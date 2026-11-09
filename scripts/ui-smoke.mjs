import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const root = await mkdtemp(join(tmpdir(), "relay-ui-"));
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
