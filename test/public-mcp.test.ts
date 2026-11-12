import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { writeClientConfigs } from "../src/client-config.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("public MCP negotiates versions, validates arguments and human decisions, isolates stdout, deduplicates start delivery", async () => {
  let starts = 0;
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      starts++;
      res.end(
        JSON.stringify({
          id: "run-test",
          status: "running",
          body: JSON.parse(raw),
        }),
      );
    } else
      res.end(
        JSON.stringify({ interfaces: ["cli", "mcp-stdio", "local-chat"] }),
      );
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(api.address() as any).port}`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), "mcp", "--url", base],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, ((v: any) => void)[]>();
  const received: any[] = [];
  lines.on("line", (line) => {
    const v = JSON.parse(line);
    received.push(v);
    pending.get(v.id)?.shift()?.(v);
  });
  let next = 0;
  const req = (method: string, params: any = {}, id = ++next) =>
    new Promise<any>((ok, no) => {
      const timer = setTimeout(() => no(Error("timeout")), 8000);
      pending.set(id, [
        ...(pending.get(id) ?? []),
        (v) => {
          clearTimeout(timer);
          ok(v);
        },
      ]);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    const init = await req("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-11-25");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const list = await req("tools/list");
    assert.equal(list.result.tools.length, 6);
    const invalid = await req("tools/call", {
      name: "harness_decide",
      arguments: {
        id: "run-test",
        gateId: "gate-test",
        revision: 1,
        choiceId: "balance",
        confirmedByUser: false,
      },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(starts, 0);
    const params = {
      name: "harness_start",
      arguments: {
        query: "test",
        urls: ["https://books.rakuten.co.jp/rb/18577690/"],
        mode: "auto",
        confirmLive: true,
      },
    };
    const id = ++next;
    const [a, b] = await Promise.all([
      req("tools/call", params, id),
      req("tools/call", params, id),
    ]);
    assert.equal(a.result.structuredContent.id, b.result.structuredContent.id);
    assert.equal(starts, 1);
    const reused = await req(
      "tools/call",
      { ...params, arguments: { ...params.arguments, query: "different" } },
      id,
    );
    assert.equal(reused.error.code, -32600);
    assert.ok(received.every((v) => v.jsonrpc === "2.0"));
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((r) => api.close(() => r()));
  }
});
test("client configs contain executable absolute paths and placeholders, never credentials or user-account changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-client-"));
  try {
    const c = await writeClientConfigs(root, "http://127.0.0.1:4311");
    assert.equal(c.files.length, 5);
    const claude = JSON.parse(
      await readFile(join(root, "claude.mcp.json"), "utf8"),
    );
    assert.ok(claude.mcpServers.harness.command.startsWith("/"));
    assert.ok(claude.mcpServers.harness.args[0].endsWith("/dist/cli.js"));
    const strata = await readFile(join(root, "opencode-strata.json"), "utf8");
    assert.match(strata, /\{env:STRATA_API_KEY\}/);
    assert.doesNotMatch(strata, /sk-or-v1-/);
    await assert.rejects(
      writeClientConfigs(root, "http://attacker.example"),
      /loopback/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
