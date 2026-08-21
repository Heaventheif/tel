import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const load = (name) => readFile(new URL(name, root), "utf8");

test("لوحة التحكم تحتوي اختبار probe/download ولا تتطلب مفتاح API", async () => {
  const html = await load("index.html");
  assert.match(html, /id="probeButton"/);
  assert.match(html, /id="downloadButton"/);
  assert.match(html, /fetch\('\/api\/probe'/);
  assert.match(html, /fetch\('\/api\/download'/);
  assert.doesNotMatch(html, /Authorization\s*:/);
  assert.doesNotMatch(html, /API_KEY/);
});

test("توثيق API يوضح التدفق الحديث ولا يطلب extra أو Authorization", async () => {
  const html = await load("docs.html");
  assert.match(html, /POST \/api\/probe/);
  assert.match(html, /POST \/api\/download/);
  assert.match(html, /لا تحتاج إلى مفتاح API أو ترويسة/);
  assert.match(html, /لا تمرر حقلاً باسم/);
  assert.doesNotMatch(html, /Bearer\s+YOUR_API_KEY/);
  assert.doesNotMatch(html, /401 Unauthorized/);
});

test("مثال العميل الخارجي يرسل url وkey فقط عند التنزيل", async () => {
  const client = await load("autodl.js");
  assert.match(client, /JSON\.stringify\(\{ url, key \}\)/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{ url, key, extra \}\)/);
  assert.doesNotMatch(client, /downloadMedia\(url, key, extra\)/);
});
