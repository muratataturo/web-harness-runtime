import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Node ESM helper is shared with the package release gate.
import {
  assertLiveAcceptance,
  requiredChatChecks,
} from "../scripts/chat-acceptance.mjs";
const now = Date.parse("2026-11-13T00:00:00Z");
function receipt() {
  return {
    schemaVersion: 1,
    mode: "live",
    passed: true,
    revision: "current",
    completedAt: new Date(now).toISOString(),
    cases: ["recruit", "rakuten"].map((family) => ({
      family,
      taskId: family,
      runStatus: "succeeded",
      taskStatus: "succeeded",
      source: "live",
      mode: "auto",
      execution: {
        target: "openshell",
        cleanupStatus: "stopped",
        sandboxId: "owned-worker",
      },
      security: {
        mode: "hardened",
        profileId: `${family}-public-research`,
        artifactNonce: family,
      },
      evidenceCount: 1,
      agent: "codex",
      modelTokens: 1,
      checks: Object.fromEntries(
        requiredChatChecks.map((key: string) => [key, true]),
      ),
    })),
  };
}
test("release requires successful live UI acceptance for both runtime families", () => {
  assert.doesNotThrow(() => assertLiveAcceptance(receipt(), "current", now));
  for (const mutate of [
    (r: any) => {
      r.mode = "fixture";
    },
    (r: any) => {
      r.passed = false;
    },
    (r: any) => {
      r.cases.pop();
    },
    (r: any) => {
      r.cases[1].family = "recruit";
    },
    (r: any) => {
      r.cases[0].source = "replay";
    },
    (r: any) => {
      r.cases[0].execution.target = "local";
    },
    (r: any) => {
      r.cases[0].execution.cleanupStatus = "unconfirmed";
    },
    (r: any) => {
      r.cases[0].checks.sourceBodyVisible = false;
    },
    (r: any) => {
      r.cases[0].taskStatus = "partial";
    },
    (r: any) => {
      r.cases[0].modelTokens = 0;
    },
    (r: any) => {
      r.cases[0].security.artifactNonce = "another-task";
    },
  ]) {
    const r = receipt();
    mutate(r);
    assert.throws(() => assertLiveAcceptance(r, "current", now));
  }
});
test("old UI evidence cannot validate changed code, expired runs, or future timestamps", () => {
  assert.throws(() => assertLiveAcceptance(receipt(), "new-code", now));
  assert.throws(() =>
    assertLiveAcceptance(receipt(), "current", now + 24 * 60 * 60 * 1000 + 1),
  );
  assert.throws(() => assertLiveAcceptance(receipt(), "current", now - 1));
  assert.throws(() => assertLiveAcceptance(undefined, "current", now));
});
