import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  OpenCodeAgent,
  strataModel,
  strataConnection,
} from "../src/opencode.js";
for (const mode of ["duplicate", "invalid"])
  test(`OpenCode Strata ${mode}: isolated provider, capability MCP, no paid credentials or duplicate spend`, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-test-"));
    const old = {
      base: process.env.STRATA_BASE_URL,
      key: process.env.STRATA_API_KEY,
    };
    const api = createServer((req, res) => {
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers.authorization, "Bearer fake-key");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: strataModel.split("/")[1], meta: { n_ctx: 65536 } }],
        }),
      );
    });
    await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
    process.env.STRATA_BASE_URL = `http://127.0.0.1:${(api.address() as any).port}/v1`;
    process.env.STRATA_API_KEY = "fake-key";
    const binary = join(root, `opencode-${mode}.mjs`);
    await symlink(resolve("test/fixtures/opencode-peer.mjs"), binary);
    let calls = 0;
    let steps = 0;
    const agent = new OpenCodeAgent({
      cwd: root,
      signal: AbortSignal.timeout(10000),
      binary,
      isComplete: () => calls > 0,
      onStep: async () => {
        steps++;
        if (calls) throw new Error("回答確定済みです");
      },
    });
    try {
      await agent.start(
        [
          {
            name: "lookup",
            label: "Lookup",
            description: "test",
            parameters: Type.Object({ value: Type.String() }),
            execute: async () => {
              calls++;
              return { content: [{ type: "text", text: "ok" }], details: {} };
            },
          },
        ],
        "Use lookup only",
      );
      await agent.prompt("check");
      assert.equal(calls, mode === "invalid" ? 0 : 1);
      assert.equal(agent.usage?.totalTokens, 170);
      assert.equal(agent.usage?.inputTokens, 150);
      assert.equal(steps, mode === "invalid" ? 3 : 2);
      await assert.rejects(
        strataConnection(undefined, "other/paid"),
        /別provider/,
      );
      const cfg = await readFile(
        join(root, "opencode-private/opencode.json"),
        "utf8",
      );
      assert.ok(!cfg.includes("fake-key"));
    } finally {
      await agent.close();
      await new Promise<void>((ok) => api.close(() => ok()));
      if (old.base === undefined) delete process.env.STRATA_BASE_URL;
      else process.env.STRATA_BASE_URL = old.base;
      if (old.key === undefined) delete process.env.STRATA_API_KEY;
      else process.env.STRATA_API_KEY = old.key;
      await rm(root, { recursive: true, force: true });
    }
  });
