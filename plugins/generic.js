// plugins/generic.js — مسار احتياطي آمن للوسائط المباشرة وصفحات الفيديو العامة.
// يدعم روابط MP4/WebM/MOV/MKV/MP3/M4A و HLS (M3U8)، وبيانات OpenGraph/JSON-LD
// و iframe بعمق واحد. منطق Twitter/X موجود في plugins/twitter.js مستقلاً للصيانة.

import HlsDownloader from "hlsdownloader";
import path from "node:path";
import { config } from "../config.js";
import { QualityOption, ProbeResult, DownloadResult, streamToFile, PluginError } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";
import { assertSafePublicUrl, safeFetch } from "../lib/http.js";

const logger = getLogger("plugin.generic");

export const DESCRIPTION = "عام — وسائط مباشرة وHLS وOpenGraph/JSON-LD وiFrame";
export const DOMAINS = ["*"];
export const PRIORITY = 99;

const OPTIONS = [
  QualityOption({ kind: "video", label: "أفضل جودة متاحة", key: "v_best" }),
  QualityOption({ kind: "video", label: "أصغر ملف متاح", key: "v_smallest" }),
];
const MEDIA_EXTENSIONS = [".m3u8", ".mp4", ".webm", ".mkv", ".mov", ".flv", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav"];
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav"]);
const PAGE_MAX_BYTES = 2 * 1024 * 1024;

const browserHeaders = (referer) => ({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "Referer": referer,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.7",
});

function cleanCandidate(value) {
  if (!value || typeof value !== "string") return null;
  const cleaned = value
    .replace(/\\u0026|\\\//g, (match) => match === "\\u0026" ? "&" : "/")
    .replace(/&amp;/gi, "&")
    .replace(/["'`<>\\]/g, "")
    .trim();
  return cleaned || null;
}

function normalizedUrl(value, baseUrl) {
  const candidate = cleanCandidate(value);
  if (!candidate) return null;
  try { return assertSafePublicUrl(new URL(candidate, baseUrl).href).href; } catch { return null; }
}

function extractTitle(html) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+/g, " ").trim().slice(0, 160);
  }
  return "وسيط عام";
}

function extractAbsoluteMediaLinks(html, baseUrl) {
  const links = new Set();
  const patterns = [
    /https?:\\?\/\\?\/[^\s"'`<>]+?\.(?:m3u8|mp4|webm|mkv|mov|flv|mp3|m4a|aac|ogg|opus|wav)(?:[^\s"'`<>]*)/gi,
    /https?:\/\/[^\s"'`<>]+?\.(?:m3u8|mp4|webm|mkv|mov|flv|mp3|m4a|aac|ogg|opus|wav)(?:[^\s"'`<>]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = normalizedUrl(match[0], baseUrl);
      if (url) links.add(url);
    }
  }
  return [...links];
}

function extractAttributeLinks(html, baseUrl) {
  const links = new Set();
  const pattern = /<(?:video|audio|source)[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = normalizedUrl(match[1], baseUrl);
    if (url) links.add(url);
  }
  return [...links];
}

function extractMetaLinks(html, baseUrl) {
  const links = new Set();
  const tags = html.match(/<meta\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!property || !["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream", "twitter:player:stream:url"].includes(property)) continue;
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
    const url = normalizedUrl(content, baseUrl);
    if (url) links.add(url);
  }
  return [...links];
}

function walkJsonForMedia(value, found) {
  if (!value) return;
  if (Array.isArray(value)) return value.forEach((item) => walkJsonForMedia(item, found));
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["contentUrl", "embedUrl", "url", "videoUrl", "streamUrl"].includes(key) && typeof item === "string") found.push(item);
    walkJsonForMedia(item, found);
  }
}

function extractJsonLdLinks(html, baseUrl) {
  const links = new Set();
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const candidates = [];
      walkJsonForMedia(JSON.parse(match[1]), candidates);
      for (const candidate of candidates) {
        const url = normalizedUrl(candidate, baseUrl);
        if (url) links.add(url);
      }
    } catch { /* صفحة تحتوي JSON-LD غير مكتمل */ }
  }
  return [...links];
}

function extractIframes(html, baseUrl) {
  const frames = new Set();
  const pattern = /<iframe[^>]+src=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = normalizedUrl(match[1], baseUrl);
    if (url) frames.add(url);
  }
  return [...frames].slice(0, 5);
}

function extensionOf(url) {
  try { return path.extname(new URL(url).pathname).toLowerCase(); } catch { return ""; }
}

function isDirectMediaUrl(url) {
  return MEDIA_EXTENSIONS.includes(extensionOf(url));
}

function isHlsUrl(url) {
  try { return /\.m3u8(?:$|[?&#])/i.test(new URL(url).href); } catch { return false; }
}

async function fetchPage(url, referer = url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await safeFetch(url, { headers: browserHeaders(referer), signal: controller.signal });
    if (!response.ok) throw new PluginError(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > PAGE_MAX_BYTES) throw new PluginError("صفحة المصدر أكبر من الحد المسموح");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > PAGE_MAX_BYTES) throw new PluginError("صفحة المصدر أكبر من الحد المسموح");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function findMediaInHtml(html, baseUrl) {
  const candidates = [
    ...extractAbsoluteMediaLinks(html, baseUrl),
    ...extractAttributeLinks(html, baseUrl),
    ...extractMetaLinks(html, baseUrl),
    ...extractJsonLdLinks(html, baseUrl),
  ];
  const direct = [...new Set(candidates)].find((url) => isDirectMediaUrl(url));
  return direct || null;
}

async function findGenericMedia(pageUrl) {
  const safePage = assertSafePublicUrl(pageUrl).href;
  const html = await fetchPage(safePage);
  const title = extractTitle(html);
  const direct = findMediaInHtml(html, safePage);
  if (direct) return { url: direct, title, method: "page-metadata" };

  for (const iframeUrl of extractIframes(html, safePage)) {
    try {
      const iframeHtml = await fetchPage(iframeUrl, safePage);
      const iframeMedia = findMediaInHtml(iframeHtml, iframeUrl);
      if (iframeMedia) return { url: iframeMedia, title, method: "iframe" };
    } catch (error) {
      logger.debug(`[generic] تعذّر فحص iframe: ${error.message}`);
    }
  }
  return null;
}

async function downloadHls(url, title) {
  const directory = config.TEMP_DIR || Bun.env.TMPDIR || "/tmp";
  const filePath = path.join(directory, `generic_hls_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const downloader = new HlsDownloader(assertSafePublicUrl(url).href, filePath, { concurrency: 4 });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new PluginError("انتهت مهلة HLS")), 300_000);
  });
  try {
    await Promise.race([downloader.start(), timeout]);
    const size = Bun.file(filePath).size;
    if (!size) throw new PluginError("ملف HLS الناتج فارغ");
    if (size > config.UPLOAD_LIMIT) throw new PluginError("ملف HLS الناتج يتجاوز حد الرفع");
    return DownloadResult({ filePath, title, isAudio: false });
  } catch (error) {
    try { await Bun.file(filePath).delete?.(); } catch {}
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function probe(url) {
  const safeUrl = assertSafePublicUrl(url).href;
  if (isDirectMediaUrl(safeUrl)) {
    return ProbeResult({ title: "رابط وسائط مباشر", options: OPTIONS, extra: { source: "direct" } });
  }
  try {
    const found = await findGenericMedia(safeUrl);
    return ProbeResult({ title: found?.title || "وسيط عام", options: OPTIONS, extra: { source: "generic" } });
  } catch (error) {
    logger.warning(`[generic] probe فشل: ${error.message}`);
    return ProbeResult({ title: "وسيط عام", options: OPTIONS, extra: { source: "generic" } });
  }
}

export async function download(url, choice = {}) {
  const safeUrl = assertSafePublicUrl(url).href;
  if (isDirectMediaUrl(safeUrl)) {
    const extension = extensionOf(safeUrl) || ".mp4";
    if (isHlsUrl(safeUrl)) return downloadHls(safeUrl, "بث HLS مباشر");
    const filePath = await streamToFile(safeUrl, extension, { timeoutTotal: 300, maxSize: config.UPLOAD_LIMIT });
    return DownloadResult({ filePath, title: "رابط وسائط مباشر", isAudio: AUDIO_EXTENSIONS.has(extension) });
  }

  const found = await findGenericMedia(safeUrl);
  if (!found?.url) throw new PluginError("لم نعثر على رابط وسائط مباشر في هذه الصفحة");
  logger.info(`[generic] المصدر=${found.method} url=${new URL(found.url).origin}`);
  if (isHlsUrl(found.url)) return downloadHls(found.url, found.title);

  const extension = extensionOf(found.url) || ".mp4";
  const filePath = await streamToFile(found.url, extension, { timeoutTotal: 300, maxSize: config.UPLOAD_LIMIT });
  return DownloadResult({ filePath, title: found.title, isAudio: AUDIO_EXTENSIONS.has(extension) });
}
