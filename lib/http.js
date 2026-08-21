// lib/http.js — أدوات HTTP مشتركة للـ API المفتوحة والتحميلات الخارجية.
//
// مبدأ SSRF الدفاعي المعتمد هنا:
//   • assertSafePublicUrl  — فحص نصي متزامن (بروتوكول، بيانات دخول، IP خاص).
//   • assertSafeResolvablePublicUrl — فحص DNS إضافي، يُستخدم فقط على المدخل
//     الأول من المستخدم، ولا يُكرَّر على كل redirect داخلي (تكلفة I/O عالية).
//   • safeFetch — يتبع الـ redirects مع assertSafePublicUrl (نصي فقط) على كل
//     redirect، لأن الـ CDNs الشرعية تُعيد التوجيه لنطاقات مختلفة باستمرار.

import { lookup } from "node:dns/promises";

const PRIVATE_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function isPrivateIpv4(host) {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(host) {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}

/**
 * فحص نصي متزامن — سريع، يُستخدم على المدخلات ومع كل redirect.
 * يرفض البروتوكولات غير HTTP/S، بيانات الدخول، والعناوين الخاصة الصريحة.
 */
export function assertSafePublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("الرابط مطلوب");
  if (value.length > 4_096) throw new Error("الرابط أطول من الحد المسموح");

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("الرابط غير صالح");
  }

  if (!/^https?:$/.test(url.protocol)) throw new Error("يُسمح بروابط HTTP وHTTPS فقط");
  if (url.username || url.password) throw new Error("لا يُسمح ببيانات دخول داخل الرابط");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    PRIVATE_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("لا يُسمح بعناوين الشبكة الداخلية");
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new Error("لا يُسمح بعناوين الشبكة الداخلية");
  }
  return url;
}

// ── DNS cache بسيط لتجنّب lookup مكرر لنفس النطاق خلال نافذة زمنية قصيرة ──
const _dnsCache = new Map(); // hostname → { safe: bool, expiresAt: number }
const DNS_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 دقائق

async function _checkHostSafe(host) {
  const now = Date.now();
  const cached = _dnsCache.get(host);
  if (cached && now < cached.expiresAt) {
    if (!cached.safe) throw new Error("عنوان المصدر يشير إلى شبكة داخلية غير مسموحة");
    return;
  }

  // IP مباشر — لا يحتاج DNS
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    const safe = !isPrivateIpv4(host) && !isPrivateIpv6(host);
    _dnsCache.set(host, { safe, expiresAt: now + DNS_CACHE_TTL_MS });
    if (!safe) throw new Error("عنوان المصدر يشير إلى شبكة داخلية غير مسموحة");
    return;
  }

  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("تعذّر التحقق من عنوان خادم المصدر");
  }

  const safe =
    records.length > 0 &&
    records.every(({ address }) => !isPrivateIpv4(address) && !isPrivateIpv6(address));

  _dnsCache.set(host, { safe, expiresAt: now + DNS_CACHE_TTL_MS });
  if (!safe) throw new Error("عنوان المصدر يشير إلى شبكة داخلية غير مسموحة");
}

/**
 * فحص DNS + نصي — يُستخدم فقط على المدخل الأول من المستخدم.
 * النتيجة مُخزَّنة في الذاكرة 5 دقائق لتجنّب lookup مكرر لنفس النطاق.
 */
export async function assertSafeResolvablePublicUrl(value) {
  const url = assertSafePublicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  await _checkHostSafe(host);
  return url;
}

/**
 * يجلب مورداً مع متابعة الـ redirects بأمان.
 *
 * استراتيجية التحقق:
 *   • الرابط الأول: assertSafeResolvablePublicUrl (نصي + DNS مع cache).
 *   • كل redirect لاحق: assertSafePublicUrl (نصي فقط، سريع).
 *
 * هذا يوازن بين الأمان (منع DNS rebinding على المدخل) والأداء
 * (عدم إضافة lookup على كل CDN redirect).
 *
 * maxRedirects مرفوع إلى 8 لاستيعاب سلاسل CDN الطويلة (YouTube/CloudFront).
 */
export async function safeFetch(url, init = {}, { maxRedirects = 8 } = {}) {
  let current = (await assertSafeResolvablePublicUrl(url)).href;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) throw new Error("إعادة توجيه بلا عنوان وجهة");
    if (hop === maxRedirects) throw new Error(`تجاوز الرابط الحد الأقصى لإعادات التوجيه (${maxRedirects})`);

    // redirects لاحقة — فحص نصي فقط (الـ CDN لا يُعيد التوجيه لعناوين داخلية)
    current = assertSafePublicUrl(new URL(location, current).href).href;
  }

  throw new Error("تعذّر متابعة إعادة التوجيه");
}

/** يقرأ JSON بحد صريح للحجم ليبقى endpoint العام مستقراً تحت الطلبات الخاطئة. */
export async function readJsonBody(req, maxBytes) {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { ok: false, status: 415, error: "Content-Type يجب أن يكون application/json" };
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: "جسم الطلب يتجاوز الحجم المسموح" };
  }

  let text;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: "تعذّر قراءة جسم الطلب" };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, status: 413, error: "جسم الطلب يتجاوز الحجم المسموح" };
  }
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return { ok: false, status: 400, error: "جسم الطلب يجب أن يكون كائناً JSON" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, error: "جسم الطلب يجب أن يكون JSON صالحاً" };
  }
}

/** محدِّد معدل ثابت النافذة، مناسب لحماية الخدمة المفتوحة دون مطالبة العميل بمفتاح. */
export class FixedWindowRateLimiter {
  constructor({ windowMs, maxRequests, maxEntries = 10_000, now = () => Date.now() }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  take(key) {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      if (this.entries.size >= this.maxEntries) {
        this.prune(now);
        // إذا كانت كل النوافذ حية، نحذف أقدم مدخل كي يبقى حد الذاكرة صارماً تحت ضغط مفاتيح مزيفة.
        if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
      }
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: Math.max(this.maxRequests - 1, 0), resetAt: now + this.windowMs };
    }
    if (entry.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }
    entry.count++;
    return { allowed: true, remaining: Math.max(this.maxRequests - entry.count, 0), resetAt: entry.resetAt };
  }

  prune(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt || this.entries.size > this.maxEntries) this.entries.delete(key);
    }
  }
}

export function requestClientKey(req, trustProxy = true) {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim().slice(0, 128) || "anonymous";
  }
  return req.headers.get("x-real-ip")?.trim().slice(0, 128) || "anonymous";
}

export function corsHeaders(req, allowedOrigins = "*") {
  const origin = req.headers.get("origin");
  const configured = String(allowedOrigins || "*").split(",").map((x) => x.trim()).filter(Boolean);
  const wildcard = configured.includes("*");
  const allowed = wildcard ? "*" : (origin && configured.includes(origin) ? origin : "null");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, X-Media-Title, X-Media-Type, X-Plugin, X-Request-Id",
    "Vary": wildcard ? "" : "Origin",
  };
}

export function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (value) merged.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

export function requestId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
