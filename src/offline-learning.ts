import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.js";
import {
  ImprovementStore,
  diagnose,
  type ImprovementLoop,
} from "./improvement.js";
import {
  allowedHosts,
  checkNavigation,
  entityKey,
  routeSources,
} from "./sources.js";
import type { Task, Criterion } from "./types.js";
import type { ImprovementContext } from "./improvement-context.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const learningPartition = (group: string) =>
  Number.parseInt(group.slice(-8), 16) % 5 === 0 ? "validation" : "train";
export const learningGroup = (
  query: string,
  criteria: Criterion[],
  urls: string[],
) =>
  digest({
    query: query.normalize("NFKC").trim(),
    criteria,
    entities: [...new Set(urls.map(entityKey))].sort(),
  });
export function bpeState(task: Task, contract: Criterion[], urls: string[]) {
  const d = diagnose(task, contract, urls);
  return {
    belief: {
      capturedPages: task.pages.length,
      verifiedDetails: d.verifiedDetails,
      supportedRequired: d.supportedRequired,
      evidenceIsCurrentTaskOnly: true,
    },
    progress: {
      complete: d.complete,
      unresolvedTargets: d.gaps.length,
      causes: d.causes,
      stepsUsed: task.steps,
    },
    experience: {
      reusableFacts: false,
      purpose: "調査手順のみ。前回の本文・回答は今回の証拠にしない",
    },
  };
}
interface Example {
  id: string;
  group: string;
  taskId: string;
  loopId: string;
  input: ReturnType<typeof bpeState>;
  action: { strategy: ImprovementContext["strategy"]; priorityUrls: string[] };
  complete: boolean;
  reward: number;
  tokens: number | null;
}
interface Recipe {
  group: string;
  taskId: string;
  artifactHash: string;
  agent: Task["agent"];
  model?: string;
  strategy: ImprovementContext["strategy"];
  urls: string[];
  reward: number;
}
export interface OfflineExperience {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  scope: "offline-procedural-experience";
  modelWeightsUpdated: false;
  datasetSha256: string;
  splitAlgorithm: "sha256-last32-mod5-v1";
  trainGroups: string[];
  validationGroups: string[];
  trainExamples: number;
  validationExamples: number;
  rejected: number;
  trainingReadiness:
    | "insufficient-independent-groups"
    | "insufficient-verified-successes"
    | "ready-for-independent-evaluation";
  deployment: "exact-goal-verified-recipe-only";
  recipes: Recipe[];
}
/** Success dominates efficiency. Cheap failures never become successful lessons. */
export function trajectoryReward(
  complete: boolean,
  valid: boolean,
  steps: number,
  limit: number,
  repeated: number,
  pages: number,
) {
  if (!valid) return -5;
  if (!complete) return -1;
  return (
    10 +
    Math.max(0, 1 - steps / Math.max(1, limit)) -
    (0.25 * repeated) / Math.max(1, pages)
  );
}
async function atomic(path: string, value: string) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, path);
}
/** Export compact observable trajectories, not hidden reasoning or scraped training corpora. */
export async function buildOfflineExperience(store = new Store()) {
  const examples: Example[] = [],
    recipeCandidates: Recipe[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const loop of await new ImprovementStore(store).list()) {
    let previous: Task;
    try {
      previous = await store.get(loop.sourceTaskId);
    } catch {
      rejected++;
      continue;
    }
    if (previous.evaluation) {
      rejected++;
      continue;
    }
    for (const iteration of loop.iterations) {
      try {
        const task = await store.get(iteration.taskId);
        if (seen.has(task.id)) continue;
        if (
          task.evaluation ||
          task.query !== loop.query ||
          !task.metrics?.tokens ||
          !task.criteria.length ||
          JSON.stringify(loop.criteria) !== JSON.stringify(task.criteria)
        ) {
          rejected++;
          continue;
        }
        const state = bpeState(previous, loop.criteria, loop.candidateUrls);
        const result = diagnose(
          task,
          loop.criteria,
          loop.candidateUrls,
          loop.allowReplacements,
          loop.minimumCandidates,
        );
        const valid = !result.validationError;
        const complete =
          result.complete && task.status === "succeeded" && !task.failure;
        const reward = trajectoryReward(
          complete,
          valid,
          task.steps,
          task.limits.maxSteps,
          iteration.measurement?.repeatedPages ?? 0,
          task.pages.length,
        );
        const group = learningGroup(
          loop.query,
          loop.criteria,
          loop.candidateUrls,
        );
        const hosts = allowedHosts(routeSources(loop.query, loop.urls));
        const urls = [...new Set(task.evidence.map((e) => e.url))]
          .filter((url) => {
            try {
              checkNavigation(url, hosts);
              return true;
            } catch {
              return false;
            }
          })
          .slice(0, 8);
        examples.push({
          id: digest({ group, taskId: task.id }),
          group,
          taskId: task.id,
          loopId: loop.id,
          input: state,
          action: {
            strategy: iteration.plan.strategy,
            priorityUrls: iteration.plan.priorityUrls,
          },
          complete,
          reward,
          tokens: task.metrics.tokens.totalTokens,
        });
        seen.add(task.id);
        if (complete && valid && urls.length && !loop.allowReplacements)
          recipeCandidates.push({
            group,
            taskId: task.id,
            artifactHash: digest(task),
            agent: task.agent,
            model: task.model,
            strategy: iteration.plan.strategy,
            urls,
            reward,
          });
        previous = task;
      } catch {
        rejected++;
      }
    }
  }
  const groups = [...new Set(examples.map((e) => e.group))].sort();
  // Same question/criteria/entities, parent runs and repeats cannot straddle splits.
  const validationGroups = groups.filter(
    (group) => learningPartition(group) === "validation",
  );
  const trainGroups = groups.filter((g) => !validationGroups.includes(g));
  const train = examples.filter((e) => trainGroups.includes(e.group));
  const validation = examples.filter((e) => validationGroups.includes(e.group));
  const recipes = [
    ...new Map(
      recipeCandidates
        .filter((r) => trainGroups.includes(r.group))
        .sort((a, b) => a.reward - b.reward)
        .map((r) => [r.group + ":" + r.agent + ":" + r.model, r]),
    ).values(),
  ];
  const manifest: OfflineExperience = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    scope: "offline-procedural-experience",
    modelWeightsUpdated: false,
    datasetSha256: digest({ train, validation }),
    splitAlgorithm: "sha256-last32-mod5-v1",
    trainGroups,
    validationGroups,
    trainExamples: train.length,
    validationExamples: validation.length,
    rejected,
    trainingReadiness:
      trainGroups.length >= 2 && validationGroups.length >= 1
        ? new Set(train.filter((e) => e.complete).map((e) => e.group)).size >=
            2 && validation.some((e) => e.complete)
          ? "ready-for-independent-evaluation"
          : "insufficient-verified-successes"
        : "insufficient-independent-groups",
    deployment: "exact-goal-verified-recipe-only",
    recipes,
  };
  const root = join(store.root, "learning");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, manifest.id);
  await mkdir(directory, { mode: 0o700 });
  await atomic(
    join(directory, "train.jsonl"),
    train.map((e) => JSON.stringify(e)).join("\n") + (train.length ? "\n" : ""),
  );
  await atomic(
    join(directory, "validation.jsonl"),
    validation.map((e) => JSON.stringify(e)).join("\n") +
      (validation.length ? "\n" : ""),
  );
  await atomic(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await atomic(
    join(root, "experience.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
/** Recipes are planning priors. Every recall revalidates its source; never copy facts. */
export async function recallOfflineExperience(
  loop: ImprovementLoop,
  store: Store,
) {
  try {
    const manifest: OfflineExperience = JSON.parse(
      await readFile(join(store.root, "learning", "experience.json"), "utf8"),
    );
    if (
      manifest.schemaVersion !== 1 ||
      manifest.splitAlgorithm !== "sha256-last32-mod5-v1" ||
      manifest.scope !== "offline-procedural-experience" ||
      manifest.modelWeightsUpdated !== false
    )
      return;
    const group = learningGroup(loop.query, loop.criteria, loop.candidateUrls);
    if (
      !manifest.trainGroups.includes(group) ||
      manifest.validationGroups.includes(group)
    )
      return;
    const recipe = manifest.recipes.find(
      (r) =>
        r.group === group && r.agent === loop.agent && r.model === loop.model,
    );
    if (
      !recipe ||
      !["targeted-links", "broader-links", "render-and-recheck"].includes(
        recipe.strategy,
      )
    )
      return;
    const task = await store.get(recipe.taskId);
    if (
      task.evaluation ||
      task.query !== loop.query ||
      digest(task) !== recipe.artifactHash ||
      !diagnose(
        task,
        loop.criteria,
        loop.candidateUrls,
        false,
        loop.minimumCandidates,
      ).complete
    )
      return;
    const hosts = allowedHosts(routeSources(loop.query, loop.urls));
    const evidenceUrls = new Set(task.evidence.map((e) => e.url));
    const urls = recipe.urls.filter((url) => {
      try {
        checkNavigation(url, hosts);
        return evidenceUrls.has(url);
      } catch {
        return false;
      }
    });
    if (!urls.length) return;
    return {
      datasetId: manifest.id,
      datasetSha256: manifest.datasetSha256,
      taskId: recipe.taskId,
      strategy: recipe.strategy,
      urls,
    };
  } catch {
    return;
  }
}
