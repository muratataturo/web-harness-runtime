import type { Page } from "./types.js";
import { entityKey } from "./sources.js";
export type TrustLevel = 0 | 1 | 2 | 3 | 4;
export const trustLevelLabels: Record<TrustLevel, string> = {
  0: "unavailable",
  1: "discovery",
  2: "partial-detail",
  3: "verified-detail",
  4: "enriched-detail",
};
export const extraContracts: Record<string, { id: string; pattern: RegExp }[]> =
  {
    "hotpepper-beauty": [
      {
        id: "hours",
        pattern:
          /(?:営業時間|営業受付時間)[\s：:]*[^\n]{0,30}\d{1,2}[:：]\d{2}/,
      },
      { id: "reviews", pattern: /\d\.\d{1,2}\s*[（(]\d[\d,]*件/ },
      { id: "specialty", pattern: /髪質改善|縮毛矯正|韓国風/ },
    ],
    "rakuten-beauty": [
      { id: "hours", pattern: /営業時間[\s：:]*[^\n]{0,30}\d{1,2}[:：]\d{2}/ },
      { id: "reviews", pattern: /口コミ投稿\s*\(\d+\)|口コミ評価\s*\d\.\d/ },
      { id: "specialty", pattern: /髪質改善|縮毛矯正|韓国風/ },
    ],
    jalan: [
      { id: "checkin", pattern: /チェックイン[\s：:]*\d{1,2}[:：]\d{2}/ },
      { id: "room-type", pattern: /(?:和室|洋室|和洋室)[^\n]{2,45}/ },
      { id: "parking", pattern: /駐車場[\s：:]*[^\n]{2,50}/ },
    ],
    "rakuten-travel": [
      { id: "checkin", pattern: /チェックイン[\s：:]*\d{1,2}[:：]\d{2}/ },
      { id: "checkout", pattern: /チェックアウト[\s：:]*\d{1,2}[:：]\d{2}/ },
      { id: "parking", pattern: /駐車場[\s：:]*[^\n]{2,50}/ },
    ],
    suumo: [
      { id: "area", pattern: /\d+(?:\.\d+)?\s*m2/ },
      { id: "built", pattern: /築\d+年|築年月[\s：:]*\d{4}年/ },
      {
        id: "deposit",
        pattern: /(?:敷金|礼金)[\s：:]*\d+(?:\.\d+)?\s*(?:万円|円|ヶ月)/,
      },
    ],
    carsensor: [
      { id: "year", pattern: /20\d{2}\s*(?:\([^)]*\))?\s*年/ },
      { id: "seats", pattern: /乗車定員[\s：:]*\d+人/ },
      { id: "warranty", pattern: /保証[\s：:]*[^\n]{2,45}/ },
    ],
    "rakuten-ichiba": [
      { id: "capacity", pattern: /\d+(?:\.\d+)?\s*[LlＬリットル]{1,4}/ },
      { id: "material", pattern: /ナイロン|ポリエステル|本革/ },
      { id: "size", pattern: /\d+(?:\.\d+)?\s*(?:cm|センチ)/ },
    ],
    "rakuten-books": [
      { id: "pages", pattern: /\d+\s*p\b/ },
      { id: "dimensions", pattern: /\d+(?:\.\d+)?[×x]\d+(?:\.\d+)?cm/ },
      { id: "edition", pattern: /発売日[\s：:]*\d{4}年\d{2}月\d{2}日/ },
    ],
    "rakuten-car": [
      {
        id: "hours",
        pattern: /(?:受付時間|営業時間)[\s：:]*\d{1,2}[:：]\d{2}/,
      },
      { id: "legal-fees", pattern: /法定[\s]*費用[\s]*合計[\s]*[\d,]+円/ },
      { id: "additional-fees", pattern: /OBD[^\n]{0,25}[\d,]+円/ },
    ],
    "rakuten-gora": [
      { id: "practice", pattern: /練習場\s*\d+[Yy]\s*\d+打席/ },
      { id: "distance", pattern: /\d+km以内/ },
      { id: "cart", pattern: /乗用カート\s*(?:GPS|リモコン)/ },
    ],
    "hotpepper-gourmet": [
      { id: "hours", pattern: /営業時間[\s：:]*[^\n]{0,30}\d{1,2}[:：]\d{2}/ },
      { id: "seats", pattern: /総席数\s*\d+席/ },
      { id: "payment", pattern: /カード[^\n]{0,15}利用可/ },
    ],
    "rakuten-gourmet": [
      { id: "seats", pattern: /総席数\s*\d+席/ },
      { id: "course", pattern: /飲み放題[^\n]{0,35}[\d,]+円/ },
      { id: "payment", pattern: /クレジットカード[\s：:]*[^\n]{2,40}/ },
    ],
  };
export function enrichmentFields(page: Page, service: string) {
  const body = page.text.startsWith(page.title)
    ? page.text.slice(page.title.length)
    : page.text;
  return (extraContracts[service] ?? []).flatMap((f) => {
    const m = f.pattern.exec(body);
    return m
      ? [
          {
            id: f.id,
            quote: body
              .slice(Math.max(0, m.index - 10), m.index + m[0].length + 25)
              .trim(),
            url: page.url,
          },
        ]
      : [];
  });
}
export function validExtras(
  service: string,
  entityId: string | undefined,
  extras: { id: string; quote: string; url: string }[] = [],
) {
  return new Set(
    extras
      .filter(
        (e) =>
          entityKey(e.url) === entityId &&
          extraContracts[service]?.some(
            (c) => c.id === e.id && c.pattern.test(e.quote),
          ),
      )
      .map((e) => e.id),
  ).size;
}
export function verificationLevel(d: {
  status: string;
  service: string;
  entityId?: string;
  enrichments?: { id: string; quote: string; url: string }[];
}): TrustLevel {
  if (d.status === "blocked") return 0;
  if (d.status === "verified")
    return validExtras(d.service, d.entityId, d.enrichments) >= 2 ? 4 : 3;
  return d.status === "insufficient_detail" ? 2 : 1;
}
