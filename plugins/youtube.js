// plugins/youtube.js — YouTube عبر youtubei.js أولاً ثم APIs خارجية، من دون yt-dlp أو binary.
// يبقى vreden احتياطياً أخيراً فقط لتخفيف الاعتماد على savetube.vip غير المستقر.
import { join } from "node:path";
import { Innertube } from "youtubei.js";
import { config } from "../config.js";
import {
  QualityOption, ProbeResult, DownloadResult, PluginError,
  runProvider, streamToFile, hasVideoStream, hasAudioStream,
} from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.youtube");

export const DESCRIPTION = "يوتيوب — YouTube.js + مزودات API احتياطية (بدون yt-dlp)";
export const DOMAINS = ["youtube.com", "youtu.be"];
export const PRIORITY = 10;

const CCPROJECT = config.YT_API_1;
const YT2_BASE = config.YT_API_2;
const VREDEN_TIMEOUT_MS = 25_000;
const YOUTUBEI_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER_ORDER = ["youtubei", "ccproject", "yt2", "vreden"];
const AUDIO_QUALITIES = [92, 128, 256, 320];

const VIDEO_OPTIONS = [
  QualityOption({ kind: "video", label: "🎥 1080p", key: "v_1080" }),
  QualityOption({ kind: "video", label: "🎥 720p", key: "v_720" }),
  QualityOption({ kind: "video", label: "🎥 480p", key: "v_480" }),
  QualityOption({ kind: "video", label: "🎥 360p", key: "v_360" }),
];
const AUDIO_OPTIONS = [
  QualityOption({ kind: "audio", label: "🎵 256kbps", key: "a_256" }),
  QualityOption({ kind: "audio", label: "🎵 128kbps", key: "a_128" }),
  QualityOption({ kind: "audio", label: "🎵 64kbps", key: "a_64" }),
];

let _innertube = null;
let _ytLib = null;

function nearestAudioQuality(q) {
  q = Number(q);
  if (!Number.isFinite(q)) return 128;
  return AUDIO_QUALITIES.reduce((best, current) => Math.abs(current - q) < Math.abs(best - q) ? current : best);
}

function configuredProviders() {
  const seen = new Set();
  const requested = [...(config.YOUTUBE_PROVIDER_ORDER || []), ...DEFAULT_PROVIDER_ORDER];
  return requested.filter((name) => PROVIDERS[name] && !seen.has(name) && seen.add(name));
}

function providerError(message, provider, { retryable = true, code, cause } = {}) {
  return new PluginError(message, { provider, retryable, code, cause });
}

function permanentProviderError(message) {
  return /private|غير خاص|محمي|restricted|age|sign in|unavailable|not available|not found|HTTP\s+(?:400|401|403|404|410)/i.test(message);
}

async function deadline(fn, timeoutMs, provider) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(providerError(`انتهت مهلة ${provider}`, provider, { code: "TIMEOUT" })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function innertube() {
  if (!_innertube) {
    // لا نستخدم cache على القرص لأن Render Free لا يوفّر تخزيناً دائماً.
    _innertube = Innertube.create({ lang: "ar", location: "SA", generate_session_locally: true, enable_session_cache: false });
  }
  return _innertube;
}

async function ytLib() {
  if (!_ytLib) _ytLib = import("@vreden/youtube_scraper");
  return _ytLib;
}

async function streamYoutubeiToFile(stream, suffix) {
  const path = join(Bun.env.TMPDIR || "/tmp", `youtubei_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);
  const writer = Bun.file(path).writer();
  const reader = stream.getReader();
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > config.UPLOAD_LIMIT) {
        await reader.cancel();
        throw providerError(`الملف يتجاوز الحجم المسموح (${config.UPLOAD_LIMIT_MB}MB)`, "youtubei", { retryable: false, code: "SIZE_EXCEEDED" });
      }
      writer.write(value);
    }
    await writer.end();
    if (!bytes) throw providerError("ملف YouTube.js الناتج فارغ", "youtubei");
    complete = true;
    return path;
  } finally {
    try { await reader.cancel(); } catch {}
    try { await writer.end(); } catch {}
    if (!complete) {
      try { await Bun.file(path).delete?.(); } catch {}
    }
  }
}

async function probeViaYoutubei(url) {
  try {
    const client = await deadline(innertube, YOUTUBEI_TIMEOUT_MS, "youtubei");
    const info = await deadline(() => client.getInfo(url), YOUTUBEI_TIMEOUT_MS, "youtubei");
    const title = info?.basic_info?.title;
    if (!title) throw providerError("لم يُعد YouTube.js عنواناً صالحاً", "youtubei");
    return String(title);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    const message = String(error?.message || error);
    throw providerError(message, "youtubei", { retryable: !permanentProviderError(message), cause: error });
  }
}

async function probeViaYt2(url) {
  try {
    const res = await fetch(`${YT2_BASE}/v2/q?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new PluginError(`HTTP ${res.status}`);
    let data = await res.json();
    if (Array.isArray(data)) data = data[0] || {};
    if (!data?.title) throw new PluginError("لا يوجد عنوان في الاستجابة");
    return String(data.title);
  } catch (error) {
    const message = String(error?.message || error);
    throw providerError(message, "yt2", { retryable: !permanentProviderError(message), cause: error });
  }
}

async function probeViaVreden(url) {
  try {
    const yt = await ytLib();
    const info = await deadline(() => yt.metadata(url), VREDEN_TIMEOUT_MS, "vreden");
    if (!info || info.status === false || !info.title) throw new PluginError(info?.error || "فشل metadata");
    return String(info.title);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    const message = String(error?.message || error);
    throw providerError(message, "vreden", { retryable: !permanentProviderError(message), cause: error });
  }
}

export async function probe(url) {
  for (const name of configuredProviders()) {
    const provider = PROVIDERS[name];
    if (!provider.probe) continue;
    try {
      const title = await runProvider("youtube", name, () => provider.probe(url));
      return ProbeResult({ title, options: [...VIDEO_OPTIONS, ...AUDIO_OPTIONS], extra: { url } });
    } catch (error) {
      logger.warning("فشل فحص مزود YouTube", { provider: name, url, error: error.message });
    }
  }
  // لا يمنع تعذّر العنوان المستخدم من محاولة التحميل عبر أحد المزودات لاحقاً.
  return ProbeResult({ title: "فيديو يوتيوب", options: [...VIDEO_OPTIONS, ...AUDIO_OPTIONS], extra: { url } });
}

async function runProcess(command, timeoutMs = 240_000) {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

async function videoCodecs(filePath) {
  const { stdout, exitCode } = await runProcess([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name", "-of", "csv=p=0", filePath,
  ], 30_000);
  if (exitCode !== 0) return { video: null, audio: null };
  const video = stdout.trim().split(/\s+/)[0] || null;
  const audioResult = await runProcess([
    "ffprobe", "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name", "-of", "csv=p=0", filePath,
  ], 30_000);
  return { video, audio: audioResult.stdout.trim().split(/\s+/)[0] || null };
}

async function normalizeTelegramVideo(filePath) {
  const codecs = await videoCodecs(filePath);
  if (codecs.video === "h264" && codecs.audio === "aac") return filePath;

  const outputPath = join(Bun.env.TMPDIR || "/tmp", `youtube_normalized_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const { stderr, exitCode } = await runProcess([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", filePath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", outputPath,
  ]);
  if (exitCode !== 0 || !Bun.file(outputPath).size) {
    try { await Bun.file(outputPath).delete?.(); } catch {}
    throw new Error(`فشل توحيد ترميز فيديو YouTube: ${stderr.slice(0, 300)}`);
  }
  try { await Bun.file(filePath).delete?.(); } catch {}
  return outputPath;
}

async function muxTelegramVideo(videoPath, audioPath) {
  const outputPath = join(Bun.env.TMPDIR || "/tmp", `youtube_h264_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const { stderr, exitCode } = await runProcess([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath, "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", outputPath,
  ]);
  if (exitCode !== 0 || !Bun.file(outputPath).size) {
    try { await Bun.file(outputPath).delete?.(); } catch {}
    throw new Error(`فشل تجهيز فيديو YouTube لـ Telegram: ${stderr.slice(0, 300)}`);
  }
  return outputPath;
}

async function downloadYoutubeiVideo(info, quality) {
  // صيغ 720p/1080p في YouTube غالباً adaptive (فيديو بلا صوت). تنزيل
  // مسار واحد قد ينتج ملفاً بصوت فقط أو ملفاً غير قابل للعرض في Telegram.
  const videoStream = await deadline(
    () => info.download({ type: "video", quality: `${quality}p`, format: "mp4" }),
    YOUTUBEI_TIMEOUT_MS,
    "youtubei-video"
  );
  const audioStream = await deadline(
    () => info.download({ type: "audio", quality: "128kbps", format: "mp4" }),
    YOUTUBEI_TIMEOUT_MS,
    "youtubei-audio"
  );
  const videoPath = await streamYoutubeiToFile(videoStream, ".video");
  let audioPath = null;
  try {
    audioPath = await streamYoutubeiToFile(audioStream, ".m4a");
    const outputPath = await muxTelegramVideo(videoPath, audioPath);
    return outputPath;
  } finally {
    try { await Bun.file(videoPath).delete?.(); } catch {}
    if (audioPath) try { await Bun.file(audioPath).delete?.(); } catch {}
  }
}

async function viaYoutubei(url, wantMp4, quality) {
  try {
    const client = await deadline(innertube, YOUTUBEI_TIMEOUT_MS, "youtubei");
    const info = await deadline(() => client.getInfo(url), YOUTUBEI_TIMEOUT_MS, "youtubei");
    const numericQuality = Number(quality);
    const filePath = wantMp4 && numericQuality >= 720
      ? await downloadYoutubeiVideo(info, numericQuality)
      : await streamYoutubeiToFile(
        await deadline(
          () => info.download(wantMp4
            ? { type: "video+audio", quality: `${quality}p`, format: "mp4" }
            : { type: "audio", quality: `${nearestAudioQuality(quality)}kbps`, format: "mp4" }),
          YOUTUBEI_TIMEOUT_MS,
          "youtubei"
        ),
        wantMp4 ? ".mp4" : ".m4a"
      );
    return DownloadResult({ filePath, title: info?.basic_info?.title || "يوتيوب", isAudio: !wantMp4 });
  } catch (error) {

    if (error instanceof PluginError) throw error;
    const message = String(error?.message || error);
    throw providerError(message, "youtubei", { retryable: !permanentProviderError(message), cause: error });
  }
}

async function viaCcproject(url, wantMp4, quality) {
  try {
    const qs = new URLSearchParams({ url, type: wantMp4 ? "mp4" : "mp3" });
    const res = await fetch(`${CCPROJECT}?${qs}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new PluginError(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.download) throw new PluginError(data?.error || "لا يوجد رابط تحميل");
    const filePath = await streamToFile(data.download, wantMp4 ? ".mp4" : ".mp3", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
    return DownloadResult({ filePath, title: data.title || "يوتيوب", isAudio: !wantMp4 });
  } catch (error) {
    const message = String(error?.message || error);
    throw providerError(message, "ccproject", { retryable: !permanentProviderError(message), cause: error });
  }
}

async function viaYt2(url, wantMp4) {
  try {
    const res = await fetch(`${YT2_BASE}/v2/q?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new PluginError(`HTTP ${res.status}`);
    let data = await res.json();
    if (Array.isArray(data)) data = data[0] || {};
    const media = data?.media || {};
    const pick = (value) => typeof value === "string" ? value : value?.url;
    const dlUrl = pick(wantMp4 ? media.mp4 : media.mp3);
    if (!dlUrl) throw new PluginError("لا يوجد رابط تحميل");
    const filePath = await streamToFile(dlUrl, wantMp4 ? ".mp4" : ".mp3", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
    return DownloadResult({ filePath, title: data?.title || "يوتيوب", isAudio: !wantMp4 });
  } catch (error) {
    const message = String(error?.message || error);
    throw providerError(message, "yt2", { retryable: !permanentProviderError(message), cause: error });
  }
}

async function viaVreden(url, wantMp4, quality) {
  try {
    const yt = await ytLib();
    const q = wantMp4 ? Number(quality) : nearestAudioQuality(quality);
    const result = await deadline(() => wantMp4 ? yt.ytmp4(url, q) : yt.ytmp3(url, q), VREDEN_TIMEOUT_MS, "vreden");
    if (!result || result.status === false) throw new PluginError(result?.error || "فشل التحويل");
    const download = result.download || {};
    if (!download.status || !download.url) throw new PluginError("لا يوجد رابط تحميل في الاستجابة");
    const filePath = await streamToFile(download.url, wantMp4 ? ".mp4" : ".mp3", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
    return DownloadResult({ filePath, title: result?.metadata?.title || "يوتيوب", isAudio: !wantMp4 });
  } catch (error) {
    if (error instanceof PluginError) throw error;
    const message = String(error?.message || error);
    throw providerError(message, "vreden", { retryable: !permanentProviderError(message), cause: error });
  }
}

const PROVIDERS = {
  youtubei: { probe: probeViaYoutubei, download: viaYoutubei },
  ccproject: { download: viaCcproject },
  yt2: { probe: probeViaYt2, download: viaYt2 },
  vreden: { probe: probeViaVreden, download: viaVreden },
};

export async function download(url, choice) {
  const isAudio = choice.key.startsWith("a_");
  const quality = choice.key.split("_")[1];
  const errors = [];

  for (const name of configuredProviders()) {
    const provider = PROVIDERS[name];
    if (!provider.download) continue;
    const startedAt = Date.now();
    try {
      let result = await runProvider("youtube", name, () => provider.download(url, !isAudio, quality));
      if (!isAudio) {
        result.filePath = await normalizeTelegramVideo(result.filePath);
        const [hasVideo, hasAudio] = await Promise.all([
          hasVideoStream(result.filePath),
          hasAudioStream(result.filePath),
        ]);
        if (!hasVideo) {
          try { await Bun.file(result.filePath).delete?.(); } catch {}
          throw providerError("الملف المُرجَع بلا مسار فيديو", name);
        }
        if (!hasAudio) {
          try { await Bun.file(result.filePath).delete?.(); } catch {}
          throw providerError("الملف المُرجَع بلا مسار صوت؛ تمت إعادة المحاولة بمزود آخر", name);
        }
      }
      logger.info("اكتمل تنزيل YouTube", { provider: name, durationMs: Date.now() - startedAt, url });
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(`${name}: ${message}`);
      logger.warning("فشل مزود YouTube", { provider: name, durationMs: Date.now() - startedAt, url, error: message });
    }
  }

  throw new PluginError("فشل كل مزودي YouTube الخارجيين", {
    provider: "youtube",
    retryable: true,
    code: "ALL_PROVIDERS_FAILED",
    cause: new PluginError(errors.join(" | ")),
  });
}
