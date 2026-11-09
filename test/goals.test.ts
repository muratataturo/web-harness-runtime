import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalEngine, GoalRepository, peerMessage } from "../src/goals.js";
import { classifyRuntimeFailure } from "../src/failures.js";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-goals-"));
  const engine = new GoalEngine(new GoalRepository(root), 2);
  return {
    root,
    engine,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};
test("direction and delight approvals gate all work, and the selected plan reflects choices and notes", async () => {
  const { engine, cleanup } = await fixture();
  try {
    const goal = await engine.create({ scenario: "travel", budget: 90000 });
    assert.equal(goal.status, "awaiting_direction");
    assert.equal(goal.tasks.length, 0);
    const gate = goal.gates[0]!;
    await engine.decide(goal.id, {
      gateId: gate.id,
      revision: 1,
      choiceId: "food",
      note: "長く歩かない",
      budget: 85000,
    });
    await engine.settle(goal.id);
    assert.equal(goal.status, "awaiting_delight");
    assert.equal(goal.plan.length, 0);
    assert.ok(goal.messages.some((m) => m.kind === "review"));
    assert.ok(goal.tasks.some((t) => t.round === 2));
    const delight = goal.gates.at(-1)!;
    await engine.decide(goal.id, {
      gateId: delight.id,
      revision: 1,
      choiceId: "dinner",
    });
    await engine.settle(goal.id);
    assert.equal(goal.status, "completed");
    assert.equal(goal.budget, 85000);
    assert.ok(goal.plan.some((p) => p.title.includes("特別な夕食")));
    assert.ok(goal.highlights.some((s) => s.includes("長く歩かない")));
    assert.ok(goal.plan.every((p) => p.demo));
    assert.ok(goal.plan.some((p) => p.title.includes("ランチとカフェ")));
  } finally {
    await cleanup();
  }
});
test("life plan starts career and home before mobility and persists chosen next step", async () => {
  const { engine, cleanup } = await fixture();
  try {
    const goal = await engine.create({ scenario: "life" });
    await engine.decide(goal.id, {
      gateId: goal.gates[0]!.id,
      revision: 1,
      choiceId: "nature",
    });
    await engine.settle(goal.id);
    const requests = goal.messages
      .filter((m) => m.kind === "request")
      .map((m) => m.to);
    assert.ok(requests.indexOf("car") > requests.indexOf("home"));
    assert.ok(requests.indexOf("car") > requests.indexOf("career"));
    await engine.decide(goal.id, {
      gateId: goal.gates.at(-1)!.id,
      revision: 1,
      choiceId: "visit-first",
    });
    await engine.settle(goal.id);
    assert.ok(goal.plan.some((p) => p.title.includes("街を、休日に歩いて")));
    assert.equal(goal.plan.length, 3);
  } finally {
    await cleanup();
  }
});
test("revising a goal expires pending gates and rejects stale or changed approvals", async () => {
  const { engine, cleanup } = await fixture();
  try {
    const goal = await engine.create({ scenario: "travel" });
    const gate = goal.gates[0]!;
    await engine.revise(goal.id);
    assert.equal(gate.status, "expired");
    await assert.rejects(
      engine.decide(goal.id, {
        gateId: gate.id,
        revision: 1,
        choiceId: "relax",
      }),
    );
    const current = goal.gates.at(-1)!;
    await engine.decide(goal.id, {
      gateId: current.id,
      revision: 2,
      choiceId: "food",
    });
    await assert.rejects(
      engine.decide(goal.id, {
        gateId: current.id,
        revision: 2,
        choiceId: "relax",
      }),
    );
    await engine.settle(goal.id);
    assert.equal(goal.revision, 2);
  } finally {
    await cleanup();
  }
});
test("membership, delivery idempotency and hop limit protect internal A2A", async () => {
  const { engine, cleanup } = await fixture();
  try {
    const goal = await engine.create({ scenario: "travel" });
    const message = {
      from: "stay",
      to: "reviewer",
      kind: "review" as const,
      text: "test",
      correlationId: goal.id,
      deliveryKey: "delivery-1",
      hop: 1,
    };
    assert.ok(peerMessage(goal, message));
    assert.equal(peerMessage(goal, message), undefined);
    assert.throws(() =>
      peerMessage(goal, { ...message, deliveryKey: "2", to: "outsider" }),
    );
    assert.throws(() =>
      peerMessage(goal, { ...message, deliveryKey: "3", hop: 9 }),
    );
    assert.throws(() =>
      peerMessage(goal, {
        ...message,
        deliveryKey: "4",
        taskId: "other-goal-task",
      }),
    );
  } finally {
    await cleanup();
  }
});
test("a cold repository marks interrupted in-flight work and restores pending choices", async () => {
  const { root, engine, cleanup } = await fixture();
  try {
    const goal = await engine.create({ scenario: "travel" });
    const restored = await new GoalRepository(root).get(goal.id);
    assert.equal(restored.status, "awaiting_direction");
    goal.status = "researching";
    await engine.repo.save(goal);
    const interrupted = await new GoalRepository(root).get(goal.id);
    assert.equal(interrupted.status, "interrupted");
  } finally {
    await cleanup();
  }
});
test("invalid and unsupported goals are rejected rather than silently run", async () => {
  const { engine, cleanup } = await fixture();
  try {
    await assert.rejects(engine.create({ scenario: "other" as any }));
    await assert.rejects(engine.create({ scenario: "life", budget: NaN }));
    await assert.rejects(
      engine.create({ scenario: "travel", mode: "paid" as any }),
    );
  } finally {
    await cleanup();
  }
});
test("daily quota failures are non-retryable and distinct from transient rate limiting", () => {
  assert.equal(
    classifyRuntimeFailure("429 free-models-per-day Remaining:0").kind,
    "quota_exhausted",
  );
  assert.equal(classifyRuntimeFailure("429 rate limit").kind, "rate_limited");
  assert.equal(classifyRuntimeFailure("401 unauthorized").retryable, false);
});
test("live queries preserve arbitrary goals and unverified career/home results block mobility", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-live-"));
  const calls: string[] = [];
  const { newTask } = await import("../src/runtime.js");
  const executor: typeof import("../src/runtime.js").runTask = async (
    options,
    store,
  ) => {
    calls.push(options.query);
    const task = newTask(options);
    task.status = "blocked";
    task.answer = {
      summary: "取得できません",
      candidates: [],
      limitations: ["アクセス制限"],
    };
    await store!.save(task);
    return task;
  };
  const engine = new GoalEngine(new GoalRepository(root), 1, executor);
  try {
    const goal = await engine.create({
      scenario: "life",
      mode: "live",
      text: "京都でデザインの仕事と住まいと車を探したい",
    });
    await engine.decide(goal.id, {
      gateId: goal.gates[0]!.id,
      revision: 1,
      choiceId: "balance",
    });
    await engine.settle(goal.id);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((q) => q.includes("京都でデザイン")));
    assert.ok(
      calls.every(
        (q) => !q.includes("藤沢駅") && !q.includes("ソフトウェアエンジニア"),
      ),
    );
    assert.equal(goal.tasks.find((t) => t.agent === "car")?.status, "skipped");
    await engine.decide(goal.id, {
      gateId: goal.gates.at(-1)!.id,
      revision: 1,
      choiceId: "job-first",
    });
    await engine.settle(goal.id);
    assert.equal(goal.status, "blocked");
    assert.equal(goal.plan.length, 0);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid decision payload cannot partially settle a pending approval", async () => {
  const { engine, cleanup } = await fixture();
  try {
    const goal = await engine.create({ scenario: "travel" });
    const gate = goal.gates[0]!;
    await assert.rejects(
      engine.decide(goal.id, {
        gateId: gate.id,
        revision: 1,
        choiceId: "relax",
        note: {} as any,
      }),
    );
    assert.equal(gate.status, "pending");
    assert.equal(goal.tasks.length, 0);
  } finally {
    await cleanup();
  }
});
