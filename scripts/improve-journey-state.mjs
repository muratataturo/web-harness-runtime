// One actual self-improvement iteration of the saved live case; never edits its answer.
import { config } from "dotenv";
config({ quiet: true });
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Store } from "../dist/store.js";
import { improveTask, diagnose } from "../dist/improvement.js";
import { runTask } from "../dist/runtime.js";
import { assessJourneyState } from "../dist/journey-state.js";
import { acceptanceRevision } from "./chat-acceptance.mjs";
if (process.argv.length !== 3 || process.argv[2] !== "--live")
  throw Error("Use --live");
const seed = JSON.parse(
  await readFile(
    ".runtime/regional-itinerary/hamamatsu-state-city/latest.json",
    "utf8",
  ),
);
const store = new Store(seed.store),
  revision = await acceptanceRevision();
const loop = await improveTask(
  seed.taskId,
  {
    interactionMode: "auto",
    maxIterations: 1,
    timeoutSeconds: 1200,
    onProgress: (m) => process.stderr.write(m + "\n"),
  },
  store,
  runTask,
);
if ((await acceptanceRevision()) !== revision)
  throw Error("Runtime changed during live improvement");
const iteration = loop.iterations.at(-1);
if (!iteration?.taskId) throw Error("No actual model iteration was performed");
const task = await store.get(iteration.taskId);
const diagnosis = diagnose(
  task,
  task.criteria,
  task.answer?.candidates.map((c) => c.url) ?? [],
  false,
  3,
);
const root = resolve(".runtime/regional-itinerary/hamamatsu-state-improved");
await mkdir(root, { recursive: true });
const report = {
  version: 1,
  caseId: "hamamatsu-state-improved",
  label: "浜松・移動と滞在の自己改善",
  mode: "live-self-improvement",
  scope:
    "actual inference + source re-fetch + host quality gates; HTML display separately verified",
  runtimeRevision: revision,
  parentTaskId: seed.taskId,
  loopId: loop.id,
  loopStatus: loop.status,
  taskId: task.id,
  status: task.status,
  model: task.model,
  steps: task.steps,
  elapsedMs: task.metrics?.elapsedMs,
  answerEdited: false,
  humanResponses: 0,
  passed:
    diagnosis.complete &&
    task.status === "succeeded" &&
    !!task.answer?.actionPlan &&
    assessJourneyState(task, task.answer.actionPlan).status === "passed",
  failure: diagnosis.complete ? undefined : "unresolved host diagnosis",
  store: store.root,
  tripBrief: task.tripBrief,
  journeyAssessment: task.journeyAssessment,
  stepVerification: task.stepVerification,
  diagnosis,
  iteration,
};
await writeFile(
  join(root, "latest.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    taskId: task.id,
    status: task.status,
    passed: report.passed,
    journey: task.journeyAssessment?.status,
    loopStatus: loop.status,
  }),
);
