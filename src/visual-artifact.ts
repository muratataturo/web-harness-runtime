import {
  proposalSetSchema,
  proposalRequested,
  validateProposalSet,
} from "./proposals.js";
import {
  discoverySchema,
  discoveryRequested,
  validateDiscoveries,
} from "./discovery.js";
import { entityKey, publicSocialRequested } from "./sources.js";
import { isCafeStay } from "./cafe.js";
import { sharedMapEmbed } from "./map-embed.js";
import { specificityContract } from "./answer-plan.js";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { assertEvidenceIntegrity } from "./provenance.js";
import type { Answer, Task } from "./types.js";
const text = Type.String({ minLength: 1, maxLength: 600 });
const id = Type.String({ minLength: 1, maxLength: 100 });
const ids = Type.Array(id, { maxItems: 20, uniqueItems: true });
export const visualArtifactSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("journey-map"),
      discoveries: Type.Optional(discoverySchema),
      proposalSet: Type.Optional(proposalSetSchema),
      title: Type.String({ minLength: 1, maxLength: 64 }),
      description: Type.String({ minLength: 1, maxLength: 180 }),
      moments: Type.Optional(
        Type.Array(
          Type.Object(
            {
              stepId: id,
              kind: Type.Union([
                Type.Literal("arrival"),
                Type.Literal("move"),
                Type.Literal("experience"),
                Type.Literal("meal"),
                Type.Literal("rest"),
                Type.Literal("return"),
              ]),
              title: Type.String({ minLength: 1, maxLength: 48 }),
              invitation: Type.String({ minLength: 1, maxLength: 180 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 16 },
        ),
      ),
      stops: Type.Array(
        Type.Object(
          {
            id,
            label: Type.String({ minLength: 1, maxLength: 48 }),
            stepIds: ids,
            primaryStepId: id,
            evidenceIds: ids,
            optional: Type.Boolean(),
            previewPageId: Type.Optional(id),
            experience: Type.Optional(
              Type.Object(
                {
                  headline: Type.String({ minLength: 1, maxLength: 64 }),
                  why: Type.String({ minLength: 1, maxLength: 200 }),
                  highlights: Type.Array(
                    Type.String({ minLength: 1, maxLength: 180 }),
                    { minItems: 2, maxItems: 4 },
                  ),
                  photoPageId: id,
                  photoIndex: Type.Integer({ minimum: 0, maximum: 7 }),
                  photoCaption: Type.String({ minLength: 1, maxLength: 180 }),
                  photoDescription: Type.String({
                    minLength: 1,
                    maxLength: 160,
                  }),
                },
                { additionalProperties: false },
              ),
            ),
            coordinates: Type.Optional(
              Type.Object(
                {
                  lat: Type.Number({ minimum: -85, maximum: 85 }),
                  lon: Type.Number({ minimum: -180, maximum: 180 }),
                  evidenceId: id,
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 2, maxItems: 12 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("life-roadmap"),
      discoveries: Type.Optional(discoverySchema),
      proposalSet: Type.Optional(proposalSetSchema),
      title: Type.String({ minLength: 1, maxLength: 64 }),
      description: Type.String({ minLength: 1, maxLength: 180 }),
      lanes: Type.Array(
        Type.Object(
          { id, label: Type.String({ minLength: 1, maxLength: 30 }) },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 5 },
      ),
      milestones: Type.Array(
        Type.Object(
          {
            id,
            laneId: id,
            horizon: Type.String({ minLength: 1, maxLength: 40 }),
            title: Type.String({ minLength: 1, maxLength: 64 }),
            action: text,
            doneWhen: text,
            decision: text,
            dependsOn: ids,
            evidenceIds: ids,
            basis: Type.Union([
              Type.Literal("proposal"),
              Type.Literal("source-backed"),
            ]),
          },
          { additionalProperties: false },
        ),
        { minItems: 3, maxItems: 20 },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type VisualArtifact = Static<typeof visualArtifactSchema>;
export function visualContract(query: string) {
  const kind =
    /人生|キャリア(?:計画|プラン)|転職.{0,20}(?:計画|順番)|life.?plan|career plan|ロードマップ/i.test(
      query,
    )
      ? "life-roadmap"
      : specificityContract(query).mode === "itinerary"
        ? "journey-map"
        : "none";
  return {
    version: 1,
    kind,
    policy:
      "文章だけでなく目的に合う操作可能な成果物を渡す。旅行は実際の手順と結びつく地図、人生・キャリアは時間軸・領域・依存関係・成果・判断条件。座標は本文に数値がある根拠を引用する。座標が取れない場所は未配置として保持し、架空のピンや道路を作らない。人生の将来を予測せず、提案と確認済みの事実を区別する。",
  };
}
export function validateVisualArtifact(
  task: Task,
  artifact: VisualArtifact,
  plan = task.answer?.actionPlan,
) {
  if (!Value.Check(visualArtifactSchema, artifact))
    throw Error("visualArtifactの形式が不正です");
  if (artifact.proposalSet)
    validateProposalSet(task, artifact.proposalSet, artifact, plan);
  if (artifact.discoveries)
    validateDiscoveries(
      task,
      artifact.discoveries,
      artifact.kind === "journey-map"
        ? artifact.stops.map((s) => s.id)
        : artifact.milestones.map((m) => m.id),
    );
  const unique = (values: string[]) => {
    if (new Set(values).size !== values.length)
      throw Error("視覚成果物のIDが重複しています");
  };
  if (artifact.kind === "journey-map") {
    unique(artifact.stops.map((s) => s.id));
    if (artifact.moments) {
      unique(artifact.moments.map((m) => m.stepId));
      if (
        !plan ||
        artifact.moments.length !== plan.steps.length ||
        plan.steps.some(
          (s) => !artifact.moments!.some((m) => m.stepId === s.id),
        )
      )
        throw Error(
          "行程の場面は移動・休憩を含む全手順に一対一で対応させてください",
        );
    }
    for (const s of artifact.stops) {
      if (
        !s.stepIds.length ||
        !s.stepIds.includes(s.primaryStepId) ||
        s.stepIds.some((id) => !plan?.steps.some((step) => step.id === id))
      )
        throw Error(`${s.id}: 地図と行動手順の対応がありません`);
      if (/\d{1,2}[:：]\d{2}|→|｜/.test(s.label))
        throw Error(
          `${s.id}: 地点名には場所だけを書き、時刻や行動説明はstepIdsに紐づく手順に分けてください`,
        );
      if (s.previewPageId) {
        const previewPage = task.pages.find((p) => p.id === s.previewPageId);
        if (
          previewPage &&
          !s.evidenceIds.some((id) => {
            const ev = task.evidence.find((e) => e.id === id);
            if (!ev) return false;
            const a = entityKey(ev.url),
              b = entityKey(previewPage.url);
            return a &&
              b &&
              !a.startsWith("generic:") &&
              !b.startsWith("generic:")
              ? a === b
              : new URL(ev.url).hostname === new URL(previewPage.url).hostname;
          })
        )
          throw Error(`${s.id}: Google共有地図と訪問先の出典対応がありません`);
      }
      if (
        s.previewPageId &&
        !task.pages
          .find((p) => p.id === s.previewPageId)
          ?.mapEmbeds?.some(sharedMapEmbed)
      )
        throw Error(`${s.id}: 取得済みのGoogle Maps共有埋め込みが必要です`);
      if (s.experience) {
        const e = s.experience,
          page = task.pages.find((p) => p.id === e.photoPageId);
        if (
          !task.photoInspections?.some(
            (p) => p.pageId === e.photoPageId && p.imageIndex === e.photoIndex,
          )
        )
          throw Error(
            `${s.id}: inspect_photoで実画像を確認してから選んでください`,
          );
        if (!page?.images?.[e.photoIndex])
          throw Error(`${s.id}: 保存ページ内の写真参照が必要です`);
        if (
          !s.evidenceIds.some(
            (id) =>
              task.evidence.find((ev) => ev.id === id)?.pageId === page.id,
          )
        )
          throw Error(`${s.id}: 写真と地点の出典対応がありません`);
      }
      s.evidenceIds.forEach((id) => assertEvidenceIntegrity(task, id));
      if (s.coordinates) {
        const quote = assertEvidenceIntegrity(
          task,
          s.coordinates.evidenceId,
        ).quote;
        const lat = quote.match(
          /["']?\b(?:lat|latitude)["']?\s*[:=]\s*["']?(-?\d+(?:\.\d+)?)/i,
        )?.[1];
        const lon = quote.match(
          /["']?\b(?:lon|lng|longitude)["']?\s*[:=]\s*["']?(-?\d+(?:\.\d+)?)/i,
        )?.[1];
        if (
          lat === undefined ||
          lon === undefined ||
          Number(lat) !== s.coordinates.lat ||
          Number(lon) !== s.coordinates.lon
        )
          throw Error(`${s.id}: 座標の数値が出典にありません`);
      }
    }
  } else {
    unique(artifact.lanes.map((l) => l.id));
    unique(artifact.milestones.map((m) => m.id));
    const byId = new Map(artifact.milestones.map((m) => [m.id, m]));
    for (const m of artifact.milestones) {
      if (!artifact.lanes.some((l) => l.id === m.laneId))
        throw Error("不明なロードマップ領域");
      if (m.dependsOn.some((id) => !byId.has(id))) throw Error("不明な依存先");
      if (m.basis === "source-backed" && !m.evidenceIds.length)
        throw Error("確認済みの節目には出典が必要です");
      m.evidenceIds.forEach((id) => assertEvidenceIntegrity(task, id));
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id))
        throw Error("ロードマップの依存関係が循環しています");
      if (visited.has(id)) return;
      visiting.add(id);
      byId.get(id)!.dependsOn.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    byId.forEach((_, id) => visit(id));
  }
}
export function assessVisualArtifact(task: Task, answer: Answer) {
  const contract = visualContract(task.query),
    issues: string[] = [];
  if (contract.kind === "none" && !answer.visualArtifact)
    return { version: 1 as const, status: "not_required" as const, issues };
  if (!answer.visualArtifact)
    issues.push(
      `${contract.kind}の視覚成果物がありません。文章の整形だけでなく地図またはロードマップを作成してください`,
    );
  else {
    try {
      validateVisualArtifact(task, answer.visualArtifact, answer.actionPlan);
    } catch (e) {
      issues.push(String((e as Error).message));
    }
    if (proposalRequested(task.query) && !answer.visualArtifact.proposalSet)
      issues.push(
        "proposalSetに発見・ゆったり・写真の3案が必要です。行動・残る成果・定番との違い・不向きな点を具体化し、元の時間枠と地点を参照してください",
      );
    if (discoveryRequested(task.query)) {
      if (!answer.visualArtifact.discoveries?.length)
        issues.push(
          "SNS・トレンドを検討したdiscoveriesが必要です。取得できた反応・公式の期間限定情報・独自案を区別し、既存行程内の具体案と代替を示してください",
        );
      if (publicSocialRequested(task.query) && !task.socialResearch?.length)
        issues.push(
          "read_socialでSNSの取得可否を確認してください。取得できなければ未確認を明示して公式情報と独自案を使えます",
        );
    }
    if (
      contract.kind !== "none" &&
      answer.visualArtifact.kind !== contract.kind
    )
      issues.push(`相談に合う${contract.kind}が必要です`);
    if (
      answer.visualArtifact.kind === "journey-map" &&
      answer.visualArtifact.stops.filter((s) => s.coordinates).length < 2
    )
      issues.push(
        "地図に配置できる出典付き座標が2地点未満です。未配置のまま部分回答に残すか追加調査してください",
      );
    if (answer.visualArtifact.kind === "journey-map") {
      if (!answer.visualArtifact.moments)
        issues.push(
          "移動・休憩を含む全手順のmoments（stepId/kind/title/invitation）が必要です。移動や休憩にも具体的な楽しみ方・過ごし方を提案してください",
        );
      const experiences = answer.visualArtifact.stops.filter(
        (s) => s.experience,
      );
      if (task.answerPhotos !== undefined) {
        const missing = experiences.filter((s) => !task.answerPhotos?.[s.id]);
        if (missing.length)
          issues.push(
            "写真の取得・保存が完了していない体験があります: " +
              missing.map((s) => s.label).join("、"),
          );
      }
      const mainStops = answer.visualArtifact.stops.filter((s) => {
        const primary = answer.actionPlan?.steps.find(
          (p) => p.id === s.primaryStepId,
        );
        return (
          primary &&
          (!/徒歩|移動|帰路|帰宅|乗車|解散|待機|休憩/.test(primary.action) ||
            isCafeStay(primary))
        );
      });
      const absent = mainStops.filter((s) => !s.experience);
      if (absent.length)
        issues.push(
          "主要な訪問先すべてに写真と体験内容が必要です: " +
            absent.map((s) => s.label).join("、"),
        );
      if (experiences.length < 2)
        issues.push(
          "YOUR DAYの写真付き体験が2件未満です。掲載写真と、何を体験するか・選ぶ理由・楽しむ手順を構造化してください",
        );
    }
    if (
      answer.visualArtifact.kind === "life-roadmap" &&
      !answer.visualArtifact.milestones.some((m) => m.dependsOn.length)
    )
      issues.push("決める順番を表す依存関係がありません");
  }
  return {
    version: 1 as const,
    status: issues.length ? ("needs_visual" as const) : ("passed" as const),
    issues,
  };
}
