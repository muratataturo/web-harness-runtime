import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type { Task } from "./types.js";
import { verifyStepPlan } from "./step-verifier.js";
import { assessJourneyState } from "./journey-state.js";
const perspectiveSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9-]{1,80}$" }),
    domain: Type.Union([Type.Literal("trip"), Type.Literal("all")]),
    origin: Type.Union([
      Type.Literal("user-correction"),
      Type.Literal("host-verifier"),
    ]),
    sourceTaskId: Type.Optional(
      Type.String({ pattern: "^[a-zA-Z0-9-]{1,100}$" }),
    ),
    concern: Type.String({ minLength: 4, maxLength: 400 }),
    question: Type.String({ minLength: 4, maxLength: 600 }),
    action: Type.String({ minLength: 4, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type ReviewPerspective = Static<typeof perspectiveSchema>;
function validate(p: unknown): asserts p is ReviewPerspective {
  if (!Value.Check(perspectiveSchema, p))
    throw Error("修正観点の形式が不正です");
}
export class ReviewPerspectiveStore {
  constructor(private store: Store) {}
  async add(p: unknown) {
    validate(p);
    const baseline = JSON.parse(
      await readFile(
        new URL("../config/review-perspectives.json", import.meta.url),
        "utf8",
      ),
    );
    if (baseline.perspectives.some((x: ReviewPerspective) => x.id === p.id))
      throw Error("既定の観点IDは上書きできません。別のIDで補足してください");
    const dir = join(this.store.root, "review-perspectives", "approved");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, p.id + ".json"), JSON.stringify(p, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    return p;
  }
  async context(task: Task) {
    const baseline = JSON.parse(
      await readFile(
        new URL("../config/review-perspectives.json", import.meta.url),
        "utf8",
      ),
    );
    if (baseline.version !== 1 || !Array.isArray(baseline.perspectives))
      throw Error("修正観点の版が不正です");
    const perspectives: ReviewPerspective[] = [];
    for (const p of baseline.perspectives) {
      validate(p);
      perspectives.push(p);
    }
    const dir = join(this.store.root, "review-perspectives", "approved");
    const files = await readdir(dir).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    for (const f of files
      .filter((f) => /^[a-z0-9-]{1,80}\.json$/.test(f))
      .sort()
      .slice(-64)) {
      const p: unknown = JSON.parse(await readFile(join(dir, f), "utf8"));
      validate(p);
      if (p.id + ".json" !== f) throw Error("修正観点IDが不一致です");
      if (!perspectives.some((x) => x.id === p.id)) perspectives.push(p);
    }
    const selected = perspectives
      .filter(
        (p) =>
          p.domain === "all" ||
          !!task.journeyPolicy ||
          /旅行|行程|旅程|カフェ|観光|遊ぶ/.test(task.query),
      )
      .slice(0, 32);
    const reflectionsDir = join(
      this.store.root,
      "review-perspectives",
      "reflections",
    );
    const names = await readdir(reflectionsDir).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const records = [];
    const recentFiles = await Promise.all(
      names
        .filter((f) => /^[a-zA-Z0-9-]+\.json$/.test(f))
        .map(async (name) => ({
          name,
          modified: (await stat(join(reflectionsDir, name))).mtimeMs,
        })),
    );
    for (const { name: f } of recentFiles
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 64)) {
      const r = JSON.parse(await readFile(join(reflectionsDir, f), "utf8"));
      if (
        r.scope === "host-procedural-reflection" &&
        r.version === 1 &&
        typeof r.createdAt === "string" &&
        Array.isArray(r.results)
      )
        records.push(r);
    }
    const previous = records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
    const pastChecks = selected.map((p) => ({
      id: p.id,
      needsAttentionCount: previous.filter((r) =>
        r.results.some(
          (x: any) => x.id === p.id && x.status === "needs-attention",
        ),
      ).length,
      checkedCount: previous.filter((r) =>
        r.results.some((x: any) => x.id === p.id && x.status === "checked"),
      ).length,
    }));
    return {
      version: 1 as const,
      scope: "procedural-review-perspectives" as const,
      reusableFacts: false as const,
      modelWeightsUpdated: false as const,
      revision: createHash("sha256")
        .update(JSON.stringify(selected))
        .digest("hex"),
      perspectives: selected,
      pastChecks,
    };
  }
  async reflect(task: Task) {
    if (!task.reviewContext || task.evaluation) return;
    const plan = task.answer?.actionPlan;
    const checks = plan ? verifyStepPlan(task, plan) : undefined;
    const journey = plan ? assessJourneyState(task, plan) : undefined;
    const results = task.reviewContext.perspectives.map((p) => {
      const restIds = new Set(
        plan?.steps.filter((s) => s.kind === "rest").map((s) => s.id),
      );
      const relevant = checks?.checks.filter((c) =>
        p.id === "rest-opening-scope"
          ? restIds.has(c.stepId) &&
            ["opening", "source", "fact"].includes(c.kind)
          : true,
      );
      const issues =
        p.id === "journey-pace"
          ? journey?.issues
          : ["rest-opening-scope", "unknown-replace"].includes(p.id)
            ? relevant
                ?.filter((c) => ["unknown", "failed"].includes(c.status))
                .map((c) => c.stepId + ": " + c.detail)
            : undefined;
      const evaluated =
        !!plan &&
        (p.id === "journey-pace"
          ? journey?.required
          : ["rest-opening-scope", "unknown-replace"].includes(p.id) &&
            checks?.required);
      return {
        id: p.id,
        status: evaluated
          ? issues?.length
            ? "needs-attention"
            : "checked"
          : "not-evaluated",
        issues: issues ?? [],
        scope:
          p.id === "rest-opening-scope"
            ? "declared rest opening/source/fact checks; not proof of seats or all semantic claims"
            : p.id === "journey-pace"
              ? "host journey contract"
              : "host step checks; human appeal is not evaluated",
      };
    });
    const record = {
      version: 1,
      scope: "host-procedural-reflection",
      createdAt: new Date().toISOString(),
      taskId: task.id,
      contextRevision: task.reviewContext.revision,
      answerSha256: task.answer
        ? createHash("sha256").update(JSON.stringify(task.answer)).digest("hex")
        : undefined,
      results,
      autoPromoted: false,
      modelWeightsUpdated: false,
    };
    const dir = join(this.store.root, "review-perspectives", "reflections");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    this.store.dir(task.id);
    await writeFile(
      join(dir, task.id + ".json"),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
    return record;
  }
}
