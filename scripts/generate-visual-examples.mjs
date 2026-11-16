// Portable replay of saved outputs, including the explicitly reviewed final edit. No inference or source requests.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { renderAnswerHtml } from "../dist/answer-html.js";
for (const [name, output] of [
  ["travel", "generated-answer"],
  ["roadmap", "life-roadmap"],
  ["asakusa", "asakusa-day"],
  ["life-actual", "life-roadmap-actual"],
  ["social", "asakusa-social-day"],
  ["comparison-travel", "comparison-travel"],
  ["comparison-life", "comparison-life"],
  ["cafe", "cafe-day"],
]) {
  const task = JSON.parse(
    await readFile(`examples/visual-${name}-answer.json`, "utf8"),
  );
  for (const photo of Object.values(task.answerPhotos ?? {})) {
    if (!/^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/.test(photo.file))
      throw Error("Invalid photo filename");
    const bytes = await readFile(`docs/answer-assets/${photo.file}`);
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      photo.file.split(".")[0]
    )
      throw Error("Photo integrity failed");
  }
  await writeFile(`docs/${output}.html`, renderAnswerHtml(task));
}
console.log(
  "Replayed six model outputs, one source-grounded final edit, and one synthetic roadmap example",
);
