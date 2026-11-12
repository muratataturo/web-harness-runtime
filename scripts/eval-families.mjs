import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { agentEngine } from "../dist/codex.js";
import { config } from "dotenv";
import { configuredRuntime, runtimeTarget } from "../dist/executors.js";
import { interactionMode } from "../dist/interaction.js";
import { verifyDetail } from "../dist/detail-contracts.js";
config({ quiet: true });
const runTask = configuredRuntime();
const definitions = JSON.parse(
  await readFile(
    new URL("../examples/codex-family-evals.json", import.meta.url),
    "utf8",
  ),
);
const cli = new Command()
  .option("--mode <mode>", "auto / approval", interactionMode, "approval")
  .option("--agent <engine>", "codex / claude-code / pi-openrouter", "codex")
  .option("--model <id>")
  .argument("[sources...]")
  .parse();
const ids = cli.args,
  engine = agentEngine(cli.opts().agent),
  model = cli.opts().model;
const cases = definitions.cases.filter(
  (c) => !ids.length || ids.includes(c.id),
);
if (!cases.length || ids.some((id) => !cases.some((c) => c.id === id)))
  throw new Error("Unknown source ID");
const directory = resolve(
  process.env.RUNTIME_DIR ?? ".runtime",
  "family-evals",
  new Date().toISOString().replaceAll(":", "-") +
    "-" +
    randomUUID().slice(0, 8),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const results = [];
const queue = [...cases];
let quotaExhausted = false;
async function save() {
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify({ agent: engine, model, directory, results }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
}
async function worker() {
  for (;;) {
    if (quotaExhausted || controller.signal.aborted) return;
    const test = queue.shift();
    if (!test) return;
    process.stderr.write(`START ${test.id}\n`);
    const task = await runTask({
      interactionMode: cli.opts().mode,
      agent: engine,
      model,
      query: test.query,
      urls: [test.seedUrl],
      maxSteps: definitions.maxSteps,
      maxPages: definitions.maxPages,
      timeoutSeconds: definitions.timeoutSeconds,
      signal: controller.signal,
      onProgress: (message) => process.stderr.write(`${test.id}: ${message}\n`),
    });
    const verified = task.pages
      .map((p) => verifyDetail(p, test.service))
      .filter((d) => d.status === "verified");
    const candidates = task.answer?.candidates ?? [];
    const r = {
      sourceId: test.id,
      family: test.family,
      label: test.label,
      query: test.query,
      seedUrl: test.seedUrl,
      taskId: task.id,
      interactionMode: cli.opts().mode,
      execution: task.execution,
      executionTarget: runtimeTarget(),
      agent: task.agent,
      model: task.model,
      status: task.status,
      failure: task.failure,
      error: task.error,
      startedAt: task.createdAt,
      finishedAt: task.updatedAt,
      pages: task.pages.map((p) => ({
        url: p.url,
        title: p.title,
        acquisition: p.acquisition,
        detail: verifyDetail(p, test.service),
      })),
      verifiedDetails: new Set(verified.map((d) => d.entityId)).size,
      candidates: candidates.length,
      eligible: candidates.filter((c) => c.eligible).length,
      evidenceCount: task.evidence.length,
      criteria: task.criteria,
      answer: task.answer,
    };
    results.push(r);
    if (task.failure?.kind === "quota_exhausted") quotaExhausted = true;
    await writeFile(
      join(directory, test.id + ".json"),
      JSON.stringify(r, null, 2) + "\n",
      { mode: 0o600 },
    );
    // Per-case files are durable; produce the combined summary only after both workers finish.
    process.stderr.write(
      `DONE ${test.id}: ${task.status}, details=${r.verifiedDetails}, candidates=${r.candidates}, eligible=${r.eligible}\n`,
    );
  }
}
try {
  await Promise.all(Array.from({ length: definitions.parallel }, worker));
  for (const c of queue)
    results.push({
      sourceId: c.id,
      label: c.label,
      status: "not_started",
      reason: quotaExhausted ? "Provider quota exhausted" : "Cancelled",
    });
  results.sort(
    (a, b) =>
      cases.findIndex((c) => c.id === a.sourceId) -
      cases.findIndex((c) => c.id === b.sourceId),
  );
  await save();
  console.log(
    JSON.stringify(
      {
        directory,
        results: results.map((r) => ({
          sourceId: r.sourceId,
          status: r.status,
          details: r.verifiedDetails,
          candidates: r.candidates,
          eligible: r.eligible,
          taskId: r.taskId,
        })),
      },
      null,
      2,
    ),
  );
  process.exitCode = controller.signal.aborted
    ? 130
    : results.some(
          (r) => r.status !== "succeeded" || (r.verifiedDetails ?? 0) < 2,
        )
      ? 2
      : 0;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
