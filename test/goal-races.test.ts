import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalEngine, GoalRepository, type Goal } from "../src/goals.js";
import type { RuntimeExecutor } from "../src/executors.js";
import { Store } from "../src/store.js";
import type { Task } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function taskFor(query: string, urls: string[]): Task {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    query,
    urls,
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
    sources: [],
    criteria: [
      {
        id: "public",
        description: "公開ページの候補",
        required: true,
        weight: 1,
      },
    ],
    pages: [
      {
        id: "page-1",
        url: urls[0]!,
        title: "Fixture candidate",
        text: "公開ページの候補です。",
        links: [],
        capturedAt: now,
        truncated: false,
      },
    ],
    evidence: [
      {
        id: "ev-1",
        pageId: "page-1",
        url: urls[0]!,
        quote: "公開ページの候補です。",
        capturedAt: now,
      },
    ],
    answer: {
      summary: "外部 API を使わないテスト候補です。",
      limitations: [],
      candidates: [
        {
          name: "Fixture candidate",
          url: urls[0]!,
          score: 100,
          eligible: true,
          matches: [
            {
              criterionId: "public",
              status: "supported",
              explanation: "公開ページの引用を確認。",
              evidenceIds: ["ev-1"],
            },
          ],
        },
      ],
    },
    limits: { maxSteps: 5, timeoutSeconds: 10, maxPages: 2 },
    steps: 1,
  };
}
function decision(goal: Goal, kind: "direction" | "delight", choiceId: string) {
  const gate = goal.gates.find(
    (g) => g.revision === goal.revision && g.kind === kind,
  )!;
  return { gateId: gate.id, revision: goal.revision, choiceId };
}

test(
  "concurrent cold loads share one goal and duplicate approval dispatches each job once",
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-cold-decision-"));
    let engine: GoalEngine | undefined;
    try {
      let calls = 0;
      const runner: RuntimeExecutor = async (options, store) => {
        calls++;
        const task = taskFor(options.query, options.urls);
        await store!.save(task);
        return task;
      };
      const initial = new GoalEngine(new GoalRepository(root), 1, runner);
      const goal = await initial.create({ scenario: "travel", mode: "live" });
      const repo = new GoalRepository(root);
      const [a, b] = await Promise.all([repo.get(goal.id), repo.get(goal.id)]);
      assert.equal(
        a,
        b,
        "a restarted process must not load two mutable copies of one goal",
      );

      // Use another cold repository so this also covers decision() itself, not just get().
      engine = new GoalEngine(new GoalRepository(root), 1, runner);
      const input = decision(goal, "direction", "relax");
      await Promise.all([
        engine.decide(goal.id, input),
        engine.decide(goal.id, input),
      ]);
      const settled = await engine.settle(goal.id);
      assert.equal(
        calls,
        3,
        "one approval should dispatch stay, food, and explore once each",
      );
      assert.equal(settled.status, "awaiting_delight");
      assert.equal(
        settled.messages.filter((m) => m.kind === "decision").length,
        1,
      );
      assert.equal(
        settled.tasks.filter((t) => t.status === "succeeded").length,
        4,
      );
    } finally {
      engine?.shutdown();
      if (engine) {
        for (const goal of await engine.repo.list())
          await engine.settle(goal.id);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const action of ["cancel", "revise"] as const) {
  test(
    `${action} during live artifact loading prevents stale synthesis from completing`,
    { timeout: 5000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), `relay-synthesis-${action}-`));
      const reached = deferred(),
        release = deferred();
      const originalGet = Store.prototype.get;
      let engine: GoalEngine | undefined;
      let goalId: string | undefined;
      try {
        const runner: RuntimeExecutor = async (options, store) => {
          const task = taskFor(options.query, options.urls);
          await store!.save(task);
          return task;
        };
        engine = new GoalEngine(new GoalRepository(root), 1, runner);
        let goal = await engine.create({ scenario: "travel", mode: "live" });
        goalId = goal.id;
        await engine.decide(goal.id, decision(goal, "direction", "relax"));
        goal = await engine.settle(goal.id);
        assert.equal(goal.status, "awaiting_delight");

        // Hold actual persisted task reads, rather than timing the cancellation with a sleep.
        Store.prototype.get = async function (id: string) {
          reached.resolve();
          await release.promise;
          return originalGet.call(this, id);
        };
        await engine.decide(goal.id, decision(goal, "delight", "bath"));
        await reached.promise;
        if (action === "cancel") await engine.cancel(goal.id);
        else await engine.revise(goal.id, "予定を見直して、もう一度選びたい。");
        const expectedStatus =
          action === "cancel" ? "cancelled" : "awaiting_direction";
        assert.equal((await engine.repo.get(goal.id)).status, expectedStatus);
        release.resolve();
        const settled = await engine.settle(goal.id);
        assert.equal(
          settled.status,
          expectedStatus,
          "stale synthesis must not overwrite cancellation or re-planning",
        );
        assert.deepEqual(
          settled.plan,
          [],
          "old candidates must not be committed after the decision changes",
        );
        assert.equal(settled.revision, action === "cancel" ? 1 : 2);
        if (action === "revise") {
          assert.equal(
            settled.gates.filter(
              (g) => g.revision === 2 && g.status === "pending",
            ).length,
            1,
          );
          assert.equal(
            settled.messages.filter(
              (m) => m.revision === 2 && m.from === "reviewer",
            ).length,
            0,
            "the old reviewer must not insert a completion into the new revision",
          );
        }
      } finally {
        release.resolve();
        Store.prototype.get = originalGet;
        engine?.shutdown();
        if (engine && goalId) await engine.settle(goalId);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
