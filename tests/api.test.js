import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "../api.js";

const silentLog = { warning() {}, exception() {} };

function config(overrides = {}) {
  return {
    API_RATE_LIMIT_WINDOW_MS: 60_000,
    API_RATE_LIMIT_PROBE: 20,
    API_RATE_LIMIT_DOWNLOAD: 5,
    API_BODY_LIMIT_BYTES: 16_384,
    API_PROBE_TIMEOUT_MS: 200,
    API_DOWNLOAD_TIMEOUT_MS: 500,
    API_CORS_ORIGINS: "*",
    TRUST_PROXY_HEADERS: false,
    ...overrides,
  };
}

function semaphore() {
  return {
    active: 0,
    acquired: 0,
    released: 0,
    async acquire() { this.active++; this.acquired++; },
    release() { this.active--; this.released++; },
  };
}

function harness({ appConfig = config(), probe, download, domains = ["media.example"], sem = semaphore() } = {}) {
  const plugin = {
    name: "fixture",
    domains,
    probe: probe || (async () => ({
      title: "Fixture media",
      options: [{ key: "v_best", label: "Best", kind: "video", sizeHint: 0 }],
      extra: { signedValue: "server-only" },
    })),
  };
  const entry = { ...plugin, download: download || (async () => ({ filePath: "/does/not/exist", title: "Fixture", isAudio: false })) };
  return {
    sem,
    handle: createApiHandler({
      appConfig,
      pluginFinder: (url) => url.includes("media.example") ? plugin : null,
      pluginList: () => [entry],
      registry: () => ({ fixture: { status: "loaded", domains, description: "fixture", providerStatus: { upstream: { status: "closed", failuresInWindow: 0 } } } }),
      semaphore: sem,
      log: silentLog,
    }),
  };
}

function request(path, body, { headers = {}, method = "POST" } = {}) {
  const normalized = { ...headers };
  if (body !== undefined && !Object.keys(normalized).some((name) => name.toLowerCase() === "content-type")) normalized["Content-Type"] = "application/json";
  return new Request(`https://service.example${path}`, {
    method,
    headers: normalized,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

test("واجهة plugins عامة ولا تتطلب Authorization", async () => {
  const { handle } = harness();
  const response = await handle(request("/api/plugins", undefined, { method: "GET" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.plugins[0].name, "fixture");
  assert.equal(data.plugins[0].providerStatus.upstream.status, "closed");
  assert.match(data.requestId, /^[a-f0-9]{16}$/);
});

test("health العامة تعرض حالة التشغيل والموارد من دون مصادقة", async () => {
  const { handle, sem } = harness();
  sem.active = 1;
  const response = await handle(request("/api/health", undefined, { method: "GET" }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.plugins, 1);
  assert.equal(data.activeDownloads, 1);
  assert.equal(data.version, "2.0.0");
  assert.equal(typeof data.memoryMB, "number");
  assert.match(data.requestId, /^[a-f0-9]{16}$/);
});

test("طلب OPTIONS يكشف CORS من دون مصادقة", async () => {
  const { handle } = harness();
  const response = await handle(request("/api/probe", undefined, { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-methods"), /POST/);
});

test("probe يتحقق من JSON والرابط العام قبل استدعاء الإضافة", async () => {
  let called = 0;
  const { handle } = harness({ probe: async () => { called++; return { options: [{ key: "x", label: "x", kind: "video" }] }; } });

  let response = await handle(request("/api/probe", { url: "https://media.example/a" }, { headers: { "Content-Type": "text/plain" } }));
  assert.equal(response.status, 415);

  response = await handle(request("/api/probe", { url: "http://127.0.0.1/private" }));
  assert.equal(response.status, 400);
  assert.equal(called, 0);
  assert.match((await response.json()).error, /الشبكة الداخلية/);

  response = await handle(request("/api/probe", { url: "ftp://media.example/a" }));
  assert.equal(response.status, 400);
  assert.equal(called, 0);
});

test("probe المفتوح يعيد خيارات نظيفة ولا يكشف بيانات المزود extra", async () => {
  const { handle } = harness();
  const response = await handle(request("/api/probe", { url: "https://media.example/a" }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.plugin, "fixture");
  assert.equal("extra" in data, false);
  assert.deepEqual(data.options[0], { key: "v_best", label: "Best", kind: "video", sizeHint: 0 });
});

test("حد المعدل يعيد 429 وRetry-After من دون تحويل الواجهة إلى مصادقة", async () => {
  const { handle } = harness({ appConfig: config({ API_RATE_LIMIT_PROBE: 1 }) });
  const first = await handle(request("/api/probe", { url: "https://media.example/a" }));
  const second = await handle(request("/api/probe", { url: "https://media.example/b" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("retry-after")) >= 1);
});

test("download يعيد ملفاً ويستخدم extra الموثوق من الخادم لا جسم العميل", async () => {
  const directory = await mkdtemp(join(tmpdir(), "media-api-test-"));
  const filePath = join(directory, "fixture.mp4");
  await writeFile(filePath, "fixture-bytes");
  let receivedExtra;
  const { handle, sem } = harness({
    download: async (_url, choice) => {
      receivedExtra = choice.extra;
      return { filePath, title: "فيديو Fixture", isAudio: false, isDocument: false };
    },
  });

  const response = await handle(request("/api/download", {
    url: "https://media.example/a",
    key: "v_best",
    extra: { signedValue: "client-controlled" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-plugin"), "fixture");
  assert.match(response.headers.get("content-disposition"), /_+ fixture\.mp4/i);
  assert.equal(decodeURIComponent(response.headers.get("x-media-title")), "فيديو Fixture");
  assert.equal(await response.text(), "fixture-bytes");
  assert.deepEqual(receivedExtra, { signedValue: "server-only" });
  assert.equal(sem.acquired, 1);
  assert.equal(sem.released, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(access(filePath));
});

test("انتهاء مهلة التنزيل لا يحرر القفل قبل اكتمال المهمة الخلفية", async () => {
  const directory = await mkdtemp(join(tmpdir(), "media-api-timeout-test-"));
  const filePath = join(directory, "late.mp4");
  let resolveDownload;
  const downloadFinished = new Promise((resolve) => { resolveDownload = resolve; });
  const sem = semaphore();
  const { handle } = harness({
    sem,
    appConfig: config({ API_DOWNLOAD_TIMEOUT_MS: 20 }),
    download: async () => downloadFinished,
  });

  // timeoutAfter يستخدم unref في التطبيق؛ يبقي هذا المؤقت حلقة الاختبار حية
  // أثناء انتظار انتهاء المهلة، كما يحدث طبيعياً داخل خادم HTTP.
  const keepAlive = setTimeout(() => {}, 100);
  const response = await handle(request("/api/download", {
    url: "https://media.example/late",
    key: "v_best",
  }));
  clearTimeout(keepAlive);
  assert.equal(response.status, 504);
  assert.equal(sem.acquired, 1);
  assert.equal(sem.released, 0);
  assert.equal(sem.active, 1);

  await writeFile(filePath, "late-bytes");
  resolveDownload({ filePath, title: "Late", isAudio: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sem.released, 1);
  assert.equal(sem.active, 0);
  await assert.rejects(access(filePath));
});

test("طرق API الخاطئة تعطي 405 والاستجابات تحمل رقم تتبع", async () => {
  const { handle } = harness();
  const response = await handle(request("/api/download", undefined, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.match(response.headers.get("x-request-id"), /^[a-f0-9]{16}$/);
  const data = await response.json();
  assert.equal(data.ok, false);
});
