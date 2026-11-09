import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createWorkbenchServer } from "../src/server.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";
test("local API validates origins, JSON, live opt-in and stale decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-api-"));
  const engine = new GoalEngine(new GoalRepository(root), 1);
  const server = createWorkbenchServer(engine);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal(
      (
        await fetch(base + "/api/goals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/api/goals", { method: "POST", body: "{}" })).status,
      415,
    );
    assert.equal(
      (
        await fetch(base + "/api/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario: "travel", mode: "live" }),
        })
      ).status,
      400,
    );
    const response = await fetch(base + "/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "travel" }),
    });
    assert.equal(response.status, 201);
    const goal: any = await response.json();
    assert.equal(
      (
        await fetch(base + `/api/goals/${goal.id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gateId: goal.gates[0].id,
            revision: 0,
            choiceId: "relax",
          }),
        })
      ).status,
      409,
    );
    assert.equal((await fetch(base + "/api/goals/../../.env")).status, 404);
    assert.equal((await fetch(base + "/.env")).status, 404);
  } finally {
    engine.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
