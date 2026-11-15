import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerBrief } from "../web/presentation.js";
import { UxFeedbackStore } from "../src/ux-feedback.js";
import { newTask } from "../src/runtime.js";
import { Store } from "../src/store.js";
test("first-glance view preserves unknown and contradicted and never claims eligibility", () => {
  const task = {
    criteria: [
      { id: "a", description: "価格" },
      { id: "b", description: "空席" },
      { id: "c", description: "徒歩" },
    ],
    answer: {
      candidates: [
        {
          matches: [
            { criterionId: "a", status: "supported", explanation: "1000円" },
            { criterionId: "b", status: "unknown", explanation: "未確認" },
            { criterionId: "c", status: "contradicted", explanation: "上限外" },
          ],
        },
      ],
      limitations: ["掲載情報"],
    },
  };
  const snapshot = JSON.stringify(task),
    brief = answerBrief(task);
  assert.equal(brief.unknown, 1);
  assert.equal(brief.contradicted, 1);
  assert.equal(brief.supported, 1);
  assert.equal(brief.total, 3);
  assert.equal(JSON.stringify(task), snapshot);
  assert.equal(brief.facts[0]!.text, "1000円");
});
test("human UX review requires explicit ratings and remains separate from answer correctness", async () => {
  const root = await mkdtemp(join(tmpdir(), "ux-feedback-")),
    store = new Store(root);
  try {
    const task = newTask({
      query: "書籍の確認",
      urls: ["https://books.rakuten.co.jp/rb/18577690/"],
      maxSteps: 10,
      maxPages: 3,
      timeoutSeconds: 30,
    });
    task.answer = {
      summary: "在庫未確認",
      candidates: [],
      limitations: ["在庫未確認"],
    };
    await store.save(task);
    const reviews = new UxFeedbackStore(store);
    const input = {
      exposureMs: 10000,
      understood: true,
      uncertaintyVisible: true,
      nextActionClear: true,
      appeal: 4,
      designVersion: "ten-second-v1" as const,
    };
    for (const invalid of [
      { ...input, appeal: 0 },
      { ...input, exposureMs: 100 },
      { ...input, understood: undefined },
    ])
      await assert.rejects(reviews.add(task.id, invalid as any));
    const result = await reviews.add(task.id, input);
    assert.equal(result.passed, true);
    assert.equal(result.scope, "self-reported-human-ux-review");
    assert.equal((await store.get(task.id)).answer!.summary, "在庫未確認");
    assert.equal((await reviews.get(task.id)).appeal, 4);
    const summary = await reviews.summary();
    assert.equal(summary.responses, 1);
    assert.equal(summary.observedResponseTargetsMet, false);
    assert.equal(
      summary.humanStudyStatus,
      "requires-verified-independent-reviewers",
    );
    await reviews.add(task.id, { ...input, appeal: 2 });
    assert.equal((await reviews.summary()).responses, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
