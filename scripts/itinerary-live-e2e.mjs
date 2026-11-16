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
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--live")
  throw Error(
    "Use --live: this command invokes the logged-in model and public sources",
  );
const root = resolve(".runtime/autonomous-itinerary");
const attempt = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(attempt, { recursive: true, mode: 0o700 });
const revision = await acceptanceRevision();
const receipt = {
  runtimeRevision: revision,
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
    query:
      "2026年11月21日（土）に大人2人で上野を10:00〜15:00、一日遊ぶカフェ旅行を正式な実行プランにしてください。現地の入園・飲食は2人合計10000円以内で交通費は除きます。主案は上野動物園とEVERYONEs CAFE。カフェでは80分ほど過ごし、各自1皿の甘味と1杯の飲物を注文して軽い昼食にします。共有や未確認のセット割に依存せず、定番の掲載商品価格から予算を作ってください。営業時間、対象日の開園予定、主案の価格、カフェの利用方式、候補比較、休憩所の名称・所在地・時間を公式資料で確認し、写真付きの体験と地図をHTMLで見られる回答にしてください。休憩20分、徒歩移動、入店待ちも独立した手順にし、時間の重複と10分を超える空白を作らないでください。満席で20分待っても入れない場合はスターバックス上野恩賜公園店へ切り替える手順を含めてください。代替店の商品単価が未掲載なら店頭で確認して2人3000円以内で注文する条件付き代替案にし、主案の掲載価格とは分けて比較してください。未来の空席や予約完了は断定せず、公式の利用方式を確認した上で席だけを当日判断とします。税区分が書かれていない資料は掲載額と税区分未記載を明示してください。写真は実画像を確認し、注文品の写真がなければ同じ店舗の外観や店内を使えます。SNS調査は不要です。",
    urls: [
      "https://www.tokyo-zoo.net/ueno/visitor-info/tickets/",
      "https://www.tokyo-zoo.net/ueno/shops/foodshop/index.html",
      "https://www.tokyo-zoo.net/file/calendar_2026_ueno.pdf",
      "https://shop.create-restaurants.co.jp/0941/",
      "https://store.starbucks.co.jp/detail-1087/",
      "https://nominatim.openstreetmap.org/",
    ],
    maxSteps: 200,
    maxPages: 24,
    timeoutSeconds: 1200,
    deepenRounds: 1,
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
    task.answer.candidates.length >= 3 &&
      task.answer.candidates.every((c) => c.eligible),
  );
  for (const e of task.evidence) assertEvidenceIntegrity(task, e.id);
  const plan = task.answer.actionPlan;
  assert.ok(plan.budget.items.every((i) => i.basis === "published"));
  assert.ok(plan.budget.totalYen <= 10000);
  assert.equal(
    plan.verification.checks.find((c) => c.kind === "seating").status,
    "arrival-check",
  );
  assert.equal(plan.verification.date, "2026-11-21");
  const diagnosis = diagnose(
    task,
    task.criteria,
    task.answer.candidates.map((c) => c.url),
    false,
    3,
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
      assert.equal(await page.locator(".hero-tags .verified").count(), 1);
      assert.ok(
        (await page.locator("#candidate-comparison tbody tr").count()) >= 3,
      );
      assert.equal(await page.locator("#verification .branch").count(), 5);
      const photos = page.locator(".experience-card img");
      assert.ok((await photos.count()) >= 2);
      for (const img of await photos.all()) {
        await img.scrollIntoViewIfNeeded();
        await img.evaluate((i) => i.decode());
      }
      await page.locator('#verification a[href^="#step-"]').first().click();
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
    caseId: "autonomous-cafe-e2e-display",
    fixtureSha256: createHash("sha256")
      .update(JSON.stringify(snapshot.pages))
      .digest("hex"),
  };
  snapshot.snapshotNote =
    "無人の実モデル出力を変更せず保存。原文は引用のみ残した表示再生用スナップショット。ライブ生成の検証はautonomous-itinerary-e2e.jsonを参照。";
  await copyAnswerMedia(
    task,
    store.dir(task.id),
    "docs/autonomous-cafe-day.html",
  );
  await exportPortableAnswer(snapshot, "docs/autonomous-cafe-day.html");
  await writeFile(
    "examples/visual-autonomous-cafe-answer.json",
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
  ].includes(e.type)
    ? { data: e.data }
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
    "docs/evidence/autonomous-itinerary-e2e.json",
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
