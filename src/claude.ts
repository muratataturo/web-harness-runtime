import { createServer, type Server } from "node:http";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { codexEnvironment } from "./codex.js";
export const claudeModels = ["claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export function claudeModel(
  requested = process.env.CLAUDE_MODEL ?? claudeModels[0],
): string {
  const aliases: Record<string, string> = {
    "sonnet-5.5": claudeModels[0],
    "haiku-5.5": claudeModels[1],
  };
  const model = aliases[requested] ?? requested;
  if (!claudeModels.includes(model as any))
    throw new Error(
      "Claude Codeモデルは claude-sonnet-5-5 または claude-haiku-5-5 を指定してください",
    );
  return model;
}
export async function claudeAuthentication(
  binary = process.env.CLAUDE_BIN ?? "claude",
  signal?: AbortSignal,
) {
  const { stdout } = await promisify(execFile)(binary, ["auth", "status"], {
    env: codexEnvironment(),
    signal,
    timeout: 15000,
    maxBuffer: 100000,
  });
  const status = JSON.parse(stdout);
  if (
    !status.loggedIn ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty"
  )
    throw new Error(
      "Claude Codeのサブスク認証が必要です。claude auth loginで確認してください。APIキーには切り替えません。",
    );
  return {
    authentication: "claude.ai",
    subscriptionType: status.subscriptionType,
  };
}
/** Private capability-protected MCP bridge. Only the common research tools are exposed. */
export class ClaudeAgent {
  private server?: Server;
  private child?: ChildProcessWithoutNullStreams;
  private files: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private tools: ToolDefinition[] = [];
  private token = randomBytes(32).toString("hex");
  private calls = new Map<
    string,
    { args: string; promise: Promise<unknown> }
  >();
  private url?: string;
  model: string;
  constructor(
    private options: {
      cwd: string;
      signal: AbortSignal;
      onStep: (name: string, args: unknown) => Promise<void>;
      onEvent?: (name: string, args: unknown) => Promise<void>;
      model?: string;
      binary?: string;
    },
  ) {
    this.model = claudeModel(options.model);
  }
  private stopChild() {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
  async start(tools: ToolDefinition[], instructions: string) {
    this.options.signal.throwIfAborted();
    const auth = await claudeAuthentication(
      this.options.binary,
      this.options.signal,
    );
    await this.options.onEvent?.("claude_auth", auth);
    this.tools = tools;
    this.server = createServer(async (req, res) => {
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (
        req.url !== "/mcp" ||
        req.headers.authorization !== `Bearer ${this.token}` ||
        !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "") ||
        req.headers.origin
      ) {
        send(403);
        return;
      }
      if (req.method !== "POST") {
        send(405);
        return;
      }
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += c.length;
          if (size > 256000) throw new Error("MCP request too large");
          chunks.push(c);
        }
        const m = JSON.parse(Buffer.concat(chunks).toString());
        if (m.id === undefined) {
          send(202);
          return;
        }
        let result: unknown;
        if (m.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "web-harness-research", version: "0.2.0" },
          };
        else if (m.method === "tools/list")
          result = {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
              annotations: { readOnlyHint: true, destructiveHint: false },
            })),
          };
        else if (m.method === "ping") result = {};
        else if (m.method === "tools/call") {
          const key = String(m.id),
            args = JSON.stringify(m.params);
          const prior = this.calls.get(key);
          if (prior && prior.args !== args)
            throw new Error("MCP ID reused with changed arguments");
          let call = prior?.promise;
          if (!call) {
            call = this.queue.then(async () => {
              this.options.signal.throwIfAborted();
              const t = this.tools.find((t) => t.name === m.params.name);
              if (!t || !Value.Check(t.parameters as any, m.params.arguments)) {
                await this.options.onStep("invalid_tool_call", {
                  tool: m.params.name,
                });
                return {
                  isError: true,
                  content: [
                    { type: "text", text: "不正な調査ツールまたは引数です" },
                  ],
                };
              }
              const out = await t.execute(
                "claude-" + key,
                m.params.arguments,
                this.options.signal,
                undefined,
                {} as any,
              );
              return {
                content: out.content.filter((c) => c.type === "text"),
                isError: !!(out as any).isError,
              };
            });
            this.calls.set(key, { args, promise: call });
            this.queue = call.catch(() => {});
          }
          result = await call;
        } else {
          send(200, {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32601, message: "Unsupported method" },
          });
          return;
        }
        send(200, { jsonrpc: "2.0", id: m.id, result });
      } catch (error) {
        if (
          this.options.signal.aborted ||
          /ステップ上限/.test(error instanceof Error ? error.message : "")
        )
          this.stopChild();
        send(400, {
          error: error instanceof Error ? error.message : "MCP error",
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    const file = join(this.options.cwd, "claude-mcp.json"),
      prompt = join(this.options.cwd, "claude-system.txt");
    this.files = [file, prompt];
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          research: {
            type: "http",
            url: this.url,
            headers: { Authorization: `Bearer ${this.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      prompt,
      instructions +
        "\nresearch MCPのツールだけを使用する。finish_taskがaccepted=falseなら不足情報を調べて再回答する。accepted=trueなら終了する。",
      { mode: 0o600 },
    );
  }
  async prompt(text: string) {
    this.options.signal.throwIfAborted();
    this.calls.clear();
    await this.options.onStep("model_turn", {
      engine: "claude-code",
      model: this.model,
    });
    const args = [
      "-p",
      "--model",
      this.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--tools",
      "",
      "--allowedTools",
      this.tools.map((t) => "mcp__research__" + t.name).join(","),
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--mcp-config",
      this.files[0]!,
      "--system-prompt-file",
      this.files[1]!,
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
    ];
    const child = (this.child = spawn(
      this.options.binary ?? process.env.CLAUDE_BIN ?? "claude",
      args,
      {
        cwd: this.options.cwd,
        env: codexEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    ));
    let error: Error | undefined,
      result = false,
      buffer = 0;
    const abort = () => child.kill("SIGTERM");
    const kill = () => this.stopChild();
    const abortAll = () => {
      error = new Error("Claude Code実行を中断しました");
      kill();
    };
    this.options.signal.addEventListener("abort", abortAll, { once: true });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdout.on("data", (c) => {
      buffer += c.length;
      if (buffer > 8 * 1024 * 1024) {
        error = new Error("Claude出力のサイズ上限です");
        kill();
      }
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      buffer = 0;
      try {
        const m = JSON.parse(line);
        if (m.type === "system" && m.subtype === "init") {
          if (m.model !== this.model)
            throw new Error(`Claudeモデルが指定と異なります: ${m.model}`);
          if (
            m.mcp_server_errors?.length ||
            m.mcp_servers?.some(
              (s: any) => s.name === "research" && s.status === "failed",
            )
          )
            throw new Error("research MCPの接続に失敗しました");
          if (
            m.tools?.some((name: string) => !name.startsWith("mcp__research__"))
          )
            throw new Error("許可していない組み込みツールが有効です");
        }
        if (m.type === "result") {
          result = true;
          if (m.is_error || m.subtype !== "success")
            throw new Error(
              m.errors?.join("; ") ?? m.result ?? `Claude ${m.subtype}`,
            );
        }
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
        kill();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          if (error) reject(error);
          else if (code !== 0 || !result)
            reject(new Error(`Claude Codeが正常終了しませんでした (${code})`));
          else resolve();
        });
        child.stdin.end(text);
      });
    } finally {
      this.options.signal.removeEventListener("abort", abortAll);
      this.child = undefined;
      abort();
    }
  }
  async close() {
    this.stopChild();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    for (const file of this.files) await rm(file, { force: true });
  }
}
