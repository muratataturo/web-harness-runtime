import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { renderAnswerHtml } from "../dist/answer-html.js";
import {
  assessVisualArtifact,
  validateVisualArtifact,
} from "../dist/visual-artifact.js";
import { diagnose } from "../dist/improvement.js";
import { Store } from "../dist/store.js";
const out = ".runtime/visual-study";
await mkdir("docs/evidence", { recursive: true });
const raw = JSON.parse(
  await readFile(".runtime/specificity-study/final-generated.json", "utf8"),
);
const task = structuredClone(raw.task ?? raw);
await writeFile(out + "/before.html", renderAnswerHtml(task));
const before = assessVisualArtifact(task, task.answer);
const addGeo = (name, text, url, capturedAt) => {
  const id = "geo-" + name,
    eid = "ev-geo-" + name,
    now = capturedAt;
  task.pages.push({
    id,
    url,
    title: name + " 地理データの取得記録",
    text,
    links: [],
    capturedAt: now,
    truncated: false,
  });
  task.evidence.push({
    id: eid,
    pageId: id,
    url,
    quote: text,
    capturedAt: now,
  });
  return eid;
};
const geos = {};
for (const key of ["station", "zoo", "museum"]) {
  const [place] = JSON.parse(
    await readFile(`${out}/${key}-geocode.json`, "utf8"),
  );
  const url = `https://www.openstreetmap.org/${place.osm_type}/${place.osm_id}`;
  const text = JSON.stringify({
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    osm_type: place.osm_type,
    osm_id: place.osm_id,
    licence: place.licence,
  });
  geos[key] = {
    lat: Number(place.lat),
    lon: Number(place.lon),
    evidenceId: addGeo(
      key,
      text,
      url,
      (await stat(`${out}/${key}-geocode.json`)).mtime.toISOString(),
    ),
  };
}
const html = await readFile(out + "/lunch-source.html", "utf8");
const geoBlock = html.match(/"geo"\s*:\s*\{[^}]+\}/)?.[0];
if (!geoBlock) throw Error("店舗の構造化座標を確認できません");
const geo = JSON.parse("{" + geoBlock + "}").geo;
geos.lunch = {
  lat: Number(geo.latitude),
  lon: Number(geo.longitude),
  evidenceId: addGeo(
    "lunch",
    geoBlock,
    "https://www.hotpepper.jp/strJ001100102/",
    (await stat(out + "/lunch-source.html")).mtime.toISOString(),
  ),
};
const definitions = [
  ["start", "JR上野駅", ["s0"], "station", false],
  ["zoo", "恩賜上野動物園", ["s1", "s2"], "zoo", false],
  ["lunch", "まいか アトレ上野店", ["s4"], "lunch", false],
  ["museum", "国立科学博物館", ["s6", "s7", "s8"], "museum", true],
  ["finish", "JR上野駅", ["s10"], "station", false],
];
for (const [key, , stepIds] of definitions) {
  const pattern =
    key === "museum"
      ? /常設|博物館/
      : key === "zoo"
        ? /動物園/
        : key === "lunch"
          ? /御膳|プレート/
          : /$^/;
  const items = task.answer.actionPlan.budget.items
    .filter((i) => pattern.test(i.label))
    .map((i) => i.id);
  task.answer.actionPlan.steps.find((s) => s.id === stepIds[0]).costItemIds =
    items;
}
task.answer.visualArtifact = {
  kind: "journey-map",
  title: "動物と科学をつなぐ、上野の一日。",
  description:
    "ピンと予定を選んで、家族のペースに合う回り方を確認。疲れたら博物館を省く案へ切り替えられます。",
  stops: definitions.map(([id, label, stepIds, key, optional]) => ({
    id,
    label,
    stepIds,
    primaryStepId: stepIds[0],
    optional,
    coordinates: geos[key],
    evidenceIds: [
      ...new Set(
        task.answer.actionPlan.steps
          .filter((s) => stepIds.includes(s.id))
          .flatMap((s) => s.evidenceIds),
      ),
    ],
  })),
};
task.visualReview = assessVisualArtifact(task, task.answer);
if (task.visualReview.status !== "passed")
  throw Error(JSON.stringify(task.visualReview));
await writeFile(out + "/journey-task.json", JSON.stringify(task, null, 2));
await writeFile("docs/generated-answer.html", renderAnswerHtml(task));
await new Store(out + "/store").save(task);
const roadmap = structuredClone(task);
roadmap.createdAt = new Date().toISOString();
roadmap.query =
  "人生計画。仕事・住居・車を決める順番と0〜30日、1〜3か月、3〜6か月のロードマップを作る。これは架空条件のインタラクション例。年収・貯蓄・採用可否を推測しない。";
roadmap.answer = {
  summary:
    "## 次の暮らしは、小さな決定から。\n架空の相談条件を使ったロードマップの表示例です。個別の求人・住宅・車を調査した回答ではありません。仕事の条件を先に確認し、住居、車の順で支出を確定する提案です。",
  candidates: [],
  limitations: [
    "この画面は架空条件による操作例です。個人向けの調査結果ではありません。",
    "手取り・貯蓄・家族構成・通勤条件は未指定です。将来の収入や採用を予測していません。",
  ],
  visualArtifact: {
    kind: "life-roadmap",
    title: "次の暮らしを、一つずつ選ぶ。",
    description:
      "仕事・住まい・移動を、決める順番で見渡す。節目を選び、前提を満たしたら次の一歩へ。架空条件の操作例です。",
    lanes: [
      { id: "work", label: "仕事と働き方" },
      { id: "home", label: "住まいと家計" },
      { id: "mobility", label: "週末と移動" },
    ],
    milestones: [
      {
        id: "w1",
        laneId: "work",
        horizon: "0〜30日 / 見える化",
        title: "譲れない働き方を3つに絞る",
        action:
          "在宅日数・通勤・給与について、希望と許容下限をそれぞれ書き出す。現職の手取りと就業規則を確認する。",
        doneWhen: "希望3項目と、確認が必要な条件が1枚にまとまる",
        decision: "優先順位が決まらなければ応募先の選定を保留する",
        dependsOn: [],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "w2",
        laneId: "work",
        horizon: "1〜3か月 / 試す",
        title: "候補職の実態を面談で確かめる",
        action:
          "公開求人の勤務条件を比較し、在宅日数・給与の確定方法・勤務地を採用担当へ質問する。回答のない条件は未確認として残す。",
        doneWhen: "条件の確認表と、次の選考に進む候補ができる",
        decision: "必須条件に合わなければ現職を続けて候補を探し直す",
        dependsOn: ["w1"],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "w3",
        laneId: "work",
        horizon: "3〜6か月 / 決める",
        title: "書面の条件で転職を判断する",
        action:
          "労働条件通知書と入社日を照合し、現職の退職手順を確認する。提示前に退職を決めない。",
        doneWhen: "勤務場所・報酬・入社日を本人が確認できる",
        decision: "書面と説明が違えば決定を保留して問い合わせる",
        dependsOn: ["w2"],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "h1",
        laneId: "home",
        horizon: "0〜30日 / 見える化",
        title: "暮らしの固定費を棚卸しする",
        action:
          "直近の家計記録から住居・通信・保険・移動を整理し、初期費用と月額を別々に記入する。未入力の手取りや貯蓄は埋めない。",
        doneWhen: "月額と一時金が分かれた家計表ができる",
        decision: "収入と生活費が不明なら家賃上限は暫定のままにする",
        dependsOn: [],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "h2",
        laneId: "home",
        horizon: "1〜3か月 / 試す",
        title: "通勤を体験し、住居条件を絞る",
        action:
          "勤務候補地が分かってから通勤時間帯に移動を試す。賃料だけでなく管理費・更新費・初期費用を候補ごとに確認する。",
        doneWhen: "通勤の実感と総費用を並べた比較表ができる",
        decision: "勤務地が未定なら契約せず内見と比較までにする",
        dependsOn: ["w2", "h1"],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "h3",
        laneId: "home",
        horizon: "3〜6か月 / 決める",
        title: "仕事が決まってから住まいを確定",
        action:
          "勤務地・在宅条件と確定した収入を前提に家計を再計算し、契約書の条件と入居日を照合する。",
        doneWhen: "月額負担と初期費用の出所を説明できる",
        decision: "生活費や予備費が不足するなら地域・広さ・時期を見直す",
        dependsOn: ["w3", "h2"],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "m1",
        laneId: "mobility",
        horizon: "0〜30日 / 見える化",
        title: "車のある週末を、まず試す",
        action:
          "利用したい週末の行先と頻度を書き出し、レンタカーやカーシェアを1回試す計画を立てる。実在の空車や料金は未確認。",
        doneWhen: "使い方・必要な大きさ・保管場所の確認項目ができる",
        decision: "利用頻度が少なければ購入案と借りる案を比較する",
        dependsOn: [],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "m2",
        laneId: "mobility",
        horizon: "1〜3か月 / 試す",
        title: "所有と借りる費用を比較する",
        action:
          "購入一時金、駐車場、保険、税、整備、燃料を別々に見積もる。駐車場は入居候補の所在地で問い合わせる。",
        doneWhen: "同じ期間の所有案と利用時払い案を比較できる",
        decision: "駐車場や維持費が不明なら車両の契約を保留する",
        dependsOn: ["h1", "m1"],
        evidenceIds: [],
        basis: "proposal",
      },
      {
        id: "m3",
        laneId: "mobility",
        horizon: "3〜6か月 / 決める",
        title: "家計を見直して購入か継続利用か",
        action:
          "住居費が確定してから総支払額と維持費を再計算する。購入するなら車両状態・見積書・保管場所を確認する。",
        doneWhen: "買う・借りる・延期のいずれかを理由つきで選べる",
        decision: "生活の予備費を削るなら購入を延期して借りる案へ",
        dependsOn: ["h3", "m2"],
        evidenceIds: [],
        basis: "proposal",
      },
    ],
  },
};
roadmap.pages = [];
roadmap.evidence = [];
roadmap.status = "partial";
roadmap.model = "操作例（推論なし）";
roadmap.visualReview = assessVisualArtifact(roadmap, roadmap.answer);
validateVisualArtifact(roadmap, roadmap.answer.visualArtifact);
await writeFile(out + "/roadmap-task.json", JSON.stringify(roadmap, null, 2));
await writeFile("docs/life-roadmap.html", renderAnswerHtml(roadmap));
await writeFile(
  "docs/evidence/visual-generation.json",
  JSON.stringify(
    {
      sourceTaskId: task.id,
      renderSource:
        "saved-live-answer plus captured geographic evidence; roadmap is an explicitly synthetic interaction example",
      before,
      after: task.visualReview,
      roadmap: roadmap.visualReview,
      diagnosisBefore: diagnose(
        raw.task ?? raw,
        (raw.task ?? raw).criteria,
        (raw.task ?? raw).answer.candidates.map((c) => c.url),
      ).causes,
      diagnosisAfter: diagnose(
        task,
        task.criteria,
        task.answer.candidates.map((c) => c.url),
      ).causes,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("Generated docs/generated-answer.html and docs/life-roadmap.html");

// The reviewed final example uses the ACTUAL model output adopted by the shared loop.
// Its facts, original answer and budget remain those of the saved research task.
try {
  const final = JSON.parse(
    await readFile(out + "/offline-accepted.json", "utf8"),
  );
  if (!final.loop.iterations.at(-1)?.accepted)
    throw Error("最終視覚改善が採用されていません");
  validateVisualArtifact(final.task, final.task.answer.visualArtifact);
  await writeFile("docs/generated-answer.html", renderAnswerHtml(final.task));
  await writeFile(
    out + "/final-artifact-task.json",
    JSON.stringify(final.task, null, 2),
  );
  const previous = JSON.parse(
    await readFile(out + "/offline-result.json", "utf8"),
  );
  const full = JSON.parse(await readFile(out + "/live-result.json", "utf8"));
  const source = JSON.parse(
    await readFile(
      out + "/offline/tasks/" + final.loop.sourceTaskId + "/task.json",
      "utf8",
    ),
  );
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await writeFile(
    "docs/evidence/visual-improvement.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: final.task.model,
        sourceTaskId: final.loop.sourceTaskId,
        finalTaskId: final.task.id,
        loopId: final.loop.id,
        loopStatus: final.loop.status,
        accepted: final.loop.iterations.at(-1).accepted,
        mode: "captured-data-only model synthesis; not weight training",
        sourcePreparation:
          "12 original research quotes retained; four geographic captures added before the offline model loop",
        factsPreserved: same(
          final.task.answer.candidates,
          source.answer.candidates,
        ),
        originalSummaryPreserved: same(
          final.task.answer.summary,
          source.answer.summary,
        ),
        budgetPreserved: same(
          final.task.answer.actionPlan.budget,
          source.answer.actionPlan.budget,
        ),
        evidencePreserved: same(final.task.evidence, source.evidence),
        firstResearchAttempt: {
          loopStatus: full.loop.status,
          accepted: full.loop.iterations.at(-1).accepted,
          reason: "合格する構造化回答を確定できず不採用。元の最良回答を保持",
        },
        densityImprovement: {
          firstDescriptionCharacters:
            previous.task.answer.visualArtifact.description.length,
          finalDescriptionCharacters:
            final.task.answer.visualArtifact.description.length,
          firstMaxPlaceLabel: Math.max(
            ...previous.task.answer.visualArtifact.stops.map(
              (s) => s.label.length,
            ),
          ),
          finalMaxPlaceLabel: Math.max(
            ...final.task.answer.visualArtifact.stops.map(
              (s) => s.label.length,
            ),
          ),
        },
        visualReview: final.task.visualReview,
        artifact: final.task.answer.visualArtifact,
        humanAppeal:
          "not measured; user's earlier negative feedback motivated revision",
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log(
    "No captured final model run: showing the deterministic research-data example.",
  );
}
