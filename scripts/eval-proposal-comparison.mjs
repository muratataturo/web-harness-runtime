import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { renderAnswerHtml } from "../dist/answer-html.js";
const out = ".runtime/proposal-comparison/qa";
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
    "actual saved model variants and automated interaction checks; ratings are test fixtures only",
  humanResponsesCollected: 0,
  humanAppeal: "unrated",
  cases: [],
  passed: false,
};
const setup = async () => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  page.setDefaultTimeout(15000);
  await page.route(/^https?:/, (r) => r.abort());
  return page;
};
try {
  for (const name of ["travel", "life"]) {
    const page = await setup();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      pathToFileURL(resolve(`docs/comparison-${name}.html`)).href,
    );
    await page.locator(".proposal-section").waitFor();
    assert.equal(await page.locator(".proposal-option").count(), 3);
    const ids = await page
      .locator(".proposal-option")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.proposalId));
    await page.locator(".proposal-option").nth(2).locator("button").click();
    assert.equal(
      await page
        .locator(".proposal-section")
        .getAttribute("data-selected-proposal"),
      ids[2],
    );
    await page.reload();
    await page.locator(".proposal-section").waitFor();
    assert.equal(
      await page
        .locator(".proposal-section")
        .getAttribute("data-selected-proposal"),
      ids[2],
    );
    const widths = [];
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      await page.locator(".proposal-heading").scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${name} ${width} overflow`,
      );
      if (width < 800) {
        await page.locator(".proposal-tabs button").nth(1).click();
        assert.equal(await page.locator(".proposal-option:visible").count(), 1);
        assert.equal(
          await page
            .locator(".proposal-section")
            .getAttribute("data-selected-proposal"),
          ids[1],
        );
      }
      widths.push(width);
      if (width === 390 || width === 1280)
        await page.screenshot({ path: `${out}/${name}-${width}.png` });
    }
    assert.deepEqual(errors, []);
    report.cases.push({
      name,
      variants: 3,
      widths,
      choicePersists: true,
      mobileOneVisibleVariant: true,
    });
    await page.close();
  }
  // Isolated fixture identity and frozen marker: never import these automated answers into a real task.
  const task = JSON.parse(
    await readFile("examples/visual-comparison-travel-answer.json", "utf8"),
  );
  task.id = "qa-only-proposal-review";
  task.evaluation = {
    mode: "frozen-replay",
    caseId: "review-workflow",
    fixtureSha256: "fixture",
  };
  await writeFile(
    `${out}/review-fixture.html`,
    renderAnswerHtml(task, {
      photoBase: pathToFileURL(resolve("docs/answer-assets")).href,
    }),
  );
  const page = await setup();
  await page.clock.install();
  await page.goto(pathToFileURL(resolve(`${out}/review-fixture.html`)).href);
  await page.locator(".proposal-section").waitFor();
  await page
    .getByRole("button", {
      name: "表示中の案で10秒レビューを始める",
      exact: true,
    })
    .click();
  await page.clock.fastForward(5000);
  assert.equal(await page.locator(".review-form").count(), 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30000);
  assert.equal(await page.locator(".review-form").count(), 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(5200);
  await page.locator(".review-form").waitFor();
  const submit = page.getByRole("button", {
    name: "自分の評価をJSONに書き出す",
    exact: true,
  });
  assert.equal(await submit.isDisabled(), true);
  for (const key of ["understood", "uncertaintyVisible", "nextActionClear"])
    await page.locator(`input[name="review-${key}"]`).first().check();
  await page.locator('input[name="review-appeal"]').nth(3).check();
  const download = page.waitForEvent("download");
  await submit.click();
  const file = await download;
  const payload = JSON.parse(await readFile(await file.path(), "utf8"));
  assert.equal(payload.taskId, "qa-only-proposal-review");
  assert.equal(payload.exposureMs, 10000);
  assert.equal(payload.designVersion, "ten-second-v2");
  assert.match(payload.artifactRevision, /^[a-f0-9]{64}$/);
  assert.ok(payload.proposalId);
  await page
    .getByRole("status")
    .filter({ hasText: "runtimeへ取り込むまで未保存" })
    .waitFor();
  report.reviewWorkflow = {
    visibleExposureGate: true,
    hiddenTimeExcluded: true,
    explicitRatingsRequired: true,
    localExportIsNotSubmitted: true,
    fixtureIdentityOnly: true,
  };
  await page.close();
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(
    "docs/evidence/proposal-comparison-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report, null, 2));
