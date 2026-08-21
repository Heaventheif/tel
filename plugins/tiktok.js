// plugins/tiktok.js — تيك توك عبر مكتبة @tobyg74/tiktok-api-dl
import Tiktok from "@tobyg74/tiktok-api-dl";
import { config } from "../config.js";
import {
  QualityOption, ProbeResult, DownloadResult, streamToFile,
  PluginError, runProvider,
} from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.tiktok");

export const DESCRIPTION = "تيك توك — عبر مكتبة @tobyg74/tiktok-api-dl";
export const DOMAINS = ["tiktok.com"];
export const PRIORITY = 10;

// خيارات الجودة
const OPTIONS = [
  QualityOption({ kind: "video", label: "🎥 فيديو", key: "v_hd" }),
  QualityOption({ kind: "audio", label: "🎵 256kbps", key: "a_256" }),
  QualityOption({ kind: "audio", label: "🎵 128kbps", key: "a_128" }),
];

// ترتيب الإصدارات للمحاولة: v1 يُعطي أغنى بيانات، ثم v3، ثم v2
const VERSIONS = ["v1", "v3", "v2"];

function validateTikTokUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new PluginError("الرابط غير صالح (تأكد من صيغته)", { retryable: false, code: "INVALID_URL" });
  }
  const hosts = ["www.tiktok.com", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com"];
  if (!hosts.includes(url.hostname.toLowerCase())) {
    throw new PluginError("الرابط يجب أن يكون من TikTok", { retryable: false, code: "INVALID_PLATFORM" });
  }
}

/**
 * استخراج رابط الفيديو والعنوان من نتيجة المكتبة حسب الإصدار.
 * @returns {{ url: string, title: string, musicUrl?: string }}
 */
function extractMedia(version, result) {
  if (!result) throw new Error("نتيجة فارغة من المكتبة");

  switch (version) {
    case "v1": {
      // result.video.playAddr[] أو downloadAddr[]
      const videoUrl =
        result.video?.playAddr?.[0] ||
        result.video?.downloadAddr?.[0];
      if (!videoUrl) throw new Error("لا يوجد رابط فيديو في v1");
      return {
        url: videoUrl,
        title: result.desc || "فيديو تيك توك",
        musicUrl: result.music?.playUrl?.[0],
      };
    }
    case "v2": {
      // result.video.playAddr (نص مفرد)
      const videoUrl = result.video?.playAddr;
      if (!videoUrl) throw new Error("لا يوجد رابط فيديو في v2");
      return {
        url: videoUrl,
        title: result.desc || "فيديو تيك توك",
        musicUrl: result.music?.playUrl,
      };
    }
    case "v3": {
      // result.videoHD أو result.videoWatermark
      const videoUrl = result.videoHD || result.videoWatermark;
      if (!videoUrl) throw new Error("لا يوجد رابط فيديو في v3");
      return {
        url: videoUrl,
        title: result.desc || "فيديو تيك توك",
        musicUrl: typeof result.music === "string" ? result.music : undefined,
      };
    }
    default:
      throw new Error(`إصدار غير معروف: ${version}`);
  }
}

/**
 * محاولة تحميل بيانات الفيديو عبر إصدار واحد من المكتبة.
 */
async function resolveWithVersion(tiktokUrl, version) {
  const response = await Tiktok.Downloader(tiktokUrl, { version });

  if (!response || response.status !== "success") {
    throw new PluginError(
      response?.message || `فشل الإصدار ${version}`,
      { provider: version, retryable: true, code: "LIB_ERROR" }
    );
  }

  const result = response.result;
  try {
    return extractMedia(version, result);
  } catch (err) {
    throw new PluginError(err.message, { provider: version, retryable: true, code: "EXTRACT_FAILED" });
  }
}

/**
 * محاولة جميع الإصدارات بالتسلسل حتى ينجح أحدها.
 * @returns {{ url: string, title: string, musicUrl?: string }}
 */
async function resolve(tiktokUrl) {
  validateTikTokUrl(tiktokUrl);

  const failures = [];
  for (const version of VERSIONS) {
    try {
      return await runProvider("tiktok", version, () => resolveWithVersion(tiktokUrl, version));
    } catch (error) {
      failures.push(`${version}: ${error.message}`);
      logger.warning("فشل إصدار TikTok", { version, url: tiktokUrl, error: error.message });
    }
  }

  throw new PluginError("تعذّر استخراج رابط الفيديو من جميع الإصدارات", {
    provider: "tiktok",
    retryable: true,
    code: "ALL_VERSIONS_FAILED",
    cause: new Error(failures.join(" | ")),
  });
}

export async function probe(url) {
  let title = "فيديو تيك توك";
  try {
    ({ title } = await resolve(url));
  } catch (error) {
    logger.warning("فشل فحص TikTok", { url, error: error.message });
  }
  return ProbeResult({ title, options: OPTIONS, extra: { url } });
}

export async function download(url, choice) {
  const { url: mediaUrl, title } = await resolve(url);

  const videoPath = await streamToFile(mediaUrl, ".mp4", {
    timeoutTotal: 60,
    maxSize: config.UPLOAD_LIMIT,
  });

  // إذا طلب المستخدم صوتاً فقط
  if (choice.key.startsWith("a_")) {
    const quality = choice.key.split("_")[1];
    try {
      const audioPath = await extractAudio(videoPath, quality);
      return DownloadResult({ filePath: audioPath, title, isAudio: true });
    } finally {
      try { await Bun.file(videoPath).delete?.(); } catch {}
    }
  }

  return DownloadResult({ filePath: videoPath, title, isAudio: false });
}

async function extractAudio(videoPath, quality) {
  const outPath = `${videoPath}.audio.mp3`;
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-b:a", `${quality}k`, outPath],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;

  let outSize = 0;
  try {
    const { statSync } = await import("node:fs");
    outSize = statSync(outPath).size;
  } catch { outSize = 0; }

  if (code !== 0 || outSize === 0) {
    throw new PluginError(
      `فشل استخراج الصوت عبر ffmpeg: ${stderr.slice(0, 300)}`,
      { retryable: false, code: "FFMPEG_FAILED" }
    );
  }
  return outPath;
}
