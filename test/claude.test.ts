import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  ClaudeAgent,
  claudeModel,
  claudeAuthentication,
} from "../src/claude.js";
async function fixture(mode = "success") {
  const dir = await mkdtemp(join(tmpdir(), "claude-peer-")),
    binary = join(dir, "claude-" + mode);
  await symlink(resolve("test/fixtures/claude-server.mjs"), binary);
  const controller = new AbortController();
  let calls = 0;
  const agent = new ClaudeAgent({
    cwd: dir,
    binary,
    signal: controller.signal,
    onStep: async () => {},
    model: "claude-haiku-5-5",
  });
  const tool = defineTool({
    name: "lookup",
    label: "Lookup",
    description: "Lookup",
    parameters: Type.Object({ url: Type.String() }),
    execute: async () => {
      calls++;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  return {
    agent,
    tool,
    dir,
    binary,
    controller,
    calls: () => calls,
    cleanup: async () => {
      await agent.close();
      assert.equal(
        (await readdir(dir)).some(
          (f) => f.endsWith(".json") || f.endsWith(".txt"),
        ),
        false,
      );
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("explicit Claude 5.5 model selection never silently upgrades or falls back", () => {
  assert.equal(claudeModel("sonnet-5.5"), "claude-sonnet-5-5");
  assert.equal(claudeModel("haiku-5.5"), "claude-haiku-5-5");
  assert.throws(() => claudeModel("opus"));
});
for (const mode of ["success", "duplicate", "invalid", "unknown"])
  test(`Claude restricted MCP ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await f.agent.start([f.tool], "Use lookup");
      await f.agent.prompt("lookup");
      assert.equal(f.calls(), mode === "invalid" || mode === "unknown" ? 0 : 1);
    } finally {
      await f.cleanup();
    }
  });
for (const mode of ["noauth", "apikey"])
  test(`Claude ${mode} cannot use the subscription adapter`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(claudeAuthentication(f.binary), /サブスク認証/);
    } finally {
      await f.cleanup();
    }
  });
for (const mode of ["wrongmodel", "quota", "hang"])
  test(`Claude ${mode} stops without another provider`, async () => {
    const f = await fixture(mode);
    try {
      await f.agent.start([f.tool], "Use lookup");
      const p = f.agent.prompt("lookup");
      if (mode === "hang") setTimeout(() => f.controller.abort(), 100);
      await assert.rejects(p);
      assert.equal(f.calls(), 0);
    } finally {
      await f.cleanup();
    }
  });
