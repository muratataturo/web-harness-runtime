import { roomConflicts } from "./improvement-conflicts.js";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.js";
import { type RunOptions } from "./runtime.js";
import {
  configuredRuntime,
  runtimeTarget,
  type RuntimeExecutor,
} from "./executors.js";
import { interactionMode, type InteractionMode } from "./interaction.js";
import { validateAnswer, setCriteria, addEvidence } from "./evidence.js";
import { verifyDetail } from "./detail-contracts.js";
import { assessPage } from "./page-quality.js";
import {
  entityKey,
  checkNavigation,
  allowedHosts,
  routeSources,
} from "./sources.js";
import { actionKey, deepeningActions } from "./research.js";
import type { Task, Criterion, Answer } from "./types.js";
import type { ImprovementContext } from "./improvement-context.js";

export interface Diagnosis {
  complete: boolean;
  verifiedDetails: number;
  supportedRequired: number;
  supportedOptional: number;
  validationError?: string;
  gaps: { url: string; fields: string[] }[];
  causes: string[];
  achievements: string[];
}
export interface ImprovementLoop {
  interactionMode?: InteractionMode;
  executionTarget?: "local" | "openshell";
  parentLoopId?: string;
  approval?: {
    id: string;
    status: "pending" | "decided";
    title: string;
    reason: string;
    choices: {
      id: "return_partial" | "research_more" | "add_url";
      title: string;
      tradeoff: string;
      recommended?: boolean;
    }[];
    selected?: string;
    additionalUrls?: string[];
    decidedAt?: string;
    nextLoopId?: string;
    error?: string;
  };
  id: string;
  sourceTaskId: string;
  query: string;
  urls: string[];
  criteria: Criterion[];
  candidateUrls: string[];
  additionalUrls: string[];
  minimumCandidates: number;
  allowReplacements?: boolean;
  learnedFrom?: string;
  learnedStrategy?: ImprovementContext["strategy"];
  learnedUrls?: string[];
  agent: Task["agent"];
  model?: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "running"
    | "succeeded"
    | "needs_input"
    | "completed_partial"
    | "exhausted"
    | "stalled"
    | "blocked"
    | "cancelled"
    | "timed_out"
    | "failed";
  stopReason?: string;
  maxIterations: number;
  timeoutSeconds: number;
  bestTaskId: string;
  baseline: Diagnosis;
  best: Diagnosis;
  iterations: {
    number: number;
    taskId: string;
    plan: ImprovementContext;
    result: Diagnosis;
    accepted: boolean;
    corrections?: string[];
    newPages: number;
    taskStatus: Task["status"];
  }[];
  promotedStrategies: ImprovementContext["strategy"][];
  questions: {
    url: string;
    missing: string[];
    question: string;
    options: string[];
  }[];
}
export class ImprovementStore {
  constructor(private store = new Store()) {}
  dir(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("不正な改善ループID");
    return join(this.store.root, "improvements", id);
  }
  async save(loop: ImprovementLoop) {
    loop.updatedAt = new Date().toISOString();
    const dir = this.dir(loop.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(loop, null, 2), { mode: 0o600 });
    await rename(temporary, join(dir, "loop.json"));
  }
  async get(id: string): Promise<ImprovementLoop> {
    return JSON.parse(await readFile(join(this.dir(id), "loop.json"), "utf8"));
  }
  async list(): Promise<ImprovementLoop[]> {
    let ids: string[];
    try {
      ids = await readdir(join(this.store.root, "improvements"));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const loops = await Promise.all(
      ids.map((id) => this.get(id).catch(() => undefined)),
    );
    return loops
      .filter((l): l is ImprovementLoop => !!l)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
/** Recompute completion from fresh captured pages/quotes, never model score/status or saved eligibility. */
export function diagnose(
  task: Task,
  criteria: Criterion[],
  candidateUrls: string[],
  allowReplacements = false,
  minimumCandidates = Math.max(
    candidateUrls.length,
    Number(
      task.query.match(/(10|[1-9])\s*(?:件|冊|商品|物件|宿|店舗|店|台)/)?.[1] ??
        0,
    ),
  ),
): Diagnosis {
  const d: Diagnosis = {
    complete: false,
    verifiedDetails: 0,
    supportedRequired: 0,
    supportedOptional: 0,
    gaps: [],
    causes: [],
    achievements: [],
  };
  if (task.pages.some((p) => p.truncated)) d.causes.push("truncated_body");
  if (task.steps >= task.limits.maxSteps)
    d.causes.push("step_budget_exhausted");
  if (
    task.research &&
    task.research.pagesOpened >= task.research.maxPages &&
    task.research.maxPages > 0
  )
    d.causes.push("deepening_budget_exhausted");
  if (task.status === "timed_out") d.causes.push("runtime_timeout");
  let answer: Answer | undefined;
  try {
    if (JSON.stringify(task.criteria) !== JSON.stringify(criteria))
      throw new Error("元の評価条件が変更されています");
    const copy = structuredClone(task);
    copy.criteria = structuredClone(criteria);
    copy.evidence = [];
    if (new Set(task.evidence.map((e) => e.id)).size !== task.evidence.length)
      throw new Error("根拠IDが重複しています");
    for (const e of task.evidence) {
      if (task.pages.find((p) => p.id === e.pageId)?.url !== e.url)
        throw new Error("根拠の出典が一致しません");
      addEvidence(copy, e.pageId, e.quote);
    }
    copy.evidence = structuredClone(task.evidence);
    answer = validateAnswer(
      copy,
      task.answer?.summary ?? "",
      task.answer?.candidates ?? [],
      task.answer?.limitations ?? [],
    );
  } catch (e) {
    d.validationError = e instanceof Error ? e.message : String(e);
    d.causes.push("invalid_or_missing_answer");
  }
  const conflicts = roomConflicts({ ...task, criteria });
  const comparedUrls =
    allowReplacements &&
    answer &&
    answer.candidates.length >= candidateUrls.length
      ? answer.candidates.map((c) => c.url)
      : [...candidateUrls, ...(answer?.candidates.map((c) => c.url) ?? [])];
  const expected = [
    ...new Map(comparedUrls.map((u) => [entityKey(u), u])).values(),
  ];
  if (!expected.length) d.causes.push("no_candidates");
  for (const url of expected) {
    const key = entityKey(url);
    const pages = task.pages.filter((p) => entityKey(p.url) === key);
    const verified = pages.some(
      (p) =>
        verifyDetail(p).status === "verified" &&
        p.url === answer?.candidates.find((c) => entityKey(c.url) === key)?.url,
    );
    const candidate = answer?.candidates.find((c) => entityKey(c.url) === key);
    const fields: string[] = [];
    if (!verified) {
      fields.push("個別詳細の必須項目");
      d.causes.push(
        pages.some((p) => assessPage(p).shouldStop)
          ? "source_unavailable"
          : "detail_missing",
      );
    } else {
      d.verifiedDetails++;
      d.achievements.push("detail:" + key);
    }
    for (const c of criteria) {
      const match = candidate?.matches.find((m) => m.criterionId === c.id);
      if (
        conflicts.stationConflicts.get(candidate?.url ?? url)?.includes(c.id)
      ) {
        fields.push(c.description + "（同一物件の掲載間で徒歩分数が不一致）");
        d.causes.push("source_conflict");
      } else if (match?.status === "supported") {
        if (c.required) d.supportedRequired++;
        else d.supportedOptional++;
        d.achievements.push(key + ":" + c.id);
      } else if (c.required) {
        fields.push(c.description);
        d.causes.push(
          match?.status === "contradicted"
            ? "condition_contradicted"
            : "required_unknown",
        );
      }
    }
    if (!candidate) d.causes.push("candidate_missing");
    if (fields.length) d.gaps.push({ url, fields });
  }
  if (conflicts.duplicateUrls.size) {
    d.causes.push("possible_duplicate_room");
    for (const url of conflicts.duplicateUrls)
      d.gaps.push({
        url,
        fields: [
          "同一部屋の別掲載の可能性。別候補として数えず部屋の同一性を確認",
        ],
      });
  }
  if ((answer?.candidates.length ?? 0) < minimumCandidates) {
    d.causes.push("candidate_count_missing");
    d.gaps.push({
      url: candidateUrls[0] ?? task.urls[0]!,
      fields: [
        `候補数${minimumCandidates}件以上（現在${answer?.candidates.length ?? 0}件）`,
      ],
    });
  }
  // Extra candidates cannot conceal a newly introduced failure either.
  const extras =
    answer?.candidates.filter(
      (c) => !expected.some((u) => entityKey(u) === entityKey(c.url)),
    ) ?? [];
  if (
    extras.some(
      (c) =>
        !c.eligible ||
        !task.pages.some(
          (p) => p.url === c.url && verifyDetail(p).status === "verified",
        ),
    )
  )
    d.causes.push("invalid_extra_candidate");
  const grouped = new Map<string, Set<string>>();
  for (const gap of d.gaps) {
    const fields = grouped.get(gap.url) ?? new Set<string>();
    gap.fields.forEach((f) => fields.add(f));
    grouped.set(gap.url, fields);
  }
  d.gaps = [...grouped].map(([url, fields]) => ({ url, fields: [...fields] }));
  d.causes = [...new Set(d.causes)];
  d.complete =
    !!expected.length &&
    !d.validationError &&
    !d.gaps.length &&
    !d.causes.includes("invalid_extra_candidate");
  return d;
}
function improves(
  before: Diagnosis,
  after: Diagnosis,
  allowReplacements = false,
) {
  if (allowReplacements && after.complete && !before.complete) return true;
  if (after.validationError) return false;
  const a = [
    before.verifiedDetails,
    before.supportedRequired,
    before.supportedOptional,
  ];
  const b = [
    after.verifiedDetails,
    after.supportedRequired,
    after.supportedOptional,
  ];
  return (
    before.achievements.every((k) => after.achievements.includes(k)) &&
    b.every((n, i) => n >= a[i]!) &&
    (b.some((n, i) => n > a[i]!) ||
      (after.complete && !before.complete) ||
      !!before.validationError)
  );
}
export function improvementPlan(
  loop: ImprovementLoop,
  tasks: Task[],
  iteration: number,
): ImprovementContext {
  const attempted = new Set(
    tasks.flatMap((t) => [
      ...t.pages.map((p) => actionKey("link", p.url)),
      ...t.pages
        .filter((p) => p.acquisition?.kind === "browser-dom")
        .map((p) => actionKey("render", p.url)),
      ...(t.research?.attempts ?? []).map((a) => actionKey(a.mode, a.url)),
    ]),
  );
  const hosts = allowedHosts(routeSources(loop.query, loop.urls));
  const actions = loop.best.gaps.flatMap((g) =>
    tasks.flatMap((t) =>
      t.pages
        .filter((p) => entityKey(p.url) === entityKey(g.url))
        .flatMap((p) => deepeningActions(p, g.fields, attempted)),
    ),
  );
  const terms = loop.best.gaps.flatMap((g) => g.fields).join(" ");
  const rank = (a: (typeof actions)[number]) => {
    const value = a.url + " " + a.reason;
    let score = 0;
    if (
      /アイドル|韓国|style/.test(terms) &&
      /style|スタイル|blog|ブログ|review|口コミ/.test(value)
    )
      score += 10;
    if (
      /価格|料金|費用|price|家賃|管理/.test(terms) &&
      /費用|price|coupon|料金|詳細/.test(value)
    )
      score += 10;
    if (/部屋|温泉|room/.test(terms) && /room|bath|部屋|温泉/.test(value))
      score += 10;
    return score;
  };
  actions.sort((a, b) => rank(b) - rank(a));
  const station = loop.query.match(/[一-龯ぁ-んァ-ヶー]{2,12}駅/)?.[0];
  const alternativeLinks = loop.allowReplacements
    ? tasks
        .flatMap((t) => t.pages.flatMap((p) => p.links))
        .filter((l) => {
          try {
            checkNavigation(l.url, hosts);
            if (attempted.has(actionKey("link", l.url))) return false;
            const key = entityKey(l.url);
            return key
              ? !loop.candidateUrls.some((u) => entityKey(u) === key)
              : !!station && l.text.includes(station) && /chintai/.test(l.url);
          } catch {
            return false;
          }
        })
        .sort(
          (a, b) =>
            Number(!!station && b.text.includes(station)) -
            Number(!!station && a.text.includes(station)),
        )
        .map((l) => l.url)
    : [];
  const priorityUrls = [
    ...new Set([
      ...[...(loop.additionalUrls ?? []), ...(loop.learnedUrls ?? [])].filter(
        (u) => !attempted.has(actionKey("link", u)),
      ),
      ...alternativeLinks,
      ...actions.filter((a) => a.mode === "link").map((a) => a.url),
    ]),
  ]
    .filter((u) => {
      try {
        checkNavigation(u, hosts);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 8);
  return {
    minimumCandidates: loop.minimumCandidates,
    allowReplacements: loop.allowReplacements,
    loopId: loop.id,
    iteration,
    criteria: structuredClone(loop.criteria),
    candidateUrls: [...loop.candidateUrls],
    gaps: structuredClone(loop.best.gaps),
    priorityUrls,
    visitedUrls: [...new Set(tasks.flatMap((t) => t.pages.map((p) => p.url)))],
    strategy:
      iteration === 1 && loop.learnedStrategy
        ? loop.learnedStrategy
        : iteration === 1
          ? "targeted-links"
          : iteration === 2
            ? "broader-links"
            : "render-and-recheck",
  };
}
export interface ImproveOptions {
  diagnoseOnly?: boolean;
  interactionMode?: InteractionMode;
  parentLoopId?: string;
  allowReplacements?: boolean;
  additionalUrls?: string[];
  maxIterations?: number;
  timeoutSeconds?: number;
  agent?: RunOptions["agent"];
  model?: string;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}
export async function improveTask(
  taskId: string,
  options: ImproveOptions = {},
  store = new Store(),
  runner?: RuntimeExecutor,
): Promise<ImprovementLoop> {
  const mode = interactionMode(options.interactionMode);
  const maxIterations = options.maxIterations ?? 3,
    timeoutSeconds = options.timeoutSeconds ?? 1800;
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 5
  )
    throw new Error("改善回数は1〜5です");
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  )
    throw new Error("改善全体の時間は1〜3600秒です");
  const seed = await store.get(taskId);
  const target = seed.execution?.target ?? "local";
  if (!runner && target !== runtimeTarget())
    throw new Error(
      "元タスクと実行先が異なります。RUNTIME_EXECUTORを元の実行先に設定してください",
    );
  const execute = runner ?? configuredRuntime();
  if (seed.evaluation)
    throw new Error(
      "凍結ベンチマークはbenchmark runで再評価してください。ライブ自己改善には使いません",
    );
  if (options.agent && options.agent !== seed.agent && !options.model)
    throw new Error("別エンジンへ変更する場合は--modelも明示してください");
  if (!seed.criteria.length)
    throw new Error(
      "評価条件のあるタスクが必要です。先にrunで調査してください",
    );
  const contract = structuredClone(seed.criteria);
  // Validate the persisted contract before spending model requests.
  setCriteria({ ...seed, answer: undefined, evidence: [] }, contract);
  const candidateUrls = seed.answer?.candidates.length
    ? seed.answer.candidates.map((c) => c.url)
    : [
        ...new Map(
          seed.pages
            .filter((p) => {
              const key = entityKey(p.url);
              return (
                key && !key.startsWith("generic:") && !assessPage(p).shouldStop
              );
            })
            .map((p) => [entityKey(p.url), p.url]),
        ).values(),
      ].slice(0, 10);
  if (!candidateUrls.length)
    throw new Error(
      "再検証できる個別対象がまだありません。runで詳細ページを取得してください",
    );
  const minimumCandidates = Math.max(
    candidateUrls.length,
    Number(
      seed.query.match(/(10|[1-9])\s*(?:件|冊|商品|物件|宿|店舗|店|台)/)?.[1] ??
        0,
    ),
  );
  const hosts = allowedHosts(routeSources(seed.query, seed.urls));
  for (const url of candidateUrls) checkNavigation(url, hosts);
  const additionalUrls = [...new Set(options.additionalUrls ?? [])];
  if (additionalUrls.length > 8) throw new Error("追加URLは最大8件です");
  for (const url of additionalUrls) {
    checkNavigation(url, hosts);
    if (!candidateUrls.some((u) => entityKey(u) === entityKey(url)))
      throw new Error("追加URLは元の候補と同じ対象の公開詳細に限ります");
  }
  const baseline = diagnose(
    seed,
    contract,
    candidateUrls,
    false,
    minimumCandidates,
  );
  const loop: ImprovementLoop = {
    interactionMode: mode,
    executionTarget: target,
    parentLoopId: options.parentLoopId,
    id: randomUUID(),
    sourceTaskId: seed.id,
    query: seed.query,
    urls: [...seed.urls],
    criteria: contract,
    candidateUrls,
    minimumCandidates,
    additionalUrls,
    allowReplacements: options.allowReplacements ?? false,
    agent: options.agent ?? seed.agent,
    model: options.model ?? seed.model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    maxIterations,
    timeoutSeconds,
    bestTaskId: seed.id,
    baseline,
    best: baseline,
    iterations: [],
    promotedStrategies: [],
    questions: [],
  };
  const loops = new ImprovementStore(store),
    tasks = [seed];
  const seen = new Set(seed.pages.map((p) => actionKey("link", p.url)));
  const controller = new AbortController();
  let timedOut = false,
    stagnant = 0;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1000);
  try {
    // Reuse only a previously verified recipe for the identical goal/contract.
    // Pages and quotes are always fetched again; no old answer becomes fresh evidence.
    for (const previous of (await loops.list()).slice(0, 20)) {
      controller.signal.throwIfAborted();
      if (
        previous.status !== "succeeded" ||
        previous.query !== loop.query ||
        JSON.stringify(previous.criteria) !== JSON.stringify(loop.criteria) ||
        !previous.promotedStrategies.length
      )
        continue;
      try {
        const verifiedTask = await store.get(previous.bestTaskId);
        if (
          !diagnose(
            verifiedTask,
            loop.criteria,
            previous.candidateUrls,
            previous.allowReplacements,
            previous.minimumCandidates ?? previous.candidateUrls.length,
          ).complete
        )
          continue;
        const verifiedUrls = [
          ...new Set(verifiedTask.evidence.map((e) => e.url)),
        ]
          .filter((u) => {
            try {
              checkNavigation(u, hosts);
              return (
                loop.allowReplacements ||
                loop.candidateUrls.some((c) => entityKey(c) === entityKey(u))
              );
            } catch {
              return false;
            }
          })
          .slice(0, 8);
        if (!verifiedUrls.length) continue;
        loop.learnedFrom = previous.id;
        loop.learnedUrls = verifiedUrls;
        loop.learnedStrategy = previous.promotedStrategies.at(-1);
        options.onProgress?.(
          `検証済み調査手順を再利用: ${previous.id} (${verifiedUrls.length}URLを再取得)`,
        );
        break;
      } catch {
        /* Missing/corrupt previous artifacts cannot promote a recipe. */
      }
    }
    await loops.save(loop);
    for (let i = 1; i <= maxIterations; i++) {
      controller.signal.throwIfAborted();
      if (loop.best.complete) {
        loop.status = "succeeded";
        loop.stopReason = "元の全候補・必須条件・詳細取得を検証済み";
        break;
      }
      if (options.diagnoseOnly) {
        loop.status = "exhausted";
        loop.stopReason = "取得済みの根拠から未達を検出しました";
        break;
      }
      const last = tasks.at(-1)!;
      if (last.failure && last.failure.kind !== "unknown") {
        loop.status = "blocked";
        loop.stopReason = last.failure.action;
        break;
      }
      if (
        loop.best.causes.includes("source_unavailable") &&
        !loop.best.causes.includes("required_unknown")
      ) {
        loop.status = "blocked";
        loop.stopReason = "公開詳細にアクセスできません。制限は回避しません";
        break;
      }
      const plan = improvementPlan(loop, tasks, i);
      options.onProgress?.(
        `improvement ${loop.id} [${i}/${maxIterations}] ${plan.strategy}: ${loop.best.gaps.length}対象が未達・未調査リンク${plan.priorityUrls.length}件`,
      );
      const task = await execute(
        {
          interactionMode: mode,
          query: loop.query,
          urls: loop.urls,
          agent: loop.agent,
          model: loop.model,
          parentId: loop.bestTaskId,
          goalId: seed.goalId,
          improvement: plan,
          maxSteps: Math.min(160, Math.max(seed.limits.maxSteps, 70) + i * 15),
          maxPages: Math.min(32, Math.max(seed.limits.maxPages, 12) + i * 4),
          timeoutSeconds: Math.min(seed.limits.timeoutSeconds, timeoutSeconds),
          deepenRounds: 3,
          signal: controller.signal,
          onProgress: options.onProgress,
        },
        store,
      );
      tasks.push(task);
      const result = diagnose(
        task,
        loop.criteria,
        loop.candidateUrls,
        loop.allowReplacements,
        loop.minimumCandidates,
      );
      let newPages = 0;
      for (const p of task.pages) {
        const key = actionKey("link", p.url);
        if (!seen.has(key)) {
          newPages++;
          seen.add(key);
        }
      }
      const previousBest = tasks.find((t) => t.id === loop.bestTaskId)!;
      const corrections = !result.validationError
        ? (previousBest.answer?.candidates ?? []).flatMap((c) =>
            c.matches
              .filter(
                (m) =>
                  m.status === "supported" &&
                  task.answer?.candidates.some(
                    (n) =>
                      entityKey(n.url) === entityKey(c.url) &&
                      n.matches.some(
                        (x) =>
                          x.criterionId === m.criterionId &&
                          x.status === "contradicted",
                      ),
                  ),
              )
              .map(
                (m) => `${c.url}: ${m.criterionId} の旧判定を新しい引用で訂正`,
              ),
          )
        : [];
      if (
        result.causes.includes("source_conflict") &&
        !loop.best.causes.includes("source_conflict")
      )
        corrections.push(
          "同一物件の掲載間で徒歩分数が不一致。旧判定の確定扱いを取り消し",
        );
      const improved = improves(loop.best, result, loop.allowReplacements);
      const accepted = improved || corrections.length > 0;
      loop.iterations.push({
        number: i,
        taskId: task.id,
        plan,
        result,
        accepted,
        corrections,
        newPages,
        taskStatus: task.status,
      });
      if (accepted) {
        loop.best = result;
        loop.bestTaskId = task.id;
        stagnant = 0;
        if (improved && !loop.promotedStrategies.includes(plan.strategy))
          loop.promotedStrategies.push(plan.strategy);
      } else stagnant++;
      options.onProgress?.(
        `検証: 必須条件 ${result.supportedRequired} / 詳細 ${result.verifiedDetails} / 新規本文 ${newPages} / ${corrections.length ? "旧情報を訂正" : accepted ? "改善を採用" : "最良結果を維持"}`,
      );
      await loops.save(loop);
      if (controller.signal.aborted) {
        loop.status = timedOut ? "timed_out" : "cancelled";
        break;
      }
      if (task.failure && task.failure.kind !== "unknown") {
        loop.status = "blocked";
        loop.stopReason = task.failure.action;
        break;
      }
      if (result.complete && accepted) {
        loop.status = "succeeded";
        loop.stopReason = "元の全候補・必須条件・詳細取得を検証済み";
        break;
      }
      if (stagnant >= 2) {
        loop.status = "stalled";
        loop.stopReason =
          "2回連続で検証可能な改善がありません。最良結果を保持します";
        break;
      }
      if (i === maxIterations) {
        loop.status = "exhausted";
        loop.stopReason = "改善回数上限に達しました";
      }
    }
  } catch (e) {
    loop.status = controller.signal.aborted
      ? timedOut
        ? "timed_out"
        : "cancelled"
      : "failed";
    const message = e instanceof Error ? e.message : String(e);
    loop.stopReason = process.env.OPENROUTER_API_KEY
      ? message.split(process.env.OPENROUTER_API_KEY).join("[REDACTED]")
      : message;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (!loop.best.complete) {
      loop.questions =
        mode === "auto"
          ? []
          : loop.best.gaps.map((g) => ({
              url: g.url,
              missing: g.fields,
              question: `${g.url} の「${g.fields.join("・")}」が未確認です。未確認を明記して受け取るか、調査を追加するか選べます。`,
              options: [
                "未確認を明記して提案を受け取る",
                "同じ条件で追加調査する（時間・利用枠を追加）",
                "同一候補の公式詳細URLを追加する",
              ],
            }));
      if (["exhausted", "stalled", "timed_out"].includes(loop.status)) {
        loop.status = mode === "auto" ? "completed_partial" : "needs_input";
        if (mode === "approval")
          loop.approval = {
            id: randomUUID(),
            status: "pending",
            title: "確認できた候補で進めますか？",
            reason: `${loop.stopReason ?? "追加調査の上限です"}。未確認: ${loop.best.gaps.map((g) => g.fields.join("・")).join(" / ") || loop.best.causes.join(" / ")}。必須条件を緩めず、最良の回答を保持しています。`,
            choices: [
              {
                id: "return_partial",
                title: "未確認事項を明記して提案を受け取る",
                recommended: true,
                tradeoff:
                  "追加推論なし。未確認条件・空席・営業日は保証できません。",
              },
              {
                id: "research_more",
                title: "同じ条件でもう一度調べる",
                tradeoff: `最大${loop.maxIterations}回・${loop.timeoutSeconds}秒を追加で使います。改善できない場合もあります。`,
              },
              {
                id: "add_url",
                title: "公式の詳細URLを追加して調べる",
                tradeoff:
                  "同一候補の公開URLを最大8件入力。認証・アクセス制限は回避しません。",
              },
            ],
          };
      }
    }
    await loops.save(loop);
  }
  return loop;
}
export function renderImprovement(loop: ImprovementLoop) {
  const lines = [
    `改善ループ: ${loop.id}`,
    `status: ${loop.status}`,
    `mode: ${loop.interactionMode ?? "approval"} / executor: ${loop.executionTarget ?? "local"}`,
    `実行: ${loop.iterations.length}/${loop.maxIterations}`,
    `必須条件の確認数: ${loop.baseline.supportedRequired} → ${loop.best.supportedRequired}`,
    `詳細取得済み: ${loop.baseline.verifiedDetails} → ${loop.best.verifiedDetails}`,
    `未達対象: ${new Set(loop.baseline.gaps.map((g) => g.url)).size} → ${new Set(loop.best.gaps.map((g) => g.url)).size}`,
    `最良タスク: ${loop.bestTaskId}`,
    loop.stopReason ?? "",
    ...(loop.approval?.status === "pending"
      ? [
          loop.approval.title,
          loop.approval.reason,
          ...loop.approval.choices.map(
            (c) =>
              `${c.id}${c.recommended ? " [推奨]" : ""}: ${c.title} — ${c.tradeoff}`,
          ),
          `再開: improvements decide ${loop.id} --approval ${loop.approval.id} --choice return_partial`,
        ]
      : []),
    ...loop.iterations.map(
      (i) =>
        `#${i.number} ${i.plan.strategy}: ${i.taskStatus}, 新規本文${i.newPages}, ${i.corrections?.length ? "旧情報を訂正" : i.accepted ? "採用" : "最良結果を維持"} (${i.taskId})`,
    ),
    ...loop.questions.map(
      (q) =>
        `要確認: ${q.url}\n  ${q.missing.join("・")}\n  ${q.options.join(" / ")}`,
    ),
  ];
  return lines.join("\n");
}

/** Persist a decision before performing more work. A replay cannot spend the budget twice. */
export async function decideImprovement(
  id: string,
  input: { approvalId: string; choiceId: string; additionalUrls?: string[] },
  store = new Store(),
  runner?: RuntimeExecutor,
): Promise<ImprovementLoop> {
  const loops = new ImprovementStore(store);
  const lock = join(loops.dir(id), "decision.lock");
  await mkdir(lock).catch(() => {
    throw new Error("この承認は処理中です。履歴を確認してください");
  });
  try {
    const loop = await loops.get(id),
      gate = loop.approval;
    if (
      !gate ||
      gate.id !== input.approvalId ||
      loop.interactionMode !== "approval"
    )
      throw new Error("古い承認、または承認対象ではありません");
    const urls = input.additionalUrls ?? [];
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string"))
      throw new Error("追加URLが不正です");
    if (gate.status === "decided") {
      if (
        gate.selected !== input.choiceId ||
        JSON.stringify(gate.additionalUrls ?? []) !== JSON.stringify(urls)
      )
        throw new Error("確定済みの選択は変更できません");
      return gate.nextLoopId ? loops.get(gate.nextLoopId) : loop;
    }
    if (
      loop.status !== "needs_input" ||
      !gate.choices.some((c) => c.id === input.choiceId)
    )
      throw new Error("提示された選択肢から選んでください");
    if (input.choiceId === "add_url") {
      if (!urls.length || urls.length > 8)
        throw new Error("追加URLを1〜8件入力してください");
      const hosts = allowedHosts(routeSources(loop.query, loop.urls));
      for (const url of urls) {
        checkNavigation(url, hosts);
        if (!loop.candidateUrls.some((u) => entityKey(u) === entityKey(url)))
          throw new Error("追加URLは同一候補の公開詳細に限ります");
      }
    } else if (urls.length) throw new Error("URL追加の選択時だけ指定できます");
    if (
      input.choiceId !== "return_partial" &&
      !runner &&
      (loop.executionTarget ?? "local") !== runtimeTarget()
    )
      throw new Error("元の実行先に設定してから再開してください");
    gate.status = "decided";
    gate.selected = input.choiceId;
    gate.additionalUrls = urls;
    gate.decidedAt = new Date().toISOString();
    loop.status = "completed_partial";
    loop.questions = [];
    await loops.save(loop);
    if (input.choiceId === "return_partial") return loop;
    try {
      const next = await improveTask(
        loop.bestTaskId,
        {
          interactionMode: "approval",
          parentLoopId: loop.id,
          maxIterations: loop.maxIterations,
          timeoutSeconds: loop.timeoutSeconds,
          allowReplacements: loop.allowReplacements,
          additionalUrls: urls,
          agent: loop.agent,
          model: loop.model,
        },
        store,
        runner,
      );
      gate.nextLoopId = next.id;
      await loops.save(loop);
      return next;
    } catch (error) {
      gate.error = error instanceof Error ? error.message : String(error);
      await loops.save(loop);
      throw error;
    }
  } finally {
    await rmdir(lock);
  }
}
