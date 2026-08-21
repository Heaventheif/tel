// api.js — REST API عامة لاستهلاك البوتات والعملاء الخارجيين.
// لا توجد مصادقة حسب تصميم الخدمة؛ بدلاً منها نطبّق تحققاً صارماً للمدخلات،
// حدوداً للمعدل، وحصة التزامن المشتركة مع بوت تيليجرام.

import { createReadStream, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { config as defaultConfig } from "./config.js";
import { findPlugin, getPlugins, getRegistry, getDownloadSemaphore, getSearchProviders } from "./plugin-loader.js";
import { getLogger } from "./lib/logger.js";
import {
  assertSafePublicUrl,
  corsHeaders,
  FixedWindowRateLimiter,
  readJsonBody,
  requestClientKey,
  requestId,
  withHeaders,
} from "./lib/http.js";

const logger = getLogger("api");
const SERVICE_STARTED_AT = Date.now();
const SERVICE_VERSION = "2.0.0";

const MIME_BY_EXTENSION = {
  mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg",
  flac: "audio/flac", wav: "audio/wav", zip: "application/zip",
};

function jsonResponse(payload, status = 200, headers = {}) {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function jsonError(error, status, id, headers = {}) {
  return jsonResponse({ ok: false, error, requestId: id }, status, headers);
}

function publicUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timeout`);
      error.code = "TIMEOUT";
      reject(error);
    }, ms);
    timer.unref?.();
  });
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutAfter(ms, label)]);
}

async function removeTempFile(path) {
  if (!path) return;
  try { await unlink(path); } catch { /* الملف حذف سابقاً أو لم يُنشأ */ }
}

function downloadHeaders(dl, pluginName) {
  const extension = (dl.filePath.split(".").pop() || "bin").toLowerCase();
  const mime = MIME_BY_EXTENSION[extension] || "application/octet-stream";
  // filename يجب أن يبقى ضمن ASCII لأن بعض خوادم HTTP ترفض أحرف Unicode
  // في Content-Disposition. يبقى العنوان الأصلي متاحاً مشفراً في X-Media-Title.
  const safeTitle = String(dl.title || "media")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "media";
  const mediaType = dl.isAudio ? "audio" : dl.isDocument ? "document" : "video";
  const headers = {
    "Content-Type": mime,
    "Content-Disposition": `attachment; filename="${safeTitle}.${extension}"`,
    "X-Media-Title": encodeURIComponent(String(dl.title || "")),
    "X-Media-Type": mediaType,
    "X-Plugin": pluginName,
    "Cache-Control": "no-store",
  };
  try { headers["Content-Length"] = String(statSync(dl.filePath).size); } catch { /* البث سيظل سليماً دون طول */ }
  return headers;
}

/**
 * منشئ قابل للاختبار؛ يمكّن الاختبارات من تمرير plugins وهمية دون طلبات شبكة.
 */
export function createApiHandler({
  appConfig = defaultConfig,
  pluginFinder = findPlugin,
  pluginList = getPlugins,
  registry = getRegistry,
  semaphore = null,
  log = logger,
} = {}) {
  const probeLimiter = new FixedWindowRateLimiter({
    windowMs: appConfig.API_RATE_LIMIT_WINDOW_MS,
    maxRequests: appConfig.API_RATE_LIMIT_PROBE,
  });
  const downloadLimiter = new FixedWindowRateLimiter({
    windowMs: appConfig.API_RATE_LIMIT_WINDOW_MS,
    maxRequests: appConfig.API_RATE_LIMIT_DOWNLOAD,
  });
  const sharedSemaphore = semaphore || getDownloadSemaphore();

  function checkRateLimit(req, limiter, id) {
    const result = limiter.take(requestClientKey(req, appConfig.TRUST_PROXY_HEADERS));
    if (result.allowed) return null;
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    return jsonError("تم تجاوز حد الطلبات مؤقتاً. حاول لاحقاً.", 429, id, {
      "Retry-After": String(retryAfter),
      "X-RateLimit-Remaining": "0",
    });
  }

  async function handleSearch(req, id) {
    const parsed = await readJsonBody(req, appConfig.API_BODY_LIMIT_BYTES);
    if (!parsed.ok) return jsonError(parsed.error, parsed.status, id);
    const query = typeof parsed.value.query === "string" ? parsed.value.query.trim() : "";
    if (query.length < 2 || query.length > 160) return jsonError("اكتب عنواناً من حرفين إلى 160 حرفاً.", 400, id);

    const providers = getSearchProviders();
    if (!providers.length) return jsonResponse({ ok: true, query, results: [], providers: 0, requestId: id });
    const settled = await Promise.allSettled(providers.map((provider) => provider.search(query)));
    const results = settled.flatMap((state) => state.status === "fulfilled" ? (state.value || []) : [])
      .filter((item) => item?.url && item?.title)
      .slice(0, 12)
      .map(({ title, url, source, duration = "", uploader = "" }) => ({ title, url, source, duration, uploader }));
    return jsonResponse({ ok: true, query, results, providers: providers.length, requestId: id });
  }

  async function handlePlugins(id) {
    const plugins = Object.entries(registry()).map(([name, info]) => ({
      name,
      domains: info.domains || [],
      description: info.description || "",
      status: info.status,
      type: info.type || "",
      // حالة المزودات ديناميكية، وتبقى البيانات القديمة للمستهلكين كما هي.
      providerStatus: info.providerStatus || {},
    }));
    return jsonResponse({ ok: true, plugins, requestId: id });
  }

  async function handleHealth(id) {
    const entries = Object.values(registry());
    const loadedPlugins = entries.filter((info) => info.status === "loaded").length;
    const memoryUsage = process.memoryUsage?.().rss || 0;
    return jsonResponse({
      ok: true,
      uptime: Math.floor((Date.now() - SERVICE_STARTED_AT) / 1_000),
      plugins: loadedPlugins,
      activeDownloads: sharedSemaphore.active || 0,
      memoryMB: Math.round((memoryUsage / 1024 / 1024) * 10) / 10,
      version: SERVICE_VERSION,
      requestId: id,
    });
  }

  async function parseUrlBody(req, id) {
    const parsed = await readJsonBody(req, appConfig.API_BODY_LIMIT_BYTES);
    if (!parsed.ok) return { response: jsonError(parsed.error, parsed.status, id) };
    const rawUrl = typeof parsed.value.url === "string" ? parsed.value.url.trim() : "";
    if (!rawUrl) return { response: jsonError("الحقل url مطلوب.", 400, id) };
    try {
      return { body: parsed.value, url: assertSafePublicUrl(rawUrl).href };
    } catch (error) {
      return { response: jsonError(error.message, 400, id) };
    }
  }

  async function handleProbe(req, id) {
    const rateLimited = checkRateLimit(req, probeLimiter, id);
    if (rateLimited) return rateLimited;

    const parsed = await parseUrlBody(req, id);
    if (parsed.response) return parsed.response;

    const plugin = pluginFinder(parsed.url);
    if (!plugin) return jsonError("هذا الرابط غير مدعوم حالياً.", 422, id);

    let result;
    try {
      result = await withTimeout(plugin.probe(parsed.url), appConfig.API_PROBE_TIMEOUT_MS, "probe");
    } catch (error) {
      log.warning(`[api/probe] فشل request=${id} url=${publicUrlForLog(parsed.url)}: ${error.message}`);
      const status = error.code === "TIMEOUT" ? 504 : 502;
      return jsonError(status === 504 ? "انتهت مهلة فحص الرابط. حاول مجدداً." : "تعذّر فحص الرابط من المزود.", status, id);
    }

    if (!result?.options?.length) return jsonError("لا توجد جودات متاحة لهذا الرابط.", 422, id);
    const options = result.options.map(({ key, label, kind, sizeHint = 0 }) => ({ key, label, kind, sizeHint }));

    // لا نعيد extra للعميل: قد يضم روابط موقعة أو بيانات مزود مؤقتة.
    // يعيد /api/download تنفيذ probe ويحصل على extra الموثوق من الخادم.
    return jsonResponse({
      ok: true,
      title: result.title || "",
      plugin: plugin.name,
      options,
      requestId: id,
    });
  }

  async function handleDownload(req, id) {
    const rateLimited = checkRateLimit(req, downloadLimiter, id);
    if (rateLimited) return rateLimited;

    const parsed = await parseUrlBody(req, id);
    if (parsed.response) return parsed.response;
    const key = typeof parsed.body.key === "string" ? parsed.body.key.trim() : "";
    if (!key || key.length > 100) return jsonError("الحقل key مطلوب وغير صالح.", 400, id);

    const plugin = pluginFinder(parsed.url);
    if (!plugin) return jsonError("هذا الرابط غير مدعوم حالياً.", 422, id);
    const pluginEntry = pluginList().find((item) => item.name === plugin.name);
    if (!pluginEntry) return jsonError("إضافة التنزيل غير متاحة حالياً.", 503, id);

    let probeResult;
    try {
      probeResult = await withTimeout(plugin.probe(parsed.url), appConfig.API_PROBE_TIMEOUT_MS, "probe");
    } catch (error) {
      log.warning(`[api/download] probe فشل request=${id} url=${publicUrlForLog(parsed.url)}: ${error.message}`);
      const status = error.code === "TIMEOUT" ? 504 : 502;
      return jsonError(status === 504 ? "انتهت مهلة فحص الرابط. حاول مجدداً." : "تعذّر فحص الرابط من المزود.", status, id);
    }

    const option = (probeResult?.options || []).find((item) => item.key === key);
    if (!option) return jsonError("الجودة المطلوبة غير متاحة لهذا الرابط.", 404, id);

    let acquired = false;
    let released = false;
    let exceededDeadline = false;
    const releaseOnce = () => {
      if (acquired && !released) {
        released = true;
        sharedSemaphore.release();
      }
    };
    try {
      await sharedSemaphore.acquire();
      acquired = true;

      // مصدر extra هو نتيجة الفحص الجديدة من الخادم، لا جسم طلب العميل.
      const work = Promise.resolve(pluginEntry.download(parsed.url, { key, option, extra: probeResult.extra || {} }));
      const guardedWork = work.finally(releaseOnce);
      // إذا انتهت مهلة الرد يستمر القفل حتى ينتهي التحميل الحقيقي، فلا يتجاوز
      // النظام حد التزامن تحت الضغط. ونحذف أي ملف متأخر فور اكتماله.
      guardedWork.then((lateResult) => { if (exceededDeadline) removeTempFile(lateResult?.filePath); }).catch(() => {});

      const dl = await withTimeout(guardedWork, appConfig.API_DOWNLOAD_TIMEOUT_MS, "download");
      if (!dl?.filePath) throw new Error("لم تُنتج الإضافة ملفاً قابلاً للتنزيل");

      const stream = createReadStream(dl.filePath);
      const cleanup = () => { removeTempFile(dl.filePath); };
      stream.once("close", cleanup);
      stream.once("error", cleanup);
      return new Response(Readable.toWeb(stream), { status: 200, headers: downloadHeaders(dl, plugin.name) });
    } catch (error) {
      if (error.code === "TIMEOUT") exceededDeadline = true;
      // عند انتهاء مهلة الاستجابة، قد يستمر التنزيل الحقيقي في الخلفية؛
      // لا نحرر القفل قبل انتهائه حتى لا يتجاوز النظام حد التزامن.
      if (error.code !== "TIMEOUT") releaseOnce();
      log.exception(`[api/download] فشل request=${id} url=${publicUrlForLog(parsed.url)} key=${key}`, error);
      const status = error.code === "TIMEOUT" ? 504 : 502;
      return jsonError(status === 504 ? "انتهت مهلة التنزيل. حاول بجودة أصغر." : "تعذّر تنزيل الملف من المزود.", status, id);
    }
  }

  return async function handle(req) {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/")) return null;

    const id = requestId();
    const applyPublicHeaders = (response) => withHeaders(response, {
      ...corsHeaders(req, appConfig.API_CORS_ORIGINS),
      "X-Request-Id": id,
    });

    if (req.method === "OPTIONS") return applyPublicHeaders(new Response(null, { status: 204 }));

    let response;
    if (req.method === "GET" && pathname === "/api/plugins") response = await handlePlugins(id);
    else if (req.method === "POST" && pathname === "/api/search") response = await handleSearch(req, id);
    else if (req.method === "GET" && pathname === "/api/health") response = await handleHealth(id);
    else if (req.method === "POST" && pathname === "/api/probe") response = await handleProbe(req, id);
    else if (req.method === "POST" && pathname === "/api/download") response = await handleDownload(req, id);
    else if (["/api/plugins", "/api/health", "/api/probe", "/api/download", "/api/search"].includes(pathname)) {
      response = jsonError("طريقة الطلب غير مدعومة لهذا المسار.", 405, id);
    } else {
      response = jsonError("مسار API غير موجود.", 404, id);
    }
    return applyPublicHeaders(response);
  };
}

const defaultHandler = createApiHandler();

/** يعالج /api/* ويعيد null لبقية المسارات. */
export function handleApiRequest(req) {
  return defaultHandler(req);
}
