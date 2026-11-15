import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mapTile } from "../test/fixtures/map-tile.mjs";
import { mapVector } from "../test/fixtures/map-vector.mjs";
import { newTask } from "../src/runtime.js";
import { renderAnswerHtml } from "../src/answer-html.js";
const out = ".runtime/visual-study/qa";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
});
browser.on("context", (context) => context.setDefaultTimeout(15000));
const report = {
  scope:
    "automatic-interaction-and-layout-only; synthetic map transport fixture, no public tile traffic",
  humanAppeal: "unrated",
  cases: [],
  passed: false,
};
try {
  for (const [file, kind] of [
    ["docs/generated-answer.html", "journey-map"],
    ["docs/life-roadmap.html", "life-roadmap"],
  ]) {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.setDefaultTimeout(15000);
    console.log(`Opening ${kind}`);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (/violates.*Content Security Policy/i.test(m.text()))
        errors.push(m.text());
    });
    await page.route("https://cyberjapandata.gsi.go.jp/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: mapVector,
      }),
    );
    page.on("request", (r) => {
      if (r.url().includes("tile.openstreetmap.org"))
        errors.push("Public OSM tile request is forbidden");
    });
    await page.route("https://www.google.com/maps/embed?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><p>Google Maps embed fixture</p>",
      }),
    );
    const renderStart = performance.now();
    await page.goto(pathToFileURL(resolve(file)).href);
    console.log(`Opened ${kind}`);
    await page.locator(`[data-artifact-kind="${kind}"]`).waitFor();
    const interactiveMs = Math.round(performance.now() - renderStart);
    assert.ok(
      interactiveMs < 10000,
      "Saved artifact must become interactive within ten seconds",
    );
    if (kind === "journey-map") {
      const preview = page.locator(".google-map-preview iframe");
      assert.equal(await page.locator(".experience-card").count(), 3);
      for (const image of await page.locator(".experience-card img").all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((img) =>
          Promise.race([
            img.decode(),
            new Promise((_, reject) =>
              setTimeout(() => reject(Error("Photo decode timeout")), 5000),
            ),
          ]),
        );
        console.log("Photo decoded");
      }
      report.experiencePhotosDecoded = 3;
      if (await preview.count()) {
        await preview.waitFor();
        await preview.dispatchEvent("error");
        await page
          .locator(".google-map-preview")
          .waitFor({ state: "detached" });
        report.googleFrameErrorFallback = true;
        await page
          .getByRole("button", { name: "Google Maps", exact: true })
          .click();
        await page.locator(".google-map-preview iframe").waitFor();
        report.googlePreviewPreferred = true;
        await page
          .getByRole("button", { name: "行程マップ", exact: true })
          .click();
      }
      await page
        .locator(".leaflet-tile-loaded")
        .first()
        .waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${out}/${kind}-desktop.png`,
      fullPage: false,
    });
    const checks = [];
    for (const width of [320, 390, 768, 1440]) {
      console.log(`Checking ${kind} at ${width}px`);
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1050 });
      await page.evaluate(() => window.scrollTo(0, 0));
      if (kind === "journey-map")
        await page.waitForFunction(() => {
          const bounds = document
            .querySelector(".journey-map")
            .getBoundingClientRect();
          return [...document.querySelectorAll(".journey-pin")].every((pin) => {
            const p = pin.getBoundingClientRect();
            return (
              p.left >= bounds.left &&
              p.right <= bounds.right &&
              p.top >= bounds.top &&
              p.bottom <= bounds.bottom
            );
          });
        });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false, `${kind} width ${width} root overflow`);
      const visualTop = await page
        .locator("#visual-artifact")
        .evaluate((el) => el.getBoundingClientRect().top);
      assert.ok(visualTop < 550, "Visual must start in first viewport");
      checks.push({ width, overflow, visualTop });
      if (width === 390) {
        if (kind === "journey-map")
          await page.waitForFunction(
            () =>
              document.querySelector(".journey-map")?.dataset.mapLoading ===
              "false",
          );
        await page.screenshot({ path: `${out}/${kind}-mobile.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    let detail = {};
    if (kind === "journey-map") {
      await page.locator(".stop-choice").nth(1).click();
      await page
        .locator(".map-selection h3")
        .filter({ hasText: "動物園" })
        .waitFor();
      await page
        .getByRole("button", { name: "行程マップ", exact: true })
        .click();
      await page.locator(".journey-pin").filter({ hasText: "4" }).click();
      assert.match(
        await page.locator(".map-selection h3").innerText(),
        /科学博物館/,
      );
      const totalBefore = await page
        .locator(".journey-total strong")
        .innerText();
      assert.equal(totalBefore, "¥12,080");
      await page.getByRole("button", { name: "任意の立寄りを省く" }).click();
      assert.equal(await page.locator(".stop-choice").count(), 4);
      assert.equal(
        await page.locator(".journey-total strong").innerText(),
        "¥10,820",
      );
      const href = await page
          .getByRole("link", { name: "全行程をGoogle Mapsで開く ↗" })
          .getAttribute("href"),
        url = new URL(href);
      assert.equal(url.searchParams.get("api"), "1");
      assert.equal(url.searchParams.get("travelmode"), "walking");
      assert.ok(!url.searchParams.get("waypoints").includes("博物館"));
      await page.getByRole("button", { name: "任意の立寄りを戻す" }).click();
      assert.equal(await page.locator(".stop-choice").count(), 5);
      const tilesLoaded = await page.locator(".leaflet-tile-loaded").count();
      assert.ok(
        await page
          .locator(".journey-map")
          .evaluate(
            (el) =>
              el.classList.contains("leaflet-container") &&
              getComputedStyle(el).overflow === "hidden",
          ),
        "React must preserve Leaflet classes and clip tiles",
      );
      assert.ok(
        await page
          .locator(".leaflet-tile-loaded")
          .first()
          .evaluate((el) => el.getBoundingClientRect().width > 200),
        "Loaded tiles must have visible dimensions",
      );
      detail = {
        linkedMapSelection: true,
        optionalBudget: { before: 12080, after: 10820 },
        googleRoute: true,
        loadedMapTiles: tilesLoaded,
      };
    } else {
      assert.equal(await page.locator(".milestone").count(), 9);
      await page
        .locator(".milestone")
        .filter({ hasText: "書面の条件で転職" })
        .first()
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "この節目を完了にする", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .locator(".milestone")
        .filter({ hasText: "譲れない働き方" })
        .first()
        .click();
      await page
        .getByRole("button", { name: "この節目を完了にする", exact: true })
        .click();
      assert.match(await page.locator(".progress-ring").innerText(), /1/);
      await page
        .locator(".milestone")
        .filter({ hasText: "候補職の実態" })
        .first()
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "この節目を完了にする", exact: true })
          .isDisabled(),
        false,
      );
      await page
        .getByRole("button", { name: "この節目を完了にする", exact: true })
        .click();
      await page
        .locator(".milestone")
        .filter({ hasText: "譲れない働き方" })
        .first()
        .click();
      await page
        .getByRole("button", { name: "未完了に戻す", exact: true })
        .click();
      assert.equal(await page.locator(".is-done").count(), 0);
      detail = {
        milestones: 9,
        dependencyGating: true,
        rollbackPropagates: true,
      };
    }
    assert.deepEqual(errors, []);
    report.cases.push({ kind, interactiveMs, viewports: checks, ...detail });
    await page.close();
  }
  report.backgroundFailures = [];
  for (const failure of [
    "http-403-png",
    "http-429-png",
    "cors-network",
    "invalid-png",
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1240, height: 960 },
    });
    let requests = 0;
    await page.route("https://cyberjapandata.gsi.go.jp/**", (route) => {
      requests++;
      if (failure === "cors-network") return route.abort("failed");
      return route.fulfill({
        status:
          failure === "http-403-png"
            ? 403
            : failure === "http-429-png"
              ? 429
              : 200,
        contentType: "image/png",
        headers: { "Access-Control-Allow-Origin": "*" },
        body:
          failure === "invalid-png" ? Buffer.from("Access blocked") : mapTile,
      });
    });
    await page.route("https://www.google.com/maps/embed?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<p>fixture</p>",
      }),
    );
    await page.goto(pathToFileURL(resolve("docs/generated-answer.html")).href);
    await page.getByRole("button", { name: "行程マップ", exact: true }).click();
    await page
      .locator(".map-fallback-note")
      .filter({ hasText: "背景地図を表示できません" })
      .waitFor();
    assert.equal(await page.locator(".leaflet-tile-loaded").count(), 0);
    assert.equal(
      await page.locator(".leaflet-tile-pane canvas").count(),
      0,
      "Provider error PNGs must never be displayed",
    );
    await page.locator(".stop-choice").nth(2).click();
    assert.match(await page.locator(".map-selection h3").innerText(), /まいか/);
    const before = requests;
    await page.locator(".leaflet-control-zoom-in").click();
    await page.waitForTimeout(150);
    assert.equal(requests, before, "No automatic retry after denial");
    assert.ok(await page.locator(".map-fallback-note a").getAttribute("href"));
    if (failure === "http-403-png")
      await page.screenshot({ path: out + "/blocked-background-fallback.png" });
    report.backgroundFailures.push({
      failure,
      errorImagesVisible: false,
      pinsAndSelectionWork: true,
      retryAfterDenial: false,
    });
    await page.close();
  }
  // No tiles / no internet: geometry, controls and roadmap still work.
  const context = await browser.newContext({ offline: true }),
    page = await context.newPage();
  await page.goto(pathToFileURL(resolve("docs/generated-answer.html")).href);
  await page.locator("[data-artifact-kind]").waitFor();
  assert.equal(await page.locator(".journey-pin").count(), 4);
  assert.match(
    await page.locator(".map-fallback-note").innerText(),
    /取得できません/,
  );
  await page.locator(".stop-choice").nth(2).click();
  assert.match(await page.locator(".map-selection h3").innerText(), /まいか/);
  report.offline = { pins: 4, selectionWorks: true, limitationsVisible: true };
  await context.close();
  const sampleHtml = await readFile("docs/life-roadmap.html", "utf8");
  const sample = JSON.parse(
    sampleHtml.match(
      /<script id="visual-data" type="application\/json">([\s\S]*?)<\/script>/,
    )[1],
  );
  const hostile = newTask({
    query: "人生計画",
    urls: ["https://www.hotpepper.jp/strJ001100102/"],
    maxSteps: 10,
    maxPages: 2,
    timeoutSeconds: 10,
  });
  hostile.answer = {
    summary: "表示安全性のテスト",
    candidates: [],
    limitations: [],
    visualArtifact: sample.artifact,
  };
  hostile.answer.visualArtifact.title =
    '</script><img src=x onerror="window.pwned=1">';
  hostile.answer.visualArtifact.milestones[0].action =
    "<script>window.pwned=1</script>";
  await writeFile(out + "/hostile.html", renderAnswerHtml(hostile));
  const security = await browser.newPage();
  await security.goto(pathToFileURL(resolve(out + "/hostile.html")).href);
  await security.locator("[data-artifact-kind]").waitFor();
  assert.equal(await security.evaluate(() => window.pwned), undefined);
  assert.equal(await security.locator("#visual-artifact img").count(), 0);
  report.untrustedMarkupEscaped = true;
  await security.close();
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(
    "docs/evidence/visual-artifact-qa.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
