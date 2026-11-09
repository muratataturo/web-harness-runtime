import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
export type AgentEngine = "codex" | "pi-openrouter";
export function agentEngine(
  value = process.env.RUNTIME_AGENT ?? "codex",
): AgentEngine {
  if (value !== "codex" && value !== "pi-openrouter")
    throw new Error("agent は codex または pi-openrouter です");
  return value;
}
/** Keep provider credentials in the official CLI. Never pass API keys or repository env to it. */
export function codexEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
export const codexArgs = [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  'model_provider="openai"',
  "-c",
  "model_providers={}",
  "-c",
  "mcp_servers={}",
  "-c",
  'web_search="disabled"',
  "-c",
  "features.shell_tool=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.skill_search=false",
  "-c",
  "features.in_app_browser=false",
  "-c",
  "features.shell_snapshot=false",
];
type Rpc = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
/** Private stdio JSON-RPC connection; no socket or shared public endpoint. */
export class CodexAgent {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private serial = 0;
  private stopped = false;
  private failure?: Error;
  private threadId?: string;
  private turn?: { resolve: () => void; reject: (e: Error) => void };
  private tools: ToolDefinition[] = [];
  private calls = new Map<string, Promise<any>>();
  private toolQueue: Promise<unknown> = Promise.resolve();
  private abortListener: () => void;
  private exit: Promise<void>;
  private bufferBytes = 0;
  model?: string;
  thread?: string;
  constructor(
    private options: {
      cwd: string;
      signal: AbortSignal;
      onStep: (name: string, args: unknown) => Promise<void>;
      onEvent?: (type: string, data: unknown) => Promise<void>;
      binary?: string;
      args?: string[];
    },
  ) {
    options.signal.throwIfAborted();
    this.child = spawn(
      options.binary ?? process.env.CODEX_BIN ?? "codex",
      options.args ?? codexArgs,
      {
        cwd: options.cwd,
        env: codexEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.exit = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.on("error", (e) =>
      this.fail(
        new Error(
          `Codex CLIを起動できません: ${e.message}。codexのインストールとcodex loginを確認してください`,
        ),
      ),
    );
    this.child.once("close", (code) => {
      if (!this.stopped)
        this.fail(new Error(`Codex App Serverが終了しました (${code})`));
    });
    // Do not persist raw stderr: the official CLI may log local paths or authentication diagnostics.
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (chunk) => {
      this.bufferBytes += chunk.length;
      if (this.bufferBytes > 8 * 1024 * 1024)
        this.fail(new Error("Codexメッセージのサイズ上限です"));
    });
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      this.bufferBytes = 0;
      try {
        const message: Rpc = JSON.parse(line);
        this.receive(message);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.abortListener = () => this.fail(new Error("Codex実行を中断しました"));
    options.signal.addEventListener("abort", this.abortListener, {
      once: true,
    });
  }
  private send(message: Rpc) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.turn?.reject(error);
    this.turn = undefined;
    this.child.kill("SIGTERM");
  }
  private receive(message: Rpc) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(Number(message.id));
      if (p) {
        this.pending.delete(Number(message.id));
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined) {
      const id = message.id;
      if (message.method !== "item/tool/call") {
        this.send({
          id,
          error: {
            message: "このランタイムは調査ツール以外の要求を許可しません",
            ...{ code: -32601 },
          },
        });
        return;
      }
      const p = message.params;
      if (p.threadId !== this.threadId || p.namespace) {
        this.send({
          id,
          error: {
            message: "不正な調査threadまたはnamespace",
            ...{ code: -32602 },
          },
        });
        return;
      }
      const key = p.turnId + ":" + p.callId;
      let call = this.calls.get(key);
      if (!call) {
        call = this.toolQueue.then(() => this.callTool(p));
        this.calls.set(key, call);
        this.toolQueue = call.catch(() => {});
      }
      void call
        .then((result) => this.send({ id, result }))
        .catch((e) => this.fail(e instanceof Error ? e : new Error(String(e))));
      return;
    }
    if (
      message.method === "turn/completed" &&
      message.params.threadId === this.threadId
    ) {
      const t = message.params.turn;
      if (t.status === "completed") this.turn?.resolve();
      else
        this.turn?.reject(
          new Error(t.error?.message ?? `Codex turn ${t.status}`),
        );
      this.turn = undefined;
    }
  }
  private async callTool(params: any) {
    this.options.signal.throwIfAborted();
    const tool = this.tools.find((t) => t.name === params.tool);
    if (
      !tool ||
      !Value.Check(
        tool.parameters as unknown as import("@sinclair/typebox").TSchema,
        params.arguments,
      )
    )
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "未対応ツールまたは不正な引数です。提示されたJSON Schemaに従ってください。",
          },
        ],
      };
    try {
      const result = await tool.execute(
        params.callId,
        params.arguments,
        this.options.signal,
        undefined,
        {} as any,
      );
      return {
        success: !(result as any).isError,
        contentItems: result.content
          .filter((c) => c.type === "text")
          .map((c) => ({ type: "inputText", text: (c as any).text })),
      };
    } catch (e) {
      throw e;
    }
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "web_harness_runtime",
        title: "Web Harness Runtime",
        version: "0.2.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
    const auth = await this.request("account/read", { refreshToken: false });
    if (auth.account?.type !== "chatgpt")
      throw new Error(
        "CodexのChatGPTログインが必要です。codex loginを実行してください。APIキーには切り替えません。",
      );
    return {
      authentication: "chatgpt" as const,
      planType: auth.account.planType,
    };
  }
  async models() {
    return (await this.request("model/list", { limit: 100 })).data as {
      model: string;
      isDefault: boolean;
      displayName: string;
    }[];
  }
  async start(
    tools: ToolDefinition[],
    instructions: string,
    requested?: string,
  ) {
    this.tools = tools;
    const models = await this.models();
    const chosen = requested
      ? models.find((m) => m.model === requested)
      : models.find((m) => m.isDefault);
    if (!chosen)
      throw new Error(
        "Codexアカウントで利用できるモデルを選べません。codex-doctorで確認してください。",
      );
    const result = await this.request("thread/start", {
      cwd: this.options.cwd,
      model: chosen.model,
      modelProvider: "openai",
      allowProviderModelFallback: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      environments: [],
      selectedCapabilityRoots: [],
      baseInstructions: instructions,
      developerInstructions:
        "提供された調査ツールだけを使う。shell、ファイル編集、外部MCP、プラグイン、別エージェントは使わない。finish_taskがacceptedならツールを追加実行せず終了する。",
      config: {
        mcp_servers: {},
        web_search: "disabled",
        features: {
          shell_tool: false,
          apps: false,
          plugins: false,
          multi_agent: false,
          skill_search: false,
          in_app_browser: false,
        },
      },
      dynamicTools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })),
    });
    this.threadId = result.thread.id;
    this.thread = this.threadId;
    this.model = result.model ?? chosen.model;
    await this.options.onEvent?.("codex_thread", {
      threadId: this.threadId,
      model: this.model,
      authentication: "chatgpt",
    });
  }
  async prompt(text: string) {
    await this.options.onStep("model_turn", {
      engine: "codex",
      model: this.model,
    });
    const completion = new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject };
    });
    // Attach a handler before turn/start: a process failure must not cause an unhandled rejection.
    void completion.catch(() => {});
    await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      effort: "low",
      serviceTierForTurn: "default",
    });
    await completion;
  }
  async close() {
    this.stopped = true;
    this.options.signal.removeEventListener("abort", this.abortListener);
    this.fail(new Error("Codex接続を終了しました"));
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    kill.unref();
    await this.exit;
    clearTimeout(kill);
  }
}
