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
const server = createServer(async (req, res) => {
  const asset = req.url.match(
    /^\/answer-assets\/([a-f0-9]{64}\.(jpg|png|webp|gif|avif))$/,
  );
  if (asset) {
    try {
      const bytes = await readFile("docs/answer-assets/" + asset[1]);
      res.writeHead(200, {
        "Content-Type": asset[2] === "jpg" ? "image/jpeg" : "image/" + asset[2],
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
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
    "live Google map pixels, local experience photos and vector fallback; no OSM tile traffic",
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
    const frame = page.locator(".google-map-preview iframe");
    let googlePreview = false;
    if (await frame.count()) {
      await page
        .locator(".google-map-loading")
        .waitFor({ state: "detached", timeout: 15000 });
      const child = await (await frame.elementHandle())?.contentFrame();
      assert.ok(child, "Google frame must exist");
      await child.waitForFunction(
        () =>
          [...document.images].filter(
            (img) => img.complete && img.naturalWidth > 0,
          ).length > 20 && document.body.innerText.includes("Google"),
        {},
        { timeout: 20000 },
      );
      googlePreview = true;
      if (googlePreview)
        await page.screenshot({ path: `${out}/google-${mode}.png` });
      await page
        .getByRole("button", { name: "行程マップ", exact: true })
        .click();
    }
    for (const image of await page.locator(".experience-card img").all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(
        (img) =>
          new Promise((resolve, reject) => {
            if (img.complete) {
              img.naturalWidth ? resolve(true) : reject(Error("Photo failed"));
            } else {
              img.onload = () => resolve(true);
              img.onerror = () => reject(Error("Photo failed"));
            }
          }),
      );
    }
    const photos = await page.locator(".experience-card img").count();
    assert.equal(photos, 3);
    await page
      .locator("#itinerary")
      .screenshot({ path: `${out}/your-day-${mode}.png` });
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
            (e) =>
              e.tagName === "CANVAS" &&
              e.width >= 256 &&
              e.dataset.vectorReady === "true",
          ).length,
      );
    assert.ok(visible > 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${out}/map-${mode}.png` });
    report.cases.push({
      mode,
      googleMapRendered: googlePreview,
      photosDecoded: photos,
      httpStatuses: [...new Set(responses)],
      tileResponses: responses.length,
      renderedVectorTiles: visible,
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
