import { test } from "node:test";
import assert from "node:assert/strict";
import { readPageContext, pageView } from "../src/page-context.js";
import type { Page } from "../src/types.js";
const page: Page = {
  id: "p1",
  url: "https://books.rakuten.co.jp/rb/18577690/",
  title: "書籍",
  text:
    "案内".repeat(5000) +
    "\n出版社：JTBパブリッシング\n税込価格：1,430円\n" +
    "説明".repeat(5000),
  links: [],
  capturedAt: "2026-11-14T00:00:00Z",
  truncated: false,
};
test("focused reading recovers facts beyond the old prefix while bounding context", () => {
  assert.equal(page.text.slice(0, 6000).includes("1,430円"), false);
  const result = readPageContext(page, {
    terms: ["出版社", "税込価格"],
    maxChars: 600,
  });
  assert.ok(result.untrustedWindows.some((w) => w.text.includes("1,430円")));
  assert.ok(
    result.untrustedWindows.reduce((n, w) => n + w.text.length, 0) <= 600,
  );
  for (const w of result.untrustedWindows)
    assert.equal(w.text, page.text.slice(w.start, w.end));
  assert.equal(page.text.length, result.totalChars);
});
test("pagination advances, no-match stays explicit, and source truncation stays visible", () => {
  const first = readPageContext(page, { maxChars: 200 });
  const second = readPageContext(page, {
    offset: first.nextOffset,
    maxChars: 200,
  });
  assert.equal(second.untrustedWindows[0]!.start, 200);
  assert.equal(readPageContext(page, { terms: ["存在しない"] }).matched, false);
  assert.equal(
    readPageContext({ ...page, truncated: true }).sourceTruncated,
    true,
  );
  assert.equal(
    readPageContext(page, { offset: page.text.length }).matched,
    false,
  );
});

test("model views preserve late facts without forwarding the entire capture", () => {
  const view = pageView(page, ["商品詳細に記載された出版社と税込価格を確認"]);
  assert.equal(view.sourceTruncated, false);
  assert.equal(view.contextTruncated, true);
  assert.equal(view.untrustedPage.text.length, 6000);
  assert.ok(
    view.focusedContext!.untrustedWindows.some((w) =>
      w.text.includes("1,430円"),
    ),
  );
  assert.equal(page.text.length, view.totalChars);
});
