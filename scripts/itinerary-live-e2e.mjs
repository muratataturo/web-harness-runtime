// Account-bound, actual inference + public sources. No final-answer fixture is supplied to the model.
import { config } from "dotenv";
config({ quiet: true });
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { runTask } from "../dist/runtime.js";
import { Store } from "../dist/store.js";
import { assessSpecificity } from "../dist/answer-plan.js";
import { assessVisualArtifact } from "../dist/visual-artifact.js";
import { cafePlanIssues } from "../dist/cafe.js";
import { uncoveredCriteria } from "../dist/criteria.js";
import { assertEvidenceIntegrity } from "../dist/provenance.js";
import { copyAnswerMedia } from "../dist/answer-media.js";
import { exportPortableAnswer } from "./portable-answer.mjs";
import { createWorkbenchServer } from "../dist/server.js";
import { GoalEngine, GoalRepository } from "../dist/goals.js";
import { acceptanceRevision } from "./chat-acceptance.mjs";
import { diagnose } from "../dist/improvement.js";
import { itineraryCases } from "./itinerary-cases.mjs";
const args = process.argv.slice(2);
if (
  args[0] !== "--live" ||
  ![1, 3].includes(args.length) ||
  (args.length === 3 && args[1] !== "--case")
)
  throw Error("Use --live [--case ueno|hamamatsu|nagoya]");
const selected = itineraryCases[args[2] ?? "ueno"];
if (!selected) throw Error("Unknown itinerary case");
const output = `docs/${selected.output}.html`;
const root = resolve(
  selected.id === "ueno"
    ? ".runtime/autonomous-itinerary"
    : `.runtime/regional-itinerary/${selected.id}`,
);
const attempt = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(attempt, { recursive: true, mode: 0o700 });
const revision = await acceptanceRevision();
const receipt = {
  runtimeRevision: revision,
  caseId: selected.id,
  label: selected.label,
  inputSha256: createHash("sha256")
    .update(JSON.stringify({ query: selected.query, urls: selected.urls }))
    .digest("hex"),
  version: 1,
  mode: "live-unattended",
  startedAt: new Date().toISOString(),
  passed: false,
  answerEdited: false,
  humanResponses: 0,
};
await writeFile(
  join(root, "latest.json"),
  JSON.stringify({ attempt, ...receipt }, null, 2),
);
const store = new Store(join(attempt, "store"));
const task = await runTask(
  {
    agent: "codex",
    model: process.env.ITINERARY_MODEL ?? "gpt-6.1-sol",
    interactionMode: "auto",
    query: selected.query,
    urls: selected.urls,
    maxSteps: selected.id === "hamamatsu-full" ? 300 : 240,
    maxPages: 36,
    timeoutSeconds: 1200,
    deepenRounds: 3,
    onProgress: (m) => {
      if (!m.startsWith("\u001e")) process.stderr.write(m + "\n");
    },
  },
  store,
);
Object.assign(receipt, {
  taskId: task.id,
  status: task.status,
  error: task.error,
  model: task.model,
  tripBrief: task.tripBrief,
  stepVerification: task.stepVerification,
  steps: task.steps,
  elapsedMs: task.metrics?.elapsedMs,
  store: store.root,
});
try {
  assert.equal(
    task.authorship,
    undefined,
    "the generated answer must not be a final edit",
  );
  assert.equal(
    task.evaluation,
    undefined,
    "live generation must not be frozen replay",
  );
  assert.equal(
    await acceptanceRevision(),
    revision,
    "runtime changed during live acceptance; rerun the current build",
  );
  assert.equal(task.status, "succeeded");
  assert.ok(task.answer);
  assert.equal(assessSpecificity(task, task.answer).status, "passed");
  assert.equal(assessVisualArtifact(task, task.answer).status, "passed");
  assert.deepEqual(cafePlanIssues(task, task.answer), []);
  assert.deepEqual(
    uncoveredCriteria(task.criteria, task.answer.candidates),
    [],
  );
  assert.ok(
    task.answer.candidates.length >= (selected.minimumCandidates ?? 3) &&
      task.answer.candidates.every((c) => c.eligible),
  );
  for (const e of task.evidence) assertEvidenceIntegrity(task, e.id);
  const plan = task.answer.actionPlan;
  if (task.tripBrief?.requiresStepResearch)
    assert.equal(task.stepVerification?.ready, true);
  assert.ok(plan.budget.items.every((i) => i.basis === "published"));
  assert.ok(plan.budget.totalYen <= (selected.budgetCap ?? 10000));
  if (!task.tripBrief?.requiresStepResearch) {
    assert.equal(
      plan.verification.checks.find((c) => c.kind === "seating").status,
      "arrival-check",
    );
    assert.equal(plan.verification.date, "2026-11-21");
  }
  const diagnosis = diagnose(
    task,
    task.criteria,
    task.answer.candidates.map((c) => c.url),
    false,
    selected.minimumCandidates ?? 3,
  );
  assert.equal(diagnosis.complete, true);
  const engine = new GoalEngine(
    new GoalRepository(join(store.root, "goals")),
    1,
  );
  const server = createWorkbenchServer(engine, store);
  let browser;
  try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/chromium",
      ].find(existsSync),
    });
    receipt.browser = [];
    for (const width of [320, 390, 768, 1280]) {
      const page = await browser.newPage({
        viewport: { width, height: 950 },
        colorScheme: "dark",
        reducedMotion: "reduce",
      });
      await page.route("https://**", (r) => r.abort());
      const response = await page.goto(
        `${base}/api/tasks/${task.id}/answer.html`,
      );
      assert.equal(response.status(), 200);
      if (!task.tripBrief?.requiresStepResearch) {
        assert.equal(await page.locator(".hero-tags .verified").count(), 1);
        assert.ok(
          (await page.locator("#candidate-comparison tbody tr").count()) >= 3,
        );
        assert.equal(await page.locator("#verification .branch").count(), 5);
      } else {
        assert.equal(await page.locator("#day-rhythm").count(), 1);
      }
      const photos = page.locator(".experience-card img");
      assert.ok((await photos.count()) >= 2);
      for (const img of await photos.all()) {
        await img.scrollIntoViewIfNeeded();
        await img.evaluate((i) => i.decode());
      }
      await page
        .locator(
          task.tripBrief?.requiresStepResearch
            ? '#day-rhythm a[href^="#step-"]'
            : '#verification a[href^="#step-"]',
        )
        .first()
        .click();
      assert.equal(await page.locator(".journey-story[open]").count(), 1);
      assert.equal(
        await page.locator(".journey-moment").count(),
        plan.steps.length,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      await page.locator(".experience-card").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(attempt, `cafe-${width}.png`) });
      receipt.browser.push({
        width,
        httpStatus: 200,
        photosDecoded: await photos.count(),
        allSteps: plan.steps.length,
        noOverflow: true,
      });
      await page.close();
    }
  } finally {
    await browser?.close();
    engine.shutdown();
    await new Promise((r) => server.close(r));
  }
  Object.assign(receipt, {
    passed: true,
    criteria: task.criteria,
    evidenceCount: task.evidence.length,
    pages: task.pages.map((p) => ({
      url: p.url,
      capturedAt: p.capturedAt,
      kind: p.acquisition?.kind,
    })),
    specificity: task.specificity,
    visualReview: task.visualReview,
    improvementDiagnosis: diagnosis,
    budget: plan.budget,
    verification: plan.verification,
  });
  // Export only after acceptance; never modify model fields to make the acceptance pass.
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
    caseId: `${selected.id}-e2e-display`,
    fixtureSha256: createHash("sha256")
      .update(JSON.stringify(snapshot.pages))
      .digest("hex"),
  };
  snapshot.snapshotNote = `無人の実モデル出力を変更せず保存。原文は引用のみ残した表示再生用スナップショット。ライブ生成の検証は${selected.receipt}.jsonを参照。`;
  await copyAnswerMedia(task, store.dir(task.id), output);
  await exportPortableAnswer(snapshot, output);
  await writeFile(
    `examples/${selected.snapshot}.json`,
    JSON.stringify(snapshot, null, 2) + "\n",
  );
} catch (error) {
  receipt.failure = error.message;
  process.exitCode = 1;
}
receipt.finishedAt = new Date().toISOString();
const events = (
  await readFile(join(store.dir(task.id), "events.jsonl"), "utf8")
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
receipt.events = events.map((e) => ({
  at: e.at,
  type: e.type,
  ...([
    "tool_error",
    "finalization_continuation",
    "specificity_revision",
    "visual_revision",
    "step_verification",
    "step_deepresearch",
  ].includes(e.type)
    ? {
        data:
          e.type === "step_deepresearch"
            ? {
                stepIds: e.data.stepIds,
                pagesOpened: e.data.pagesOpened,
                rounds: e.data.rounds,
                additionalCount: e.data.additional.length,
              }
            : e.data,
      }
    : {}),
}));
await writeFile(join(attempt, "report.json"), JSON.stringify(receipt, null, 2));
await writeFile(
  join(root, "latest.json"),
  JSON.stringify({ attempt, ...receipt }, null, 2),
);
if (receipt.passed) {
  const publicReceipt = structuredClone(receipt);
  delete publicReceipt.store;
  await writeFile(
    `docs/evidence/${selected.receipt}.json`,
    JSON.stringify(publicReceipt, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    attempt,
    taskId: task.id,
    status: task.status,
    passed: receipt.passed,
    failure: receipt.failure,
  }),
);
