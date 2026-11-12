import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { normalized } from "./evidence.js";
import {
  entityKey,
  routeSources,
  allowedHosts,
  checkNavigation,
} from "./sources.js";
import { Store } from "./store.js";
import { runTask, type RunOptions } from "./runtime.js";
import type { Task, Criterion, Page, Match } from "./types.js";
export interface SemanticCase {
  id: string;
  service: string;
  provenance: {
    kind: string;
    description: string;
    annotationStatus: "provisional" | "human-reviewed";
    annotator: string;
    independentHumanReview: boolean;
  };
  query: string;
  pages: Page[];
  criteria: Criterion[];
  expected: {
    url: string;
    criterionId: string;
    status: Match["status"];
    evidenceAnchors: string[];
  }[];
}
const statusSchema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("contradicted"),
  Type.Literal("unknown"),
]);
const caseSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9-]+$" }),
  service: Type.String(),
  query: Type.String({ minLength: 1 }),
  provenance: Type.Object({
    kind: Type.String(),
    description: Type.String(),
    annotationStatus: Type.Union([
      Type.Literal("provisional"),
      Type.Literal("human-reviewed"),
    ]),
    annotator: Type.String(),
    independentHumanReview: Type.Boolean(),
  }),
  pages: Type.Array(
    Type.Object({
      id: Type.String(),
      url: Type.String(),
      title: Type.String(),
      text: Type.String({ minLength: 1 }),
      links: Type.Array(
        Type.Object({ text: Type.String(), url: Type.String() }),
      ),
      capturedAt: Type.String(),
      truncated: Type.Boolean(),
      acquisition: Type.Object({
        kind: Type.Literal("public-html"),
        status: Type.Number(),
        charset: Type.String(),
      }),
    }),
    { minItems: 1, maxItems: 10 },
  ),
  criteria: Type.Array(
    Type.Object({
      id: Type.String(),
      description: Type.String(),
      weight: Type.Number({ minimum: 1, maximum: 10 }),
      required: Type.Boolean(),
    }),
    { minItems: 1, maxItems: 12 },
  ),
  expected: Type.Array(
    Type.Object({
      url: Type.String(),
      criterionId: Type.String(),
      status: statusSchema,
      evidenceAnchors: Type.Array(Type.String({ minLength: 1 })),
    }),
    { minItems: 1 },
  ),
});
export async function loadSemanticCases(
  path?: string,
): Promise<SemanticCase[]> {
  const data = JSON.parse(
    await readFile(
      path ?? new URL("../benchmarks/semantic-v1.json", import.meta.url),
      "utf8",
    ),
  );
  if (data.version !== 1 || !Array.isArray(data.cases) || !data.cases.length)
    throw new Error("不正なベンチマーク定義");
  const cases: SemanticCase[] = data.cases;
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("ケースIDが重複しています");
  for (const c of cases) {
    if (!Value.Check(caseSchema, c))
      throw new Error(`ケースのスキーマ不正: ${c.id}`);
    if (
      (c.provenance.annotationStatus === "human-reviewed") !==
      c.provenance.independentHumanReview
    )
      throw new Error("人のレビュー確認が必要です");
    const hosts = allowedHosts(
      routeSources(
        c.query,
        c.pages.map((p) => p.url),
      ),
    );
    for (const p of c.pages) {
      checkNavigation(p.url, hosts);
      if (!entityKey(p.url)?.startsWith(c.service + ":"))
        throw new Error("ケースのサービスと対象URLが一致しません");
      if (!Number.isFinite(Date.parse(p.capturedAt)))
        throw new Error("凍結資料の取得日時が不正です");
    }
    const keys = new Set(c.pages.map((p) => entityKey(p.url)));
    if (
      keys.has(undefined) ||
      keys.size !== c.pages.length ||
      new Set(c.criteria.map((x) => x.id)).size !== c.criteria.length
    )
      throw new Error("個別対象・条件に重複/不正があります");
    if (
      c.expected.length !== c.pages.length * c.criteria.length ||
      new Set(c.expected.map((e) => e.url + ":" + e.criterionId)).size !==
        c.expected.length
    )
      throw new Error("正解ラベルの欠落または重複");
    for (const e of c.expected) {
      const p = c.pages.find((p) => p.url === e.url);
      if (
        !p ||
        !c.criteria.some((x) => x.id === e.criterionId) ||
        e.evidenceAnchors.some(
          (a) => !normalized(p.text).includes(normalized(a)),
        ) ||
        (e.status !== "unknown" && !e.evidenceAnchors.length)
      )
        throw new Error("正解の対象・条件・根拠が一致しません");
    }
  }
  return cases;
}
export interface SemanticResult {
  caseId: string;
  caseSha256: string;
  taskId: string;
  agent: Task["agent"];
  model?: string;
  taskStatus: Task["status"];
  annotationStatus: string;
  inputIntact: boolean;
  contractIntact: boolean;
  strictPass: boolean;
  freeTextReview: "not_evaluated";
  judgements: {
    url: string;
    criterionId: string;
    expected: Match["status"];
    actual: Match["status"] | "missing";
    correct: boolean;
    citationCorrect: boolean;
  }[];
}
export function gradeSemanticTask(c: SemanticCase, task: Task): SemanticResult {
  const inputIntact =
    task.evaluation?.mode === "frozen-replay" &&
    task.evaluation.caseId === c.id &&
    task.evaluation.fixtureSha256 ===
      createHash("sha256").update(JSON.stringify(c.pages)).digest("hex") &&
    c.pages.every((s) => task.pages.some((p) => p.url === s.url)) &&
    task.pages.every((p) =>
      c.pages.some(
        (s) =>
          s.url === p.url && s.text === p.text && s.capturedAt === p.capturedAt,
      ),
    );
  const contractIntact =
    JSON.stringify(task.criteria) === JSON.stringify(c.criteria) &&
    task.query === c.query &&
    JSON.stringify(task.urls) === JSON.stringify(c.pages.map((p) => p.url));
  const judgements = c.expected.map((gold) => {
    const match = task.answer?.candidates
      .find((x) => x.url === gold.url)
      ?.matches.find((m) => m.criterionId === gold.criterionId);
    const evidence = (match?.evidenceIds ?? []).map((id) =>
      task.evidence.find((e) => e.id === id),
    );
    const valid = evidence.every(
      (e) =>
        !!e &&
        entityKey(e.url) === entityKey(gold.url) &&
        task.pages.some(
          (p) =>
            p.id === e.pageId &&
            p.url === e.url &&
            normalized(p.text).includes(normalized(e.quote)),
        ),
    );
    const cited = evidence.filter((e) => !!e).map((e) => normalized(e.quote));
    const asserts =
      match?.status === "supported" || match?.status === "contradicted";
    const citationCorrect =
      valid &&
      (!asserts ||
        (match.status === gold.status &&
          evidence.length > 0 &&
          gold.evidenceAnchors.every((a) =>
            cited.some((q) => q.includes(normalized(a))),
          )));
    return {
      url: gold.url,
      criterionId: gold.criterionId,
      expected: gold.status,
      actual: match?.status ?? ("missing" as const),
      correct: match?.status === gold.status,
      citationCorrect,
    };
  });
  const candidates = task.answer?.candidates ?? [];
  const candidateSetIntact =
    candidates.length === c.pages.length &&
    new Set(candidates.map((c) => c.url)).size === c.pages.length &&
    candidates.every(
      (x) =>
        c.pages.some((p) => p.url === x.url) &&
        x.matches.length === c.criteria.length &&
        new Set(x.matches.map((m) => m.criterionId)).size ===
          c.criteria.length &&
        x.matches.every((m) => c.criteria.some((k) => k.id === m.criterionId)),
    );
  return {
    caseId: c.id,
    caseSha256: createHash("sha256").update(JSON.stringify(c)).digest("hex"),
    taskId: task.id,
    agent: task.agent,
    model: task.model,
    taskStatus: task.status,
    annotationStatus: c.provenance.annotationStatus,
    inputIntact: !!inputIntact,
    contractIntact,
    strictPass:
      !!inputIntact &&
      contractIntact &&
      candidateSetIntact &&
      judgements.every((j) => j.correct && j.citationCorrect),
    freeTextReview: "not_evaluated",
    judgements,
  };
}
export function semanticMetrics(results: SemanticResult[]) {
  const js = results.flatMap((r) =>
      r.judgements.map((j) =>
        r.inputIntact && r.contractIntact
          ? j
          : {
              ...j,
              actual: "missing" as const,
              correct: false,
              citationCorrect: false,
            },
      ),
    ),
    total = js.length;
  const ratio = (n: number, d: number) => (d ? n / d : null);
  const asserted = js.filter(
    (j) => j.actual === "supported" || j.actual === "contradicted",
  );
  const supported = js.filter((j) => j.actual === "supported"),
    unknown = js.filter((j) => j.expected === "unknown");
  const perClass = (["supported", "contradicted", "unknown"] as const).map(
    (label) => {
      const tp = js.filter(
        (j) => j.expected === label && j.actual === label,
      ).length;
      const actual = js.filter((j) => j.expected === label).length,
        predicted = js.filter((j) => j.actual === label).length;
      return {
        label,
        support: actual,
        precision: ratio(tp, predicted),
        recall: ratio(tp, actual),
        f1: ratio(2 * tp, actual + predicted),
      };
    },
  );
  const f1s = perClass.filter((p) => p.f1 !== null).map((p) => p.f1!);
  return {
    cases: results.length,
    labelledClaims: total,
    targetedEntailmentAccuracy: ratio(
      js.filter((j) => j.correct).length,
      total,
    ),
    macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null,
    supportedPrecision: ratio(
      supported.filter((j) => j.correct).length,
      supported.length,
    ),
    unsupportedAssertionRate: ratio(
      supported.filter((j) => !j.correct).length,
      supported.length,
    ),
    unknownRecall: ratio(
      unknown.filter((j) => j.correct).length,
      unknown.length,
    ),
    citationAccuracy: ratio(
      asserted.filter((j) => j.citationCorrect).length,
      asserted.length,
    ),
    strictCasePassRate: ratio(
      results.filter((r) => r.strictPass).length,
      results.length,
    ),
    perClass,
    freeTextReview: "not_evaluated",
    independentHumanReviewedCases: results.filter(
      (r) => r.annotationStatus === "human-reviewed",
    ).length,
  };
}
export async function runSemanticBenchmark(
  options: {
    caseIds?: string[];
    agent?: RunOptions["agent"];
    model?: string;
    maxSteps?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (s: string) => void;
  } = {},
  store = new Store(),
  runner = runTask,
) {
  const all = await loadSemanticCases(),
    cases = all.filter(
      (c) => !options.caseIds?.length || options.caseIds.includes(c.id),
    );
  if (
    !cases.length ||
    options.caseIds?.some((id) => !cases.some((c) => c.id === id))
  )
    throw new Error("不明なベンチマークケースID");
  const id = randomUUID(),
    results: SemanticResult[] = [],
    notRun: string[] = [];
  let stopped = false;
  const report = () => ({
    id,
    dataset: "targeted-semantic-regression-v1",
    datasetSha256: createHash("sha256")
      .update(JSON.stringify(all))
      .digest("hex"),
    split: "regression",
    annotationStatus: cases.every((c) => c.provenance.independentHumanReview)
      ? "human-reviewed"
      : "provisional",
    scope: "structured-entailment-judgements",
    plannedCases: cases.length,
    completedCases: results.length,
    notRun,
    results,
    metrics: semanticMetrics(results),
    overallPass:
      !notRun.length &&
      results.length === cases.length &&
      results.every((r) => r.strictPass),
  });
  for (const c of cases) {
    if (stopped || options.signal?.aborted) {
      notRun.push(c.id);
      continue;
    }
    options.onProgress?.(`benchmark ${c.id}`);
    const task = await runner(
      {
        query: c.query,
        urls: c.pages.map((p) => p.url),
        benchmark: {
          id: c.id,
          pages: structuredClone(c.pages),
          criteria: structuredClone(c.criteria),
        },
        agent: options.agent,
        model: options.model,
        maxSteps: options.maxSteps ?? 40,
        maxPages: 12,
        timeoutSeconds: options.timeoutSeconds ?? 120,
        deepenRounds: 0,
        signal: options.signal,
        onProgress: options.onProgress,
      },
      store,
    );
    results.push(gradeSemanticTask(c, task));
    if (
      (task.failure && task.failure.kind !== "unknown") ||
      task.status === "cancelled"
    )
      stopped = true;
  }
  const dir = join(store.root, "benchmarks", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, randomUUID() + ".tmp");
  await writeFile(temp, JSON.stringify(report(), null, 2), { mode: 0o600 });
  await rename(temp, join(dir, "report.json"));
  return report();
}
