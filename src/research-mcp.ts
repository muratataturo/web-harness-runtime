import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** A private capability bridge; no filesystem, shell, network or arbitrary JS tools. */
export class ResearchMcp {
  private server?: Server;
  private token = randomBytes(32).toString("hex");
  private queue: Promise<unknown> = Promise.resolve();
  private calls = new Map<string, { args: string; result: Promise<unknown> }>();
  constructor(
    private tools: ToolDefinition[],
    private signal: AbortSignal,
    private onFatal: () => void,
  ) {}
  reset() {
    this.calls.clear();
  }
  async start() {
    this.server = createServer(async (req, res) => {
      const send = (code: number, value?: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
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
          if (size > 256000) throw new Error("MCP request size limit");
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
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
              annotations: { readOnlyHint: true, destructiveHint: false },
            })),
          };
        else if (m.method === "ping") result = {};
        else if (m.method === "tools/call") {
          const key = String(m.id),
            args = JSON.stringify(m.params),
            previous = this.calls.get(key);
          if (previous && previous.args !== args)
            throw new Error("MCP request ID reused with changed arguments");
          let call = previous?.result;
          if (!call) {
            call = this.queue.then(async () => {
              this.signal.throwIfAborted();
              const tool = this.tools.find((t) => t.name === m.params?.name);
              if (
                !tool ||
                !Value.Check(tool.parameters as any, m.params.arguments)
              )
                return {
                  isError: true,
                  content: [
                    { type: "text", text: "不正な調査ツールまたは引数です" },
                  ],
                };
              const value = await tool.execute(
                `mcp-${key}`,
                m.params.arguments,
                this.signal,
                undefined,
                {} as any,
              );
              return {
                content: value.content.filter((c) => c.type === "text"),
                isError: !!(value as any).isError,
              };
            });
            this.calls.set(key, { args, result: call });
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
      } catch {
        if (this.signal.aborted) this.onFatal();
        send(400, { error: "MCP request failed" });
      }
    });
    await new Promise<void>((ok, no) => {
      this.server!.once("error", no);
      this.server!.listen(0, "127.0.0.1", ok);
    });
    return {
      url: `http://127.0.0.1:${(this.server.address() as { port: number }).port}/mcp`,
      headers: { Authorization: `Bearer ${this.token}` },
    };
  }
  async close() {
    this.server?.closeAllConnections();
    if (this.server)
      await new Promise<void>((ok) => this.server!.close(() => ok()));
  }
}
