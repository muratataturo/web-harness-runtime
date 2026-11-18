import { test } from "node:test";
import assert from "node:assert/strict";
import { tripBrief, tripRhythmIssues } from "../src/trip-brief.js";
import { verifyStepPlan } from "../src/step-verifier.js";
import { newTask } from "../src/runtime.js";
import { addEvidence } from "../src/evidence.js";
import { specificityContract, type ActionPlan } from "../src/answer-plan.js";
import { deepeningActions } from "../src/research.js";
import { renderTripRhythm } from "../src/trip-rhythm-html.js";
const url = "https://www.act-okura.co.jp/facilities/gallery/";
function fixture() {
  const task = newTask({
    query: "浜松で午後だけちょっと遊ぶ",
    urls: [url],
    maxSteps: 60,
    maxPages: 12,
    timeoutSeconds: 60,
  });
  task.pages = [
    {
      id: "p1",
      url,
      title: "展望回廊",
      text: "営業時間 11:00 〜 18:00（最終入場17：30）。大人1,200円。都合により休業する場合があります。",
      links: [],
      capturedAt: task.createdAt,
      truncated: false,
    },
  ];
  addEvidence(task, "p1", task.pages[0]!.text);
  const plan: ActionPlan = {
    steps: [
      {
        id: "s1",
        kind: "activity",
        venueUrl: url,
        when: "16:00",
        where: "展望回廊",
        action: "北側の眺望を楽しむ",
        how: "入口の当日案内を確認して入場する",
        doneWhen: "眺望を見て入口へ戻る",
        durationMinutes: 60,
        evidenceIds: ["ev-1"],
        costItemIds: [],
        locationStatus: "evidence-linked",
      },
    ],
    branches: [],
    stepChecks: [
      {
        id: "opening1",
        stepId: "s1",
        venueUrl: url,
        kind: "opening",
        opens: "11:00",
        closes: "18:00",
        lastEntry: "17:30",
        evidenceIds: ["ev-1"],
      },
    ],
  };
  return { task, plan };
}
test("trip intent separates full day, afternoon and short visits, with explicit time winning", () => {
  assert.equal(tripBrief("丸一日ゆっくり浜松で遊ぶ")?.mode, "full-day");
  assert.deepEqual(tripBrief("日帰り旅行")?.timeRange, ["09:00", "20:00"]);
  assert.equal(tripBrief("午後だけちょっと遊ぶ")?.pacing, "relaxed");
  assert.deepEqual(tripBrief("午後だけちょっと遊ぶ")?.timeRange, [
    "13:00",
    "17:00",
  ]);
  assert.equal(tripBrief("2時間だけ寄り道")?.mode, "short");
  assert.equal(
    tripBrief("朝から夜まで丸一日、午前の体験、昼食、午後の体験とカフェ、夕食")
      ?.mode,
    "full-day",
  );
  assert.equal(tripBrief("一日ではなく午後だけ遊ぶ")?.mode, "afternoon");
  assert.equal(tripBrief("一日10:00〜15:00遊ぶ")?.timeBasis, "user-specified");
  assert.equal(tripBrief("一日10:00〜15:00遊ぶ")?.requiresStepResearch, false);
  assert.equal(tripBrief("本の価格を調べる"), undefined);
});
test("full day cannot be fulfilled by a short morning; meals, afternoon and night are checked", () => {
  const { plan } = fixture();
  const issues = tripRhythmIssues("一日遊ぶ", plan);
  assert.ok(issues.some((s) => s.includes("午前")));
  assert.ok(issues.some((s) => s.includes("昼食")));
  assert.ok(issues.some((s) => s.includes("夕食")));
  assert.ok(issues.some((s) => s.includes("夜")));
  assert.ok(issues.some((s) => s.includes("09:00〜20:00")));
  assert.deepEqual(tripRhythmIssues("一日10:00〜15:00遊ぶ", plan), []);
});
test("step verifier checks source integrity, closing time and last admission, recomputing every plan", () => {
  const { task, plan } = fixture();
  const first = verifyStepPlan(task, plan);
  assert.equal(first.ready, true);
  plan.steps[0]!.when = "17:40";
  plan.steps[0]!.durationMinutes = 10;
  const next = verifyStepPlan(task, plan);
  assert.equal(next.failed, 1);
  assert.notEqual(first.planHash, next.planHash);
  plan.steps[0]!.when = "16:00";
  plan.stepChecks![0]!.closes = "21:00";
  assert.equal(verifyStepPlan(task, plan).unknown, 1);
  task.evidence[0]!.quote = "営業時間11:00〜21:00";
  assert.equal(verifyStepPlan(task, plan).failed, 1);
});
test("source and step references cannot be borrowed from another venue", () => {
  const { task, plan } = fixture();
  plan.stepChecks![0]!.venueUrl =
    "https://www.act-okura.co.jp/restaurant/cafe/";
  assert.equal(verifyStepPlan(task, plan).failed, 1);
  plan.stepChecks![0]!.venueUrl = url;
  plan.steps[0]!.evidenceIds = [];
  assert.equal(verifyStepPlan(task, plan).failed, 1);
});
test("unknowns request research while seats and travel remain explicitly conditional", () => {
  const { task, plan } = fixture();
  plan.stepChecks = [];
  plan.steps[0]!.kind = "cafe";
  const r = verifyStepPlan(task, plan);
  assert.equal(r.unknown, 1);
  assert.equal(
    r.checks.find((c) => c.status === "unknown")?.needsResearch,
    true,
  );
  assert.ok(r.checks.some((c) => c.status === "arrival-check"));
  plan.steps[0]!.kind = "move";
  assert.equal(verifyStepPlan(task, plan).checks[0]!.status, "proposal");
});
test("deepresearch ranks hours and menu links inside the same venue and respects attempted links", () => {
  const { task } = fixture();
  const p = task.pages[0]!;
  p.url = "https://www.gakkihaku.jp/";
  p.text =
    "楽器博物館の利用案内。住所 静岡県浜松市。入館料800円。開館時間9:30〜17:00。".repeat(
      10,
    );
  p.links = [
    { url: "https://www.gakkihaku.jp/news/", text: "新着情報" },
    { url: "https://www.gakkihaku.jp/guide/", text: "開館時間・カレンダー" },
    { url: "https://www.act-okura.co.jp/restaurant/cafe/", text: "営業時間" },
  ];
  const actions = deepeningActions(p, ["営業時間", "休館日"], new Set());
  assert.equal(actions[0]?.url, "https://www.gakkihaku.jp/guide/");
  assert.ok(actions.every((a) => a.url.includes("gakkihaku.jp")));
  assert.ok(
    !deepeningActions(
      p,
      ["営業時間"],
      new Set(["link:https://www.gakkihaku.jp/guide/"]),
    ).some((a) => a.url.endsWith("guide/")),
  );
});
test("HTML exposes suggested rhythm and unknown step checks without claiming future availability", () => {
  const { task, plan } = fixture();
  task.answer = {
    summary: "午後の提案",
    candidates: [],
    limitations: [],
    actionPlan: plan,
  };
  plan.stepChecks = [];
  const html = renderTripRhythm(task, () => "");
  assert.match(html, /午後だけ/);
  assert.match(html, /13:00 → 17:00/);
  assert.match(html, /未確認 1件/);
  assert.match(html, /時刻の指定がないため/);
});

test("runtime step deepresearch fetches discovered same-venue links once and requires new evidence before recheck", async () => {
  const { mock } = await import("node:test");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { CodexAgent } = await import("../src/codex.js");
  const { Browser } = await import("../src/browser.js");
  const { Store } = await import("../src/store.js");
  const { runTask } = await import("../src/runtime.js");
  const root = await mkdtemp(join(tmpdir(), "step-deepresearch-"));
  const old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  const source = "https://www.hotpepper.jp/strJ001100102/";
  const child = source + "food/";
  let tools: any[] = [],
    ran = false;
  const replies: any[] = [],
    opened: string[] = [];
  const stubs = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(Browser.prototype, "init", async () => {}),
    mock.method(Browser.prototype, "close", async () => {}),
    mock.method(Browser.prototype, "open", async (value: string) => {
      opened.push(value);
      return {
        id: value === child ? "page-2" : value === source ? "page-1" : "page-3",
        url: value,
        title: "食事店",
        text:
          (value === child
            ? "営業時間 11:00〜18:00。"
            : "東京都台東区上野1-1-1。メニュー 昼食1000円。") +
          "公開店舗の詳細情報です。".repeat(40),
        links:
          value === source ? [{ url: child, text: "営業時間とメニュー" }] : [],
        capturedAt: new Date().toISOString(),
        truncated: false,
      };
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      if (ran) return;
      ran = true;
      const call = async (name: string, args: any) => {
        const output = await tools
          .find((t) => t.name === name)
          .execute(name, args);
        const parsed = JSON.parse(output.content[0].text);
        assert.ok(!output.isError, JSON.stringify(parsed));
        return parsed.result;
      };
      await call("plan_task", {
        criteria: [
          { id: "price", description: "掲載価格", required: true, weight: 1 },
        ],
      });
      await call("open_page", { url: source });
      await call("record_evidence", {
        pageId: "page-1",
        quote: "東京都台東区上野1-1-1。メニュー 昼食1000円。",
      });
      const { plan } = fixture();
      plan.steps[0]!.venueUrl = source;
      plan.stepChecks = [];
      await call("stage_plan", { actionPlan: plan });
      replies.push(await call("verify_steps", { deepResearch: true }));
      replies.push(await call("verify_steps", { deepResearch: true }));
      await call("record_evidence", {
        pageId: "page-2",
        quote: "営業時間 11:00〜18:00。",
      });
      plan.steps[0]!.evidenceIds.push("ev-2");
      plan.stepChecks = [
        {
          id: "check1",
          stepId: "s1",
          kind: "opening",
          venueUrl: source,
          evidenceIds: ["ev-2"],
          opens: "11:00",
          closes: "18:00",
        },
      ];
      await call("stage_plan", { actionPlan: plan });
      replies.push(await call("verify_steps", {}));
      await call("open_page", { url: "https://www.hotpepper.jp/" });
      plan.steps[0]!.venueUrl = "https://www.hotpepper.jp/article/other/";
      plan.stepChecks = [];
      await call("stage_plan", { actionPlan: plan });
      replies.push(await call("verify_steps", {}));
    }),
  ];
  try {
    const result = await runTask(
      {
        query: "午後だけちょっと遊ぶ",
        urls: [source],
        agent: "codex",
        maxSteps: 40,
        maxPages: 6,
        timeoutSeconds: 20,
        deepenRounds: 1,
      },
      new Store(root),
    );
    assert.ok(replies.length, result.error);
    assert.equal(replies[0].report.unknown, 1);
    assert.equal(replies[0].additional.length, 1);
    assert.equal(replies[1].additional.length, 0);
    assert.equal(replies[1].remainingRounds, 0);
    assert.equal(replies[2].report.ready, true);
    assert.deepEqual(replies[3].contexts, []);
    assert.deepEqual(opened, [source, child, "https://www.hotpepper.jp/"]);
  } finally {
    stubs.forEach((s) => s.mock.restore());
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("self-improvement diagnosis rechecks the current steps rather than trusting an earlier ready report", async () => {
  const { diagnose } = await import("../src/improvement.js");
  const { task, plan } = fixture();
  task.stepVerification = verifyStepPlan(task, plan);
  assert.equal(task.stepVerification.ready, true);
  plan.steps[0]!.when = "18:30";
  task.answer = {
    summary: "夕方の体験",
    candidates: [],
    limitations: [],
    actionPlan: plan,
  };
  task.criteria = [
    { id: "opening", description: "通常営業時間", required: true, weight: 1 },
  ];
  task.answer.candidates = [
    {
      name: "展望回廊",
      url,
      eligible: true,
      score: 1,
      matches: [
        {
          criterionId: "opening",
          status: "supported",
          explanation: "通常営業時間を引用",
          evidenceIds: ["ev-1"],
        },
      ],
    },
  ];
  const diagnosis = diagnose(task, task.criteria, [url], false, 1);
  assert.equal(diagnosis.complete, false);
  assert.ok(
    diagnosis.causes.includes("insufficient_specificity"),
    diagnosis.validationError,
  );
  assert.ok(
    diagnosis.gaps.some((g) => g.fields.some((f) => f.includes("衝突"))),
  );
});

test("step verifier rejects invalid clock values and missing duration instead of comparing NaN", () => {
  for (const invalid of ["午後4時", "25:00", "16:99"]) {
    const { task, plan } = fixture();
    plan.steps[0]!.when = invalid;
    assert.equal(verifyStepPlan(task, plan).ready, false);
    assert.equal(verifyStepPlan(task, plan).failed, 1);
  }
  const { task, plan } = fixture();
  delete plan.steps[0]!.durationMinutes;
  assert.equal(verifyStepPlan(task, plan).failed, 1);
});

test("calendar dates do not turn factual lookups or short visits into a full-day request", () => {
  assert.equal(tripBrief("2026年11月21日に2時間だけ寄り道")?.mode, "short");
  assert.equal(tripBrief("2026年11月1日に午後から遊ぶ")?.mode, "afternoon");
  assert.equal(tripBrief("2026年11月21日の営業時間を調べて"), undefined);
  assert.equal(
    specificityContract("2026年11月21日の営業時間を調べて").mode,
    "facts",
  );
  assert.equal(tripBrief("朝から夜まで楽しむプラン")?.mode, "full-day");
  assert.equal(tripBrief("１日遊ぶ")?.mode, "full-day");
});
