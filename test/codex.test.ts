import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  CodexAgent,
  agentEngine,
  codexEnvironment,
  codexArgs,
} from "../src/codex.js";
import { classifyRuntimeFailure } from "../src/failures.js";
function fixture(mode = "success") {
  const controller = new AbortController();
  let calls = 0,
    steps = 0;
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
  const client = new CodexAgent({
    cwd: process.cwd(),
    signal: controller.signal,
    onStep: async () => {
      steps++;
    },
    binary: process.execPath,
    args: [resolve("test/fixtures/codex-server.mjs"), mode],
  });
  return { client, controller, tool, calls: () => calls, steps: () => steps };
}
test("Codex defaults and credentials are separate from OpenRouter/API key billing", () => {
  assert.equal(agentEngine("codex"), "codex");
  assert.equal(agentEngine("pi-openrouter"), "pi-openrouter");
  assert.throws(() => agentEngine("unexpected"));
  const env = codexEnvironment();
  for (const key of [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
  ])
    assert.equal(env[key], undefined);
  assert.ok(codexArgs.includes('forced_login_method="chatgpt"'));
  assert.ok(codexArgs.includes("features.shell_tool=false"));
});
test("official protocol handshake, model discovery and custom tools complete without a paid fallback", async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.initialize()).authentication, "chatgpt");
    await f.client.start([f.tool], "Use lookup");
    await f.client.prompt("look up");
    assert.equal(f.calls(), 1);
    assert.equal(f.steps(), 1);
    assert.equal(f.client.model, "test-model");
  } finally {
    await f.client.close();
  }
});
test("duplicate tool deliveries execute the host tool only once", async () => {
  const f = fixture("duplicate");
  try {
    await f.client.initialize();
    await f.client.start([f.tool], "Use lookup");
    await f.client.prompt("look up");
    assert.equal(f.calls(), 1);
  } finally {
    await f.client.close();
  }
});
for (const mode of ["invalid", "unknown", "forbidden", "wrong-thread"])
  test(`Codex ${mode} request cannot execute a host tool`, async () => {
    const f = fixture(mode);
    try {
      await f.client.initialize();
      await f.client.start([f.tool], "Use lookup");
      await f.client.prompt("look up");
      assert.equal(f.calls(), 0);
    } finally {
      await f.client.close();
    }
  });
test("API-key login is rejected before model execution", async () => {
  const f = fixture("api-key");
  try {
    await assert.rejects(f.client.initialize(), /ChatGPTログイン/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.client.close();
  }
});
test("subscription exhaustion fails without retry or provider switching", async () => {
  const f = fixture("quota");
  try {
    await f.client.initialize();
    await f.client.start([f.tool], "Use lookup");
    await assert.rejects(f.client.prompt("look up"), /usage_limit/);
    assert.equal(f.calls(), 0);
    assert.equal(
      classifyRuntimeFailure("usage_limit_reached", "codex").kind,
      "quota_exhausted",
    );
  } finally {
    await f.client.close();
  }
});
test("abort stops a running turn and process exit rejects pending work", async () => {
  for (const mode of ["hang", "exit"]) {
    const f = fixture(mode);
    try {
      await f.client.initialize();
      await f.client.start([f.tool], "Use lookup");
      const p = f.client.prompt("look up");
      if (mode === "hang") setTimeout(() => f.controller.abort(), 50);
      await assert.rejects(p, /中断|終了/);
    } finally {
      await f.client.close();
    }
  }
});
test("missing CLI is reported and cleaned up", async () => {
  const f = new CodexAgent({
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onStep: async () => {},
    binary: "/definitely-not-installed/codex",
  });
  try {
    await assert.rejects(f.initialize(), /起動できません/);
  } finally {
    await f.close();
  }
});

test("runtime uses Codex without OpenRouter requests and persists subscription quota failure", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mock } = await import("node:test");
  const { runTask } = await import("../src/runtime.js");
  const { Store } = await import("../src/store.js");
  const root = await mkdtemp(join(tmpdir(), "codex-runtime-")),
    original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let requests = 0;
  const fetchStub = mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("Unexpected API request");
  });
  try {
    const t = await runTask(
      {
        agent: "codex",
        query: "Compare hotels",
        urls: ["https://www.jalan.net/"],
        maxSteps: 10,
        maxPages: 2,
        timeoutSeconds: 5,
      },
      new Store(root),
    );
    assert.equal(t.agent, "codex");
    assert.equal(t.status, "failed");
    assert.equal(t.failure?.kind, "quota_exhausted");
    assert.equal(t.steps, 1);
    assert.equal(requests, 0);
    assert.equal(t.pages.length, 0);
    const events = await readFile(
      join(root, "tasks", t.id, "events.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(events, /free_quota|quota_check_unavailable/);
  } finally {
    fetchStub.mock.restore();
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable requested model stops without selecting another model", async () => {
  const f = fixture();
  try {
    await f.client.initialize();
    await assert.rejects(
      f.client.start([f.tool], "Use lookup", "not-in-catalog"),
      /モデルを選べません/,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.client.close();
  }
});
test("Codex requests cannot allocate an OpenRouter-only OpenShell sandbox", async () => {
  const { createOpenShellExecutor } = await import("../src/executors.js");
  const execute = createOpenShellExecutor({ gateway: "test-gateway" });
  await assert.rejects(
    execute({
      agent: "codex",
      query: "Compare hotels",
      urls: ["https://www.jalan.net/"],
      maxSteps: 10,
      maxPages: 2,
      timeoutSeconds: 10,
    }),
    /認証連携が未対応/,
  );
});
