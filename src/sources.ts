import { isIP } from "node:net";
import type { Source } from "./types.js";
export interface Adapter {
  id: string;
  hosts: string[];
  keywords: RegExp;
  guidance: string;
}
export const adapters: Adapter[] = [
  {
    id: "hotpepper-beauty",
    hosts: ["beauty.hotpepper.jp"],
    keywords: /髪|美容|サロン|ヘア|韓国|アイドル|縮毛|salon|hair/i,
    guidance:
      "美容室の詳細 /sln/H.../、クーポン、スタイル、口コミを比較する。髪質改善と韓国風の根拠を別々に集める。駅徒歩分数はアクセス欄で確認。「有名」は宣伝文句だけで断定せず口コミ数・評価・実績と区別する。検索は /sln/keyword/ + encodeURIComponent(短い検索語) + / を使える。語を絞って探す。",
  },
  {
    id: "hotpepper-gourmet",
    hosts: ["www.hotpepper.jp", "hotpepper.jp"],
    keywords: /グルメ|飲食|居酒屋|レストラン|ランチ|ディナー|食事|restaurant/i,
    guidance:
      "料理、エリア、駅、予算、営業時間を /strJ.../ の店舗詳細で確認する。一覧・特集ページは発見に使い、そのものを店舗候補にしない。ランチとディナーの価格を混同しない。トップから地域リンク、または取得済みのランチ一覧へ進む。検索URLは https://www.hotpepper.jp/CSP/psh010/doBasic?FWT= + encodeURIComponent(短い検索語) を使用できる。空席は日付人数が未指定なら未確認とする。",
  },
  {
    id: "jalan",
    hosts: ["www.jalan.net", "jalan.net"],
    keywords: /旅行|宿|ホテル|旅館|温泉|泊|hotel/i,
    guidance:
      "宿の所在地、アクセス、食事、部屋、料金条件、日程を区別する。候補は /yad数字/ の宿詳細を開く。トップのエリア・温泉リンクから地域を絞り、検索結果の実在リンクを使う。日付未指定で最安価格・空室・2泊の総額を確約しない。施設の露天風呂と露天風呂付き客室を区別する。",
  },
  {
    id: "carsensor",
    hosts: ["www.carsensor.net", "carsensor.net"],
    keywords: /車|中古|走行|自動車|car/i,
    guidance:
      "車種、年式、走行距離、支払総額、修復歴、販売店、在庫を /usedcar/detail/ の車両詳細から確認する。一覧の車種ページを1台の候補にしない。本体価格でなく諸費用を含む支払総額を比較し、万円と円・万kmとkmを混同しない。検索は https://www.carsensor.net/usedcar/freeword/ + encodeURIComponent(車種など短い語) + /index.html を利用できる。サービス一部再開や情報更新遅れの告知があれば在庫・価格の制約として明記する。",
  },
  {
    id: "suumo",
    hosts: ["suumo.jp", "www.suumo.jp"],
    keywords: /賃貸|物件|住居|家賃|マンション|引越|部屋|住宅/i,
    guidance:
      "家賃と管理費、初期費用、駅徒歩、間取り、築年、募集条件を /chintai/bc_.../ など個別物件詳細で確認する。一覧を1部屋の候補にしない。月額上限は家賃と管理費・共益費の合算で判定し、別の駅への徒歩分数を対象駅の徒歩と取り違えない。検索URLの内部エリアIDは推測せず地域・駅の実在リンクを使う。空室や入居可否は確約しない。",
  },
  {
    id: "indeed",
    hosts: ["jp.indeed.com", "indeed.com", "www.indeed.com"],
    keywords: /求人|仕事|転職|就職|年収|リモート|job/i,
    guidance:
      "勤務地、職種、雇用形態、給与、要件、掲載日を /viewjob?jk=... の求人詳細で確認する。https://jp.indeed.com/jobs?q= + encodeURIComponent(職種) + &l= + encodeURIComponent(勤務地) で検索できる。年収下限と上限、年俸と月給、固定残業代の有無を区別する。給与レンジの上限だけで希望年収を満たすと判定しない。Request Blocked・CAPTCHAは回避しない。応募はしない。",
  },
];
export function publicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("公開 HTTPS URL のみ利用できます");
  if (
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error("ローカル・内部 URL は利用できません");
  return url;
}
export function routeSources(query: string, urls: string[]): Source[] {
  return [...new Set(urls)]
    .map((value, i) => {
      const url = publicUrl(value);
      const adapter = adapters.find((a) => a.hosts.includes(url.hostname));
      const relevant = adapter?.keywords.test(query) ?? false;
      return {
        id: `source-${i + 1}`,
        kind: adapter?.id ?? "generic",
        url: url.href,
        score: relevant ? 10 : adapter ? 1 : 0,
        reason: relevant
          ? "クエリの分野と URL の分野が一致"
          : adapter
            ? "別分野の候補。必要な場合だけ参照"
            : "汎用サイト。内容を読んで適合性を確認",
        guidance:
          adapter?.guidance ??
          "ページを読んで対象分野と検索方法を確認し、候補の詳細ページで条件を検証する。",
      };
    })
    .sort((a, b) => b.score - a.score);
}
export function allowedHosts(sources: Source[]): string[] {
  return [
    ...new Set(
      sources.flatMap((s) => {
        const host = new URL(s.url).hostname;
        return adapters.find((a) => a.id === s.kind)?.hosts ?? [host];
      }),
    ),
  ];
}
export function checkNavigation(value: string, hosts: string[]): string {
  const url = publicUrl(value);
  if (!hosts.includes(url.hostname))
    throw new Error(`許可対象外のドメインです: ${url.hostname}`);
  return url.href;
}

/** Stable entity identity for known providers; list pages intentionally return undefined. */
export function entityKey(value: string): string | undefined {
  const url = new URL(value);
  const adapter = adapters.find((a) => a.hosts.includes(url.hostname));
  if (!adapter) return `generic:${url.href}`;
  let id: string | undefined;
  if (adapter.id === "hotpepper-beauty")
    id = url.pathname.match(/^\/sln\/(H[0-9a-z]+)(?:\/|$)/i)?.[1];
  if (adapter.id === "hotpepper-gourmet")
    id = url.pathname.match(/^\/str(J[0-9]+)(?:\/|$)/i)?.[1];
  if (adapter.id === "jalan")
    id = url.pathname.match(/^\/yad([0-9]+)(?:\/|$)/)?.[1];
  if (adapter.id === "carsensor")
    id = url.pathname.match(/^\/usedcar\/detail\/([0-9a-z]+)(?:\/|$)/i)?.[1];
  if (adapter.id === "suumo")
    id = url.pathname.match(/^\/chintai\/((?:bc|jnc)_[0-9]+)(?:\/|$)/)?.[1];
  if (adapter.id === "indeed" && /^\/(?:viewjob|rc\/clk)$/.test(url.pathname))
    id = url.searchParams.get("jk") ?? undefined;
  return id ? `${adapter.id}:${id}` : undefined;
}
