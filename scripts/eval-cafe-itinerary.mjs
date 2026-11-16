// Replay of the source-grounded, reviewed final answer. No source requests, inference, or human ratings.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { cafePlanIssues } from "../dist/cafe.js";
import { assessSpecificity } from "../dist/answer-plan.js";
import { uncoveredCriteria } from "../dist/criteria.js";
import { assessVisualArtifact } from "../dist/visual-artifact.js";
const task = JSON.parse(
  await readFile("examples/visual-cafe-answer.json", "utf8"),
);
assert.deepEqual(cafePlanIssues(task, task.answer), []);
const current = structuredClone(task);
delete current.evaluation;
assert.equal(current.status, "succeeded");
assert.equal(current.authorship.mode, "source-grounded-final-edit");
assert.equal(assessSpecificity(current, current.answer).status, "passed");
assert.deepEqual(
  uncoveredCriteria(current.criteria, current.answer.candidates),
  [],
);
assert.equal(current.answer.candidates.length, 3);
assert.ok(current.answer.candidates.every((c) => c.eligible));
assert.ok(
  current.answer.actionPlan.budget.items.every((i) => i.basis === "published"),
);
assert.equal(
  current.answer.actionPlan.verification.checks.find(
    (c) => c.kind === "seating",
  ).status,
  "arrival-check",
);
assert.equal(assessVisualArtifact(task, task.answer).status, "passed");
const out = ".runtime/cafe-itinerary/qa";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
});
const report = {
  scope:
    "source-grounded final edit; offline replay; automated checks only; not unattended model success",
  taskId: task.id,
  humanResponses: 0,
  cases: [],
};
try {
  for (const width of [320, 390, 768, 1280]) {
    const page = await browser.newPage({
      viewport: { width, height: 950 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await page.route(/^https?:/, (r) => r.abort());
    await page.goto(pathToFileURL(resolve("docs/cafe-day.html")).href);
    await page.locator("[data-artifact-kind]").waitFor();
    assert.equal(await page.locator(".hero-tags .verified").count(), 1);
    assert.equal(
      await page.locator("#candidate-comparison tbody tr").count(),
      3,
    );
    assert.equal(await page.locator("#verification .branch").count(), 5);
    await page.locator('#verification a[href^="#step-"]').first().click();
    assert.equal(await page.locator(".journey-story[open]").count(), 1);
    const cafe = page
      .locator(".experience-card")
      .filter({ hasText: /EVERYONEs CAFE/ });
    assert.equal(await cafe.count(), 1);
    await cafe.scrollIntoViewIfNeeded();
    await cafe.locator("img").evaluate((img) => img.decode());
    const decoded = await cafe
      .locator("img")
      .evaluate((img) => img.naturalWidth > 0 && img.naturalHeight > 0);
    assert.equal(decoded, true);
    assert.equal(await cafe.locator("[data-map-stop]").count(), 1);
    await page
      .locator("details")
      .evaluateAll((items) => items.forEach((e) => (e.open = true)));
    assert.equal(
      await page.locator(".journey-moment").count(),
      task.answer.actionPlan.steps.length,
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, `horizontal overflow at ${width}`);
    const screenshot = `${out}/cafe-${width}.png`;
    await cafe.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot });
    report.cases.push({
      width,
      scheme: "dark",
      cafePhotoDecoded: decoded,
      allStepsVisible: true,
      noHorizontalOverflow: !overflow,
      screenshot,
    });
    await page.close();
  }
  report.passed = true;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await writeFile(
    "docs/evidence/cafe-itinerary-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
