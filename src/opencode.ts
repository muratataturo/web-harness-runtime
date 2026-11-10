import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { join, isAbsolute } from "node:path";
import { ResearchMcp } from "./research-mcp.js";
import { opencodeUsage, type TokenUsage } from "./metrics.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const strataModel = "strata-colab/qwen3.8-flash-next-iq2_xs";
export function opencodeBinary() {
  return (
    process.env.OPENCODE_BIN ??
    "/private/tmp/strata-opencode/node_modules/.bin/opencode"
  );
}
export async function strataConnection(
  signal?: AbortSignal,
  requested = process.env.OPENCODE_MODEL ?? strataModel,
) {
  if (!/^strata-colab\/[a-zA-Z0-9._:-]+$/.test(requested))
    throw new Error(
      "OpenCodeは既存strata-colabの明示モデルだけに対応します。別providerへ切り替えません",
    );
  const endpoint = new URL(
    process.env.STRATA_BASE_URL ?? "http://127.0.0.1:18081/v1",
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["http:", "https:"].includes(endpoint.protocol)
  )
    throw new Error("不正なStrata endpoint");
  const keyFile =
    process.env.STRATA_KEY_FILE ?? "/private/tmp/strata-colab-api-key";
  if (!isAbsolute(keyFile))
    throw new Error("STRATA_KEY_FILEは絶対パスで指定してください");
  const key =
    process.env.STRATA_API_KEY ?? (await readFile(keyFile, "utf8")).trim();
  if (!key) throw new Error("既存Strata認証がありません");
  const response = await fetch(
    endpoint.toString().replace(/\/$/, "") + "/models",
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  if (!response.ok)
    throw new Error(
      `既存Strata /models HTTP ${response.status}。GPUを新規割当・再起動しません`,
    );
  const data = (await response.json()) as {
    data?: { id: string; meta?: { n_ctx?: number } }[];
  };
  const model = data.data?.find(
    (m) => m.id === requested.slice("strata-colab/".length),
  );
  const context = model?.meta?.n_ctx;
  if (!model || !Number.isSafeInteger(context) || context! < 16384)
    throw new Error(
      "指定Qwenモデル/コンテキストを既存Strataで確認できません。別モデルへ切り替えません",
    );
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    key,
    model: requested,
    modelId: model.id,
    context: context!,
  };
}
export class OpenCodeAgent {
  private bridge?: ResearchMcp;
  private child?: ChildProcessWithoutNullStreams;
  private files: string[] = [];
  private env: NodeJS.ProcessEnv = {};
  private usages = new Map<string, TokenUsage>();
  get usage(): TokenUsage | undefined {
    const values = [...this.usages.values()];
    if (!values.length) return;
    return values.reduce((a, b) => ({
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
      cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
      reasoningOutputTokens:
        (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0),
      totalTokens: a.totalTokens + b.totalTokens,
      source: "opencode-step-total",
    }));
  }
  model: string;
  constructor(
    private options: {
      cwd: string;
      signal: AbortSignal;
      onStep: (name: string, args: unknown) => Promise<void>;
      model?: string;
      binary?: string;
      isComplete?: () => boolean;
    },
  ) {
    this.model = options.model ?? process.env.OPENCODE_MODEL ?? strataModel;
  }
  private stop() {
    const child = this.child;
    child?.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 1500);
    timer.unref();
    child?.once("close", () => clearTimeout(timer));
  }
  async start(tools: ToolDefinition[], instructions: string) {
    const connection = await strataConnection(this.options.signal, this.model);
    const binary = this.options.binary ?? opencodeBinary();
    const { stdout } = await promisify(execFile)(binary, ["--version"], {
      timeout: 15000,
      signal: this.options.signal,
    });
    if (stdout.trim() !== "1.19.5")
      throw new Error(
        "このOpenCode adapterは既存の1.19.5で検証します。CLIバージョンが異なります",
      );
    this.bridge = new ResearchMcp(tools, this.options.signal, () =>
      this.stop(),
    );
    const mcp = await this.bridge.start();
    const home = join(this.options.cwd, "opencode-private");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const config = join(home, "opencode.json");
    this.files.push(config);
    const permissions = { "*": "deny", "research_*": "allow" };
    const toolMap = { "*": false, "research_*": true };
    await writeFile(
      config,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: connection.model,
        small_model: connection.model,
        enabled_providers: ["strata-colab"],
        share: "disabled",
        permission: permissions,
        tools: toolMap,
        compaction: { auto: false },
        provider: {
          "strata-colab": {
            name: "Existing Strata Colab",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: connection.endpoint,
              apiKey: "{env:STRATA_API_KEY}",
            },
            models: {
              [connection.modelId]: {
                name: connection.modelId,
                tool_call: true,
                reasoning: false,
                options: {
                  reasoningEffort: "none",
                  chatTemplateKwargs: { enable_thinking: false },
                },
                limit: {
                  context: connection.context,
                  input: connection.context - 16384,
                  output: 8192,
                },
              },
            },
          },
        },
        mcp: {
          research: {
            type: "remote",
            url: mcp.url,
            headers: mcp.headers,
            oauth: false,
          },
        },
        agent: {
          research: {
            description: "URL research with evidence only",
            mode: "primary",
            model: connection.model,
            prompt:
              instructions +
              "\nresearch_のMCPツールだけを使い、finish_taskがaccepted=trueなら終了してください。",
            permission: permissions,
            tools: toolMap,
          },
        },
      }),
      { mode: 0o600 },
    );
    this.env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_CONFIG: config,
      OPENCODE_CONFIG_DIR: join(home, "config"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      STRATA_API_KEY: connection.key,
    };
  }
  async prompt(text: string) {
    this.options.signal.throwIfAborted();
    this.bridge?.reset();
    await this.options.onStep("model_turn", {
      engine: "opencode",
      model: this.model,
    });
    const child = (this.child = spawn(
      this.options.binary ?? opencodeBinary(),
      [
        "run",
        "--pure",
        "--format",
        "json",
        "--agent",
        "research",
        "--model",
        this.model,
      ],
      {
        cwd: this.options.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    ));
    let eventQueue: Promise<void> = Promise.resolve();
    let error: Error | undefined,
      steps = 0,
      bytes = 0;
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    const abort = () => {
      error = new Error("OpenCode実行を中断しました");
      this.stop();
    };
    this.options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (c) => {
      bytes += c.length;
      if (bytes > 8 * 1024 * 1024) {
        error = new Error("OpenCode出力サイズ上限");
        this.stop();
      }
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      bytes = 0;
      try {
        const value = JSON.parse(line);
        if (value.type === "step_start") {
          eventQueue = eventQueue
            .then(() => {
              if (this.options.isComplete?.()) return;
              return this.options.onStep("model_request", {
                engine: "opencode",
                model: this.model,
              });
            })
            .catch((e) => {
              error =
                e instanceof Error ? e : new Error("OpenCodeステップ上限");
              this.stop();
            });
        }
        if (
          value.type === "step_finish" &&
          typeof value.part?.id === "string"
        ) {
          const usage = opencodeUsage(value.part.tokens);
          if (usage)
            this.usages.set(`${value.sessionID}:${value.part.id}`, usage);
        }
        if (value.type === "step_finish") steps++;
        if (value.type === "error")
          throw new Error(
            "OpenCode/Strataが推論エラーを返しました。別providerへ切り替えません",
          );
      } catch (e) {
        error = e instanceof Error ? e : new Error("OpenCode出力形式不正");
        this.stop();
      }
    });
    try {
      await new Promise<void>((ok, no) => {
        child.once("error", no);
        child.once("close", async (code) => {
          await eventQueue;
          error
            ? no(error)
            : code !== 0 || !steps
              ? no(new Error(`OpenCodeが正常終了しませんでした (${code})`))
              : ok();
        });
        child.stdin.end(text);
      });
    } finally {
      this.options.signal.removeEventListener("abort", abort);
      this.child = undefined;
    }
  }
  async close() {
    this.stop();
    await this.bridge?.close();
    for (const file of this.files) await rm(file, { force: true });
    this.env = {};
  }
}
