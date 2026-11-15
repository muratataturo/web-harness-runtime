import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTask } from "../src/runtime.js";
import { addEvidence, validateAnswer } from "../src/evidence.js";
import { Store } from "../src/store.js";
import { improveTask, type ImprovementLoop } from "../src/improvement.js";
import {
  buildOfflineExperience,
  recallOfflineExperience,
  learningGroup,
  trajectoryReward,
} from "../src/offline-learning.js";
const url = "https://item.rakuten.co.jp/shop/a/";
function task(query: string, supported: boolean) {
  const t = newTask({
    query,
    urls: [url],
    agent: "codex",
    maxSteps: 30,
    maxPages: 6,
    timeoutSeconds: 60,
  });
  t.criteria = [
    { id: "capacity", description: "容量40L", required: true, weight: 1 },
  ];
  t.pages = [
    {
      id: "page-1",
      url,
      title: "リュック",
      text:
        "販売価格6990円 商品詳細 サイズ 素材 ショップABC\n容量は40Lです。\n" +
        "商品説明".repeat(60),
      links: [],
      capturedAt: t.createdAt,
      truncated: false,
    },
  ];
  const ev = addEvidence(t, "page-1", "容量は40Lです。");
  t.answer = validateAnswer(
    t,
    "容量の確認",
    [
      {
        name: "リュック",
        url,
        matches: [
          {
            criterionId: "capacity",
            status: supported ? "supported" : "unknown",
            explanation: supported ? "40Lと記載" : "未確認",
            evidenceIds: supported ? [ev.id] : [],
          },
        ],
      },
    ],
    [],
  );
  t.status = supported ? "succeeded" : "partial";
  t.metrics = {
    elapsedMs: 1000,
    tokens: {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      cacheWriteInputTokens: 0,
      source: "codex-thread-total",
    },
    billing: {
      mode: "test-fixture",
      additionalApiUsd: 0,
      subscriptionAllocationUsd: null,
      note: "test only",
    },
  };
  return t;
}
test("offline experience groups duplicates, holds out whole goals and revalidates every recalled recipe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "offline-learning-")),
    store = new Store(dir),
    loops: ImprovementLoop[] = [];
  try {
    for (const query of ["容量確認 alpha", "容量確認 beta", "容量確認 gamma"]) {
      const seed = task(query, false);
      await store.save(seed);
      loops.push(
        await improveTask(
          seed.id,
          { interactionMode: "auto", maxIterations: 1 },
          store,
          async (o, s) => {
            const t = task(o.query, true);
            await s!.save(t);
            return t;
          },
        ),
      );
    }
    const manifest = await buildOfflineExperience(store);
    assert.equal(manifest.modelWeightsUpdated, false);
    assert.equal(manifest.trainGroups.length, 2);
    assert.equal(manifest.validationGroups.length, 1);
    assert.equal(
      manifest.trainingReadiness,
      "ready-for-independent-evaluation",
    );
    assert.ok(
      !manifest.trainGroups.some((g) => manifest.validationGroups.includes(g)),
    );
    const heldout = loops.find((l) =>
      manifest.validationGroups.includes(
        learningGroup(l.query, l.criteria, l.candidateUrls),
      ),
    )!;
    assert.equal(await recallOfflineExperience(heldout, store), undefined);
    const trained = loops.find((l) =>
      manifest.trainGroups.includes(
        learningGroup(l.query, l.criteria, l.candidateUrls),
      ),
    )!;
    const recalled = await recallOfflineExperience(trained, store);
    assert.ok(recalled);
    const source = await store.get(recalled.taskId);
    source.evidence[0]!.quote = "改変された架空の容量です";
    await store.save(source);
    assert.equal(await recallOfflineExperience(trained, store), undefined);
    const exported = await readFile(
      join(dir, "learning", manifest.id, "train.jsonl"),
      "utf8",
    );
    assert.ok(!exported.includes("商品説明"));
    assert.ok(!exported.includes("<think>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cost reward cannot make a fast failure outrank a verified success", () => {
  assert.ok(
    trajectoryReward(true, true, 100, 100, 10, 10) >
      trajectoryReward(false, true, 1, 100, 0, 1),
  );
  assert.ok(trajectoryReward(true, false, 1, 100, 0, 1) < 0);
  assert.ok(
    trajectoryReward(true, true, 10, 100, 0, 1) >
      trajectoryReward(true, true, 90, 100, 0, 1),
  );
});
