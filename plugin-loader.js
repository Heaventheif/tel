// plugin-loader.js — يكتشف plugins/*.js تلقائياً (بديل plugin_loader.py)
//
// ثلاثة أنواع plugins، كل ملف plugins/xxx.js يُصدّر (export) أياً منها:
//
// ── Type 1: URL-plugin (تحميل عبر رابط) ──
//   export const DOMAINS = ["youtube.com"];
//   export const PRIORITY = 10;              // اختياري، افتراضي 50
//   export const DESCRIPTION = "...";
//   export async function probe(url) { ... }   // يرجع { title, options, extra }
//   export async function download(url, choice) { ... } // يرجع { filePath, title, isAudio, isDocument }
//
// ── Type 2: Handler-plugin (يستقبل رسائل مباشرة) ──
//   export function registerPlugin() {
//     return { filter: (msg) => bool, callback: async (msg, bot) => {} };
//     // أو مصفوفة من هذا الشكل
//   }
//
// ── Type 3: Search-plugin (بحث عن أغاني بالاسم) ──
//   export const SEARCH_PRIORITY = 10;
//   export async function search(query) { ... } // يرجع مصفوفة SearchResult
//
// اختياري لكل الأنواع: export async function setup() { ... }
//
// ⚡ حذف أي ملف plugins/*.js يعطّل ذلك الأمر فوراً دون تعديل أي ملف آخر —
// هذا الملف يفحص المجلد ديناميكياً في كل إقلاع، لا توجد قائمة ثابتة بالأسماء.
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.js";
import { getLogger } from "./lib/logger.js";
import { assertSafePublicUrl, safeFetch } from "./lib/http.js";

const logger = getLogger("plugin_loader");

/**
 * خطأ موحّد للإضافات: يحمل هوية المزود وقابلية إعادة المحاولة بدون كشف تفاصيله للعميل.
 */
export class PluginError extends Error {
  constructor(message, { provider, retryable = false, code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PluginError";
    this.provider = provider || null;
    this.retryable = retryable;
    this.code = code || null;
  }
}

/**
 * يعيد العملية مرة واحدة افتراضياً بعد تأخير متزايد؛ الأخطاء غير القابلة للإعادة تمر فوراً.
 */
export async function withRetry(fn, { attempts = 2, delayMs = 1_500, shouldRetry } = {}) {
  const total = Math.max(1, Math.min(Number(attempts) || 1, 5));
  const baseDelay = Math.max(0, Number(delayMs) || 0);
  let lastError;
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry ? shouldRetry(error) : error?.retryable !== false;
      if (!retryable || attempt === total) throw error;
      await Bun.sleep(baseDelay * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, "plugins");

// ══════════════════════════════════════════════
// هياكل بيانات مشتركة (factories بسيطة بدل dataclass)
// ══════════════════════════════════════════════
export function QualityOption({ kind, label, key, sizeHint = 0 }) {
  return { kind, label, key, sizeHint };
}
export function ProbeResult({ title, options, extra = {} }) {
  return { title, options, extra };
}
export function DownloadResult({ filePath, title, isAudio, isDocument = false, extra = {} }) {
  return { filePath, title, isAudio, isDocument, extra };
}
export function SearchResult({ title, url, source, duration = "", uploader = "" }) {
  return { title, url, source, duration, uploader };
}

// ══════════════════════════════════════════════
// صحة المزودات وقاطع الدائرة — في الذاكرة فقط، مناسب لـ Render Free عديم القرص الدائم.
// ثلاث إخفاقات خلال خمس دقائق توقف المزود ثلاثين دقيقة بدلاً من إهدار وقت كل طلب.
// ══════════════════════════════════════════════
const PROVIDER_FAILURE_WINDOW_MS = 5 * 60 * 1_000;
const PROVIDER_FAILURE_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 30 * 60 * 1_000;
const _providerHealth = new Map(); // "plugin:provider" -> state

function providerKey(plugin, provider) {
  return `${plugin}:${provider}`;
}

function providerState(plugin, provider) {
  const key = providerKey(plugin, provider);
  if (!_providerHealth.has(key)) {
    _providerHealth.set(key, { plugin, provider, failures: [], openUntil: 0, lastError: null, lastFailureAt: null, successes: 0 });
  }
  return _providerHealth.get(key);
}

function pruneProviderFailures(state, now = Date.now()) {
  state.failures = state.failures.filter((at) => now - at <= PROVIDER_FAILURE_WINDOW_MS);
}

export function isProviderAvailable(plugin, provider, now = Date.now()) {
  const state = providerState(plugin, provider);
  pruneProviderFailures(state, now);
  return now >= state.openUntil;
}

export function recordProviderSuccess(plugin, provider) {
  const state = providerState(plugin, provider);
  state.successes++;
  state.failures = [];
  state.openUntil = 0;
  state.lastError = null;
}

export function recordProviderFailure(plugin, provider, error, now = Date.now()) {
  const state = providerState(plugin, provider);
  pruneProviderFailures(state, now);
  state.failures.push(now);
  state.lastFailureAt = new Date(now).toISOString();
  state.lastError = String(error?.message || error || "unknown error").slice(0, 240);
  if (state.failures.length >= PROVIDER_FAILURE_THRESHOLD) state.openUntil = now + PROVIDER_COOLDOWN_MS;
}

export function getProviderStatus(plugin) {
  const now = Date.now();
  return Object.fromEntries(
    [..._providerHealth.values()]
      .filter((state) => state.plugin === plugin)
      .map((state) => {
        pruneProviderFailures(state, now);
        return [state.provider, {
          status: now < state.openUntil ? "open" : "closed",
          failuresInWindow: state.failures.length,
          retryAt: state.openUntil ? new Date(state.openUntil).toISOString() : null,
          lastFailureAt: state.lastFailureAt,
          lastError: state.lastError,
          successes: state.successes,
        }];
      })
  );
}

/** ينفذ مزوداً مع retry وقاطع دائرة موحّدين لكل plugins الرابط. */
export async function runProvider(plugin, provider, fn, options = {}) {
  if (!isProviderAvailable(plugin, provider)) {
    throw new PluginError("المزود متوقف مؤقتاً بعد إخفاقات متكررة", {
      provider,
      retryable: true,
      code: "PROVIDER_CIRCUIT_OPEN",
    });
  }
  try {
    const result = await withRetry(fn, options);
    recordProviderSuccess(plugin, provider);
    return result;
  } catch (error) {
    recordProviderFailure(plugin, provider, error);
    throw error;
  }
}

// ══════════════════════════════════════════════
// سجل الـ plugins
// ══════════════════════════════════════════════
const _plugins = [];
const _registry = {};
const _extraHandlers = [];
const _searchProviders = [];
const _pendingSetups = [];

export const getRegistry = () => _registry;
export const getPlugins = () => _plugins;
export const getExtraHandlers = () => _extraHandlers;
export const getSearchProviders = () => _searchProviders;

// ══════════════════════════════════════════════
// 🚦 حد أقصى للتحميلات المتزامنة — semaphore بسيطة
// ══════════════════════════════════════════════
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  /** يُستخدم كـ: const release = await sem.run(); try { ... } finally { release(); } */
  async run() {
    await this.acquire();
    return () => this.release();
  }
}

let _downloadSemaphore = null;
export function getDownloadSemaphore() {
  if (!_downloadSemaphore) {
    _downloadSemaphore = new Semaphore(config.MAX_CONCURRENT_DOWNLOADS);
    logger.info(`🚦 الحد الأقصى للتحميلات المتزامنة: ${config.MAX_CONCURRENT_DOWNLOADS}`);
  }
  return _downloadSemaphore;
}

// ══════════════════════════════════════════════
// ⬇️ تنزيل بالتدفّق (streaming) إلى ملف مؤقت — عبر fetch + Bun.write
// ══════════════════════════════════════════════
class SizeExceeded extends Error {}

export async function streamToFile(url, suffix, { headers, timeoutTotal = 120, maxSize, retries = 2 } = {}) {
  // نفحص الرابط قبل أول طلب، وكل إعادة توجيه داخل safeFetch، لمنع توجيه
  // التنزيل العام إلى خدمات Render الداخلية أو إلى metadata endpoint.
  const safeUrl = assertSafePublicUrl(url).href;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const path = join(
      Bun.env.TMPDIR || "/tmp",
      `dl_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutTotal * 1000);
    let writer = null;
    let reader = null;
    let completed = false;
    try {
      const res = await safeFetch(safeUrl, { headers, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      if (maxSize) {
        const contentLength = Number(res.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > maxSize) {
          throw new SizeExceeded(
            `الملف يتجاوز الحجم المسموح (${(maxSize / 1024 / 1024).toFixed(0)}MB) — تم إيقاف التحميل مبكراً`
          );
        }
      }

      writer = Bun.file(path).writer();
      let downloaded = 0;
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        if (maxSize && downloaded > maxSize) {
          await reader.cancel();
          throw new SizeExceeded(
            `الملف يتجاوز الحجم المسموح (${(maxSize / 1024 / 1024).toFixed(0)}MB) — تم إيقاف التحميل مبكراً`
          );
        }
        writer.write(value);
      }
      await writer.end();
      writer = null;

      if (downloaded === 0) throw new Error("الملف المُنزَّل فارغ");
      completed = true;
      return path;
    } catch (e) {
      try { await reader?.cancel(); } catch {}
      try { await writer?.end(); } catch {}
      if (e instanceof SizeExceeded) throw e;
      lastErr = e;
      if (attempt <= retries) {
        logger.warning(`[stream_to_file] محاولة ${attempt}/${retries + 1} فشلت (${e.message}) — إعادة المحاولة...`);
        await Bun.sleep(1_000 * attempt);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (!completed) {
        try { await Bun.file(path).delete?.(); } catch {}
      }
    }
  }
  throw lastErr;
}

// ══════════════════════════════════════════════
// 🔇/🖤 فحوصات ffprobe/ffmpeg على ملف محلي مكتمل
// ══════════════════════════════════════════════
async function runProc(cmd, { timeoutMs } = {}) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let timer;
  if (timeoutMs) {
    timer = setTimeout(() => proc.kill(), timeoutMs);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

export async function hasAudioStream(path) {
  try {
    const { stdout, exitCode } = await runProc([
      "ffprobe", "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
    ]);
    if (exitCode !== 0) return true;
    return stdout.includes("audio");
  } catch (e) {
    logger.warning(`[has_audio_stream] تعذّر فحص الملف: ${path}`, e);
    return true;
  }
}

export async function hasVideoStream(path) {
  try {
    const { stdout, exitCode } = await runProc([
      "ffprobe", "-v", "error", "-select_streams", "v",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
    ]);
    if (exitCode !== 0) return true;
    return stdout.includes("video");
  } catch (e) {
    logger.warning(`[has_video_stream] تعذّر فحص الملف: ${path}`, e);
    return true;
  }
}

async function ffprobeDuration(path) {
  const { stdout } = await runProc([
    "ffprobe", "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  const v = parseFloat(stdout.trim());
  return Number.isFinite(v) ? v : 0;
}

export async function isBlackVideo(path, blackRatioThreshold = 0.98) {
  try {
    const duration = await ffprobeDuration(path);
    if (!duration || duration <= 0) return false;
    const { stderr } = await runProc([
      "ffmpeg", "-i", path, "-vf", "blackdetect=d=0.1:pic_th=0.98",
      "-an", "-f", "null", "-",
    ]);
    let blackTotal = 0;
    for (const m of stderr.matchAll(/black_duration:\s*([\d.]+)/g)) {
      blackTotal += parseFloat(m[1]);
    }
    return blackTotal / duration >= blackRatioThreshold;
  } catch (e) {
    logger.warning(`[is_black_video] تعذّر فحص الملف: ${path}`, e);
    return false;
  }
}

// ══════════════════════════════════════════════
// ✂️ تقسيم ملف كبير إلى أجزاء عبر ffmpeg -f segment -c copy
// ══════════════════════════════════════════════
export async function splitMedia(path, { maxSize, isAudio }) {
  const file = Bun.file(path);
  const fsize = file.size;
  if (fsize <= maxSize) return [path];

  const duration = await ffprobeDuration(path);
  if (duration <= 0) throw new Error("تعذّر تحديد مدة الملف لتقسيمه");

  const avgBitrateBps = (fsize * 8) / duration;
  const segmentSeconds = Math.max(5, Math.floor((maxSize * 0.9 * 8) / avgBitrateBps));

  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : isAudio ? ".m4a" : ".mp4";
  const base = join(Bun.env.TMPDIR || "/tmp", `split_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const pattern = `${base}_part_%03d${ext}`;

  const { exitCode, stderr } = await runProc([
    "ffmpeg", "-y", "-i", path, "-c", "copy", "-map", "0",
    "-f", "segment", "-segment_time", String(segmentSeconds),
    "-reset_timestamps", "1", pattern,
  ]);
  if (exitCode !== 0) throw new Error(`فشل تقسيم الملف عبر ffmpeg: ${stderr.slice(0, 300)}`);

  const dir = dirname(base);
  const prefix = base.slice(dir.length + 1) + "_part_";
  const parts = readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => join(dir, f));

  if (!parts.length) throw new Error("ffmpeg لم يُنتج أي أجزاء");

  const oversized = parts.filter((p) => Bun.file(p).size > maxSize);
  if (oversized.length) {
    logger.warning(`[split_media] ${oversized.length} جزء تجاوز الحد رغم التقسيم — سيُرسل كما هو`);
  }
  return parts;
}

// ══════════════════════════════════════════════
// 🎵 SoundCloud client_id — كاش مشترك بين plugins/soundcloud.js
//    و plugins/search_soundcloud.js
// ══════════════════════════════════════════════
const SC_SCRIPT_RE = /https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g;
const SC_CLIENT_RE = /client_id:"([a-zA-Z0-9]{20,32})"/;

let _scClientId = null;
let _scClientExp = 0;

export async function getSoundcloudClientId(headers) {
  if (_scClientId && Date.now() / 1000 < _scClientExp) return _scClientId;

  const page = await (await fetch("https://soundcloud.com", { headers, signal: AbortSignal.timeout(15_000) })).text();
  const scripts = [...page.matchAll(SC_SCRIPT_RE)].map((m) => m[0]).slice(-6);

  for (const surl of scripts) {
    try {
      const text = await (await fetch(surl, { headers, signal: AbortSignal.timeout(10_000) })).text();
      const m = SC_CLIENT_RE.exec(text);
      if (m) {
        _scClientId = m[1];
        _scClientExp = Date.now() / 1000 + 12 * 3600;
        return _scClientId;
      }
    } catch {
      continue;
    }
  }
  throw new Error("فشل استخراج client_id من SoundCloud");
}

// ══════════════════════════════════════════════
export function domainMatches(url, domain) {
  if (domain === "*") return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    const normalized = String(domain).toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  } catch {
    return false;
  }
}

export function findPlugin(url) {
  for (const plugin of _plugins) {
    if ((plugin.domains || []).some((domain) => domain !== "*" && domainMatches(url, domain))) return plugin;
  }
  return _plugins.find((plugin) => (plugin.domains || []).includes("*")) || null;
}

// ══════════════════════════════════════════════
// تحميل الـ plugins ديناميكياً من plugins/*.js
// ══════════════════════════════════════════════
export async function loadAllPlugins() {
  let files = [];
  try {
    files = readdirSync(PLUGINS_DIR)
      .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
      .sort();
  } catch {
    logger.warning("[plugin_loader] مجلد plugins/ غير موجود أو فارغ");
    return;
  }

  let loaded = 0;
  let failed = 0;

  for (const file of files) {
    const name = file.slice(0, -3);
    const ok = await _loadOne(name, join(PLUGINS_DIR, file));
    if (ok) loaded++;
    else failed++;
  }

  _plugins.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  _searchProviders.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

  logger.info(
    `[plugin_loader] ✅ ${loaded} plugin محمَّل` +
      (failed ? ` | ❌ ${failed} فشل` : "") +
      ` | الترتيب: ${JSON.stringify(_plugins.map((p) => p.name))}`
  );
}

export async function runPendingSetups() {
  if (!_pendingSetups.length) return;
  await Promise.all(
    _pendingSetups.map(async ({ name, fn }) => {
      try {
        await fn();
      } catch (e) {
        logger.warning(`[${name}] setup() فشل: ${e.message}`);
      }
    })
  );
  logger.info(`[plugin_loader] ✅ اكتمل setup() لـ ${_pendingSetups.length} plugin`);
}

async function _loadOne(name, fpath) {
  try {
    const mod = await import(pathToFileURL(fpath).href + `?t=${Date.now()}`);

    const domains = mod.DOMAINS || [];
    const isUrlPlugin = domains.length > 0 && typeof mod.probe === "function" && typeof mod.download === "function";
    const isHandlerPlugin = typeof mod.registerPlugin === "function";
    const isSearchPlugin = typeof mod.search === "function";

    if (!isUrlPlugin && !isHandlerPlugin && !isSearchPlugin) {
      logger.warning(`[${name}] ⚠️ لا probe/download/DOMAINS ولا registerPlugin ولا search — تخطي`);
      _registry[name] = { status: "skipped", reason: "no valid export shape" };
      return false;
    }

    if (isUrlPlugin) {
      _plugins.push({
        name,
        module: mod,
        domains,
        priority: mod.PRIORITY ?? 50,
        description: mod.DESCRIPTION || "",
        probe: mod.probe,
        download: mod.download,
      });
    }

    if (isSearchPlugin) {
      _searchProviders.push({ name, search: mod.search, priority: mod.SEARCH_PRIORITY ?? 50 });
    }

    let handlerCount = 0;
    if (isHandlerPlugin) {
      try {
        let handlers = mod.registerPlugin();
        if (handlers && !Array.isArray(handlers)) handlers = [handlers];
        for (const h of handlers || []) _extraHandlers.push(h);
        handlerCount = (handlers || []).length;
      } catch (e) {
        logger.exception(`[${name}] registerPlugin() فشل`, e);
      }
    }

    if (typeof mod.setup === "function") {
      _pendingSetups.push({ name, fn: mod.setup });
    }

    const types = [];
    if (isUrlPlugin) types.push("رابط");
    if (isHandlerPlugin) types.push("مباشر");
    if (isSearchPlugin) types.push("بحث");

    _registry[name] = {
      status: "loaded",
      type: types.join("+"),
      domains,
      priority: mod.PRIORITY ?? 50,
      description: mod.DESCRIPTION || "",
      handlers: handlerCount,
      search: isSearchPlugin,
      // تقرأ API هذه الدالة عند الطلب حتى تعكس دائرة المزود الحالة الحية بلا إعادة تحميل.
      get providerStatus() { return getProviderStatus(name); },
    };
    logger.info(`[${name}] ✅ محمَّل | نوع=${types.join("+")}`);
    return true;
  } catch (e) {
    logger.exception(`[${name}] ❌ فشل: ${e.message}`, e);
    _registry[name] = { status: "error", reason: e.message };
    return false;
  }
}
