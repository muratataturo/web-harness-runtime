import type { Task } from "./types.js";
import { assessJourneyState } from "./journey-state.js";
import { escapeHtml as esc } from "../web/presentation.js";
export function renderJourneyState(task: Task) {
  if (!task.journeyPolicy || !task.answer?.actionPlan) return "";
  const plan = task.answer.actionPlan,
    r = assessJourneyState(task, plan);
  const sum = (kinds: string[]) =>
    plan.steps
      .filter(
        (s) =>
          kinds.includes(s.kind ?? "") &&
          !/入店待|待機|行列|入場待/.test(s.action),
      )
      .reduce((n, s) => n + (s.durationMinutes ?? 0), 0);
  const segments = [
    ["体験", sum(["activity", "evening"])],
    ["食事・カフェ", sum(["breakfast", "lunch", "dinner", "cafe"])],
    ["休憩", sum(["rest"])],
    ["移動", sum(["move", "return"])],
    [
      "待ち",
      plan.steps
        .filter(
          (s) => s.kind === "wait" || /入店待|待機|行列|入場待/.test(s.action),
        )
        .reduce((n, s) => n + (s.durationMinutes ?? 0), 0),
    ],
  ] as [string, number][];
  const colors = ["#28634f", "#8b531c", "#526379", "#28718a", "#746273"];
  const total = segments.reduce((n, s) => n + s[1], 0);
  const missing = r.legs.filter(
    (l) => l.mode === "walk" && l.estimatedMeters === undefined,
  ).length;
  return `<section id="journey-state" class="section"><span class="eyebrow">DISTANCE · TIME · YOUR PACE</span><h2>移動にも、楽しむ時間にも、余裕を。</h2><p class="section-note">算出できた徒歩区間の距離見積 <strong>${(r.walkingMetersEstimate / 1000).toFixed(1)}km</strong> · 徒歩本体 ${r.walkingMinutes}分 · 未算出の徒歩区間 ${missing}件。道路距離・当日の所要時間を確認した値ではありません。</p><div style="display:flex;height:12px;border-radius:8px;overflow:hidden" aria-hidden="true">${segments.map((s, i) => `<span style="width:${total ? (s[1] / total) * 100 : 0}%;background:${colors[i]}"></span>`).join("")}</div><p>${segments.map((s) => `${s[0]} ${s[1]}分`).join(" · ")}</p><p class="section-note">${r.historySamples ? `同条件の申告実績・経路見積 ${r.historySamples}件を参照。日付・方向・移動手段・ペースを照合します。` : "参照できる同条件の実績はありません。初期の歩速・迂回係数・滞在時間を使った見積で、過去の生成案を実績に数えていません。"}</p><details><summary>区間の距離・時間と、滞在の根拠を見る${r.issues.length ? ` · 要調整 ${r.issues.length}件` : ""}</summary>${r.issues.length ? `<ul>${r.issues.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}<div class="table-wrap"><table><thead><tr><th>移動区間</th><th>距離と時間</th><th>見積の根拠</th></tr></thead><tbody>${r.legs.map((l) => `<tr><td>${esc(l.from)} → ${esc(l.to)}<br>${esc({ walk: "徒歩", indoor: "館内", transit: "公共交通", car: "車" }[l.mode] ?? l.mode)}</td><td>${l.estimatedMeters === undefined ? "距離未算出" : `推定 ${(l.estimatedMeters / 1000).toFixed(2)}km`}${l.straightLineMeters === undefined ? "" : `<br>直線 ${(l.straightLineMeters / 1000).toFixed(2)}km`}<br>確保 ${l.allocatedMinutes}分（待ち・乗降・余裕を含む）</td><td>${esc(l.basis)}</td></tr>`).join("")}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>滞在</th><th>正味の体験時間</th><th>参考時間と根拠</th></tr></thead><tbody>${r.stays.map((s) => `<tr><td>${esc(s.place)}</td><td>${s.minutes}分</td><td>参考 ${s.suggestedRange.join("〜")}分<br>${esc(s.basis)}</td></tr>`).join("")}</tbody></table></div>${r.warnings.map((w) => `<p class="section-note">${esc(w)}</p>`).join("")}</details></section>`;
}
