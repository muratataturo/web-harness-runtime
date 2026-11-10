import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunService } from "../src/run-service.js";
import { Store } from "../src/store.js";
import { newTask } from "../src/runtime.js";
const input = {
  query: "本の確認",
  urls: ["https://books.rakuten.co.jp/rb/18577690/"],
  agent: "codex" as const,
  source: "live" as const,
  confirmLive: true,
};
async function settle(s: RunService, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await s.get(id);
    if (r.status !== "running") return r;
    await delay(10);
  }
  throw Error("did not settle");
}
test("approval requires explicit direction, duplicate delivery does not spend again, stale choice rejected; state survives reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-run-"));
  let calls = 0;
  const s = new RunService(new Store(root), async (options) => {
    calls++;
    const t = newTask(options);
    t.status = "partial";
    t.answer = {
      summary: "価格は確認。サインは不明。",
      candidates: [],
      limitations: ["サインは未確認"],
    };
    return t;
  });
  try {
    const r = await s.create({ ...input, mode: "approval" });
    assert.equal(calls, 0);
    assert.equal(r.status, "needs_input");
    const d = { gateId: r.gate!.id, revision: r.revision, choiceId: "balance" };
    await Promise.all([s.decide(r.id, d), s.decide(r.id, d)]);
    const result = await settle(s, r.id);
    assert.equal(calls, 1);
    assert.equal(result.gate?.kind, "result");
    await assert.rejects(
      s.decide(r.id, { ...d, choiceId: "experience" }),
      /古い/,
    );
    const reloaded = new RunService(new Store(root));
    const persisted = await reloaded.get(r.id);
    assert.equal(persisted.gate?.id, result.gate?.id);
    const accepted = await reloaded.decide(r.id, {
      gateId: persisted.gate!.id,
      revision: persisted.revision,
      choiceId: "return_partial",
    });
    assert.equal(accepted.status, "completed_partial");
    assert.equal(accepted.gate, undefined);
    assert.equal(calls, 1);
    await reloaded.shutdown();
  } finally {
    await s.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
test("Auto never creates an input gate; replay runs without inference and is explicitly attributed", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-auto-"));
  let calls = 0;
  const s = new RunService(new Store(root), async () => {
    calls++;
    throw Error("unexpected inference");
  });
  try {
    const r = await s.create({
      ...input,
      source: "replay",
      mode: "auto",
      example: "day-out",
    });
    const done = await settle(s, r.id);
    assert.equal(done.status, "completed_partial");
    assert.equal(done.gate, undefined);
    assert.ok(done.task?.answer?.summary);
    assert.equal(done.decisions[0]?.decidedBy, "runtime");
    assert.equal(done.target, "recorded-result");
    assert.equal(calls, 0);
    await assert.rejects(s.create({ ...input, confirmLive: false }), /明示/);
  } finally {
    await s.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
test("cancellation is durable and a daemon restart never silently repeats an interrupted paid task", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cancel-"));
  const s = new RunService(new Store(root), async (o) => {
    await delay(5000, undefined, { signal: o.signal });
    throw Error("unexpected");
  });
  try {
    const r = await s.create({ ...input, mode: "auto" });
    await s.cancel(r.id);
    await s.shutdown();
    assert.equal((await s.get(r.id)).status, "cancelled");
    const disk = { ...r, id: "interrupted-test", status: "running" };
    await mkdir(join(root, "runs"), { recursive: true });
    await writeFile(
      join(root, "runs/interrupted-test.json"),
      JSON.stringify(disk),
    );
    const recovered = await new RunService(new Store(root)).get(
      "interrupted-test",
    );
    assert.equal(recovered.status, "interrupted");
  } finally {
    await s.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
