import test from "node:test";
import assert from "node:assert/strict";
import { assertSafePublicUrl, FixedWindowRateLimiter, readJsonBody, safeFetch } from "../lib/http.js";
import { domainMatches } from "../plugin-loader.js";

test("التحقق من الرابط يسمح بـ HTTPS العام ويمنع شبكة البنية الداخلية", () => {
  assert.equal(assertSafePublicUrl("https://media.example/path?q=1").hostname, "media.example");
  for (const unsafe of [
    "http://localhost:10000/health", "http://127.0.0.1/", "http://10.0.0.8/",
    "http://172.20.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://[::1]/", "ftp://media.example/file", "file:///etc/passwd", "https://user:pass@media.example/file",
    `https://media.example/${"x".repeat(4_100)}`,
  ]) {
    assert.throws(() => assertSafePublicUrl(unsafe));
  }
});

test("مطابقة النطاق تعتمد على hostname الفعلي ولا تقبل النطاقات المموهة", () => {
  assert.equal(domainMatches("https://www.youtube.com/watch?v=1", "youtube.com"), true);
  assert.equal(domainMatches("https://youtu.be/abc", "youtube.com"), false);
  assert.equal(domainMatches("https://notyoutube.com/video", "youtube.com"), false);
  assert.equal(domainMatches("https://youtube.com.evil.example/video", "youtube.com"), false);
});

test("قارئ JSON يرفض الجسم الكبير أو غير الكائني أو الترويسة الخاطئة", async () => {
  let parsed = await readJsonBody(new Request("https://example.test", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), 10);
  assert.equal(parsed.status, 415);
  parsed = await readJsonBody(new Request("https://example.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }), 100);
  assert.equal(parsed.status, 400);
  parsed = await readJsonBody(new Request("https://example.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"url":"this body is too large"}' }), 8);
  assert.equal(parsed.status, 413);
});

async function withMockedFetch(mock, work) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await work(); } finally { globalThis.fetch = original; }
}

test("safeFetch يرفض حلقة إعادة التوجيه", async () => {
  await withMockedFetch(async () => new Response(null, { status: 302, headers: { location: "https://8.8.8.8/loop" } }), async () => {
    await assert.rejects(() => safeFetch("https://8.8.8.8/loop"), /الحد الأقصى/);
  });
});

test("safeFetch يمنع redirect إلى عنوان داخلي", async () => {
  await withMockedFetch(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }), async () => {
    await assert.rejects(() => safeFetch("https://8.8.8.8/start"), /الشبكة الداخلية/);
  });
});

test("safeFetch يرفض سلسلة تتجاوز ثماني إعادات توجيه", async () => {
  let hops = 0;
  await withMockedFetch(async () => {
    hops++;
    return new Response(null, { status: 302, headers: { location: `https://8.8.8.8/hop-${hops}` } });
  }, async () => {
    await assert.rejects(() => safeFetch("https://8.8.8.8/start"), /الحد الأقصى/);
  });
  assert.equal(hops, 9);
});

test("محدد المعدل يسمح بالحد ثم يرفض حتى انتهاء النافذة", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ windowMs: 100, maxRequests: 2, now: () => now });
  assert.equal(limiter.take("client").allowed, true);
  assert.equal(limiter.take("client").allowed, true);
  assert.equal(limiter.take("client").allowed, false);
  now += 101;
  assert.equal(limiter.take("client").allowed, true);
});

test("محدد المعدل يفرّغ النوافذ المنتهية ويحافظ على حد المفاتيح", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ windowMs: 100, maxRequests: 1, maxEntries: 2, now: () => now });
  limiter.take("expired");
  now += 101;
  limiter.take("fresh-a");
  limiter.prune();
  assert.equal(limiter.entries.has("expired"), false);
  limiter.take("fresh-b");
  limiter.take("fresh-c");
  assert.ok(limiter.entries.size <= 2);
  assert.equal(limiter.entries.has("fresh-c"), true);
});
