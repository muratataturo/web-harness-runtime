import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTask } from "../src/runtime.js";
import { extractReviewSignal, taskReviewSignals } from "../src/reviews.js";
import { FeedbackStore } from "../src/feedback.js";
import { Store } from "../src/store.js";
function task() {
  const t = newTask({
    query: "サロンを比較",
    urls: ["https://beauty.hotpepper.jp/slnH900000001/"],
    maxSteps: 30,
    maxPages: 6,
    timeoutSeconds: 60,
  });
  t.pages = [
    {
      id: "p1",
      url: t.urls[0]!,
      title: "評価用サロン",
      text: `東京都渋谷区渋谷。渋谷駅徒歩2分。カット料金6000円。髪質改善トリートメント対応。\n4.81\n（978件）\n口コミ・平均点について\n平均点は直近1年間の集計です。\n${"サロンのメニューをご確認ください。".repeat(25)}`,
      links: [],
      capturedAt: "2026-11-10T03:00:00.000Z",
      truncated: false,
    },
  ];
  t.answer = {
    summary: "評価用の比較回答",
    limitations: [],
    candidates: [
      {
        name: "評価用サロン",
        url: t.urls[0]!,
        matches: [],
        score: 0,
        eligible: false,
      },
    ],
  };
  t.status = "partial";
  return t;
}
test("review score and displayed count are a provenance-bearing service proxy, not CSAT", () => {
  const t = task(),
    r = extractReviewSignal(t.pages[0]!)!;
  assert.equal(r.average, 4.81);
  assert.equal(r.displayedCount, 978);
  assert.equal(r.countPeriodConfirmed, false);
  assert.equal(
    r.interpretation,
    "service-review-proxy-not-answer-satisfaction",
  );
  assert.equal(r.scale.max, 5);
  assert.equal(r.capturedAt, t.pages[0]!.capturedAt);
  const before = JSON.stringify(t.answer);
  assert.equal(taskReviewSignals(t).length, 1);
  assert.equal(JSON.stringify(t.answer), before);
});
test("missing, individual or invalid ratings remain missing instead of zero", () => {
  const p = task().pages[0]!;
  assert.equal(
    extractReviewSignal({ ...p, text: p.text.replace("4.81", "14.81") }),
    undefined,
  );
  assert.equal(
    extractReviewSignal({ ...p, text: p.text.replace("978件", "9,,78件") }),
    undefined,
  );
  assert.equal(
    extractReviewSignal({ ...p, text: p.text.replace("4.81", "5.81") }),
    undefined,
  );
  assert.equal(
    extractReviewSignal({ ...p, text: p.text.replace("（978件）", "") }),
    undefined,
  );
  assert.equal(
    extractReviewSignal({ ...p, title: "Access Denied" }),
    undefined,
  );
  assert.equal(
    extractReviewSignal({ ...p, url: "https://item.rakuten.co.jp/shop/item/" }),
    undefined,
  );
});
test("conflicting observations are visible and counts are never summed", () => {
  const t = task();
  t.pages.push({
    ...t.pages[0]!,
    id: "p2",
    text: t.pages[0]!.text.replace("4.81", "4.82"),
    capturedAt: "2026-11-10T04:00:00.000Z",
  });
  const r = taskReviewSignals(t)[0]!;
  assert.equal(r.conflictingObservations, true);
  assert.equal(r.latest.average, 4.82);
  assert.equal(r.latest.displayedCount, 978);
});
test("answer feedback is explicit, empty aggregates stay null and resubmission does not inflate samples", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feedback-test-")),
    store = new Store(dir),
    f = new FeedbackStore(store),
    t = task();
  try {
    assert.equal((await f.summary()).meanRating, null);
    await store.save(t);
    await f.add(t.id, { rating: 5, helpful: true });
    assert.equal((await f.summary()).csat4or5, 1);
    await f.add(t.id, { rating: 2, helpful: false });
    const summary = await f.summary();
    assert.equal(summary.responses, 1);
    assert.equal(summary.meanRating, 2);
    assert.equal(summary.csat4or5, 0);
    await assert.rejects(f.add(t.id, { rating: 6, helpful: true }));
    await assert.rejects(
      f.add(t.id, {
        rating: 3,
        helpful: true,
        candidateUrl: "https://attacker.invalid",
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("benchmark results and third-party reviews cannot become user answer-feedback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feedback-replay-test-")),
    store = new Store(dir),
    f = new FeedbackStore(store),
    t = task();
  try {
    t.evaluation = { mode: "frozen-replay", caseId: "x", fixtureSha256: "x" };
    await store.save(t);
    await assert.rejects(
      f.add(t.id, { rating: 5, helpful: true }),
      /ベンチマーク/,
    );
    assert.equal((await f.summary()).responses, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed stored feedback is rejected instead of inflating satisfaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feedback-integrity-")),
    store = new Store(dir),
    f = new FeedbackStore(store),
    t = task();
  try {
    await store.save(t);
    await f.add(t.id, { rating: 5, helpful: true });
    await writeFile(
      join(dir, "feedback", t.id + ".json"),
      JSON.stringify({
        taskId: t.id,
        rating: 99,
        helpful: true,
        scope: "local-user-answer-feedback",
      }),
    );
    await assert.rejects(f.summary(), /不正/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
