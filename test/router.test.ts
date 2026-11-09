import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { routeJobs, validateGraph, type RoutedJob } from "../src/router.js";
test("DAG validation rejects cycles, missing dependencies and duplicate identifiers", () => {
  assert.throws(() =>
    validateGraph([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]),
  );
  assert.throws(() => validateGraph([{ id: "a", dependsOn: ["missing"] }]));
  assert.throws(() =>
    validateGraph([
      { id: "a", dependsOn: [] },
      { id: "a", dependsOn: [] },
    ]),
  );
});
test("router respects dependency ordering and its concurrency limit", async () => {
  let active = 0,
    maximum = 0;
  const finished = new Set();
  const starts: string[] = [];
  const job = (id: string, dependsOn: string[]): RoutedJob<number> => ({
    id,
    agent: id,
    dependsOn,
    run: async ({ results }) => {
      starts.push(id);
      for (const dependency of dependsOn) {
        assert.ok(finished.has(dependency));
        assert.equal(typeof results.get(dependency), "number");
      }
      maximum = Math.max(maximum, ++active);
      await delay(15);
      active--;
      finished.add(id);
      return 1;
    },
  });
  const result = await routeJobs(
    [
      job("stay", []),
      job("food", []),
      job("explore", []),
      job("review", ["stay", "food", "explore"]),
    ],
    { concurrency: 2 },
  );
  assert.equal(maximum, 2);
  assert.equal(starts.at(-1), "review");
  assert.ok(result.every((r) => r.status === "succeeded"));
});
test("a failed dependency skips dependent work while independent jobs proceed", async () => {
  let carRan = false;
  const result = await routeJobs(
    [
      {
        id: "home",
        agent: "home",
        dependsOn: [],
        run: async () => {
          throw new Error("no verified house");
        },
      },
      {
        id: "car",
        agent: "car",
        dependsOn: ["home"],
        run: async () => {
          carRan = true;
        },
      },
      { id: "food", agent: "food", dependsOn: [], run: async () => {} },
    ],
    { concurrency: 2 },
  );
  assert.equal(result[1]?.status, "skipped");
  assert.equal(result[2]?.status, "succeeded");
  assert.equal(carRan, false);
});
test("an already-aborted router never starts work", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await routeJobs(
    [
      {
        id: "a",
        agent: "a",
        dependsOn: [],
        run: async () => {
          calls++;
        },
      },
    ],
    { concurrency: 1, signal: controller.signal },
  );
  assert.equal(calls, 0);
  assert.equal(result[0]?.status, "skipped");
});
