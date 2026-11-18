import { Type, type Static } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import type { Task } from "./types.js";
import type { ActionPlan } from "./answer-plan.js";
import { assertEvidenceIntegrity } from "./provenance.js";
import { entityKey, allowedHosts, checkNavigation } from "./sources.js";
const time = Type.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" });
export const stepChecksSchema = Type.Array(
  Type.Object(
    {
      id: Type.String({ minLength: 1, maxLength: 100 }),
      stepId: Type.String({ minLength: 1, maxLength: 100 }),
      kind: Type.Union([Type.Literal("opening"), Type.Literal("fact")]),
      venueUrl: Type.String({ maxLength: 2048 }),
      evidenceIds: Type.Array(Type.String({ maxLength: 100 }), {
        maxItems: 20,
      }),
      opens: Type.Optional(time),
      closes: Type.Optional(time),
      lastEntry: Type.Optional(time),
      terms: Type.Optional(
        Type.Array(Type.String({ minLength: 2, maxLength: 100 }), {
          minItems: 1,
          maxItems: 8,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  { maxItems: 96 },
);
export type StepCheck = Static<typeof stepChecksSchema>[number];
export type StepResult = {
  id: string;
  stepId: string;
  kind: string;
  venueUrl?: string;
  status: "passed" | "unknown" | "failed" | "arrival-check" | "proposal";
  detail: string;
  evidenceIds: string[];
  needsResearch: boolean;
};
const clock = (s: string) =>
  Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]);
function normalize(s: string) {
  return s
    .normalize("NFKC")
    .replace(
      /(午前|午後)?\s*(\d{1,2})時(?:(\d{1,2})分)?/g,
      (_all, period, h, m) =>
        `${Number(h) + (period === "午後" && Number(h) < 12 ? 12 : 0)}:${String(m ?? "00").padStart(2, "0")}`,
    )
    .replace(
      /(\d{1,2}):(\d{2})/g,
      (_a, h, m) => `${String(Number(h)).padStart(2, "0")}:${m}`,
    );
}
export function stepPlanHash(plan: ActionPlan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
/** Declarative, bounded checks: no generated regex, JavaScript or arbitrary network fetch. */
export function verifyStepPlan(task: Task, plan: ActionPlan) {
  const required =
    task.tripBrief?.requiresStepResearch === true || !!plan.stepChecks?.length;
  const checks: StepResult[] = [];
  const push = (r: StepResult) => checks.push(r);
  const same = (a: string, b: string) => {
    const key = entityKey(a);
    return !!key && key === entityKey(b);
  };
  for (const s of plan.steps) {
    if (!required) continue;
    const base = {
      stepId: s.id,
      venueUrl: s.venueUrl,
      evidenceIds: [] as string[],
    };
    if (
      !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(s.when) ||
      !Number.isSafeInteger(s.durationMinutes) ||
      (s.durationMinutes ?? 0) < 1 ||
      clock(s.when) + s.durationMinutes! > 1440
    ) {
      push({
        ...base,
        id: `${s.id}-time`,
        kind: "structure",
        status: "failed",
        detail:
          "開始時刻はHH:MM、所要時間は正の整数で同一日の範囲に指定してください",
        needsResearch: false,
      });
      continue;
    }
    if (!s.kind) {
      push({
        ...base,
        id: `${s.id}-kind`,
        kind: "structure",
        status: "unknown",
        detail:
          "手順のkindがありません。食事・体験・移動・休憩を区別してください",
        needsResearch: false,
      });
      continue;
    }
    if (["move", "return"].includes(s.kind)) {
      push({
        ...base,
        id: `${s.id}-travel`,
        kind: "access",
        status: "proposal",
        detail:
          "移動時間は提案の見積。道路経路・当日の交通状況を確認済みにはしません",
        needsResearch: false,
      });
      continue;
    }
    if (!s.venueUrl) {
      push({
        ...base,
        id: `${s.id}-venue`,
        kind: "source",
        status: "unknown",
        detail:
          "実施設のvenueUrlが必要です。場所・営業時間を照合する対象を指定してください",
        needsResearch: false,
      });
      continue;
    }
    try {
      checkNavigation(s.venueUrl, allowedHosts(task.sources));
    } catch {
      push({
        ...base,
        id: `${s.id}-venue`,
        kind: "source",
        status: "failed",
        detail: "許可されていない施設URLです",
        needsResearch: false,
      });
      continue;
    }
    const declared = plan.stepChecks?.filter((c) => c.stepId === s.id) ?? [];
    if (!declared.some((c) => c.kind === "opening"))
      push({
        ...base,
        id: `${s.id}-opening`,
        kind: "opening",
        status: "unknown",
        detail:
          "訪問時間に対応する営業時間の引用とopens/closesが必要です。休憩所も施設全体と区別して確認してください",
        needsResearch: true,
      });
    for (const c of declared) {
      const r = {
        ...base,
        id: c.id,
        kind: c.kind,
        evidenceIds: c.evidenceIds,
        needsResearch: true,
      };
      if (!same(s.venueUrl, c.venueUrl)) {
        push({
          ...r,
          status: "failed",
          detail: "検査対象が手順の施設と一致しません",
          needsResearch: false,
        });
        continue;
      }
      let quotes: string[] = [];
      try {
        quotes = c.evidenceIds.map((id) => {
          const e = assertEvidenceIntegrity(task, id);
          if (!same(e.url, c.venueUrl) || !s.evidenceIds.includes(id))
            throw Error("別施設または手順にない引用");
          return e.quote;
        });
      } catch {
        push({
          ...r,
          status: "failed",
          detail:
            "手順・検査・引用の対象が一致しないか、引用の完全性を確認できません",
          needsResearch: false,
        });
        continue;
      }
      if (!quotes.length) {
        push({
          ...r,
          status: "unknown",
          detail:
            "引用が未取得です。取得済み本文を読み、連続した根拠を保存してください",
        });
        continue;
      }
      if (c.kind === "fact") {
        const supported =
          c.terms?.length &&
          c.terms.every((term) =>
            quotes.some((q) => normalize(q).includes(normalize(term))),
          );
        push({
          ...r,
          status: supported ? "passed" : "unknown",
          detail: supported
            ? "指定した語句が同施設の引用内にあります。意味全体の含意を証明する判定ではありません"
            : "確認したいtermsが引用内に揃っていません",
          needsResearch: !supported,
        });
        continue;
      }
      if (!c.opens || !c.closes || clock(c.closes) <= clock(c.opens)) {
        push({
          ...r,
          status: "unknown",
          detail:
            "同一日のopens/closesを指定してください。深夜を跨ぐ営業は別途確認が必要です",
        });
        continue;
      }
      const paired = quotes.some((q) => {
        const n = normalize(q);
        const from = n.indexOf(normalize(c.opens!));
        const to = n.indexOf(normalize(c.closes!), Math.max(0, from + 1));
        return from >= 0 && to > from && to - from <= 120;
      });
      const entry =
        !c.lastEntry ||
        quotes.some((q) => normalize(q).includes(normalize(c.lastEntry!)));
      if (!paired || !entry) {
        push({
          ...r,
          status: "unknown",
          detail:
            "申告した営業時間・締切の数値対応が引用内で確認できません。曜日・ランチ/ディナー・臨時条件も読んで選び直してください",
        });
        continue;
      }
      const from = clock(s.when),
        to = from + (s.durationMinutes ?? 0);
      if (
        from < clock(c.opens) ||
        to > clock(c.closes) ||
        (c.lastEntry && from > clock(c.lastEntry))
      ) {
        push({
          ...r,
          status: "failed",
          detail: `予定${s.when}〜${Math.floor(to / 60)
            .toString()
            .padStart(
              2,
              "0",
            )}:${(to % 60).toString().padStart(2, "0")}が引用の営業枠${c.opens}〜${c.closes}${c.lastEntry ? "（入場/注文締切" + c.lastEntry + "）" : ""}と衝突しています。行程を変更するか対象日の別枠を調査してください`,
          needsResearch: false,
        });
      } else
        push({
          ...r,
          status: "passed",
          detail: `予定が引用にある${c.opens}〜${c.closes}の数値枠に収まります。曜日・提供枠・臨時変更の意味解釈は別途必要です`,
          needsResearch: false,
        });
    }
    for (const item of plan.budget?.items.filter((i) =>
      s.costItemIds.includes(i.id),
    ) ?? []) {
      const refs = item.evidenceIds;
      let valid = item.basis === "published" && refs.length > 0;
      try {
        valid =
          valid &&
          refs.every((id) =>
            same(assertEvidenceIntegrity(task, id).url, s.venueUrl!),
          );
      } catch {
        valid = false;
      }
      push({
        ...base,
        id: `${s.id}-price-${item.id}`,
        kind: "price",
        evidenceIds: refs,
        status: valid ? "passed" : "unknown",
        detail: valid
          ? `${item.label}：${item.quantity}×掲載単価${item.unitYen}円。合算と引用内数値は共通の予算検査で照合します`
          : "この手順で使う商品単価の同一施設の引用が不足、または見積です。掲載額と混同しないでください",
        needsResearch: !valid,
      });
    }
    if (["breakfast", "lunch", "dinner", "cafe"].includes(s.kind))
      push({
        ...base,
        id: `${s.id}-seating`,
        kind: "seating",
        status: "arrival-check",
        detail:
          "席・提供・当日の受付は現地判断。予約完了や空席確約として扱いません",
        needsResearch: false,
      });
  }
  for (const c of plan.stepChecks ?? [])
    if (!plan.steps.some((s) => s.id === c.stepId))
      push({
        id: c.id,
        stepId: c.stepId,
        kind: c.kind,
        status: "failed",
        detail: "実在しない手順への検査です",
        evidenceIds: c.evidenceIds,
        needsResearch: false,
      });
  const unknown = checks.filter((c) => c.status === "unknown");
  const failed = checks.filter((c) => c.status === "failed");
  return {
    version: 1 as const,
    planHash: stepPlanHash(plan),
    required,
    ready: !unknown.length && !failed.length,
    checks,
    unknown: unknown.length,
    failed: failed.length,
    scope:
      "引用・対象・数値・時間枠の契約検査。自然言語の意味全体、当日の営業・席・道路経路を証明するものではない",
  };
}
