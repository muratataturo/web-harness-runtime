import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";

const report = resolve(process.argv[2] || "docs/vehicle3d/index.html");
const out = resolve(process.argv[3] || ".runtime/vehicle3d/report-qa");
await mkdir(out, { recursive: true });
const errors = [],
  requests = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ].find(existsSync),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.goto(pathToFileURL(report).href);
  const result = JSON.parse(
    await readFile(resolve("docs/vehicle3d/result.json"), "utf8"),
  );
  const expected = `${result.final_test.baseline.mean_iou.toFixed(3)} → ${result.final_test.reconstructed.mean_iou.toFixed(3)}`;
  assert.equal(
    await page.getByText(expected, { exact: true }).count(),
    1,
    "Headline must use final test, not selection scores",
  );
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.complete),
  );
  assert.equal(
    await page
      .locator("img")
      .evaluateAll((images) => images.every((i) => i.naturalWidth > 0)),
    true,
  );
  const mesh = await page.locator("#mesh").textContent();
  assert.ok(JSON.parse(mesh).count > 1000);
  const canvas = page.locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  const before = await canvas.screenshot();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, {
    steps: 8,
  });
  await page.mouse.up();
  assert.notDeepEqual(
    before,
    await canvas.screenshot(),
    "Real mesh must rotate",
  );
  assert.equal(
    await canvas.evaluate((c) => c.getContext("webgl").getError()),
    0,
  );
  await page.getByRole("button", { name: "視点を戻す" }).click();
  await page.screenshot({
    path: `${out}/desktop.jpg`,
    fullPage: true,
    type: "jpeg",
    quality: 75,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${out}/mobile.jpg`,
    fullPage: true,
    type: "jpeg",
    quality: 75,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [], "Report must work offline");
  const imageMetrics = JSON.parse(
    await readFile(resolve("docs/vehicle3d/image-metrics.json"), "utf8"),
  );
  assert.equal(imageMetrics.primary_metric, "reference_roi PSNR + SSIM");
  assert.equal(result.deliverable_accepted, false);
  await page.goto(
    pathToFileURL(resolve("docs/vehicle3d/image-audit.html")).href,
  );
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.complete && i.naturalWidth > 0),
  );
  const input = imageMetrics.variants.delivered.input_target_fit.reference_roi;
  assert.ok(
    (await page.locator("body").innerText()).includes(
      `PSNR ${input.psnr_db.toFixed(2)} dB / SSIM ${input.ssim.toFixed(3)}`,
    ),
  );
  const score = imageMetrics.variants.delivered.aggregate.reference_roi;
  assert.ok(
    (await page.locator("body").innerText()).includes(
      score.pooled_psnr_db.toFixed(2),
    ),
  );
  assert.ok(
    (await page.locator("body").innerText()).includes(
      score.mean_ssim.toFixed(3),
    ),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: `${out}/image-audit-mobile.jpg`,
    fullPage: true,
    type: "jpeg",
    quality: 75,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: `${out}/image-audit-desktop.jpg`,
    fullPage: true,
    type: "jpeg",
    quality: 75,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const receipt = JSON.parse(
    await readFile(resolve("docs/vehicle3d/receipt.json"), "utf8"),
  );
  assert.equal(receipt.physicalAccuracyCertified, false);
  for (const [name, expected] of Object.entries(receipt.sourceFiles)) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(resolve(name)))
        .digest("hex"),
      expected,
      `Source changed after publication: ${name}`,
    );
  }
  for (const [name, expected] of Object.entries(receipt.reviewFiles)) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(resolve("docs/vehicle3d", name)))
        .digest("hex"),
      expected.sha256,
      `Review artifact changed: ${name}`,
    );
  }
  await writeFile(
    `${out}/checks.json`,
    JSON.stringify(
      {
        status: "passed",
        offline: true,
        meshRotates: true,
        desktop: true,
        mobile: true,
        actualRenderImageMetrics: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Vehicle3D report: offline images, real mesh rotation, desktop/mobile passed",
  );
} finally {
  await browser.close();
}
