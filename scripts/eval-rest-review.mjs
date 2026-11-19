// Verify actual output and the saved correction loop without changing the model's answer.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { verifyStepPlan } from "../dist/step-verifier.js";
import { assessJourneyState } from "../dist/journey-state.js";
import { assertEvidenceIntegrity } from "../dist/provenance.js";
const task = JSON.parse(
  await readFile(
    "examples/visual-hamamatsu-rest-confirmed-answer.json",
    "utf8",
  ),
);
const receipt = JSON.parse(
  await readFile("docs/evidence/hamamatsu-rest-confirmed-e2e.json", "utf8"),
);
assert.equal(receipt.answerEdited, false);
assert.equal(
  createHash("sha256").update(JSON.stringify(task.answer)).digest("hex"),
  receipt.publication.answerSha256,
);
assert.ok(
  task.reviewContext.perspectives.some((p) => p.id === "rest-opening-scope"),
);
assert.ok(
  task.reviewContext.pastChecks.some(
    (p) => p.id === "rest-opening-scope" && p.needsAttentionCount >= 1,
  ),
);
for (const e of task.evidence) assertEvidenceIntegrity(task, e.id);
const report = verifyStepPlan(task, task.answer.actionPlan);
const rests = task.answer.actionPlan.steps.filter((s) => s.kind === "rest");
assert.ok(rests.length > 0);
for (const s of rests) {
  const checks = report.checks.filter((c) => c.stepId === s.id);
  assert.ok(
    checks.some((c) => c.kind === "opening" && c.status === "passed"),
    s.id + ": missing opening proof",
  );
  assert.ok(
    checks.some((c) => c.kind === "fact" && c.status === "passed"),
    s.id + ": missing rest location proof",
  );
  assert.ok(
    !checks.some((c) => ["unknown", "failed"].includes(c.status)),
    s.id + ": unresolved rest check",
  );
}
assert.equal(report.ready, true);
const journey = assessJourneyState(task, task.answer.actionPlan);
assert.equal(journey.status, "passed", journey.issues.join("\n"));
const result = {
  scope:
    "actual unedited answer, rest/step/journey contracts, prior correction recall, local display",
  originalStatus: task.status,
  livePassed: receipt.passed,
  rests: rests.map((s) => ({
    id: s.id,
    when: s.when,
    where: s.where,
    venueUrl: s.venueUrl,
    checks: report.checks.filter((c) => c.stepId === s.id),
  })),
  stepReady: report.ready,
  journey,
  displays: [],
  passed: false,
};
const out = ".runtime/rest-review/qa";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
});
try {
  for (const scheme of ["light", "dark"])
    for (const width of [320, 390, 768, 1280]) {
      const page = await browser.newPage({
        viewport: { width, height: 950 },
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/^https?:/, (r) => r.abort());
      await page.goto(
        pathToFileURL(resolve("docs/hamamatsu-rest-confirmed.html")).href,
        { waitUntil: "domcontentloaded" },
      );
      const photos = page.locator(".experience-card img");
      assert.ok((await photos.count()) >= 3);
      for (const photo of await photos.all()) {
        await photo.evaluate((i) => i.scrollIntoView());
        await photo.evaluate((i) => i.decode());
      }
      assert.match(
        await page.locator("#review-perspectives").innerText(),
        /未確認 0件/,
      );
      await page.locator("#review-perspectives summary").first().click();
      assert.equal(
        await page.locator("#review-perspectives tbody tr").count(),
        rests.length,
      );
      await page.locator("#journey-state summary").click();
      assert.equal(
        await page.locator("#journey-state tbody tr").count(),
        journey.legs.length + journey.stays.length,
      );
      await page.locator("#journey-state summary").click();
      await page.locator('#day-rhythm a[href^="#step-"]').first().click();
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
      result.displays.push({
        scheme,
        width,
        photos: await photos.count(),
        noOverflow: true,
        noPageErrors: true,
      });
      await page.close();
    }
  result.passed = true;
} finally {
  await browser.close();
  await writeFile(
    "docs/evidence/rest-review-qa.json",
    JSON.stringify(result, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    status: task.status,
    restCount: rests.length,
    stepReady: report.ready,
    state: journey.status,
    displays: result.displays.length,
    passed: result.passed,
  }),
);
