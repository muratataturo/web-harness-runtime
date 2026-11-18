import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.js";
import type { Task } from "./types.js";
import {
  placeKey,
  type JourneyMemory,
  type JourneyObservation,
} from "./journey-state.js";
const key = Type.String({ minLength: 3, maxLength: 2200 });
export const journeyObservationSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-zA-Z0-9-]{1,100}$" }),
    kind: Type.Union([Type.Literal("travel"), Type.Literal("dwell")]),
    basis: Type.Union([
      Type.Literal("user-observed"),
      Type.Literal("provider-estimate"),
    ]),
    fromKey: Type.Optional(key),
    toKey: Type.Optional(key),
    placeKey: Type.Optional(key),
    mode: Type.Optional(
      Type.Union(
        ["walk", "transit", "car", "indoor"].map((x) => Type.Literal(x)),
      ),
    ),
    category: Type.Optional(
      Type.Union(
        [
          "museum",
          "viewpoint",
          "experience",
          "park",
          "cafe",
          "meal",
          "rest",
        ].map((x) => Type.Literal(x)),
      ),
    ),
    minutes: Type.Number({ minimum: 1, maximum: 1440 }),
    meters: Type.Optional(Type.Number({ minimum: 0, maximum: 1000000 })),
    pacing: Type.Union([
      Type.Literal("relaxed"),
      Type.Literal("balanced"),
      Type.Literal("active"),
    ]),
    occurredAt: Type.String({ maxLength: 50 }),
    sourceNote: Type.String({ minLength: 8, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
function validate(value: unknown): asserts value is JourneyObservation {
  if (!Value.Check(journeyObservationSchema, value))
    throw Error("移動・滞在履歴の形式が不正です");
  const o = value as JourneyObservation;
  if (
    !Number.isFinite(Date.parse(o.occurredAt)) ||
    Date.parse(o.occurredAt) > Date.now()
  )
    throw Error("実績日時は過去の日時を指定してください");
  if (
    o.kind === "travel"
      ? !o.fromKey || !o.toKey || o.fromKey === o.toKey || !o.mode
      : !o.placeKey || !o.category || o.basis !== "user-observed"
  )
    throw Error(
      "移動は方向と手段、滞在は施設とカテゴリを持つ本人の観測が必要です",
    );
}
/** Only the caller/CLI imports observations. The model can save proposals, never observed trips. */
export class JourneyMemoryStore {
  readonly root: string;
  constructor(private readonly store: Store) {
    this.root = join(store.root, "journey-memory");
  }
  async importObservations(values: unknown) {
    if (!Array.isArray(values) || !values.length || values.length > 100)
      throw Error("履歴は1〜100件の配列で指定してください");
    values.forEach(validate);
    if (new Set(values.map((o) => o.id)).size !== values.length)
      throw Error("履歴IDが重複しています");
    await mkdir(join(this.root, "observations"), {
      recursive: true,
      mode: 0o700,
    });
    for (const o of values)
      await writeFile(
        join(this.root, "observations", o.id + ".json"),
        JSON.stringify(o),
        { flag: "wx", mode: 0o600 },
      );
    return {
      imported: values.length,
      basis: "本人申告または提供元の経路見積。モデル生成案は実績へ昇格しない",
    };
  }
  async read(task?: Task): Promise<JourneyMemory> {
    const keys = task
      ? new Set(task.urls.map((venueUrl) => placeKey({ venueUrl, label: "" })))
      : undefined;
    const files = async (dir: string) =>
      (
        await readdir(join(this.root, dir)).catch((e) => {
          if (e.code === "ENOENT") return [];
          throw e;
        })
      )
        .filter((f) => /^[a-zA-Z0-9-]+\.json$/.test(f))
        .sort()
        .slice(-512);
    const observations: JourneyObservation[] = [];
    for (const f of await files("observations")) {
      const o: unknown = JSON.parse(
        await readFile(join(this.root, "observations", f), "utf8"),
      );
      validate(o);
      if (
        !keys ||
        [o.fromKey, o.toKey, o.placeKey].some(
          (key) =>
            !!key &&
            [...keys].some(
              (root) => key === root || key.startsWith(root + "#floor:"),
            ),
        )
      )
        observations.push(o);
    }
    let planFiles = await files("plans");
    if (!planFiles.length && task) {
      for (const previous of (await this.store.list())
        .filter(
          (p) => p.id !== task.id && p.answer?.actionPlan && !p.evaluation,
        )
        .slice(0, 20))
        await this.rememberPlan(previous);
      planFiles = await files("plans");
    }
    const priorPlans: JourneyMemory["priorPlans"] = [];
    for (const f of planFiles) {
      const p = JSON.parse(await readFile(join(this.root, "plans", f), "utf8"));
      if (
        p.kind === "planned" &&
        typeof p.taskId === "string" &&
        Number.isFinite(p.minutes) &&
        (!keys || p.venueKeys?.some((key: string) => keys.has(key)))
      )
        priorPlans.push({
          taskId: p.taskId,
          status: p.status,
          createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined,
          steps: p.steps,
          minutes: p.minutes,
          visits: Array.isArray(p.visits) ? p.visits.slice(0, 12) : undefined,
          distanceEstimateMeters: Number.isFinite(
            p.report?.walkingMetersEstimate,
          )
            ? p.report.walkingMetersEstimate
            : undefined,
          travel: Array.isArray(p.report?.legs)
            ? p.report.legs
                .slice(0, 12)
                .map(
                  (l: {
                    from: string;
                    to: string;
                    mode: string;
                    allocatedMinutes: number;
                    estimatedMeters?: number;
                  }) => ({
                    from: l.from.slice(0, 150),
                    to: l.to.slice(0, 150),
                    mode: l.mode,
                    minutes: l.allocatedMinutes,
                    estimateMeters: l.estimatedMeters,
                  }),
                )
            : undefined,
        });
    }
    return {
      version: 1,
      observations: observations
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, 256),
      priorPlans: priorPlans
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .slice(0, 5),
    };
  }
  async rememberPlan(task: Task) {
    if (
      !task.answer?.actionPlan ||
      task.evaluation ||
      !/^[a-zA-Z0-9-]+$/.test(task.id)
    )
      return;
    await mkdir(join(this.root, "plans"), { recursive: true, mode: 0o700 });
    const p = task.answer.actionPlan;
    await writeFile(
      join(this.root, "plans", task.id + ".json"),
      JSON.stringify({
        kind: "planned",
        taskId: task.id,
        status: task.status,
        createdAt: task.createdAt,
        steps: p.steps.length,
        visits: p.steps
          .filter(
            (s) =>
              !["move", "return", "wait"].includes(s.kind ?? "") &&
              !/入店待|待機|行列/.test(s.action),
          )
          .map((s) => ({
            place: s.where.slice(0, 150),
            kind: s.kind ?? "unknown",
            minutes: s.durationMinutes ?? 0,
          }))
          .slice(0, 12),
        venueKeys: task.urls.map((venueUrl) =>
          placeKey({ venueUrl, label: "" }),
        ),
        minutes: p.steps.reduce((n, s) => n + (s.durationMinutes ?? 0), 0),
        journeyState: p.journeyState,
        report: task.journeyAssessment,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
}
