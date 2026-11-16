import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cafeRequested, cafePlanIssues } from "../src/cafe.js";
import { routeSources, allowedHosts, entityKey } from "../src/sources.js";
import { createResearchProfile } from "../src/runtime-profile.js";
import { newTask } from "../src/runtime.js";
import { addEvidence } from "../src/evidence.js";
import { assessSpecificity } from "../src/answer-plan.js";
import { assessVisualArtifact } from "../src/visual-artifact.js";
import { verifyDetail } from "../src/detail-contracts.js";
import type { Task, Answer } from "../src/types.js";

test("cafe intent discovers dining sources with the same trusted profile and respects exclusions", () => {
  for (const query of [
    "上野でカフェを含む一日遊び",
    "a day trip with coffee",
    "旅行プランに喫茶店も",
  ]) {
    assert.equal(cafeRequested(query), true);
    const urls = ["https://www.tokyo-zoo.net/ueno/"];
    const sources = routeSources(query, urls);
    assert.ok(
      sources.some((s) => s.kind === "hotpepper-gourmet" && s.score === 10),
    );
    assert.deepEqual(
      [...createResearchProfile(urls, undefined, query).hosts].sort(),
      allowedHosts(sources).sort(),
    );
  }
  for (const query of [
    "カフェは不要な一日遊び",
    "旅行に喫茶店は含めない",
    "day trip without coffee",
    "上野動物園の一日遊び",
  ]) {
    assert.equal(cafeRequested(query), false);
    assert.equal(
      routeSources(query, ["https://www.tokyo-zoo.net/ueno/"]).some(
        (s) => s.kind === "hotpepper-gourmet",
      ),
      false,
    );
  }
  assert.equal(
    routeSources("カフェを含む一日遊び", [
      "https://shop.create-restaurants.co.jp/0941/",
    ]).length,
    1,
  );
});

test("a Rakuten-only runtime keeps cafe discovery in the same provider family", () => {
  const previous = process.env.RUNTIME_PROFILE;
  process.env.RUNTIME_PROFILE = "rakuten";
  try {
    const profile = createResearchProfile(
      ["https://travel.rakuten.co.jp/"],
      undefined,
      "旅行にカフェも含めたい",
    );
    assert.ok(profile.hosts.includes("r.gnavi.co.jp"));
    assert.equal(profile.hosts.includes("www.hotpepper.jp"), false);
    assert.equal(profile.id, "rakuten-public-research");
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_PROFILE;
    else process.env.RUNTIME_PROFILE = previous;
  }
});

function fixture() {
  const task = newTask({
    query: "上野でカフェを含む一日遊び",
    urls: ["https://shop.create-restaurants.co.jp/0941/"],
    maxSteps: 20,
    maxPages: 5,
    timeoutSeconds: 30,
  });
  task.pages.push({
    id: "p1",
    url: task.urls[0]!,
    title: "EVERYONEs CAFE",
    text: "EVERYONEs CAFE 上野恩賜公園\n住所 東京都台東区上野公園8-4号\n営業時間 月：10:00〜21:00（L.O.20:00）\nメニュー コーヒーとハーブティー。".repeat(
      3,
    ),
    links: [],
    capturedAt: task.createdAt,
    truncated: false,
  });
  const ev = addEvidence(task, "p1", task.pages[0]!.text.slice(0, 100));
  const answer: Answer = {
    summary: "カフェでひと息",
    candidates: [],
    limitations: [],
    actionPlan: {
      steps: [
        {
          id: "cafe",
          when: "13:00",
          where: "EVERYONEs CAFE 上野恩賜公園",
          action: "カフェ休憩",
          how: "コーヒーかハーブティーを選び、次の行動を相談する。",
          doneWhen: "飲み物を楽しんで退店する。",
          durationMinutes: 40,
          locationStatus: "evidence-linked",
          evidenceIds: [ev.id],
          costItemIds: ["drink"],
        },
      ],
      budget: {
        scenario: "大人2人のカフェ予算枠",
        items: [
          {
            id: "drink",
            label: "飲み物・甘味の予算枠",
            quantity: 2,
            unitYen: 1500,
            basis: "estimate",
            evidenceIds: [],
          },
        ],
        totalYen: 3000,
      },
      branches: [
        {
          trigger: "満席で10分待っても入れない",
          action: "入店を見送り帰路へ",
          how: "追加の待ち時間を増やさず駅へ向かう。",
          evidenceIds: [],
        },
      ],
    },
  };
  return { task, answer };
}
test("a cafe requires same-venue facts, a linked cost and a concrete full-seat fallback", () => {
  const { task, answer } = fixture();
  assert.deepEqual(cafePlanIssues(task, answer), []);
  answer.actionPlan!.steps.unshift({
    ...answer.actionPlan!.steps[0]!,
    id: "queue",
    action: "入店待機",
    costItemIds: [],
    evidenceIds: [],
    locationStatus: "unconfirmed",
  });
  assert.deepEqual(cafePlanIssues(task, answer), []);
  answer.actionPlan!.steps.shift();
  const step = answer.actionPlan!.steps[0]!;
  step.costItemIds = [];
  assert.match(cafePlanIssues(task, answer).join(" "), /費用/);
  step.costItemIds = ["drink"];
  answer.actionPlan!.branches = [];
  assert.match(cafePlanIssues(task, answer).join(" "), /満席/);
  step.evidenceIds = [];
  assert.match(cafePlanIssues(task, answer).join(" "), /同一店舗/);
});
test("another branch's address and a provider directory cannot complete a cafe's evidence", () => {
  const { task, answer } = fixture();
  task.pages[0]!.text =
    "EVERYONEs CAFE のメニューと住所 東京都台東区上野公園8-4号";
  task.evidence = [];
  const a = addEvidence(task, "p1", task.pages[0]!.text);
  task.pages.push({
    ...task.pages[0]!,
    id: "p2",
    url: "https://shop.create-restaurants.co.jp/9999/",
    text: "別のカフェ 営業時間 10:00〜21:00",
  });
  const b = addEvidence(task, "p2", task.pages[1]!.text);
  answer.actionPlan!.steps[0]!.evidenceIds = [a.id, b.id];
  assert.match(cafePlanIssues(task, answer).join(" "), /同一店舗/);
  task.pages[1]!.url = "https://www.hotpepper.jp/SA11/";
  task.pages[1]!.text = "カフェ一覧 住所 東京都 営業時間 10:00〜21:00";
  task.evidence.pop();
  const directory = addEvidence(task, "p2", task.pages[1]!.text);
  answer.actionPlan!.steps[0]!.evidenceIds = [directory.id];
  assert.match(cafePlanIssues(task, answer).join(" "), /同一店舗/);
  assert.notEqual(
    entityKey(task.urls[0]!),
    entityKey("https://shop.create-restaurants.co.jp/9999/"),
  );
});
test("an average restaurant budget is not a published drink price", () => {
  const { task, answer } = fixture();
  task.pages[0]!.text += "\n平均予算[昼/夜] 1500円 / 1900円";
  const ev = addEvidence(task, "p1", "平均予算[昼/夜] 1500円 / 1900円");
  const item = answer.actionPlan!.budget!.items[0]!;
  item.basis = "published";
  item.evidenceIds = [ev.id];
  assert.match(cafePlanIssues(task, answer).join(" "), /平均予算/);
  item.basis = "estimate";
  assert.deepEqual(cafePlanIssues(task, answer), []);
});
test("cafe gaps participate in the common specificity improvement gate and rest stops need photos", async () => {
  const task: Task = JSON.parse(
    await readFile("examples/visual-travel-answer.json", "utf8"),
  );
  delete task.evaluation;
  task.query += " カフェも含めたい";
  assert.match(
    assessSpecificity(task, task.answer!).issues.join(" "),
    /カフェ/,
  );
  const artifact = task.answer!.visualArtifact!;
  if (artifact.kind !== "journey-map") throw Error();
  const stop = artifact.stops.find((s) => s.id === "zoo")!;
  const step = task.answer!.actionPlan!.steps.find(
    (s) => s.id === stop.primaryStepId,
  )!;
  step.action = "カフェで休憩";
  delete stop.experience;
  assert.match(
    assessVisualArtifact(task, task.answer!).issues.join(" "),
    /主要な訪問先/,
  );
});
test("official cafe details keep branch identity and do not require an invented item price", () => {
  const { task } = fixture();
  assert.equal(verifyDetail(task.pages[0]!).status, "verified");
  assert.equal(
    entityKey("https://shop.create-restaurants.co.jp/0941/menu/"),
    entityKey(task.urls[0]!),
  );
  assert.equal(entityKey("https://shop.create-restaurants.co.jp/"), undefined);
});

test("an itinerary cannot bypass cafe checks by omitting candidate comparisons", () => {
  const { task, answer } = fixture();
  answer.actionPlan!.steps[0]!.costItemIds = [];
  const review = assessSpecificity(task, answer);
  assert.equal(review.status, "needs_detail");
  assert.match(review.issues.join(" "), /費用/);
});
