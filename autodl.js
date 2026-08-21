/**
 * autodl.js — قالب أمر /autodl لبوت تيليغرام
 * ════════════════════════════════════════════════════════════════
 *
 * يستخدم هذا الملف واجهة برمجة التطبيقات (API) الخاصة بالسيرفر:
 *   https://telegram-bhci.onrender.com
 *
 * لا يلزم أي مفتاح API أو مصادقة — الـ endpoints مفتوحة للجميع.
 *
 * ── تدفق العمل ──────────────────────────────────────────────────
 *
 *   1. المستخدم يرسل /autodl <رابط> [جودة]
 *   2. نُرسل الرابط إلى POST /api/probe → نحصل على قائمة الجودات
 *   3. نعرض الأزرار على المستخدم (أو نختار الجودة تلقائياً)
 *   4. المستخدم يختار → نُرسل إلى POST /api/download → نستقبل الملف
 *   5. نُرسل الملف إلى تيليغرام
 *
 * ── الـ Endpoints المستخدمة ──────────────────────────────────────
 *
 *   GET  /api/plugins   → قائمة المنصات المدعومة
 *   POST /api/probe     → { url } → { title, plugin, options[] }
 *   POST /api/download  → { url, key } → binary stream
 *
 * ── curl examples (بدون أي Authorization header) ────────────────
 *
 *   # قائمة الـ plugins:
 *   curl https://telegram-bhci.onrender.com/api/plugins
 *
 *   # فحص رابط:
 *   curl -X POST https://telegram-bhci.onrender.com/api/probe \
 *        -H "Content-Type: application/json" \
 *        -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'
 *
 *   # تحميل مباشر:
 *   curl -X POST https://telegram-bhci.onrender.com/api/download \
 *        -H "Content-Type: application/json" \
 *        -d '{"url":"https://youtu.be/dQw4w9WgXcQ","key":"v_720"}' \
 *        --output video.mp4
 */

// ══════════════════════════════════════════════════════════════════
// الإعدادات
// ══════════════════════════════════════════════════════════════════

const API_BASE = "https://telegram-bhci.onrender.com";

/**
 * الجودة الافتراضية إذا لم يحددها المستخدم.
 * القيم المتاحة تعتمد على المنصة — استخدم /api/probe للاطلاع عليها.
 * أمثلة شائعة: "v_720", "v_1080", "v_480", "a_128", "a_320"
 */
const DEFAULT_QUALITY = "v_720";

// ══════════════════════════════════════════════════════════════════
// دوال API المساعدة
// ══════════════════════════════════════════════════════════════════

/**
 * جلب قائمة الـ plugins المدعومة من السيرفر.
 *
 * @returns {Promise<Array<{name, domains, description, status}>>}
 *
 * @example
 *   const plugins = await fetchPlugins();
 *   console.log(plugins.map(p => p.name));
 *   // ["youtube", "tiktok", "instagram", "facebook", "soundcloud", ...]
 */
async function fetchPlugins() {
  const res = await fetch(`${API_BASE}/api/plugins`);
  if (!res.ok) throw new Error(`plugins endpoint returned ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "unknown error from /api/plugins");
  return data.plugins;
}

/**
 * فحص رابط وإرجاع الجودات المتاحة.
 *
 * @param {string} url  — رابط الوسائط (YouTube, TikTok, Instagram, ...)
 * @returns {Promise<{title, plugin, options: Array<{key,label,kind,sizeHint}>}>}
 *
 * @example
 *   const result = await probeUrl("https://youtu.be/dQw4w9WgXcQ");
 *   console.log(result.title);   // "Rick Astley - Never Gonna Give You Up"
 *   console.log(result.options); // [{key:"v_720",label:"🎥 720p",kind:"video",...}, ...]
 */
async function probeUrl(url) {
  const res = await fetch(`${API_BASE}/api/probe`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ url }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || `probe failed (${res.status})`);
  return data; // { title, plugin, options }
}

/**
 * تحميل ملف وسائط وإرجاعه كـ Buffer.
 *
 * @param {string} url    — نفس الرابط الذي تم probe له
 * @param {string} key    — مفتاح الجودة من نتيجة probe (مثل "v_720")
 * @returns {Promise<{buffer: Buffer, filename: string, contentType: string, title: string, mediaType: string}>}
 *
 * @example
 *   const dl = await downloadMedia(url, "v_720");
 *   await fs.writeFile(dl.filename, dl.buffer);
 */
async function downloadMedia(url, key) {
  const res = await fetch(`${API_BASE}/api/download`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ url, key }),
  });

  if (!res.ok) {
    // حاول قراءة رسالة الخطأ
    let errMsg = `download failed (${res.status})`;
    try {
      const errData = await res.json();
      if (errData.error) errMsg = errData.error;
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }

  // استخراج البيانات من الـ headers
  const contentType  = res.headers.get("Content-Type")  || "application/octet-stream";
  const disposition  = res.headers.get("Content-Disposition") || "";
  const mediaType    = res.headers.get("X-Media-Type")  || "video";
  const rawTitle     = res.headers.get("X-Media-Title") || "";
  const title        = rawTitle ? decodeURIComponent(rawTitle) : "media";

  // استخراج اسم الملف من Content-Disposition
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  const filename      = filenameMatch ? filenameMatch[1] : `${title}.mp4`;

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, filename, contentType, title, mediaType };
}

// ══════════════════════════════════════════════════════════════════
// منطق الأمر /autodl
// ══════════════════════════════════════════════════════════════════

/**
 * معالج الأمر /autodl — يُسجَّل في بوت تيليغرام.
 *
 * الاستخدام:
 *   /autodl <رابط>           ← يعرض أزرار الجودة للاختيار
 *   /autodl <رابط> <جودة>   ← يحمّل مباشرة (مثل: /autodl https://… v_720)
 *
 * @param {TelegramBot} bot   — كائن البوت (node-telegram-bot-api أو مشابه)
 * @param {object}      msg   — كائن الرسالة من تيليغرام
 * @param {string[]}    args  — الوسائط بعد /autodl
 *
 * @example
 *   bot.onText(/\/autodl (.+)/, async (msg, match) => {
 *     const args = match[1].trim().split(/\s+/);
 *     await handleAutodl(bot, msg, args);
 *   });
 */
async function handleAutodl(bot, msg, args) {
  const chatId = msg.chat.id;

  // ── التحقق من المدخلات ─────────────────────────────────────────
  if (!args.length || !args[0].startsWith("http")) {
    await bot.sendMessage(
      chatId,
      "❌ الاستخدام:\n" +
      "/autodl <رابط>\n" +
      "/autodl <رابط> <جودة>\n\n" +
      "مثال:\n" +
      "/autodl https://youtu.be/dQw4w9WgXcQ\n" +
      "/autodl https://youtu.be/dQw4w9WgXcQ v_720"
    );
    return;
  }

  const url            = args[0];
  const requestedKey   = args[1] || null; // اختياري

  // ── إرسال رسالة انتظار ────────────────────────────────────────
  const waitMsg = await bot.sendMessage(chatId, "🔍 جاري فحص الرابط…");

  // ── Probe ──────────────────────────────────────────────────────
  let probeResult;
  try {
    probeResult = await probeUrl(url);
  } catch (e) {
    await bot.editMessageText(
      `❌ فشل فحص الرابط:\n${e.message}`,
      { chat_id: chatId, message_id: waitMsg.message_id }
    );
    return;
  }

  const { title, plugin, options } = probeResult;
  await bot.editMessageText(
    `✅ *${escapeMarkdown(title)}*\nمنصة: ${plugin} • ${options.length} جودة متاحة`,
    { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: "MarkdownV2" }
  );

  // ── إذا طلب المستخدم جودة محددة أو استخدم الافتراضية ──────────
  const qualityKey = requestedKey
    || options.find(o => o.key === DEFAULT_QUALITY)?.key
    || options[0]?.key;

  if (requestedKey || true /* حمّل تلقائياً بالجودة الافتراضية */) {
    // إذا أردت عرض الأزرار بدلاً من التحميل التلقائي:
    // → استبدل هذا الـ block بـ sendQualityKeyboard()
    await downloadAndSend(bot, chatId, url, qualityKey, title);
  }
}

/**
 * يُنزّل الملف ويرسله إلى تيليغرام.
 *
 * @param {TelegramBot} bot
 * @param {number}      chatId
 * @param {string}      url
 * @param {string}      key       — مفتاح الجودة
 * @param {string}      title     — عنوان المقطع
 */
async function downloadAndSend(bot, chatId, url, key, title) {
  const dlMsg = await bot.sendMessage(chatId, `⏳ جاري تحميل «${title}» بجودة ${key}…`);

  let dl;
  try {
    dl = await downloadMedia(url, key);
  } catch (e) {
    await bot.editMessageText(
      `❌ فشل التحميل:\n${e.message}`,
      { chat_id: chatId, message_id: dlMsg.message_id }
    );
    return;
  }

  await bot.deleteMessage(chatId, dlMsg.message_id);

  // اختر طريقة الإرسال بناءً على نوع الوسائط
  const caption = `🎬 ${title}`;
  const fileOptions = { filename: dl.filename, contentType: dl.contentType };

  if (dl.mediaType === "audio") {
    await bot.sendAudio(chatId, dl.buffer, { caption }, fileOptions);
  } else if (dl.mediaType === "document") {
    await bot.sendDocument(chatId, dl.buffer, { caption }, fileOptions);
  } else {
    await bot.sendVideo(chatId, dl.buffer, { caption, supports_streaming: true }, fileOptions);
  }
}

/**
 * يعرض أزرار الجودة للمستخدم (بديل للتحميل التلقائي).
 *
 * @param {TelegramBot} bot
 * @param {number}      chatId
 * @param {string}      url
 * @param {object[]}    options  — قائمة الجودات من probe
 * @param {string}      title
 */
async function sendQualityKeyboard(bot, chatId, url, options, title) {
  // بناء أزرار inline — نُشفّر البيانات في callback_data
  const videoOptions = options.filter(o => o.kind === "video");
  const audioOptions = options.filter(o => o.kind === "audio");

  const rows = [];
  if (videoOptions.length) {
    rows.push(videoOptions.map(o => ({
      text:          o.label,
      callback_data: JSON.stringify({ action: "autodl", url, key: o.key }),
    })));
  }
  if (audioOptions.length) {
    rows.push(audioOptions.map(o => ({
      text:          o.label,
      callback_data: JSON.stringify({ action: "autodl", url, key: o.key }),
    })));
  }

  await bot.sendMessage(
    chatId,
    `🎬 *${escapeMarkdown(title)}*\nاختر الجودة:`,
    {
      parse_mode:   "MarkdownV2",
      reply_markup: { inline_keyboard: rows },
    }
  );
}

// ══════════════════════════════════════════════════════════════════
// معالج callback_query لأزرار الجودة
// ══════════════════════════════════════════════════════════════════

/**
 * يُسجَّل كمعالج لـ callback_query في البوت.
 *
 * @example
 *   bot.on("callback_query", (cq) => handleAutodlCallback(bot, cq));
 */
async function handleAutodlCallback(bot, cq) {
  let data;
  try { data = JSON.parse(cq.data); } catch { return; }
  if (data.action !== "autodl") return;

  await bot.answerCallbackQuery(cq.id, { text: "جاري التحميل…" });
  await downloadAndSend(bot, cq.message.chat.id, data.url, data.key, "");
}

// ══════════════════════════════════════════════════════════════════
// مثال توثيقي: استخدام fetchPlugins
// ══════════════════════════════════════════════════════════════════

/**
 * معالج /plugins — يعرض قائمة المنصات المدعومة في الوقت الحالي.
 *
 * @example
 *   bot.onText(/\/plugins/, (msg) => handlePluginsCommand(bot, msg));
 */
async function handlePluginsCommand(bot, msg) {
  const chatId = msg.chat.id;
  try {
    const plugins = await fetchPlugins();
    const loaded  = plugins.filter(p => p.status === "loaded");
    const lines   = loaded.map(p => `• *${p.name}*: ${p.domains.join(", ") || "—"}`);
    await bot.sendMessage(
      chatId,
      `🔌 *المنصات المدعومة (${loaded.length}):*\n\n${lines.join("\n")}`,
      { parse_mode: "MarkdownV2" }
    );
  } catch (e) {
    await bot.sendMessage(chatId, `❌ تعذّر جلب قائمة المنصات:\n${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// أدوات مساعدة
// ══════════════════════════════════════════════════════════════════

/** Escape MarkdownV2 special characters لتيليغرام */
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ══════════════════════════════════════════════════════════════════
// التصدير — اربطها ببوتك كما يلي:
// ══════════════════════════════════════════════════════════════════

export {
  // وظائف API الأساسية — يمكن استيرادها منفردةً
  fetchPlugins,
  probeUrl,
  downloadMedia,

  // معالجات الأوامر — جاهزة للتسجيل في البوت
  handleAutodl,
  handleAutodlCallback,
  handlePluginsCommand,
};

// نموذج تسجيل هذه الدوال مع بوت خارجي (مثل node-telegram-bot-api) موثّق في README.md.
