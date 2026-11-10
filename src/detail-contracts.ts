import {
  enrichmentFields,
  verificationLevel,
  type TrustLevel,
} from "./trust-levels.js";
import { createHash } from "node:crypto";
import { entityKey, adapters } from "./sources.js";
import { assessPage } from "./page-quality.js";
import type { Page } from "./types.js";
export interface DetailField {
  id: string;
  pattern: RegExp;
}
const access = {
  id: "access",
  pattern:
    /(?:東京都|北海道|(?:京都|大阪)府|[^\s]{2,3}県)[^\n]{3,65}|[^\n]{2,35}駅[^\n]{0,25}(?:徒歩|バス|車)[^\n]{0,15}(?:分|km)/,
};
const price = {
  id: "price",
  pattern: /(?:[\d,]+\s*円|[¥￥]\s*[\d,]+|\d[\d,.]*\s*万円)/,
};
const salon = [
  access,
  price,
  { id: "menu", pattern: /メニュー|カット|トリートメント|施術/ },
];
const hotel = [
  access,
  { id: "facilities", pattern: /温泉|風呂|浴場|館内設備|設備・サービス/ },
  {
    id: "rooms",
    pattern:
      /(?:総部屋数|客室数)\s*[:：]?\s*[\d０-９]+|[\d０-９]+\s*室|(?:和室|洋室)[^\n]{2,60}/,
  },
];
export const detailContracts: Record<string, DetailField[]> = {
  "official-visit": [
    {
      id: "opening-conditions",
      pattern:
        /(?:開園時間|開館時間|営業時間|休館|休園)[\s\S]{0,90}(?:\d|午前|午後|無休|月曜|火曜)/,
    },
    {
      id: "admission",
      pattern: /(?:入園料|入館料|一般料金|大人|一般)[\s\S]{0,45}[0-9,]+\s*円/,
    },
  ],
  "official-dining": [
    access,
    price,
    { id: "menu", pattern: /メニュー|そば|うどん|天丼/ },
    { id: "hours", pattern: /営業時間[\s\S]{0,30}\d{1,2}[:：]/ },
  ],
  "hotpepper-beauty": salon,
  "rakuten-beauty": salon,
  "hotpepper-gourmet": [
    access,
    price,
    { id: "menu", pattern: /料理|ランチ|メニュー|コース/ },
  ],
  "rakuten-gourmet": [
    access,
    price,
    { id: "hours", pattern: /営業時間|定休日/ },
  ],
  jalan: hotel,
  "rakuten-travel": hotel,
  suumo: [
    access,
    { id: "rent", pattern: /賃料|家賃/ },
    { id: "fees", pattern: /管理費|共益費/ },
    { id: "layout", pattern: /間取り|[1-9][LDKRS]+/ },
  ],
  "rakuten-realestate": [
    access,
    { id: "rent", pattern: /賃料|家賃/ },
    { id: "layout", pattern: /間取り|[1-9][LDKRS]+/ },
  ],
  carsensor: [
    { id: "total_price", pattern: /支払総額|総額/ },
    { id: "mileage", pattern: /走行距離|[\d.]+\s*万?km/i },
    { id: "repair_history", pattern: /修復歴/ },
  ],
  indeed: [
    { id: "job", pattern: /仕事内容|職務内容|業務内容/ },
    { id: "salary", pattern: /給与|年収|月給|時給/ },
    { id: "location", pattern: /勤務地|勤務場所/ },
  ],
  "rakuten-car": [
    access,
    price,
    {
      id: "service",
      pattern: /車検基本料|車検費用|車検料金|法定費用|点検項目/,
    },
  ],
  "rakuten-gora": [
    access,
    {
      id: "course",
      pattern: /\d+\s*ホール|\d[\d,]*\s*ヤード|ホール数\s*[:：]?\s*\d+/,
    },
    {
      id: "facilities",
      pattern: /設備・サービス|練習場\s*[:：]?\s*(?:あり|なし|有|無|\d)/,
    },
  ],
  "rakuten-books": [
    price,
    { id: "publication", pattern: /著者|出版社|発売日|著・編/ },
    { id: "identifier", pattern: /ISBN|JAN|商品番号|コード/ },
  ],
  "rakuten-ichiba": [
    // A coupon or a related item's generic "価格" is not this product's selling price.
    {
      id: "price",
      pattern:
        /(?:^|\n)(?:対象商品の販売価格(?:帯)?|販売価格|商品価格)[ \t]*[：:]?[ \t]*(?:\n[ \t]*)?(?:[¥￥][ \t]*)?\d[\d,]*(?:[〜～]\d[\d,]*)?(?:[ \t]*円|(?=[ \t]*(?:\n|$)))/,
    },
    { id: "specification", pattern: /商品説明|商品詳細|仕様|サイズ|素材|容量/ },
    { id: "seller", pattern: /ショップ|店舗|会社概要|販売元|メーカー/ },
  ],
};
export interface DetailVerification {
  level?: TrustLevel;
  enrichments?: { id: string; quote: string; url: string }[];
  status:
    | "verified"
    | "blocked"
    | "not_detail"
    | "insufficient_detail"
    | "unsupported";
  url: string;
  service: string;
  entityId?: string;
  title: string;
  capturedAt: string;
  acquisition: Page["acquisition"];
  fields: { id: string; quote: string }[];
  missingFields: string[];
  bodySha256: string;
  reason: string;
  truncated: boolean;
}
/** Retrieval evidence, not an endorsement of page instructions, prices or business suitability. */
function verifyDetailBase(
  page: Page,
  expectedService?: string,
): DetailVerification {
  const service =
    adapters.find((a) => a.hosts.includes(new URL(page.url).hostname))?.id ??
    "generic";
  const entityId = entityKey(page.url),
    contract = detailContracts[service];
  const base: DetailVerification = {
    status: "unsupported",
    url: page.url,
    service,
    entityId,
    title: page.title,
    capturedAt: page.capturedAt,
    acquisition: page.acquisition,
    enrichments: enrichmentFields(page, service),
    fields: [],
    missingFields: [],
    bodySha256: createHash("sha256").update(page.text).digest("hex"),
    reason: "詳細取得の検証契約がありません",
    truncated: page.truncated,
  };
  const quality = assessPage(page);
  if (quality.shouldStop)
    return { ...base, status: "blocked", reason: quality.reason };
  if (!contract || (expectedService && service !== expectedService))
    return base;
  if (!entityId || entityId.startsWith("generic:"))
    return {
      ...base,
      status: "not_detail",
      reason: "一覧・トップ・未知の詳細形式は完了条件を満たしません",
    };
  const body = page.text.startsWith(page.title)
    ? page.text.slice(page.title.length)
    : page.text;
  for (const field of contract) {
    const match = field.pattern.exec(body);
    if (match)
      base.fields.push({
        id: field.id,
        quote: body
          .slice(
            Math.max(0, match.index - 12),
            match.index + Math.min(match[0].length, 45) + 35,
          )
          .trim(),
      });
    else base.missingFields.push(field.id);
  }
  if (
    !page.title.trim() ||
    body.trim().length < 200 ||
    base.missingFields.length ||
    (body.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, body.length) > 0.01
  )
    return {
      ...base,
      status: "insufficient_detail",
      reason: "詳細本文・文字品質・必須項目が不足しています",
    };
  return {
    ...base,
    status: "verified",
    reason: "個別対象の本文と領域別必須項目を取得しました",
  };
}

export function verifyDetail(
  page: Page,
  expectedService?: string,
): DetailVerification {
  const result = verifyDetailBase(page, expectedService);
  return { ...result, level: verificationLevel(result) };
}
