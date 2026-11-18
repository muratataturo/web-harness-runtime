import { test } from "node:test";
import assert from "node:assert/strict";
import { entityKey, routeSources, allowedHosts } from "../src/sources.js";
import { verifyDetail } from "../src/detail-contracts.js";
import {
  createResearchProfile,
  checkResearchNavigation,
} from "../src/runtime-profile.js";
import { prefersPublicHtml } from "../src/html-reader.js";
import type { Page } from "../src/types.js";
const museum = "https://www.gakkihaku.jp/guide/";
const cafe = "https://www.act-okura.co.jp/restaurant/cafe/";
const science =
  "https://www.ncsm.city.nagoya.jp/visit/visitors_guide/admission.html";
const nagoyaCafe = "https://www.nomura-medias.co.jp/shop_list/1083/";
function page(url: string, text: string): Page {
  return {
    id: "p",
    url,
    title: "公式の個別施設案内",
    text: text + "\n公開案内。".repeat(50),
    links: [],
    truncated: false,
    capturedAt: "2026-11-17T00:00:00Z",
    acquisition: { kind: "public-html", status: 200 },
  };
}
test("regional venue identity joins only the registered venue and keeps unrelated corporate outlets separate", () => {
  assert.equal(entityKey(museum), entityKey("https://www.gakkihaku.jp/about/"));
  assert.equal(
    entityKey(science),
    entityKey(
      "https://www.ncsm.city.nagoya.jp/visit/visitors_guide/facilities.html",
    ),
  );
  assert.notEqual(entityKey(museum), entityKey(science));
  assert.equal(
    entityKey(cafe),
    entityKey("https://www.act-okura.co.jp/restaurant-plan/cafemenu202303/"),
  );
  assert.equal(
    entityKey("https://www.act-okura.co.jp/restaurant/figaro/"),
    undefined,
  );
  assert.equal(
    entityKey("https://www.act-okura.co.jp/restaurant-plan/"),
    undefined,
  );
  assert.equal(
    entityKey(nagoyaCafe),
    entityKey(
      "https://www.nomura-medias.co.jp/wordpress/wp-content/uploads/2026/09/774.pdf",
    ),
  );
  assert.equal(
    entityKey("https://www.nomura-medias.co.jp/shop_list/9999/"),
    undefined,
  );
  assert.equal(
    entityKey(
      "https://www.nomura-medias.co.jp/wordpress/wp-content/uploads/2026/09/999.pdf",
    ),
    undefined,
  );
  assert.notEqual(
    entityKey(nagoyaCafe),
    entityKey(science),
    "cafe operator and the museum are distinct comparison targets",
  );
});
test("regional routing retains explicit host boundaries and supports public HTML in both regions", () => {
  const urls = [museum, cafe, science, nagoyaCafe];
  const sources = routeSources("浜松と名古屋でカフェと博物館の一日旅行", urls);
  const hosts = allowedHosts(sources);
  const profile = createResearchProfile(urls, undefined, "一日カフェ旅行");
  for (const url of urls) {
    assert.ok(prefersPublicHtml(url));
    assert.equal(checkResearchNavigation(url, hosts), url);
    assert.ok(profile.hosts.includes(new URL(url).hostname));
  }
  assert.throws(() =>
    checkResearchNavigation(
      "https://www.act-okura.co.jp.evil.example/restaurant/cafe/",
      hosts,
    ),
  );
  assert.throws(() =>
    checkResearchNavigation("https://www.nomura-medias.co.jp/contact/", hosts),
  );
});
test("regional public details verify admission tables, cafe information and free outdoor conditions without conflating a paid hall", () => {
  const visit = verifyDetail(
    page(
      museum,
      "ご利用案内 観覧料 大人 高校生 中学生以下 高齢者70歳以上\n個人800円 400円 無料\n開館時間9:30〜17:00\n静岡県浜松市中央区中央3-9-1",
    ),
  );
  assert.equal(visit.status, "verified");
  const food = verifyDetail(
    page(
      cafe,
      "静岡県浜松市中央区板屋町111-2\nザ・シーズンカフェ\n営業時間 土日祝11：00〜17：00\nメニュー コーヒー850円",
    ),
  );
  assert.equal(food.status, "verified");
  const rest = verifyDetail(
    page(
      "https://www.actcity.jp/faq/",
      "屋外広場は無料でご利用いただけます。（6:00～19:00）\n人数が多い場合には申請が必要です。",
    ),
  );
  assert.equal(rest.status, "verified");
  const hall = verifyDetail(
    page(
      "https://www.actcity.jp/facility/hall/",
      "大ホールの利用料金 開館時間9:00〜21:00。屋外とは別の有料施設。",
    ),
  );
  assert.notEqual(hall.status, "verified");
  const missing = verifyDetail(
    page(science, "開館時間9:30〜17:00。観覧料は未掲載。"),
  );
  assert.equal(missing.status, "insufficient_detail");
});

test("season cafe and cocktail lounge share the named business, while the observatory uses a distinct visit contract", () => {
  const lounge = "https://www.act-okura.co.jp/restaurant/lounge/";
  const menu = "https://www.act-okura.co.jp/restaurant-plan/cafe_cocktailtime/";
  assert.equal(entityKey(lounge), entityKey(cafe));
  assert.equal(entityKey(menu), entityKey(lounge));
  const gallery = "https://www.act-okura.co.jp/facilities/gallery/";
  assert.notEqual(entityKey(gallery), entityKey(cafe));
  const result = verifyDetail(
    page(
      gallery,
      "営業時間 11:00〜18:00。料金 大人1200円。住所 静岡県浜松市中央区板屋町111-2。",
    ),
  );
  assert.equal(result.service, "official-visit");
});
