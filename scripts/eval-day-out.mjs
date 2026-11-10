import { config } from "dotenv";
import { Command } from "commander";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runTask } from "../dist/runtime.js";
import { improveTask } from "../dist/improvement.js";
import { Store } from "../dist/store.js";
import { agentEngine } from "../dist/codex.js";
config({ quiet: true });
process.umask(0o077);
const cli = new Command()
  .option("--agent <engine>", "実行エンジン", "codex")
  .option("--model <id>", "モデルID")
  .option("--parallel <n>", "並列1〜2", Number, 2)
  .option("--persona <ids...>")
  .option("--no-improve", "追加自己改善を無効にする")
  .parse();
const opts = cli.opts();
if (!Number.isInteger(opts.parallel) || opts.parallel < 1 || opts.parallel > 2)
  throw Error("parallelは1〜2");
const definition = JSON.parse(
  await readFile(
    new URL("../examples/day-out-personas.json", import.meta.url),
    "utf8",
  ),
);
const profiles = definition.personas.filter(
  (p) => !opts.persona?.length || opts.persona.includes(p.id),
);
if (
  !profiles.length ||
  opts.persona?.some((id) => !profiles.some((p) => p.id === id))
)
  throw Error("不明なpersona");
const store = new Store(),
  id = randomUUID(),
  dir = resolve(store.root, "day-out-evals", id);
await mkdir(dir, { recursive: true, mode: 0o700 });
const controller = new AbortController(),
  cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const results = [],
  queue = [...profiles],
  started = performance.now();
let stoppedReason;
const save = async () => {
  const report = {
    id,
    date: definition.date,
    locationAssumption: definition.locationAssumption,
    parallel: opts.parallel,
    batchWallMs: Math.round(performance.now() - started),
    measurementScope:
      "runTask + up to one improveTask + local artifact I/O; excludes setup/development/research outside runtime",
    results,
    notRun: queue.map((p) => p.id),
    stoppedReason,
  };
  const tmp = join(dir, randomUUID() + ".tmp");
  await writeFile(tmp, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(tmp, join(dir, "report.json"));
  return report;
};
async function worker() {
  for (;;) {
    if (controller.signal.aborted || stoppedReason) return;
    const p = queue.shift();
    if (!p) return;
    const at = performance.now();
    let task, loop, error;
    const tasks = [];
    try {
      task = await runTask(
        {
          query: p.query,
          urls: p.urls,
          agent: agentEngine(opts.agent),
          model: opts.model,
          maxSteps: 90,
          timeoutSeconds: 240,
          maxPages: 14,
          deepenRounds: 2,
          signal: controller.signal,
          onProgress: (m) => process.stderr.write(`${p.id}: ${m}\n`),
        },
        store,
      );
      tasks.push(task);
      if (
        opts.improve &&
        task.status === "partial" &&
        task.answer?.candidates.length &&
        task.criteria.length &&
        !controller.signal.aborted
      ) {
        loop = await improveTask(
          task.id,
          {
            maxIterations: 1,
            timeoutSeconds: 120,
            signal: controller.signal,
            onProgress: (m) => process.stderr.write(`${p.id}: ${m}\n`),
          },
          store,
        );
        for (const i of loop.iterations) tasks.push(await store.get(i.taskId));
        task = await store.get(loop.bestTaskId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (process.env.OPENROUTER_API_KEY)
        error = error.split(process.env.OPENROUTER_API_KEY).join("[REDACTED]");
    }
    const usage =
      tasks.length && tasks.every((t) => !!t.metrics?.tokens)
        ? tasks.reduce(
            (u, t) => {
              for (const k of [
                "inputTokens",
                "outputTokens",
                "cachedInputTokens",
                "reasoningOutputTokens",
                "totalTokens",
                "cacheWriteInputTokens",
              ])
                u[k] += t.metrics.tokens[k];
              return u;
            },
            {
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 0,
              cacheWriteInputTokens: 0,
            },
          )
        : null;
    results.push({
      personaId: p.id,
      persona: p.persona,
      budgetYen: p.budgetYen,
      budgetBasis: p.budgetBasis,
      query: p.query,
      urls: p.urls,
      elapsedMs: Math.round(performance.now() - at),
      status: loop?.status ?? task?.status ?? "failed",
      error,
      initialTaskId: tasks[0]?.id,
      finalTaskId: task?.id,
      loopId: loop?.id,
      tokens: usage,
      tokenAccounting: !usage
        ? "unavailable"
        : tasks.some(
              (t) =>
                t.error ||
                !t.answer ||
                ["cancelled", "timed_out", "failed"].includes(t.status),
            )
          ? "last-observed-partial"
          : "provider-reported",
      billing: {
        additionalApiUsd:
          tasks.length &&
          tasks.every((t) => t.metrics?.billing.additionalApiUsd === 0)
            ? 0
            : null,
        subscriptionAllocationUsd: null,
        note: "API課金とサブスク/クレジット配賦は別。サブスクのタスク別消費額は未取得",
      },
      attempts: tasks.map((t) => ({
        taskId: t.id,
        status: t.status,
        model: t.model,
        metrics: t.metrics,
        pages: t.pages.map((p) => ({
          url: p.url,
          title: p.title,
          capturedAt: p.capturedAt,
          acquisition: p.acquisition,
        })),
        evidence: t.evidence,
        answer: t.answer,
        retrieval: t.retrieval,
      })),
      answer: task?.answer,
    });
    const fatal = tasks.find(
      (t) =>
        t.failure &&
        [
          "quota_exhausted",
          "authentication",
          "rate_limited",
          "model_unavailable",
        ].includes(t.failure.kind),
    );
    if (fatal) stoppedReason = fatal.failure.action;
    await save();
    process.stderr.write(
      `DONE ${p.id}: ${loop?.status ?? task?.status}, ${(performance.now() - at) / 1000}s\n`,
    );
  }
}
try {
  await Promise.all(
    Array.from({ length: Math.min(opts.parallel, profiles.length) }, worker),
  );
  const report = await save();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = controller.signal.aborted
    ? 130
    : report.notRun.length ||
        report.results.some(
          (r) =>
            !r.answer ||
            ["failed", "blocked", "timed_out", "cancelled"].includes(r.status),
        )
      ? 1
      : report.results.some((r) => r.status !== "succeeded")
        ? 2
        : 0;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
