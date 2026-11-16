import { adapters, publicSocialRequested } from "./sources.js";
import { Type, type Static } from "@sinclair/typebox";
import { assertEvidenceIntegrity } from "./provenance.js";
import { verifySocialSignal } from "./social.js";
import type { Task } from "./types.js";
const text = Type.String({ minLength: 1, maxLength: 200 });
export const discoverySchema = Type.Array(
  Type.Object(
    {
      anchorId: Type.String({ minLength: 1, maxLength: 100 }),
      headline: Type.String({ minLength: 1, maxLength: 56 }),
      idea: text,
      whyNow: text,
      fit: text,
      fallback: text,
      basis: Type.Union([
        Type.Literal("social-snapshot"),
        Type.Literal("official-event"),
        Type.Literal("original-idea"),
      ]),
      evidenceIds: Type.Array(Type.String({ maxLength: 100 }), {
        maxItems: 6,
        uniqueItems: true,
      }),
      signalId: Type.Optional(Type.String({ maxLength: 100 })),
      validFrom: Type.Optional(
        Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      ),
      validTo: Type.Optional(
        Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      ),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 3 },
);
export type Discovery = Static<typeof discoverySchema>[number];
export const discoveryRequested = (query: string) =>
  publicSocialRequested(query) || /ユニーク|穴場/i.test(query);
const isoDates = (s: string) =>
  [
    ...s
      .normalize("NFKC")
      .matchAll(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/g),
  ].map((m) => `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`);
function rangeDates(text: string) {
  const found = isoDates(text);
  for (const m of text
    .normalize("NFKC")
    .matchAll(
      /(20\d{2})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?\s*[～〜~]\s*(\d{1,2})月(\d{1,2})日/g,
    )) {
    if (Number(m[4]) >= Number(m[2]))
      found.push(`${m[1]}-${m[4]!.padStart(2, "0")}-${m[5]!.padStart(2, "0")}`);
  }
  return found;
}
export function validateDiscoveries(
  task: Task,
  items: Discovery[],
  anchors: string[],
) {
  for (const d of items) {
    if (!anchors.includes(d.anchorId))
      throw Error("ユニークな提案は元の地点・節目に結び付けてください");
    const evidence = d.evidenceIds.map((id) =>
      assertEvidenceIntegrity(task, id),
    );
    if (
      /急上昇|急増|バズって|爆発的人気|SNSで大人気|トレンド[1１]位/.test(
        [d.headline, d.idea, d.whyNow].join(" "),
      )
    )
      throw Error("単一投稿や公式告知からSNS全体の流行・急増を断定できません");
    if (d.basis === "social-snapshot") {
      const signal = task.socialSignals?.find((s) => s.id === d.signalId);
      if (!signal)
        throw Error("SNS反応に基づく提案には取得済みsignalIdが必要です");
      verifySocialSignal(task, signal);
      if (
        !evidence.some((e) => e.pageId === signal.pageId) ||
        Object.values(signal.metrics).every((v) => v === null)
      )
        throw Error("SNS反応の引用と数値を確認できません");
      const age = Date.parse(task.createdAt) - Date.parse(signal.observedAt);
      if (
        Date.parse(task.createdAt) - Date.parse(signal.publishedAt) >
        30 * 86400000
      )
        throw Error("古い投稿を現在の話題として扱えません");
      if (age > 30 * 86400000 || age < -300000)
        throw Error("SNS反応の取得が古いか未来のため再確認が必要です");
    } else if (d.signalId)
      throw Error("SNS反応の参照はsocial-snapshotだけに指定してください");
    if (d.basis === "official-event") {
      if (
        !d.validFrom ||
        !d.validTo ||
        d.validFrom > d.validTo ||
        !evidence.length
      )
        throw Error("期間限定の提案には開催期間と公式根拠が必要です");
      for (const day of [d.validFrom, d.validTo])
        if (
          !Number.isFinite(Date.parse(day)) ||
          new Date(day).toISOString().slice(0, 10) !== day
        )
          throw Error("開催日付が不正です");
      const pages = evidence.map((e) =>
        task.pages.find((p) => p.id === e.pageId)!,
      );
      if (
        pages.some(
          (p) =>
            !adapters.some(
              (a) =>
                ["official-visit", "official-dining"].includes(a.id) &&
                a.hosts.includes(new URL(p.url).hostname),
            ),
        )
      )
        throw Error(
          "期間・利用条件は許可済みの公式施設ページで確認してください",
        );
      const dates = rangeDates(evidence.map((e) => e.quote).join(" "));
      if (!dates.includes(d.validFrom) || !dates.includes(d.validTo))
        throw Error("開催期間の両日付が引用にありません");
      const visit = isoDates(task.query)[0] ?? task.createdAt.slice(0, 10);
      if (d.validTo < visit || d.validFrom > visit)
        throw Error(
          "対象日と開催期間が合いません。通常の体験を提案してください",
        );
    } else if (d.validFrom || d.validTo)
      throw Error("開催期間はofficial-eventだけに指定してください");
  }
}
