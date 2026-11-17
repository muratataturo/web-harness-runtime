// Summarize saved, unedited runs. This never calls a model or fills in itinerary facts.
import { readFile, writeFile } from "node:fs/promises";
import { itineraryCases } from "./itinerary-cases.mjs";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cards = [];
const rows = [];
for (const id of ["hamamatsu", "nagoya"]) {
  const c = itineraryCases[id];
  const t = JSON.parse(await readFile(`examples/${c.snapshot}.json`, "utf8"));
  const r = JSON.parse(
    await readFile(`docs/evidence/${c.receipt}.json`, "utf8"),
  );
  if (t.id !== r.taskId || t.authorship || r.answerEdited !== false)
    throw Error("Receipt and unedited output must match");
  const a = t.answer;
  const photos = Object.values(t.answerPhotos ?? {});
  const success = r.passed === true;
  const unresolved = a.candidates.flatMap((candidate) =>
    candidate.matches
      .filter(
        (m) => m.status === "unknown" && !m.explanation.includes("対象外"),
      )
      .map((m) => ({
        criterion: t.criteria.find((c) => c.id === m.criterionId)?.description,
        reason: m.explanation,
      })),
  );
  const details = `<details><summary>残っている確認事項（${unresolved.length}条件）</summary><ul>${unresolved.map((m) => `<li><strong>${esc(m.criterion)}</strong><br>${esc(m.reason)}</li>`).join("")}</ul></details>`;
  const photo = photos[1] ?? photos[0];
  const qa = JSON.parse(
    await readFile(`docs/evidence/${id}-itinerary-qa.json`, "utf8"),
  );
  const checked = qa.cases.length;
  rows.push({
    caseId: id,
    taskId: t.id,
    status: t.status,
    livePassed: r.passed,
    model: t.model,
    steps: a.actionPlan?.steps.length,
    candidates: a.candidates.length,
    photos: photos.length,
    totalYen: a.actionPlan?.budget?.totalYen,
    elapsedMs: r.elapsedMs,
    evidence: t.evidence.length,
    checks: checked,
    limitations: a.limitations,
    answerEdited: false,
    remainingUnknowns: a.candidates.flatMap((candidate) =>
      candidate.matches
        .filter(
          (m) => m.status === "unknown" && !m.explanation.includes("対象外"),
        )
        .map((m) => ({
          candidate: candidate.name,
          criterion: t.criteria.find((c) => c.id === m.criterionId)
            ?.description,
          reason: m.explanation,
        })),
    ),
  });
  cards.push(
    `<article class="card"><a class="cover" href="${c.output}.html#itinerary"><img src="answer-assets/${esc(photo?.file)}" alt="${esc(a.visualArtifact?.stops?.find((s) => t.answerPhotos?.[s.id]?.file === photo?.file)?.experience?.photoCaption ?? c.label + "の掲載写真")}" loading="eager"><span class="region">${id === "hamamatsu" ? "01 / SHIZUOKA" : "02 / AICHI"}</span></a><div class="content"><span class="status ${success ? "ok" : "partial"}">${success ? "無編集のライブE2E通過" : "未確認を含む保存回答"}</span><h2>${esc(c.label)}</h2><p class="story">${esc(a.visualArtifact?.title)}</p><p>${esc(a.visualArtifact?.description)}</p><div class="metrics"><div><b>${esc(a.actionPlan?.steps.length)}</b><small>移動・休憩を含む手順</small></div><div><b>${Number(a.actionPlan?.budget?.totalYen ?? 0).toLocaleString("ja-JP")}<em>円</em></b><small>大人2人の主案掲載額</small></div></div><p class="proof">${a.candidates.length}候補比較 · 写真${photos.length}枚 · 引用${t.evidence.length}件<br>${Math.round((r.elapsedMs ?? 0) / 1000)}秒の実生成 · ${checked}画面幅の表示を検査</p>${details}<a class="button" href="${c.output}.html#itinerary">写真と地図で、一日の過ごし方を見る <span>↗</span></a><p class="links"><a href="evidence/${c.receipt}.json">ライブ検証記録</a><a href="evidence/${id}-itinerary-qa.json">表示検証記録</a></p></div></article>`,
  );
}
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>浜松と名古屋、次の一日。｜地域の実生成ケース</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f5ef;color:#233b36;font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;line-height:1.85}main{max-width:1200px;margin:auto;padding:64px 32px}a{color:#14635c}a:focus-visible{outline:3px solid #a15d25;outline-offset:5px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.19em;color:#626b48}header{max-width:900px;margin-bottom:40px}h1{font-size:clamp(32px,5vw,58px);line-height:1.35;letter-spacing:-.03em;margin:18px 0 24px}header p{font-size:16px;max-width:760px;color:#4b6159}.conditions{display:flex;gap:8px;flex-wrap:wrap}.conditions span{border:1px solid #cbd3c4;border-radius:30px;padding:6px 14px;font-size:12px;background:#fff}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.card{background:#fff;border:1px solid #d8ded0;border-radius:22px;overflow:hidden}.cover{display:block;height:290px;position:relative}.cover img{height:100%;width:100%;object-fit:cover}.region{position:absolute;top:18px;left:18px;border-radius:30px;padding:6px 12px;background:#fff;color:#36564b;font-size:12px;letter-spacing:.12em;font-weight:700}.content{padding:26px 30px 24px}.status{display:inline-block;font-size:11px;padding:4px 10px;border-radius:8px}.ok{background:#e6f0e8;color:#235d39}.partial{background:#f8ead0;color:#744b13}h2{font-size:30px;margin:14px 0 3px}.story{font-weight:750;font-size:18px;margin:3px 0 14px}.content>p{color:#50665e;font-size:14px}.metrics{border-top:1px solid #e1e6dc;border-bottom:1px solid #e1e6dc;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:18px 0;margin-top:24px}.metrics b{font-size:31px;line-height:1.4;display:block;font-weight:650}.metrics em{font-size:14px;font-style:normal;margin-left:3px}.metrics small{font-size:11px;color:#617065}.proof{font-size:12px!important}.button{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#235b4a;color:#fff;text-decoration:none;border-radius:10px;padding:14px 16px;margin-top:20px;font-size:13px;font-weight:700}.button:hover{background:#184737}.links{display:flex;gap:18px;font-size:11px!important;margin-bottom:0}.content details{font-size:12px;color:#4b6159;border-top:1px solid #e1e6dc;padding-top:12px;margin-top:16px}.content summary{cursor:pointer;font-weight:650}.content details ul{padding-left:18px}.content details li{margin:12px 0}.note{border-top:1px solid #d2d9cb;margin-top:42px;padding-top:24px;color:#526359;font-size:12px}.note a{display:inline-block;margin-right:20px}@media(max-width:700px){main{padding:36px 18px}.grid{grid-template-columns:1fr}.cover{height:240px}.content{padding:22px}.links{flex-wrap:wrap}}
</style></head><body><main><header><span class="eyebrow">GENERATED AUTONOMOUSLY / BEYOND TOKYO</span><h1>次の一日は、<br>浜松と名古屋へ。</h1><p>街を変えても、旅の間にある時間まで。公式資料の取得から、カフェ、休憩、写真と地図のある回答までを自律runtimeで新規生成しました。回答本文への手修正は加えていません。</p><p>全条件が揃った正式版判定：${rows.filter((r) => r.livePassed).length}/${rows.length}件。生成・表示の検証と、事実の確認完了は分けて記録しています。</p><div class="conditions"><span>2026年11月21日（土）</span><span>大人2人 · 10:00〜15:00</span><span>入館・飲食 1万円以内</span><span>交通費は除外 · 徒歩中心</span></div></header><section class="grid" aria-label="地域別の実生成結果">${cards.join("")}</section><footer class="note"><p>写真は公式掲載元の参考画像。時刻・移動時間・楽しみ方は提案です。将来の営業・席・提供商品を保証しません。地域ごとに調査した初回ケースであり、地域全体や全店舗での成功率は示しません。掲載額と支払条件は各回答の引用と取得日時で確認できます。</p><a href="regional-itinerary-e2e.md">地域対応と検証の詳細</a><a href="autonomous-cafe-day.html#itinerary">東京・上野の先行ケース</a><a href="visual-cases.html">ほかの生成例</a></footer></main></body></html>`;
await writeFile("docs/regional-cases.html", html);
await writeFile(
  "docs/evidence/regional-itinerary-summary.json",
  JSON.stringify(
    {
      scope:
        "two source-seeded regional live runs; not an aggregate success-rate benchmark",
      answerEdited: false,
      cases: rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    rows.map(({ caseId, status, livePassed, totalYen }) => ({
      caseId,
      status,
      livePassed,
      totalYen,
    })),
  ),
);
