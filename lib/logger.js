// lib/logger.js — structured event logger
// NOTE: reads process.env directly to avoid a circular dependency with config.js.

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
const rawLevel = (process.env.LOG_LEVEL ?? "INFO").trim().toUpperCase();
const currentLevel = LEVELS[rawLevel] ?? LEVELS.INFO;
const logFormat = (process.env.LOG_FORMAT ?? "text").trim().toLowerCase() === "json" ? "json" : "text";

function timestamp() {
  return new Date().toISOString();
}

function normalizeError(error) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    code: error.code || undefined,
    provider: error.provider || undefined,
    retryable: error.retryable,
    stack: error.stack,
  };
}

function isMeta(value) {
  return value && typeof value === "object" && !(value instanceof Error) && !Array.isArray(value);
}

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function getLogger(name) {
  function log(level, message, ...details) {
    if (LEVELS[level] < currentLevel) return;
    const fn = level === "ERROR" ? console.error : level === "WARNING" ? console.warn : console.log;
    const meta = details.find(isMeta) || {};
    const error = details.find((item) => item instanceof Error);
    const safeMeta = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, normalizeError(value)]));

    if (logFormat === "json") {
      fn(JSON.stringify({
        ts: timestamp(),
        level,
        logger: name,
        message: String(message),
        ...safeMeta,
        ...(error ? { error: normalizeError(error) } : {}),
      }));
      return;
    }

    const suffix = [
      ...details.filter((item) => !isMeta(item)).map(stringify),
      Object.keys(safeMeta).length ? stringify(safeMeta) : "",
    ].filter(Boolean).join(" ");
    fn(`${timestamp().replace("T", " ").slice(0, 19)} [${name}] ${level} ${message}${suffix ? ` ${suffix}` : ""}`);
  }

  return {
    debug: (message, ...details) => log("DEBUG", message, ...details),
    info: (message, ...details) => log("INFO", message, ...details),
    warning: (message, ...details) => log("WARNING", message, ...details),
    warn: (message, ...details) => log("WARNING", message, ...details),
    error: (message, ...details) => log("ERROR", message, ...details),
    exception: (message, ...details) => log("ERROR", message, ...details),
  };
}
