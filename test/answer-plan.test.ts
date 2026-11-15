import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newTask, runTask } from "../src/runtime.js";
import { addEvidence, validateAnswer } from "../src/evidence.js";
import {
  assessSpecificity,
  specificityContract,
  validateActionPlan,
  type ActionPlan,
} from "../src/answer-plan.js";
import { diagnose } from "../src/improvement.js";
import { improveTask } from "../src/improvement.js";
import { CodexAgent } from "../src/codex.js";
import { Store } from "../src/store.js";
const url = "https://www.hotpepper.jp/strJ001100102/";
const query =
  "上野で一日のお出かけ。9:30〜17:00、家族予算16000円以内、休憩2回、雨天の案も";
function fixture() {
  const t = newTask({
    query,
    urls: [url],
    agent: "codex",
    maxSteps: 30,
    maxPages: 6,
    timeoutSeconds: 10,
  });
  t.criteria = [
    { id: "price", description: "掲載価格1000円", weight: 1, required: true },
  ];
  t.pages = [
    {
      id: "page-1",
      url,
      title: "食事店",
      text:
        "食事店\n住所 東京都台東区上野7-1-1\nアクセス 上野駅徒歩1分\n営業時間 11:00～22:00\n予算 ランチ1000円。\n" +
        "公開情報の説明です。".repeat(40),
      links: [],
      capturedAt: t.createdAt,
      truncated: false,
    },
  ];
  addEvidence(t, "page-1", "予算 ランチ1000円。");
  t.answer = validateAnswer(
    t,
    "店と料金は確認、詳しい手順は後で",
    [
      {
        name: "食事店",
        url,
        matches: [
          {
            criterionId: "price",
            status: "supported",
            explanation: "1000円と掲載",
            evidenceIds: ["ev-1"],
          },
        ],
      },
    ],
    [],
  );
  return t;
}
function plan(): ActionPlan {
  return {
    steps: ["09:30", "09:40", "09:50", "10:00"].map((when, i) => ({
      id: `s${i}`,
      when,
      where: "食事店の案内板前",
      action: "掲載案内を確認する",
      how: "入口の住所表示と掲載された住所を照合して、営業案内を一枚メモする",
      doneWhen: "住所と営業案内をメモできた",
      durationMinutes: 10,
      locationStatus: "evidence-linked",
      evidenceIds: ["ev-1"],
      costItemIds: i === 3 ? ["lunch"] : [],
    })),
    budget: {
      scenario: "主案",
      items: [
        {
          id: "lunch",
          label: "昼食",
          quantity: 2,
          unitYen: 1000,
          basis: "published",
          evidenceIds: ["ev-1"],
        },
        {
          id: "travel",
          label: "交通見積",
          quantity: 1,
          unitYen: 1000,
          basis: "estimate",
          evidenceIds: [],
        },
      ],
      totalYen: 3000,
    },
    branches: [
      {
        trigger: "雨で屋外移動が難しい場合",
        action: "入口に戻る",
        how: "屋根のある現在の建物入口へ戻り、外出を続けず帰路を選ぶ",
        evidenceIds: [],
      },
      {
        trigger: "場所が見つからない、または利用できない場合",
        action: "出発地点に戻る",
        how: "最後に確認できた出発地点へ戻り、掲載案内と現在地を再確認する",
        evidenceIds: [],
      },
    ],
  };
}
test("specificity checks actionable instructions, time, branches and source-backed arithmetic", () => {
  const t = fixture(),
    a = { ...t.answer!, actionPlan: plan() };
  assert.equal(assessSpecificity(t, a).status, "passed");
  for (const mutate of [
    (p: ActionPlan) => (p.steps[0]!.how = "ゆっくり過ごす"),
    (p: ActionPlan) => (p.steps[0]!.where = "周辺"),
    (p: ActionPlan) => (p.steps[1]!.when = "09:35"),
    (p: ActionPlan) => (p.steps[1]!.when = "10:30"),
    (p: ActionPlan) => (p.steps[0]!.how = "11:40に退園し徒歩20分で駅へ戻る"),
    (p: ActionPlan) => delete p.budget!.scenario,
    (p: ActionPlan) => (p.branches = []),
    (p: ActionPlan) => {
      delete p.budget;
      p.steps.forEach((s) => (s.costItemIds = []));
    },
  ]) {
    const p = plan();
    mutate(p);
    assert.equal(
      assessSpecificity(t, { ...a, actionPlan: p }).status,
      "needs_detail",
    );
  }
  for (const mutate of [
    (p: ActionPlan) => (p.budget!.totalYen = 2999),
    (p: ActionPlan) => {
      p.budget!.items[0]!.unitYen = 2000;
      p.budget!.totalYen = 5000;
    },
    (p: ActionPlan) => (p.steps[0]!.evidenceIds = ["invented"]),
    (p: ActionPlan) => (p.steps[0]!.costItemIds = ["invented"]),
  ]) {
    const p = plan();
    mutate(p);
    assert.throws(() => validateActionPlan(t, p));
  }
  const answered = validateAnswer(
    t,
    "短い結論",
    t.answer!.candidates,
    [],
    plan(),
  );
  assert.match(answered.summary, /具体的な実行手順/);
  assert.match(answered.summary, /完了の目安/);
  assert.match(answered.summary, /未確認の見積/);
  assert.equal(
    validateAnswer(t, answered.summary, answered.candidates, [], plan())
      .summary,
    answered.summary,
  );
});
test("a vague saved success fails independent diagnosis, while fact lookups need no itinerary", () => {
  const t = fixture();
  t.status = "succeeded";
  assert.ok(
    diagnose(t, t.criteria, [url]).causes.includes("insufficient_specificity"),
  );
  assert.equal(
    specificityContract("旅行リュックの容量を確認して").mode,
    "facts",
  );
  assert.equal(specificityContract("箱根旅行の宿を2件比較して").mode, "facts");
  t.answer = validateAnswer(
    t,
    "具体的な提案",
    t.answer!.candidates,
    [],
    plan(),
  );
  assert.equal(diagnose(t, t.criteria, [url]).complete, false);
  assert.ok(
    diagnose(t, t.criteria, [url]).causes.includes(
      "insufficient_visual_artifact",
    ),
  );
  t.query = "掲載料金を確認";
  assert.equal(diagnose(t, t.criteria, [url]).complete, true);
});
test("improvement can adopt a more concrete answer while preserving unresolved factual conditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "specificity-improvement-")),
    store = new Store(root);
  try {
    const seed = fixture();
    seed.criteria.push({
      id: "stock",
      description: "当日の空席",
      required: true,
      weight: 1,
    });
    seed.answer!.candidates[0]!.matches.push({
      criterionId: "stock",
      status: "unknown",
      explanation: "空席未確認",
      evidenceIds: [],
    });
    seed.status = "partial";
    await store.save(seed);
    const loop = await improveTask(
      seed.id,
      { interactionMode: "auto", maxIterations: 1 },
      store,
      async () => {
        const t = fixture();
        t.criteria = structuredClone(seed.criteria);
        t.answer = validateAnswer(
          t,
          "空席は未確認の具体案",
          seed.answer!.candidates,
          ["空席未確認"],
          plan(),
        );
        t.status = "partial";
        await store.save(t);
        return t;
      },
    );
    assert.equal(loop.iterations[0]!.accepted, true);
    assert.equal(loop.best.supportedRequired, loop.baseline.supportedRequired);
    assert.equal(loop.best.complete, false);
    assert.ok(loop.best.achievements.includes("answer:concrete-action-plan"));
    assert.equal(
      (await store.get(loop.bestTaskId)).answer!.candidates[0]!.matches[1]!
        .status,
      "unknown",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const fix of [true, false, "abort"] as const)
  test(`runtime ${fix ? "repairs" : "bounds failed repair of"} a vague answer without relaxing evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "specificity-runtime-")),
      old = process.env.CODEX_BIN;
    process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
    let tools: any[] = [],
      replies: any[] = [];
    const seed = fixture();
    const controller = new AbortController();
    const stubs = [
      mock.method(CodexAgent.prototype, "initialize", async () => ({})),
      mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
        tools = t;
      }),
      mock.method(CodexAgent.prototype, "prompt", async () => {
        const call = async (name: string, args: any) =>
          JSON.parse(
            (await tools.find((t) => t.name === name).execute(name, args))
              .content[0].text,
          ).result;
        await call("plan_task", { criteria: seed.criteria });
        await call("open_page", { url });
        await call("record_evidence", {
          pageId: "page-1",
          quote: "予算 ランチ1000円。",
        });
        const input = {
          summary: "店でゆっくり過ごす",
          candidates: seed.answer!.candidates,
          limitations: ["当日営業は未確認"],
        };
        replies.push(await call("finish_task", input));
        if (fix === "abort") {
          controller.abort();
          return;
        }
        replies.push(
          await call(
            "finish_task",
            fix ? { ...input, actionPlan: plan() } : input,
          ),
        );
        if (!fix) replies.push(await call("finish_task", input));
      }),
    ];
    // Source access is deterministic; this test verifies the actual live finish_task path.
    const { Browser } = await import("../src/browser.js");
    stubs.push(
      mock.method(Browser.prototype, "init", async () => {}),
      mock.method(Browser.prototype, "close", async () => {}),
      mock.method(Browser.prototype, "open", async () =>
        structuredClone(seed.pages[0]!),
      ),
    );
    try {
      const t = await runTask(
        {
          query:
            "具体的な行動計画。9:30〜17:00、家族予算16000円以内、雨天の案も",
          urls: [url],
          agent: "codex",
          maxSteps: 30,
          maxPages: 6,
          timeoutSeconds: 10,
          deepenRounds: 0,
          signal: controller.signal,
        },
        new Store(root),
      );
      assert.equal(replies[0].accepted, false);
      assert.equal(replies[0].qualityGate, "specificity");
      if (fix === "abort") {
        assert.equal(t.status, "cancelled");
        assert.ok(t.answer);
        assert.match(t.answer!.limitations[0]!, /引用検証済みの草案/);
        assert.equal(t.specificity!.status, "needs_detail");
        return;
      }
      assert.equal(replies.at(-1).accepted, true);
      assert.equal(t.specificity!.status, fix ? "passed" : "needs_detail");
      if (fix) {
        assert.ok(t.answer!.actionPlan);
        assert.match(t.answer!.summary, /具体的な実行手順/);
      } else {
        assert.equal(t.status, "partial");
        assert.match(t.answer!.limitations[0]!, /具体的な手順/);
        assert.equal(t.specificity!.attempts.length, 3);
      }
    } finally {
      stubs.forEach((s) => s.mock.restore());
      if (old === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = old;
      await rm(root, { recursive: true, force: true });
    }
  });
