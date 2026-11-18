// Solid-background DOM contrast regression. External map contents are out of scope.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const out = ".runtime/social-discovery/contrast";
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
    "computed text contrast on owned HTML; transparent solid ancestors composited; map iframes and disabled controls excluded",
  cases: [],
  passed: false,
};
try {
  for (const file of [
    "docs/generated-answer.html",
    "docs/asakusa-day.html",
    "docs/life-roadmap.html",
    "docs/life-roadmap-actual.html",
    "docs/asakusa-social-day.html",
    "docs/comparison-travel.html",
    "docs/comparison-life.html",
    "docs/cafe-day.html",
    "docs/autonomous-cafe-day.html",
    "docs/hamamatsu-day.html",
    "docs/nagoya-day.html",
    "docs/regional-cases.html",
    "docs/hamamatsu-full-day.html",
    "docs/nagoya-afternoon.html",
    "docs/experience-cases.html",
  ])
    for (const scheme of ["light", "dark"])
      for (const width of [390, 1280]) {
        const page = await browser.newPage({
          colorScheme: scheme,
          viewport: { width, height: 950 },
          reducedMotion: "reduce",
        });
        await page.route(/^https?:/, (r) => r.abort());
        await page.goto(pathToFileURL(resolve(file)).href);
        if (
          !["docs/regional-cases.html", "docs/experience-cases.html"].includes(
            file,
          )
        )
          await page.locator("[data-artifact-kind]").waitFor();
        await page
          .locator("details")
          .evaluateAll((items) => items.forEach((e) => (e.open = true)));
        const audit = await page.evaluate(() => {
          const color = (s) => {
            const n = (s.match(/[\d.]+/g) || []).map(Number);
            return s.startsWith("color(srgb")
              ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1]
              : [n[0], n[1], n[2], n[3] ?? 1];
          };
          const blend = (a, b) =>
            [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3]));
          const luminance = (c) =>
            c.slice(0, 3).reduce((sum, n, i) => {
              const s = n / 255;
              return (
                sum +
                (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][i]
              );
            }, 0);
          let inspected = 0;
          const failures = [];
          for (const e of document.querySelectorAll("body *")) {
            if (
              !e.getClientRects().length ||
              ["STYLE", "SCRIPT"].includes(e.tagName) ||
              e.closest('[disabled],[aria-disabled="true"]') ||
              ![...e.childNodes].some(
                (n) => n.nodeType === 3 && n.textContent.trim(),
              )
            )
              continue;
            const st = getComputedStyle(e);
            if (st.visibility === "hidden") continue;
            let bg = [255, 255, 255];
            const chain = [];
            for (let n = e; n; n = n.parentElement) chain.unshift(n);
            for (const n of chain)
              bg = blend(color(getComputedStyle(n).backgroundColor), bg);
            const fg = blend(color(st.color), bg);
            const l1 = luminance(fg),
              l2 = luminance(bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const large =
              parseFloat(st.fontSize) >= 24 ||
              (parseFloat(st.fontSize) >= 18.66 &&
                parseInt(st.fontWeight) >= 700);
            const min = large ? 3 : 4.5;
            inspected++;
            if (ratio + 0.01 < min)
              failures.push({
                tag: e.tagName,
                class: typeof e.className === "string" ? e.className : "",
                text: e.textContent.trim().slice(0, 60),
                foreground: st.color,
                background: bg,
                ratio: Number(ratio.toFixed(2)),
                minimum: min,
              });
          }
          return { inspected, failures };
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        assert.equal(overflow, false, `${file} ${scheme} ${width} overflow`);
        report.cases.push({ file, scheme, width, ...audit });
        if (file.includes("social") && width === 1280) {
          await page.locator("#discoveries").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${out}/discovery-${scheme}.png` });
        }
        await page.close();
      }
  const failures = report.cases.filter((c) => c.failures.length);
  assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    "docs/evidence/answer-contrast-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    cases: report.cases.length,
    inspected: report.cases.reduce((n, c) => n + c.inspected, 0),
    passed: report.passed,
  }),
);
