import { proposalRevision, rankProposals } from "./proposals.js";
import { renderDiscoveries } from "./discovery-html.js";
import { renderJourneyStory } from "./journey-story.js";
import { sharedMapEmbed } from "./map-embed.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateVisualArtifact } from "./visual-artifact.js";
import { markdown, escapeHtml as esc, safeLink } from "../web/presentation.js";
import { specificityContract } from "./answer-plan.js";
import type { Task } from "./types.js";

/** Saved answer plus a purpose-specific interactive artifact; never starts model inference. */
export function renderAnswerHtml(
  task: Task,
  options: { photoBase?: string; uxFeedbackEndpoint?: string } = {},
): string {
  const answer = task.answer,
    plan = answer?.actionPlan,
    contract = specificityContract(task.query);
  const artifact = answer?.visualArtifact;
  const isExample = task.model?.startsWith("操作例") ?? false;
  if (artifact) validateVisualArtifact(task, artifact, answer.actionPlan);
  const client = artifact
    ? readFileSync(
        new URL("../web/artifact-client.bundle.js", import.meta.url),
        "utf8",
      ).replace(/\r\n?/g, "\n")
    : "";
  const artifactCss = artifact
    ? readFileSync(
        new URL("../web/artifact-client.bundle.css", import.meta.url),
        "utf8",
      )
    : "";
  const scriptHash = createHash("sha256").update(client).digest("base64");
  // Photo stories and full-step invitations are already rendered in HTML. Send only fields the interactive client uses.
  const clientArtifact =
    artifact?.kind === "journey-map"
      ? {
          kind: artifact.kind,
          title: artifact.title,
          description: artifact.description,
          proposalSet: artifact.proposalSet,
          stops: artifact.stops.map((s) => ({
            id: s.id,
            label: s.label,
            stepIds: s.stepIds,
            primaryStepId: s.primaryStepId,
            evidenceIds: s.evidenceIds,
            optional: s.optional,
            coordinates: s.coordinates,
          })),
        }
      : artifact;
  const visualData = JSON.stringify({
    artifact: clientArtifact,
    proposalRanking: artifact?.proposalSet
      ? rankProposals(task, artifact.proposalSet)
      : undefined,
    review: artifact?.proposalSet
      ? {
          taskId: task.id,
          revision: proposalRevision(task),
          endpoint: options.uxFeedbackEndpoint,
        }
      : undefined,
    previews:
      artifact?.kind === "journey-map"
        ? Object.fromEntries(
            artifact.stops.flatMap((s) => {
              const page = task.pages.find((p) => p.id === s.previewPageId),
                url = page?.mapEmbeds?.map(sharedMapEmbed).find(Boolean);
              return url ? [[s.id, { url, sourceUrl: page!.url }]] : [];
            }),
          )
        : {},
    plan: answer?.actionPlan,
    evidence: task.evidence.map((e) => ({ id: e.id })),
  })
    .replaceAll("<", "\\u003c")
    .replaceAll("&", "\\u0026");
  const visual = artifact
    ? `<section id="visual-artifact" aria-label="目的に合った視覚成果物"><div class="artifact-fallback"><h2>${esc(artifact.title)}</h2><p>${esc(artifact.description)}</p><p>操作可能な地図・ロードマップを読み込み中。JavaScriptが無効な場合も下の回答全文を読めます。</p></div></section>`
    : "";
  const title = (
    answer?.summary.split("\n").find((l) => l.trim()) ??
    "回答を保存できませんでした"
  )
    .replace(/^#{1,6}\s*/, "")
    .replace(/^推奨[:：]\s*/, "");
  const date = task.query.match(/\d{4}年\d{1,2}月\d{1,2}日/)?.[0];
  const captured =
    task.pages[0]?.capturedAt ?? task.evidence[0]?.capturedAt ?? task.createdAt;
  const evidenceIndex = new Map(task.evidence.map((e, i) => [e.id, i]));
  const refs = (ids: string[]) =>
    [...new Set(ids)]
      .filter((id) => evidenceIndex.has(id))
      .map(
        (id) =>
          `<a class="ref" href="#source-${evidenceIndex.get(id)}">${esc(id)}</a>`,
      )
      .join("");
  const external = (url: string, label: string) => {
    const href = safeLink(url);
    return href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`
      : esc(label);
  };
  const full = markdown(
    (answer?.summary ?? task.error ?? "回答はありません。").replace(
      /\[(ev-\d+)\]/g,
      (all, id) => {
        const ev = task.evidence.find((e) => e.id === id);
        return ev ? `[${id}](${ev.url})` : all;
      },
    ),
  );
  const budget = plan?.budget,
    published =
      budget?.items
        .filter((i) => i.basis === "published")
        .reduce((n, i) => n + i.quantity * i.unitYen, 0) ?? 0;
  const estimated =
    budget?.items
      .filter((i) => i.basis === "estimate")
      .reduce((n, i) => n + i.quantity * i.unitYen, 0) ?? 0;
  const money = (v: number) => Math.round(v).toLocaleString("ja-JP");
  const lead = (answer?.summary.split(/\n## /)[0] ?? "")
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .slice(0, 1)
    .join("")
    .replace(/\[ev-\d+\]/g, "");
  const steps =
    plan?.steps
      .map(
        (s, i) =>
          `<article class="step" id="step-${i}"><div class="step-time"><time>${esc(s.when)}</time><span>${s.durationMinutes ? `${s.durationMinutes}分・見積` : "提案"}</span></div><div class="step-body"><div class="step-topline"><span class="step-number">${String(i + 1).padStart(2, "0")}</span><span class="location">${esc(s.where)}</span></div><h3>${esc(s.action)}</h3><p>${esc(s.how)}</p><div class="done"><span>完了の目安</span>${esc(s.doneWhen)}</div>${s.locationStatus === "unconfirmed" ? '<small class="unconfirmed">場所・動線の詳細は未確認</small>' : ""}<div class="refs">${refs(s.evidenceIds)}</div></div></article>`,
      )
      .join("") ?? "";
  const experiences =
    artifact?.kind === "journey-map"
      ? artifact.stops.filter((s) => s.experience)
      : [];
  const story = experiences
    .map((stop, i) => {
      const e = stop.experience!,
        primary = plan!.steps.find((s) => s.id === stop.primaryStepId)!,
        photo = task.answerPhotos?.[stop.id],
        page = task.pages.find((p) => p.id === e.photoPageId);
      const file =
        photo && /^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/.test(photo.file)
          ? photo.file
          : null;
      return `<article class="experience-card" id="experience-${esc(stop.id)}"><figure>${file ? `<img src="${esc(options.photoBase ?? "answer-assets")}/${file}" alt="${esc(e.photoDescription)}" loading="lazy" width="600" height="400">` : '<div class="photo-missing">掲載写真を取得できませんでした</div>'}<span class="experience-order">${String(i + 1).padStart(2, "0")}</span><figcaption>${esc(e.photoCaption)} ${page ? external(page.url, "写真の掲載元") : ""}</figcaption></figure><div class="experience-copy"><div class="experience-meta"><time>${esc(primary.when)}</time><span>${esc(stop.label)}</span><span>${primary.durationMinutes ?? "—"}分・提案</span></div><h3>${esc(e.headline)}</h3><p class="experience-why">${esc(e.why)}</p><ol>${e.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ol><div class="experience-bottom"><a href="#visual-artifact" data-map-stop="${esc(stop.id)}">地図で場所を見る ↗</a><div class="refs">${refs(stop.evidenceIds)}</div></div></div></article>`;
    })
    .join("");
  const journeyStory = renderJourneyStory(
    task,
    options.photoBase ?? "answer-assets",
    refs,
  );
  const inspiration = renderDiscoveries(task, refs);
  const rows =
    budget?.items
      .map(
        (i) =>
          `<tr><td><strong>${esc(i.label)}</strong><div class="refs">${refs(i.evidenceIds)}</div></td><td>${i.quantity} × ${money(i.unitYen)}円</td><td>${money(i.quantity * i.unitYen)}<small>円</small></td><td><span class="tag ${i.basis === "published" ? "published" : "estimate"}">${i.basis === "published" ? "掲載額" : "未確認の見積"}</span></td></tr>`,
      )
      .join("") ?? "";
  const sources = task.evidence
    .map(
      (e, i) =>
        `<details class="source" id="source-${i}"><summary><span class="source-id">${esc(e.id)}</span>${esc(task.pages.find((p) => p.id === e.pageId)?.title ?? new URL(e.url).hostname)}</summary><blockquote>${esc(e.quote).replaceAll("\n", "<br>")}</blockquote><div class="source-footer">${external(e.url, "掲載元を開く")}<span>取得 ${esc(e.capturedAt)}</span></div></details>`,
    )
    .join("");
  return `<!doctype html><html lang="ja" data-astryx-theme="neutral" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cyberjapandata.gsi.go.jp; frame-src https://www.google.com; base-uri 'none'; form-action 'none'"><meta name="referrer" content="strict-origin-when-cross-origin"><title>${esc(title)}｜生成回答</title><style>${artifactCss}\n${styles}</style></head><body class="${artifact ? "has-visual" : ""}">
  <header class="masthead"><a class="wordmark" href="#top"><span class="brand-mark">h</span>harness<span class="wordmark-small">RESEARCH NOTE</span></a><span class="saved-label">${isExample ? "架空条件の操作例" : "保存された実生成回答"}</span></header>
  <main id="top"><section class="hero"><div class="eyebrow">YOUR NEXT GOOD CHOICE <span>／ 調査からの提案</span></div><div class="hero-grid"><div><div class="hero-tags">${date ? `<span>${esc(date)}</span>` : ""}${contract.timeRange ? `<span>${esc(contract.timeRange.join("–"))}・提案</span>` : ""}<span class="partial">${task.status === "succeeded" ? "取得時点の掲載情報を確認" : "未確認を含む暫定案"}</span></div><h1>${esc(title)}</h1><p class="lead">${esc(lead)}</p><p class="snapshot">${isExample ? "作成" : "取得"}：${esc(new Date(captured).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }))} JST · ${task.evidence.length}件の引用</p></div>${budget ? `<aside class="budget-hero"><span class="eyebrow">家族の予算見積</span><div class="amount"><small>¥</small>${money(budget.totalYen)}</div><p>${esc(budget.scenario ?? "対象案は未確認")}</p>${contract.ceilingYen !== undefined ? `<div class="remaining">上限 ${money(contract.ceilingYen)}円まで <strong>${money(contract.ceilingYen - budget.totalYen)}円</strong></div>` : ""}<small>未確認の見積${money(estimated)}円を含みます。</small><a class="budget-link" href="#budget">内訳と出典を見る ↓</a></aside>` : ""}</div>
  ${visual}<nav class="section-nav" aria-label="回答の目次">${inspiration ? '<a href="#discoveries">ひとつ違う楽しみ方</a>' : ""}${steps ? '<a href="#itinerary">行程と進め方</a>' : ""}${budget ? '<a href="#budget">予算</a>' : ""}<a href="#conditions">未確認・変更時の行動</a><a href="#full-answer">回答全文</a><a href="#sources">引用・出典</a></nav></section>
  <div class="content-grid"><div class="main-column">${artifact?.proposalSet ? '<div id="proposal-comparison"></div>' : ""}${inspiration}${steps ? `<section id="itinerary" class="section"><div class="section-heading"><div><span class="eyebrow">01 / YOUR DAY</span><h2>${story ? "この日を、こんなふうに楽しむ。" : "いつ、どこで、どう過ごすか。"}</h2></div><span class="section-count">${plan!.steps.length}の手順</span></div><p class="section-note">時刻・所要時間・観察や休憩の方法は提案です。未確認の場所や当日の利用を保証しません。</p>${story ? `<div class="experience-grid">${story}</div>${journeyStory}` : `<div class="timeline">${steps}</div>`}</section>` : ""}
${budget ? `<section id="budget" class="section"><span class="eyebrow">02 / BUDGET</span><h2>掲載料金と、未確認の見積を分ける。</h2><p class="section-note">${esc(budget.scenario ?? "")}</p><div class="table-wrap"><table><thead><tr><th>内訳</th><th>数量 × 単価</th><th>小計</th><th>区分</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="2">合計</th><td colspan="2">${money(budget.totalYen)}円</td></tr></tfoot></table></div><p class="budget-note">掲載額 ${money(published)}円 ＋ 未確認の見積 ${money(estimated)}円。実際の支払額を保証するものではありません。</p></section>` : ""}
  <section id="conditions" class="section"><span class="eyebrow">03 / PLAN B & UNCERTAINTY</span><h2>無理をしないための、切り替え方。</h2><div class="branches">${plan?.branches.map((b) => `<article class="branch"><span class="trigger">${esc(b.trigger)}なら</span><h3>${esc(b.action)}</h3><p>${esc(b.how)}</p><div class="refs">${refs(b.evidenceIds)}</div></article>`).join("") ?? ""}</div><div class="limitations"><h3>確認できていないこと</h3><ul>${answer?.limitations.map((l) => `<li>${esc(l)}</li>`).join("") ?? `<li>${esc(task.error ?? "回答未取得")}</li>`}</ul></div></section>
  <section id="full-answer" class="section"><span class="eyebrow">04 / ORIGINAL ANSWER</span><h2>生成した回答の全文。</h2><p class="section-note">保存された本文を表示しています。構造化手順・予算・分岐の表示部分はruntimeが追記したものです。</p><details class="full-answer"><summary>回答全文を開く</summary><div class="markdown-body">${full}</div></details></section>
  <section id="sources" class="section"><span class="eyebrow">05 / SOURCES</span><h2>判断のもとになった引用。</h2><p class="section-note">項目を開くと、取得した本文の引用と掲載元を確認できます。</p>${sources || "<p>引用は保存されていません。</p>"}</section></div>
  <aside class="side-note"><span class="eyebrow">この案の使い方</span><h3>予定を埋めるより、<br>無理なく選ぶ。</h3><p>各手順の「進め方」と「完了の目安」を確認し、状況が変わったら代替行動へ。</p><div class="side-warning"><strong>出発前に確認</strong><p>${esc(answer?.limitations[0] ?? "最新の営業・料金・利用条件を掲載元で確認してください。")}</p></div><a href="#conditions">未確認事項を読む ↗</a><a href="#sources">掲載元と引用を確認 ↗</a><details class="record"><summary>この回答の記録</summary><p>モデル：${esc(task.model ?? "記録なし")}</p><p>結果：${esc(task.status)}</p><p>Task：${esc(task.id)}</p><p>このHTMLを開いても、モデル推論やWeb取得は行いません。</p></details></aside></div>${artifact?.proposalSet ? '<div id="ux-review"></div>' : ""}</main>
  <footer>WEB HARNESS RUNTIME <span>${isExample ? "架空条件の操作例" : "実生成の保存記録"} · 予約・購入を行う画面ではありません</span><a href="#top">先頭へ ↑</a></footer>${artifact ? `<script id="visual-data" type="application/json">${visualData}</script><script>${client}</script>` : ""}</body></html>`;
}

const styles = `
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",Meiryo,sans-serif;color:#183746;background:#f6f8f8;font-synthesis:none;scroll-behavior:smooth}*{box-sizing:border-box}body{margin:0;font-size:15px;line-height:1.8;color:#183746;background:#f6f8f8}a{color:#075f71;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #007f9c;outline-offset:4px}summary{cursor:pointer}.masthead,main,footer{max-width:1180px;margin:auto}.masthead{padding:25px 34px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #dce5e6}.wordmark{display:flex;gap:10px;align-items:center;color:#153442;font-size:22px;font-weight:800;text-decoration:none;letter-spacing:-.8px}.brand-mark{background:#0c6475;color:white;border-radius:9px;width:30px;height:34px;text-align:center;line-height:30px;font-size:25px}.wordmark-small{font-size:10px;letter-spacing:1.7px;font-weight:500;margin-left:14px;color:#526e77}.saved-label{font-size:12px;color:#526e77}main{padding:50px 34px 20px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:1.4px;color:#356371}.eyebrow>span{font-weight:400;letter-spacing:0;color:#526e77}.hero-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:45px;align-items:start;margin-top:22px}.hero-tags{display:flex;flex-wrap:wrap;gap:8px;font-size:12px}.hero-tags>span{padding:4px 10px;background:white;border:1px solid #d6e3e6;border-radius:5px}.hero-tags .partial{color:#795517;background:#fcf5e4;border-color:#e8d8b3}h1{font-size:clamp(27px,3.1vw,42px);line-height:1.5;letter-spacing:-1px;margin:18px 0}h2{font-size:25px;line-height:1.5;letter-spacing:-.6px;margin:8px 0 14px}h3{font-size:18px;line-height:1.6;margin:8px 0}.lead{font-size:15px;color:#405e6a;max-width:720px}.snapshot{font-size:12px;color:#526e77;margin-top:20px}.budget-hero{background:#eaf4f4;border:1px solid #c5dddf;border-radius:15px;padding:25px}.budget-hero .amount{font-size:45px;line-height:1.3;font-weight:700;letter-spacing:-1.8px;margin:12px 0}.amount small{font-size:23px;margin-right:6px}.budget-hero p{font-size:13px;margin:8px 0 16px}.remaining{font-size:12px;padding:12px 0;border-top:1px solid #c5dddf;display:flex;justify-content:space-between;gap:10px}.remaining strong{font-size:15px}.budget-hero>small{font-size:12px;color:#405e6a}.budget-link{display:block;margin-top:12px;font-size:13px;font-weight:600}.section-nav{display:flex;flex-wrap:wrap;gap:10px 26px;border-top:1px solid #dce5e6;border-bottom:1px solid #dce5e6;padding:12px 0;margin-top:35px}.section-nav a{display:inline-flex;align-items:center;min-height:40px;font-size:13px;text-decoration:none}.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:48px}.section{padding-top:45px;scroll-margin-top:20px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:15px}.section-count{white-space:nowrap;color:#526e77;font-size:12px}.section-note{font-size:13px;color:#526e77;margin-top:0}.timeline{margin-top:26px}.step{display:grid;grid-template-columns:65px minmax(0,1fr);gap:20px;position:relative;padding-bottom:22px}.step:not(:last-child):before{content:"";position:absolute;left:26px;top:55px;bottom:0;width:1px;background:#c5dddf}.step-time{padding-top:14px}.step-time time{font-weight:700;font-size:19px;color:#0c6475}.step-time>span{display:block;font-size:10px;line-height:1.5;color:#526e77}.step-body{background:white;border:1px solid #dce5e6;border-radius:12px;padding:20px 24px}.step-topline{display:flex;gap:12px;align-items:baseline}.step-number{font-size:10px;color:#637d86;letter-spacing:1px}.location{font-size:12px;color:#526e77;overflow-wrap:anywhere}.step-body h3{margin:6px 0 8px}.step-body p{margin:0 0 12px;overflow-wrap:anywhere}.done{background:#f1f7f7;border-left:3px solid #8bbcc3;padding:9px 12px;font-size:13px}.done>span{display:block;font-size:10px;color:#526e77;margin-bottom:2px}.unconfirmed{display:block;font-size:11px;color:#795517;margin-top:11px}.refs{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}.ref{border:1px solid #d6e3e6;border-radius:4px;padding:0 7px;font-size:10px;text-decoration:none;color:#356371;background:#f9fcfc}.table-wrap{overflow:auto;border:1px solid #dce5e6;border-radius:12px;background:white}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:14px 12px;border-bottom:1px solid #e4ebec;vertical-align:middle}th{color:#526e77;font-size:11px;background:#f0f6f6;white-space:nowrap}td strong{font-weight:500}td:nth-child(2),td:nth-child(3){white-space:nowrap}td:nth-child(3){text-align:right;font-variant-numeric:tabular-nums;font-size:15px}td small{font-size:10px;margin-left:3px}tfoot th,tfoot td{background:#eaf4f4;border:0;font-weight:700!important}.tag{font-size:10px;white-space:nowrap;padding:4px 7px;border-radius:4px}.published{background:#eaf4f4;color:#155965}.estimate{background:#faf2df;color:#795517}.budget-note{font-size:12px;color:#526e77}.branches{display:grid;gap:14px;margin-top:22px}.branch{background:white;border:1px solid #dce5e6;border-radius:12px;padding:22px}.trigger{font-size:12px;color:#795517;background:#faf2df;padding:3px 8px;border-radius:3px}.branch h3{margin-top:12px}.branch p{font-size:14px}.limitations{padding:22px;background:#fcf7ed;border:1px solid #e8ddc3;border-radius:12px;margin-top:24px;color:#66502b}.limitations h3{font-size:15px}.limitations ul{padding-left:20px;font-size:13px}.limitations li+li{margin-top:8px}.full-answer{background:white;border:1px solid #dce5e6;border-radius:12px}.full-answer>summary{padding:18px 22px;font-weight:600;min-height:52px}.markdown-body{padding:0 22px 22px;overflow-wrap:anywhere}.markdown-body h3{border-top:1px solid #dce5e6;padding-top:22px;margin-top:25px}.markdown-body table{display:block;overflow:auto}.markdown-body blockquote{border-left:3px solid #a8c8ce;padding:10px 15px;background:#f1f7f7;margin:15px 0}.source{background:white;border:1px solid #dce5e6;border-radius:8px;margin-top:10px;scroll-margin-top:15px}.source:target{border-color:#0c6475;box-shadow:0 0 0 2px #c5dddf}.source>summary{padding:15px;font-size:13px;overflow-wrap:anywhere}.source-id{display:inline-block;font-size:10px;background:#eaf4f4;padding:1px 6px;margin-right:8px;border-radius:3px}.source blockquote{font-size:14px;margin:0 18px 15px;padding:15px;background:#f3f7f7;border-left:3px solid #a8c8ce;overflow-wrap:anywhere}.source-footer{padding:0 18px 15px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:#526e77}.side-note{align-self:start;position:sticky;top:30px;margin-top:55px;border-top:2px solid #0c6475;padding-top:20px}.side-note h3{font-size:21px}.side-note>p{font-size:13px;color:#526e77}.side-warning{background:#eef4f4;border-radius:9px;padding:16px;margin:20px 0}.side-warning strong{font-size:12px}.side-warning p{font-size:12px;color:#405e6a;margin:7px 0 0}.side-note>a{display:block;font-size:12px;margin-top:12px}.record{margin-top:24px;border-top:1px solid #dce5e6;padding-top:15px;font-size:11px;color:#526e77}.record p{overflow-wrap:anywhere}footer{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;font-size:10px;letter-spacing:1px;color:#526e77;border-top:1px solid #dce5e6;margin-top:55px;padding:24px 34px}footer span{letter-spacing:0}
@media(max-width:800px){main{padding:30px 22px 0}.masthead{padding:20px 22px}.hero-grid{grid-template-columns:minmax(0,1fr) 260px;gap:24px}.content-grid{grid-template-columns:minmax(0,1fr);gap:0}.side-note{position:static;margin-top:40px}.wordmark-small{display:none}h2{font-size:23px}.step{gap:12px}}@media(max-width:600px){body{font-size:14px}.hero-grid{grid-template-columns:1fr}.budget-hero{padding:20px}.budget-hero .amount{font-size:40px}.hero-grid{gap:20px}.lead{font-size:14px}h1{font-size:29px;letter-spacing:-.5px}.saved-label{font-size:10px}.masthead{padding:15px 18px}.wordmark{font-size:21px}main{padding:26px 18px 0}.section-nav{gap:0 20px;margin-top:25px}.section{padding-top:32px}.step{grid-template-columns:48px minmax(0,1fr);gap:9px}.step-time time{font-size:16px}.step-time>span{font-size:9px}.step:not(:last-child):before{left:20px}.step-body{padding:16px}.step-body h3{font-size:17px}.step-body p{font-size:14px}.done{font-size:12px;padding:8px 10px}th,td{padding:10px 8px}.table-wrap table{min-width:530px}.limitations{padding:18px}.markdown-body{padding:0 16px 16px}footer{padding:22px 18px}}
@media(prefers-reduced-motion:reduce){:root{scroll-behavior:auto}}@media print{body{background:white}.masthead{padding-top:0}.content-grid,.hero-grid{display:block}.budget-hero{margin-top:20px}.side-note,.section-nav{display:none}.step{break-inside:avoid}.step-body{box-shadow:none}.table-wrap{overflow:visible}main{padding-top:20px}.source{break-inside:avoid}a{color:inherit}}
`;
