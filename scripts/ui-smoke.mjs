import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { newTask } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { improveTask } from "../src/improvement.js";
const root = await mkdtemp(join(tmpdir(), "relay-ui-"));
const taskStore = new Store(root);
const pendingTask = newTask({
  query: "UI検証用：容量40Lを確認（架空資料）",
  urls: ["https://item.rakuten.co.jp/ui-fixture/bag/"],
  agent: "codex",
  maxSteps: 10,
  maxPages: 2,
  timeoutSeconds: 10,
});
pendingTask.status = "partial";
pendingTask.criteria = [
  { id: "capacity", description: "容量40L", required: true, weight: 5 },
];
pendingTask.answer = {
  summary: "容量が未確認のため確定できません（UIテスト資料）",
  candidates: [
    {
      name: "検証用バッグ",
      url: pendingTask.urls[0],
      matches: [
        {
          criterionId: "capacity",
          status: "unknown",
          explanation: "記載なし",
          evidenceIds: [],
        },
      ],
      score: 0,
      eligible: false,
    },
  ],
  limitations: ["架空のUI検証資料"],
};
await taskStore.save(pendingTask);
const pendingLoop = await improveTask(
  pendingTask.id,
  { diagnoseOnly: true, interactionMode: "approval" },
  taskStore,
  async () => {
    throw new Error("UI test must not invoke a model");
  },
);
const artifacts = resolve(".runtime/ui-qa");
await mkdir(artifacts, { recursive: true });
const port = Number(process.env.UI_TEST_PORT ?? 4311),
  base = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "web", "--port", String(port)],
  {
    env: {
      ...process.env,
      RUNTIME_DIR: root,
      OPENROUTER_API_KEY: "",
      RUNTIME_EXECUTOR: "local",
      RUNTIME_AGENT: "codex",
      CODEX_BIN: join(root, "not-installed-codex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + "/api/config")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(150);
  }
  if (!ready) throw new Error("Webサーバーを起動できませんでした: " + output);
  const executable =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executable ? { executablePath: executable } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 982 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("heading", { name: /かなえたいことを/ }).waitFor();
  await page.screenshot({
    path: join(artifacts, "01-welcome-desktop.png"),
    fullPage: true,
  });
  checks.push("desktop welcome");
  await page.getByRole("button", { name: /余白のある、2泊3日の旅/ }).click();
  await page
    .getByRole("heading", { name: "今回の旅で、いちばん大切にしたいのは？" })
    .waitFor();
  const goalId = await page.evaluate(() => localStorage.getItem("relay.goal"));
  const before = await (await fetch(base + "/api/goals/" + goalId)).json();
  assert.equal(before.tasks.length, 0);
  await page.getByRole("radio", { name: /温泉と、何もしない時間/ }).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.getByRole("radio", { name: /おいしい発見を/ }).isChecked(),
    true,
  );
  await page
    .getByRole("textbox", { name: "追加のこだわり" })
    .fill("たくさん歩かず、食事をゆっくり楽しみたい");
  await page.getByRole("spinbutton", { name: "予算" }).fill("90000");
  await page.screenshot({
    path: join(artifacts, "02-travel-approval.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /この方針で調べる/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "チームの作業" }).click();
  await page.screenshot({
    path: join(artifacts, "03-parallel-tasks.png"),
    fullPage: true,
  });
  await page
    .getByRole("heading", { name: "ひとつだけ、旅のご褒美を選ぶなら？" })
    .waitFor({ timeout: 25000 });
  await page.getByRole("radio", { name: /忘れられない夕食を一度/ }).check();
  await page.getByRole("button", { name: /この案でプランを整える/ }).click();
  await page
    .getByText("あなたらしいプランの、たたき台ができました", { exact: false })
    .waitFor({ timeout: 15000 });
  await page.getByRole("tab", { name: /^プラン/ }).click();
  await page.getByRole("tab", { name: "2日目", exact: true }).click();
  await page
    .getByRole("heading", { name: "今日の主役は、特別な夕食" })
    .waitFor();
  assert.ok(
    (await page.locator("#computer-content").innerText()).includes(
      "たくさん歩かず",
    ),
  );
  const completed = await (await fetch(base + "/api/goals/" + goalId)).json();
  assert.equal(completed.budget, 90000);
  assert.equal(completed.direction, "food");
  assert.equal(completed.delight, "dinner");
  assert.ok(completed.tasks.some((t) => t.round === 2));
  assert.ok(completed.messages.some((m) => m.kind === "review"));
  checks.push(
    "travel: keyboard approval, direction, note, budget, parallel jobs, review, rework, delight, plan",
  );
  await page.screenshot({
    path: join(artifacts, "04-travel-plan.png"),
    fullPage: true,
  });
  await page.reload();
  await page
    .getByText("あなたらしいプランの、たたき台ができました", { exact: false })
    .waitFor();
  checks.push("reload restores decisions and plan");
  await page.locator("#new-thread").click();
  await page.getByRole("button", { name: /暮らしを考える/ }).click();
  await page
    .getByRole("heading", {
      name: "新しい暮らしで、いちばん大切にしたいのは？",
    })
    .waitFor();
  await page.getByRole("radio", { name: /自然のそばで/ }).check();
  await page.getByRole("button", { name: /この方針で調べる/ }).click();
  await page
    .getByRole("heading", { name: "次の一歩は、どこから始めましょう？" })
    .waitFor({ timeout: 25000 });
  await page.getByRole("radio", { name: /街の空気を、歩いて/ }).check();
  await page.getByRole("button", { name: /この案でプランを整える/ }).click();
  await page
    .getByText("あなたらしいプランの、たたき台ができました", { exact: false })
    .waitFor({ timeout: 15000 });
  await page.getByRole("tab", { name: /^プラン/ }).click();
  await page.getByRole("tab", { name: "住まい", exact: true }).click();
  await page
    .getByRole("heading", { name: "藤沢の街を、休日に歩いてみる" })
    .waitFor();
  await page.screenshot({
    path: join(artifacts, "05-life-plan.png"),
    fullPage: true,
  });
  checks.push("life: dependent mobility, review, next-step choice, plan");
  await page
    .getByRole("button", { name: "方針を見直す", exact: true })
    .first()
    .click();
  await page
    .getByRole("heading", {
      name: "新しい暮らしで、いちばん大切にしたいのは？",
    })
    .waitFor();
  assert.ok((await page.locator("#thread").innerText()).includes("v2"));
  checks.push("revision expires old choices");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page
    .getByText("チームの作業を停止しました。履歴は残っています。")
    .waitFor();
  checks.push("stop button cancels task");
  await context.close();
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const mobile = await mobileContext.newPage();
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(base);
  await mobile.getByRole("button", { name: /余白のある、2泊3日の旅/ }).click();
  await mobile
    .getByRole("heading", { name: "今回の旅で、いちばん大切にしたいのは？" })
    .waitFor();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await mobile.screenshot({
    path: join(artifacts, "06-mobile-approval.png"),
    fullPage: true,
  });
  await mobile.getByRole("radio", { name: /温泉と、何もしない時間/ }).check();
  await mobile.getByRole("button", { name: /この方針で調べる/ }).click();
  await mobile
    .getByRole("heading", { name: "ひとつだけ、旅のご褒美を選ぶなら？" })
    .waitFor({ timeout: 25000 });
  await mobile.getByRole("radio", { name: /露天風呂を、ふたりの時間/ }).check();
  await mobile.getByRole("button", { name: /この案でプランを整える/ }).click();
  await mobile
    .getByRole("button", { name: /プランを見てみる/ })
    .waitFor({ timeout: 15000 });
  await mobile.getByRole("button", { name: /プランを見てみる/ }).click();
  await mobile
    .getByRole("heading", { name: "ふたりだけの、貸切露天風呂" })
    .waitFor();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await mobile.screenshot({
    path: join(artifacts, "07-mobile-plan.png"),
    fullPage: true,
  });
  checks.push("390px mobile: approvals, final plan, no horizontal overflow");
  const autoContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  const autoPage = await autoContext.newPage();
  autoPage.on("pageerror", (error) => errors.push(error.message));
  await autoPage.goto(base);
  await autoPage.getByLabel("進め方", { exact: true }).selectOption("auto");
  await autoPage
    .getByRole("button", { name: /余白のある、2泊3日の旅/ })
    .click();
  await autoPage
    .getByText("あなたらしいプランの、たたき台ができました", { exact: false })
    .waitFor({ timeout: 25000 });
  assert.equal(await autoPage.locator(".approval-card").count(), 0);
  assert.equal(await autoPage.getByText(/Autoで自動選択/).count(), 2);
  const autoId = await autoPage.evaluate(() =>
    localStorage.getItem("relay.goal"),
  );
  const autoGoal = await (await fetch(base + "/api/goals/" + autoId)).json();
  assert.equal(autoGoal.interactionMode, "auto");
  assert.ok(
    autoGoal.gates.every(
      (g) => g.status === "approved" && g.decidedBy === "runtime",
    ),
  );
  await autoPage.reload();
  await autoPage
    .getByText("あなたらしいプランの、たたき台ができました", { exact: false })
    .waitFor();
  assert.equal(await autoPage.locator(".approval-card").count(), 0);
  await autoPage.screenshot({
    path: join(artifacts, "08-auto-mobile.png"),
    fullPage: true,
  });
  checks.push(
    "Auto: no pending gates, runtime decision receipts, reload persistence on mobile",
  );
  await autoPage.locator("#mobile-menu").click();
  await autoPage.getByRole("button", { name: "調査の確認待ち ↗" }).click();
  const inbox = autoPage.locator("#runtime-approvals-dialog");
  await inbox
    .getByRole("heading", { name: "確認できた候補で進めますか？" })
    .waitFor();
  assert.equal(
    await inbox
      .getByRole("radio", { name: /未確認事項を明記して/ })
      .isChecked(),
    true,
  );
  await inbox.getByRole("radio", { name: /公式の詳細URLを追加して/ }).check();
  await inbox.getByRole("textbox", { name: "追加の公開詳細URL" }).waitFor();
  await inbox.getByRole("radio", { name: /未確認事項を明記して/ }).check();
  assert.equal(
    await inbox.getByRole("textbox", { name: "追加の公開詳細URL" }).count(),
    0,
  );
  await autoPage.screenshot({
    path: join(artifacts, "09-runtime-approval-mobile.png"),
    fullPage: true,
  });
  await inbox.getByRole("button", { name: /選んで続ける/ }).click();
  await inbox.getByRole("heading", { name: "選択を保存しました" }).waitFor();
  await inbox.getByText(/容量が未確認のため/).waitFor();
  const decided = (await (await fetch(base + "/api/improvements")).json()).find(
    (l) => l.id === pendingLoop.id,
  );
  assert.equal(decided.status, "completed_partial");
  assert.equal(decided.best.complete, false);
  checks.push(
    "Approval inbox: recommended choice, tradeoff, durable decision, partial answer without fabricated completion",
  );
  await inbox.getByRole("button", { name: "確認待ちを更新" }).click();
  await autoPage
    .getByText("現在、選択待ちの調査はありません。Autoは承認待ちを作りません。")
    .waitFor();
  checks.push("runtime approvals inbox: no pending state");
  await autoContext.close();
  assert.deepEqual(errors, []);
  checks.push("no browser JavaScript errors");
  await mobileContext.close();
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        errors,
        apiCalls: "none (OPENROUTER_API_KEY disabled)",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, artifacts }, null, 2),
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  await rm(root, { recursive: true, force: true });
}
