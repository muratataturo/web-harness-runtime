import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newTask, runTask } from "../src/runtime.js";
import { addEvidence, setCriteria, validateAnswer } from "../src/evidence.js";
import { uncoveredCriteria } from "../src/criteria.js";
import { validateActionPlan, assessSpecificity } from "../src/answer-plan.js";
import { decodeImprovementContext } from "../src/improvement-context.js";
import { CodexAgent } from "../src/codex.js";
import { Store } from "../src/store.js";
const urls = [
  "https://shop.create-restaurants.co.jp/0941/",
  "https://shop.create-restaurants.co.jp/9999/",
];
function scoped() {
  const t = newTask({
    query: "カフェの比較",
    urls,
    maxSteps: 20,
    maxPages: 4,
    timeoutSeconds: 20,
  });
  setCriteria(
    t,
    urls.map((u, i) => ({
      id: `c${i}`,
      description: `店舗${i}の営業`,
      required: true,
      weight: 1,
      appliesTo: [u],
    })),
  );
  const candidates = urls.map((url, i) => {
    const id = `p${i}`;
    t.pages.push({
      id,
      url,
      title: `店舗${i}`,
      text: `店舗${i}の営業は10時から21時です。`,
      capturedAt: t.createdAt,
      truncated: false,
      links: [],
    });
    const ev = addEvidence(t, id, t.pages.at(-1)!.text);
    return {
      name: `店舗${i}`,
      url,
      matches: t.criteria.map((c, j) => ({
        criterionId: c.id,
        status: (i === j ? "supported" : "unknown") as "supported" | "unknown",
        explanation: i === j ? "当該店舗の営業" : "対象外",
        evidenceIds: i === j ? [ev.id] : [],
      })),
    };
  });
  return { t, candidates };
}
test("venue-specific conditions are scored separately and a missing required venue stays unresolved", () => {
  const { t, candidates } = scoped();
  const answer = validateAnswer(t, "比較", candidates, []);
  assert.ok(answer.candidates.every((c) => c.eligible && c.score === 100));
  const missing = validateAnswer(t, "片方だけ", candidates.slice(0, 1), []);
  assert.equal(uncoveredCriteria(t.criteria, missing.candidates).length, 1);
  assert.match(missing.limitations.join(" "), /対象候補が不足/);
  candidates[0]!.matches[1]!.status = "supported";
  candidates[0]!.matches[1]!.evidenceIds = [t.evidence[1]!.id];
  assert.throws(
    () => validateAnswer(t, "混同", candidates, []),
    /対象外|別の役割/,
  );
  const before = structuredClone(t.criteria);
  t.evidence = [];
  assert.throws(
    () =>
      setCriteria(t, [
        {
          id: "bad",
          description: "不正",
          required: true,
          weight: 1,
          appliesTo: [],
        },
      ]),
    /appliesTo/,
  );
  assert.deepEqual(t.criteria, before);
});
test("formal verification cannot relabel future seating as guaranteed", () => {
  const { t } = scoped();
  const plan: any = {
    steps: [
      {
        id: "c",
        when: "13:00",
        where: "EVERYONEs CAFE",
        action: "カフェでお茶",
        how: "メニューを確認して注文する",
        doneWhen: "店を出る",
        locationStatus: "evidence-linked",
        durationMinutes: 60,
        evidenceIds: [t.evidence[0]!.id],
        costItemIds: [],
      },
    ],
    branches: [],
    verification: {
      date: "2026-11-21",
      checks: ["opening", "prices", "seating", "comparison", "rest"].map(
        (kind) => ({
          kind,
          status: kind === "seating" ? "arrival-check" : "published",
          detail:
            kind === "seating"
              ? "予約は行わず当日店頭で入店判断する"
              : "公式情報の取得内容を引用で確認する",
          evidenceIds: [t.evidence[0]!.id],
          stepIds: ["c"],
        }),
      ),
    },
  };
  validateActionPlan(t, plan);
  plan.verification.checks[2].status = "published";
  assert.throws(() => validateActionPlan(t, plan), /座席|到着時/);
  plan.verification.checks[2].status = "arrival-check";
  plan.verification.checks[2].detail =
    "当日は予約済みなので座席確保できています";
  assert.throws(() => validateActionPlan(t, plan), /未来|予約完了/);
  t.query = "2026年11月21日の一日旅行を正式にする";
  delete plan.verification;
  const review = assessSpecificity(t, {
    summary: "未完",
    candidates: [],
    limitations: [],
    actionPlan: plan,
  });
  assert.equal(review.status, "needs_detail");
  assert.ok(review.issues.some((s) => s.includes("候補比較")));
});

test("venue scopes survive improvement context transfer", () => {
  const { t } = scoped();
  const context = {
    loopId: "scoped-loop",
    iteration: 1,
    criteria: t.criteria,
    candidateUrls: urls,
    gaps: [],
    priorityUrls: [],
    visitedUrls: [],
    strategy: "targeted-links",
  };
  const decoded = decodeImprovementContext(
    Buffer.from(JSON.stringify(context)).toString("base64url"),
  );
  assert.deepEqual(decoded.criteria, t.criteria);
});

test("formal life actions do not require travel opening and seating checks", () => {
  const { t } = scoped();
  t.query = "人生の行動計画を正式にする";
  const answer: any = {
    summary: "次の一歩",
    candidates: [],
    limitations: [],
    actionPlan: {
      steps: [
        {
          id: "one",
          when: "今日",
          where: "自宅のノート",
          action: "希望を二つ書く",
          how: "仕事と暮らしの希望を紙へ書く",
          doneWhen: "二つの希望が見える",
          locationStatus: "unconfirmed",
          evidenceIds: [],
          costItemIds: [],
        },
      ],
      branches: [],
    },
  };
  const review = assessSpecificity(t, answer);
  assert.equal(review.mode, "next-actions");
  assert.equal(
    review.issues.some((s) => s.includes("verification.checks")),
    false,
  );
});
test("staging retains a validated itinerary and visual when candidate submission needs a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "staged-answer-"));
  const old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [];
  const url = "https://books.rakuten.co.jp/rb/18577690/";
  const plan = {
    steps: [
      {
        id: "s1",
        when: "今日",
        where: "自宅のメモ",
        action: "希望を書き出す",
        how: "二つの希望を紙に書く",
        doneWhen: "二つの希望が見える",
        locationStatus: "unconfirmed",
        evidenceIds: [],
        costItemIds: [],
      },
      {
        id: "s2",
        when: "次の週末",
        where: "自宅のメモ",
        action: "一つに絞る",
        how: "条件を比べて一つ選ぶ",
        doneWhen: "次に試す行動が一つ決まる",
        locationStatus: "unconfirmed",
        evidenceIds: [],
        costItemIds: [],
      },
    ],
    branches: [],
  };
  const visual = {
    kind: "life-roadmap",
    title: "次の週末へ",
    description: "二つの節目で考える提案",
    lanes: [{ id: "a", label: "暮らし" }],
    milestones: [
      {
        id: "m1",
        laneId: "a",
        horizon: "今日",
        title: "希望を二つ書く",
        action: "紙へ二つ書き出す",
        doneWhen: "二つの希望が見える",
        decision: "次の候補を選ぶ",
        dependsOn: [],
        basis: "proposal",
        evidenceIds: [],
      },
      {
        id: "m2",
        laneId: "a",
        horizon: "週末",
        title: "一つを試す",
        action: "候補を比較する",
        doneWhen: "試す行動が決まる",
        decision: "小さく試す",
        dependsOn: ["m1"],
        basis: "proposal",
        evidenceIds: [],
      },
    ],
  };
  visual.milestones.push({
    ...visual.milestones[1]!,
    id: "m3",
    title: "試して振り返る",
    dependsOn: ["m2"],
  });
  const stubs = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      const call = async (name: string, args: any) =>
        JSON.parse(
          (await tools.find((t) => t.name === name).execute(name, args))
            .content[0].text,
        );
      await call("open_page", { url });
      assert.equal(
        (await call("stage_plan", { actionPlan: plan })).result.staged,
        true,
      );
      assert.equal(
        (await call("stage_visual", { visualArtifact: visual })).result.staged,
        true,
      );
      assert.match(
        (
          await call("finish_task", {
            summary: "調査を止める",
            candidates: [],
            limitations: ["ユーザーの指示により候補なしで保存します"],
          })
        ).error,
        /指示していません/,
      );
      const candidate = {
        name: "書籍",
        url,
        matches: [
          {
            criterionId: "stock",
            status: "unknown",
            explanation: "在庫は未確認",
            evidenceIds: [],
          },
        ],
      };
      assert.ok(
        (
          await call("finish_task", {
            summary: "調査",
            candidates: [
              { ...candidate, url: "https://books.rakuten.co.jp/rb/99999999/" },
            ],
            limitations: [],
          })
        ).error,
      );
      assert.equal(
        (
          await call("finish_task", {
            summary: "週末の行動を提案",
            candidates: [candidate],
            limitations: ["在庫未確認"],
          })
        ).result.accepted,
        true,
      );
    }),
  ];
  try {
    const t = await runTask(
      {
        query: "人生ロードマップ",
        urls: [url],
        agent: "codex",
        maxSteps: 12,
        maxPages: 3,
        timeoutSeconds: 10,
        benchmark: {
          id: "staging",
          criteria: [
            { id: "stock", description: "在庫", required: true, weight: 1 },
          ],
          pages: [
            {
              id: "source",
              url,
              title: "書籍",
              text: "書籍の紹介と出版社の案内です。",
              links: [],
              capturedAt: new Date().toISOString(),
              truncated: false,
            },
          ],
        },
      },
      new Store(root),
    );
    assert.equal(t.error, undefined);
    assert.equal(t.answer!.actionPlan!.steps.length, 2);
    assert.equal(t.answer!.visualArtifact!.kind, "life-roadmap");
  } finally {
    for (const s of stubs) s.mock.restore();
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    await rm(root, { recursive: true, force: true });
  }
});
