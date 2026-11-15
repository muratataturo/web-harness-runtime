import type { Page } from "./types.js";

/** Bounded, verbatim windows. Offsets refer to stored text, never synthetic quotes. */
export function readPageContext(
  page: Page,
  options: { terms?: string[]; offset?: number; maxChars?: number } = {},
) {
  const budget = Math.min(6000, Math.max(200, options.maxChars ?? 4000));
  const offset = Math.min(page.text.length, Math.max(0, options.offset ?? 0));
  const terms = [...new Set(options.terms ?? [])]
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 24);
  const starts = terms.length
    ? terms.flatMap((term) => {
        const index = page.text
          .toLocaleLowerCase()
          .indexOf(term.toLocaleLowerCase(), offset);
        return index < 0 ? [] : [Math.max(offset, index - 120)];
      })
    : [offset];
  const unique = [...new Set(starts)].sort((a, b) => a - b);
  const windows: { start: number; end: number; text: string }[] = [];
  let remaining = budget;
  const size = Math.max(200, Math.floor(budget / Math.max(1, unique.length)));
  for (const start of unique) {
    if (remaining <= 0) break;
    const from = Math.max(start, windows.at(-1)?.end ?? offset);
    const end = Math.min(page.text.length, start + Math.min(size, remaining));
    if (end <= from) continue;
    windows.push({ start: from, end, text: page.text.slice(from, end) });
    remaining -= end - from;
  }
  return {
    pageId: page.id,
    url: page.url,
    capturedAt: page.capturedAt,
    totalChars: page.text.length,
    sourceTruncated: page.truncated,
    matched: windows.length > 0,
    untrustedWindows: windows,
    nextOffset: windows.at(-1)?.end ?? offset,
    instruction:
      "各windowは保存本文の連続部分です。別windowを連結して引用しないでください。語が見つからない場合はoffsetで読み進められます。",
  };
}

export function focusTerms(fields: string[]): string[] {
  return [
    ...new Set(
      fields.flatMap((field) => [
        ...(field.match(
          /税込|価格|料金|出版社|書名|著者|所在地|住所|アクセス|徒歩|予算|営業時間|管理費|家賃|送料|在庫|容量|温泉|露天風呂|間取り|修復歴|走行距離|年収|雇用形態|アイドル|韓国/g,
        ) ?? []),
        ...(field.match(/[A-Za-z0-9]+|[\p{Script=Han}]{2,}/gu) ?? []),
      ]),
    ),
  ].slice(0, 24);
}

/** Store complete captures, but bound the context sent to every engine. */
export function pageView(page: Page, fields: string[]) {
  return {
    untrustedPage: {
      ...page,
      text: page.text.slice(0, 6000),
      links: page.links.filter((l) => l.url.length <= 2048).slice(0, 48),
      truncated: page.truncated || page.text.length > 6000,
    },
    sourceTruncated: page.truncated,
    contextTruncated: page.text.length > 6000 || page.links.length > 48,
    totalChars: page.text.length,
    totalLinks: page.links.length,
    ...(page.text.length > 6000
      ? {
          focusedContext: readPageContext(page, {
            terms: focusTerms(fields),
            offset: 6000,
          }),
        }
      : {}),
    fullPageAvailableViaReadPage: page.id,
  };
}
