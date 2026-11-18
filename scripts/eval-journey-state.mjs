// Re-evaluate the immutable output of an actual self-improvement run, then inspect HTML.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { assessJourneyState } from "../dist/journey-state.js";
import { assessSpecificity } from "../dist/answer-plan.js";
import { assertEvidenceIntegrity } from "../dist/provenance.js";
const task = JSON.parse(
  await readFile(
    "examples/visual-hamamatsu-state-improved-answer.json",
    "utf8",
  ),
);
const receipt = JSON.parse(
  await readFile("docs/evidence/hamamatsu-state-improved-e2e.json", "utf8"),
);
assert.equal(receipt.mode, "live-self-improvement");
assert.equal(receipt.answerEdited, false);
assert.equal(task.id, receipt.taskId);
assert.equal(
  createHash("sha256").update(JSON.stringify(task.answer)).digest("hex"),
  receipt.publication.answerSha256,
);
assert.ok(task.journeyMemory.priorPlans.length >= 1);
assert.equal(task.journeyMemory.observations.length, 0);
for (const e of task.evidence) assertEvidenceIntegrity(task, e.id);
const current = structuredClone(task);
delete current.evaluation;
const assessment = assessJourneyState(current, current.answer.actionPlan);
assert.equal(assessment.status, "passed", assessment.issues.join("\n"));
assert.equal(assessment.historySamples, 0);
assert.ok(assessment.walkingMetersEstimate > 0);
assert.equal(
  assessment.legs.length,
  task.answer.actionPlan.steps.filter((s) =>
    ["move", "return"].includes(s.kind),
  ).length,
);
const report = {
  scope:
    "independent state + immutable answer + display; original live/factual verdict preserved",
  originalStatus: task.status,
  livePassed: receipt.passed,
  specificity: assessSpecificity(current, current.answer).status,
  assessment,
  displays: [],
  passed: false,
};
const out = ".runtime/journey-state/qa";
await mkdir(out, { recursive: true });
const b = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
});
try {
  for (const scheme of ["light", "dark"])
    for (const width of [320, 390, 768, 1280]) {
      const page = await b.newPage({
          viewport: { width, height: 950 },
          colorScheme: scheme,
          reducedMotion: "reduce",
        }),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/^https?:/, (r) => r.abort());
      await page.goto(
        pathToFileURL(resolve("docs/hamamatsu-experience-state.html")).href,
        { waitUntil: "domcontentloaded" },
      );
      assert.equal(await page.locator("#journey-state").count(), 1);
      assert.match(
        await page.locator("#journey-state").innerText(),
        /初期の歩速|実績/,
      );
      const photos = page.locator(".experience-card img");
      assert.ok((await photos.count()) >= 2);
      for (const photo of await photos.all()) {
        await photo.evaluate((i) => i.scrollIntoView());
        await photo.evaluate((i) => i.decode());
      }
      await page.locator("#journey-state summary").click();
      assert.equal(
        await page.locator("#journey-state tbody tr").count(),
        assessment.legs.length + assessment.stays.length,
      );
      await page.locator("#journey-state summary").click();
      await page.locator('#day-rhythm a[href^="#step-"]').first().click();
      assert.equal(await page.locator(".journey-story[open]").count(), 1);
      assert.equal(
        await page.locator(".journey-moment").count(),
        task.answer.actionPlan.steps.length,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      assert.deepEqual(errors, []);
      await page
        .locator("#journey-state")
        .evaluate((el) => el.scrollIntoView());
      await page.screenshot({ path: `${out}/${scheme}-${width}.png` });
      report.displays.push({
        scheme,
        width,
        photos: await photos.count(),
        allSteps: task.answer.actionPlan.steps.length,
        noOverflow: true,
        noPageErrors: true,
      });
      await page.close();
    }
  report.passed = true;
} finally {
  await b.close();
  await writeFile(
    "docs/evidence/journey-state-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    status: task.status,
    livePassed: receipt.passed,
    state: assessment.status,
    walkingMetersEstimate: assessment.walkingMetersEstimate,
    walkingMinutes: assessment.walkingMinutes,
    displays: report.displays.length,
    passed: report.passed,
  }),
);
