import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mapVector } from "../test/fixtures/map-vector.mjs";
const out = ".runtime/journey-moments/qa";
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
    "saved real model outputs, deterministic transport; human appeal unrated",
  cases: [],
  passed: false,
};
try {
  for (const [name, file] of [
    ["ueno", "docs/generated-answer.html"],
    ["asakusa", "docs/asakusa-day.html"],
    ["life", "docs/life-roadmap-actual.html"],
  ].filter(([name]) => !process.argv[2] || name === process.argv[2])) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/^https?:/, (route) => route.abort());
    await page.route("https://cyberjapandata.gsi.go.jp/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: mapVector,
      }),
    );
    await page.route("https://www.google.com/maps/embed?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<p>Captured map transport fixture</p>",
      }),
    );
    const start = performance.now();
    await page.goto(pathToFileURL(resolve(file)).href);
    await page.locator("[data-artifact-kind]").waitFor();
    const readyMs = Math.round(performance.now() - start);
    assert.ok(readyMs < 10000);
    const html = await readFile(file, "utf8");
    const data = JSON.parse(
      html.match(
        /<script id="visual-data" type="application\/json">([\s\S]*?)<\/script>/,
      )[1],
    );
    const checks = [];
    if (data.artifact.kind === "journey-map") {
      const story = page.locator(".journey-story"),
        summary = story.locator(":scope > summary");
      assert.equal(await story.getAttribute("open"), null);
      await summary.scrollIntoViewIfNeeded();
      if (!process.argv[2])
        await page.screenshot({ path: `${out}/${name}-closed.png` });
      await summary.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".journey-story").open,
      );
      const count = await page.locator(".journey-moment").count();
      assert.equal(count, data.plan.steps.length);
      assert.deepEqual(
        await page
          .locator(".journey-moment")
          .evaluateAll((nodes) => nodes.map((n) => n.dataset.stepId)),
        data.plan.steps.map((s) => s.id),
      );
      assert.ok((await page.locator(".kind-rest").count()) >= 2);
      assert.ok((await page.locator(".kind-move").count()) > 0);
      const originalHow = await page.locator(".moment-how").allTextContents();
      assert.deepEqual(
        originalHow,
        data.plan.steps.map((s) => s.how),
      );
      for (const img of await page.locator(".moment-photo img").all()) {
        await img.scrollIntoViewIfNeeded();
        await img.evaluate((img) =>
          Promise.race([
            img.decode(),
            new Promise((_, reject) =>
              setTimeout(() => reject(Error("Photo failed to decode")), 5000),
            ),
          ]),
        );
      }
      await page.locator(".moment-practical > summary").first().click();
      await page.locator(".moment-practical[open]").first().waitFor();
      await page.locator(".moment-map-link").first().click();
      await page.locator("#visual-artifact").scrollIntoViewIfNeeded();
      checks.push(
        "all fixed steps preserved",
        "rest and move invitations",
        "reviewed photos decoded",
        "practical details",
        "map selection link",
      );
    } else {
      assert.ok((await page.locator(".milestone").count()) >= 3);
      await page.locator(".milestone").first().click();
      assert.equal(
        await page.locator(".milestone-detail h3").innerText(),
        data.artifact.milestones[0].title,
      );
      const dependent = data.artifact.milestones.find(
        (m) => m.dependsOn.length,
      );
      assert.ok(dependent);
      await page
        .locator(".milestone")
        .filter({ hasText: dependent.title })
        .first()
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "この節目を完了にする", exact: true })
          .isDisabled(),
        true,
      );
      checks.push("actual generated life roadmap", "milestone selection");
    }
    const widths = [];
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      if (data.artifact.kind === "journey-map")
        await page.locator(".journey-story > summary").scrollIntoViewIfNeeded();
      else await page.locator("#visual-artifact").scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${name}: ${width}px overflow`,
      );
      widths.push(width);
      if (width === 390 || width === 1280)
        await page.screenshot({ path: `${out}/${name}-${width}.png` });
    }
    if (data.artifact.kind === "journey-map") {
      if (!process.argv[2]) {
        await page.locator(".kind-rest").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${out}/${name}-rest.png` });
      }
      await page.locator(".journey-story > summary").click();
      assert.equal(
        await page.locator(".journey-story").getAttribute("open"),
        null,
      );
    }
    assert.deepEqual(errors, []);
    report.cases.push({
      name,
      file,
      readyMs,
      widths,
      checks,
      steps: data.plan?.steps.length,
      moments: data.artifact.moments?.length,
    });
    await page.close();
  }
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(
    "docs/evidence/journey-moments-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report, null, 2));
