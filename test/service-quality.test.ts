import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTRACT } from "../src/browser.js";
import { assessPage } from "../src/page-quality.js";
import { entityKey } from "../src/sources.js";
import { newTask } from "../src/runtime.js";
import { setCriteria, addEvidence, validateAnswer } from "../src/evidence.js";
test("fixed extraction script includes title and prioritizes deduplicated candidate links", () => {
  const doc = {
    title: "店舗A",
    body: { innerText: "渋谷駅から徒歩3分" },
    querySelectorAll: () => [
      {
        innerText: "京都一覧",
        href: "https://www.hotpepper.jp/SA22/",
        getClientRects: () => [{}],
      },
      {
        innerText: "店舗A",
        href: "https://www.hotpepper.jp/strJ000000001/",
        getClientRects: () => [{}],
      },
      {
        innerText: "店舗A詳細",
        href: "https://www.hotpepper.jp/strJ000000001/",
        getClientRects: () => [{}],
      },
    ],
  };
  const extract = new Function("document", "location", `return ${EXTRACT}`);
  const result = JSON.parse(
    extract(doc, { href: "https://www.hotpepper.jp/SA22/" }),
  );
  assert.equal(result.links.length, 2);
  assert.match(result.links[0].url, /strJ/);
  assert.match(result.text, /店舗A\n渋谷/);
});
test("maintenance, blocking and updates have distinct availability outcomes", () => {
  assert.equal(
    assessPage({ title: "Blocked - Indeed.com", text: "Request Blocked" }).kind,
    "access_denied",
  );
  assert.equal(
    assessPage({
      title: "美容室",
      text: "システムメンテナンスのためご利用できません。メンテナンス終了までしばらくお待ち下さい。",
    }).kind,
    "maintenance",
  );
  assert.equal(
    assessPage({
      title: "カーセンサー",
      text: "在庫状況や販売価格の変更が、現在の掲載情報に反映されていない場合がございます。",
    }).kind,
    "degraded",
  );
  assert.equal(
    assessPage({
      title: "店舗A",
      text: "京都駅から徒歩3分、ランチ2000円の和食店です。",
    }).kind,
    "available",
  );
});
test("known service entity IDs keep individual detail children together and exclude search pages", () => {
  const cases = [
    [
      "https://beauty.hotpepper.jp/sln/H000000001/",
      "https://beauty.hotpepper.jp/sln/H000000001/coupon/",
      "https://beauty.hotpepper.jp/sln/keyword/",
    ],
    [
      "https://www.hotpepper.jp/strJ000000001/",
      "https://www.hotpepper.jp/strJ000000001/food/",
      "https://www.hotpepper.jp/SA22/",
    ],
    [
      "https://www.jalan.net/yad123456/",
      "https://www.jalan.net/yad123456/bath/",
      "https://www.jalan.net/",
    ],
    [
      "https://www.carsensor.net/usedcar/detail/AU000001/index.html",
      "https://www.carsensor.net/usedcar/detail/AU000001/index.html?TRCD=200002",
      "https://www.carsensor.net/usedcar/bTO/s077/index.html",
    ],
    [
      "https://suumo.jp/chintai/bc_100000001/",
      "https://suumo.jp/chintai/bc_100000001/?suit=nsuusbsp20121129001",
      "https://suumo.jp/chintai/kanagawa/",
    ],
    [
      "https://jp.indeed.com/viewjob?jk=abcdef",
      "https://jp.indeed.com/viewjob?jk=abcdef&from=web",
      "https://jp.indeed.com/jobs?q=engineer",
    ],
  ];
  for (const [a, b, list] of cases) {
    assert.equal(entityKey(a!), entityKey(b!));
    assert.equal(entityKey(list!), undefined);
  }
});
test("a service listing page or a blocked detail cannot be recommended as a candidate", () => {
  const task = newTask({
    query: "京都駅の和食店",
    urls: ["https://www.hotpepper.jp/"],
    maxSteps: 20,
    maxPages: 5,
    timeoutSeconds: 30,
  });
  setCriteria(task, [
    { id: "station", description: "京都駅徒歩10分", weight: 5, required: true },
  ]);
  task.pages.push({
    id: "p1",
    url: "https://www.hotpepper.jp/SA22/",
    title: "京都駅のお店一覧",
    text: "京都駅から徒歩3分のお店を探す一覧ページ。",
    links: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  });
  const ev = addEvidence(task, "p1", "京都駅から徒歩3分");
  const c = {
    name: "一覧ページ",
    url: task.pages[0]!.url,
    matches: [
      {
        criterionId: "station",
        status: "supported" as const,
        explanation: "徒歩3分",
        evidenceIds: [ev.id],
      },
    ],
  };
  assert.throws(() => validateAnswer(task, "候補", [c], []), /個別/);
  task.pages[0]!.url = "https://www.hotpepper.jp/strJ000000001/";
  task.pages[0]!.title = "Access Denied";
  task.pages[0]!.text = "Access Denied";
  assert.throws(
    () => validateAnswer(task, "候補", [{ ...c, url: task.pages[0]!.url }], []),
    /アクセス制限/,
  );
});

test("provider errors distinguish exhausted free daily quota from retryable throttling", async () => {
  const { providerFailureKind } = await import("../src/models.js");
  assert.equal(
    providerFailureKind(
      new Error("429 free-models-per-day openrouter_free_tier_daily"),
    ),
    "daily_limit",
  );
  assert.equal(providerFailureKind("429 Too many requests"), "rate_limit");
  assert.equal(providerFailureKind("401 Invalid API key"), "auth");
});
test("service evaluation reports structural success separately from access and API errors", async () => {
  const { evaluateServiceTask } = await import("../src/service-evals.js");
  const testCase = {
    id: "indeed",
    service: "indeed",
    query: "東京の求人",
    urls: ["https://jp.indeed.com/"],
    minCandidates: 2,
    expectedCriteria: ["東京"],
  };
  const task = newTask({
    query: testCase.query,
    urls: testCase.urls,
    maxSteps: 20,
    maxPages: 5,
    timeoutSeconds: 30,
  });
  task.status = "blocked";
  task.pages.push({
    id: "p1",
    url: "https://jp.indeed.com/",
    title: "Blocked - Indeed.com",
    text: "Request Blocked",
    links: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  });
  assert.equal(evaluateServiceTask(testCase, task).outcome, "site_blocked");
  task.status = "failed";
  task.error = "429 free-models-per-day";
  assert.equal(evaluateServiceTask(testCase, task).outcome, "runtime_failed");
});
