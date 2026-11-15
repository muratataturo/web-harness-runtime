// Compare real model generations on identical captured pages and fixed criteria.
// No HTTP fallback; synthetic navigation padding is explicitly labelled.
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runTask } from "../dist/runtime.js";
import { diagnose } from "../dist/improvement.js";
import { Store } from "../dist/store.js";
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    capture: { type: "string", multiple: true },
    out: { type: "string", default: ".runtime/harness-quality" },
    model: { type: "string" },
    stress: { type: "boolean", default: false },
  },
});
if (!values.baseline || !values.capture?.length) {
  throw new Error(
    "--baseline BASELINE_ROOT --capture TASK_JSON [--capture TASK_JSON] [--stress] [--out DIR]",
  );
}
const baseline = await import(
  pathToFileURL(resolve(values.baseline, "dist/runtime.js")).href
);
const root = resolve(values.out);
await mkdir(root, { recursive: true });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  protocol:
    "same captured pages, criteria, query, model and budgets; baseline first; current independent structural verifier; one sample per case; not a statistical benchmark",
  syntheticNavigationPadding: values.stress ? 24000 : 0,
  cases: [],
};
for (const [index, file] of values.capture.entries()) {
  const captured = JSON.parse(await readFile(file, "utf8"));
  if (!captured.answer || !captured.criteria.length || !captured.pages.length)
    throw new Error("成功した取得Task JSONが必要です");
  const pages = structuredClone(captured.pages);
  if (values.stress)
    for (const p of pages)
      p.text = "ナビゲーション案内。".repeat(2400) + p.text;
  const fixture = { pages, criteria: captured.criteria };
  const fixtureSha256 = createHash("sha256")
    .update(JSON.stringify(fixture))
    .digest("hex");
  const entry = { sourceTaskId: captured.id, fixtureSha256, results: {} };
  for (const [label, execute] of [
    ["before", baseline.runTask],
    ["after", runTask],
  ]) {
    const task = await execute(
      {
        query: captured.query,
        urls: captured.urls,
        agent: "codex",
        model: values.model ?? captured.model,
        interactionMode: "auto",
        maxSteps: 30,
        maxPages: 6,
        timeoutSeconds: 180,
        benchmark: { id: `quality-${index}`, ...fixture },
      },
      new Store(join(root, label)),
    );
    const diagnosis = diagnose(
      task,
      captured.criteria,
      captured.answer.candidates.map((c) => c.url),
    );
    entry.results[label] = {
      taskId: task.id,
      model: task.model,
      status: task.status,
      diagnosis,
      steps: task.steps,
      metrics: task.metrics,
      answer: task.answer,
      evidence: task.evidence,
      error: task.error,
    };
    console.log(
      `${index} ${label}: ${task.status}, required=${diagnosis.supportedRequired}, tokens=${task.metrics?.tokens?.totalTokens ?? "unknown"}`,
    );
  }
  report.cases.push(entry);
  await writeFile(
    join(root, "comparison.json"),
    JSON.stringify(report, null, 2),
  );
}
if (
  report.cases.some(
    (c) =>
      !["succeeded", "partial"].includes(c.results.after.status) ||
      !!c.results.after.diagnosis.validationError ||
      c.results.after.diagnosis.supportedRequired <
        c.results.before.diagnosis.supportedRequired,
  )
)
  process.exitCode = 2;
