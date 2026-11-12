import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFreeQuota } from "../src/quota.js";
test("free request reset is next UTC midnight, expressed as 09:00 JST", () => {
  const quota = parseFreeQuota(
    {
      data: {
        free_model_daily_requests: { used: 53, limit: 50, remaining: 0 },
        limit_reset: "monthly",
      },
    },
    "Mon, 09 Nov 2026 21:47:02 GMT",
  );
  assert.equal(quota.remaining, 0);
  assert.equal(quota.resetsAt, "2026-11-10T00:00:00.000Z");
  assert.match(quota.resetsAtJapan, /2026\/11\/10 09:00/);
});
test("missing counters cannot become a misleading zero/available quota", () => {
  assert.throws(() => parseFreeQuota({ data: { limit_remaining: 0 } }));
  assert.throws(() =>
    parseFreeQuota({
      data: {
        free_model_daily_requests: { used: 0, limit: 50, remaining: -1 },
      },
    }),
  );
});
test("an exhausted quota ends the task before model selection or inference", async () => {
  const { mock } = await import("node:test");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runTask } = await import("../src/runtime.js");
  const { Store } = await import("../src/store.js");
  const root = await mkdtemp(join(tmpdir(), "relay-quota-")),
    key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-not-a-real-secret";
  let requests = 0;
  const stub = mock.method(globalThis, "fetch", async (input: any) => {
    assert.equal(String(input), "https://openrouter.ai/api/v1/key");
    requests++;
    return new Response(
      JSON.stringify({
        data: {
          free_model_daily_requests: { used: 50, limit: 50, remaining: 0 },
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
          Date: "Mon, 09 Nov 2026 21:47:02 GMT",
        },
      },
    );
  });
  try {
    const task = await runTask(
      {
        agent: "pi-openrouter",
        query: "箱根の宿",
        urls: ["https://www.jalan.net/"],
        maxSteps: 10,
        maxPages: 2,
        timeoutSeconds: 20,
      },
      new Store(root),
    );
    assert.equal(requests, 1);
    assert.equal(task.failure?.kind, "quota_exhausted");
    assert.equal(task.steps, 0);
    assert.match(task.error!, /09:00/);
    assert.equal(task.pages.length, 0);
  } finally {
    stub.mock.restore();
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
    await rm(root, { recursive: true, force: true });
  }
});
