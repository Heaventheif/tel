// lib/keep-alive.js — يُبقي APIs الخارجية والسيرفر نفسه مستيقظة
// بإرسال ping دوري لمنعها من الدخول في وضع السكون على Render/Heroku.
import { getLogger } from "./logger.js";

const logger = getLogger("keep-alive");

// ── الحالة الداخلية ─────────────────────────────────────────────────────────

/** @type {Map<string, PingRecord>} url → آخر نتيجة ping */
const pingHistory = new Map();

/** @type {number|null} مؤشر setInterval الحالي */
let intervalHandle = null;

/** @type {string[]} قائمة الـ URLs المُراقَبة */
let watchedUrls = [];

/**
 * @typedef {Object} PingRecord
 * @property {string}  url          - عنوان الـ API
 * @property {boolean} ok           - هل آخر ping نجح؟
 * @property {number}  status       - HTTP status code (0 = خطأ شبكة)
 * @property {number}  ms           - زمن الاستجابة بالمللي ثانية
 * @property {string}  lastPingAt   - ISO timestamp لآخر ping
 * @property {string|null} error    - رسالة الخطأ إن وُجدت
 * @property {number}  totalPings   - إجمالي عدد المحاولات
 * @property {number}  failPings    - عدد المحاولات الفاشلة
 * @property {boolean} isSelf       - هل هذا هو السيرفر نفسه؟
 */

// ── ping منفرد ───────────────────────────────────────────────────────────────

/**
 * يرسل ping لـ URL واحد ويحدّث السجل.
 * @param {string}  url
 * @param {boolean} isSelf
 */
async function pingOne(url, isSelf = false) {
  const prev = pingHistory.get(url) || {
    url, ok: false, status: 0, ms: 0,
    lastPingAt: null, error: null,
    totalPings: 0, failPings: 0, isSelf,
  };

  const t0 = Date.now();
  let ok = false, status = 0, error = null;

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    ok     = res.status < 500;
    if (ok) {
      logger.debug(`[keep-alive] ✅ ${isSelf ? "[self] " : ""}ping ناجح: ${url} (${res.status})`);
    } else {
      logger.warning(`[keep-alive] ⚠️ ${url} رد بـ HTTP ${res.status}`);
    }
  } catch (e) {
    error = e.message;
    logger.warning(`[keep-alive] ❌ ping فشل: ${url} — ${e.message}`);
  }

  pingHistory.set(url, {
    url,
    ok,
    status,
    ms:         Date.now() - t0,
    lastPingAt: new Date().toISOString(),
    error,
    totalPings: prev.totalPings + 1,
    failPings:  prev.failPings + (ok ? 0 : 1),
    isSelf,
  });
}

// ── ping الكل ────────────────────────────────────────────────────────────────

async function pingAll() {
  await Promise.allSettled(
    watchedUrls.map((u) => pingOne(u, u === watchedUrls[0] && pingHistory.get(u)?.isSelf))
  );
}

// ── الواجهة العامة ───────────────────────────────────────────────────────────

/**
 * يبدأ حلقة keep-alive.
 * @param {string[]} externalUrls  - APIs خارجية (Render / Heroku)
 * @param {string}   [selfUrl]     - رابط السيرفر نفسه (اختياري)
 * @param {number}   [intervalMs]  - الفترة بالمللي ثانية (افتراضي: 10 دقائق)
 */
export function startKeepAlive(externalUrls, selfUrl, intervalMs = 10 * 60 * 1000) {
  const urls = [selfUrl, ...externalUrls].filter(Boolean);
  if (!urls.length) return;

  // وضع علامة self على أول عنصر إن كان selfUrl موجوداً
  if (selfUrl) {
    pingHistory.set(selfUrl, {
      url: selfUrl, ok: false, status: 0, ms: 0,
      lastPingAt: null, error: null,
      totalPings: 0, failPings: 0, isSelf: true,
    });
  }

  watchedUrls = urls;

  logger.info(`[keep-alive] 🏃 مراقبة ${urls.length} عنوان (self + ${urls.length - (selfUrl ? 1 : 0)} خارجي)`);

  // ping فوري عند الإقلاع
  pingAll();

  // إلغاء أي interval قديم
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(pingAll, intervalMs);
}

/**
 * يُعيد نسخة من سجل ping لكل URL (للـ endpoint).
 * @returns {PingRecord[]}
 */
export function getKeepAliveStatus() {
  return [...pingHistory.values()];
}
