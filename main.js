// main.js — نقطة الدخول
import { config } from "./config.js";
import * as cache from "./cache.js";
import {
  loadAllPlugins, runPendingSetups, findPlugin, getRegistry, getPlugins,
  getDownloadSemaphore, getSearchProviders, getExtraHandlers, splitMedia,
} from "./plugin-loader.js";
import { Bot, isCommand, isPlainText, commandName } from "./telegram-api.js";
import { getLogger } from "./lib/logger.js";
import { startKeepAlive, getKeepAliveStatus } from "./lib/keep-alive.js";
import { shortHash } from "./cache.js";
import { handleApiRequest } from "./api.js";

const logger = getLogger("main");

config.validate();

const UPLOAD_LIMIT = config.UPLOAD_LIMIT;
const URL_RE = /https?:\/\/\S+/;
const bot = new Bot(config.TELEGRAM_TOKEN);

// حالات مؤقتة في الذاكرة
const PENDING = new Map();          // token -> { url, plugin, title, options: Map, extra, ts, clip? }
const SEARCH_PENDING = new Map();   // token -> { results, query, ts }
const URL_MODE_PENDING = new Map(); // token -> { url, ts }
const URL_CLIP_AWAIT = new Map();   // chatId -> { url, statusMessageId, ts }
const DOWNLOAD_TASKS = new Map();   // token -> { cancelled, done }
const lastMessageTs = new Map();    // chatId -> ts (rate limiting للرسائل النصية)
const lastCallbackTs = new Map();   // chatId -> ts (rate limiting منفصل لأزرار callback)

const PENDING_TTL_MS = config.PENDING_TTL_MIN * 60 * 1000;
const SEARCH_TTL_MS = config.SEARCH_PENDING_TTL_MIN * 60 * 1000;

const PLATFORM_NAMES = {
  facebook: "فيسبوك", instagram: "إنستغرام", tiktok: "تيك توك", twitter: "Twitter/X",
  youtube: "يوتيوب", soundcloud: "SoundCloud", generic: "هذا الموقع",
};

// لا نعرض الرسالة الخام للمزود للمستخدم؛ نترجم نوع الخطأ إلى إجراء واضح ومختصر.
function friendlyPluginFailure(pluginName, error, action = "تنزيل") {
  const platform = PLATFORM_NAMES[pluginName] || pluginName || "المنصة";
  const message = String(error?.message || "");
  const protectedMedia = error?.retryable === false || /private|protected|restricted|age|غير خاص|محمي|خاص|غير متاح/i.test(message);
  if (protectedMedia) {
    return (
      "🔒 *المحتوى محمي أو خاص*\n\n" +
      `تعذّر ${action} محتوى *${platform}* — يبدو أن المنشور خاص أو مقيّد أو يتطلب تسجيل الدخول.\n\n` +
      "تأكد من أن الرابط متاح للعموم وأعد المحاولة."
    );
  }
  return (
    "⚠️ *تعذّر التنزيل*\n\n" +
    `واجهتُ مشكلة مؤقتة أثناء ${action} محتوى *${platform}*.\n\n` +
    "💡 جرّب:\n• إعادة المحاولة بعد لحظات\n• اختيار جودة أصغر\n• إعادة إرسال الرابط"
  );
}

function cleanupMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.ts > ttlMs) map.delete(k);
}

function isRateLimited(chatId, map) {
  const now = Date.now();
  const last = map.get(chatId) || 0;
  if (now - last < config.RATE_LIMIT_SECONDS * 1000) return true;
  map.set(chatId, now);
  return false;
}

// ══════════════════════════════════════════════
// بناء لوحة الأزرار من قائمة QualityOption
// ══════════════════════════════════════════════
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function buildKeyboard(token, options) {
  const toBtn = (o) => ({ text: o.label, callback_data: `dl|${token}|${o.key}` });
  const rows = [
    ...chunk(options.filter((o) => o.kind === "video"), 3),
    ...chunk(options.filter((o) => o.kind === "audio"), 3),
  ];
  return { inline_keyboard: rows.map((row) => row.map(toBtn)) };
}

// ══════════════════════════════════════════════
// فحص رابط وعرض خيارات الجودة
// ══════════════════════════════════════════════
async function probeAndPresent(url, chatId, messageId) {
  const plugin = findPlugin(url);
  if (!plugin) {
    await bot.editMessageText(
      chatId, messageId,
      "🚫 *الموقع غير مدعوم*\n\nلا أستطيع التعامل مع هذا الرابط حالياً.\n\n" +
      "✅ *المنصات المدعومة:*\nيوتيوب • تيك توك • إنستغرام • فيسبوك • تويتر/X • ساوندكلاود وغيرها\n\n" +
      "💡 استخدم /plugins لرؤية القائمة الكاملة",
      { parseMode: "Markdown" }
    );
    return;
  }

  await bot.editMessageText(chatId, messageId, `⏳ جاري فحص الرابط…`);

  let result;
  try {
    result = await Promise.race([
      plugin.probe(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), config.API_PROBE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    if (e.message === "timeout") {
      logger.warning(`[${plugin.name}] probe تجاوز المهلة | url=${url} | chat=${chatId}`);
      await bot.editMessageText(chatId, messageId,
        "⏱️ *انتهت المهلة*\n\nاستغرق فحص الرابط وقتاً طويلاً.\n\n💡 أعد المحاولة بعد لحظات.",
        { parseMode: "Markdown" }
      );
    } else {
      logger.exception(`[${plugin.name}] probe فشل | url=${url} | chat=${chatId}`, e);
      await bot.editMessageText(chatId, messageId, friendlyPluginFailure(plugin.name, e, "فحص"),
        { parseMode: "Markdown" }
      );
    }
    return;
  }

  if (!result?.options?.length) {
    await bot.editMessageText(chatId, messageId,
      "😕 *لا توجد جودات متاحة*\n\nتعذّر العثور على محتوى قابل للتنزيل في هذا الرابط.\n\n💡 تأكد من صحة الرابط وأن المحتوى متاح للعموم.",
      { parseMode: "Markdown" }
    );
    return;
  }

  cleanupMap(PENDING, PENDING_TTL_MS);
  // رمز فريد مربوط بالمحادثة، لمنع أن تعالج أزرار مستخدم طلب مستخدم آخر.
  const token = shortHash(`${chatId}|${url}|${Date.now()}|${Math.random()}`, config.CACHE_HASH_LEN);
  PENDING.set(token, {
    chatId, url, plugin: plugin.name, title: result.title,
    options: new Map(result.options.map((o) => [o.key, o])),
    extra: result.extra, ts: Date.now(),
  });

  const titleLine = result.title ? `*${result.title}*\n\n` : "";
  await bot.editMessageText(
    chatId, messageId,
    `🎬 ${titleLine}اختر الجودة المناسبة:`,
    { replyMarkup: buildKeyboard(token, result.options), parseMode: "Markdown" }
  );
}

// ══════════════════════════════════════════════
// بحث نصي متعدد المنصات
// ══════════════════════════════════════════════
const SOURCE_EMOJI = { YouTube: "▶️", SoundCloud: "🟠" };

async function handleSearchQuery(queryText, chatId) {
  const providers = getSearchProviders();
  if (!providers.length) return;

  const status = await bot.sendMessage(chatId, `🔍 جاري البحث عن «${queryText}»…`);

  const settled = await Promise.allSettled(providers.map((p) => p.search(queryText)));
  const allResults = settled.flatMap((s, i) => {
    if (s.status === "rejected") {
      logger.exception(`[${providers[i].name}] search فشل | query=${queryText}`, s.reason);
      return [];
    }
    return s.value || [];
  });

  if (!allResults.length) {
    await bot.editMessageText(chatId, status.message_id,
      "🔎 *لا نتائج*\n\nلم أجد نتائج مطابقة لبحثك.\n\n💡 جرّب:\n• صياغة مختلفة للعنوان\n• اسم الفنان مع اسم الأغنية\n• إرسال رابط مباشر",
      { parseMode: "Markdown" }
    );
    return;
  }

  const results = allResults.slice(0, 10);
  cleanupMap(SEARCH_PENDING, SEARCH_TTL_MS);
  const token = shortHash(`${chatId}|${queryText}|${Date.now()}|${Math.random()}`, config.CACHE_HASH_LEN);
  SEARCH_PENDING.set(token, { chatId, results, query: queryText, ts: Date.now() });

  const rows = results.map((r, i) => {
    const emoji = SOURCE_EMOJI[r.source] || "🎵";
    const dur = r.duration ? ` · ${r.duration}` : "";
    let label = `${i + 1}. ${emoji} ${r.title}${dur}`;
    if (label.length > 60) label = label.slice(0, 57) + "...";
    return [{ text: label, callback_data: `srch|${token}|${i}` }];
  });

  await bot.editMessageText(chatId, status.message_id, `🎵 *نتائج البحث عن «${queryText}»*\n\nاختر ما تريد تنزيله:`, {
    replyMarkup: { inline_keyboard: rows },
    parseMode: "Markdown",
  });
}

async function handleSearchChoice(cq) {
  const chatId = cq.message.chat.id;
  const [, token, idxS] = (cq.data || "").split("|");
  const idx = parseInt(idxS, 10);

  cleanupMap(SEARCH_PENDING, SEARCH_TTL_MS);
  const task = SEARCH_PENDING.get(token);
  if (!task) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت صلاحية نتائج البحث، أعد البحث.", true);
    return;
  }
  if (task.chatId !== chatId) {
    await bot.answerCallbackQuery(cq.id, "⚠️ هذا الزر تابع لمحادثة أخرى.", true);
    return;
  }
  if (Number.isNaN(idx) || idx < 0 || idx >= task.results.length) {
    await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير موجود.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);
  const chosen = task.results[idx];
  SEARCH_PENDING.delete(token);

  await bot.editMessageText(chatId, cq.message.message_id, `⏳ جاري فحص: *${chosen.title}*`, { parseMode: "Markdown" });
  await probeAndPresent(chosen.url, chatId, cq.message.message_id);
}

// ══════════════════════════════════════════════
// استقبال الرسائل النصية
// ══════════════════════════════════════════════
async function handleMessage(msg) {
  const text = (msg.text || "").trim();
  if (!text) return;
  const chatId = msg.chat.id;

  // إلغاء التحميل النشط برسالة "c"
  if (text.toLowerCase() === "c") {
    const cancelled = cancelActiveDownload(chatId);
    if (cancelled) await bot.sendMessage(chatId, "🚫 *جاري الإلغاء…*\n\nسيتوقف التحميل خلال لحظات.", { parseMode: "Markdown" });
    return;
  }

  const pendingClip = URL_CLIP_AWAIT.get(chatId);
  if (pendingClip) {
    URL_CLIP_AWAIT.delete(chatId);
    if (!URL_RE.test(text)) {
      await handleUrlClipTime(chatId, text, pendingClip);
      return;
    }
  }

  const m = URL_RE.exec(text);
  if (m) {
    const url = m[0];
    cleanupMap(URL_MODE_PENDING, PENDING_TTL_MS);
    const token = shortHash(`${chatId}|${url}|${Date.now()}|${Math.random()}`, config.CACHE_HASH_LEN);
    URL_MODE_PENDING.set(token, { chatId, url, ts: Date.now() });
    await bot.sendMessage(chatId, "📎 *تم استقبال الرابط*\n\nكيف تريد المتابعة؟", {
      replyMarkup: {
        inline_keyboard: [[
          { text: "⬇️ تنزيل كامل", callback_data: `mode|${token}|full` },
          { text: "✂️ قص جزء محدد", callback_data: `mode|${token}|part` },
        ]],
      },
      parseMode: "Markdown",
    });
    return;
  }

  if (text.length >= 2 && text.length <= 100) {
    await handleSearchQuery(text, chatId);
  }
}

async function handleUrlModeChoice(cq) {
  const chatId = cq.message.chat.id;
  const statusId = cq.message.message_id;
  const [, token, mode] = (cq.data || "").split("|");

  cleanupMap(URL_MODE_PENDING, PENDING_TTL_MS);
  const entry = URL_MODE_PENDING.get(token);
  if (!entry) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت الصلاحية، أعد إرسال الرابط.", true);
    return;
  }
  if (entry.chatId !== chatId) {
    await bot.answerCallbackQuery(cq.id, "⚠️ هذا الزر تابع لمحادثة أخرى.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);
  URL_MODE_PENDING.delete(token);

  if (mode === "full") {
    await bot.editMessageText(chatId, statusId, "⏳ جاري فحص الرابط…");
    await probeAndPresent(entry.url, chatId, statusId);
    return;
  }

  if (mode === "part") {
    await bot.editMessageText(
      chatId, statusId,
      "✂️ *قص جزء محدد*\n\nأرسل وقت البداية والنهاية بصيغة:\n`البداية - النهاية`\n\n📌 *مثال:* `0:30 - 1:15`\n\n_الحد الأقصى: 10 دقائق_",
      { parseMode: "Markdown" }
    );
    URL_CLIP_AWAIT.set(chatId, { url: entry.url, statusMessageId: statusId, ts: Date.now() });
    return;
  }

  await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير معروف.", true);
}

async function handleUrlClipTime(chatId, text, pending) {
  const { parseTimeRange } = await import("./plugins/media_tools.js");
  const statusId = pending.statusMessageId;

  let start, end;
  try {
    [start, end] = parseTimeRange(text);
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ *صيغة غير صحيحة*\n\n${e.message}\n\n💡 مثال: \`0:30 - 1:15\``, { parseMode: "Markdown" });
    URL_CLIP_AWAIT.set(chatId, pending);
    return;
  }

  await bot.editMessageText(chatId, statusId, "⏳ جاري فحص الرابط…");
  await probeAndPresent(pending.url, chatId, statusId);

  // يضاف القص إلى أحدث طلب صالح للمحادثة والرابط نفسه.
  for (const [, task] of PENDING) {
    if (task.chatId === chatId && task.url === pending.url) task.clip = { start, end };
  }
}

// ══════════════════════════════════════════════
// إرسال من الكاش
// ══════════════════════════════════════════════
async function sendCached(chatId, cached, statusMessageId) {
  if (cached.mediaType === "video") {
    await bot.sendCachedVideo(chatId, cached.fileId, null);
  } else if (cached.mediaType === "audio") {
    await bot.sendCachedAudio(chatId, cached.fileId, null, cached.title);
  } else {
    await bot.sendCachedDocument(chatId, cached.fileId, null);
  }
  await bot.deleteMessage(chatId, statusMessageId);
}

// ══════════════════════════════════════════════
// حذف ملف مؤقت
// ══════════════════════════════════════════════
function cleanupFile(path) {
  if (!path) return;
  try {
    Bun.file(path).delete?.();
    logger.info(`[cleanup] 🧹 تم حذف الملف المؤقت: ${path}`);
  } catch (e) {
    logger.exception(`فشل حذف الملف المؤقت: ${path}`, e);
  }
}

// ══════════════════════════════════════════════
// إرسال النتيجة مع تقسيم إذا لزم
// ══════════════════════════════════════════════
async function sendResult(chatId, dl, task, cacheKey) {
  const fsize = Bun.file(dl.filePath).size;
  let parts = [dl.filePath];

  if (fsize > UPLOAD_LIMIT) {
    if (dl.isDocument) {
      cleanupFile(dl.filePath);
      await bot.sendMessage(chatId, `📦 *الملف كبير جداً*\n\nحجم الملف *(${(fsize / 1024 / 1024).toFixed(1)}MB)* يتجاوز الحد المسموح به في تيليجرام *(50MB)*.\n\n💡 جرّب اختيار جودة أصغر.`, { parseMode: "Markdown" });
      return;
    }
    try {
      parts = await splitMedia(dl.filePath, { maxSize: UPLOAD_LIMIT, isAudio: dl.isAudio });
    } catch (e) {
      logger.exception(`[split] فشل تقسيم الملف | ${dl.filePath}`, e);
      cleanupFile(dl.filePath);
      await bot.sendMessage(chatId, `⚠️ *فشل تقسيم الملف*\n\nحجم الملف كبير وتعذّر تقسيمه تلقائياً.\n\n💡 جرّب اختيار جودة أصغر.`, { parseMode: "Markdown" });
      return;
    }
    if (!parts.includes(dl.filePath)) cleanupFile(dl.filePath);
  }

  try {
    let sent = null;
    for (const partPath of parts) {
      if (dl.isDocument) {
        const fname = dl.title.toLowerCase().endsWith(".zip") ? dl.title : partPath.split("/").pop();
        sent = await bot.sendDocument(chatId, partPath, { filename: fname });
      } else if (dl.isAudio) {
        sent = await bot.sendAudio(chatId, partPath, { title: dl.title });
      } else {
        sent = await bot.sendVideo(chatId, partPath);
      }
    }

    if (cacheKey && parts.length === 1 && sent) {
      const [urlHash, qualityKey] = cacheKey;
      const mediaType = dl.isDocument ? "document" : dl.isAudio ? "audio" : "video";
      const fileId = sent[mediaType]?.file_id;
      if (fileId) await cache.setCached(urlHash, qualityKey, fileId, mediaType, dl.title);
    }
  } catch (e) {
    logger.exception(`[send] فشل رفع الملف | plugin=${task.plugin} | chat=${chatId}`, e);
    await bot.sendMessage(chatId, `📤 *فشل رفع الملف*\n\nتم تنزيل الملف بنجاح لكن فشل إرساله إلى تيليجرام.\n\n💡 أعد المحاولة، وإن تكرّرت المشكلة جرّب جودة أصغر.`, { parseMode: "Markdown" });
  } finally {
    for (const p of parts) cleanupFile(p);
  }
}

// ══════════════════════════════════════════════
// إلغاء التحميل — المستخدم يرسل "c"
// ══════════════════════════════════════════════
function cancelActiveDownload(chatId) {
  for (const [, task] of DOWNLOAD_TASKS) {
    if (task.chatId === chatId && !task.done) {
      task.cancelled = true;
      return true;
    }
  }
  return false;
}

// ══════════════════════════════════════════════
// اختيار المستخدم → تحميل وإرسال
// ══════════════════════════════════════════════
async function handleChoice(cq) {
  const chatId = cq.message.chat.id;
  const [, token, key] = (cq.data || "").split("|");

  cleanupMap(PENDING, PENDING_TTL_MS);
  const task = PENDING.get(token);
  if (!task) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت صلاحية الطلب، أعد إرسال الرابط.", true);
    return;
  }
  if (task.chatId !== chatId) {
    await bot.answerCallbackQuery(cq.id, "⚠️ هذا الزر تابع لمحادثة أخرى.", true);
    return;
  }
  const option = task.options.get(key);
  if (!option) {
    await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير موجود.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);

  const urlHash = shortHash(task.url, config.CACHE_HASH_LEN);
  const cached = await cache.getCached(urlHash, key);
  if (cached) {
    try {
      await sendCached(chatId, cached, cq.message.message_id);
      PENDING.delete(token);
      return;
    } catch {
      logger.warning(`[cache] file_id مخزَّن لم يعد صالحاً (urlHash=${urlHash}, key=${key}) — تحميل عادي`);
    }
  }

  // نحذف الطلب من PENDING فوراً بعد التحقق لمنع النقر المزدوج من تشغيل تنزيلين متوازيين
  PENDING.delete(token);

  // حذف رسالة الجودة — لا نرسل أي رسالة "جاري التحميل"
  await bot.deleteMessage(chatId, cq.message.message_id);

  const pluginEntry = getPlugins().find((p) => p.name === task.plugin);
  if (!pluginEntry) {
    await bot.sendMessage(chatId, "🔧 *الخدمة غير متاحة مؤقتاً*\n\nأعد إرسال الرابط بعد لحظات.", { parseMode: "Markdown" });
    return;
  }

  const tDlStart = Date.now();
  const downloadTask = { cancelled: false, done: false, chatId };
  DOWNLOAD_TASKS.set(token, downloadTask);

  let dl;
  let release = null;
  let released = false;
  const releaseOnce = () => {
    if (release && !released) {
      released = true;
      release();
    }
  };
  try {
    // البوت والـ API يتشاركان القفل نفسه حتى لا تستنزف الطلبات العامة موارد Render.
    release = await getDownloadSemaphore().run();
    const dlPromise = Promise.resolve(pluginEntry.download(task.url, { key, option, extra: task.extra }));
    dlPromise.finally(releaseOnce).catch(() => {});
    const cancelPromise = new Promise((_, reject) => {
      const check = setInterval(() => {
        if (downloadTask.cancelled) {
          clearInterval(check);
          reject(new Error("__CANCELLED__"));
        }
      }, 300);
      dlPromise.finally(() => clearInterval(check)).catch(() => {});
    });
    dl = await Promise.race([dlPromise, cancelPromise]);
  } catch (e) {
    // عند الإلغاء يستمر التنزيل الأصلي إلى أن ينتهي، ولا نحرر القفل مبكراً.
    if (e.message !== "__CANCELLED__") releaseOnce();
    downloadTask.done = true;
    DOWNLOAD_TASKS.delete(token);
    if (e.message === "__CANCELLED__") {
      await bot.sendMessage(chatId, "🚫 *تم إلغاء التحميل*\n\nيمكنك إرسال الرابط مجدداً في أي وقت.", { parseMode: "Markdown" });
      return;
    }
    logger.exception(`[${task.plugin}] download فشل | url=${task.url} | chat=${chatId}`, e);
    await bot.sendMessage(chatId, friendlyPluginFailure(task.plugin, e), { parseMode: "Markdown" });
    return;
  }

  downloadTask.done = true;
  DOWNLOAD_TASKS.delete(token);
  logger.info(`[${task.plugin}] ⬇️ تحميل مكتمل في ${((Date.now() - tDlStart) / 1000).toFixed(1)}s | ${dl.filePath}`);

  let cacheKey = [urlHash, key];
  if (task.clip && !dl.isDocument) {
    const { trimMediaByTime } = await import("./plugins/media_tools.js");
    try {
      const trimmedPath = await trimMediaByTime(dl.filePath, task.clip.start, task.clip.end, dl.isAudio);
      cleanupFile(dl.filePath);
      dl.filePath = trimmedPath;
      cacheKey = null;
    } catch (e) {
      logger.exception(`[clip] فشل قص الجزء المطلوب | url=${task.url} | chat=${chatId}`, e);
      await bot.sendMessage(chatId, "✂️ *تعذّر القص*\n\nلم أتمكن من قص الجزء المطلوب — سيُرسل الملف كاملاً بدلاً من ذلك.", { parseMode: "Markdown" });
    }
  }

  await sendResult(chatId, dl, task, cacheKey);
}

// ══════════════════════════════════════════════
// أوامر البوت الأساسية
// ══════════════════════════════════════════════
async function cmdStart(msg) {
  const name = msg.from?.first_name ? ` ${msg.from.first_name}` : "";
  await bot.sendMessage(msg.chat.id,
    `👋 *أهلاً${name}!*\n\n` +
    "أنا بوت تنزيل الوسائط — أرسل لي أي مما يلي وسأتولى الباقي:\n\n" +
    "🔗 *رابط مباشر* من يوتيوب، تيك توك، إنستغرام، فيسبوك، تويتر/X، ساوندكلاود…\n" +
    "🎵 *اسم أغنية* للبحث والتنزيل\n" +
    "🎙️ *ملف صوتي أو فيديو* للتعرف على الأغنية أو استخراج الصوت\n\n" +
    "─────────────────\n" +
    "📋 /plugins — المنصات المدعومة\n" +
    "🎤 /lyrics `<اسم الأغنية>` — كلمات الأغنية\n\n" +
    "_💡 أرسل_ `c` _لإلغاء أي تنزيل جارٍ_",
    { parseMode: "Markdown" }
  );
}

const PLATFORM_LABELS = {
  facebook: "📘 فيسبوك / ريلز",
  instagram: "📸 إنستغرام",
  tiktok: "🎵 تيك توك",
  youtube: "▶️ يوتيوب",
  soundcloud: "☁️ ساوندكلاود",
};

async function cmdPlugins(msg) {
  const reg = getRegistry();
  const lines = Object.entries(reg)
    .filter(([, info]) => info.status === "loaded" && info.domains?.length && !info.domains.includes("*"))
    .map(([name]) => PLATFORM_LABELS[name] || `✅ ${name}`);
  if (reg.generic?.status === "loaded") lines.push("🌐 مواقع أخرى (رابط وسائط مباشر)");
  const count = lines.length;
  await bot.sendMessage(msg.chat.id,
    `🔌 *المنصات المدعومة (${count})*\n\n` +
    lines.join("\n") +
    "\n\n─────────────────\n" +
    "_أرسل رابطاً أو اسم أغنية للبدء_",
    { parseMode: "Markdown" }
  );
}

async function cmdClearCache(msg) {
  const chatId = msg.chat.id;
  if (!config.ADMIN_CHAT_IDS.includes(chatId)) {
    await bot.sendMessage(chatId, "🚫 *غير مصرح*\n\nهذا الأمر مخصص للمشرفين فقط.", { parseMode: "Markdown" });
    return;
  }
  let count;
  try {
    count = await cache.clearAllCache();
  } catch (e) {
    await bot.sendMessage(chatId, `❌ *فشل مسح الكاش*\n\n\`${e.message.slice(0, 200)}\``, { parseMode: "Markdown" });
    return;
  }
  const msg2 = count === -1
    ? "⏸️ *الكاش غير مفعّل*\n\n`CACHE_ENABLED=false` — لا شيء لمسحه."
    : `🧹 *تم مسح الكاش بنجاح*\n\n${count} مدخل محذوف.`;
  await bot.sendMessage(chatId, msg2, { parseMode: "Markdown" });
}

const BUILTIN_COMMANDS = { start: cmdStart, plugins: cmdPlugins, clear_cache: cmdClearCache };

// ══════════════════════════════════════════════
// تشغيل handlers الإضافية من plugins
// ══════════════════════════════════════════════
async function runExtraHandlers(obj, label) {
  for (const h of getExtraHandlers()) {
    try {
      if (h.filter(obj)) {
        await h.callback(obj, bot);
        return true;
      }
    } catch (e) {
      logger.exception(`[handler-plugin] فشل handler لـ ${label}`, e);
    }
  }
  return false;
}

// ══════════════════════════════════════════════
// توجيه التحديثات
// ══════════════════════════════════════════════
async function dispatchUpdate(update) {
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      // تطبيق rate limiting على الأزرار أيضاً لمنع النقر المتكرر السريع — بمعدل مستقل عن الرسائل
      // حتى لا يُحجب اختيار الجودة مباشرة بعد إرسال الرابط بسبب مشاركة نفس المؤقّت.
      if (chatId !== undefined && isRateLimited(chatId, lastCallbackTs)) {
        await bot.answerCallbackQuery(cq.id, "⏳ انتظر لحظة قبل المحاولة مرة أخرى.", true);
        return;
      }
      const data = cq.data || "";
      if (data.startsWith("dl|"))   return void (await handleChoice(cq));
      if (data.startsWith("srch|")) return void (await handleSearchChoice(cq));
      if (data.startsWith("mode|")) return void (await handleUrlModeChoice(cq));
      await runExtraHandlers(cq, "callback_query");
      return;
    }

    if (!update.message) return;
    const msg = update.message;

    if (msg.chat?.id !== undefined && isRateLimited(msg.chat.id, lastMessageTs)) return;

    if (isCommand(msg)) {
      const name = commandName(msg);
      if (BUILTIN_COMMANDS[name]) return void (await BUILTIN_COMMANDS[name](msg));
      await runExtraHandlers(msg, `أمر: ${name}`);
      return;
    }

    if (await runExtraHandlers(msg, "رسالة")) return;
    if (isPlainText(msg)) await handleMessage(msg);
  } catch (e) {
    logger.exception(`⚠️ خطأ غير متوقع في update=${JSON.stringify(update).slice(0, 300)}`, e);
  }
}

// ══════════════════════════════════════════════
// تنظيف دوري
// ══════════════════════════════════════════════
function startPeriodicCleanup() {
  setInterval(() => {
    try {
      cleanupMap(PENDING, PENDING_TTL_MS);
      cleanupMap(SEARCH_PENDING, SEARCH_TTL_MS);
      cleanupMap(URL_MODE_PENDING, PENDING_TTL_MS);
      const staleMs = Math.max(config.RATE_LIMIT_SECONDS, 1) * 20 * 1000;
      const now = Date.now();
      for (const [k, ts] of lastMessageTs) if (now - ts > staleMs) lastMessageTs.delete(k);
      for (const [k, ts] of lastCallbackTs) if (now - ts > staleMs) lastCallbackTs.delete(k);
    } catch (e) {
      logger.exception("[cleanup] فشل التنظيف الدوري", e);
    }
  }, 5 * 60 * 1000);
}

// ══════════════════════════════════════════════
// الإقلاع
// ══════════════════════════════════════════════
async function bootstrap() {
  await loadAllPlugins();
  await runPendingSetups();
  await cache.initCache(config);

  const handlerCount = getExtraHandlers().length;
  if (handlerCount) logger.info(`✅ تم تسجيل ${handlerCount} handler إضافي من الـ plugins`);

  await bot.setWebhook(`${config.SERVER_URL}${config.WEBHOOK_PATH}`, config.TELEGRAM_WEBHOOK_SECRET);
  startPeriodicCleanup();

  startKeepAlive(
    [config.YT_API_2, config.FB_DOWNLOAD_API_OLD, config.FB_DOWNLOAD_API],
    config.SERVER_URL ? `${config.SERVER_URL}/health` : null,
    (config.KEEP_ALIVE_INTERVAL_MIN || 10) * 60 * 1000
  );

  logger.info("✅ البوت يعمل!");
}

try {
  await bootstrap();
} catch (e) {
  logger.error(`❌ فشل إقلاع البوت — سيتم الإيقاف: ${e.message}`);
  process.exit(1);
}

// ══════════════════════════════════════════════
// خادم HTTP
// ══════════════════════════════════════════════
const server = Bun.serve({
  port: config.PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // Delegate /api/* requests to the external API handler
    const apiRes = await handleApiRequest(req);
    if (apiRes) return apiRes;

    if (req.method === "POST" && pathname === config.WEBHOOK_PATH) {
      if (config.TELEGRAM_WEBHOOK_SECRET &&
          req.headers.get("x-telegram-bot-api-secret-token") !== config.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "Unauthorized webhook" }, { status: 401 });
      }
      try {
        const upd = await req.json();
        if (upd) dispatchUpdate(upd);
      } catch (e) {
        logger.exception("webhook: خطأ أثناء معالجة التحديث", e);
      }
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && pathname === "/") {
      const accept = req.headers.get("accept") || "";
      if (accept.includes("application/json") && !accept.includes("text/html")) {
        return Response.json({ status: "online", plugins: getRegistry(), docs: "/docs" });
      }
      return new Response(Bun.file("./index.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && pathname === "/health") {
      return Response.json({ status: "healthy", ts: Date.now() / 1000 });
    }

    // ── Keep-Alive status — لا يحتاج مصادقة (بيانات غير حساسة) ──
    if (req.method === "GET" && pathname === "/api/keep-alive") {
      const records = getKeepAliveStatus();
      const allOk   = records.length > 0 && records.every((r) => r.ok);
      return Response.json({
        ok:        allOk,
        updatedAt: new Date().toISOString(),
        targets:   records,
      });
    }

    if (req.method === "GET" && pathname === "/docs") {
      return new Response(Bun.file("./docs.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
});

logger.info(`🌐 الخادم يعمل على المنفذ ${server.port}`);

async function shutdown() {
  await cache.closeCache();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
