import { Type, type Static } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import type { Task } from "./types.js";
import type { ActionPlan } from "./answer-plan.js";
import { tripBrief } from "./trip-brief.js";
import { assertEvidenceIntegrity } from "./provenance.js";
import { entityKey } from "./sources.js";
const ids = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
  maxItems: 32,
});
export const journeyStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    places: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 100 }),
          label: Type.String({ minLength: 2, maxLength: 150 }),
          venueUrl: Type.Optional(Type.String({ maxLength: 2048 })),
          lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
          lon: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
          floor: Type.Optional(Type.Integer({ minimum: -10, maximum: 200 })),
          evidenceIds: ids,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    legs: Type.Array(
      Type.Object(
        {
          stepId: Type.String({ maxLength: 100 }),
          fromPlaceId: Type.String({ maxLength: 100 }),
          toPlaceId: Type.String({ maxLength: 100 }),
          mode: Type.Union(
            ["walk", "transit", "car", "indoor"].map((x) => Type.Literal(x)),
          ),
          movementMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
          waitMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
          boardingMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
          bufferMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
          publishedMinutes: Type.Optional(
            Type.Number({ minimum: 1, maximum: 1440 }),
          ),
          evidenceIds: ids,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    stays: Type.Array(
      Type.Object(
        {
          id: Type.String({ maxLength: 100 }),
          placeId: Type.String({ maxLength: 100 }),
          stepIds: ids,
          category: Type.Union(
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
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);
export type JourneyState = Static<typeof journeyStateSchema>;
export type JourneyObservation = {
  id: string;
  kind: "travel" | "dwell";
  basis: "user-observed" | "provider-estimate";
  fromKey?: string;
  toKey?: string;
  placeKey?: string;
  mode?: string;
  category?: string;
  minutes: number;
  meters?: number;
  pacing: "relaxed" | "balanced" | "active";
  occurredAt: string;
  sourceNote: string;
};
export type JourneyMemory = {
  version: 1;
  observations: JourneyObservation[];
  priorPlans: {
    taskId: string;
    status: string;
    createdAt?: string;
    steps: number;
    minutes: number;
    visits?: { place: string; kind: string; minutes: number }[];
    distanceEstimateMeters?: number;
    travel?: {
      from: string;
      to: string;
      mode: string;
      minutes: number;
      estimateMeters?: number;
    }[];
  }[];
};
function safeEntity(url: string) {
  try {
    return entityKey(url);
  } catch {
    return undefined;
  }
}
export function placeKey(p: {
  venueUrl?: string;
  label: string;
  lat?: number;
  lon?: number;
}) {
  return p.venueUrl
    ? `venue:${safeEntity(p.venueUrl) ?? p.venueUrl.replace(/#.*$/, "")}`
    : `label:${p.label.normalize("NFKC").replace(/\s+/g, "")}${p.lat !== undefined && p.lon !== undefined ? `@${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : ""}`;
}
export function endpointKey(p: {
  venueUrl?: string;
  label: string;
  lat?: number;
  lon?: number;
  floor?: number;
}) {
  return placeKey(p) + (p.floor === undefined ? "" : `#floor:${p.floor}`);
}
export function journeyPolicy(query: string) {
  const b = tripBrief(query);
  if (!b) return undefined;
  const minutes = b.timeRange
    ? time(b.timeRange[1]!) - time(b.timeRange[0]!)
    : 0;
  if (
    !b.requiresStepResearch &&
    minutes < 480 &&
    !/移動距離|滞在時間|移動時間|歩行距離/.test(query)
  )
    return undefined;
  return {
    version: 1 as const,
    pacing: b.pacing,
    fullDay: minutes >= 480,
    walkMetersPerMinute: b.pacing === "relaxed" ? 50 : 65,
    detourFactor: 1.3,
    restAfterMinutes: b.pacing === "relaxed" ? 120 : 180,
    restMinutes: 15,
    basis:
      "初期の計画仮定。道路経路・人の実績を表す数値ではない。実績は同じ場所・方向・手段・ペースの記録だけを参照する",
  };
}
const time = (s: string) => +s.split(":")[0]! * 60 + +s.split(":")[1]!;
export function straightLineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
) {
  const rad = Math.PI / 180,
    dlat = (b.lat - a.lat) * rad,
    dlon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return (
    6371008.8 *
    2 *
    Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)))
  );
}
const prior: Record<string, [number, number, number]> = {
  museum: [60, 90, 150],
  viewpoint: [25, 35, 60],
  experience: [30, 45, 90],
  park: [20, 30, 60],
  cafe: [30, 45, 75],
  meal: [40, 60, 90],
  rest: [10, 15, 30],
};
function q(values: number[], p: number) {
  const a = [...values].sort((a, b) => a - b);
  return a[Math.max(0, Math.ceil(a.length * p) - 1)]!;
}
export function assessJourneyState(task: Task, plan: ActionPlan) {
  const policy = task.journeyPolicy;
  const state = plan.journeyState;
  const issues: string[] = [],
    warnings: string[] = [];
  const legs: {
    stepId: string;
    mode: string;
    from: string;
    to: string;
    straightLineMeters?: number;
    estimatedMeters?: number;
    recommendedMinutes?: number;
    allocatedMinutes: number;
    historySamples: number;
    basis: string;
  }[] = [];
  const stays: {
    place: string;
    category: string;
    minutes: number;
    minimumMinutes: number;
    suggestedRange: number[];
    historySamples: number;
    basis: string;
  }[] = [];
  const base = {
    version: 1 as const,
    required: !!policy,
    planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
  if (!policy)
    return {
      ...base,
      status: "not_required" as const,
      issues,
      warnings,
      legs,
      stays,
      walkingMetersEstimate: 0,
      walkingMinutes: 0,
      historySamples: 0,
    };
  if (!state)
    return {
      ...base,
      status: "needs_detail" as const,
      issues: [
        "journeyStateに場所・移動・滞在の状態が必要です。移動時間を距離・手段・乗換・待ち・余裕から組み立ててください",
      ],
      warnings,
      legs,
      stays,
      walkingMetersEstimate: 0,
      walkingMinutes: 0,
      historySamples: 0,
    };
  const observations = (task.journeyMemory?.observations ?? []).filter(
    (o) =>
      o.pacing === policy.pacing &&
      Date.parse(o.occurredAt) <= Date.parse(task.createdAt) &&
      Date.parse(task.createdAt) - Date.parse(o.occurredAt) <=
        (o.basis === "provider-estimate" ? 7 : 730) * 86400000,
  );
  const places = new Map(state.places.map((p) => [p.id, p]));
  if (places.size !== state.places.length)
    issues.push("場所IDが重複しています");
  if (new Set(state.stays.map((s) => s.id)).size !== state.stays.length)
    issues.push("滞在IDが重複しています");
  const verifiedCoordinates = new Set<string>();
  for (const p of state.places) {
    if (p.venueUrl) {
      try {
        const u = new URL(p.venueUrl);
        if (
          u.protocol !== "https:" ||
          !task.pages.some(
            (page) =>
              page.url === p.venueUrl ||
              (!!safeEntity(p.venueUrl!) &&
                safeEntity(page.url) === safeEntity(p.venueUrl!)),
          )
        )
          throw Error();
      } catch {
        issues.push(
          `${p.label}: 滞在先は取得済みの公開施設URLを指定してください`,
        );
      }
    }
    if ((p.lat === undefined) !== (p.lon === undefined))
      issues.push(`${p.label}: 緯度と経度は対で指定してください`);
    if (p.lat === undefined || p.lon === undefined) continue;
    try {
      const quotes = p.evidenceIds.map((id) =>
        assertEvidenceIntegrity(task, id),
      );
      if (
        !quotes.some(
          (s) =>
            [
              ...s.quote.matchAll(
                /"lat"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*,\s*"lon"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/g,
              ),
            ].some(
              (m) =>
                Math.abs(Number(m[1]) - p.lat!) < 1e-8 &&
                Math.abs(Number(m[2]) - p.lon!) < 1e-8,
            ) &&
            (s.quote.normalize("NFKC").includes(p.label.normalize("NFKC")) ||
              (!!p.venueUrl &&
                !!safeEntity(p.venueUrl) &&
                safeEntity(p.venueUrl) === safeEntity(s.url))),
        )
      )
        throw Error();
      verifiedCoordinates.add(p.id);
    } catch {
      issues.push(
        `${p.label}: 座標とlabelに対応する引用が必要です。labelは引用にある施設名だけを使い、階数はfloorへ分けてください`,
      );
    }
  }
  let walkingMetersEstimate = 0,
    walkingMinutes = 0,
    historySamples = 0;
  for (const s of plan.steps) {
    if (!["move", "return"].includes(s.kind ?? "")) continue;
    const declared = state.legs.filter((l) => l.stepId === s.id);
    if (declared.length !== 1) {
      issues.push(
        `${s.id}: 移動のfrom/to・手段・時間内訳を1件指定してください`,
      );
      continue;
    }
    const l = declared[0]!,
      a = places.get(l.fromPlaceId),
      b = places.get(l.toPlaceId);
    if (!a || !b || a.id === b.id) {
      issues.push(`${s.id}: 異なる出発地点と到着地点が必要です`);
      continue;
    }
    const total =
      l.movementMinutes + l.waitMinutes + l.boardingMinutes + l.bufferMinutes;
    if (total !== s.durationMinutes)
      issues.push(
        `${s.id}: 移動・待ち・乗降/乗換・余裕の合計${total}分と手順${s.durationMinutes}分が一致しません`,
      );
    if (l.bufferMinutes < 3)
      issues.push(`${s.id}: 到着準備や信号待ちの余裕を3分以上明示してください`);
    const history = observations.filter(
      (o) =>
        o.kind === "travel" &&
        o.fromKey === endpointKey(a) &&
        o.toKey === endpointKey(b) &&
        o.mode === l.mode,
    );
    historySamples += history.length;
    const lower =
      verifiedCoordinates.has(a.id) && verifiedCoordinates.has(b.id)
        ? straightLineMeters(
            a as { lat: number; lon: number },
            b as { lat: number; lon: number },
          )
        : undefined;
    let recommended: number | undefined,
      meters: number | undefined,
      basis = "未確認";
    if (l.mode === "walk" && lower !== undefined) {
      meters = Math.ceil(lower * policy.detourFactor);
      recommended = Math.ceil(meters / policy.walkMetersPerMinute);
      basis = "引用座標の直線距離×仮の迂回係数と歩速。道路距離は未確認";
    }
    if (l.mode === "indoor") {
      const building = (p: typeof a) => {
        const key = placeKey(p);
        return key.includes(":okura-hamamatsu-")
          ? "building:okura-hamamatsu"
          : key;
      };
      if (
        building(a) !== building(b) ||
        placeKey(a).includes("official-public-space:") ||
        placeKey(b).includes("official-public-space:")
      )
        issues.push(
          `${s.id}: 異なる施設や屋外広場を館内移動に置き換えられません。徒歩区間の距離または経路時間を調査してください`,
        );

      if (lower !== undefined && lower > 500)
        issues.push(`${s.id}: 離れた地点を館内移動として扱えません`);
      recommended = Math.abs((a.floor ?? 0) - (b.floor ?? 0)) >= 10 ? 10 : 5;
      basis = "館内・上下移動の初期見積。エレベーター待ち等は別内訳";
    }
    if (
      lower !== undefined &&
      lower < 100 &&
      Math.abs((a.floor ?? 0) - (b.floor ?? 0)) >= 10
    )
      recommended = Math.max(recommended ?? 0, 10);
    if (l.publishedMinutes !== undefined) {
      try {
        const quotes = l.evidenceIds.map((id) =>
          assertEvidenceIntegrity(task, id).quote.normalize("NFKC"),
        );
        const supported = quotes.some((quote) => {
          const from = quote.indexOf(a.label.normalize("NFKC"));
          const to = quote.indexOf(
            b.label.normalize("NFKC"),
            from + a.label.length,
          );
          return (
            from >= 0 &&
            to > from &&
            /から|より|→|\bto\b/i.test(
              quote.slice(from + a.label.length, to),
            ) &&
            [...quote.matchAll(/(\d+(?:\.\d+)?)\s*分/g)].some(
              (m) => Number(m[1]) === l.publishedMinutes,
            ) &&
            (l.mode !== "walk" || /徒歩|walk/i.test(quote))
          );
        });
        if (!supported) throw Error();
        recommended = Math.max(recommended ?? 0, l.publishedMinutes);
        basis += "／同一方向の掲載分数を照合";
      } catch {
        issues.push(
          `${s.id}: 掲載移動時間は出発→到着の方向・両地点名・手段・分数が同じ引用にある根拠が必要です`,
        );
      }
    }
    if (history.length) {
      recommended = Math.max(
        recommended ?? 0,
        q(
          history.map((o) => o.minutes),
          0.8,
        ),
      );
      const distances = history
        .filter((o) => o.meters !== undefined)
        .map((o) => o.meters!);
      if (distances.length) meters = Math.max(meters ?? 0, q(distances, 0.8));
      basis += `／同条件の申告実績・経路見積${history.length}件の上位側分数`;
    }
    if (l.mode === "walk" && meters !== undefined)
      recommended = Math.max(
        recommended ?? 0,
        Math.ceil(meters / policy.walkMetersPerMinute),
      );
    if (recommended === undefined)
      issues.push(
        `${s.id}: 距離を求める引用座標、掲載経路時間、または同条件の履歴が不足しています`,
      );
    else if (l.movementMinutes < recommended)
      issues.push(
        `${s.id}: ${a.label}→${b.label}は移動本体を${recommended}分以上見積もる基準です（現在${l.movementMinutes}分）。行程を再配分してください`,
      );
    if (l.mode === "walk") {
      walkingMetersEstimate += meters ?? 0;
      walkingMinutes += l.movementMinutes;
    }
    legs.push({
      stepId: s.id,
      mode: l.mode,
      from: a.label,
      to: b.label,
      straightLineMeters: lower === undefined ? undefined : Math.round(lower),
      estimatedMeters: meters,
      recommendedMinutes: recommended,
      allocatedMinutes: total,
      historySamples: history.length,
      basis,
    });
  }
  const occupied = new Set<string>();
  const groups = new Map<string, (typeof stays)[number]>();
  for (const stay of state.stays) {
    const p = places.get(stay.placeId),
      steps = stay.stepIds.map((id) => plan.steps.find((s) => s.id === id));
    if (!p || !steps.length || steps.some((s) => !s)) {
      issues.push(`${stay.id}: 滞在場所と実在する手順を指定してください`);
      continue;
    }
    for (const s of steps) {
      if (occupied.has(s!.id))
        issues.push(`${s!.id}: 滞在時間を重複加算できません`);
      occupied.add(s!.id);
      const allowed =
        stay.category === "meal"
          ? ["breakfast", "lunch", "dinner"]
          : stay.category === "cafe"
            ? ["cafe"]
            : stay.category === "rest"
              ? ["rest"]
              : ["activity", "evening"];
      if (
        !allowed.includes(s!.kind ?? "") ||
        /入店待|待機|行列|入場待/.test(s!.action)
      )
        issues.push(
          `${s!.id}: 待ちや移動を${stay.category}の滞在時間へ混ぜられません`,
        );
      if (
        s!.venueUrl &&
        p.venueUrl &&
        placeKey({ venueUrl: s!.venueUrl, label: "" }) !== placeKey(p)
      )
        issues.push(`${s!.id}: 滞在先の施設が手順と一致しません`);
    }
    const minutes = steps.reduce((n, s) => n + (s!.durationMinutes ?? 0), 0);
    const history = observations.filter(
      (o) =>
        o.kind === "dwell" &&
        o.basis === "user-observed" &&
        o.placeKey === placeKey(p) &&
        o.category === stay.category,
    );
    const d = prior[stay.category]!,
      min = Math.max(
        d[0],
        history.length
          ? q(
              history.map((o) => o.minutes),
              0.5,
            )
          : 0,
      );
    const range = history.length
      ? [
          q(
            history.map((o) => o.minutes),
            0.5,
          ),
          q(
            history.map((o) => o.minutes),
            0.8,
          ),
        ]
      : [d[1], d[2]];
    const key = placeKey(p);
    const first = Math.min(
      ...stay.stepIds.map((id) => plan.steps.findIndex((s) => s.id === id)),
    );
    const exits = plan.steps.slice(0, first).filter((s) => {
      const leg = state.legs.find((l) => l.stepId === s.id);
      if (!leg) return false;
      const from = places.get(leg.fromPlaceId),
        to = places.get(leg.toPlaceId);
      return from && to && placeKey(from) === key && placeKey(to) !== key;
    }).length;
    const groupKey =
      stay.category === "rest"
        ? `rest:${stay.id}`
        : `${key}:${stay.category}:${stay.category === "meal" ? steps[0]!.kind : ""}:${exits}`;
    const group = groups.get(groupKey);
    if (group) {
      group.minutes += minutes;
      if (group.place !== p.label && !group.place.includes("館内合計"))
        group.place += "ほか（館内合計）";
    } else {
      historySamples += history.length;
      groups.set(groupKey, {
        place: p.label,
        category: stay.category,
        minutes,
        minimumMinutes: min,
        suggestedRange: range,
        historySamples: history.length,
        basis: history.length
          ? `同施設・同カテゴリ・同ペースの申告実績${history.length}件（少数なら統計的確信とは扱わない）`
          : "カテゴリ別の初期計画仮定。過去の実測ではない",
      });
    }
  }
  for (const row of groups.values()) {
    stays.push(row);
    if (row.minutes < row.minimumMinutes)
      issues.push(
        `${row.place}の正味滞在${row.minutes}分は基準${row.minimumMinutes}分未満です。入場・待ち・移動を除いて体験時間を確保してください`,
      );
    if (row.minutes > row.suggestedRange[1]! + 30)
      warnings.push(
        `${row.place}: 滞在${row.minutes}分は参考上限${row.suggestedRange[1]}分より長めです。時間埋めでなく具体的な楽しみ方を確認してください`,
      );
  }
  for (const s of plan.steps)
    if (
      !["move", "return", "wait"].includes(s.kind ?? "") &&
      !/入店待|待機|行列|入場待/.test(s.action) &&
      !occupied.has(s.id)
    )
      issues.push(`${s.id}: 正味滞在としてstaysへ結び付けてください`);
  for (const l of state.legs)
    if (
      !plan.steps.some(
        (s) => s.id === l.stepId && ["move", "return"].includes(s.kind ?? ""),
      )
    )
      issues.push(`${l.stepId}: 移動以外または存在しない手順へのlegです`);
  // Follow the actual chain, rather than evaluating disconnected pairs independently.
  const at = new Map(
    state.stays.flatMap((stay) =>
      stay.stepIds.map((id) => [id, stay.placeId] as const),
    ),
  );
  let currentPlace: string | undefined;
  for (const s of plan.steps) {
    const leg = state.legs.find((l) => l.stepId === s.id);
    if (leg) {
      if (currentPlace && currentPlace !== leg.fromPlaceId)
        issues.push(
          `${s.id}: 前の到着・滞在地点と移動の出発地点がつながりません`,
        );
      currentPlace = leg.toPlaceId;
    } else if (at.has(s.id)) {
      if (currentPlace && currentPlace !== at.get(s.id))
        issues.push(`${s.id}: 移動なしに別の滞在先へ移っています`);
      currentPlace = at.get(s.id);
    }
  }
  for (const stay of state.stays) {
    const indexes = stay.stepIds
      .map((id) => plan.steps.findIndex((s) => s.id === id))
      .filter((n) => n >= 0);
    if (!indexes.length) continue;
    const between = plan.steps.slice(
      Math.min(...indexes),
      Math.max(...indexes) + 1,
    );
    if (
      between.some((s) => {
        const leg = state.legs.find((l) => l.stepId === s.id);
        return (
          leg &&
          places.has(leg.toPlaceId) &&
          places.has(stay.placeId) &&
          placeKey(places.get(leg.toPlaceId)!) !==
            placeKey(places.get(stay.placeId)!)
        );
      })
    )
      issues.push(
        `${stay.id}: 別の訪問へ出かけた滞在は分けてください。短い訪問を合算して最低時間を満たせません`,
      );
    if (
      stay.category === "meal" &&
      new Set(
        stay.stepIds.map((id) => plan.steps.find((s) => s.id === id)?.kind),
      ).size > 1
    )
      issues.push(
        `${stay.id}: 朝食・昼食・夕食は別の滞在枠として検査してください`,
      );
  }
  let continuous = 0,
    warned = false;
  for (const s of plan.steps) {
    const realBreak =
      ["rest", "cafe", "lunch", "dinner", "breakfast"].includes(s.kind ?? "") &&
      !/入店待|待機|行列|入場待/.test(s.action) &&
      (s.durationMinutes ?? 0) >= policy.restMinutes;
    if (realBreak) {
      continuous = 0;
      warned = false;
    } else continuous += s.durationMinutes ?? 0;
    if (continuous > policy.restAfterMinutes && !warned) {
      issues.push(
        `${s.id}: 休める枠なしで${continuous}分続きます。待ち行列を休憩に数えず${policy.restMinutes}分以上の休憩を挿入してください`,
      );
      warned = true;
    }
  }
  if (!observations.length)
    warnings.push(
      "参照できる同条件・期限内の実績はありません。過去に生成した計画を実績として学習していません",
    );
  return {
    ...base,
    status: issues.length ? ("needs_detail" as const) : ("passed" as const),
    issues,
    warnings,
    legs,
    stays,
    walkingMetersEstimate,
    walkingMinutes,
    historySamples,
  };
}
