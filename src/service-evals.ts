import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask, type RunOptions } from "./runtime.js";
import { entityKey } from "./sources.js";
import { assessPage } from "./page-quality.js";
import { Store } from "./store.js";
import type { Task } from "./types.js";
export interface ServiceEvalCase {
  id: string;
  service: string;
  query: string;
  urls: string[];
  minCandidates: number;
  expectedCriteria: string[];
}
export interface ServiceEvalResult {
  caseId: string;
  service: string;
  taskId: string;
  taskStatus: Task["status"] | "not_started";
  outcome:
    | "validated"
    | "partial"
    | "site_blocked"
    | "runtime_failed"
    | "needs_review"
    | "not_run_quota";
  candidates: number;
  eligible: number;
  supported: number;
  unknown: number;
  contradicted: number;
  individualDetails: boolean;
  pageGrounded: boolean;
  requestedCriteriaFound: string[];
  requestedCriteriaMissing: string[];
  access: ReturnType<typeof assessPage>[];
  urls: string[];
  error?: string;
}
export async function loadServiceCases(): Promise<ServiceEvalCase[]> {
  const body = JSON.parse(
    await readFile(
      new URL("../examples/service-evals.json", import.meta.url),
      "utf8",
    ),
  );
  return body.cases;
}
/** Structural checks cannot prove that a quote semantically entails a model's claim. */
export function evaluateServiceTask(
  test: ServiceEvalCase,
  task: Task,
): ServiceEvalResult {
  const candidates = task.answer?.candidates ?? [];
  const matches = candidates.flatMap((c) => c.matches);
  const access = task.pages.map(assessPage);
  const individualDetails =
    candidates.length > 0 && candidates.every((c) => !!entityKey(c.url));
  const pageGrounded =
    candidates.length > 0 &&
    candidates.every((c) => task.pages.some((p) => p.url === c.url)) &&
    matches
      .filter((m) => m.status !== "unknown")
      .every(
        (m) =>
          m.evidenceIds.length > 0 &&
          m.evidenceIds.every((id) => task.evidence.some((e) => e.id === id)),
      );
  const criteria = task.criteria.map((c) => c.description).join(" ");
  const found = test.expectedCriteria.filter((term) => criteria.includes(term));
  const missing = test.expectedCriteria.filter(
    (term) => !criteria.includes(term),
  );
  let outcome: ServiceEvalResult["outcome"] = "needs_review";
  if (
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "timed_out"
  )
    outcome = "runtime_failed";
  else if (!candidates.length && access.some((a) => a.shouldStop))
    outcome = "site_blocked";
  else if (candidates.length && individualDetails && pageGrounded) {
    outcome =
      candidates.length >= test.minCandidates &&
      candidates.every((c) => c.eligible) &&
      missing.length === 0
        ? "validated"
        : "partial";
  }
  return {
    caseId: test.id,
    service: test.service,
    taskId: task.id,
    taskStatus: task.status,
    outcome,
    candidates: candidates.length,
    eligible: candidates.filter((c) => c.eligible).length,
    supported: matches.filter((m) => m.status === "supported").length,
    unknown: matches.filter((m) => m.status === "unknown").length,
    contradicted: matches.filter((m) => m.status === "contradicted").length,
    individualDetails,
    pageGrounded,
    requestedCriteriaFound: found,
    requestedCriteriaMissing: missing,
    access,
    urls: task.pages.map((p) => p.url),
    error: task.error,
  };
}
export async function runServiceEvaluations(
  options: {
    caseIds?: string[];
    parallel?: number;
    model?: string;
    maxSteps?: number;
    maxPages?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
  store = new Store(),
): Promise<ServiceEvalResult[]> {
  const cases = (await loadServiceCases()).filter(
    (c) => !options.caseIds?.length || options.caseIds.includes(c.id),
  );
  if (!cases.length) throw new Error("一致する評価ケースがありません");
  if (options.caseIds?.some((id) => !cases.some((c) => c.id === id)))
    throw new Error("不明な評価ケースIDが指定されています");
  const parallel = options.parallel ?? 1;
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 2)
    throw new Error("無料API評価の並列数は1または2を指定してください");
  const results: ServiceEvalResult[] = [];
  const queue = [...cases];
  let exhausted = false;
  const worker = async () => {
    for (;;) {
      options.signal?.throwIfAborted();
      if (exhausted) return;
      const test = queue.shift();
      if (!test) return;
      options.onProgress?.(`eval: ${test.id}`);
      const runOptions: RunOptions = {
        query: test.query,
        urls: test.urls,
        model: options.model,
        maxSteps: options.maxSteps ?? 80,
        maxPages: options.maxPages ?? 10,
        timeoutSeconds: options.timeoutSeconds ?? 360,
        signal: options.signal,
        onProgress: (m) => options.onProgress?.(`${test.id}: ${m}`),
      };
      const task = await runTask(runOptions, store);
      const result = evaluateServiceTask(test, task);
      results.push(result);
      if (task.failure?.kind === "quota_exhausted") exhausted = true;
      const dir = join(store.root, "service-evals");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(dir, `${test.id}.json`),
        JSON.stringify(result, null, 2),
        { mode: 0o600 },
      );
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return cases.map(
    (test) =>
      results.find((r) => r.caseId === test.id) ?? {
        caseId: test.id,
        service: test.service,
        taskId: "",
        taskStatus: "not_started",
        outcome: "not_run_quota",
        candidates: 0,
        eligible: 0,
        supported: 0,
        unknown: 0,
        contradicted: 0,
        individualDetails: false,
        pageGrounded: false,
        requestedCriteriaFound: [],
        requestedCriteriaMissing: test.expectedCriteria,
        access: [],
        urls: [],
        error: "無料日次枠が枯渇したため実行を見送りました",
      },
  );
}

export interface ServiceProbeResult {
  caseId: string;
  service: string;
  mode: "browser-only";
  outcome: "details_read" | "listing_only" | "site_blocked" | "browser_error";
  artifactDir: string;
  pages: {
    url: string;
    title: string;
    assessment: ReturnType<typeof assessPage>;
    textLength: number;
  }[];
  discoveredDetails: number;
  error?: string;
}
/** Browser-only diagnostics intentionally do not assert that a natural-language goal was answered. */
export async function probeServiceCases(
  options: {
    caseIds?: string[];
    parallel?: number;
    maxDetails?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
  store = new Store(),
): Promise<ServiceProbeResult[]> {
  const { Browser } = await import("./browser.js");
  const { routeSources, allowedHosts } = await import("./sources.js");
  const { randomUUID } = await import("node:crypto");
  const cases = (await loadServiceCases()).filter(
    (c) => !options.caseIds?.length || options.caseIds.includes(c.id),
  );
  if (
    !cases.length ||
    options.caseIds?.some((id) => !cases.some((c) => c.id === id))
  )
    throw new Error("不明な評価ケースIDが指定されています");
  const parallel = options.parallel ?? 1,
    maxDetails = options.maxDetails ?? 2;
  if (
    options.timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 1)
  )
    throw new Error("制限時間は1以上の整数を指定してください");
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 2)
    throw new Error("評価の並列数は1または2を指定してください");
  if (!Number.isSafeInteger(maxDetails) || maxDetails < 0 || maxDetails > 5)
    throw new Error("詳細ページ数は0〜5を指定してください");
  const queue = [...cases],
    results: ServiceProbeResult[] = [];
  const worker = async () => {
    for (;;) {
      options.signal?.throwIfAborted();
      const test = queue.shift();
      if (!test) return;
      const id = randomUUID(),
        dir = join(store.root, "service-probes", id, test.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const signal = AbortSignal.any([
        AbortSignal.timeout((options.timeoutSeconds ?? 150) * 1000),
        ...(options.signal ? [options.signal] : []),
      ]);
      const browser = new Browser(
        `eval-${id}`,
        dir,
        allowedHosts(routeSources(test.query, test.urls)),
        signal,
      );
      const result: ServiceProbeResult = {
        caseId: test.id,
        service: test.service,
        mode: "browser-only",
        outcome: "browser_error",
        artifactDir: dir,
        pages: [],
        discoveredDetails: 0,
      };
      const capture = async (url: string) => {
        options.onProgress?.(`${test.id}: ${url}`);
        const page = await browser.open(url);
        result.pages.push({
          url: page.url,
          title: page.title,
          assessment: assessPage(page),
          textLength: page.text.length,
        });
        await writeFile(
          join(dir, `page-${result.pages.length}.json`),
          JSON.stringify(page, null, 2),
          { mode: 0o600 },
        );
        return page;
      };
      try {
        await browser.init();
        const listing = await capture(test.urls[0]!);
        if (assessPage(listing).shouldStop) result.outcome = "site_blocked";
        else {
          const links = listing.links
            .filter((l) => !!entityKey(l.url))
            .filter(
              (l, i, all) =>
                all.findIndex((a) => entityKey(a.url) === entityKey(l.url)) ===
                i,
            );
          result.discoveredDetails = links.length;
          for (const link of links.slice(0, maxDetails))
            await capture(link.url);
          result.outcome = result.pages
            .slice(1)
            .some((p) => !p.assessment.shouldStop)
            ? "details_read"
            : "listing_only";
        }
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
      } finally {
        try {
          await browser.close();
        } catch {}
        await writeFile(
          join(dir, "probe.json"),
          JSON.stringify(result, null, 2),
          { mode: 0o600 },
        );
      }
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return cases.map((c) => results.find((r) => r.caseId === c.id)!);
}
