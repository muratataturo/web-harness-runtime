import {
  assessVisualArtifact,
  visualArtifactSchema,
} from "./visual-artifact.js";
import { constants } from "node:fs";
import { readdir, open, lstat, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Task } from "./types.js";
import type { RunOptions } from "./runtime.js";
import {
  createResearchProfile,
  checkResearchNavigation,
} from "./runtime-profile.js";
import { checkNavigation, routeSources, entityKey } from "./sources.js";
import { normalized, validateAnswer } from "./evidence.js";
import { actionPlanSchema, assessSpecificity } from "./answer-plan.js";
import { verifyDetail } from "./detail-contracts.js";
import { pinRequiredCriteria } from "./research.js";
import { readPublicHtml } from "./html-reader.js";
import type { Page } from "./types.js";

const text = (maxLength = 32000) => Type.String({ maxLength });
const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9-]+$",
});
const url = text(8192);
const list = <T extends TSchema>(item: T, maxItems: number) =>
  Type.Array(item, { maxItems });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const metricsSchema = Type.Object(
  {
    elapsedMs: Type.Number({ minimum: 0, maximum: 86400000 }),
    tokenAccounting: Type.Optional(
      Type.Union([
        Type.Literal("provider-reported"),
        Type.Literal("last-observed-partial"),
        Type.Literal("unavailable"),
      ]),
    ),
    tokens: Type.Union([
      Type.Null(),
      Type.Object({
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        reasoningOutputTokens: Type.Union([count, Type.Null()]),
        totalTokens: count,
        cacheWriteInputTokens: count,
        source: Type.Union([
          Type.Literal("codex-thread-total"),
          Type.Literal("pi-session-total"),
          Type.Literal("opencode-step-total"),
        ]),
      }),
    ]),
    billing: Type.Object({
      mode: text(100),
      additionalApiUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
      subscriptionAllocationUsd: Type.Null(),
      note: text(2000),
    }),
  },
  { additionalProperties: false },
);
const schema = Type.Object({
  id,
  agent: Type.Union([
    Type.Literal("codex"),
    Type.Literal("pi-openrouter"),
    Type.Literal("claude-code"),
    Type.Literal("opencode"),
  ]),
  query: text(24000),
  urls: list(url, 20),
  status: Type.Union(
    ["succeeded", "partial", "failed", "blocked", "cancelled", "timed_out"].map(
      (s) => Type.Literal(s),
    ),
  ),
  createdAt: text(80),
  updatedAt: text(80),
  steps: Type.Integer({ minimum: 0, maximum: 1000 }),
  limits: Type.Object({
    maxSteps: Type.Integer({ minimum: 1, maximum: 1000 }),
    maxPages: Type.Integer({ minimum: 1, maximum: 100 }),
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 7200 }),
  }),
  criteria: list(
    Type.Object({
      id,
      description: text(4000),
      weight: Type.Number({ minimum: 1, maximum: 10 }),
      required: Type.Boolean(),
    }),
    12,
  ),
  pages: list(
    Type.Object({
      id,
      url,
      title: text(2000),
      text: text(32000),
      capturedAt: text(80),
      truncated: Type.Boolean(),
      links: list(Type.Object({ text: text(2000), url }), 220),
      images: Type.Optional(list(Type.Object({ url, alt: text(2000) }), 8)),
      acquisition: Type.Optional(
        Type.Object({
          kind: Type.Union([
            Type.Literal("public-html"),
            Type.Literal("public-json"),
            Type.Literal("browser-dom"),
          ]),
          status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
          charset: Type.Optional(text(100)),
          contentType: Type.Optional(text(256)),
        }),
      ),
      productOffer: Type.Optional(
        Type.Object({
          url,
          currency: Type.Literal("JPY"),
          low: Type.Integer({ minimum: 0, maximum: 1e9 }),
          high: Type.Integer({ minimum: 0, maximum: 1e9 }),
          source: Type.Literal("microdata"),
          kind: Type.Union([Type.Literal("exact"), Type.Literal("range")]),
        }),
      ),
    }),
    100,
  ),
  evidence: list(
    Type.Object({
      id,
      pageId: id,
      url,
      quote: text(1200),
      capturedAt: text(80),
    }),
    1000,
  ),
  answer: Type.Optional(
    Type.Object({
      summary: text(64000),
      limitations: list(text(8192), 100),
      actionPlan: Type.Optional(actionPlanSchema),
      visualArtifact: Type.Optional(visualArtifactSchema),
      candidates: list(
        Type.Object({
          name: text(2000),
          url,
          score: Type.Number({ minimum: 0, maximum: 100 }),
          eligible: Type.Boolean(),
          matches: list(
            Type.Object({
              criterionId: id,
              status: Type.Union([
                Type.Literal("supported"),
                Type.Literal("unknown"),
                Type.Literal("contradicted"),
              ]),
              explanation: text(8192),
              evidenceIds: list(id, 100),
            }),
            12,
          ),
        }),
        10,
      ),
    }),
  ),
  error: Type.Optional(text(16000)),
  model: Type.Optional(text(256)),
  metrics: Type.Optional(metricsSchema),
});
function unique(items: { id: string }[]) {
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw new Error("sandbox成果物のIDが重複しています");
}
/** Recompute derived claims on the host; guest verified/succeeded is never evidence. */
export function validateSandboxTask(value: unknown, options: RunOptions): Task {
  if (!Value.Check(schema, value))
    throw new Error("sandbox成果物のschemaが不正です");
  const raw = value as Task;
  const profile = createResearchProfile(options.urls);
  if (
    raw.id !== options.artifactNonce ||
    raw.query !== options.query ||
    raw.agent !== (options.agent ?? "codex") ||
    JSON.stringify(raw.urls) !== JSON.stringify(options.urls)
  )
    throw new Error("sandbox成果物の実行要求が一致しません");
  if (
    raw.security?.artifactNonce !== options.artifactNonce ||
    !options.artifactNonce ||
    raw.security?.policyHash !== profile.policyHash ||
    raw.security?.mode !== profile.mode ||
    raw.security?.profileId !== profile.id ||
    raw.security?.profileVersion !== 1
  )
    throw new Error("sandbox成果物のnonce/profileが一致しません");
  if (
    raw.limits.maxSteps !== options.maxSteps ||
    raw.limits.maxPages !== options.maxPages ||
    raw.limits.timeoutSeconds !== options.timeoutSeconds ||
    raw.pages.length > options.maxPages ||
    raw.steps > options.maxSteps
  )
    throw new Error("sandbox成果物の予算が一致しません");
  if (
    [raw.createdAt, raw.updatedAt, ...raw.pages.map((p) => p.capturedAt)].some(
      (t) => !Number.isFinite(Date.parse(t)),
    )
  )
    throw new Error("sandbox成果物の日時が不正です");
  unique(raw.criteria);
  unique(raw.pages);
  unique(raw.evidence);
  const navigation =
    profile.mode === "hardened" ? checkResearchNavigation : checkNavigation;
  // Guest execution, ownership, telemetry and derived trust fields are discarded.
  const task: Task = {
    id: raw.id,
    agent: raw.agent,
    query: raw.query,
    urls: [...raw.urls],
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    steps: raw.steps,
    limits: { ...raw.limits },
    sources: routeSources(options.query, options.urls),
    criteria: pinRequiredCriteria(options.query, raw.criteria),
    pages: raw.pages.map((p) => ({
      id: p.id,
      url: navigation(p.url, [...profile.hosts]),
      title: p.title,
      text: p.text,
      links: p.links.filter((l) => {
        try {
          navigation(l.url, [...profile.hosts]);
          return true;
        } catch {
          return false;
        }
      }),
      images: p.images,
      acquisition: p.acquisition,
      productOffer: p.productOffer,
      capturedAt: p.capturedAt,
      truncated: p.truncated,
    })),
    evidence: raw.evidence.map((e) => ({ ...e })),
    model: raw.model,
    metrics: raw.metrics ? structuredClone(raw.metrics) : undefined,
    error: raw.error,
    security: {
      profileId: profile.id,
      profileVersion: 1,
      mode: profile.mode,
      policyHash: profile.policyHash,
      artifactNonce: options.artifactNonce,
    },
    parentId: options.parentId,
    goalId: options.goalId,
    improvement: options.improvement,
  };
  if (
    options.improvement &&
    JSON.stringify(task.criteria) !==
      JSON.stringify(options.improvement.criteria)
  )
    throw new Error("sandbox成果物が固定条件を変更しました");
  for (const page of task.pages) {
    if (
      profile.mode === "hardened" &&
      !["public-html", "public-json"].includes(page.acquisition?.kind ?? "")
    )
      throw new Error("強化モード以外の取得成果物です");
    if (
      page.productOffer &&
      (entityKey(page.productOffer.url) !== entityKey(page.url) ||
        new URL(page.productOffer.url).hostname !==
          new URL(page.url).hostname ||
        page.productOffer.low > page.productOffer.high)
    )
      throw new Error("sandbox成果物の販売価格が不正です");
  }
  for (const e of task.evidence) {
    const page = task.pages.find((p) => p.id === e.pageId);
    if (
      !page ||
      page.url !== e.url ||
      page.capturedAt !== e.capturedAt ||
      normalized(e.quote).length < 6 ||
      !normalized(page.text).includes(normalized(e.quote))
    )
      throw new Error("sandbox成果物の引用を本文で確認できません");
  }
  const verifiedDetailUrls = [
    ...new Set(
      task.pages
        .filter((p) => verifyDetail(p).status === "verified")
        .map((p) => p.url),
    ),
  ];
  task.retrieval = {
    status: verifiedDetailUrls.length ? "verified" : "insufficient_detail",
    verifiedDetailUrls,
    checkedPages: task.pages.length,
  };
  if (raw.answer)
    task.answer = validateAnswer(
      task,
      raw.answer.summary,
      raw.answer.candidates,
      raw.answer.limitations,
      raw.answer.actionPlan,
      raw.answer.visualArtifact,
    );
  if (task.answer) task.visualReview = assessVisualArtifact(task, task.answer);
  if (task.answer)
    task.specificity = {
      ...assessSpecificity(task, task.answer),
      attempts: [],
    };
  if (["succeeded", "partial", "blocked"].includes(task.status) && task.answer)
    task.status =
      task.answer.candidates.length === 0
        ? "blocked"
        : task.specificity?.status !== "needs_detail" &&
            task.visualReview?.status !== "needs_visual" &&
            task.answer.candidates.every(
              (c) => c.eligible && verifiedDetailUrls.includes(c.url),
            )
          ? task.status === "succeeded"
            ? "succeeded"
            : "partial"
          : "partial";
  else if (task.status === "succeeded")
    throw new Error("回答のない成功成果物です");
  return task;
}

export async function recoverSandboxTask(
  root: string,
  options: RunOptions,
  deps: { readPage?: typeof readPublicHtml } = {},
): Promise<Task> {
  const base = await realpath(root);
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("sandbox成果物rootにsymlinkは使えません");
  let visited = 0;
  const matches: Task[] = [];
  async function visit(dir: string, depth = 0): Promise<void> {
    if (depth > 5 || ++visited > 1000)
      throw new Error("sandbox成果物の走査上限です");
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length > 1000) throw new Error("sandbox成果物の件数上限です");
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("sandbox成果物にsymlinkは使えません");
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.name === "task.json") {
        const actual = await realpath(path),
          rel = relative(base, actual);
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new Error("sandbox成果物のpathが不正です");
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024)
            throw new Error("sandbox成果物のサイズ/形式が不正です");
          const bytes = Buffer.alloc(stat.size + 1);
          let bytesRead = 0;
          while (bytesRead < bytes.length) {
            const chunk = await file.read(
              bytes,
              bytesRead,
              bytes.length - bytesRead,
              bytesRead,
            );
            if (!chunk.bytesRead) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead !== stat.size)
            throw new Error("sandbox成果物が読込中に変更されました");
          matches.push(
            validateSandboxTask(
              JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
              options,
            ),
          );
          if (matches.length > 1)
            throw new Error("sandbox成果物を一意に検証できません");
        } finally {
          await file.close();
        }
      }
    }
  }
  await visit(base);
  if (matches.length !== 1)
    throw new Error("sandbox成果物を一意に検証できません");
  const task = matches[0]!;
  // A compromised guest could fabricate both text and quotes. For hardened
  // answers independently reacquire cited/candidate pages without its credentials.
  if (task.security?.mode === "hardened" && task.answer) {
    const profile = createResearchProfile(options.urls);
    const needed = new Set([
      ...task.evidence.map((e) => e.url),
      ...task.answer.candidates.map((c) => c.url),
    ]);
    const signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(60000),
    ]);
    const verified = new Map<string, Omit<Page, "id">>();
    for (const url of needed) {
      signal.throwIfAborted();
      const page = await (deps.readPage ?? readPublicHtml)(
        url,
        [...profile.hosts],
        signal,
      );
      if (page.url !== url)
        throw new Error("sandbox根拠の独立取得先が一致しません");
      verified.set(url, page);
    }
    const fresh = {
      ...task,
      pages: task.pages.map((p) =>
        verified.has(p.url) ? { ...verified.get(p.url)!, id: p.id } : p,
      ),
      evidence: task.evidence.map((e) => ({
        ...e,
        capturedAt: verified.get(e.url)?.capturedAt ?? e.capturedAt,
      })),
    };
    return validateSandboxTask(fresh, options);
  }
  return task;
}
