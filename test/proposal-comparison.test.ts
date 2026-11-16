import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateProposalSet,
  contentSimilarity,
  proposalRevision,
  rankProposals,
  type ProposalSet,
} from "../src/proposals.js";
import {
  validateVisualArtifact,
  assessVisualArtifact,
} from "../src/visual-artifact.js";
import { UxFeedbackStore } from "../src/ux-feedback.js";
import { Store } from "../src/store.js";
import type { Task } from "../src/types.js";
async function fixture() {
  const t: Task = JSON.parse(
    await readFile("examples/visual-travel-answer.json", "utf8"),
  );
  delete t.evaluation;
  t.id = randomUUID();
  t.query += " 子供が疲れないように3案を比較して選ぶ";
  return t;
}
function options(t: Task): ProposalSet {
  const a = t.answer!.visualArtifact!;
  if (a.kind !== "journey-map") throw Error();
  const anchor = a.stops.find((s) => s.id === "zoo")!;
  const base = {
    anchorId: anchor.id,
    stepId: anchor.primaryStepId,
    minutes: 12,
    evidenceIds: anchor.evidenceIds.slice(0, 1),
  };
  return {
    options: [
      {
        ...base,
        id: "discover",
        theme: "discovery",
        mechanism: "compare",
        title: "足の形を比べる",
        activity:
          "案内で公開中の2種類を選び、足の形を交互に観察して違いを丸印と短い言葉で1つずつ残す。",
        deliverable: "違いが2つ分かる比較メモ",
        benefit: "動物の特徴を自分の言葉で説明できる。",
        difference: "見る対象をただ増やすのでなく違いを二つ記録する。",
        tradeoff: "比較より気楽に眺めたい場合はゆったり案へ。",
      },
      {
        ...base,
        id: "relax",
        theme: "relax",
        mechanism: "focus",
        title: "ひとつの動きを見つめる",
        activity:
          "その場で見られる1種類だけを選び、動きを一つ見つけたら次の回遊は増やさず今日の発見を一言で話す。",
        deliverable: "気に入った動きについて短い感想一つ",
        benefit: "観察対象を絞って自分のペースで楽しむ。",
        difference: "比較や記録を必須にせず一つの対象へ関心を向ける。",
        tradeoff: "多くの種類を見たいときは発見案へ。",
      },
      {
        ...base,
        id: "photo",
        theme: "photo",
        mechanism: "capture",
        title: "形を二つの見方で残す",
        activity:
          "撮影可の表示を確認し、許可される場合だけ同じ対象を別の角度から1枚ずつ残し、不可なら紙に形を描いて記録する。",
        deliverable: "二つの角度の記録と短い説明文",
        benefit: "家に帰ってから思い出しやすい記録を残す。",
        difference: "観察して終わらず本人が見た特徴を記録へ変える。",
        tradeoff: "撮影可否や場所は未確認なので禁止の場合は紙に描く。",
      },
    ],
  };
}
test("three proposals change actions and outcomes rather than just titles; fixed slots and citations are checked", async () => {
  const t = await fixture(),
    set = options(t),
    a = t.answer!.visualArtifact!;
  a.proposalSet = set;
  validateVisualArtifact(t, a);
  assert.equal(assessVisualArtifact(t, t.answer!).status, "passed");
  assert.ok(
    contentSimilarity(set.options[0]!.activity, set.options[1]!.activity) <
      0.72,
  );
  const duplicate = structuredClone(set);
  duplicate.options[1]!.activity = duplicate.options[0]!.activity;
  duplicate.options[1]!.deliverable = duplicate.options[0]!.deliverable;
  duplicate.options[1]!.title = "別の魅力的な名前";
  assert.throws(() => validateProposalSet(t, duplicate, a), /似すぎ/);
  const over = structuredClone(set);
  over.options[0]!.minutes = 180;
  assert.throws(() => validateProposalSet(t, over, a), /活動枠/);
  const foreign = structuredClone(set);
  foreign.options[0]!.anchorId = "unknown";
  assert.throws(() => validateProposalSet(t, foreign, a), /地点/);
  delete a.proposalSet;
  assert.ok(
    assessVisualArtifact(t, t.answer!).issues.some((i) =>
      i.includes("proposalSet"),
    ),
  );
});
test("ranking describes query correspondence and never calls it measured human appeal", async () => {
  const t = await fixture(),
    rank = rankProposals(t, options(t));
  assert.equal(rank.recommendedId, "relax");
  assert.match(rank.assessment, /人間の魅力度/);
});
test("versioned human feedback deduplicates browser/variant responses and produces actionable, non-fabricated guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "proposal-ux-")),
    store = new Store(root),
    ux = new UxFeedbackStore(store),
    t = await fixture();
  t.answer!.visualArtifact!.proposalSet = options(t);
  await store.save(t);
  try {
    const empty = await ux.learningContext(t.id);
    assert.equal(empty.responses, 0);
    assert.equal(empty.humanAppealStatus, "unrated");
    const input = {
      designVersion: "ten-second-v2" as const,
      exposureMs: 10000,
      reviewerId: "browser-reviewer-0001",
      artifactRevision: proposalRevision(t),
      proposalId: "relax",
      understood: true,
      uncertaintyVisible: true,
      nextActionClear: true,
      appeal: 2,
      issues: ["unclear_difference" as const],
    };
    await assert.rejects(ux.add(t.id, { ...input, exposureMs: 9999 }), /10秒/);
    await ux.add(t.id, input);
    await ux.add(t.id, { ...input, appeal: 4 });
    const context = await ux.learningContext(t.id);
    assert.equal(context.responses, 1);
    assert.equal(context.uniqueBrowserReviewers, 1);
    assert.equal(context.independentHumansVerified, false);
    assert.ok(context.guidance.some((s) => s.includes("成果")));
    assert.equal(
      context.variants.find((v) => v.proposalId === "relax")!.medianAppeal,
      4,
    );
    t.answer!.visualArtifact!.proposalSet!.options[0]!.activity +=
      " 最後に感想を話す。";
    await store.save(t);
    assert.equal((await ux.learningContext(t.id)).responses, 0);
    await assert.rejects(ux.add(t.id, input), /版/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("answer endpoint binds the feedback form to the saved task and keeps same-origin protection", async () => {
  const { createWorkbenchServer } = await import("../src/server.js");
  const { GoalEngine, GoalRepository } = await import("../src/goals.js");
  const root = await mkdtemp(join(tmpdir(), "comparison-api-")),
    store = new Store(root),
    t = await fixture();
  t.answer!.visualArtifact!.proposalSet = options(t);
  await store.save(t);
  const engine = new GoalEngine(new GoalRepository(join(root, "goals")), 1),
    server = createWorkbenchServer(engine, store, {
      get: async () => ({ taskId: t.id }),
      shutdown: async () => {},
    } as any);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const answer = await fetch(base + "/api/runs/demo/answer.html");
    const html = await answer.text();
    assert.match(html, new RegExp("/api/tasks/" + t.id + "/ux-feedback"));
    assert.match(html, /proposal-comparison/);
    const taskAnswer = await fetch(
      base + "/api/tasks/" + t.id + "/answer.html",
    );
    assert.equal(taskAnswer.status, 200);
    assert.match(
      await taskAnswer.text(),
      new RegExp("/api/tasks/" + t.id + "/answer-assets"),
    );
    const payload = {
      designVersion: "ten-second-v2",
      exposureMs: 10000,
      reviewerId: "test-browser-0001",
      artifactRevision: proposalRevision(t),
      proposalId: "relax",
      understood: true,
      uncertaintyVisible: true,
      nextActionClear: true,
      appeal: 3,
      issues: ["unclear_difference"],
    };
    const endpoint = base + "/api/tasks/" + t.id + "/ux-feedback";
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Origin: "https://evil.example",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
      200,
    );
    const context = (await (await fetch(endpoint)).json()) as any;
    assert.equal(context.responses, 1);
    assert.equal(context.independentHumansVerified, false);
    assert.ok(context.guidance.length);
  } finally {
    engine.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("real-review guidance is passed into the next model run without becoming a rating of its output", async () => {
  const { visualRefinementRunner } =
      await import("../src/visual-refinement.js"),
    { CodexAgent } = await import("../src/codex.js");
  const root = await mkdtemp(join(tmpdir(), "proposal-learning-")),
    store = new Store(root),
    ux = new UxFeedbackStore(store);
  const seed: Task = JSON.parse(
    await readFile("examples/visual-comparison-life-answer.json", "utf8"),
  );
  delete seed.evaluation;
  seed.id = randomUUID();
  await store.save(seed);
  const option = seed.answer!.visualArtifact!.proposalSet!.options[0]!;
  await ux.add(seed.id, {
    designVersion: "ten-second-v2",
    reviewerId: "test-browser-learning",
    artifactRevision: proposalRevision(seed),
    proposalId: option.id,
    exposureMs: 10000,
    understood: false,
    uncertaintyVisible: true,
    nextActionClear: false,
    appeal: 2,
    issues: ["unclear_difference"],
  });
  const oldBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [],
    seen = false;
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async (message: string) => {
      const input = JSON.parse(message);
      assert.equal(input.uxLearningContext.responses, 1);
      assert.ok(
        input.uxLearningContext.guidance.some((s: string) =>
          s.includes("成果"),
        ),
      );
      seen = true;
      const finish = tools.find((t) => t.name === "finish_proposals");
      assert.ok(finish);
      const result = await finish.execute("fixture", {
        proposalSet: seed.answer!.visualArtifact!.proposalSet,
      });
      assert.equal(JSON.parse(result.content[0].text).accepted, true);
    }),
  ];
  try {
    const result = await visualRefinementRunner()(
      {
        parentId: seed.id,
        query: seed.query,
        urls: seed.urls,
        agent: "codex",
        maxSteps: 20,
        maxPages: 10,
        timeoutSeconds: 30,
      },
      store,
    );
    assert.equal(seen, true);
    assert.equal(result.visualReview!.status, "passed");
    assert.deepEqual(result.answer!.actionPlan, seed.answer!.actionPlan);
    assert.equal(result.uxLearningContext!.responses, 1);
    assert.equal((await ux.learningContext(result.id)).responses, 0);
  } finally {
    for (const m of mocks) m.mock.restore();
    if (oldBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = oldBin;
    await rm(root, { recursive: true, force: true });
  }
});
