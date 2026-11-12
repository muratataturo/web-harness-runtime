import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  StrataColab,
  parseColabStatus,
  IdleObservation,
  metricSample,
} from "../src/strata-colab.js";
import { strataSettings } from "../src/strata-settings.js";
test("Colab status parser requires explicit absence; errors never authorize allocation", () => {
  assert.equal(
    parseColabStatus(
      "[colab] Session 'example-qwen' not found.",
      "example-qwen",
    ),
    undefined,
  );
  assert.equal(
    parseColabStatus("[example-qwen] endpoint-test | IDLE", "example-qwen"),
    "endpoint-test",
  );
  for (const s of [
    "503 unavailable",
    "authentication required",
    "No active sessions.",
    "[other] endpoint | IDLE",
  ])
    assert.throws(() => parseColabStatus(s, "example-qwen"), /確定できません/);
  assert.throws(() => parseColabStatus("", "x;echo"));
});
test("idle timeout resets on activity, counters changing, sleep and observation failure", () => {
  const timer = new IdleObservation(),
    idle = { busy: false, marker: "server-1:0" };
  assert.equal(timer.observe(idle, 100, 30).ready, false);
  assert.equal(timer.observe(idle, 130, 30).ready, true);
  assert.equal(timer.observe({ ...idle, busy: true }, 131, 30).ready, false);
  assert.equal(
    timer.observe({ ...idle, marker: "server-1:1" }, 150, 30).ready,
    false,
  );
  assert.equal(timer.observe(idle, 300, 30).ready, false);
  timer.reset();
  assert.equal(timer.observe(idle, 301, 30).ready, false);
  assert.equal(
    metricSample({
      live: { state: "generating", queued: 0 },
      totals: { since: "a", requests: 0 },
    }).busy,
    true,
  );
  assert.equal(
    metricSample({
      live: { state: "idle", queued: 1 },
      totals: { since: "a", requests: 0 },
    }).busy,
    true,
  );
  assert.throws(() =>
    metricSample({
      live: { state: "idle", queued: -1 },
      totals: { since: "a", requests: 0 },
    }),
  );
});
test("replacement or unowned sessions cannot be stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "strata-owned-"));
  const manager = new StrataColab(root);
  const calls: string[][] = [];
  const state = {
    session: "example-qwen",
    endpoint: "original",
    owned: true,
    cli: "colab",
    phase: "ready",
  };
  (manager as any).command = async (_bin: string, args: string[]) => {
    calls.push(args);
    return { stdout: "[example-qwen] replacement | IDLE", stderr: "" };
  };
  try {
    await writeFile(join(root, "state.json"), JSON.stringify(state));
    await assert.rejects(manager.stop(), /置換/);
    assert.equal(
      calls.some((c) => c[0] === "stop"),
      false,
    );
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({ ...state, owned: false }),
    );
    await assert.rejects(manager.stop(), /所有/);
    await assert.rejects(
      manager.connect("http://127.0.0.1:1/v1", "/absolute/key"),
      /所有中|API|fetch|ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a failed bootstrap cleans up only the runtime allocated by that operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "strata-bootstrap-"));
  const manager: any = new StrataColab(root);
  let endpoint: string | undefined;
  const calls: string[] = [];
  manager.cli = async () => ({ cli: "fake-colab", python: process.execPath });
  manager.endpoint = async () => endpoint;
  manager.freePort = async () => {};
  manager.command = async (_b: string, args: string[], label: string) => {
    calls.push(label);
    if (label === "allocate") endpoint = "owned-endpoint";
    if (label === "remote-start") throw Error("bootstrap failed");
    if (label === "stop-colab") endpoint = undefined;
    return { stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(
      manager.up({ session: "example-qwen" }),
      /bootstrap failed/,
    );
    assert.ok(calls.includes("allocate"));
    assert.ok(calls.includes("stop-colab"));
    assert.equal((await manager.state()).phase, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("managed connection feeds the runtime without exposing credentials and verifies SSE plus tool result", async () => {
  const root = await mkdtemp(join(tmpdir(), "strata-probe-"));
  const manager = new StrataColab(root);
  const secret = "unit-test-local-secret";
  let calls = 0;
  const api = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + secret) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "qwen3.8-flash-next-iq2_xs", meta: { n_ctx: 65536 } }],
        }),
      );
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const p = JSON.parse(body);
    calls++;
    if (p.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({ choices: [{ delta: { content: "OK" } }] }) +
          "\n\n",
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    const message = p.messages.some((m: any) => m.role === "tool")
      ? { role: "assistant", content: "hello" }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "echo", arguments: '{"text":"hello"}' },
            },
          ],
        };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(api.address() as any).port}/v1`,
      keyFile = join(root, "api-key");
    await writeFile(keyFile, secret, { mode: 0o600 });
    const result = await manager.connect(baseUrl, keyFile);
    assert.equal(result.owned, false);
    const settings = await strataSettings(root);
    assert.equal(settings.baseUrl, baseUrl);
    assert.ok(
      !(await readFile(join(root, "connection.json"), "utf8")).includes(secret),
    );
    const probe = await manager.probe();
    assert.equal(probe.unauthorizedStatus, 401);
    assert.equal(probe.toolRoundTrip, true);
    assert.equal(probe.sseDone, true);
    assert.equal(calls, 3);
    assert.ok(!JSON.stringify(probe).includes(secret));
    await assert.rejects(manager.stop(), /所有/);
  } finally {
    await new Promise<void>((r) => api.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH proxy guard refuses automatic allocation and replacement endpoints", async () => {
  await promisify(execFileCb)("python3", ["test/strata_proxy_test.py"], {
    timeout: 15000,
  });
});
test("up refuses an unknown live session or occupied forwarding port before allocating a GPU", async () => {
  const root = await mkdtemp(join(tmpdir(), "strata-no-allocation-"));
  const manager: any = new StrataColab(root);
  const calls: string[] = [];
  manager.cli = async () => ({ cli: "fake-colab", python: process.execPath });
  manager.command = async (_b: string, _a: string[], label: string) => {
    calls.push(label);
    return { stdout: "", stderr: "" };
  };
  try {
    manager.endpoint = async () => "someone-elses-endpoint";
    await assert.rejects(manager.up(), /所有/);
    assert.equal(calls.includes("allocate"), false);
    manager.endpoint = async () => undefined;
    manager.freePort = async () => {
      throw Error("port in use");
    };
    await assert.rejects(manager.up(), /port in use/);
    assert.equal(calls.includes("allocate"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
