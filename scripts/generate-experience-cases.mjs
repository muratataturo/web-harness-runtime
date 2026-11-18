// A comparison of saved model outputs; never supplies or edits their itineraries.
import { readFile, writeFile } from "node:fs/promises";
import { escapeHtml as esc } from "../web/presentation.js";
import { itineraryCases } from "./itinerary-cases.mjs";
const cards = [],
  cases = [];
for (const id of ["hamamatsu-full", "nagoya-afternoon"]) {
  const c = itineraryCases[id];
  const t = JSON.parse(await readFile(`examples/${c.snapshot}.json`, "utf8"));
  const receipt = JSON.parse(
    await readFile(`docs/evidence/${c.receipt}.json`, "utf8"),
  );
  const plan = t.answer.actionPlan,
    brief = t.tripBrief,
    artifact = t.answer.visualArtifact;
  const photos = (artifact.stops ?? [])
    .filter((s) => s.experience)
    .flatMap((s) => {
      const x = s.experience;
      const photo = t.photoInspections?.find(
        (p) => p.pageId === x.photoPageId && p.imageIndex === x.photoIndex,
      );
      return photo ? [{ ...x, file: photo.file, label: s.label }] : [];
    });
  const cover = photos.find((p) => /展望|眺望/.test(p.label)) ?? photos[0];
  const facts = {
    id,
    taskId: t.id,
    status: t.status,
    livePassed: receipt.passed,
    mode: brief.mode,
    timeRange: brief.timeRange,
    steps: plan.steps.length,
    photos: photos.length,
    totalYen: plan.budget?.totalYen,
    verifier: {
      unknown: t.stepVerification?.unknown,
      failed: t.stepVerification?.failed,
    },
    answerEdited: false,
  };
  cases.push(facts);
  const bands =
    brief.mode === "full-day"
      ? [
          ["午前", 0, 12],
          ["午後", 12, 17],
          ["夕方〜夜", 17, 24],
        ]
      : [["午後だけ", 0, 24]];
  cards.push(
    `<article class="case"><a class="cover" href="${c.output}.html#day-rhythm">${cover ? `<img src="answer-assets/${esc(cover.file)}" alt="${esc(cover.photoDescription ?? cover.photoCaption)}">` : ""}<span>${esc(c.label)}</span></a><div class="body"><div class="meta">${esc(brief.timeRange.join(" → "))} <span>時刻未指定への提案</span></div><h2>${brief.mode === "full-day" ? "音楽と街の眺めを、朝から夜まで。" : "科学に出会って、カフェでひと息。"}</h2><p>${plan.steps.length}手順 · 写真${photos.length}枚 · 2人の主案掲載額／見積合計 <strong>¥${plan.budget.totalYen.toLocaleString("ja-JP")}</strong></p><p class="verdict">${t.status === "succeeded" ? "生成時の品質条件を通過" : "未確認を残した提案"} · 手順検査の未確認 ${t.stepVerification?.unknown ?? 0}件／要修正 ${t.stepVerification?.failed ?? 0}件。空席や当日の営業は保証しません。</p><div class="bands">${bands
      .map(
        ([name, from, to]) =>
          `<section><h3>${name}</h3>${plan.steps
            .filter(
              (s) =>
                +s.when.split(":")[0] >= from &&
                +s.when.split(":")[0] < to &&
                !["move", "return"].includes(s.kind),
            )
            .map(
              (s) =>
                `<p><time>${esc(s.when)}</time><span>${esc(s.action)}<small>${esc(s.where)}</small></span></p>`,
            )
            .join("")}</section>`,
      )
      .join(
        "",
      )}</div><a class="button" href="${c.output}.html">写真・地図・食事・全行程を見る ↗</a><details><summary>この生成で残った確認事項</summary><ul>${t.answer.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details></div></article>`,
  );
}
await writeFile(
  "docs/experience-cases.html",
  `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>一日を、ちょうどいい密度で。｜実生成の比較</title><style>*{box-sizing:border-box}html{color-scheme:light dark}body{margin:0;background:#f4f3ee;color:#202d29;font:16px/1.8 system-ui,-apple-system,sans-serif}main{max-width:1240px;margin:auto;padding:48px 24px 72px}header{max-width:850px;margin-bottom:40px}.eyebrow{font-size:12px;letter-spacing:.17em;color:#276854;font-weight:750}h1{font-size:clamp(32px,5vw,60px);letter-spacing:-.04em;line-height:1.25}header p{max-width:750px;color:#4c5c54}.grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:start}.case{background:#fff;border:1px solid #dce2da;border-radius:24px;overflow:hidden}.cover{display:block;height:290px;position:relative;background:#244f42;overflow:hidden}.cover img{width:100%;height:100%;object-fit:cover}.cover:after{content:"";position:absolute;inset:0;background:linear-gradient(transparent,rgba(0,0,0,.7))}.cover span{position:absolute;bottom:22px;left:24px;right:20px;z-index:1;color:white;font-size:28px;font-weight:750;line-height:1.3}.body{padding:26px}.meta{font-weight:750;color:#23634e}.meta span{display:block;font-size:12px;font-weight:450}h2{font-size:25px;line-height:1.5;margin:16px 0}.verdict{padding:12px 15px;border-radius:12px;background:#f8eedb;color:#66481e;font-size:13px}.bands{border-left:2px solid #9abbad;padding-left:18px;margin:25px 0}.bands h3{font-size:15px;color:#24664e}.bands p{display:flex;gap:14px;line-height:1.5;font-size:14px}.bands time{font-variant-numeric:tabular-nums;color:#527065;flex-shrink:0}.bands small{display:block;color:#5c6b62;font-size:12px;margin-top:5px}a{color:#23634e}.button{display:inline-block;background:#1c604b;color:white;padding:13px 20px;border-radius:30px;text-decoration:none;font-weight:700}details{margin-top:22px;font-size:13px}summary{cursor:pointer}li{margin:12px 0}footer{font-size:13px;margin-top:32px;color:#556359}@media(max-width:760px){main{padding:28px 16px}.grid{grid-template-columns:1fr}.cover{height:250px}.body{padding:22px}}@media(prefers-color-scheme:dark){body{background:#101c18;color:#e7eee9}.case{background:#182a22;border-color:#385044}header p,footer,.bands small{color:#b8c9bf}.eyebrow,.meta,a,.bands h3,.bands time{color:#99d4b9}.verdict{background:#3b3120;color:#f2d7a0}.button{color:#fff;background:#226d53}}</style><main><header><p class="eyebrow">GENERATED BY THE AUTONOMOUS RUNTIME</p><h1>一日を、<br>ちょうどいい密度で。</h1><p>朝から夜まで楽しむ日も、午後だけ気軽に出かける日も。時間帯と気分を読み取るruntimeで、浜松と名古屋を実際に無人生成しました。写真・行程・注文・費用はモデルの保存回答から表示しています。</p><p>追加調査をしても確認できなかった情報は、そのまま表示。人による魅力度評価は未実施です。<a href="experience-depth-runtime.md">実装と検査の範囲 ↗</a></p></header><div class="grid">${cards.join("")}</div><footer>時刻・移動・楽しみ方は提案。金額の掲載根拠・見積区分・対象日の確認状態は各回答で確認できます。公式候補URLを与えた2ケースの検証であり、全国検索の成功率を表すものではありません。過去の短い時間指定ケースは<a href="regional-cases.html">こちら</a>。</footer></main></html>`,
);
await writeFile(
  "docs/evidence/experience-cases.json",
  JSON.stringify(
    {
      scope: "two unedited source-seeded live outputs; no human appeal score",
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(cases));
