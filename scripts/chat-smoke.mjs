import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbenchServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";
const root = await mkdtemp(join(tmpdir(), "harness-chat-ui-"));
const server = createWorkbenchServer(
  new GoalEngine(new GoalRepository(join(root, "goals")), 1),
  new Store(root),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const artifacts = resolve(".runtime/chat-qa");
await mkdir(artifacts, { recursive: true });
let browser;
const checks = [];
try {
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/chat");
  await page.getByText("つぎの、", { exact: false }).first().waitFor();
  await page.locator("#chat-query").waitFor();
  await page.waitForFunction(
    () => document.querySelector("#chat-query").value.length > 0,
  );
  await page.screenshot({ path: join(artifacts, "recruit-welcome.png") });
  checks.push("Recruit desktop welcome, sample query and source disclosure");
  await page
    .getByRole("button", { name: "Rakuten style", exact: true })
    .click();
  assert.equal(
    await page.locator("body").getAttribute("data-brand"),
    "rakuten",
  );
  await page.reload();
  assert.equal(
    await page.locator("body").getAttribute("data-brand"),
    "rakuten",
  );
  await page.screenshot({ path: join(artifacts, "rakuten-welcome.png") });
  checks.push("Rakuten theme persists after reload");
  await page
    .getByRole("button", { name: "Recruit style", exact: true })
    .click();
  await page.locator("#send-chat").click();
  await page.locator(".gate-card").waitFor();
  assert.equal(await page.locator(".answer").count(), 0);
  const before = await page.request.get(base + "/api/runs");
  const first = (await before.json())[0];
  assert.equal(first.status, "needs_input");
  assert.equal(first.task, undefined);
  checks.push(
    "Approval waits before any lookup; recommended choice is not auto-submitted",
  );
  await page.locator(".gate-confirm").click();
  await page.locator(".answer").waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".gate-card h2")?.textContent.includes("未確認"),
  );
  await page.screenshot({ path: join(artifacts, "approval-answer.png") });
  await page.reload();
  await page.locator(".gate-card").waitFor();
  await page.locator(".gate-confirm").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".message.system")
      ?.textContent.includes("未確認を明記した提案"),
  );
  assert.equal(await page.locator(".gate-card").count(), 0);
  checks.push(
    "Approval result gate + durable reload + accept partial without fabricated success",
  );
  await page.locator("#new-chat").click();
  await page.waitForFunction(
    () => document.querySelector("#chat-query").value.length > 0,
  );
  await page.locator("#chat-mode").selectOption("auto");
  await page.locator("#send-chat").click();
  await page.locator(".answer").waitFor();
  assert.equal(await page.locator(".gate-card").count(), 0);
  assert.ok(
    (await page.locator(".decision-receipt").textContent()).includes("Auto"),
  );
  await page.reload();
  await page.locator(".answer").waitFor();
  assert.equal(await page.locator(".gate-card").count(), 0);
  checks.push(
    "Auto makes a visible runtime decision, no input gates, saved answer restored",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "auto-mobile.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#mobile-nav").click();
  assert.equal(
    await page.locator(".rail").evaluate((e) => e.classList.contains("open")),
    true,
  );
  checks.push(
    "390px mobile: no horizontal overflow, navigation and saved answer usable",
  );
  assert.deepEqual(errors, []);
  checks.push("No browser JavaScript errors");
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify({ passed: checks.length, checks, artifacts }, null, 2),
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, artifacts }, null, 2),
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
