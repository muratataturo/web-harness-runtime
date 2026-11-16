import type { Task } from "./types.js";
import { escapeHtml as esc, safeLink } from "../web/presentation.js";
export function renderDiscoveries(task: Task, refs: (ids: string[]) => string) {
  const artifact = task.answer?.visualArtifact,
    items = artifact?.discoveries;
  if (!artifact || !items?.length) return "";
  const unavailable = (task.socialResearch ?? []).some(
    (a) => a.status === "unavailable",
  );
  return `<section class="discovery-section section" id="discoveries"><div class="section-heading"><div><span class="eyebrow">A DIFFERENT WAY TO SPEND THE DAY</span><h2>いつもの場所に、ひとつ発見。</h2></div><span class="discovery-spark" aria-hidden="true">✧</span></div><p class="section-note">定番に添える、理由のある楽しみ方。元の行程と予算の中で選べる提案です。</p>${unavailable ? '<p class="social-unavailable">SNSの公開投稿・反応数を検証できない参照先がありました。人気の断定はせず、確認できた公式情報と独自の提案を分けています。</p>' : ""}<div class="discovery-grid">${items
    .map((d, index) => {
      const signal = task.socialSignals?.find((s) => s.id === d.signalId),
        label =
          d.basis === "official-event"
            ? "公式の期間限定情報"
            : d.basis === "social-snapshot"
              ? "公開投稿の反応を参考"
              : "独自の楽しみ方・提案";
      const anchor =
        artifact.kind === "journey-map"
          ? artifact.stops.find((s) => s.id === d.anchorId)?.label
          : artifact.milestones.find((m) => m.id === d.anchorId)?.title;
      const metric = signal
        ? Object.entries(signal.metrics)
            .filter(([, v]) => v !== null)
            .map(
              ([k, v]) =>
                `${{ likes: "いいね", reposts: "再投稿", replies: "返信" }[k]} ${v!.toLocaleString("ja-JP")}`,
            )
            .join(" · ")
        : "";
      const source = signal && safeLink(signal.url);
      return `<article class="discovery-card"><div class="discovery-kicker"><span>${String(index + 1).padStart(2, "0")} / ${esc(label)}</span><span>${esc(anchor ?? "")}</span></div><h3>${esc(d.headline)}</h3><p class="discovery-idea">${esc(d.idea)}</p><div class="discovery-reason"><span>選ぶ理由</span><p>${esc(d.whyNow)}</p></div>${d.basis === "official-event" ? `<p class="discovery-window">掲載期間 ${esc(d.validFrom!)} – ${esc(d.validTo!)}<br><small>期間内に訪れる場合だけ。提供・営業は出発前に再確認。</small></p>` : ""}${signal ? `<div class="social-snapshot"><strong>${esc(metric)}</strong><span>投稿 ${esc(signal.publishedAt.slice(0, 10))} / 取得 ${esc(signal.observedAt)}</span><span>単一投稿の取得時点の反応です。増加率やSNS全体の人気ではありません。</span>${source ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">公開投稿を見る ↗</a>` : ""}</div>` : ""}<div class="discovery-fit"><span>行程への入れ方</span><p>${esc(d.fit)}</p><span>使えないときは</span><p>${esc(d.fallback)}</p></div><div class="discovery-bottom"><div class="refs">${refs(d.evidenceIds)}</div><a href="#visual-artifact" ${artifact.kind === "journey-map" ? `data-map-stop="${esc(d.anchorId)}"` : ""}>${artifact.kind === "journey-map" ? "地図" : "ロードマップ"}で確認 ↗</a></div></article>`;
    })
    .join("")}</div></section>`;
}
