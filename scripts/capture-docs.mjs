/** Capture the real app using public recorded examples and an isolated temporary store. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createWorkbenchServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { RunService } from "../src/run-service.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";

const root = await mkdtemp(join(tmpdir(), "harness-public-docs-"));
const store = new Store(root);
// Model execution is unavailable in this capture process. Replay uses committed public evidence.
const rejectModel = async () => {
  throw Error("Documentation captures only support replay");
};
const runs = new RunService(store, rejectModel);
const server = createWorkbenchServer(
  new GoalEngine(new GoalRepository(join(root, "goals")), 1, rejectModel),
  store,
  runs,
);
const output = resolve("docs/screenshots");
await mkdir(output, { recursive: true });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const shots = [];
let browser;
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
  // 1240px uses the actual layout without the wide-screen execution-ID inspector.
  const page = await browser.newPage({
    viewport: { width: 1240, height: 960 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function capture(file, caption, kind = "ui") {
    await page.screenshot({
      path: join(output, file),
      type: "jpeg",
      quality: 78,
      animations: "disabled",
    });
    const bytes = await readFile(join(output, file));
    assert.ok(
      bytes.length < 250 * 1024,
      `${file} exceeds documentation image budget`,
    );
    shots.push({
      file,
      caption,
      kind,
      viewport: page.viewportSize(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await page.goto(base + "/chat");
  await page.locator("#chat-query").waitFor();
  await page.waitForFunction(
    () => document.querySelector("#chat-query").value.length > 0,
  );
  await capture(
    "chat-welcome.jpg",
    "相談内容・進め方・使うデータを選ぶ初期画面",
  );
  await page.locator("#send-chat").click();
  await page.locator(".gate-card").waitFor();
  await page
    .locator(".gate-card")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(
    "chat-approval.jpg",
    "調査前の方針選択。推奨案もクリックするまで承認されない",
  );
  const example = (
    await (await page.request.get(base + "/api/examples")).json()
  ).find((e) => e.id === "day-out");
  const response = await page.request.post(base + "/api/runs", {
    data: {
      query: example.query,
      urls: example.urls,
      source: "replay",
      example: "day-out",
      mode: "auto",
      agent: "codex",
    },
  });
  assert.ok(response.ok());
  const { id } = await response.json();
  await page.goto(base + "/chat?run=" + id);
  await page.locator(".journey-track").waitFor();
  await capture("chat-answer.jpg", "保存済み実測から構成した行程のフロー");
  await page
    .locator(".answer-candidates")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForFunction(
    () => {
      const image = document.querySelector(
        ".candidate-card:first-child .media-slot img",
      );
      return image?.complete && image.naturalWidth > 100;
    },
    {},
    { timeout: 30000 },
  );
  await capture(
    "chat-candidates.jpg",
    "候補・掲載画像・条件照合をまとめたカード",
  );
  await page.locator(".read-answer").click();
  await page.locator(".markdown-body").waitFor();
  await capture(
    "chat-markdown.jpg",
    "行程・予算・未確認事項・出典を読むMarkdownノート",
  );
  await page.locator("#answer-close").click();
  await page.locator("#artifact-jump").click();
  await page.locator(".artifact-open").first().click();
  await page.locator(".preview-photo").waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector(".preview-photo")?.naturalWidth > 100,
  );
  await capture(
    "chat-source-photo.jpg",
    "掲載元から表示用に取得した画像。本文の取得日時とは別",
    "public-source-image",
  );
  await page.getByRole("tab", { name: "Web画面", exact: true }).click();
  await page.locator(".web-screen").waitFor({ timeout: 70000 });
  await page.waitForFunction(
    () => document.querySelector(".web-screen")?.naturalWidth > 100,
  );
  await capture(
    "chat-source-screen.jpg",
    "agent-browserで実際に撮影したホットペッパーグルメの画面",
    "public-page-capture",
  );
  await page.locator("#artifact-close").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".journey-track").waitFor();
  await capture("chat-mobile.jpg", "390px幅での行程フローと入力欄の折り畳み");
  assert.deepEqual(errors, []);
  const totalBytes = shots.reduce((s, x) => s + x.bytes, 0);
  assert.ok(
    totalBytes < 1024 * 1024,
    "Documentation screenshots exceed 1 MiB total",
  );
  await writeFile(
    join(output, "chat-manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: "committed-public-evidence-replay",
        example: "day-out",
        modelInference: false,
        isolatedHistory: true,
        visualFetch:
          "public page images and browser screenshot fetched separately at capture time",
        notes:
          "Real app UI; no source-response mocking. Private histories and authentication are not loaded. Wide-screen execution-ID inspector is outside this viewport.",
        totalBytes,
        screenshots: shots,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ screenshots: shots.length, totalBytes, errors }, null, 2),
  );
} finally {
  await browser?.close();
  server.emit("shutdown");
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
