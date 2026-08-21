// telegram-api.js — عميل خفيف لـ Telegram Bot API عبر fetch
import { basename } from "node:path";
import { getLogger } from "./lib/logger.js";

const logger = getLogger("telegram_api");

export class TelegramError extends Error {}

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

export function sanitizeFilename(name, maxLen = 150) {
  if (!name) return "file";
  name = basename(name).replace(INVALID_FILENAME_CHARS, "_").trim().replace(/^\.+|\.+$/g, "");
  return (name || "file").slice(0, maxLen);
}

export class Bot {
  constructor(token) {
    this.token = token;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  async _call(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const payload = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    );
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new TelegramError(
        `[${method}] رد غير صالح من تيليجرام (HTTP ${res.status}): ${raw.slice(0, 200) || "(فارغ)"}`
      );
    }
    if (!res.ok || !data.ok) {
      throw new TelegramError(`[${method}] ${data.description || `HTTP ${res.status}: ${JSON.stringify(data)}`}`);
    }
    return data.result;
  }

  async sendMessage(chatId, text, { replyMarkup, parseMode } = {}) {
    return this._call("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup, parse_mode: parseMode });
  }

  async editMessageText(chatId, messageId, text, { replyMarkup, parseMode } = {}) {
    try {
      return await this._call("editMessageText", {
        chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup, parse_mode: parseMode,
      });
    } catch (e) {
      if (String(e.message).includes("not modified")) return null;
      throw e;
    }
  }

  async deleteMessage(chatId, messageId) {
    try {
      return await this._call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      logger.warning(`[delete_message] فشل حذف الرسالة ${messageId} في ${chatId}`);
      return null;
    }
  }

  async answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    try {
      return await this._call("answerCallbackQuery", {
        callback_query_id: callbackQueryId, text, show_alert: showAlert,
      });
    } catch {
      logger.warning("[answer_callback_query] فشل — على الأرجح انتهت صلاحية الاستعلام");
      return null;
    }
  }

  async sendPhoto(chatId, photo, caption, { parseMode } = {}) {
    return this._call("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: parseMode });
  }

  async _sendFile(method, field, chatId, filePath, { filename, caption, extraFields } = {}, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    for (const [k, v] of Object.entries(extraFields || {})) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    form.append(field, Bun.file(filePath), sanitizeFilename(filename || basename(filePath)));
    // رفع الملفات قد يستغرق وقتاً طويلاً — مهلة 10 دقائق
    let res, data;
    try {
      res = await fetch(`${this.apiBase}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(600_000) });
      data = await res.json();
    } catch (networkErr) {
      // انقطاع شبكي أثناء الرفع نفسه (وليس رد صريح من تيليجرام)
      if (attempt < MAX_ATTEMPTS) {
        logger.warning(`[${method}] خطأ شبكي أثناء الرفع (محاولة ${attempt}/${MAX_ATTEMPTS}): ${networkErr.message} — إعادة المحاولة`);
        await new Promise((r) => setTimeout(r, attempt * 4000));
        return this._sendFile(method, field, chatId, filePath, { filename, caption, extraFields }, attempt + 1);
      }
      throw new TelegramError(`[${method}] فشل الاتصال بعد ${MAX_ATTEMPTS} محاولات: ${networkErr.message}`);
    }

    if (!data.ok) {
      const desc = data.description || JSON.stringify(data);
      // أخطاء مؤقتة (بوابة/شبكة/تحميل زائد) تستحق إعادة المحاولة، على عكس أخطاء المحتوى (رابط فاسد، صلاحيات...)
      const retryable = /timeout|gateway|bad gateway|too many requests|502|503|504/i.test(desc);
      if (retryable && attempt < MAX_ATTEMPTS) {
        logger.warning(`[${method}] فشل مؤقت من تيليجرام (محاولة ${attempt}/${MAX_ATTEMPTS}): ${desc} — إعادة المحاولة`);
        await new Promise((r) => setTimeout(r, attempt * 4000));
        return this._sendFile(method, field, chatId, filePath, { filename, caption, extraFields }, attempt + 1);
      }
      throw new TelegramError(`[${method}] ${desc}`);
    }
    return data.result;
  }

  async sendDocument(chatId, filePath, { filename, caption } = {}) {
    return this._sendFile("sendDocument", "document", chatId, filePath, { filename, caption });
  }

  async sendAudio(chatId, filePath, { title, caption } = {}) {
    return this._sendFile("sendAudio", "audio", chatId, filePath, { caption, extraFields: { title } });
  }

  async sendVideo(chatId, filePath, { caption } = {}) {
    // supports_streaming يساعد Telegram على معالجة MP4 كفيديو قابل للتشغيل
    // فوراً، بعد أن يضمن مسار YouTube ترميز H.264/AAC وmoov atom في البداية.
    return this._sendFile("sendVideo", "video", chatId, filePath, {
      caption,
      extraFields: { supports_streaming: true },
    });
  }

  async sendCachedVideo(chatId, fileId, caption) {
    return this._call("sendVideo", { chat_id: chatId, video: fileId, caption });
  }

  async sendCachedAudio(chatId, fileId, caption, title) {
    return this._call("sendAudio", { chat_id: chatId, audio: fileId, caption, title });
  }

  async sendCachedDocument(chatId, fileId, caption) {
    return this._call("sendDocument", { chat_id: chatId, document: fileId, caption });
  }

  async downloadFile(fileId, destPath) {
    const info = await this._call("getFile", { file_id: fileId });
    const res = await fetch(`${this.fileBase}/${info.file_path}`);
    if (!res.ok) throw new TelegramError(`تعذّر تنزيل الملف: HTTP ${res.status}`);
    await Bun.write(destPath, res);
    return destPath;
  }

  async setWebhook(url, secretToken) {
    return this._call("setWebhook", {
      url,
      secret_token: secretToken || undefined,
      allowed_updates: ["message", "callback_query"],
    });
  }
}

// فلاتر رسائل تيليجرام
export function isCommand(msg) { return !!(msg.text || "").startsWith("/"); }
export function isPlainText(msg) { return "text" in msg && !isCommand(msg); }
export function isRecognizableMedia(msg) {
  return ["voice", "audio", "video", "video_note"].some((k) => k in msg);
}
export function commandName(msg) {
  return ((msg.text || "").split(/\s+/)[0] || "").slice(1).split("@")[0].toLowerCase();
}
export function commandArgs(msg) {
  const text = msg.text || "";
  const idx = text.indexOf(" ");
  return idx === -1 ? "" : text.slice(idx + 1).trim();
}
