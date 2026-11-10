import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbenchServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { RunService } from "../src/run-service.js";
import { newTask } from "../src/runtime.js";
import { pageArtifact } from "../src/artifacts.js";
import { progressPrefix, researchProgress } from "../src/progress.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";
const root = await mkdtemp(join(tmpdir(), "harness-chat-ui-"));
const store = new Store(root);
let finishStream;
const streamGate = new Promise((r) => (finishStream = r));
const runs = new RunService(store, async (o) => {
  const t = newTask(o);
  const p = {
    id: "page-1",
    url: o.urls[0],
    title: "進捗テスト <script>window.bad = true</script>",
    text: "進捗テスト用の本文。書籍の税込価格は1,430円。".repeat(30),
    capturedAt: new Date().toISOString(),
    acquisition: { kind: "public-html", status: 200 },
    links: [],
    truncated: false,
  };
  t.pages.push(p);
  const event =
    progressPrefix +
    JSON.stringify(
      researchProgress("open_page", "done", {
        url: p.url,
        artifact: pageArtifact(t, p),
        pages: 1,
        evidence: 0,
      }),
    ) +
    "\n";
  o.onProgress?.(event.slice(0, 11));
  o.onProgress?.(event.slice(11));
  await streamGate;
  t.status = "partial";
  t.answer = {
    summary: "進捗テスト完了",
    candidates: [],
    limitations: ["ブラウザ統合テスト用の結果"],
  };
  await store.save(t);
  return t;
});
const server = createWorkbenchServer(
  new GoalEngine(new GoalRepository(join(root, "goals")), 1),
  store,
  runs,
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
  await page.getByRole("button", { name: "Rakuten", exact: true }).click();
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
  await page.getByRole("button", { name: "Recruit", exact: true }).click();
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
  assert.ok((await page.locator(".artifact-card").count()) > 0);
  await page.locator("#artifact-jump").click();
  const original = await page
    .locator(".artifact-card a")
    .first()
    .getAttribute("href");
  assert.match(original, /^https:\/\//);
  await page.locator(".artifact-open").first().click();
  await page.locator(".artifact-preview-body").waitFor();
  assert.ok(
    (await page.locator(".artifact-preview-body").textContent()).length > 10,
  );
  assert.equal(
    await page.locator(".artifact-external").getAttribute("href"),
    original,
  );
  await page.screenshot({ path: join(artifacts, "artifact-preview.png") });
  await page.locator("#artifact-close").click();
  checks.push(
    "Actual fetched URL cards open a saved text preview and original source link",
  );
  for (const width of [320, 360, 390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `overflow at ${width}px`,
    );
    await page.locator(".artifact-open").first().click();
    await page.locator(".artifact-preview-body").waitFor();
    const box = await page.locator("#artifact-dialog").boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= width + 1,
      `preview at ${width}px`,
    );
    await page.locator("#artifact-close").click();
  }
  checks.push(
    "Answer, source cards and preview dialog fit seven viewport widths from 320 to 1440px",
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "/chat");
  const live = await page.request.post(base + "/api/runs", {
    data: {
      query: "進捗テスト",
      urls: ["https://books.rakuten.co.jp/rb/18577690/"],
      source: "live",
      mode: "auto",
      confirmLive: true,
    },
  });
  assert.ok(live.ok());
  const { id } = await live.json();
  await page.goto(base + "/chat?run=" + id);
  await page.getByText("● LIVE", { exact: true }).waitFor();
  await page.locator(".artifact-open").waitFor();
  assert.equal(await page.locator(".answer").count(), 0);
  await page.screenshot({ path: join(artifacts, "stream-artifact.png") });
  await page.locator(".artifact-open").click();
  await page.locator(".artifact-preview-body").waitFor();
  assert.ok(
    (await page.locator("#artifact-content h2").textContent()).includes(
      "<script>",
    ),
  );
  assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.locator("#artifact-close").click();
  finishStream();
  await page.locator(".answer").waitFor();
  await page.locator(".artifact-open").click();
  await page.locator(".artifact-preview-body").waitFor();
  assert.ok(
    (await page.locator(".artifact-preview-body").textContent()).length > 420,
  );
  await page.locator("#artifact-close").click();
  checks.push(
    "Live progress: SSE delivers preview before answer; final preview shows stored body; source markup stays text",
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
  finishStream();
  await browser?.close();
  server.emit("shutdown");
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
