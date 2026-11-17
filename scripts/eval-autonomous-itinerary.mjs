// Replay of an unedited live model output. No source requests, inference, or human ratings.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { itineraryCases } from "./itinerary-cases.mjs";
import { isCafeStay } from "../dist/cafe.js";
import { cafePlanIssues } from "../dist/cafe.js";
import { assessSpecificity } from "../dist/answer-plan.js";
import { uncoveredCriteria } from "../dist/criteria.js";
import { assessVisualArtifact } from "../dist/visual-artifact.js";
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--case"))
  throw Error("Use [--case ueno|hamamatsu|nagoya]");
const selected = itineraryCases[args[1] ?? "ueno"];
if (!selected) throw Error("Unknown itinerary case");
const task = JSON.parse(
  await readFile(`examples/${selected.snapshot}.json`, "utf8"),
);
const live = JSON.parse(
  await readFile(`docs/evidence/${selected.receipt}.json`, "utf8"),
);
assert.equal(live.mode, "live-unattended");
// A source-incomplete regional answer may be displayed, but must keep its failed factual verdict and draft banner.
assert.ok(
  live.passed === true || (selected.id !== "ueno" && task.status === "partial"),
);
assert.equal(live.answerEdited, false);
assert.equal(live.taskId, task.id);
assert.deepEqual(cafePlanIssues(task, task.answer), []);
const current = structuredClone(task);
delete current.evaluation;
assert.equal(current.status, live.passed ? "succeeded" : "partial");
assert.equal(current.authorship, undefined);
assert.equal(assessSpecificity(current, current.answer).status, "passed");
assert.deepEqual(
  uncoveredCriteria(current.criteria, current.answer.candidates),
  [],
);
assert.ok(current.answer.candidates.length >= 3);
if (live.passed) assert.ok(current.answer.candidates.every((c) => c.eligible));
else {
  assert.ok(current.answer.candidates.some((c) => !c.eligible));
  assert.ok(current.answer.limitations.length > 0);
}
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
const out =
  selected.id === "ueno"
    ? ".runtime/autonomous-itinerary/qa"
    : `.runtime/regional-itinerary/${selected.id}/qa`;
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
    "unedited live model output; offline display replay; live success is recorded separately",
  taskId: task.id,
  humanResponses: 0,
  factualComplete: live.passed,
  originalTaskStatus: task.status,
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
    await page.goto(
      pathToFileURL(resolve(`docs/${selected.output}.html`)).href,
    );
    await page.locator("[data-artifact-kind]").waitFor();
    assert.equal(
      await page.locator(".hero-tags .verified").count(),
      live.passed ? 1 : 0,
    );
    if (!live.passed)
      assert.match(await page.locator(".hero-tags").innerText(), /暫定|未確認/);
    assert.equal(
      await page.locator("#candidate-comparison tbody tr").count(),
      task.answer.candidates.length,
    );
    assert.equal(await page.locator("#verification .branch").count(), 5);
    await page.locator('#verification a[href^="#step-"]').first().click();
    assert.equal(await page.locator(".journey-story[open]").count(), 1);
    const cafeStop = task.answer.visualArtifact.stops.find((s) =>
      isCafeStay(
        task.answer.actionPlan.steps.find((p) => p.id === s.primaryStepId) ?? {
          where: "",
          action: "",
        },
      ),
    );
    assert.ok(cafeStop?.experience);
    const cafe = page
      .locator(".experience-card")
      .filter({ hasText: cafeStop.experience.headline });
    assert.equal(await cafe.count(), 1);
    await cafe.scrollIntoViewIfNeeded();
    await cafe.locator("img").evaluate((img) => img.decode());
    for (const img of await page.locator(".experience-card img").all()) {
      await img.scrollIntoViewIfNeeded();
      await img.evaluate((i) => i.decode());
    }
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
      photosDecoded: await page.locator(".experience-card img").count(),
      allStepsVisible: true,
      noHorizontalOverflow: !overflow,
      screenshot,
    });
    await page.close();
  }
  report.passed = true;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await writeFile(
    `docs/evidence/${selected.id === "ueno" ? "autonomous-itinerary" : selected.id + "-itinerary"}-qa.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
