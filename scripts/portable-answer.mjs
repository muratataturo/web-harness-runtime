// Share the fixed theme CSS without changing any model-produced answer fields.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { renderAnswerHtml } from "../dist/answer-html.js";
export async function exportPortableAnswer(task, outFile) {
  const css = await readFile(
    new URL("../web/artifact-client.bundle.css", import.meta.url),
    "utf8",
  );
  const hash = createHash("sha256").update(css).digest("hex");
  const filename = `theme-${hash}.css`;
  let html = renderAnswerHtml(task);
  const marker = `<style>${css}\n`;
  if (!html.includes(marker)) throw Error("Portable theme marker missing");
  html = html
    .replace(
      marker,
      `<link rel="stylesheet" href="answer-assets/${filename}"><style>\n`,
    )
    .replace("style-src 'unsafe-inline'", "style-src 'self' 'unsafe-inline'");
  await mkdir(join(dirname(outFile), "answer-assets"), { recursive: true });
  await writeFile(join(dirname(outFile), "answer-assets", filename), css);
  await writeFile(outFile, html);
  return { htmlBytes: Buffer.byteLength(html), themeFile: filename };
}
