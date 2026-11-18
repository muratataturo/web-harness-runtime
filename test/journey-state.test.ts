import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTask } from "../src/runtime.js";
import { addEvidence } from "../src/evidence.js";
import {
  assessJourneyState,
  journeyPolicy,
  placeKey,
  endpointKey,
  straightLineMeters,
  type JourneyObservation,
} from "../src/journey-state.js";
import { JourneyMemoryStore } from "../src/journey-memory.js";
import { Store } from "../src/store.js";
import type { ActionPlan } from "../src/answer-plan.js";
import { renderJourneyState } from "../src/journey-state-html.js";
const url = "https://www.gakkihaku.jp/guide/";
function fixture() {
  const task = newTask({
    query: "浜松で09:00〜20:00、移動距離も考えてゆっくり一日遊ぶ",
    urls: [url, "https://nominatim.openstreetmap.org/"],
    maxSteps: 80,
    maxPages: 12,
    timeoutSeconds: 60,
  });
  task.pages = [
    {
      id: "p1",
      url: "https://nominatim.openstreetmap.org/search?q=A",
      title: "地点座標",
      text: '{"lat":35,"lon":137,"display_name":"駅A"}\n{"lat":35.01,"lon":137.01,"display_name":"博物館B"}',
      links: [],
      capturedAt: task.createdAt,
      truncated: false,
    },
  ];
  addEvidence(task, "p1", '{"lat":35,"lon":137,"display_name":"駅A"}');
  addEvidence(
    task,
    "p1",
    '{"lat":35.01,"lon":137.01,"display_name":"博物館B"}',
  );
  task.pages.push({
    id: "p2",
    url,
    title: "博物館B",
    text: "博物館B 静岡県浜松市の施設",
    links: [],
    capturedAt: task.createdAt,
    truncated: false,
  });
  const step = (id: string, kind: string, minutes: number, when: string) => ({
    id,
    kind,
    when,
    durationMinutes: minutes,
    where: "博物館B",
    action: kind === "rest" ? "椅子でひと休み" : "展示の音を聴いて比べる",
    how: "入口の案内を確認する",
    doneWhen: "案内を読んでから進む",
    locationStatus: "evidence-linked" as const,
    evidenceIds: ["ev-2"],
    costItemIds: [],
  });
  const plan: ActionPlan = {
    steps: [
      step("walk", "move", 45, "09:00"),
      step("visit", "activity", 60, "09:45"),
      step("rest", "rest", 15, "10:45"),
    ],
    branches: [],
    journeyState: {
      version: 1,
      places: [
        { id: "a", label: "駅A", lat: 35, lon: 137, evidenceIds: ["ev-1"] },
        {
          id: "b",
          label: "博物館B",
          venueUrl: url,
          lat: 35.01,
          lon: 137.01,
          evidenceIds: ["ev-2"],
        },
      ],
      legs: [
        {
          stepId: "walk",
          fromPlaceId: "a",
          toPlaceId: "b",
          mode: "walk",
          movementMinutes: 40,
          waitMinutes: 0,
          boardingMinutes: 0,
          bufferMinutes: 5,
          evidenceIds: [],
        },
      ],
      stays: [
        {
          id: "visit-stay",
          placeId: "b",
          stepIds: ["visit"],
          category: "museum",
        },
        { id: "rest-stay", placeId: "b", stepIds: ["rest"], category: "rest" },
      ],
    },
  };
  return { task, plan };
}
test("explicit 09–20 has a full-day journey policy and straight-line distance is only an estimate", () => {
  const { task, plan } = fixture();
  const r = assessJourneyState(task, plan);
  assert.equal(task.journeyPolicy?.fullDay, true);
  assert.equal(r.status, "passed");
  assert.ok(r.walkingMetersEstimate > 1800 && r.walkingMetersEstimate < 2000);
  assert.ok(r.legs[0]!.basis.includes("道路距離は未確認"));
  assert.equal(r.historySamples, 0);
  assert.ok(r.warnings.some((w) => w.includes("実績")));
  assert.equal(journeyPolicy("価格を調べる"), undefined);
  assert.equal(journeyPolicy("一日10:00〜15:00遊ぶ"), undefined);
  assert.equal(
    straightLineMeters({ lat: 35, lon: 137 }, { lat: 35, lon: 137 }),
    0,
  );
});
test("too-short walking time and incompatible time components require reallocation", () => {
  const { task, plan } = fixture();
  plan.steps[0]!.durationMinutes = 5;
  plan.journeyState!.legs[0]!.movementMinutes = 2;
  plan.journeyState!.legs[0]!.bufferMinutes = 3;
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("移動本体")),
  );
  plan.steps[0]!.durationMinutes = 10;
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("合計")),
  );
});
test("missing coordinates remain unknown and an unrelated numeric substring cannot prove a location", () => {
  const { task, plan } = fixture();
  plan.journeyState!.places[1]!.lat = 5.01;
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("座標")),
  );
  delete plan.journeyState!.places[1]!.lat;
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("不足")),
  );
});
test("indoor vertical travel has overhead even at the same representative coordinate", () => {
  const { task, plan } = fixture();
  const state = plan.journeyState!;
  state.places[0] = { ...state.places[1]!, id: "a", floor: 2 };
  state.places[1]!.floor = 45;
  state.legs[0]!.mode = "indoor";
  state.legs[0]!.movementMinutes = 1;
  state.legs[0]!.bufferMinutes = 3;
  plan.steps[0]!.durationMinutes = 4;
  const r = assessJourneyState(task, plan);
  assert.equal(r.legs[0]!.recommendedMinutes, 10);
  assert.ok(r.issues.some((s) => s.includes("10分以上")));
});
test("short museum visits and queues disguised as rest do not satisfy dwell or recovery", () => {
  const { task, plan } = fixture();
  plan.steps[1]!.durationMinutes = 10;
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) =>
      s.includes("正味滞在10分"),
    ),
  );
  plan.steps[1]!.durationMinutes = 150;
  plan.steps[2]!.action = "入店待機の行列";
  const r = assessJourneyState(task, plan);
  assert.ok(r.issues.some((s) => s.includes("待ちや移動")));
  assert.ok(r.issues.some((s) => s.includes("待ち行列を休憩")));
});
test("history matches exact venue, direction, mode and pace; generated proposals never calibrate time", () => {
  const { task, plan } = fixture();
  const state = plan.journeyState!,
    date = new Date(Date.now() - 86400000).toISOString();
  const o: JourneyObservation = {
    id: "h1",
    kind: "dwell",
    basis: "user-observed",
    placeKey: placeKey(state.places[1]!),
    category: "museum",
    minutes: 110,
    pacing: "relaxed",
    occurredAt: date,
    sourceNote: "本人が現地で時刻を記録した",
  };
  task.journeyMemory = {
    version: 1,
    observations: [o],
    priorPlans: [{ taskId: "old", status: "succeeded", steps: 9, minutes: 1 }],
  };
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("基準110分")),
  );
  task.journeyMemory.observations[0]!.pacing = "active";
  assert.equal(assessJourneyState(task, plan).stays[0]!.minimumMinutes, 60);
  const leg = state.legs[0]!,
    a = state.places[0]!,
    b = state.places[1]!;
  task.journeyMemory.observations = [
    {
      ...o,
      id: "h2",
      pacing: "relaxed",
      kind: "travel",
      fromKey: placeKey(b),
      toKey: placeKey(a),
      mode: "walk",
      minutes: 200,
    },
  ];
  assert.equal(assessJourneyState(task, plan).legs[0]!.historySamples, 0);
  task.journeyMemory.observations[0]!.fromKey = placeKey(a);
  task.journeyMemory.observations[0]!.toKey = placeKey(b);
  assert.equal(assessJourneyState(task, plan).legs[0]!.recommendedMinutes, 200);
  assert.equal(leg.mode, "walk");
});
test("a changed plan is rechecked and state appears as a qualified estimate in HTML", () => {
  const { task, plan } = fixture();
  const first = assessJourneyState(task, plan);
  task.answer = {
    summary: "提案",
    candidates: [],
    limitations: [],
    actionPlan: plan,
  };
  assert.match(renderJourneyState(task), /初期の歩速/);
  assert.match(renderJourneyState(task), /距離見積/);
  plan.steps[1]!.durationMinutes = 5;
  const after = assessJourneyState(task, plan);
  assert.notEqual(first.planHash, after.planHash);
  assert.equal(after.status, "needs_detail");
});
test("the memory store imports caller observations without promoting or overwriting generated plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "journey-memory-"));
  try {
    const store = new Store(root),
      memory = new JourneyMemoryStore(store),
      { task, plan } = fixture();
    task.answer = {
      summary: "生成した案",
      candidates: [],
      limitations: [],
      actionPlan: plan,
    };
    task.status = "partial";
    await memory.rememberPlan(task);
    await memory.rememberPlan(task);
    assert.equal((await memory.read()).observations.length, 0);
    assert.equal((await memory.read()).priorPlans.length, 1);
    const o = {
      id: "observed-1",
      kind: "dwell",
      basis: "user-observed",
      placeKey: placeKey(plan.journeyState!.places[1]!),
      category: "museum",
      minutes: 110,
      pacing: "relaxed",
      occurredAt: new Date(Date.now() - 86400000).toISOString(),
      sourceNote: "自分で入退場時刻を記録",
    };
    await memory.importObservations([o]);
    assert.equal((await memory.read(task)).observations.length, 1);
    await assert.rejects(memory.importObservations([o]), /EEXIST/);
    await assert.rejects(
      memory.importObservations([{ ...o, id: "bad", basis: "planned" }]),
      /形式/,
    );
    await assert.rejects(
      memory.importObservations([
        { ...o, id: "future", occurredAt: "2999-01-01" },
      ]),
      /過去/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ontology transitions reject disconnected legs and unannounced changes of venue", () => {
  const { task, plan } = fixture();
  const state = plan.journeyState!;
  state.stays[1]!.placeId = "a";
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("移動なし")),
  );
  state.stays[1]!.placeId = "b";
  plan.steps.push({ ...plan.steps[0]!, id: "back", when: "11:00" });
  state.legs.push({ ...state.legs[0]!, stepId: "back" });
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) =>
      s.includes("つながりません"),
    ),
  );
});

test("floors within one venue form one visit; indoor transfers and breaks are excluded from net dwell", () => {
  const { task, plan } = fixture();
  const state = plan.journeyState!;
  state.places.push({ ...state.places[1]!, id: "lower", floor: -1 });
  state.places[1]!.floor = 1;
  const visit = plan.steps[1]!,
    rest = plan.steps[2]!;
  visit.durationMinutes = 30;
  plan.steps = [
    plan.steps[0]!,
    visit,
    { ...plan.steps[0]!, id: "floor", when: "10:15", durationMinutes: 8 },
    { ...visit, id: "lower-visit", when: "10:23", durationMinutes: 35 },
    { ...rest, when: "10:58" },
  ];
  state.legs.push({
    stepId: "floor",
    fromPlaceId: "b",
    toPlaceId: "lower",
    mode: "indoor",
    movementMinutes: 5,
    waitMinutes: 0,
    boardingMinutes: 0,
    bufferMinutes: 3,
    evidenceIds: [],
  });
  state.stays[1]!.placeId = "lower";
  state.stays.push({
    id: "lower-stay",
    placeId: "lower",
    stepIds: ["lower-visit"],
    category: "museum",
  });
  const r = assessJourneyState(task, plan);
  assert.equal(r.stays.filter((s) => s.category === "museum").length, 1);
  assert.equal(r.stays.find((s) => s.category === "museum")!.minutes, 65);
  assert.equal(r.status, "passed", JSON.stringify(r.issues));
});

test("outdoor travel cannot be disguised as indoor to avoid missing distance data", () => {
  const { task, plan } = fixture();
  plan.journeyState!.legs[0]!.mode = "indoor";
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) => s.includes("屋外広場")),
  );
});

test("stale route-provider estimates and future observations do not calibrate a new trip", () => {
  const { task, plan } = fixture(),
    state = plan.journeyState!;
  const o: JourneyObservation = {
    id: "route-old",
    kind: "travel",
    basis: "provider-estimate",
    fromKey: placeKey(state.places[0]!),
    toKey: placeKey(state.places[1]!),
    mode: "walk",
    minutes: 200,
    pacing: "relaxed",
    occurredAt: new Date(Date.now() - 9 * 86400000).toISOString(),
    sourceNote: "経路提供元の過去の見積",
  };
  task.journeyMemory = { version: 1, observations: [o], priorPlans: [] };
  assert.equal(assessJourneyState(task, plan).legs[0]!.historySamples, 0);
  o.basis = "user-observed";
  assert.equal(assessJourneyState(task, plan).legs[0]!.historySamples, 1);
  o.occurredAt = "2999-01-01";
  assert.equal(assessJourneyState(task, plan).legs[0]!.historySamples, 0);
});

test("floor-specific route history is distinct from venue-level dwell history", () => {
  const { task, plan } = fixture(),
    state = plan.journeyState!;
  state.places[0] = { ...state.places[1]!, id: "a", floor: 2 };
  state.places[1]!.floor = 45;
  assert.equal(placeKey(state.places[0]!), placeKey(state.places[1]!));
  assert.notEqual(endpointKey(state.places[0]!), endpointKey(state.places[1]!));
  state.legs[0]!.mode = "indoor";
  task.journeyMemory = {
    version: 1,
    priorPlans: [],
    observations: [
      {
        id: "elevator-actual",
        kind: "travel",
        basis: "user-observed",
        fromKey: endpointKey(state.places[0]!),
        toKey: endpointKey(state.places[1]!),
        mode: "indoor",
        pacing: "relaxed",
        minutes: 18,
        occurredAt: new Date(Date.now() - 86400000).toISOString(),
        sourceNote: "本人が2階から45階の移動を記録",
      },
    ],
  };
  assert.equal(assessJourneyState(task, plan).legs[0]!.recommendedMinutes, 18);
});

test("published durations require the exact amount and direction in the same quotation", () => {
  const { task, plan } = fixture();
  task.pages.push({
    id: "route",
    url,
    title: "経路案内",
    text: "駅Aから博物館Bへ徒歩25分。博物館Bから駅Aへ徒歩35分。",
    links: [],
    capturedAt: task.createdAt,
    truncated: false,
  });
  addEvidence(task, "route", "駅Aから博物館Bへ徒歩25分。");
  const leg = plan.journeyState!.legs[0]!;
  leg.publishedMinutes = 25;
  leg.evidenceIds = ["ev-3"];
  assert.ok(
    !assessJourneyState(task, plan).issues.some((s) =>
      s.includes("掲載移動時間"),
    ),
  );
  leg.publishedMinutes = 35;
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) =>
      s.includes("掲載移動時間"),
    ),
  );
  leg.publishedMinutes = 25;
  [leg.fromPlaceId, leg.toPlaceId] = [leg.toPlaceId, leg.fromPlaceId];
  assert.ok(
    assessJourneyState(task, plan).issues.some((s) =>
      s.includes("掲載移動時間"),
    ),
  );
});

test("an explicit long day is not capped to the relaxed afternoon activity count", async () => {
  const { tripRhythmIssues } = await import("../src/trip-brief.js");
  const steps = ["09:00", "11:00", "14:00", "17:00"].map((when, i) => ({
    when,
    durationMinutes: 60,
    kind: "activity",
    where: "施設" + i,
    action: "具体的に展示を観察する",
  }));
  assert.ok(
    !tripRhythmIssues("09:00〜20:00で一日ゆっくり遊ぶ", { steps }).some((s) =>
      s.includes("2枠"),
    ),
  );
  const { publicSocialRequested } = await import("../src/sources.js");
  assert.equal(
    publicSocialRequested("予約・購入・問い合わせ・SNS調査は行いません"),
    false,
  );
  assert.equal(publicSocialRequested("SNS調査は行わない"), false);
  assert.equal(publicSocialRequested("SNSの人気も調べて"), true);
});

test("existing saved tasks bootstrap as planned history, never as observed trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "journey-bootstrap-"));
  try {
    const store = new Store(root),
      { task, plan } = fixture();
    task.answer = {
      summary: "過去の計画",
      candidates: [],
      limitations: [],
      actionPlan: plan,
    };
    task.status = "partial";
    await store.save(task);
    const next = { ...task, id: "another-task" };
    const memory = await new JourneyMemoryStore(store).read(next);
    assert.equal(memory.priorPlans.length, 1);
    assert.equal(memory.priorPlans[0]!.visits?.length, 2);
    assert.equal(memory.observations.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the self-improvement judge rewards consistent state without trading away verified facts", async () => {
  const { improvementAdvances } = await import("../src/improvement.js");
  const base = {
    verifiedDetails: 2,
    supportedRequired: 4,
    supportedOptional: 0,
    achievements: ["fact:confirmed"],
    complete: false,
  };
  assert.equal(
    improvementAdvances(
      base as any,
      {
        ...base,
        achievements: [...base.achievements, "journey:consistent-plan-state"],
      } as any,
    ),
    true,
  );
  assert.equal(
    improvementAdvances(
      base as any,
      {
        ...base,
        verifiedDetails: 1,
        achievements: [...base.achievements, "journey:consistent-plan-state"],
      } as any,
    ),
    false,
  );
  assert.equal(
    improvementAdvances(
      {
        ...base,
        achievements: [...base.achievements, "journey:covered-day-window"],
      } as any,
      base as any,
    ),
    false,
  );
});
