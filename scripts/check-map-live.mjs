// Explicit, manual verification only. CI uses synthetic tiles in eval:visual.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
const html = await readFile("docs/generated-answer.html");
const out = ".runtime/map-fix/live";
await mkdir(out, { recursive: true });
const server = createServer((req, res) => {
  if (req.url !== "/answer.html") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
});
const report = {
  scope:
    "explicit single-viewport manual live verification; no OSM tile traffic",
  checkedAt: new Date().toISOString(),
  cases: [],
  passed: false,
};
try {
  for (const [mode, url] of [
    ["file", pathToFileURL(resolve("docs/generated-answer.html")).href],
    ["http", `http://127.0.0.1:${server.address().port}/answer.html`],
  ]) {
    const page = await browser.newPage({
        viewport: { width: 1240, height: 960 },
      }),
      responses = [],
      errors = [];
    let forbiddenRequests = 0;
    page.on("response", (r) => {
      if (r.url().startsWith("https://cyberjapandata.gsi.go.jp/"))
        responses.push(r.status());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().includes("tile.openstreetmap.org")) forbiddenRequests++;
    });
    await page.goto(url);
    await page.waitForFunction(
      () =>
        document.querySelector(".journey-map")?.dataset.tilesReady === "true" &&
        document.querySelector(".journey-map")?.dataset.mapLoading === "false",
      {},
      { timeout: 25000 },
    );
    assert.deepEqual(errors, []);
    assert.ok(responses.length > 0 && responses.every((s) => s === 200));
    assert.equal(forbiddenRequests, 0);
    assert.equal(await page.locator(".map-fallback-note").count(), 0);
    assert.ok(
      await page
        .locator(".leaflet-control-attribution")
        .innerText()
        .then((t) => t.includes("地理院タイル")),
    );
    const visible = await page
      .locator(".leaflet-tile-loaded")
      .evaluateAll(
        (images) =>
          images.filter(
            (e) => e.naturalWidth === 256 && e.src.startsWith("blob:"),
          ).length,
      );
    assert.ok(visible > 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${out}/map-${mode}.png` });
    report.cases.push({
      mode,
      httpStatuses: [...new Set(responses)],
      tileResponses: responses.length,
      decodedTileImages: visible,
      osmTileRequests: forbiddenRequests,
      attributionVisible: true,
    });
    await page.close();
  }
  report.passed = true;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    "docs/evidence/map-background-live.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
