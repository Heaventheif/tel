# Media Bot API — Bun + Telegram

خدمة واحدة لتحميل الوسائط عبر **بوت تيليجرام** أو واجهة HTTP عامة. يشترك المساران في الإضافات نفسها، وفي حد تنزيل موحّد، وفي سياسات الملفات المؤقتة؛ لذلك لا يستطيع الضغط على واجهة API أن يحجب البوت أو يتجاوز سعة الاستضافة.

> **سياسة الوصول:** مسارات `/api/*` مفتوحة بلا مصادقة عمداً. الحماية مبنية على التحقق من JSON والرابط، وحجب العناوين الداخلية وعمليات إعادة التوجيه إليها، وحدود المعدل، وحدّ التزامن المشترك. لا تضف `API_KEY` أو `Authorization` إلى هذا المشروع.

## المسارات

| المسار | الطريقة | الغرض |
|---|---:|---|
| `/` | GET | لوحة تشغيل عربية، قائمة الإضافات، واختبار Probe/Download تفاعلي. |
| `/docs` | GET | مرجع التكامل والأمثلة. |
| `/health` | GET | فحص حياة خفيف للاستضافة والمراقبة. |
| `/api/health` | GET | حالة تشغيل تفصيلية: uptime والذاكرة والتحميلات النشطة والإصدار. |
| `/api/plugins` | GET | الإضافات المحمّلة وحالاتها وحالة دوائر مزوديها. |
| `/api/probe` | POST | فحص رابط وإرجاع خيارات الجودة. |
| `/api/download` | POST | تنزيل اختيار محدد وبثه كملف ثنائي. |
| `/api/keep-alive` | GET | حالة فحص المزودات الخارجية. |
| `/webhook` | POST | Webhook بوت تيليجرام. |

## التكامل مع API

أرسل JSON إلى `/api/probe` ثم استخدم قيمة `key` التي يرد بها الخادم في `/api/download`.

```bash
curl -sS -X POST "$BASE_URL/api/probe" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'

curl -L -X POST "$BASE_URL/api/download" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","key":"v_720"}' \
  --output media.mp4
```

لا يرد الحقل `extra` للعميل، ولا يحتاج العميل لإرساله. يعيد الخادم تنفيذ الفحص عند التنزيل كي يستخدم بيانات المزود الطازجة والموثوقة فقط.

## الإضافات ودعم المواقع

تُكتشف الملفات في `plugins/*.js` تلقائياً عند الإقلاع. لكل إضافة روابط يمكنها فحصها وتنزيلها، بينما `plugins/generic.js` هو المسار الاحتياطي للآتي:

| المصدر | آلية الدعم |
|---|---|
| روابط وسائط مباشرة | MP4 وWebM وMOV وMKV وملفات الصوت الشائعة. |
| HLS | روابط M3U8 بحد حجم ووقت واضحين وملف مؤقت في `/tmp`. |
| صفحات الفيديو العامة | OpenGraph وJSON-LD ووسوم `<video>/<source>` وiFrame بعمق واحد. |
| Twitter / X | مزود خارجي احتياطي، مع إعادة محاولة منظمة. |

لا تعني الإضافة العامة تجاوز حماية المنصات أو المحتوى المحمي؛ يدعم المشروع فقط الروابط المتاحة علناً والتي تسمح بها المصادر ومزوداتها.

## الإعداد والتشغيل محلياً

يتطلب المشروع Bun 1.1 أو أحدث و`ffmpeg`/`ffprobe` لتقسيم الملفات وقصها وتحويلها.

```bash
bun install
cp .env.example .env
# عدّل TELEGRAM_TOKEN وSERVER_URL وبقية الإعدادات اللازمة
bun run main.js
```

يجب أن يطابق `SERVER_URL` العنوان العام النهائي بلا شرطة مائلة في نهايته. ولحماية مصدر تحديثات تيليجرام، اضبط `TELEGRAM_WEBHOOK_SECRET` بقيمة عشوائية؛ لا يؤثر ذلك على الـ API العامة.

## النشر على Render

استخدم خدمة Web Service مع **Native Environment**. اجعل Build Command يثبت Bun والاعتمادات (وفق بيئتك)، واجعل Start Command:

```bash
bun run main.js
```

استخدم `/tmp` في `TEMP_DIR` لأن ملفات الوسائط مؤقتة. لا تفترض بقاء ملفات Render المحلية أو قاعدة SQLite بعد إعادة البناء أو التوسع إلى أكثر من نسخة. عند الحاجة إلى كاش مشترك أو أكثر من نسخة، اضبط `REDIS_URL`.

> تتطلب أدوات القص والتحويل وجود `ffmpeg` و`ffprobe`. إن لم تكن متاحة في صورة الاستضافة، عطّل هذه المزايا أو وفّر بيئة تشغيل تحتوي عليهما قبل النشر.

## حدود API المفتوحة

تتحكم المتغيرات التالية في الاستقرار دون فرض حسابات أو مفاتيح على المستخدمين:

| المتغير | القيمة الافتراضية | الأثر |
|---|---:|---|
| `MAX_CONCURRENT_DOWNLOADS` | 2 | السعة المشتركة بين البوت وAPI. |
| `API_RATE_LIMIT_PROBE` | 20 | أقصى فحوصات لكل عميل في النافذة. |
| `API_RATE_LIMIT_DOWNLOAD` | 5 | أقصى تنزيلات لكل عميل في النافذة. |
| `API_RATE_LIMIT_WINDOW_MS` | 60000 | مدة النافذة بالمللي ثانية. |
| `API_BODY_LIMIT_BYTES` | 16384 | الحد الأقصى لجسم JSON. |
| `API_CORS_ORIGINS` | `*` | أصول المتصفح المسموح بها. |
| `YOUTUBE_PROVIDER_ORDER` | `youtubei,ccproject,yt2,vreden` | ترتيب مزودي YouTube بلا تعديل كود؛ يبقى vreden احتياطياً أخيراً. |
| `LOG_FORMAT` | `text` | استخدم `json` لسجلات Render القابلة للتحليل. |

عند استلام `429`، يجب أن يحترم العميل الترويسة `Retry-After`. وتُعرّف كل القيم في `.env.example`.

## الاختبارات

```bash
npm test
npm run check
```

تشمل الاختبارات: الوصول العام، CORS، `/api/health`، حالة المزودات، التحقق من JSON والروابط الداخلية، حلقات وإعادات توجيه SSRF، حد ثماني إعادات، حدود معدل ومدخلات الذاكرة، تمرير بيانات المزود من الخادم فقط، تنظيف الملف بعد البث، والتحقق من توافق اللوحة والتوثيق مع API بلا مصادقة.

## عميل خارجي جاهز (`autodl.js`)

يوفّر `autodl.js` قالباً مستقلاً (`fetchPlugins`, `probeUrl`, `downloadMedia`, `handleAutodl`, `handleAutodlCallback`, `handlePluginsCommand`) لأي بوت تيليجرام خارجي يريد استهلاك واجهة `/api/*` هذه دون مصادقة. لتسجيله مع `node-telegram-bot-api` مثلاً:

```js
import TelegramBot from "node-telegram-bot-api";
import { handleAutodl, handleAutodlCallback, handlePluginsCommand } from "./autodl.js";

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.onText(/\/autodl(?:\s+(.+))?/, async (msg, match) => {
  const args = (match[1] || "").trim().split(/\s+/).filter(Boolean);
  await handleAutodl(bot, msg, args);
});

bot.onText(/\/plugins/, async (msg) => await handlePluginsCommand(bot, msg));
bot.on("callback_query", async (cq) => await handleAutodlCallback(bot, cq));
```

## سجل التحديثات

### النسخة 2.0.0 — تحسينات الاستقرار والمراقبة

نُفّذت حزمة تحسينات على النسخة الأساسية مع الحفاظ على Bun وESM بلا Python أو Docker أو `yt-dlp` محلي:

| التحسين | التفاصيل |
|---|---|
| مزوّد YouTube | أُضيف `youtubei.js` كمزوّد أول (مكتبة JS حديثة فوق `fetch`)؛ صار `@vreden/youtube_scraper` احتياطاً أخيراً. يُضبط الترتيب عبر `YOUTUBE_PROVIDER_ORDER` بلا تعديل كود. |
| إعادة المحاولة | `withRetry(fn, { attempts, delayMs })` في `plugin-loader.js` — محاولتان افتراضياً بتأخير 1.5 ثانية يتزايد أسياً. |
| قاطع الدائرة | لكل مزود: 3 إخفاقات خلال 5 دقائق توقفه 30 دقيقة؛ الحالة تظهر عبر `providerStatus` في `/api/plugins`. |
| أخطاء موحّدة | `PluginError` معتمد في كل ملفات `plugins/`، ويحمل المزود و`retryable` و`code`. |
| سجلات منظمة | `lib/logger.js` يدعم metadata، وتُنتج JSON عند `LOG_FORMAT=json` أو نصاً مقروءاً افتراضياً. |
| فصل Twitter/X | انتقل من `generic.js` إلى `plugins/twitter.js` بنطاقات `twitter.com`/`x.com`/`t.co` وأولوية 20. |
| رسائل تيليجرام | توضّح المنصة وتفرّق بين المحتوى الخاص/المحمي والمشكلة المؤقتة، ولا تقترح إعادة المحاولة إلا عند ملاءمتها. |
| اختبارات HTTP | تغطية موسّعة لـ `lib/http.js`: `file://`، الروابط الطويلة، حلقات وredirects داخلية، تجاوز 8 إعادات توجيه، تنظيف، وحدود معدل. |
| مراقبة | `GET /api/health` عام يعيد `ok` وuptime وعدد الإضافات والتحميلات النشطة وRSS والإصدار. |

> لا يتغير شكل طلبات أو استجابات `/api/probe` و`/api/download`. الحقل `providerStatus` إضافة توافقية إلى `/api/plugins` فقط.

**نتائج التحقق:** 19 اختباراً ناجحاً بلا فشل، بناء ناجح للمدخل الرئيسي و13 إضافة، وفحص ESM سليم لكل الملفات المعدَّلة.

### إصلاحات لاحقة

- إصلاح تعريف مزدوج للمتغير `urlHash` في `main.js` (كان يُعاد إعلانه بـ `const` مرتين في نفس الدالة، مما يسبب فشل الإقلاع فوراً على Bun/Render). أُزيل التعريف المكرر واستُخدم المتغير الأصلي مباشرة.
- إصلاح تحديد معدل (rate limit) كان يشارك نفس المؤقّت الزمني بين رسائل المستخدم (إرسال رابط) وأزرار callback (اختيار الجودة/التنزيل). كانت النتيجة أن الضغط على زر الجودة مباشرة بعد إرسال الرابط يُرفض برسالة "⏳ انتظر لحظة قبل المحاولة مرة أخرى" لأن كلا الحدثين يستهلكان نفس نافذة `RATE_LIMIT_SECONDS`، فيضطر المستخدم للضغط مرتين. صار لكل من الرسائل وأزرار callback مؤقّت خاص به.
