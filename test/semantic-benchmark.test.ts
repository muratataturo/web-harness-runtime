import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSemanticCases,
  gradeSemanticTask,
  semanticMetrics,
  runSemanticBenchmark,
  type SemanticCase,
} from "../src/semantic-benchmark.js";
import { newTask, type RunOptions } from "../src/runtime.js";
import { addEvidence } from "../src/evidence.js";
import { ReplayBrowser } from "../src/replay-browser.js";
import { Store } from "../src/store.js";
import { improveTask } from "../src/improvement.js";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "semantic-test-"));
  return {
    dir,
    store: new Store(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
// Grader oracle only: never used in benchmark inference or as a model result.
function oracle(c: SemanticCase, options?: RunOptions) {
  const t = newTask(
    options ?? {
      query: c.query,
      urls: c.pages.map((p) => p.url),
      benchmark: { id: c.id, pages: c.pages, criteria: c.criteria },
      maxSteps: 40,
      maxPages: 12,
      timeoutSeconds: 60,
    },
  );
  t.pages = structuredClone(c.pages);
  t.status = "succeeded";
  t.answer = {
    summary: "採点器の単体検証用正解。モデル生成ではない。",
    limitations: [],
    candidates: c.pages.map((p) => ({
      name: p.title,
      url: p.url,
      score: 0,
      eligible: false,
      matches: c.expected
        .filter((e) => e.url === p.url)
        .map((g) => ({
          criterionId: g.criterionId,
          status: g.status,
          explanation: "採点器用の固定ラベル",
          evidenceIds:
            g.status === "unknown" ? [] : [addEvidence(t, p.id, p.text).id],
        })),
    })),
  };
  return t;
}
test("gold corpus is complete, anchored and explicitly provisional", async () => {
  const cs = await loadSemanticCases();
  assert.equal(cs.length, 8);
  assert.equal(
    cs.reduce((s, c) => s + c.expected.length, 0),
    28,
  );
  assert.equal(
    cs.every(
      (c) =>
        !c.provenance.independentHumanReview &&
        c.provenance.annotationStatus === "provisional",
    ),
    true,
  );
  for (const c of cs)
    assert.equal(gradeSemanticTask(c, oracle(c)).strictPass, true);
  const m = semanticMetrics(cs.map((c) => gradeSemanticTask(c, oracle(c))));
  assert.equal(m.targetedEntailmentAccuracy, 1);
  assert.equal(m.strictCasePassRate, 1);
  assert.equal(m.independentHumanReviewedCases, 0);
  assert.equal(m.freeTextReview, "not_evaluated");
});
test("wrong support of an unknown claim lowers accuracy and support precision", async () => {
  const c = (await loadSemanticCases())[0]!,
    t = oracle(c);
  t.answer!.candidates[0]!.matches[2]!.status = "supported";
  const r = gradeSemanticTask(c, t),
    m = semanticMetrics([r]);
  assert.equal(r.strictPass, false);
  assert.equal(m.targetedEntailmentAccuracy, 2 / 3);
  assert.equal(m.supportedPrecision, 2 / 3);
  assert.equal(m.unknownRecall, 0);
  assert.equal(m.citationAccuracy, 2 / 3);
});
test("quotes from another entity, invented quotes and input drift cannot pass", async () => {
  const c = (await loadSemanticCases()).find(
    (c) => c.id === "books-edition-identity",
  )!;
  const t = oracle(c);
  t.evidence[0]!.url = c.pages[1]!.url;
  assert.equal(gradeSemanticTask(c, t).strictPass, false);
  const forged = oracle(c);
  forged.evidence[0]!.quote = "取得本文にない正解っぽい情報";
  assert.equal(gradeSemanticTask(c, forged).strictPass, false);
  const drift = oracle(c);
  drift.pages[0]!.text += "資料改変";
  assert.equal(gradeSemanticTask(c, drift).inputIntact, false);
  assert.equal(gradeSemanticTask(c, drift).strictPass, false);
  assert.equal(
    semanticMetrics([gradeSemanticTask(c, drift)]).targetedEntailmentAccuracy,
    0,
  );
  const changed = oracle(c);
  changed.criteria[0]!.description = "別の簡単な条件";
  assert.equal(gradeSemanticTask(c, changed).contractIntact, false);
  const alteredQuery = oracle(c);
  alteredQuery.query += "別の簡単な問題";
  assert.equal(gradeSemanticTask(c, alteredQuery).contractIntact, false);
  const duplicate = oracle(c);
  duplicate.answer!.candidates[0]!.matches.push(
    structuredClone(duplicate.answer!.candidates[0]!.matches[0]!),
  );
  assert.equal(gradeSemanticTask(c, duplicate).strictPass, false);
});
test("missing answers have zero accuracy and do not manufacture precision", async () => {
  const c = (await loadSemanticCases())[0]!,
    t = oracle(c);
  t.answer = undefined;
  const m = semanticMetrics([gradeSemanticTask(c, t)]);
  assert.equal(m.targetedEntailmentAccuracy, 0);
  assert.equal(m.supportedPrecision, null);
  assert.equal(m.strictCasePassRate, 0);
});
test("free-form prose is explicitly not graded by the targeted-label benchmark", async () => {
  const c = (await loadSemanticCases())[0]!,
    t = oracle(c);
  t.answer!.summary = "自由文には誤りがあり得る。";
  assert.equal(gradeSemanticTask(c, t).freeTextReview, "not_evaluated");
});
test("replay cannot fetch outside the frozen corpus or relabel capture time", async () => {
  const c = (await loadSemanticCases())[0]!;
  const b = new ReplayBrowser(
    c.pages,
    ["beauty.hotpepper.jp"],
    new AbortController().signal,
  );
  assert.equal(
    (await b.open(c.pages[0]!.url)).capturedAt,
    c.pages[0]!.capturedAt,
  );
  await assert.rejects(
    b.open("https://beauty.hotpepper.jp/slnH999999999/"),
    /ライブ取得には切り替えません/,
  );
  await assert.rejects(b.open("https://attacker.invalid/"));
});
test("runner receives no expected labels and freezes the same inputs for all engines", async () => {
  const f = await setup();
  const cs = await loadSemanticCases();
  try {
    const report = await runSemanticBenchmark(
      { caseIds: [cs[0]!.id], agent: "claude-code", model: "claude-haiku-5-5" },
      f.store,
      async (o, s) => {
        assert.deepEqual(Object.keys(o.benchmark!).sort(), [
          "criteria",
          "id",
          "pages",
        ]);
        assert.equal(o.agent, "claude-code");
        assert.equal(o.deepenRounds, 0);
        const t = oracle(cs[0]!, o);
        await s!.save(t);
        return t;
      },
    );
    assert.equal(report.overallPass, true);
    assert.equal(report.metrics.labelledClaims, 3);
  } finally {
    await f.cleanup();
  }
});
test("quota halts subsequent benchmark cases and reports the unrun coverage", async () => {
  const f = await setup();
  const cs = await loadSemanticCases();
  let calls = 0;
  try {
    const report = await runSemanticBenchmark(
      { caseIds: cs.slice(0, 2).map((c) => c.id) },
      f.store,
      async (o, s) => {
        calls++;
        const t = oracle(cs[0]!, o);
        t.answer = undefined;
        t.status = "failed";
        t.failure = {
          kind: "quota_exhausted",
          retryable: false,
          action: "wait",
        };
        await s!.save(t);
        return t;
      },
    );
    assert.equal(calls, 1);
    assert.equal(report.notRun.length, 1);
    assert.equal(report.overallPass, false);
  } finally {
    await f.cleanup();
  }
});
test("invalid gold anchors are rejected and replay tasks cannot start live improvement", async () => {
  const f = await setup(),
    c = (await loadSemanticCases())[0]!;
  try {
    const bad = structuredClone(c);
    bad.expected[0]!.evidenceAnchors = ["資料にない正解"];
    const path = join(f.dir, "bad.json");
    await writeFile(path, JSON.stringify({ version: 1, cases: [bad] }));
    await assert.rejects(loadSemanticCases(path), /根拠/);
    const t = oracle(c);
    await f.store.save(t);
    await assert.rejects(
      improveTask(t.id, {}, f.store),
      /ライブ自己改善には使いません/,
    );
  } finally {
    await f.cleanup();
  }
});
