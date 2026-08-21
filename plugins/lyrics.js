// plugins/lyrics.js — Handler-plugin: أمر /lyrics (نصاً أو رداً على مقطع صوتي/فيديو)
// حذف هذا الملف يعطّل أمر /lyrics فوراً، بدون تعديل أي ملف آخر.
import { config } from "../config.js";
import { isCommand, commandName, commandArgs } from "../telegram-api.js";
import { getLogger } from "../lib/logger.js";
import { PluginError } from "../plugin-loader.js";

const logger = getLogger("plugin.lyrics");

export const DESCRIPTION = "عرض كلمات الأغاني عبر /lyrics (نصاً أو رداً على مقطع صوتي/فيديو)";

const LYRICS_API = config.LYRICS_API;
const TG_MSG_LIMIT = 4096;

function isLyricsCommand(msg) {
  return isCommand(msg) && commandName(msg) === "lyrics";
}

async function fetchLyrics(artist, title) {
  const res = await fetch(`${LYRICS_API}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 200) throw new PluginError("لم يُعثر على كلمات لهذه الأغنية");
  const data = await res.json();
  const lyrics = (data?.lyrics || "").trim();
  if (!lyrics) throw new PluginError("لم يُعثر على كلمات لهذه الأغنية");
  return lyrics;
}

function splitQuery(query) {
  if (query.includes(" - ")) {
    const [artist, ...rest] = query.split(" - ");
    return [artist.trim(), rest.join(" - ").trim()];
  }
  return ["", query.trim()];
}

export async function replyWithLyrics(bot, chatId, statusMessageId, artist, title) {
  let lyrics;
  try {
    lyrics = await fetchLyrics(artist || "", title);
  } catch (e) {
    await bot.editMessageText(chatId, statusMessageId,
      `🎵 *لم يُعثر على الكلمات*\n\n${e.message.slice(0, 200)}`,
      { parseMode: "Markdown" }
    );
    return;
  }

  const header = `🎵 *${title}*` + (artist ? `\n🎤 ${artist}` : "") + "\n\n──────────────\n\n";
  const full = header + lyrics;
  await bot.editMessageText(chatId, statusMessageId, full.slice(0, TG_MSG_LIMIT), { parseMode: "Markdown" });

  let rest = full.slice(TG_MSG_LIMIT);
  while (rest) {
    const chunk = rest.slice(0, TG_MSG_LIMIT);
    rest = rest.slice(TG_MSG_LIMIT);
    await bot.sendMessage(chatId, chunk);
  }
}

async function handleLyricsCommand(msg, bot) {
  const chatId = msg.chat.id;
  const query = commandArgs(msg);
  const reply = msg.reply_to_message;

  const status = await bot.sendMessage(chatId, "🎵 جاري البحث عن الكلمات…");

  if (reply && !query) {
    const shazam = await import("./shazam.js");
    let track;
    try {
      track = await shazam.identifyFromMessage(reply, bot);
    } catch (e) {
      await bot.editMessageText(chatId, status.message_id,
        `🔍 *تعذّر التعرف على المقطع*\n\n${e.message.slice(0, 200)}`,
        { parseMode: "Markdown" }
      );
      return;
    }
    await replyWithLyrics(bot, chatId, status.message_id, track.artist, track.title);
    return;
  }

  if (!query) {
    await bot.editMessageText(
      chatId, status.message_id,
      "📝 *استخدام /lyrics*\n\n• `/lyrics <اسم الأغنية>`\n• `/lyrics <الفنان> - <الأغنية>`\n• رد على مقطع صوتي/فيديو بـ /lyrics للتعرف التلقائي",
      { parseMode: "Markdown" }
    );
    return;
  }

  const [artist, title] = splitQuery(query);
  await replyWithLyrics(bot, chatId, status.message_id, artist, title);
}

export function registerPlugin() {
  return { filter: isLyricsCommand, callback: handleLyricsCommand };
}
