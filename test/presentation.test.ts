import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdown,
  presentation,
  normalizeMarkdown,
} from "../web/presentation.js";
import { extractPublicHtml } from "../src/html-reader.js";
import { fetchPreviewImage } from "../src/visual-preview.js";
test("Markdown note renders headings, lists, tables and citations but never source HTML or unsafe URLs", () => {
  const html = markdown(
    "## 行程\n\n**休憩**を大切に\n\n- 子どもと動物園\n- 昼食\n\n| 項目 | 料金 |\n| --- | --- |\n| 昼食 | 未確認 |\n\n> 営業時間は未確認\n\n[出典](https://example.com/page)\n\n<script>alert(1)</script> [危険](javascript:alert) ![画像](https://example.com/photo.jpg)\n\n```html\n<img onerror=alert(1)>\n```",
  );
  assert.match(html, /<h3>行程<\/h3>/);
  assert.match(html, /<strong>休憩<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>営業時間は未確認/);
  assert.match(html, /href="https:\/\/example.com\/page"/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
});
test("visual answer derives its itinerary from original lines and retains conditional and unconfirmed text", () => {
  const summary =
    "【推奨：公園と昼食】\n大人2名の行程案\n9:30 公園へ。雨なら中止。\n12:00 昼食。席は未確認。\n\n【予算】\n合計は暫定。";
  const result = presentation({ task: { answer: { summary } } });
  assert.equal(result.title, "推奨：公園と昼食");
  assert.deepEqual(result.timeline, [
    { time: "9:30", text: "公園へ。雨なら中止。" },
    { time: "12:00", text: "昼食。席は未確認。" },
  ]);
  assert.equal(result.sections[1].title, "予算");
  assert.equal(result.raw, normalizeMarkdown(summary));
});
test("page image extraction keeps genuine image metadata, deduplicates transformed copies and excludes decorative assets", () => {
  const p = extractPublicHtml(
    `<title>温泉の宿</title><meta property="og:image" content="https://images.example.com/hotel.jpg?w=600"><main><img src="https://images.example.com/hotel.jpg?w=900"><img src="/SYS/heading.gif"><img src="/logo.png"><img src="/view.jpg" alt="客室"><img src="http://127.0.0.1/x.png"><img src="https://user:pass@example.com/photo.jpg"></main>`,
    "https://www.jalan.net/yad330299/",
    ["www.jalan.net"],
  );
  assert.deepEqual(
    p.images?.map((i) => i.url),
    [
      "https://images.example.com/hotel.jpg?w=600",
      "https://www.jalan.net/view.jpg",
    ],
  );
});
test("image proxy checks every redirect, bounds bytes, and rejects HTML or SVG disguised as a photo", async () => {
  const resolver = async (host: string) => [
    { address: host === "private.example" ? "127.0.0.1" : "93.184.216.34" },
  ];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const valid = await fetchPreviewImage(
    "https://images.example/photo.png",
    AbortSignal.timeout(1000),
    async () => new Response(png, { headers: { "content-type": "image/png" } }),
    resolver,
  );
  assert.equal(valid.type, "image/png");
  await assert.rejects(
    fetchPreviewImage(
      "https://images.example/photo.png",
      AbortSignal.timeout(1000),
      async () =>
        new Response("<script>bad</script>", {
          headers: { "content-type": "image/png" },
        }),
      resolver,
    ),
    /画像形式/,
  );
  await assert.rejects(
    fetchPreviewImage(
      "https://images.example/photo.svg",
      AbortSignal.timeout(1000),
      async () =>
        new Response("<svg/>", {
          headers: { "content-type": "image/svg+xml" },
        }),
      resolver,
    ),
    /公開画像/,
  );
  let calls = 0;
  await assert.rejects(
    fetchPreviewImage(
      "https://images.example/photo.png",
      AbortSignal.timeout(1000),
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example/secret" },
        });
      },
      resolver,
    ),
    /公開 IP/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchPreviewImage(
      "https://images.example/photo.png",
      AbortSignal.timeout(1000),
      async () =>
        new Response(png, {
          headers: {
            "content-type": "image/png",
            "content-length": String(5 * 1024 * 1024),
          },
        }),
      resolver,
    ),
    /サイズ上限/,
  );
});
