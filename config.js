// config.js — مصدر الإعدادات الوحيد
// لا تستورد logger.js هنا لتجنّب الاعتماد الدائري.

function env(name, def) {
  const value = process.env[name];
  if (value === undefined) return def;
  if (typeof def === "boolean") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  if (typeof def === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : def;
  }
  return value;
}

function clampNumber(value, { min, max, fallback }) {
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const CACHE_TTL_DAYS = clampNumber(env("CACHE_TTL_DAYS", 30), { min: 0, max: 3650, fallback: 30 });

export const config = {
  // Telegram / Webhook
  TELEGRAM_TOKEN: (env("TELEGRAM_TOKEN", "") || "").trim(),
  SERVER_URL: (env("SERVER_URL", "") || "").replace(/\/+$/, ""),
  PORT: clampNumber(env("PORT", 10000), { min: 1, max: 65535, fallback: 10000 }),
  WEBHOOK_PATH: env("WEBHOOK_PATH", "/webhook"),
  // اختياري لكنه موصى به: يحمي مسار Webhook فقط، ولا يؤثر على /api المفتوحة.
  TELEGRAM_WEBHOOK_SECRET: (env("TELEGRAM_WEBHOOK_SECRET", "") || "").trim(),

  // حدود التشغيل
  MAX_CONCURRENT_DOWNLOADS: clampNumber(env("MAX_CONCURRENT_DOWNLOADS", 2), { min: 1, max: 20, fallback: 2 }),
  UPLOAD_LIMIT_MB: clampNumber(env("UPLOAD_LIMIT_MB", 50), { min: 1, max: 2000, fallback: 50 }),
  get UPLOAD_LIMIT() { return this.UPLOAD_LIMIT_MB * 1024 * 1024; },
  TEMP_DIR: (env("TEMP_DIR", "") || "").trim() || null,

  PENDING_TTL_MIN: clampNumber(env("PENDING_TTL_MIN", 30), { min: 1, max: 180, fallback: 30 }),
  SEARCH_PENDING_TTL_MIN: clampNumber(env("SEARCH_PENDING_TTL_MIN", 15), { min: 1, max: 180, fallback: 15 }),
  RATE_LIMIT_SECONDS: clampNumber(env("RATE_LIMIT_SECONDS", 3), { min: 0, max: 300, fallback: 3 }),
  MAX_CLIP_DURATION_SECONDS: clampNumber(env("MAX_CLIP_DURATION_SECONDS", 600), { min: 1, max: 7200, fallback: 600 }),

  // الإدارة
  ADMIN_CHAT_IDS: (env("ADMIN_CHAT_IDS", "") || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map(Number),

  // الكاش
  CACHE_DB_PATH: env("CACHE_DB_PATH", "media_cache.sqlite"),
  REDIS_URL: (env("REDIS_URL", "") || "").trim() || null,
  CACHE_TTL_DAYS,
  CACHE_TTL: CACHE_TTL_DAYS > 0 ? CACHE_TTL_DAYS * 86400 : null,
  CACHE_HASH_LEN: clampNumber(env("CACHE_HASH_LEN", 12), { min: 8, max: 32, fallback: 12 }),
  CACHE_ENABLED: env("CACHE_ENABLED", true),

  // APIs خارجية
  YT_API_1: env("YT_API_1", "https://ccproject.serv00.net/ytdl2.php"),
  YT_API_2: env("YT_API_2", "https://yt-dlp-stream.onrender.com/api"),
  // ترتيب مزودي YouTube قابل للتبديل بلا نشر جديد؛ vreden يبقى احتياطاً أخيراً فقط.
  YOUTUBE_PROVIDER_ORDER: (env("YOUTUBE_PROVIDER_ORDER", "youtubei,ccproject,yt2,vreden") || "youtubei,ccproject,yt2,vreden")
    .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  FB_DOWNLOAD_API: env("FB_DOWNLOAD_API", "https://betadash-api-swordslush-production.up.railway.app"),
  FB_DOWNLOAD_API_OLD: env("FB_DOWNLOAD_API_OLD", "https://facebook-video-download-api.onrender.com"),
  FERDEV_API_KEY: (env("FERDEV_API_KEY", "") || "").trim(),
  LYRICS_API: env("LYRICS_API", "https://api.lyrics.ovh/v1"),
  GROQ_API_KEY: env("GROQ_API_KEY", ""),
  AUDD_API_KEY: (env("AUDD_API_KEY", "") || "").trim(),

  KEEP_ALIVE_INTERVAL_MIN: clampNumber(env("KEEP_ALIVE_INTERVAL_MIN", 10), { min: 1, max: 120, fallback: 10 }),
  LOG_LEVEL: (env("LOG_LEVEL", "INFO") || "INFO").toUpperCase(),
  // JSON مناسب لـ Render logs؛ text يحافظ على الشكل المقروء الحالي افتراضياً.
  LOG_FORMAT: (env("LOG_FORMAT", "text") || "text").trim().toLowerCase() === "json" ? "json" : "text",

  // REST API عامة: لا مصادقة. الحماية تتم بالحدود والتحقق من المدخلات.
  API_PROBE_TIMEOUT_MS: clampNumber(env("API_PROBE_TIMEOUT_MS", 25_000), { min: 1_000, max: 120_000, fallback: 25_000 }),
  API_DOWNLOAD_TIMEOUT_MS: clampNumber(env("API_DOWNLOAD_TIMEOUT_MS", 120_000), { min: 5_000, max: 900_000, fallback: 120_000 }),
  API_BODY_LIMIT_BYTES: clampNumber(env("API_BODY_LIMIT_BYTES", 16_384), { min: 512, max: 1_048_576, fallback: 16_384 }),
  API_RATE_LIMIT_WINDOW_MS: clampNumber(env("API_RATE_LIMIT_WINDOW_MS", 60_000), { min: 1_000, max: 3_600_000, fallback: 60_000 }),
  API_RATE_LIMIT_PROBE: clampNumber(env("API_RATE_LIMIT_PROBE", 20), { min: 1, max: 1000, fallback: 20 }),
  API_RATE_LIMIT_DOWNLOAD: clampNumber(env("API_RATE_LIMIT_DOWNLOAD", 5), { min: 1, max: 1000, fallback: 5 }),
  API_CORS_ORIGINS: (env("API_CORS_ORIGINS", "*") || "*").trim(),
  TRUST_PROXY_HEADERS: env("TRUST_PROXY_HEADERS", true),

  validate() {
    const missing = ["TELEGRAM_TOKEN", "SERVER_URL"].filter((name) => !this[name]);
    if (missing.length) {
      console.error(`❌ متغيرات بيئة إلزامية ناقصة: ${missing.join(", ")} — راجع .env.example`);
      process.exit(1);
    }
    if (!this.WEBHOOK_PATH.startsWith("/")) {
      console.error("❌ WEBHOOK_PATH يجب أن يبدأ بـ /");
      process.exit(1);
    }
  },
};
