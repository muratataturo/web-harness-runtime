import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask, type RunOptions } from "./runtime.js";
import { agentEngine } from "./codex.js";
import { Store } from "./store.js";
import {
  planOpenShellTask,
  executeOpenShellPlan,
  type OpenShellTaskOptions,
} from "./sandbox.js";
import type { Task } from "./types.js";
export type RuntimeExecutor = (
  options: RunOptions,
  store?: Store,
) => Promise<Task>;
export function runtimeTarget(): "local" | "openshell" {
  const value = process.env.RUNTIME_EXECUTOR ?? "local";
  if (value !== "local" && value !== "openshell")
    throw new Error("RUNTIME_EXECUTOR は local または openshell です");
  return value;
}
async function taskFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const item of entries) {
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory())
      paths.push(...(await taskFiles(join(root, item.name), depth + 1)));
    else if (item.name === "task.json") paths.push(join(root, item.name));
  }
  return paths;
}
export function createOpenShellExecutor(
  config: Pick<OpenShellTaskOptions, "gateway" | "image" | "provider">,
): RuntimeExecutor {
  return async (options, store = new Store()) => {
    options.signal?.throwIfAborted();
    if (agentEngine(options.agent) !== "pi-openrouter")
      throw new Error(
        "選択エンジンのOpenShell実行は認証連携が未対応です。RUNTIME_EXECUTOR=localで利用してください。",
      );
    const plan = planOpenShellTask({
      query: options.query,
      urls: options.urls,
      gateway: config.gateway,
      image: config.image,
      provider: config.provider,
      maxSteps: options.maxSteps,
      maxPages: options.maxPages,
      timeoutSeconds: options.timeoutSeconds,
    });
    options.onProgress?.(
      `sandbox: ${plan.sandboxName} / gateway: ${plan.gateway}`,
    );
    const result = await executeOpenShellPlan(plan, {
      confirmed: true,
      signal: options.signal,
      onOutput: (_stream, text) => options.onProgress?.(text.slice(-1000)),
    });
    const files = await taskFiles(result.artifactsDirectory).catch(() => []);
    const tasks: Task[] = [];
    for (const file of files) {
      const task = JSON.parse(await readFile(file, "utf8")) as Task;
      if (
        task.query !== options.query ||
        !/^[a-zA-Z0-9-]+$/.test(task.id) ||
        !Array.isArray(task.urls) ||
        task.urls.join("\n") !== options.urls.join("\n")
      )
        continue;
      if (
        ![
          "succeeded",
          "partial",
          "blocked",
          "failed",
          "cancelled",
          "timed_out",
        ].includes(task.status)
      )
        continue;
      if (
        !Array.isArray(task.pages) ||
        !Array.isArray(task.evidence) ||
        !Array.isArray(task.criteria) ||
        !Array.isArray(task.sources)
      )
        continue;
      tasks.push(task);
    }
    if (tasks.length !== 1)
      throw new Error(
        `OpenShell: ${result.status}; タスク成果物を一意に回収できません。${plan.directory} を確認してください`,
      );
    const task = tasks[0]!;
    task.parentId = options.parentId;
    task.goalId = options.goalId;
    await store.save(task);
    await store.event(task.id, "sandbox_import", {
      sandbox: plan.sandboxName,
      gateway: plan.gateway,
      executionStatus: result.status,
    });
    return task;
  };
}
export function configuredRuntime(): RuntimeExecutor {
  if (runtimeTarget() === "local") return runTask;
  const gateway = process.env.OPENSHELL_GATEWAY;
  if (!gateway)
    throw new Error("OPENSHELL_GATEWAY に登録済みgateway名を指定してください");
  return createOpenShellExecutor({
    gateway,
    image: process.env.OPENSHELL_IMAGE,
    provider: process.env.OPENSHELL_PROVIDER,
  });
}
