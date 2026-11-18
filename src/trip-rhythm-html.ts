import type { Task } from "./types.js";
import { verifyStepPlan } from "./step-verifier.js";
import { escapeHtml as esc } from "../web/presentation.js";

export function renderTripRhythm(task: Task, refs: (ids: string[]) => string) {
  const b = task.tripBrief,
    p = task.answer?.actionPlan;
  if (!b?.requiresStepResearch || !p) return "";
  const report = verifyStepPlan(task, p);
  const labels = {
    "full-day": "朝から夜まで、一日を楽しむ",
    afternoon: "午後だけ、気軽に出かける",
    short: "ひと息つく、短い寄り道",
    flexible: "気分に合わせた過ごし方",
    custom: "指定時間で楽しむ",
  };
  const kinds: Record<string, string> = {
    activity: "体験",
    breakfast: "朝食",
    lunch: "昼食",
    dinner: "夕食",
    cafe: "カフェ",
    rest: "休憩",
    evening: "夜の楽しみ",
    move: "移動",
    return: "帰路",
  };
  const groups =
    b.mode === "full-day"
      ? ([
          ["MORNING", "午前", 0, 12],
          ["AFTERNOON", "午後", 12, 17],
          ["EVENING", "夕方から夜", 17, 24],
        ] as const)
      : ([["YOUR PACE", "この時間の楽しみ方", 0, 24]] as const);
  const chapters = groups
    .map(([en, title, from, to]) => {
      const steps = p.steps.filter(
        (s) =>
          +s.when.split(":")[0]! >= from &&
          +s.when.split(":")[0]! < to &&
          [
            "activity",
            "breakfast",
            "lunch",
            "dinner",
            "cafe",
            "evening",
          ].includes(s.kind ?? ""),
      );
      return `<article class="branch"><span class="eyebrow">${en}</span><h3>${title}</h3>${steps.map((s) => `<p class="rhythm-step"><a href="#step-${p.steps.indexOf(s)}"><strong>${esc(s.when)} · ${esc(kinds[s.kind ?? ""] ?? "過ごし方")}</strong></a><br>${esc(s.where)}<br>${esc(s.action)}</p>`).join("") || "<p>体験枠が未構成です</p>"}</article>`;
    })
    .join("");
  const statuses = {
    passed: "引用と照合",
    unknown: "未確認",
    failed: "要修正",
    "arrival-check": "当日判断",
    proposal: "移動の見積",
  };
  return `<style>#day-rhythm .rhythm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}#day-rhythm .rhythm-grid.single{grid-template-columns:1fr}#day-rhythm .rhythm-step{margin:16px 0;line-height:1.65;font-size:14px}#day-rhythm .rhythm-grid .branch{padding:22px}#day-rhythm details{margin-top:20px}#day-rhythm summary{cursor:pointer}@media(max-width:700px){#day-rhythm .rhythm-grid{grid-template-columns:1fr}#day-rhythm .rhythm-grid .branch{padding:18px}}</style><section id="day-rhythm" class="section"><span class="eyebrow">A DAY AT YOUR PACE</span><h2>${labels[b.mode]}</h2><p class="section-note">${esc(b.timeRange?.join(" → ") ?? "")} · ${b.pacing === "relaxed" ? "ゆっくり、余白を大切に" : b.pacing === "active" ? "体験をしっかり楽しむ" : "体験と休憩をバランスよく"}。${esc(b.assumptions.join(" "))}</p><p class="section-note">時間帯ごとの主な楽しみ方。移動・待ち時間・休憩は、この下の全行程で確認できます。</p><div class="rhythm-grid ${groups.length === 1 ? "single" : ""}">${chapters}</div><details><summary>手順ごとの確認を見る · 未確認 ${report.unknown}件／要修正 ${report.failed}件</summary><p class="section-note">施設と引用の対応、掲載された営業時間の数値枠を照合します。曜日・臨時休業の意味解釈や当日の提供を保証する検査ではありません。</p><div class="branches">${report.checks.map((c) => `<article class="branch"><span class="tag ${c.status === "passed" ? "published" : "estimate"}">${statuses[c.status]}</span><h3>${esc(p.steps.find((s) => s.id === c.stepId)?.where ?? c.stepId)}</h3><p>${esc(c.detail)}</p><div class="refs">${refs(c.evidenceIds)}</div></article>`).join("")}</div></details></section>`;
}
