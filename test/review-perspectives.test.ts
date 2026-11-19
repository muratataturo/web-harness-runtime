import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewPerspectiveStore } from "../src/review-perspectives.js";
import { Store } from "../src/store.js";
import { newTask } from "../src/runtime.js";
import { verifyStepPlan } from "../src/step-verifier.js";
import { addEvidence } from "../src/evidence.js";
import { verifyDetail } from "../src/detail-contracts.js";
import { entityKey } from "../src/sources.js";
import type { ActionPlan } from "../src/answer-plan.js";
const park = "https://mice-hamamatsu.jp/castlepark/";
function fixture() {
  const task = newTask({
    query: "浜松で一日観光して休憩する",
    urls: [park, "https://www.gakkihaku.jp/guide/"],
    maxSteps: 50,
    maxPages: 10,
    timeoutSeconds: 60,
  });
  task.pages = [
    {
      id: "p1",
      url: park,
      title: "浜松城公園",
      text:
        "浜松城公園 利用時間 公園は24時間開放。駐車場8:00〜21:30。\n時計台広場のベンチ。" +
        "公園の施設案内。".repeat(100),
      links: [],
      capturedAt: task.createdAt,
      truncated: false,
    },
  ];
  const e = addEvidence(task, "p1", "公園は24時間開放。");
  const plan: ActionPlan = {
    steps: [
      {
        id: "r1",
        kind: "rest",
        when: "09:40",
        durationMinutes: 15,
        where: "浜松城公園 時計台広場",
        venueUrl: park,
        action: "ベンチで休憩",
        how: "案内を確認する",
        doneWhen: "15分休む",
        evidenceIds: [e.id],
        costItemIds: [],
      },
    ],
    branches: [],
    stepChecks: [
      {
        id: "open",
        stepId: "r1",
        kind: "opening",
        venueUrl: park,
        evidenceIds: [e.id],
        access: "always-open",
      },
    ],
  };
  return { task, plan };
}
test("24-hour public access requires same-park evidence, never parking hours or a building's hours", () => {
  const { task, plan } = fixture();
  assert.equal(verifyStepPlan(task, plan).unknown, 0);
  assert.equal(verifyDetail(task.pages[0]!).status, "verified");
  const parking = addEvidence(task, "p1", "駐車場8:00〜21:30。");
  plan.steps[0]!.evidenceIds.push(parking.id);
  plan.stepChecks![0]!.evidenceIds = [parking.id];
  assert.equal(verifyStepPlan(task, plan).unknown, 1);
  plan.stepChecks![0]!.evidenceIds = ["ev-1"];
  plan.stepChecks![0]!.opens = "08:00";
  plan.stepChecks![0]!.closes = "21:30";
  assert.equal(verifyStepPlan(task, plan).unknown, 1);
  delete plan.stepChecks![0]!.opens;
  delete plan.stepChecks![0]!.closes;
  task.pages[0]!.url = "https://www.gakkihaku.jp/guide/";
  task.evidence[0]!.url = task.pages[0]!.url;
  plan.steps[0]!.venueUrl = task.pages[0]!.url;
  plan.stepChecks![0]!.venueUrl = task.pages[0]!.url;
  assert.ok(
    verifyStepPlan(task, plan).checks.some(
      (c) => c.kind === "opening" && c.status !== "passed",
    ),
  );
  assert.notEqual(
    entityKey(park),
    entityKey("https://www.city.hamamatsu.shizuoka.jp/maps/c-castle.html"),
  );
  assert.equal(
    entityKey(park),
    entityKey(
      "https://www.entetsuassist-dms.com/hamamatsu-jyo/news/detail/363",
    ),
  );
  assert.notEqual(
    entityKey(park),
    entityKey("https://mice-hamamatsu.jp/other/"),
  );
});
test("user correction perspectives persist across runs; host reflections recur as procedure, never venue facts or approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-memory-"));
  try {
    const store = new Store(root),
      memory = new ReviewPerspectiveStore(store),
      { task, plan } = fixture();
    const local = {
      id: "seat-specific",
      domain: "trip",
      origin: "user-correction",
      concern: "席の条件を区別する",
      question: "休憩と空席の条件を区別したか",
      action: "公開情報を調べ直し空席は当日判断として分離する",
    };
    await memory.add(local);
    await assert.rejects(memory.add(local));
    await assert.rejects(memory.add({ ...local, id: "rest-opening-scope" }));
    await assert.rejects(memory.add({ ...local, id: "../escape" }));
    await assert.rejects(memory.add({ ...local, origin: "model-generated" }));
    task.reviewContext = await new ReviewPerspectiveStore(
      new Store(root),
    ).context(task);
    assert.ok(
      task.reviewContext.perspectives.some(
        (p) => p.id === "rest-opening-scope",
      ),
    );
    assert.ok(task.reviewContext.perspectives.some((p) => p.id === local.id));
    assert.equal(task.reviewContext.reusableFacts, false);
    delete plan.stepChecks;
    task.answer = {
      summary: "草案",
      candidates: [],
      limitations: [],
      actionPlan: plan,
    };
    const r = await memory.reflect(task);
    assert.equal(
      r!.results.find((x) => x.id === "rest-opening-scope")!.status,
      "needs-attention",
    );
    assert.equal(
      r!.results.find((x) => x.id === "visual-appeal")!.status,
      "not-evaluated",
    );
    const next = await new ReviewPerspectiveStore(new Store(root)).context(
      task,
    );
    assert.equal(
      next.pastChecks.find((p) => p.id === "rest-opening-scope")!
        .needsAttentionCount,
      1,
    );
    assert.equal(r!.autoPromoted, false);
    assert.equal(
      (await readdir(join(root, "review-perspectives", "approved"))).length,
      1,
    );
    const unrelated = newTask({
      query: "本の価格を調べる",
      urls: ["https://books.rakuten.co.jp/rb/1234567/"],
      maxSteps: 5,
      maxPages: 5,
      timeoutSeconds: 30,
    });
    assert.equal((await memory.context(unrelated)).perspectives.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admission retrieval accepts yen symbols with admission labels, while public access negation stays unknown", () => {
  const { task, plan } = fixture();
  task.pages[0].text += "\n公園は24時間開放されていません。";
  const denied = addEvidence(task, "p1", "公園は24時間開放されていません。");
  plan.steps[0].evidenceIds.push(denied.id);
  plan.stepChecks[0].evidenceIds = [denied.id];
  assert.equal(verifyStepPlan(task, plan).unknown, 1);
  const venue = {
    ...task.pages[0],
    url: "https://www.act-okura.co.jp/facilities/gallery/",
    text:
      "ご利用案内 営業時間11:00〜18:00\n一般料金\n大人（中学生以上）￥1,200\n" +
      "展望回廊の案内。".repeat(100),
  };
  assert.equal(verifyDetail(venue).status, "verified");
  venue.text =
    "ご利用案内 営業時間11:00〜18:00\nおみやげ￥1,200\n" +
    "展望回廊の案内。".repeat(100);
  assert.ok(verifyDetail(venue).missingFields.includes("admission"));
});

test("reflection recall chooses recent records rather than alphabetically late task IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-recency-"));
  try {
    const store = new Store(root),
      memory = new ReviewPerspectiveStore(store),
      { task } = fixture();
    task.reviewContext = await memory.context(task);
    await memory.reflect(task);
    const dir = join(root, "review-perspectives", "reflections"),
      now = Date.now();
    for (let i = 0; i < 70; i++) {
      const p = join(dir, String(i).padStart(3, "0") + ".json");
      await writeFile(
        p,
        JSON.stringify({
          version: 1,
          scope: "host-procedural-reflection",
          createdAt: new Date(now - i * 1000).toISOString(),
          results: [
            {
              id: "rest-opening-scope",
              status: i === 0 ? "needs-attention" : "checked",
            },
          ],
        }),
      );
      await utimes(p, new Date(now - i * 1000), new Date(now - i * 1000));
    }
    const next = await memory.context(task);
    assert.equal(
      next.pastChecks.find((p) => p.id === "rest-opening-scope")
        .needsAttentionCount,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
