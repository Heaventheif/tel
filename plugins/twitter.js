// plugins/twitter.js — Twitter/X عبر smfahim.xyz، معزول عن المسار العام لسهولة الصيانة.
import { config } from "../config.js";
import {
  QualityOption, ProbeResult, DownloadResult, PluginError,
  runProvider, streamToFile,
} from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";
import { assertSafePublicUrl, safeFetch } from "../lib/http.js";

const logger = getLogger("plugin.twitter");

export const DESCRIPTION = "Twitter/X — smfahim.xyz API";
export const DOMAINS = ["twitter.com", "x.com", "t.co"];
export const PRIORITY = 20;

const PROVIDER = "smfahim";
const API_VERSIONS = 15;
const TIMEOUT_MS = 20_000;
const OPTIONS = [
  QualityOption({ kind: "video", label: "أفضل جودة متاحة", key: "v_best" }),
  QualityOption({ kind: "video", label: "أصغر ملف متاح", key: "v_smallest" }),
];

const browserHeaders = (referer) => ({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
  Referer: referer,
  Accept: "application/json,text/plain,*/*",
});

function apiUrl(version, url) {
  return `https://www.smfahim.xyz/download/all/v${version}?url=${encodeURIComponent(url)}`;
}

function candidatesFrom(data) {
  const links = data?.links || {};
  const raw = [{ url: links.hd, quality: "hd" }, { url: links.sd, quality: "sd" }].filter((item) => item.url);
  const safe = raw.flatMap((item) => {
    try { return [{ ...item, url: assertSafePublicUrl(item.url).href }]; } catch { return []; }
  });
  return [...new Map(safe.map((item) => [item.url, item])).values()];
}

function classify(message, cause) {
  const retryable = !/private|protected|not found|HTTP\s+(?:400|401|403|404|410)/i.test(message);
  return new PluginError(message, { provider: PROVIDER, retryable, code: retryable ? "UPSTREAM_FAILURE" : "UNAVAILABLE_MEDIA", cause });
}

async function resolveOnce(url) {
  const failures = [];
  for (let version = 1; version <= API_VERSIONS; version++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await safeFetch(apiUrl(version, url), {
        headers: browserHeaders(url),
        signal: controller.signal,
      });
      if (!response.ok) throw new PluginError(`HTTP ${response.status}`);
      const data = await response.json();
      const candidates = candidatesFrom(data);
      if (data?.status === true && candidates.length) {
        return { candidates, title: String(data.title || "فيديو تويتر/X").slice(0, 100) };
      }
      failures.push(`v${version}: لا توجد وسائط`);
    } catch (error) {
      failures.push(`v${version}: ${error?.name === "AbortError" ? "timeout" : error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw classify(`تعذّر استخراج وسائط Twitter/X (${failures.join(" | ").slice(0, 600)})`);
}

async function resolve(url) {
  const safeUrl = assertSafePublicUrl(url).href;
  return runProvider("twitter", PROVIDER, () => resolveOnce(safeUrl));
}

export async function probe(url) {
  try {
    const resolved = await resolve(url);
    return ProbeResult({ title: resolved.title, options: OPTIONS, extra: { resolved } });
  } catch (error) {
    logger.warning("فشل فحص Twitter/X", { provider: PROVIDER, url, error: error.message });
    // نسمح بإظهار خيارات التنزيل؛ قد ينجح المزود في المحاولة اللاحقة بعد cold start.
    return ProbeResult({ title: "فيديو تويتر/X", options: OPTIONS, extra: {} });
  }
}

export async function download(url, choice = {}) {
  const resolved = choice.extra?.resolved || await resolve(url);
  const selected = choice.key === "v_smallest" ? resolved.candidates.at(-1) : resolved.candidates[0];
  if (!selected?.url) {
    throw new PluginError("لم تُعثر على جودة Twitter/X قابلة للتنزيل", {
      provider: PROVIDER,
      retryable: false,
      code: "NO_MEDIA",
    });
  }
  const filePath = await streamToFile(selected.url, ".mp4", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
  return DownloadResult({ filePath, title: resolved.title, isAudio: false });
}
