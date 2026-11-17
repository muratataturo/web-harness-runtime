// Package a saved live run without editing its answer or changing its factual verdict.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Store } from "../dist/store.js";
import { copyAnswerMedia } from "../dist/answer-media.js";
import { assessSpecificity } from "../dist/answer-plan.js";
import { assessVisualArtifact } from "../dist/visual-artifact.js";
import { cafePlanIssues } from "../dist/cafe.js";
import { assertEvidenceIntegrity } from "../dist/provenance.js";
import { diagnose } from "../dist/improvement.js";
import { exportPortableAnswer } from "./portable-answer.mjs";
import { itineraryCases } from "./itinerary-cases.mjs";
const id = process.argv[2];
const c = itineraryCases[id];
if (!c || id === "ueno" || process.argv.length !== 3)
  throw Error("Use hamamatsu or nagoya");
const run = JSON.parse(
  await readFile(`.runtime/regional-itinerary/${id}/latest.json`, "utf8"),
);
assert.equal(run.mode, "live-unattended");
assert.equal(run.answerEdited, false);
const store = new Store(run.store);
const task = await store.get(run.taskId);
assert.equal(task.authorship, undefined);
assert.equal(task.evaluation, undefined);
assert.ok(task.answer);
assert.ok(["succeeded", "partial"].includes(task.status));
for (const e of task.evidence) assertEvidenceIntegrity(task, e.id);
assert.equal(assessSpecificity(task, task.answer).status, "passed");
assert.equal(assessVisualArtifact(task, task.answer).status, "passed");
assert.deepEqual(cafePlanIssues(task, task.answer), []);
const answerSha256 = createHash("sha256")
  .update(JSON.stringify(task.answer))
  .digest("hex");
const snapshot = structuredClone(task);
snapshot.pages = snapshot.pages.map((p) => ({
  ...p,
  text: [
    p.title,
    ...snapshot.evidence.filter((e) => e.pageId === p.id).map((e) => e.quote),
  ].join("\n\n"),
  links: [],
}));
snapshot.evaluation = {
  mode: "frozen-replay",
  caseId: `${id}-e2e-display`,
  fixtureSha256: createHash("sha256")
    .update(JSON.stringify(snapshot.pages))
    .digest("hex"),
};
snapshot.snapshotNote = `無編集のライブ生成回答。${task.status === "partial" ? "未確認を残したpartialをそのまま公開。" : "正式判定を通過。"}表示再生のため本文は引用のみ。ライブ記録は${c.receipt}.json。`;
assert.equal(
  createHash("sha256").update(JSON.stringify(snapshot.answer)).digest("hex"),
  answerSha256,
);
await copyAnswerMedia(task, store.dir(task.id), `docs/${c.output}.html`);
await exportPortableAnswer(snapshot, `docs/${c.output}.html`);
await writeFile(
  `examples/${c.snapshot}.json`,
  JSON.stringify(snapshot, null, 2) + "\n",
);
const { store: privateStore, attempt: privateAttempt, ...receipt } = run;
Object.assign(receipt, {
  criteria: task.criteria,
  evidenceCount: task.evidence.length,
  pages: task.pages.map((p) => ({
    url: p.url,
    capturedAt: p.capturedAt,
    kind: p.acquisition?.kind,
  })),
  specificity: task.specificity,
  visualReview: task.visualReview,
  budget: task.answer.actionPlan.budget,
  verification: task.answer.actionPlan.verification,
  improvementDiagnosis: diagnose(
    task,
    task.criteria,
    task.answer.candidates.map((c) => c.url),
    false,
    3,
  ),
  publication: {
    source: "saved-live-run",
    answerEdited: false,
    answerSha256,
    taskStatusPreserved: true,
    originalStrictVerdictPreserved: true,
  },
});
await writeFile(
  `docs/evidence/${c.receipt}.json`,
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    caseId: id,
    status: task.status,
    strictLivePassed: run.passed,
    answerEdited: false,
    steps: task.answer.actionPlan.steps.length,
    candidates: task.answer.candidates.length,
    totalYen: task.answer.actionPlan.budget.totalYen,
  }),
);
