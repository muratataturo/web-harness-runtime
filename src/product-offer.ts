import * as cheerio from "cheerio";
import { entityKey } from "./sources.js";
export interface ProductOffer {
  url: string;
  currency: "JPY";
  low: number;
  high: number;
  source: "microdata";
  kind: "exact" | "range";
}
/** One canonical Product, one own Offer. Recommendations/coupons are not price sources. */
export function productOffer(
  html: string,
  url: string,
): ProductOffer | undefined {
  const $ = cheerio.load(html),
    products = $('[itemscope][itemtype$="/Product"]');
  const key = entityKey(url);
  if (!key || key.startsWith("generic:") || products.length !== 1) return;
  const canonical = $('link[rel="canonical"]').attr("href");
  if (!canonical) return;
  let target: string;
  try {
    target = new URL(canonical, url).href;
    if (
      entityKey(target) !== key ||
      new URL(target).hostname !== new URL(url).hostname
    )
      return;
  } catch {
    return;
  }
  const p = products.first(),
    offers = p
      .find('[itemprop="offers"][itemscope]')
      .filter((_, e) => $(e).closest('[itemtype$="/Product"]')[0] === p[0]);
  if (offers.length !== 1) return;
  const o = offers.first();
  const get = (prop: string) => {
    const nodes = o
      .find(`[itemprop="${prop}"]`)
      .filter((_, e) => $(e).closest('[itemprop="offers"]')[0] === o[0]);
    return nodes.length === 1
      ? (nodes.attr("content") ?? nodes.text()).trim()
      : undefined;
  };
  if (get("priceCurrency") !== "JPY") return;
  const number = (s?: string) =>
    s &&
    /^\d+(?:\.\d+)?$/.test(s) &&
    Number.isSafeInteger(Number(s)) &&
    Number(s) >= 0 &&
    Number(s) < 1e9
      ? Number(s)
      : undefined;
  const aggregate = (o.attr("itemtype") ?? "").endsWith("/AggregateOffer");
  const low = number(aggregate ? get("lowPrice") : get("price")),
    high = number(aggregate ? get("highPrice") : get("price"));
  if (low === undefined || high === undefined || low > high) return;
  return {
    url: target,
    currency: "JPY",
    low,
    high,
    source: "microdata",
    kind: low === high ? "exact" : "range",
  };
}
export function offerText(offer: ProductOffer): string {
  return `公開HTMLの構造化データ（Microdata・対象商品URL一致・選択SKU/送料/在庫未確認）\n対象商品の販売価格${offer.kind === "range" ? "帯" : ""}: ${offer.low}${offer.kind === "range" ? "〜" + offer.high : ""}円（JPY）`;
}
