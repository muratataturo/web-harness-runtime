import { entityKey } from "./sources.js";
import { assessPage } from "./page-quality.js";
import { verifyDetail } from "./detail-contracts.js";
import type { Page, Criterion } from "./types.js";
export function actionKey(mode: string, value: string): string {
  const u = new URL(value);
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^l-id$|^cstt$/.test(key)) u.searchParams.delete(key);
  return mode + ":" + u.href;
}
export interface DeepeningAction {
  url: string;
  mode: "link" | "render";
  reason: string;
}
/** Deterministic discovery from already fetched links; never invent URLs or cross entities. */
export function deepeningActions(
  page: Page,
  fields: string[],
  attempted: Set<string>,
): DeepeningAction[] {
  const key = entityKey(page.url);
  if (!key || key.startsWith("generic:") || assessPage(page).shouldStop)
    return [];
  const terms = fields.join(" "),
    check = verifyDetail(page);
  const rank = (value: string) => {
    let score = /詳細|基本情報|_std\.html/.test(value) ? 2 : 0;
    if (
      /price|価格|料金|予算|送料|費用/.test(terms) &&
      /料金|価格|送料|price|coupon/.test(value)
    )
      score += 10;
    if (
      /韓国|アイドル|style/.test(terms) &&
      /スタイル|style|スタッフ|staff/.test(value)
    )
      score += 10;
    if (
      /rooms|部屋|温泉|風呂/.test(terms) &&
      /部屋|温泉|風呂|bath|room|_std\.html/.test(value)
    )
      score += 10;
    if (/管理|家賃|費用/.test(terms) && /詳細|取扱|費用|設備/.test(value))
      score += 5;
    return score;
  };
  const links = page.links.filter(
    (l) =>
      entityKey(l.url) === key &&
      actionKey("link", l.url) !== actionKey("link", page.url) &&
      !attempted.has(actionKey("link", l.url)) &&
      !/ログイン|購入確定|申込確定|予約確定/.test(l.text),
  );
  const seen = new Set<string>();
  const unique = links.filter((l) => {
    const key = actionKey("link", l.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort(
    (a, b) => rank(b.text + " " + b.url) - rank(a.text + " " + a.url),
  );
  const actions: DeepeningAction[] = unique.map((l) => ({
    url: l.url,
    mode: "link",
    reason: `同一対象の詳細リンク: ${l.text}`,
  }));
  if (
    page.acquisition?.kind === "public-html" &&
    !attempted.has(actionKey("render", page.url)) &&
    (page.truncated ||
      check.missingFields.length ||
      /価格|price|送料|費用|管理費|家賃|車重/.test(terms))
  )
    actions.unshift({
      url: page.url,
      mode: "render",
      reason: "公開HTMLの不足項目をブラウザ描画で追加確認",
    });
  return actions;
}
export function pinRequiredCriteria(
  query: string,
  criteria: Criterion[],
): Criterion[] {
  const result = criteria.map((c) => ({ ...c }));
  if (/韓国.{0,10}アイドル|アイドル.{0,10}風/.test(query)) {
    const found = result.filter((c) => /アイドル/.test(c.description));
    if (found.length) for (const c of found) c.required = true;
    else
      result.push({
        id: "required-idol-style",
        description:
          "韓国アイドル風への対応根拠（一般的な韓国風だけで完全適合としない）",
        required: true,
        weight: 5,
      });
  }
  if (/SKU.{0,12}未確認でよい/.test(query))
    for (const c of result)
      if (/SKU/.test(c.description) && /確定/.test(c.description))
        c.required = false;
  return result;
}
