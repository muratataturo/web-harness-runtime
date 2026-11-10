import { entityKey } from "./sources.js";
import { assessPage } from "./page-quality.js";
import type {
  Answer,
  Candidate,
  Criterion,
  Evidence,
  Match,
  Page,
  Task,
} from "./types.js";
export const normalized = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, " ").trim();
export function addEvidence(
  task: Task,
  pageId: string,
  quote: string,
): Evidence {
  const page = task.pages.find((p) => p.id === pageId);
  if (!page) throw new Error("閲覧済み pageId が必要です");
  if (
    normalized(quote).length < 6 ||
    quote.length > 1200 ||
    !normalized(page.text).includes(normalized(quote))
  ) {
    const text = normalized(page.text);
    const tokens =
      normalized(quote).match(
        /(?:[0-9][0-9,.]*円|[\p{Script=Han}\p{Script=Katakana}ー]{3,})/gu,
      ) ?? [];
    const hints = [...new Set(tokens)]
      .map((token) => text.indexOf(token))
      .filter((index) => index >= 0)
      .slice(0, 2)
      .map((index) => text.slice(Math.max(0, index - 45), index + 160));
    throw new Error(
      "引用は取得ページに実在する 6〜1200 文字の連続した本文を指定してください。離れた箇所を連結したり省略記号を補わず、pageIdも確認してください。" +
        (hints.length ? ` 取得本文の該当箇所: ${JSON.stringify(hints)}` : ""),
    );
  }
  const existing = task.evidence.find(
    (e) => e.pageId === pageId && e.quote === quote,
  );
  if (existing) return existing;
  const evidence = {
    id: `ev-${task.evidence.length + 1}`,
    pageId,
    url: page.url,
    quote,
    capturedAt: page.capturedAt,
  };
  task.evidence.push(evidence);
  return evidence;
}
export function setCriteria(task: Task, criteria: Criterion[]) {
  if (task.evidence.length || task.answer)
    throw new Error("根拠収集後は評価条件を変更できません");
  if (
    !criteria.length ||
    criteria.length > 12 ||
    new Set(criteria.map((c) => c.id)).size !== criteria.length
  )
    throw new Error("評価条件は重複のない 1〜12 件にしてください");
  if (
    criteria.some(
      (c) =>
        !c.id ||
        !c.description.trim() ||
        !Number.isFinite(c.weight) ||
        c.weight < 1 ||
        c.weight > 10,
    )
  )
    throw new Error("評価条件の説明と 1〜10 の重みが必要です");
  task.criteria = criteria;
}
export function validateAnswer(
  task: Task,
  summary: string,
  input: Omit<Candidate, "score" | "eligible">[],
  limitations: string[],
): Answer {
  if (!task.criteria.length)
    throw new Error("先に plan_task で条件を定義してください");
  if (!summary.trim()) throw new Error("回答の要約が必要です");
  if (
    input.length > 10 ||
    new Set(input.map((c) => c.url)).size !== input.length
  )
    throw new Error("候補は URL が重複しない最大 10 件です");
  const candidates = input
    .map((c) => ({
      ...c,
      matches: c.matches.map((m) => ({
        ...m,
        evidenceIds: [...m.evidenceIds],
      })),
    }))
    .map((candidate) => {
      if (!candidate.name.trim()) throw new Error("候補名が必要です");
      const key = entityKey(candidate.url);
      if (!key)
        throw new Error(
          "候補には一覧・検索ページではなく個別店舗・宿・車両・物件・求人のURLが必要です",
        );
      const detail = task.pages.find((p) => p.url === candidate.url);
      if (!detail)
        throw new Error(
          `候補 URL は閲覧済みのページが必要です: ${candidate.url}`,
        );
      if (assessPage(detail).shouldStop)
        throw new Error(
          "アクセス制限・メンテナンス・本文不足のページを候補にできません",
        );
      if (input.filter((c) => entityKey(c.url) === key).length > 1)
        throw new Error("同じ候補の別URLを重複候補にできません");
      if (
        candidate.matches.length !== task.criteria.length ||
        new Set(candidate.matches.map((m) => m.criterionId)).size !==
          task.criteria.length
      )
        throw new Error("候補ごとにすべての評価条件を一度ずつ評価してください");
      for (const m of candidate.matches) {
        if (!task.criteria.some((c) => c.id === m.criterionId))
          throw new Error("不明な評価条件");
        if (!m.explanation.trim())
          throw new Error("各条件の判定理由が必要です");
        if (!["supported", "unknown", "contradicted"].includes(m.status))
          throw new Error("不正な判定");
        if (m.status !== "unknown" && !m.evidenceIds.length)
          throw new Error("確認済み・不一致の判定には根拠 ID が必要です");
        if (m.evidenceIds.some((id) => !task.evidence.some((e) => e.id === id)))
          throw new Error("不明な根拠 ID");
        // Evidence must come from this candidate's detail hierarchy (coupons, reviews, styles).
        for (const id of m.evidenceIds) {
          const evidence = task.evidence.find((e) => e.id === id)!;
          if (
            !sameEntity(
              detail,
              task.pages.find((p) => p.id === evidence.pageId)!,
            )
          )
            throw new Error(`別候補の根拠を流用できません: ${id}`);
        }
      }
      for (const m of candidate.matches) {
        const criterion = task.criteria.find((c) => c.id === m.criterionId)!;
        if (
          m.status === "supported" &&
          /アイドル/.test(task.query) &&
          /アイドル/.test(criterion.description) &&
          !m.evidenceIds.some((id) =>
            /アイドル/.test(task.evidence.find((e) => e.id === id)!.quote),
          )
        ) {
          m.status = "unknown";
          m.explanation =
            "引用にアイドル風への対応を示す記載がなく、一般的な韓国風だけでは確認できません。" +
            m.explanation;
        }
      }
      if (key.startsWith("suumo:"))
        for (const match of candidate.matches) {
          const criterion = task.criteria.find(
            (c) => c.id === match.criterionId,
          )!;
          const body = task.pages
            .filter((p) => entityKey(p.url) === key)
            .map((p) => p.text)
            .join("\n");
          const quotes = match.evidenceIds
            .map((id) => task.evidence.find((e) => e.id === id)!.quote)
            .join("\n");
          if (
            match.status === "supported" &&
            /合計|月額|予算|管理費/.test(criterion.description) &&
            /管理費(?:・共益費)?[：:\s]*[-−―ー](?:\s|$)/.test(body) &&
            !/管理費(?:・共益費)?[：:\s]*(?:[\d,]+円|なし|無し|不要)/.test(
              quotes,
            )
          ) {
            match.status = "unknown";
            match.explanation =
              "管理費「-」を0円と確定できず、合計月額は未確認。" +
              match.explanation;
          }
        }
      const weight = task.criteria.reduce((sum, c) => sum + c.weight, 0);
      const score = Math.round(
        (100 *
          task.criteria.reduce(
            (sum, c) =>
              sum +
              (candidate.matches.find((m) => m.criterionId === c.id)?.status ===
              "supported"
                ? c.weight
                : 0),
            0,
          )) /
          weight,
      );
      const eligible = task.criteria
        .filter((c) => c.required)
        .every(
          (c) =>
            candidate.matches.find((m) => m.criterionId === c.id)?.status ===
            "supported",
        );
      return { ...candidate, score, eligible };
    })
    .sort(
      (a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score,
    );
  return { summary, candidates, limitations };
}
function sameEntity(a: Page, b: Page) {
  const x = entityKey(a.url),
    y = entityKey(b.url);
  return !!x && x === y;
}

export function renderAnswer(task: Task): string {
  const answer = task.answer;
  if (!answer)
    return `タスク ${task.id}: ${task.status}\n${task.error ?? "回答はまだありません。"}`;
  const lines = [
    answer.summary,
    "",
    `状態: ${task.status} / 詳細取得: ${task.retrieval?.status ?? "未検証"}`,
    `${task.evaluation ? "凍結ベンチマーク実行日時（ライブ取得ではありません）" : "調査日時"}: ${task.updatedAt} / モデル: ${task.model}`,
    "",
  ];
  for (const [i, c] of answer.candidates.entries()) {
    lines.push(
      `${i + 1}. ${c.name} — 条件確認率 ${c.score}%${c.eligible ? "" : "（必須条件に未確認・不一致あり）"}`,
      c.url,
    );
    for (const m of c.matches) {
      const label = task.criteria.find(
        (c) => c.id === m.criterionId,
      )?.description;
      lines.push(
        `   ${m.status === "supported" ? "○" : m.status === "contradicted" ? "×" : "?"} ${label}: ${m.explanation}`,
      );
      for (const id of m.evidenceIds) {
        const e = task.evidence.find((e) => e.id === id)!;
        lines.push(`     [${id}] 「${e.quote}」 ${e.url}`);
      }
    }
    lines.push("");
  }
  if (!answer.candidates.length)
    lines.push("条件を確認できる候補が見つかりませんでした。");
  if (answer.limitations.length)
    lines.push(
      "確認できなかった点:",
      ...answer.limitations.map((l) => `- ${l.replace(/^[-*]\s+/, "")}`),
    );
  return lines.join("\n");
}
