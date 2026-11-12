import { createInterface } from "node:readline";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
const runId = Type.String({ pattern: "^[a-zA-Z0-9-]+$" });
const closed = (properties: Record<string, any>) =>
  Type.Object(properties, { additionalProperties: false });
export const harnessTools = [
  {
    name: "harness_capabilities",
    description:
      "実行先・利用可能なエンジン/モードを確認。認証情報やAPIキーを返さない。",
    inputSchema: closed({}),
  },
  {
    name: "harness_start",
    description:
      "公開URLから調査する。mode=approvalは利用者の方針選択を待つ。autoは待たず推奨で進む。liveは利用枠を使うので依頼の範囲内のみconfirmLive=trueとする。戻り値のrun IDをharness_getでpollする。",
    inputSchema: closed({
      query: Type.String({ minLength: 1, maxLength: 16000 }),
      urls: Type.Array(Type.String({ format: "uri" }), {
        minItems: 1,
        maxItems: 12,
      }),
      mode: Type.Union([Type.Literal("auto"), Type.Literal("approval")]),
      agent: Type.Optional(
        Type.Union([
          Type.Literal("codex"),
          Type.Literal("claude-code"),
          Type.Literal("pi-openrouter"),
          Type.Literal("opencode"),
        ]),
      ),
      model: Type.Optional(Type.String()),
      source: Type.Optional(
        Type.Union([Type.Literal("live"), Type.Literal("replay")]),
      ),
      example: Type.Optional(
        Type.Union([
          Type.Literal("day-out"),
          Type.Literal("life-plan"),
          Type.Literal("books"),
        ]),
      ),
      confirmLive: Type.Optional(Type.Boolean()),
    }),
  },
  {
    name: "harness_get",
    description:
      "相談の進捗・実際の回答・引用・費用・VM情報・承認待ちを取得。needs_inputならgateを利用者に見せる。",
    inputSchema: closed({ id: runId }),
  },
  {
    name: "harness_list",
    description: "保存した相談・回答を一覧。CLI/Chatと共通のローカル保存先。",
    inputSchema: closed({}),
  },
  {
    name: "harness_decide",
    description:
      "gateの推奨/選択肢/追加時間・利用枠を利用者に提示し、利用者が選んだ後に実行。autoへ勝手に切り替えない。confirmedByUser=trueが必須。",
    inputSchema: closed({
      id: runId,
      gateId: runId,
      revision: Type.Integer({ minimum: 1 }),
      choiceId: Type.String({ minLength: 1 }),
      confirmedByUser: Type.Literal(true),
      additionalUrls: Type.Optional(
        Type.Array(Type.String({ format: "uri" }), { maxItems: 8 }),
      ),
    }),
  },
  {
    name: "harness_cancel",
    description: "実行中の調査を停止。取得済み回答・履歴を残す。",
    inputSchema: closed({ id: runId }),
  },
].map((t) => ({
  ...t,
  annotations: {
    readOnlyHint: [
      "harness_capabilities",
      "harness_get",
      "harness_list",
    ].includes(t.name),
    destructiveHint: false,
    openWorldHint: t.name === "harness_start" || t.name === "harness_decide",
  },
}));
// Explicit format validator: TypeBox formats are not registered implicitly.
import { FormatRegistry } from "@sinclair/typebox";
if (!FormatRegistry.Has("uri"))
  FormatRegistry.Set("uri", (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
export async function harnessCall(name: string, args: any, base: string) {
  const origin = new URL(base);
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw Error(
      "loopback daemon originが必要です。remoteはSSH tunnelを使ってください",
    );
  base = origin.origin;
  const tool = harnessTools.find((t) => t.name === name);
  if (!tool || !Value.Check(tool.inputSchema, args))
    throw Error("不正なツールまたは引数です");
  const paths: Record<string, string> = {
    harness_capabilities: "/api/runtime",
    harness_list: "/api/runs",
    harness_get: `/api/runs/${args.id}`,
    harness_cancel: `/api/runs/${args.id}/cancel`,
    harness_decide: `/api/runs/${args.id}/decision`,
    harness_start: "/api/runs",
  };
  const mutation = [
    "harness_start",
    "harness_decide",
    "harness_cancel",
  ].includes(name);
  const { id, confirmedByUser, ...payload } = args;
  const res = await fetch(base + paths[name], {
    method: mutation ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: mutation ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
/** MCP 2025-11-25 compatible stdio bridge to the persistent local daemon. */
export async function startPublicMcp(
  endpoint = process.env.HARNESS_URL ?? "http://127.0.0.1:4310",
) {
  const url = new URL(endpoint);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error(
      "HARNESS_URLはloopback HTTPのoriginを指定してください。remote VMはSSH tunnelを利用してください",
    );
  const base = url.origin;
  let initialized = false,
    ready = false;
  const seen = new Map<string, { body: string; result: Promise<any> }>();
  const send = (value: unknown) =>
    process.stdout.write(JSON.stringify(value) + "\n");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handle = async (m: any) => {
    if (
      !m ||
      Array.isArray(m) ||
      m.jsonrpc !== "2.0" ||
      typeof m.method !== "string"
    )
      throw Error("Invalid JSON-RPC request");
    if (m.method === "ping") return {};
    if (m.method === "initialize") {
      if (initialized) throw Error("Already initialized");
      initialized = true;
      const supported = [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
      ];
      return {
        protocolVersion: supported.includes(m.params?.protocolVersion)
          ? m.params.protocolVersion
          : "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "web-harness-runtime", version: "0.3.0" },
        instructions:
          "harness_startはrun IDを即時返す。harness_getでpoll。needs_inputを人に提示して選択後にharness_decide。実行先と取得制約を回答に含める。",
      };
    }
    if (!initialized || !ready)
      throw Error("Initialize and notifications/initialized are required");
    if (m.method === "tools/list") return { tools: harnessTools };
    if (m.method === "tools/call") {
      try {
        const data = await harnessCall(
          m.params?.name,
          m.params?.arguments ?? {},
          base,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: Array.isArray(data) ? { items: data } : data,
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: e instanceof Error ? e.message : "Harness failed",
            },
          ],
        };
      }
    }
    throw Error("Method not found");
  };
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 128000) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Request too large" },
      });
      continue;
    }
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    if (m.id === undefined) {
      if (m.method === "notifications/initialized" && initialized) ready = true;
      continue;
    }
    const key = JSON.stringify(m.id),
      body = JSON.stringify(m);
    const old = seen.get(key);
    if (old && old.body !== body) {
      send({
        jsonrpc: "2.0",
        id: m.id,
        error: {
          code: -32600,
          message: "Request ID reused with different arguments",
        },
      });
      continue;
    }
    const result =
      old?.result ??
      handle(m).then(
        (result) => ({ jsonrpc: "2.0", id: m.id, result }),
        (e) => ({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32600, message: e.message },
        }),
      );
    seen.set(key, { body, result });
    if (seen.size > 512) seen.delete(seen.keys().next().value!);
    void result.then(send);
  }
}
