import { prepareAnswerMedia } from "./answer-media.js";
import { runTask, type RunOptions } from "./runtime.js";
import { agentEngine } from "./codex.js";
import { Store } from "./store.js";
import {
  planOpenShellTask,
  executeOpenShellPlan,
  type OpenShellTaskOptions,
} from "./sandbox.js";
import type { Task } from "./types.js";
import { runCodexSandbox, configuredCodexSandbox } from "./codex-sandbox.js";
import { recoverSandboxTask } from "./sandbox-artifacts.js";
import { createResearchProfile } from "./runtime-profile.js";
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
export function createOpenShellExecutor(
  config: Pick<OpenShellTaskOptions, "gateway" | "image" | "provider">,
): RuntimeExecutor {
  return async (options, store = new Store()) => {
    const started = performance.now();
    options.signal?.throwIfAborted();
    if (agentEngine(options.agent) !== "pi-openrouter")
      throw new Error(
        "選択エンジンのOpenShell実行は認証連携が未対応です。RUNTIME_EXECUTOR=localで利用してください。",
      );
    if (options.benchmark || options.headed)
      throw new Error(
        "OpenShell: benchmark / headed は未対応です。ローカルへ切り替えず停止しました。",
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
      interactionMode: options.interactionMode,
      deepenRounds: options.deepenRounds,
      model: options.model,
      improvement: options.improvement,
    });
    options.onProgress?.(
      `sandbox: ${plan.sandboxName} / gateway: ${plan.gateway}`,
    );
    const result = await executeOpenShellPlan(plan, {
      confirmed: true,
      signal: options.signal,
      onOutput: (stream, text) => {
        if (stream === "stderr") options.onProgress?.(text);
      },
    });
    if (!result.observedSandbox)
      throw new Error(
        `OpenShell sandbox の発行を確認できません。ローカルへ切り替えず停止しました。${plan.directory}`,
      );
    if (
      !result.commands.some(
        (c) => c.label === "download-artifacts" && c.exitCode === 0,
      )
    )
      throw new Error(
        `OpenShell成果物の回収を確認できません。${plan.directory}`,
      );
    const task = await recoverSandboxTask(result.artifactsDirectory, {
      ...options,
      agent: "pi-openrouter",
      artifactNonce: plan.artifactNonce,
    });
    task.parentId = options.parentId;
    task.goalId = options.goalId;
    if (result.status === "failed" && task.status === "succeeded") {
      task.status = "partial";
      task.error =
        "sandboxの実行終了を正常確認できませんでした。回収できた回答を保持します";
    }
    task.interactionMode = options.interactionMode ?? "approval";
    task.execution = {
      target: "openshell",
      isolation: "openshell-sandbox",
      gateway: plan.gateway,
      sandboxName: plan.sandboxName,
      sandboxId: result.observedSandbox.id,
      image: plan.image,
      artifactsDirectory: result.artifactsDirectory,
      elapsedMs: Math.round(performance.now() - started),
      cleanupStatus: result.cleanupStatus,
    };
    await prepareAnswerMedia(task, store.dir(task.id));
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
  if (
    process.env.RUNTIME_DEPLOYMENT &&
    process.env.RUNTIME_DEPLOYMENT !== "single-user"
  )
    throw new Error(
      "このruntimeはsingle-user専用です。共有サービスの認証・tenant分離は未対応です",
    );
  if (runtimeTarget() === "local") return runTask;
  const gateway = process.env.OPENSHELL_GATEWAY;
  if (!gateway)
    throw new Error("OPENSHELL_GATEWAY に登録済みgateway名を指定してください");
  const pi = createOpenShellExecutor({
    gateway,
    image: process.env.OPENSHELL_IMAGE,
    provider: process.env.OPENSHELL_PROVIDER,
  });
  return (options, store) => {
    createResearchProfile(options.urls);
    return agentEngine(options.agent) === "codex"
      ? runCodexSandbox(
          { ...options, agent: "codex" },
          store,
          configuredCodexSandbox(),
        )
      : pi(options, store);
  };
}
