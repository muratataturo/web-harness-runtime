import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { assertEvidenceIntegrity } from "./provenance.js";
import type { Task } from "./types.js";
const text = Type.String({ minLength: 8, maxLength: 180 });
export const proposalSetSchema = Type.Object(
  {
    options: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64 }),
          theme: Type.Union([
            Type.Literal("discovery"),
            Type.Literal("relax"),
            Type.Literal("photo"),
          ]),
          anchorId: Type.String({ minLength: 1, maxLength: 100 }),
          stepId: Type.Optional(Type.String({ maxLength: 100 })),
          title: Type.String({ minLength: 1, maxLength: 48 }),
          activity: Type.String({ minLength: 25, maxLength: 220 }),
          deliverable: text,
          benefit: text,
          difference: text,
          tradeoff: text,
          mechanism: Type.Union([
            Type.Literal("compare"),
            Type.Literal("focus"),
            Type.Literal("capture"),
          ]),
          minutes: Type.Integer({ minimum: 1, maximum: 180 }),
          evidenceIds: Type.Array(Type.String({ maxLength: 100 }), {
            maxItems: 6,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 3, maxItems: 3 },
    ),
  },
  { additionalProperties: false },
);
export type Proposal = Static<typeof proposalSetSchema>["options"][number];
export type ProposalSet = Static<typeof proposalSetSchema>;
export const proposalRequested = (query: string) =>
  /3案|３案|複数案|比較して選|比較選択|過ごし方を選|three (?:options|variants)/i.test(
    query,
  );
const grams = (s: string) => {
  const n = s
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}\d]/gu, "")
    .toLowerCase();
  return new Set(
    Array.from({ length: Math.max(0, n.length - 1) }, (_, i) =>
      n.slice(i, i + 2),
    ),
  );
};
export function contentSimilarity(a: string, b: string) {
  const x = grams(a),
    y = grams(b);
  const intersection = [...x].filter((g) => y.has(g)).length;
  return x.size + y.size ? (2 * intersection) / (x.size + y.size) : 0;
}
export function proposalRevision(task: Task) {
  const presentationRevision = createHash("sha256")
    .update(
      readFileSync(
        new URL("../web/artifact-client.bundle.js", import.meta.url),
        "utf8",
      ).replace(/\r\n?/g, "\n"),
    )
    .update(
      readFileSync(
        new URL("../web/artifact-client.bundle.css", import.meta.url),
        "utf8",
      ).replace(/\r\n?/g, "\n"),
    )
    .digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "proposal-review-v2",
        presentationRevision,
        query: task.query,
        answer: task.answer,
      }),
    )
    .digest("hex");
}
export function validateProposalSet(
  task: Task,
  set: ProposalSet,
  artifact: NonNullable<Task["answer"]>["visualArtifact"],
  plan = task.answer?.actionPlan,
) {
  if (!artifact) throw Error("比較対象の視覚成果物が必要です");
  if (
    new Set(set.options.map((o) => o.id)).size !== 3 ||
    new Set(set.options.map((o) => o.theme)).size !== 3 ||
    new Set(set.options.map((o) => o.mechanism)).size !== 3
  )
    throw Error("3案のID・テーマ・体験の仕組みはそれぞれ異なる必要があります");
  for (const o of set.options) {
    o.evidenceIds.forEach((id) => assertEvidenceIntegrity(task, id));
    if (artifact.kind === "journey-map") {
      const stop = artifact.stops.find((s) => s.id === o.anchorId),
        step = plan?.steps.find((s) => s.id === o.stepId);
      if (!stop || !step || !stop.stepIds.includes(step.id))
        throw Error("比較案は元の地点と手順に結び付けてください");
      if (
        step.durationMinutes === undefined ||
        o.minutes > step.durationMinutes
      )
        throw Error("比較案の時間は元の活動枠内に収めてください");
      if (
        !o.evidenceIds.length ||
        !o.evidenceIds.some((id) => stop.evidenceIds.includes(id))
      )
        throw Error("比較案には対象地点の根拠が必要です");
      if (contentSimilarity(o.activity, step.action + " " + step.how) > 0.84)
        throw Error(
          "元の手順の言い換えだけでは独自案になりません。行動と成果を変えてください",
        );
    } else if (!artifact.milestones.some((m) => m.id === o.anchorId))
      throw Error("比較案は元の節目に結び付けてください");
  }
  for (let i = 0; i < set.options.length; i++)
    for (let j = i + 1; j < set.options.length; j++) {
      const a = set.options[i]!,
        b = set.options[j]!;
      if (
        contentSimilarity(
          a.activity + " " + a.deliverable,
          b.activity + " " + b.deliverable,
        ) > 0.72
      )
        throw Error(
          `${a.id}/${b.id}: 見出し以外の内容が似すぎています。行動と残る成果が異なる案にしてください`,
        );
    }
}
export function rankProposals(task: Task, set: ProposalSet) {
  const query = task.query;
  const reasons = {
    relax: /疲れ|休憩|子供|幼児|無理|ゆっくり|負担|保留|家計/g,
    photo: /写真|撮影|カメラ|記録/g,
    discovery: /発見|科学|動物|学び|比較|観察|体験/g,
  };
  const priority = {
    relax: /(?:疲れ|休憩|負担).{0,8}優先|優先.{0,8}(?:休息|負担|疲れ)/.test(
      query,
    ),
    photo: /(?:写真|撮影|記録).{0,8}優先/.test(query),
    discovery: /(?:発見|科学|学び).{0,8}優先/.test(query),
  };
  const ranked = set.options
    .map((o) => ({
      id: o.id,
      theme: o.theme,
      matches: [...new Set(query.match(reasons[o.theme]) ?? [])],
      evidenceLinked: o.evidenceIds.length > 0,
      explicitlyPrioritized: priority[o.theme],
    }))
    .sort(
      (a, b) =>
        Number(b.explicitlyPrioritized) - Number(a.explicitlyPrioritized) ||
        b.matches.length - a.matches.length ||
        a.id.localeCompare(b.id),
    );
  return {
    recommendedId: ranked[0]!.id,
    reason: ranked[0]!.matches.length
      ? `希望にある「${ranked[0]!.matches.slice(0, 3).join("・")}」との対応から、この案を先に表示しています。`
      : "同じ条件内で比較できる3案です。好みで切り替えてください。",
    assessment:
      "入力した希望からの初期提案で、人間の魅力度評価や実測結果ではありません。好みで切り替えてください。",
    options: ranked,
  };
}
export function proposalAudit(task: Task, set: ProposalSet) {
  return {
    version: 1,
    method: "structured-actions-and-character-bigram-heuristic",
    semanticAppeal: "unrated",
    pairwise: set.options.flatMap((a, i) =>
      set.options.slice(i + 1).map((b) => ({
        a: a.id,
        b: b.id,
        similarity: Number(
          contentSimilarity(
            a.activity + " " + a.deliverable,
            b.activity + " " + b.deliverable,
          ).toFixed(3),
        ),
      })),
    ),
    ranking: rankProposals(task, set),
  };
}
