import { test } from "node:test";
import assert from "node:assert/strict";
import { productOffer } from "../src/product-offer.js";
import { extractPublicHtml } from "../src/html-reader.js";
import { verifyDetail } from "../src/detail-contracts.js";
import { verificationLevel } from "../src/trust-levels.js";
import { deepeningActions, pinRequiredCriteria } from "../src/research.js";
import { validateAnswer, setCriteria, addEvidence } from "../src/evidence.js";
import { newTask } from "../src/runtime.js";
const url = "https://item.rakuten.co.jp/shop/item/";
const html = (canonical = url, currency = "JPY") =>
  `<link rel="canonical" href="${canonical}"><title>リュック</title><body><div itemscope itemtype="https://schema.org/Product"><div itemprop="offers" itemscope itemtype="https://schema.org/AggregateOffer"><meta itemprop="lowPrice" content="6990"><meta itemprop="highPrice" content="7990"><meta itemprop="priceCurrency" content="${currency}"></div><p>商品詳細 サイズ40L 素材ナイロン 52cm ショップABC ${"商品情報です。".repeat(40)}</p><div>1000円クーポン 関連商品の価格2,790円</div></div></body>`;
test("own canonical Product microdata supplies a range without treating a coupon as the price", () => {
  assert.deepEqual(productOffer(html(), url), {
    url,
    currency: "JPY",
    low: 6990,
    high: 7990,
    source: "microdata",
    kind: "range",
  });
  const p = {
    ...extractPublicHtml(html(), url, ["item.rakuten.co.jp"]),
    id: "p1",
    capturedAt: new Date().toISOString(),
  };
  assert.match(p.text, /対象商品の販売価格帯: 6990〜7990円/);
  assert.equal(verifyDetail(p).status, "verified");
  assert.equal(verifyDetail(p).level, 4);
});
test("foreign entities, ambiguous Product scopes and currencies cannot supply a trusted price", () => {
  assert.equal(
    productOffer(html("https://item.rakuten.co.jp/shop/other/"), url),
    undefined,
  );
  assert.equal(productOffer(html(url, "USD"), url), undefined);
  assert.equal(
    productOffer(
      html().replace(
        "</body>",
        '<div itemscope itemtype="https://schema.org/Product"></div></body>',
      ),
      url,
    ),
    undefined,
  );
  assert.equal(
    productOffer(html().replace('content="7990"', 'content="1000"'), url),
    undefined,
  );
  assert.equal(
    productOffer(html().replace('content="6990"', 'content="NaN"'), url),
    undefined,
  );
});
test("trust levels do not promote partial, blocked, or forged cross-entity enrichment", () => {
  assert.equal(
    verificationLevel({ status: "blocked", service: "rakuten-ichiba" }),
    0,
  );
  assert.equal(
    verificationLevel({ status: "not_detail", service: "rakuten-ichiba" }),
    1,
  );
  assert.equal(
    verificationLevel({
      status: "insufficient_detail",
      service: "rakuten-ichiba",
    }),
    2,
  );
  assert.equal(
    verificationLevel({ status: "verified", service: "rakuten-ichiba" }),
    3,
  );
  assert.equal(
    verificationLevel({
      status: "verified",
      service: "rakuten-ichiba",
      entityId: "rakuten-ichiba:shop:item",
      enrichments: [
        {
          id: "material",
          quote: "ナイロン",
          url: "https://item.rakuten.co.jp/shop/other/",
        },
        { id: "capacity", quote: "40L", url },
      ],
    }),
    3,
  );
});
test("deepening stays on the same entity, prioritizes missing fields and does not retry blocked pages", () => {
  const p = {
    url: "https://beauty.hotpepper.jp/slnH000001/",
    id: "p1",
    title: "店舗",
    text: "詳細説明です。".repeat(50),
    links: [
      {
        url: "https://beauty.hotpepper.jp/slnH000001/style/",
        text: "ヘアスタイル",
      },
      { url: "https://beauty.hotpepper.jp/slnH000002/", text: "他の店" },
      { url: "https://beauty.hotpepper.jp/slnH000001/coupon/", text: "料金" },
    ],
    capturedAt: new Date().toISOString(),
    truncated: false,
  };
  assert.match(
    deepeningActions(p, ["韓国アイドル風"], new Set())[0]!.url,
    /style/,
  );
  assert.equal(deepeningActions(p, ["価格"], new Set()).length, 2);
  assert.equal(
    deepeningActions({ ...p, title: "Access Denied" }, ["価格"], new Set())
      .length,
    0,
  );
  assert.equal(
    deepeningActions(p, ["価格"], new Set(p.links.map((l) => "link:" + l.url)))
      .length,
    0,
  );
});
test("explicit idol intent remains mandatory across agent plans", () => {
  const a = pinRequiredCriteria("韓国アイドル風になれるサロン", [
    { id: "idol", description: "アイドル風", required: false, weight: 1 },
  ]);
  assert.equal(a[0]!.required, true);
  assert.equal(
    pinRequiredCriteria("韓国アイドル風", [
      { id: "near", description: "駅近", required: true, weight: 1 },
    ]).at(-1)!.id,
    "required-idol-style",
  );
});
test("management fee dash cannot silently become zero in a supported monthly budget claim", () => {
  const t = newTask({
    query: "家賃管理費合計",
    urls: ["https://suumo.jp/chintai/jnc_123/"],
    maxSteps: 10,
    maxPages: 3,
    timeoutSeconds: 5,
  });
  setCriteria(t, [
    {
      id: "cost",
      description: "家賃と管理費の合計月額15万円以下",
      required: true,
      weight: 1,
    },
  ]);
  t.pages.push({
    url: t.urls[0]!,
    id: "p1",
    title: "部屋",
    text: "13.5万円\n管理費・共益費: -\n間取り1LDK",
    links: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  });
  const ev = addEvidence(t, "p1", "13.5万円\n管理費・共益費: -");
  const a = validateAnswer(
    t,
    "費用を比較",
    [
      {
        name: "物件",
        url: t.urls[0]!,
        matches: [
          {
            criterionId: "cost",
            status: "supported",
            explanation: "13.5万円",
            evidenceIds: [ev.id],
          },
        ],
      },
    ],
    [],
  );
  assert.equal(a.candidates[0]!.eligible, false);
  assert.equal(a.candidates[0]!.matches[0]!.status, "unknown");
});

test("generic Korean-style text cannot satisfy an explicit idol criterion", () => {
  const t = newTask({
    query: "韓国アイドル風",
    urls: ["https://beauty.hotpepper.jp/slnH000001/"],
    maxSteps: 10,
    maxPages: 2,
    timeoutSeconds: 5,
  });
  setCriteria(
    t,
    pinRequiredCriteria(t.query, [
      { id: "idol", description: "アイドル風対応", required: false, weight: 5 },
    ]),
  );
  t.pages.push({
    url: t.urls[0]!,
    id: "p1",
    title: "サロン",
    text: "韓国風レイヤーをご提案します。",
    links: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  });
  const ev = addEvidence(t, "p1", "韓国風レイヤーをご提案します。");
  const a = validateAnswer(
    t,
    "比較",
    [
      {
        name: "サロン",
        url: t.urls[0]!,
        matches: [
          {
            criterionId: "idol",
            status: "supported",
            explanation: "韓国風対応",
            evidenceIds: [ev.id],
          },
        ],
      },
    ],
    [],
  );
  assert.equal(a.candidates[0]!.eligible, false);
  assert.equal(a.candidates[0]!.matches[0]!.status, "unknown");
});

test("explicitly permitted unknown SKU price is not promoted to a mandatory condition", () => {
  const c = pinRequiredCriteria(
    "価格帯を比較。選択SKU確定価格は未確認でよい。",
    [{ id: "sku", description: "SKUの確定価格", required: true, weight: 3 }],
  );
  assert.equal(c[0]!.required, false);
});

test("deepening does not spend its budget on same-page anchors or tracking variants", () => {
  const p = {
    id: "p1",
    url: "https://suumo.jp/chintai/jnc_123/",
    title: "物件",
    text: "掲載物件の情報です。".repeat(30),
    capturedAt: new Date().toISOString(),
    truncated: false,
    links: [
      { url: "https://suumo.jp/chintai/jnc_123/#photos", text: "写真" },
      {
        url: "https://suumo.jp/chintai/jnc_123/?utm_source=a",
        text: "元のページ",
      },
      { url: "https://suumo.jp/chintai/jnc_123/kankyo/", text: "周辺環境" },
      {
        url: "https://suumo.jp/chintai/jnc_123/kankyo/#map",
        text: "周辺環境地図",
      },
    ],
  };
  const a = deepeningActions(p, ["管理費"], new Set());
  assert.equal(a.length, 1);
  assert.match(a[0]!.url, /kankyo/);
});
