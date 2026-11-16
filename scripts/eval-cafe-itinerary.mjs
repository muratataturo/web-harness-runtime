// Replay of saved model output. No source requests, inference, or human ratings.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { cafePlanIssues } from "../dist/cafe.js";
import { assessVisualArtifact } from "../dist/visual-artifact.js";
const task = JSON.parse(
  await readFile("examples/visual-cafe-answer.json", "utf8"),
);
assert.deepEqual(cafePlanIssues(task, task.answer), []);
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
  scope: "saved real cafe itinerary; offline replay; automated checks only",
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
