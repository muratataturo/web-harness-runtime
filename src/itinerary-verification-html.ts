import { criterionApplies } from "./criteria.js";
import { escapeHtml as esc, safeLink } from "../web/presentation.js";
import type { Task } from "./types.js";
const labels = {
  opening: "営業予定",
  prices: "注文と掲載価格",
  seating: "席の利用方法",
  comparison: "候補の選び方",
  rest: "休憩場所",
};
export function renderItineraryVerification(
  task: Task,
  refs: (ids: string[]) => string,
) {
  const plan = task.answer?.actionPlan,
    v = plan?.verification;
  if (!v) return "";
  const checks = v.checks
    .map(
      (c) =>
        `<article class="branch"><span class="tag ${c.status === "published" ? "published" : "estimate"}">${c.status === "published" ? "公開情報を確認" : "利用方法を確認・席は到着時に判断"}</span><h3>${labels[c.kind]}</h3><p>${esc(c.detail)}</p><div class="refs">${refs(c.evidenceIds)}</div><p>${c.stepIds.map((id) => `<a href="#step-${plan.steps.findIndex((s) => s.id === id)}">${esc(plan.steps.find((s) => s.id === id)!.when)}の手順 ↗</a>`).join(" · ")}</p></article>`,
    )
    .join("");
  const rows = task
    .answer!.candidates.map((candidate) => {
      const matched = candidate.matches.filter((m) => {
        const c = task.criteria.find((c) => c.id === m.criterionId);
        return c && criterionApplies(c, candidate.url);
      });
      const href = safeLink(candidate.url);
      return `<tr><td><strong>${esc(candidate.name)}</strong><p>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">公式情報 ↗</a>` : ""}</p><span class="tag ${candidate.eligible ? "published" : "estimate"}">${candidate.eligible ? "対象条件を確認" : "未解消の条件あり"}</span></td><td>${matched.map((m) => `<p><strong>${m.status === "supported" ? "確認" : m.status === "contradicted" ? "不一致" : "未確認"}</strong> ${esc(m.explanation)} ${refs(m.evidenceIds)}</p>`).join("")}</td></tr>`;
    })
    .join("");
  return `<section id="verification" class="section"><span class="eyebrow">READY FOR YOUR DAY</span><h2>調べたことを、当日の安心へ。</h2><p class="section-note">対象日 ${esc(v.date)}。公開された予定・掲載価格・利用条件を確認した行程です。予約や未来の空席を確約するものではありません。</p><div class="branches">${checks}</div></section><section id="candidate-comparison" class="section"><span class="eyebrow">WHY THESE PLACES</span><h2>調べた候補と、選ぶ理由。</h2><p class="section-note">施設・店舗ごとの役割に応じた条件を確認しています。人気や満足度の順位ではありません。</p><div class="table-wrap"><table><thead><tr><th>施設・店舗</th><th>確認した条件と出典</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
