import type { Task } from "./types.js";
import { verifyStepPlan } from "./step-verifier.js";
import { entityKey } from "./sources.js";
import { escapeHtml as esc } from "../web/presentation.js";
export function renderReviewPerspectives(task: Task) {
  const plan = task.answer?.actionPlan,
    context = task.reviewContext;
  if (!plan || !context?.perspectives.length) return "";
  const checks = verifyStepPlan(task, plan);
  const rows = plan.steps
    .filter((s) => s.kind === "rest")
    .map((s) => {
      const relevant = checks.checks.filter((c) => c.stepId === s.id);
      const ready =
        relevant.some((c) => c.kind === "opening" && c.status === "passed") &&
        relevant.some((c) => c.kind === "fact" && c.status === "passed") &&
        !relevant.some((c) => ["unknown", "failed"].includes(c.status));
      const opening = plan.stepChecks?.find(
        (c) => c.stepId === s.id && c.kind === "opening",
      );
      const hours = ready
        ? opening?.access === "always-open"
          ? "24時間開放の案内"
          : `${opening?.opens}〜${opening?.closes}`
        : "要確認";
      return { step: s, ready, hours };
    });
  const used = new Set(
    plan.steps
      .filter((s) => !["move", "return", "wait"].includes(s.kind ?? ""))
      .map((s) => (s.venueUrl ? entityKey(s.venueUrl) : undefined)),
  );
  const excluded = task.answer!.candidates.filter(
    (c) => !c.eligible && !used.has(entityKey(c.url)),
  );
  const unresolved = excluded.flatMap((c) =>
    c.matches.filter((m) => m.status === "unknown"),
  );
  const pending = rows.filter((r) => !r.ready).length;
  return `<section id="review-perspectives" class="section"><span class="eyebrow">CHECK · REFLECT · NEXT TIME</span><h2>${pending ? "休憩の確認を、もう一度。" : "休む場所まで、確認する。"}</h2><p>採用した休憩 ${rows.length}手順 · 場所の引用・利用時間の検査 ${rows.length - pending}件通過 · 未確認 ${pending}件。</p><p class="section-note">公開案内と宣言した検査の照合結果です。当日の空席・継続着席・臨時規制は別途確認してください。${unresolved.length ? `不採用候補には未確認が${unresolved.length}項目残っています。採用した休憩の未確認と分けて表示しています。` : ""}</p><details><summary>休憩場所と利用時間の検査を見る</summary><div class="table-wrap"><table><thead><tr><th>時刻・場所</th><th>引用の利用時間</th><th>場所の引用</th></tr></thead><tbody>${rows.map((r) => `<tr><td><a href="#step-${esc(r.step.id)}">${esc(r.step.when)} · ${esc(r.step.where)}</a></td><td>${esc(r.hours)}</td><td>${r.ready ? "場所の引用・利用時間を照合" : "要確認"}</td></tr>`).join("")}</tbody></table></div></details><details><summary>次回にも引き継ぐ${context.perspectives.length}つの確認観点</summary><ul>${context.perspectives.map((p) => `<li><strong>${esc(p.question)}</strong><p>${esc(p.action)}</p></li>`).join("")}</ul><p class="section-note">観点と検査結果を保存し、次回の生成で参照します。営業時間はその都度調べ直します。魅力が伝わるかは、人が見て確かめる観点として残します。</p></details></section>`;
}
