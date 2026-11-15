import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { Store } from "../src/store.js";
import { RunService } from "../src/run-service.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";
import { createWorkbenchServer } from "../src/server.js";
import { pageArtifact } from "../src/artifacts.js";
import { renderAnswer } from "../src/evidence.js";
const { values } = parseArgs({
  options: {
    task: { type: "string" },
    "before-web": { type: "string" },
    out: { type: "string", default: ".runtime/ux-loop" },
  },
});
if (!values.task)
  throw new Error("--task SAVED_LIVE_TASK_JSON [--before-web DIR] [--out DIR]");
const raw = JSON.parse(await readFile(values.task, "utf8")),
  task = raw.task ?? raw;
if (!task.answer || task.evaluation)
  throw new Error("保存された実生成の回答が必要です");
const contract = JSON.parse(await readFile("config/ux-quality.json", "utf8"));
const output = resolve(values.out),
  root = await mkdtemp(join(tmpdir(), "ux-loop-")),
  store = new Store(root);
await mkdir(output, { recursive: true });
await store.save(structuredClone(task));
const id = randomUUID();
await mkdir(join(root, "runs"), { recursive: true });
const record = {
  id,
  revision: 1,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  status: task.status === "succeeded" ? "succeeded" : "completed_partial",
  input: {
    query: task.query,
    urls: task.urls,
    mode: "auto",
    source: "live",
    agent: task.agent,
  },
  target: task.execution?.target ?? "local",
  phase: "保存された実生成回答",
  decisions: [],
  progress: [],
  taskId: task.id,
  task,
  reviewWarnings: [],
  artifacts: task.pages.map((p, i) => pageArtifact(task, p, i)),
};
await writeFile(join(root, "runs", id + ".json"), JSON.stringify(record));
const noInference = async () => {
  throw new Error(
    "UX loop only renders a captured live answer; it never starts inference",
  );
};
const runs = new RunService(store, noInference),
  server = createWorkbenchServer(
    new GoalEngine(new GoalRepository(join(root, "goals")), 1, noInference),
    store,
    runs,
  );
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = {
  schemaVersion: 1,
  designVersion: contract.designVersion,
  taskId: task.id,
  model: task.model,
  renderSource: "saved-live-generated-answer",
  generatedAt: new Date().toISOString(),
  humanAssessment: "pending; no human ratings synthesized",
  contract,
  variants: [],
  passed: false,
};
try {
  const executable =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executable ? { executablePath: executable } : {}),
  });
  for (const variant of values["before-web"]
    ? ["before", "after"]
    : ["after"]) {
    const page = await browser.newPage({
        viewport: { width: 1240, height: 960 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // No fabricated imagery, no additional source traffic during screenshot QA.
    await page.route("**/artifacts/*/visual", (route) =>
      route.fulfill({
        json: {
          images: [],
          capturedAt: task.updatedAt,
          note: "Imagery omitted for deterministic UI inspection",
        },
      }),
    );
    if (variant === "before")
      for (const file of [
        "chat.html",
        "chat.js",
        "chat.css",
        "presentation.js",
      ]) {
        const path = file === "chat.html" ? "chat" : file;
        await page.route(base + "/" + path, async (route) =>
          route.fulfill({
            body: await readFile(join(values["before-web"], file)),
            contentType: file.endsWith("css")
              ? "text/css"
              : file.endsWith("js")
                ? "text/javascript"
                : "text/html",
          }),
        );
      }
    const start = performance.now();
    await page.goto(`${base}/chat?run=${id}`);
    await page.locator(".answer-overview").waitFor();
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const visibleMs = performance.now() - start;
    const result = {
      variant,
      visibleMs,
      errors,
      viewports: [],
      screenshots: [],
    };
    for (const viewport of contract.automatic.viewports) {
      const { width } = viewport;
      await page.setViewportSize(viewport);
      await page
        .locator(".answer-overview")
        .evaluate((e) => e.scrollIntoView({ block: "start" }));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const metrics = await page.evaluate(() => {
        const targets = {
          conclusion: document.querySelector(
            '[data-ux="conclusion"], .answer-overview > h2',
          ),
          uncertainty:
            document.querySelector('[data-ux="uncertainty"]') ??
            [...document.querySelectorAll(".answer-meta span")].find((e) =>
              e.textContent.includes("未確認"),
            ),
          "primary-action": document.querySelector(
            '[data-ux="primary-action"], .read-answer',
          ),
        };
        const isAbove = (e) => {
          const b = e.getBoundingClientRect(),
            main = document.querySelector("main").getBoundingClientRect(),
            compose = document
              .querySelector(".compose-panel")
              .getBoundingClientRect();
          return (
            b.top >= Math.max(0, main.top) &&
            b.bottom <= Math.min(innerHeight, compose.top) + 1
          );
        };
        const aboveFold = Object.fromEntries(
          ["conclusion", "uncertainty", "primary-action"].map((key) => [
            key,
            Boolean(targets[key] && isAbove(targets[key])),
          ]),
        );
        const button = targets["primary-action"],
          box = button?.getBoundingClientRect();
        const rgb = (s) =>
            s
              .match(/[\d.]+/g)
              ?.slice(0, 3)
              .map(Number),
          lum = (rgb) =>
            rgb
              .map((n) => {
                const v = n / 255;
                return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
              })
              .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
        const contrast = (e) => {
          if (!e) return null;
          let p = e,
            bg;
          while (p) {
            const c = getComputedStyle(p).backgroundColor;
            if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
              bg = rgb(c);
              break;
            }
            p = p.parentElement;
          }
          const fg = rgb(getComputedStyle(e).color),
            a = lum(fg),
            b = lum(bg ?? [255, 255, 255]);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        return {
          width: innerWidth,
          height: innerHeight,
          overflow: Math.max(
            0,
            document.documentElement.scrollWidth - innerWidth,
          ),
          aboveFold,
          primary: box ? { width: box.width, height: box.height } : null,
          contrast: {
            conclusion: contrast(targets.conclusion),
            uncertainty: contrast(targets.uncertainty),
            primary: contrast(targets["primary-action"]),
          },
        };
      });
      result.viewports.push(metrics);
      if ([1240, 390].includes(width)) {
        const file = `${variant}-${width}.png`;
        await page.screenshot({
          path: join(output, file),
          animations: "disabled",
        });
        const bytes = await readFile(join(output, file));
        result.screenshots.push({
          file,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    if (variant === "after") {
      assert.ok(visibleMs < contract.automatic.savedAnswerVisibleMs);
      for (const m of result.viewports) {
        assert.equal(m.overflow, 0, `overflow at ${m.width}`);
        for (const [key, visible] of Object.entries(m.aboveFold))
          assert.ok(visible, `${key} below fold at ${m.width}`);
        assert.ok(m.primary.height >= 44);
        for (const [key, ratio] of Object.entries(m.contrast))
          assert.ok(ratio >= 4.5, `${key} contrast ${ratio}`);
      }
      const interaction = performance.now();
      await page.locator('[data-ux="primary-action"]').click();
      await page.locator("#answer-dialog").waitFor({ state: "visible" });
      result.detailInteractionMs = performance.now() - interaction;
      assert.ok(
        result.detailInteractionMs < contract.automatic.detailInteractionMs,
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#answer-dialog").isVisible(), false);
      result.focusRestored = await page
        .locator('[data-ux="primary-action"]')
        .evaluate((e) => e === document.activeElement);
      assert.ok(result.focusRestored);
      await page.locator('[data-answer-detail="candidate-0"]').click();
      await page.locator(".markdown-body blockquote").first().waitFor();
      result.citationOpened = true;
      await page.keyboard.press("Escape");
      if (task.answer.actionPlan?.steps?.length) {
        await page.locator('[data-answer-detail^="step-"]').first().click();
        await page.locator("#answer-dialog").waitFor({ state: "visible" });
        const detail = await page.locator(".markdown-body").textContent();
        assert.ok(detail.includes(task.answer.actionPlan.steps[0].how));
        assert.ok(detail.includes(task.answer.actionPlan.steps[0].doneWhen));
        await page.screenshot({
          path: join(output, "step-detail.png"),
          animations: "disabled",
        });
        result.concreteStepDetailOpened = true;
        await page.keyboard.press("Escape");
      }
      assert.equal(
        await page.locator("#ux-review-form input:checked").count(),
        0,
      );
      result.humanSurveyHasNoDefaults = true;
      const reviewStart = performance.now();
      await page.locator(".ux-review-start").click();
      await page
        .locator("#ux-review-dialog")
        .waitFor({ state: "visible", timeout: 15000 });
      result.reviewExposureMs = performance.now() - reviewStart;
      assert.ok(result.reviewExposureMs >= 10000);
      assert.equal(
        await page.locator("#ux-review-form input:checked").count(),
        0,
      );
      await page.keyboard.press("Escape");
    }
    assert.deepEqual(errors, []);
    report.variants.push(result);
    await page.close();
  }
  report.passed = true;
  await writeFile(join(output, "answer.md"), renderAnswer(task) + "\n");
  await writeFile(join(output, "task.json"), JSON.stringify(task, null, 2));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close();
  server.emit("shutdown");
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
