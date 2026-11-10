import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  openShellPolicy,
  runOpenShellCommand,
  openShellHostEnvironment,
  type SandboxCommand,
} from "./sandbox.js";
import { routeSources, allowedHosts } from "./sources.js";
import { recoverSandboxTask } from "./sandbox-artifacts.js";
import {
  buildRuntimeSnapshot,
  snapshotInstallScript,
} from "./runtime-snapshot.js";
import { Store } from "./store.js";
import type { RunOptions } from "./runtime.js";
import type { Task } from "./types.js";

export interface CodexSandboxConfig {
  gateway: string;
  name?: string;
  image?: string;
}
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9-]{0,18}$/.test(value))
    throw new Error("Codex gateway/worker名は英小文字始まりの19文字以内です");
  return value;
};
export function codexSandboxConfig(config: CodexSandboxConfig) {
  const gateway = identifier(config.gateway),
    name = identifier(config.name ?? "wh-codex");
  const image = config.image ?? "web-harness-codex:local";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image))
    throw new Error("不正なCodexイメージ名");
  return { gateway, name, image };
}
export function configuredCodexSandbox(): CodexSandboxConfig {
  if (!process.env.OPENSHELL_GATEWAY)
    throw new Error("OPENSHELL_GATEWAYが必要です");
  return codexSandboxConfig({
    gateway: process.env.OPENSHELL_GATEWAY,
    name: process.env.OPENSHELL_CODEX_SANDBOX,
    image: process.env.OPENSHELL_CODEX_IMAGE,
  });
}
export function codexSandboxPolicy(urls: string[] = [], nativePath?: string) {
  if (
    nativePath &&
    !/^\/usr\/local\/lib\/node_modules\/@openai\/codex\/node_modules\/@openai\/codex-linux-(arm64|x64)\/vendor\/(aarch64|x86_64)-unknown-linux-musl\/bin\/codex$/.test(
      nativePath,
    )
  )
    throw new Error("不正な公式Codex native path");
  const hosts = urls.length
    ? allowedHosts(routeSources("research", urls))
    : ["chatgpt.com"];
  return (
    openShellPolicy(hosts) +
    [
      "  codex_subscription:",
      "    endpoints:",
      ...["auth.openai.com", "chatgpt.com", "api.openai.com"].flatMap(
        (host) => [
          `      - host: ${host}`,
          "        port: 443",
          "        tls: skip",
        ],
      ),
      "    binaries:",
      "      - path: /usr/local/bin/codex-native",
      ...(nativePath ? [`      - path: ${nativePath}`] : []),
      "",
    ].join("\n")
  );
}
function command(
  config: CodexSandboxConfig,
  label: string,
  args: string[],
): SandboxCommand {
  return {
    executable: "openshell",
    label,
    args: ["-g", config.gateway, ...args],
  };
}
async function run(
  config: CodexSandboxConfig,
  label: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 30000,
) {
  const result = await runOpenShellCommand(command(config, label, args), {
    signal,
    timeoutMs,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `OpenShell ${label}: ${result.stderr.slice(-1200) || result.exitCode}`,
    );
  return result;
}
async function inspect(config: ReturnType<typeof codexSandboxConfig>) {
  const result = await runOpenShellCommand(
    command(config, "inspect-codex-worker", [
      "sandbox",
      "get",
      config.name,
      "--output",
      "json",
    ]),
    { timeoutMs: 15000 },
  );
  if (result.exitCode !== 0) {
    if (/not found|not exist/i.test(result.stderr)) return undefined;
    throw new Error(
      `Codex workerを確認できません: ${result.stderr.slice(-500)}`,
    );
  }
  const value = JSON.parse(result.stdout);
  if (
    value.name !== config.name ||
    value.labels?.["web-harness-role"] !== "codex-worker" ||
    typeof value.id !== "string"
  )
    throw new Error("指定sandboxはこのruntimeのCodex workerではありません");
  return {
    id: value.id as string,
    name: value.name as string,
    phase: value.phase as string,
    labels: value.labels as Record<string, string>,
  };
}
async function ready(
  config: ReturnType<typeof codexSandboxConfig>,
  signal?: AbortSignal,
) {
  for (let i = 0; i < 120; i++) {
    signal?.throwIfAborted();
    const state = await inspect(config);
    if (state?.phase === "Ready") return state;
    if (state?.phase === "Error")
      throw new Error(
        "Codex workerの起動に失敗しました。sandbox getで確認してください",
      );
    await delay(500, undefined, { signal });
  }
  throw new Error("Codex workerの起動待ち時間を超過しました");
}
async function lease<T>(
  config: ReturnType<typeof codexSandboxConfig>,
  action: () => Promise<T>,
  signal?: AbortSignal,
) {
  const dir = resolve(
    process.env.RUNTIME_DIR ?? ".runtime",
    "codex-workers",
    `${config.gateway}-${config.name}`,
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lease");
  let acquired = false;
  for (let i = 0; i < 3600; i++) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock, { mode: 0o700 });
      acquired = true;
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    await delay(250, undefined, { signal });
  }
  if (!acquired)
    throw new Error(
      "Codex workerは別タスク/ログインが使用中です。leaseを確認してください",
    );
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
async function ensure(
  config: ReturnType<typeof codexSandboxConfig>,
  signal?: AbortSignal,
) {
  let state = await inspect(config);
  if (!state) {
    const dir = resolve(
      process.env.RUNTIME_DIR ?? ".runtime",
      "codex-workers",
      `${config.gateway}-${config.name}`,
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const policy = join(dir, "policy.yaml");
    await writeFile(policy, codexSandboxPolicy(), { mode: 0o600 });
    await run(
      config,
      "create-codex-worker",
      [
        "sandbox",
        "create",
        "--name",
        config.name,
        "--from",
        config.image,
        "--label",
        "web-harness-role=codex-worker",
        "--no-auto-providers",
        "--policy",
        policy,
        "--cpu",
        "2",
        "--memory",
        "4Gi",
        "--env",
        "HOME=/sandbox",
        "--env",
        "CODEX_HOME=/sandbox/.codex",
        "--env",
        "CODEX_BIN=/usr/local/bin/codex-native",
        "--env",
        "AGENT_BROWSER_EXECUTABLE_PATH=/opt/web-harness/infra/openshell/chromium",
        "--detach",
        "--",
        "/usr/local/bin/node",
        "/opt/web-harness/dist/codex-worker.js",
      ],
      signal,
      300000,
    );
  } else if (state.phase !== "Ready") {
    await run(
      config,
      "start-codex-worker",
      ["sandbox", "start", config.name],
      signal,
      180000,
    );
  }
  return ready(config, signal);
}
async function check(
  config: ReturnType<typeof codexSandboxConfig>,
  signal?: AbortSignal,
) {
  const result = await runOpenShellCommand(
    command(config, "check-codex-login", [
      "sandbox",
      "exec",
      config.name,
      "--no-login-shell",
      "--timeout",
      "25",
      "--",
      "/usr/local/bin/node",
      "/opt/web-harness/dist/codex-worker.js",
      "--check",
    ]),
    { signal, timeoutMs: 30000 },
  );
  const value = JSON.parse(result.stdout.trim());
  return {
    authenticated:
      value.authenticated === true && value.authentication === "chatgpt",
    models: Array.isArray(value.models) ? (value.models as string[]) : [],
  };
}
export async function setupCodexSandbox(input: CodexSandboxConfig) {
  const config = codexSandboxConfig(input);
  return lease(config, async () => {
    const state = await ensure(config);
    return { ...state, ...(await check(config)) };
  });
}
export async function codexSandboxStatus(input = configuredCodexSandbox()) {
  const config = codexSandboxConfig(input),
    state = await inspect(config);
  if (!state)
    return {
      configured: false,
      authenticated: false,
      phase: "missing",
      models: [] as string[],
    };
  const auth =
    state.phase === "Ready"
      ? await check(config)
      : { authenticated: false, models: [] as string[] };
  return { configured: true, phase: state.phase, ...auth };
}
/** Login uses the user's terminal. Device codes and auth files never enter task artifacts. */
export async function loginCodexSandbox(input: CodexSandboxConfig) {
  const config = codexSandboxConfig(input);
  return lease(config, async () => {
    await ensure(config);
    await new Promise<void>((ok, no) => {
      const cmd = command(config, "login-codex-worker", [
        "sandbox",
        "exec",
        config.name,
        "--no-login-shell",
        "--tty",
        "--",
        "/usr/local/bin/codex-native",
        "login",
        "--device-auth",
        "-c",
        'cli_auth_credentials_store="file"',
      ]);
      const child = spawn(process.env.OPENSHELL_BIN ?? "openshell", cmd.args, {
        env: openShellHostEnvironment(),
        stdio: "inherit",
        shell: false,
      });
      child.once("error", no);
      child.once("close", (code) =>
        code === 0
          ? ok()
          : no(new Error(`Codexログインを完了できませんでした (${code})`)),
      );
    });
    const auth = await check(config);
    if (!auth.authenticated)
      throw new Error(
        "CodexのChatGPTログインを確認できません。APIキーには切り替えません",
      );
    return {
      authenticated: true,
      authentication: "chatgpt",
      sandboxName: config.name,
    };
  });
}
export async function runCodexSandbox(
  options: RunOptions,
  store = new Store(),
  input = configuredCodexSandbox(),
): Promise<Task> {
  const config = codexSandboxConfig(input);
  if (options.agent !== "codex" || options.benchmark || options.headed)
    throw new Error("Codex workerはcodexの公開調査のみ対応します");
  options.onProgress?.("Codex account-workerの空きと起動状態を確認しています");
  return lease(
    config,
    async () => {
      const started = performance.now(),
        id = randomUUID(),
        dir = resolve(store.root, "codex-workers", "runs", id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let stopped = false;
      try {
        const state = await ensure(config, options.signal);
        const auth = await check(config, options.signal);
        if (!auth.authenticated)
          throw new Error(
            "Codex workerのChatGPTログインが必要です。sandbox codex loginを実行してください。ローカル/API/piへ切り替えません",
          );
        if (options.model && !auth.models.includes(options.model))
          throw new Error(
            `Codex workerに指定モデルがありません: ${options.model}`,
          );
        const policyPath = join(dir, "policy.yaml");
        const nativeProbe = await run(
          config,
          "codex-native-layout",
          [
            "sandbox",
            "exec",
            config.name,
            "--no-login-shell",
            "--",
            "/usr/local/bin/node",
            "-e",
            "const fs=require('node:fs');const arch=process.arch;const triple=arch==='arm64'?'aarch64':'x86_64';const p='/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-'+arch+'/vendor/'+triple+'-unknown-linux-musl/bin/codex';if(!fs.existsSync(p)||!fs.existsSync(p+'-code-mode-host'))throw Error('Codex package layout incomplete');console.log(JSON.stringify({nativePath:p}));",
          ],
          options.signal,
        );
        const nativePath = JSON.parse(nativeProbe.stdout).nativePath as string;
        await writeFile(
          policyPath,
          codexSandboxPolicy(options.urls, nativePath),
          {
            mode: 0o600,
          },
        );
        await run(
          config,
          "set-research-policy",
          ["policy", "set", config.name, "--policy", policyPath, "--wait"],
          options.signal,
        );
        const guestRoot = `/sandbox/results/${id}`;
        const snapshot = await buildRuntimeSnapshot(dir);
        const guestArchive = `/sandbox/bundles/${id}.tar.gz`;
        await run(
          config,
          "upload-runtime-snapshot",
          [
            "sandbox",
            "upload",
            config.name,
            snapshot.archive,
            guestArchive,
            "--no-git-ignore",
          ],
          options.signal,
          90000,
        );
        await run(
          config,
          "install-runtime-snapshot",
          [
            "sandbox",
            "exec",
            config.name,
            "--no-login-shell",
            "--timeout",
            "30",
            "--",
            "/usr/local/bin/node",
            "-e",
            snapshotInstallScript(snapshot.revision, guestArchive),
          ],
          options.signal,
          40000,
        );
        const args = [
          "sandbox",
          "exec",
          config.name,
          "--no-login-shell",
          "--timeout",
          String(options.timeoutSeconds + 20),
          "--env",
          `RUNTIME_DIR=${guestRoot}`,
          "--env",
          "WEB_HARNESS_MANAGED_WORKER=codex",
          "--env",
          "CODEX_BIN=/usr/local/bin/codex",
          "--",
          "/usr/local/bin/node",
          `/sandbox/runtime/${snapshot.revision}/dist/cli.js`,
          "run",
          options.query,
          "--agent",
          "codex",
          "--openshell-outer-sandbox",
          "--mode",
          options.interactionMode ?? "approval",
          "--url",
          ...options.urls,
          "--max-steps",
          String(options.maxSteps),
          "--max-pages",
          String(options.maxPages),
          "--timeout",
          String(options.timeoutSeconds),
          "--deepen-rounds",
          String(options.deepenRounds ?? 2),
        ];
        if (options.model) args.push("--model", options.model);
        if (options.improvement)
          args.push(
            "--improvement-context",
            Buffer.from(JSON.stringify(options.improvement)).toString(
              "base64url",
            ),
          );
        args.push("--json");
        options.onProgress?.(`Codex MicroVM: ${config.name} (${state.id})`);
        const execution = await runOpenShellCommand(
          command(config, "run-codex-task", args),
          {
            signal: options.signal,
            timeoutMs: (options.timeoutSeconds + 60) * 1000,
            onOutput: (_stream, text) => options.onProgress?.(text.slice(-800)),
          },
        );
        await run(
          config,
          "download-codex-task",
          [
            "sandbox",
            "download",
            config.name,
            guestRoot,
            join(dir, "artifacts"),
          ],
          undefined,
          90000,
        );
        const task = await recoverSandboxTask(join(dir, "artifacts"), options);
        task.parentId = options.parentId;
        task.goalId = options.goalId;
        task.execution = {
          target: "openshell",
          isolation: "openshell-sandbox",
          gateway: config.gateway,
          sandboxName: config.name,
          sandboxId: state.id,
          image: config.image,
          artifactsDirectory: join(dir, "artifacts"),
          allocation: "account-worker",
          runtimeRevision: snapshot.revision,
          innerSandbox: "externalSandbox",
          elapsedMs: Math.round(performance.now() - started),
          cleanupStatus: "unconfirmed",
        };
        stopped =
          (
            await runOpenShellCommand(
              command(config, "stop-codex-worker", [
                "sandbox",
                "stop",
                config.name,
              ]),
              { timeoutMs: 15000 },
            )
          ).exitCode === 0;
        task.execution.cleanupStatus = stopped ? "stopped" : "unconfirmed";
        if (execution.exitCode !== 0 && task.status === "succeeded") {
          task.status = "partial";
          task.error = "VM実行終了を正常確認できませんでした。回答を保持します";
        }
        await store.save(task);
        await store.event(task.id, "sandbox_import", {
          sandbox: config.name,
          sandboxId: state.id,
          allocation: "account-worker",
          auth: "chatgpt",
        });
        return task;
      } finally {
        if (!stopped)
          await runOpenShellCommand(
            command(config, "stop-codex-worker", [
              "sandbox",
              "stop",
              config.name,
            ]),
            { timeoutMs: 15000 },
          ).catch(() => {});
      }
    },
    options.signal,
  );
}
