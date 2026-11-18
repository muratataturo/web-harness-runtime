import { stepChecksSchema, verifyStepPlan } from "./step-verifier.js";
import { tripBrief, tripRhythmIssues } from "./trip-brief.js";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { assertEvidenceIntegrity } from "./provenance.js";
import type { Task, Answer } from "./types.js";
import { cafePlanIssues } from "./cafe.js";
import { uncoveredCriteria } from "./criteria.js";
const text = Type.String({ maxLength: 600 });
const ids = Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 });
export const actionPlanSchema = Type.Object(
  {
    stepChecks: Type.Optional(stepChecksSchema),
    verification: Type.Optional(
      Type.Object(
        {
          date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          checks: Type.Array(
            Type.Object(
              {
                kind: Type.Union([
                  Type.Literal("opening"),
                  Type.Literal("prices"),
                  Type.Literal("seating"),
                  Type.Literal("comparison"),
                  Type.Literal("rest"),
                ]),
                status: Type.Union([
                  Type.Literal("published"),
                  Type.Literal("arrival-check"),
                ]),
                detail: Type.String({ minLength: 12, maxLength: 500 }),
                evidenceIds: ids,
                stepIds: ids,
              },
              { additionalProperties: false },
            ),
            { minItems: 5, maxItems: 10 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    steps: Type.Array(
      Type.Object({
        id: Type.String({ maxLength: 100 }),
        kind: Type.Optional(
          Type.Union(
            [
              "activity",
              "breakfast",
              "lunch",
              "dinner",
              "cafe",
              "move",
              "rest",
              "evening",
              "return",
            ].map((s) => Type.Literal(s)),
          ),
        ),
        venueUrl: Type.Optional(Type.String({ maxLength: 2048 })),
        when: text,
        where: text,
        action: text,
        how: text,
        doneWhen: text,
        durationMinutes: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 1440 }),
        ),
        locationStatus: Type.Union([
          Type.Literal("evidence-linked"),
          Type.Literal("unconfirmed"),
        ]),
        evidenceIds: ids,
        costItemIds: ids,
      }),
      { maxItems: 32 },
    ),
    budget: Type.Optional(
      Type.Object({
        scenario: Type.Optional(text),
        items: Type.Array(
          Type.Object({
            id: Type.String({ maxLength: 100 }),
            label: text,
            quantity: Type.Number({ minimum: 0.01, maximum: 10000 }),
            unitYen: Type.Integer({ minimum: 0, maximum: 100000000 }),
            basis: Type.Union([
              Type.Literal("published"),
              Type.Literal("estimate"),
            ]),
            evidenceIds: ids,
          }),
          { maxItems: 30 },
        ),
        totalYen: Type.Integer({ minimum: 0, maximum: 1000000000 }),
      }),
    ),
    branches: Type.Array(
      Type.Object({ trigger: text, action: text, how: text, evidenceIds: ids }),
      { maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);
export type ActionPlan = Static<typeof actionPlanSchema>;
export interface SpecificityReview {
  version: 1;
  mode: "itinerary" | "next-actions" | "facts";
  status: "passed" | "needs_detail" | "not_required";
  issues: string[];
  attempts: { number: number; issues: string[] }[];
}
export function specificityContract(query: string) {
  const mode =
    /一日|1日|日帰り|お出かけ|行程|旅程|午後だけ|午後から|午後に|寄り道|itinerary|day trip|day out/i.test(
      query,
    ) ||
    (/旅行/.test(query) && /計画|過ご|スケジュール|回り|プラン/.test(query))
      ? ("itinerary" as const)
      : /行動計画|具体.{0,6}(?:手順|行動|計画)|決める順番|次に何|おすすめ|推奨案|action plan|next steps|recommend/i.test(
            query,
          )
        ? ("next-actions" as const)
        : ("facts" as const);
  const range = query.match(
    /([0-2]?\d[:：]\d{2})\s*[〜～~–-]\s*([0-2]?\d[:：]\d{2})/,
  );
  const cap = query.match(
    /(?:家族(?:合計|予算)?|予算|上限|合計)\s*([\d,]+)(万)?円(?:以内|以下)?/,
  );
  return {
    version: 1,
    mode,
    minimumSteps: mode === "itinerary" ? 4 : 2,
    timeRange: range
      ? [range[1]!.replace("：", ":"), range[2]!.replace("：", ":")]
      : tripBrief(query)?.timeRange,
    budgetRequired:
      mode !== "facts" && /予算|総額|合計.{0,15}円|費用/.test(query),
    ceilingYen: cap
      ? Number(cap[1]!.replaceAll(",", "")) * (cap[2] ? 10000 : 1)
      : undefined,
    branchesRequired: mode === "itinerary" ? 2 : 1,
    policy:
      "行動・場所・進め方・完了目安・切替条件を具体化する。移動は独立手順にし、10分を超える未説明の空白を残さない。予算のscenarioに対象案を明記する。時刻と徒歩時間は提案/見積、掲載価格と見積は区別。未確認の施設・商品・展示・空席を捏造しない。事実確認だけの質問に余分な行程を要求しない",
  };
}
const clock = (s: string) => {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60
    ? Number(m[1]) * 60 + Number(m[2])
    : -1;
};
const vague = (s: string) =>
  !s.trim() ||
  /^(?:適宜|周辺|園内|現地|どこか|後で|楽しむ|ゆっくり(?:する|過ごす)?|様子を見る|散策する|休憩する)[。！!\s]*$/.test(
    s.trim(),
  ) ||
  /(?:ここに記入|未記入|TODO)/i.test(s);
/** Validate saved references and arithmetic at every entry, including re-evaluation. */
export function validateActionPlan(task: Task, plan: ActionPlan) {
  if (!Value.Check(actionPlanSchema, plan))
    throw new Error("actionPlanの形式が不正です");
  const unique = (values: string[], what: string) => {
    if (values.some((v) => !v.trim()) || new Set(values).size !== values.length)
      throw new Error(`${what}のIDが空または重複しています`);
  };
  unique(
    plan.steps.map((s) => s.id),
    "手順",
  );
  unique(plan.budget?.items.map((i) => i.id) ?? [], "費用項目");
  for (const step of plan.steps) {
    for (const id of step.evidenceIds) assertEvidenceIntegrity(task, id);
    if (step.locationStatus === "evidence-linked" && !step.evidenceIds.length)
      throw new Error(`${step.id}: 確認した場所には根拠IDが必要です`);
    if (
      step.costItemIds.some(
        (id) => !plan.budget?.items.some((i) => i.id === id),
      )
    )
      throw new Error(`${step.id}: 不明な費用項目ID`);
  }
  for (const branch of plan.branches)
    for (const id of branch.evidenceIds) assertEvidenceIntegrity(task, id);
  if (plan.verification) {
    const v = plan.verification;
    if (new Date(v.date).toISOString().slice(0, 10) !== v.date)
      throw Error("対象日が不正です");
    for (const c of v.checks) {
      if (
        !c.evidenceIds.length ||
        !c.stepIds.length ||
        c.stepIds.some((id) => !plan.steps.some((s) => s.id === id))
      )
        throw Error("正式版の確認項目は引用と実際の手順へ結び付けてください");
      c.evidenceIds.forEach((id) => assertEvidenceIntegrity(task, id));
      if ((c.kind === "seating") !== (c.status === "arrival-check"))
        throw Error(
          "座席は到着時判断、それ以外の正式版の情報は公開根拠で確認してください。空席確約・予約完了にはできません",
        );
      if (
        c.kind === "seating" &&
        /空席あり|空席確約|座席確保|予約済|予約完了/.test(c.detail)
      )
        throw Error("公開情報から未来の空席・予約完了を断定できません");
    }
  }
  if (plan.budget) {
    for (const item of plan.budget.items) {
      if (item.basis === "published" && !item.evidenceIds.length)
        throw new Error(`${item.id}: 掲載料金には根拠IDが必要です`);
      for (const id of item.evidenceIds) assertEvidenceIntegrity(task, id);
      if (item.basis === "published") {
        const quotes = item.evidenceIds
          .map((id) =>
            assertEvidenceIntegrity(task, id).quote.normalize("NFKC"),
          )
          .join("\n");
        const amounts = [
          ...quotes.matchAll(/([\d,]+(?:\.\d+)?)\s*(万)?\s*円/g),
          ...quotes.matchAll(/¥\s*([\d,]+(?:\.\d+)?)(万)?/g),
        ].map((m) => Number(m[1]!.replaceAll(",", "")) * (m[2] ? 10000 : 1));
        // Japanese menu PDFs commonly omit 円 beside each displayed price.
        // Accept stand-alone numeric price lines only in a captured PDF; the
        // item and tax interpretation still need to be described and cited.
        for (const id of item.evidenceIds) {
          const ev = assertEvidenceIntegrity(task, id);
          if (
            task.pages.find((p) => p.id === ev.pageId)?.acquisition?.kind ===
            "public-pdf"
          ) {
            for (const line of ev.quote.normalize("NFKC").split("\n"))
              if (/^\s*[+＋]?\s*\d[\d,\s/]*$/.test(line))
                amounts.push(
                  ...[...line.matchAll(/[\d,]+/g)].map((m) =>
                    Number(m[0].replaceAll(",", "")),
                  ),
                );
          }
        }
        if (
          !amounts.includes(item.unitYen) &&
          !(item.unitYen === 0 && /無料|無償/.test(quotes))
        )
          throw new Error(
            `${item.id}: 掲載単価${item.unitYen}円が根拠引用で確認できません。単価の引用を追加するか未確認の見積と区別してください`,
          );
      }
    }
    const total = Math.round(
      plan.budget.items.reduce((n, i) => n + i.quantity * i.unitYen, 0),
    );
    if (total !== plan.budget.totalYen)
      throw new Error(
        `予算の合算が不一致です。内訳の合計は${total}円、提示は${plan.budget.totalYen}円`,
      );
  }
}
/** This is an executable specificity contract, not a proof of natural-language entailment. */
export function assessSpecificity(
  task: Task,
  answer: Answer,
): Omit<SpecificityReview, "attempts"> {
  const c = specificityContract(task.query),
    issues: string[] = [];
  if (
    task.evaluation ||
    c.mode === "facts" ||
    (!answer.candidates.length && !answer.actionPlan)
  )
    return { version: 1, mode: c.mode, status: "not_required", issues };
  const p = answer.actionPlan;
  if (!p)
    return {
      version: 1,
      mode: c.mode,
      status: "needs_detail",
      issues: [
        "行動手順actionPlanがありません。説明だけでなく、いつ・どこで・何を・どう進め・何ができれば終わりかを構造化してください",
      ],
    };
  validateActionPlan(task, p);
  if (task.tripBrief?.requiresStepResearch || p.stepChecks?.length)
    issues.push(
      ...verifyStepPlan(task, p)
        .checks.filter((c) => c.status === "failed" || c.status === "unknown")
        .map((c) => `${c.stepId}: ${c.detail}`),
    );
  issues.push(
    ...uncoveredCriteria(task.criteria, answer.candidates).map(
      (c) => `必須条件の対象候補が不足しています: ${c.description}`,
    ),
  );
  if (c.mode === "itinerary" && /正式|確定版|暫定.{0,8}解消/.test(task.query)) {
    const v = p.verification;
    for (const kind of ["opening", "prices", "seating", "comparison", "rest"])
      if (!v?.checks.some((c) => c.kind === kind))
        issues.push(
          `正式版にはverification.checksの${kind}（営業時間・掲載価格・席の利用方法・候補比較・具体的な休憩所）が必要です`,
        );
    const date = task.query.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    if (
      date &&
      v &&
      v.date !==
        `${date[1]}-${date[2]!.padStart(2, "0")}-${date[3]!.padStart(2, "0")}`
    )
      issues.push("確認項目の対象日が相談日程と一致しません");
    if (p.budget?.items.some((i) => i.basis !== "published"))
      issues.push(
        "正式版の主案は選ぶ商品と掲載単価を確認し、未確認の見積枠を残さないでください。移動時間などの提案とは区別してください",
      );
    if (!answer.candidates.length)
      issues.push("正式版の候補比較を省略できません");
  }
  if (c.mode === "itinerary")
    issues.push(
      ...cafePlanIssues(task, answer),
      ...(task.tripBrief ? tripRhythmIssues(task.query, p) : []),
    );
  if (p.steps.length < c.minimumSteps)
    issues.push(`具体的な手順を${c.minimumSteps}件以上にしてください`);
  for (const [i, s] of p.steps.entries()) {
    for (const field of ["when", "where", "action", "how", "doneWhen"] as const)
      if (vague(s[field]))
        issues.push(
          `${s.id}.${field}: 抽象的です。実際に行う操作・場所・判断可能な目安を書いてください`,
        );
    if (s.how.trim().length < 6)
      issues.push(`${s.id}.how: 進め方を一段具体化してください`);
    if (
      s.locationStatus === "unconfirmed" &&
      !p.branches.some((b) =>
        /場所|見つから|確認|閉|利用|入れ|座|席|休憩|できない|不可/.test(
          b.trigger,
        ),
      )
    )
      issues.push(`${s.id}: 未確認の場所が使えない場合の切替条件がありません`);
    if (c.mode === "itinerary") {
      const start = clock(s.when),
        prev = p.steps[i - 1];
      if (start < 0 || !s.durationMinutes)
        issues.push(`${s.id}: HH:MMの開始時刻と所要分数が必要です`);
      if (
        prev &&
        clock(prev.when) >= 0 &&
        start >= 0 &&
        clock(prev.when) + (prev.durationMinutes ?? 0) > start
      )
        issues.push(
          `${s.id}: 前の手順と時刻が重なっています。移動時間も別の手順として確保してください`,
        );
      if (
        prev &&
        start >= 0 &&
        clock(prev.when) >= 0 &&
        start - (clock(prev.when) + (prev.durationMinutes ?? 0)) > 10
      )
        issues.push(
          `${s.id}: 前の手順後に10分を超える未説明の空白があります。観察・移動・待機など実際に行う手順を別にしてください`,
        );
      if (
        start >= 0 &&
        [...s.how.matchAll(/(\d{1,2}:\d{2})/g)].some(
          (m) =>
            clock(m[1]!) >= 0 &&
            (clock(m[1]!) < start ||
              clock(m[1]!) > start + (s.durationMinutes ?? 0)),
        )
      )
        issues.push(
          `${s.id}: 説明に手順の時間枠外の行動があります。退園・徒歩・帰路を独立した手順にしてください`,
        );
    }
  }
  if (c.mode === "itinerary" && c.timeRange && p.steps.length) {
    const [from, to] = c.timeRange.map(clock),
      first = p.steps[0]!,
      last = p.steps.at(-1)!;
    if (clock(first.when) !== from)
      issues.push(`集合/開始は指定の${c.timeRange[0]}から具体化してください`);
    if (clock(last.when) + (last.durationMinutes ?? 0) > to!)
      issues.push(`指定終了${c.timeRange[1]}を越えています`);
  }
  if (c.budgetRequired && (!p.budget || !p.budget.items.length))
    issues.push(
      "人数×単価の内訳、掲載料金/見積の区別、家族全体の合計を示してください",
    );
  if (p.budget && !p.budget.scenario?.trim())
    issues.push(
      "予算がどの案に対するものかscenarioに明示してください。任意の追加案の費用を主案と混同しないでください",
    );
  if (p.branches.length < c.branchesRequired)
    issues.push(
      `切替条件と、その時に行う具体的な代替行動を${c.branchesRequired}件以上にしてください`,
    );
  for (const b of p.branches)
    if (
      vague(b.trigger) ||
      vague(b.action) ||
      vague(b.how) ||
      b.how.trim().length < 6
    )
      issues.push(
        "分岐の条件・行動・進め方を具体化してください。『雨なら代替』『疲れたら休憩』だけでは不足です",
      );
  return {
    version: 1,
    mode: c.mode,
    status: issues.length ? "needs_detail" : "passed",
    issues,
  };
}
export function renderActionPlan(task: Task, plan: ActionPlan) {
  const c = specificityContract(task.query),
    refs = (ids: string[]) => ids.map((id) => `[${id}]`).join("");
  const lines = [
    "",
    "## 具体的な実行手順（時刻・行動は提案）",
    ...plan.steps.map(
      (s) =>
        `${s.when} ${s.where} — ${s.action}${s.durationMinutes ? `（${s.durationMinutes}分の見積）` : ""}。${s.how} 完了の目安：${s.doneWhen}。${s.locationStatus === "unconfirmed" ? "場所の詳細は未確認。" : ""}${refs(s.evidenceIds)}`,
    ),
  ];
  if (plan.budget) {
    lines.push(
      "",
      `## 予算（${plan.budget.scenario?.replaceAll("\n", " ") ?? "対象案は未確認"}・掲載料金と未確認の見積）`,
      "| 内訳 | 人数・数量 | 単価 | 小計 | 区分 |",
      "| --- | ---: | ---: | ---: | --- |",
      ...plan.budget.items.map(
        (i) =>
          `| ${i.label.replaceAll("|", "／")} | ${i.quantity} | ${i.unitYen.toLocaleString()}円 | ${Math.round(i.quantity * i.unitYen).toLocaleString()}円 | ${i.basis === "published" ? "掲載額" : "未確認の見積"}${refs(i.evidenceIds)} |`,
      ),
      `合計${plan.budget.totalYen.toLocaleString()}円。${c.ceilingYen !== undefined ? `指定上限${c.ceilingYen.toLocaleString()}円との差額${(c.ceilingYen - plan.budget.totalYen).toLocaleString()}円。` : ""}見積を含み、実際の支払額を保証しません。`,
    );
  }
  lines.push(
    "",
    "## 状況が変わった時の行動",
    ...plan.branches.map(
      (b) => `- ${b.trigger} → ${b.action}。${b.how}${refs(b.evidenceIds)}`,
    ),
  );
  return lines.join("\n");
}
