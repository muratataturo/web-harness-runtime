import type { Task } from "./types.js";
import { escapeHtml as esc } from "../web/presentation.js";

const kinds = {
  arrival: ["待ち合わせ", "M8 3v3m8-3v3M5 6h14v14H5zM8 10h8m-8 4h5"],
  move: [
    "移動",
    "M13 4a1 1 0 1 0 0 .1M8 21l3-7 3 3v4M6 12l3-5 4 1 2 4h4M11 8l-1 6",
  ],
  experience: [
    "体験",
    "m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z",
  ],
  meal: [
    "食事",
    "M5 3v7m3-7v7M3 3v5a3 3 0 0 0 6 0V3M6 11v10M18 3c-4 4-4 9 0 9h2M20 3v18",
  ],
  rest: [
    "ひと休み",
    "M4 8h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Zm12 1h2a3 3 0 0 1 0 6h-2M7 3v2m5-2v2",
  ],
  return: ["帰り支度", "m3 10 9-7 9 7M6 9v12h12V9M10 21v-7h4v7"],
} as const;
type Kind = keyof typeof kinds;
const inferKind = (action: string): Kind =>
  /帰路|帰宅|解散/.test(action)
    ? "return"
    : /徒歩|移動|乗車/.test(action)
      ? "move"
      : /休憩|休息/.test(action)
        ? "rest"
        : /食|ランチ/.test(action)
          ? "meal"
          : /待ち合わせ|集合/.test(action)
            ? "arrival"
            : "experience";
const icon = (kind: Kind) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${kinds[kind][1]}"/></svg>`;

/** The host renders the fixed plan; model-written invitations are explicitly proposals. */
export function renderJourneyStory(
  task: Task,
  photoBase: string,
  refs: (ids: string[]) => string,
) {
  const plan = task.answer?.actionPlan,
    artifact = task.answer?.visualArtifact;
  if (!plan || artifact?.kind !== "journey-map") return "";
  const moments = plan.steps.map((s, index) => {
    const moment = artifact.moments?.find((m) => m.stepId === s.id);
    return {
      step: s,
      index,
      moment,
      kind: moment?.kind ?? inferKind(s.action),
    };
  });
  const rests = moments.filter((m) => m.kind === "rest").length;
  const walk = moments.filter((m) => m.kind === "move");
  const moveMinutes = walk.every((m) => m.step.durationMinutes !== undefined)
    ? walk.reduce((n, m) => n + m.step.durationMinutes!, 0)
    : null;
  const cards = moments
    .map(({ step: s, index, moment, kind }) => {
      const stop = artifact.stops.find(
        (stop) => stop.primaryStepId === s.id && stop.experience,
      );
      const photo = stop && task.answerPhotos?.[stop.id];
      const image =
        photo && /^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/.test(photo.file)
          ? `<a class="moment-photo" href="#experience-${esc(stop!.id)}"><img src="${esc(photoBase)}/${photo.file}" alt="${esc(stop!.experience!.photoDescription)}" loading="lazy" width="200" height="150"><span>掲載写真・体験へ ↗</span></a>`
          : "";
      return `<li class="journey-moment kind-${kind}" id="step-${index}" data-step-id="${esc(s.id)}"><div class="moment-clock"><time>${esc(s.when)}</time><span>${s.durationMinutes ? `${s.durationMinutes}分・見積` : "時間は提案"}</span></div><span class="moment-node">${icon(kind)}</span><article class="moment-card${image ? " with-photo" : ""}"><div class="moment-copy"><div class="moment-topline"><span>${String(index + 1).padStart(2, "0")} / ${kinds[kind][0]}</span><span>${esc(s.where)}</span></div><h3>${esc(moment?.title ?? s.action)}</h3>${moment ? `<p class="moment-invitation"><span>楽しみ方の提案</span>${esc(moment.invitation)}</p>` : ""}<p class="moment-how">${esc(s.how)}</p><details class="moment-practical"><summary>当日の確認・完了の目安</summary><p><strong>${esc(s.action)}</strong> — ${esc(s.doneWhen)}</p>${s.locationStatus === "unconfirmed" ? "<p>場所・動線・休憩場所の詳細は未確認。現地で利用できる場所を確認してください。</p>" : ""}<div class="refs">${refs(s.evidenceIds)}</div></details></div>${image}${stop ? `<a class="moment-map-link" href="#visual-artifact" data-map-stop="${esc(stop.id)}">地図で場所を確認 ↗</a>` : ""}</article></li>`;
    })
    .join("");
  return `<details class="full-itinerary journey-story"><summary><span class="journey-summary-art" aria-hidden="true">${icon("move")}${icon("rest")}${icon("experience")}</span><span class="journey-summary-copy"><span class="eyebrow">THE LITTLE MOMENTS</span><strong>移動も、ひと息も、一日の楽しみに。</strong><span>移動・休憩も含めた${plan.steps.length}手順を見る</span><span class="journey-summary-meta">${esc(plan.steps[0]?.when ?? "")}からの主案 · ${rests}回の休憩${moveMinutes !== null && walk.length ? ` · 移動計${moveMinutes}分の見積` : ""}</span></span><span class="journey-summary-toggle"><span class="when-closed">行程をひらく</span><span class="when-open">行程をとじる</span><b aria-hidden="true">＋</b></span></summary><div class="journey-story-body"><div class="journey-story-intro"><p>心地よいペースで、次の場面へ。</p><span>主案の全手順です。時刻・所要時間・楽しみ方は提案。地図の省略操作では、この主案を変更しません。</span></div><ol class="journey-moments">${cards}</ol><p class="journey-story-end">予定通りより、気持ちよく帰れる一日を。疲れたら「未確認・変更時の行動」の代替案へ。</p></div></details>`;
}
