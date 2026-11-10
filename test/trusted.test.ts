import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDetail, detailContracts } from "../src/detail-contracts.js";
import { entityKey } from "../src/sources.js";
import { extractPublicHtml } from "../src/html-reader.js";
import {
  emptyRegistry,
  reconcileAudit,
  activeTrustedUrls,
  auditComplete,
  TrustedStore,
  type SourceAudit,
} from "../src/trusted.js";
import type { Page } from "../src/types.js";
const page = (id = "s6000060698"): Page => ({
  id: "p1",
  url: `https://beauty.rakuten.co.jp/${id}/`,
  title: "渋谷の美容室",
  text:
    "渋谷の美容室\n住所 東京都渋谷区。渋谷駅から徒歩3分。カット 5000円 トリートメントメニュー。" +
    "施術について説明します。".repeat(25),
  links: [],
  capturedAt: new Date().toISOString(),
  truncated: false,
  acquisition: { kind: "public-html", status: 200, charset: "utf-8" },
});
function audit(sourceId = "sample"): SourceAudit {
  const now = Date.now();
  return {
    sourceId,
    service: "rakuten-beauty",
    seedUrl: "https://beauty.rakuten.co.jp/addr13113/",
    status: "verified",
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
    minDetails: 2,
    details: [verifyDetail(page()), verifyDetail(page("s2000048982"))],
    pages: [],
  };
}
test("detail completion requires an individual URL, body and every domain field", () => {
  const p = page();
  const d = verifyDetail(p);
  assert.equal(d.status, "verified");
  assert.deepEqual(
    d.fields.map((f) => f.id),
    detailContracts["rakuten-beauty"]!.map((f) => f.id),
  );
  for (const f of d.fields) assert.ok(p.text.includes(f.quote));
  assert.equal(
    verifyDetail({ ...p, url: "https://beauty.rakuten.co.jp/addr13113/" })
      .status,
    "not_detail",
  );
  assert.equal(
    verifyDetail({ ...p, text: p.text.replace("5000円", "金額未記載") }).status,
    "insufficient_detail",
  );
  assert.equal(verifyDetail({ ...p, text: p.title }).status, "blocked");
  assert.equal(
    verifyDetail({ ...p, text: p.text + "�".repeat(100) }).status,
    "insufficient_detail",
  );
  assert.equal(
    verifyDetail({ ...p, title: "Access Denied" }).status,
    "blocked",
  );
  assert.equal(
    verifyDetail({ ...p, acquisition: { kind: "public-html", status: 403 } })
      .status,
    "blocked",
  );
  assert.equal(verifyDetail(p, "jalan").status, "unsupported");
});
test("actual Beauty and Rakuten entity forms exclude lists and keep child pages together", () => {
  assert.equal(
    entityKey("https://beauty.hotpepper.jp/slnH000639463/"),
    entityKey("https://beauty.hotpepper.jp/slnH000639463/coupon/"),
  );
  for (const [detail, child, list] of [
    [
      "https://beauty.rakuten.co.jp/s6000060698/",
      "https://beauty.rakuten.co.jp/s6000060698/tk1/",
      "https://beauty.rakuten.co.jp/addr13113/",
    ],
    [
      "https://travel.rakuten.co.jp/HOTEL/84721/84721.html",
      "https://travel.rakuten.co.jp/HOTEL/84721/review.html",
      "https://travel.rakuten.co.jp/yado/kanagawa/hakone.html",
    ],
    [
      "https://r.gnavi.co.jp/g888000/",
      "https://r.gnavi.co.jp/g888000/menu1/",
      "https://r.gnavi.co.jp/area/aream2126/",
    ],
    [
      "https://booking.gora.golf.rakuten.co.jp/guide/disp/c_id/120045/",
      "https://booking.gora.golf.rakuten.co.jp/guide/disp/c_id/120045/?a=b",
      "https://gora.golf.rakuten.co.jp/doc/area/chiba/",
    ],
    [
      "https://books.rakuten.co.jp/rb/18577690/",
      "https://books.rakuten.co.jp/rb/18577690/?a=b",
      "https://books.rakuten.co.jp/search?sitem=a",
    ],
    [
      "https://item.rakuten.co.jp/samfolk/sa80ss/",
      "https://item.rakuten.co.jp/samfolk/sa80ss/?a=b",
      "https://search.rakuten.co.jp/search/mall/a/",
    ],
    [
      "https://car.rakuten.co.jp/shaken/shop/12416/",
      "https://car.rakuten.co.jp/shaken/shop/12416/?a=b",
      "https://car.rakuten.co.jp/shaken/area/tokyo/",
    ],
  ]) {
    assert.ok(entityKey(detail!));
    assert.equal(entityKey(detail!), entityKey(child!));
    assert.equal(entityKey(list!), undefined);
  }
});
test("two independent details are necessary; repeated children, missing proofs and zero thresholds cannot promote", () => {
  const a = audit();
  assert.equal(auditComplete(a), true);
  assert.equal(
    auditComplete({ ...a, details: [a.details[0]!, a.details[0]!] }),
    false,
  );
  assert.equal(auditComplete({ ...a, minDetails: 0 }), false);
  assert.equal(
    auditComplete({
      ...a,
      details: a.details.map((d) => ({ ...d, fields: [] })),
    }),
    false,
  );
  assert.equal(
    reconcileAudit(emptyRegistry(), { ...a, status: "insufficient_detail" })
      .urls.length,
    0,
  );
});
test("trust covers exact evidenced URLs, expires, and is revoked by failed revalidation", () => {
  const a = audit(),
    r = reconcileAudit(emptyRegistry(), a);
  assert.equal(activeTrustedUrls(r).length, 2);
  assert.equal(
    activeTrustedUrls(r, new Date(Date.now() + 2 * 86400000)).length,
    0,
  );
  assert.equal(
    activeTrustedUrls({
      ...r,
      urls: r.urls.map((u) => ({ ...u, url: u.url + "coupon/" })),
    }).length,
    0,
  );
  assert.equal(
    activeTrustedUrls({
      ...r,
      urls: r.urls.map((u) => ({ ...u, service: "jalan" })),
    }).length,
    0,
  );
  assert.equal(activeTrustedUrls({ ...r, audits: [] }).length, 0);
  assert.equal(
    activeTrustedUrls(reconcileAudit(r, { ...a, status: "blocked" })).length,
    0,
  );
});
test("concurrent stores serialize updates without losing source registrations; unknown IDs cannot run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trusted-test-"));
  try {
    const file = join(dir, "registry.json"),
      one = new TrustedStore(file),
      two = new TrustedStore(file);
    assert.deepEqual(await one.load(), emptyRegistry());
    await Promise.all([one.record(audit("one")), two.record(audit("two"))]);
    const r = await one.load();
    assert.equal(r.audits.length, 2);
    assert.equal(r.urls.length, 4);
    assert.deepEqual(
      await one.urlsFor(["one"]),
      audit().details.map((d) => d.url),
    );
    await assert.rejects(one.urlsFor(["unknown"]), /未確認/);
    await assert.rejects(one.urlsFor([]), /必要/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("hidden hotel anchors can guide discovery but hidden text is never evidence", () => {
  const p = extractPublicHtml(
    '<title>一覧</title><body><div style="display:none"><a href="/HOTEL/84721/84721.html">ホテル名</a><p>非表示の施設情報</p></div><p>公開本文</p></body>',
    "https://travel.rakuten.co.jp/yado/kanagawa/hakone.html",
    ["travel.rakuten.co.jp"],
  );
  assert.equal(
    p.links[0]?.url,
    "https://travel.rakuten.co.jp/HOTEL/84721/84721.html",
  );
  assert.doesNotMatch(p.text, /非表示|ホテル名/);
  assert.match(p.text, /公開本文/);
});

test("a delayed older audit cannot revoke a newer successful verification", () => {
  const a = audit(),
    registry = reconcileAudit(emptyRegistry(), a);
  const stale = {
    ...a,
    status: "failed" as const,
    checkedAt: new Date(Date.parse(a.checkedAt) - 1000).toISOString(),
  };
  assert.deepEqual(reconcileAudit(registry, stale), registry);
});
test("shared travel navigation text is insufficient as hotel detail evidence", () => {
  const p = {
    ...page(),
    url: "https://travel.rakuten.co.jp/HOTEL/84721/84721.html",
    text:
      "国内宿泊 交通＋宿 宿泊施設へお問い合わせ サイトマップ " +
      "ご利用案内はこちら。".repeat(30),
  };
  const d = verifyDetail(p);
  assert.equal(d.status, "insufficient_detail");
  assert.deepEqual(d.missingFields, ["access", "facilities", "rooms"]);
});

test("Rakuten item coupons and related-item prices cannot satisfy the selling-price requirement", () => {
  const p = {
    ...page(),
    url: "https://item.rakuten.co.jp/samfolk/sa80ss/",
    title: "旅行リュック",
    text:
      "旅行リュック\n商品詳細 サイズ40L 素材ナイロン ショップSAMFOLK\n" +
      "商品の仕様について記載します。".repeat(20),
  };
  for (const other of [
    "【マラソン限定1000円CP付き】",
    "関連商品\n価格2,790円~\nトラベルポーチ",
    "1万円以上で1000円OFF",
  ]) {
    const d = verifyDetail({ ...p, text: p.text + "\n" + other });
    assert.equal(d.status, "insufficient_detail");
    assert.ok(d.missingFields.includes("price"));
  }
  assert.equal(
    verifyDetail({ ...p, text: p.text + "\n販売価格：6,990円（税込）" }).status,
    "verified",
  );
});

test("legacy trust migrates to derived L3 and an asserted L4 cannot bypass enrichment evidence", async () => {
  const a = audit(),
    r = reconcileAudit(emptyRegistry(), a);
  for (const u of r.urls) u.level = 4;
  assert.ok(activeTrustedUrls(r).every((u) => u.level === 3));
  const dir = await mkdtemp(join(tmpdir(), "trust-level-"));
  try {
    const store = new TrustedStore(join(dir, "registry.json"));
    await store.save(r);
    assert.ok((await store.load()).urls.every((u) => u.level === 3));
    await assert.rejects(store.urlsFor(["sample"], 4), /未確認/);
    assert.equal((await store.urlsFor(["sample"], 3)).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
