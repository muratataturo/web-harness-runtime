// Display and intent regression for saved, unedited live outputs. A display pass never changes livePassed.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { verifyStepPlan } from "../dist/step-verifier.js";
import { tripRhythmIssues } from "../dist/trip-brief.js";
import { assessSpecificity } from "../dist/answer-plan.js";
import { assertEvidenceIntegrity } from "../dist/provenance.js";
import { itineraryCases } from "./itinerary-cases.mjs";
const report = {
  scope:
    "saved live output intent + integrity + display, not live factual acceptance or human appeal",
  cases: [],
  passed: false,
};
const out = ".runtime/experience-cases/qa";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
});
try {
  for (const id of ["hamamatsu-full", "nagoya-afternoon"]) {
    const c = itineraryCases[id];
    const task = JSON.parse(
      await readFile(`examples/${c.snapshot}.json`, "utf8"),
    );
    const receipt = JSON.parse(
      await readFile(`docs/evidence/${c.receipt}.json`, "utf8"),
    );
    assert.equal(task.id, receipt.taskId);
    assert.equal(receipt.answerEdited, false);
    assert.equal(task.authorship, undefined);
    assert.equal(
      task.tripBrief.mode,
      id === "hamamatsu-full" ? "full-day" : "afternoon",
    );
    assert.deepEqual(tripRhythmIssues(task.query, task.answer.actionPlan), []);
    for (const e of task.evidence) assertEvidenceIntegrity(task, e.id);
    assert.equal(
      createHash("sha256").update(JSON.stringify(task.answer)).digest("hex"),
      receipt.publication.answerSha256,
    );
    const current = structuredClone(task);
    delete current.evaluation;
    const specificity = assessSpecificity(current, current.answer);
    const verification = verifyStepPlan(task, task.answer.actionPlan);
    assert.equal(verification.planHash, task.stepVerification.planHash);
    if (receipt.passed) assert.equal(verification.ready, true);
    else {
      assert.ok(receipt.failure);
      assert.equal(task.status, receipt.status);
      assert.ok(["partial", "succeeded"].includes(task.status));
    }
    assert.ok(task.answer.candidates.length >= (c.minimumCandidates ?? 3));
    assert.ok(task.answer.actionPlan.budget.totalYen <= c.budgetCap);
    assert.equal(task.visualReview.status, "passed");
    if (task.status === "succeeded") {
      assert.equal(specificity.status, "passed");
      assert.equal(verification.ready, true);
      assert.ok(
        task.answer.candidates.every((candidate) => candidate.eligible),
      );
    }
    if (task.tripBrief.mode === "afternoon")
      assert.ok(
        task.answer.actionPlan.steps.every(
          (s) => !["dinner", "evening"].includes(s.kind),
        ),
      );
    const result = {
      id,
      livePassed: receipt.passed,
      taskStatus: task.status,
      specificity: specificity.status,
      stepUnknown: verification.unknown,
      stepFailed: verification.failed,
      displays: [],
    };
    for (const scheme of ["light", "dark"])
      for (const width of [320, 390, 768, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 950 },
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        // No public map traffic: prove the owned HTML, photos and fallback shell survive unavailable external services.
        await page.route(/^https?:/, (r) => r.abort());
        await page.goto(pathToFileURL(resolve(`docs/${c.output}.html`)).href, {
          waitUntil: "domcontentloaded",
        });
        assert.equal(await page.locator("#day-rhythm").count(), 1);
        assert.ok(
          (await page.locator("#day-rhythm").innerText()).includes(
            task.tripBrief.timeRange.join(" → "),
          ),
        );
        if (task.status === "partial")
          assert.equal(await page.locator(".hero-tags .verified").count(), 0);
        const photos = page.locator(".experience-card img");
        assert.ok((await photos.count()) >= 2);
        const photoTimes = await page
          .locator(".experience-meta time")
          .allTextContents();
        assert.deepEqual(photoTimes, [...photoTimes].sort());
        for (const p of await photos.all()) {
          await p.scrollIntoViewIfNeeded();
          await p.evaluate((i) => i.decode());
        }
        await page.locator('#day-rhythm a[href^="#step-"]').first().click();
        assert.equal(await page.locator(".journey-story[open]").count(), 1);
        assert.equal(
          await page.locator(".journey-moment").count(),
          task.answer.actionPlan.steps.length,
        );
        await page.locator("#day-rhythm details summary").click();
        assert.equal(
          await page.locator("#day-rhythm details[open] .branch").count(),
          verification.checks.length,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          ),
          false,
        );
        assert.deepEqual(errors, []);
        await page.locator("#day-rhythm").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${out}/${id}-${scheme}-${width}.png` });
        result.displays.push({
          scheme,
          width,
          photos: await photos.count(),
          allSteps: task.answer.actionPlan.steps.length,
          noOverflow: true,
          noPageErrors: true,
        });
        await page.close();
      }
    report.cases.push(result);
  }
  for (const scheme of ["light", "dark"])
    for (const width of [390, 1280]) {
      const page = await browser.newPage({
        viewport: { width, height: 950 },
        colorScheme: scheme,
      });
      await page.goto(
        pathToFileURL(resolve("docs/experience-cases.html")).href,
        { waitUntil: "domcontentloaded" },
      );
      assert.equal(await page.locator(".case").count(), 2);
      for (const p of await page.locator("img").all())
        await p.evaluate((i) => i.decode());
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      await page.screenshot({
        path: `${out}/comparison-${scheme}-${width}.png`,
        fullPage: true,
      });
      await page.close();
    }
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(
    "docs/evidence/experience-cases-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report, null, 2));
