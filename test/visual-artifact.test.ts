import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { newTask, runTask } from "../src/runtime.js";
import { addEvidence, validateAnswer } from "../src/evidence.js";
import {
  assessVisualArtifact,
  validateVisualArtifact,
  visualContract,
  type VisualArtifact,
} from "../src/visual-artifact.js";
import { diagnose, improveTask } from "../src/improvement.js";
import { Store } from "../src/store.js";
import { CodexAgent } from "../src/codex.js";
import { Browser } from "../src/browser.js";
import { extractPublicHtml } from "../src/html-reader.js";
import { renderAnswerHtml } from "../src/answer-html.js";
const url = "https://www.hotpepper.jp/strJ001100102/";
function fixture() {
  const task = newTask({
    query: "人生計画をロードマップにする",
    urls: [url],
    maxSteps: 30,
    maxPages: 6,
    timeoutSeconds: 15,
    agent: "codex",
  });
  task.criteria = [
    { id: "price", description: "掲載価格1000円", required: true, weight: 1 },
  ];
  task.pages = [
    {
      id: "page-1",
      url,
      title: "食事店",
      text:
        "住所 東京都台東区上野7-1-1\nアクセス 上野駅徒歩1分\n営業時間 11:00～22:00\n予算 ランチ1000円。\n座標 latitude=35.714 longitude=139.777\n" +
        "公開情報の説明です。".repeat(40),
      links: [],
      capturedAt: task.createdAt,
      truncated: false,
    },
  ];
  addEvidence(task, "page-1", "予算 ランチ1000円。");
  addEvidence(task, "page-1", "座標 latitude=35.714 longitude=139.777");
  task.answer = validateAnswer(
    task,
    "## 人生計画\n必要な条件を確認して進める。",
    [
      {
        name: "食事店",
        url,
        matches: [
          {
            criterionId: "price",
            status: "supported",
            explanation: "掲載1000円",
            evidenceIds: ["ev-1"],
          },
        ],
      },
    ],
    ["将来の実現は未確認"],
  );
  task.status = "partial";
  return task;
}
function roadmap(): VisualArtifact {
  return {
    kind: "life-roadmap",
    title: "人生のロードマップ",
    description: "架空条件の表示例。将来の予測ではなく提案。",
    lanes: [{ id: "work", label: "仕事" }],
    milestones: [0, 1, 2].map((i) => ({
      id: "m" + i,
      laneId: "work",
      horizon: ["今週", "今月", "3か月"][i]!,
      title: "条件を確認 " + i,
      action: "希望と許容条件を書き出し、勤務条件の書面を確認する",
      doneWhen: "確認表ができる",
      decision: "条件が異なるなら決定を保留する",
      dependsOn: i ? ["m" + (i - 1)] : [],
      evidenceIds: [],
      basis: "proposal",
    })),
  };
}
test("purpose selection avoids visual clutter on fact-only requests", () => {
  assert.equal(visualContract("上野の日帰り行程").kind, "journey-map");
  assert.equal(visualContract("人生計画").kind, "life-roadmap");
  for (const q of [
    "旅行リュックの容量を確認",
    "箱根旅行の宿を2件比較して",
    "転職サイトの料金は",
  ])
    assert.equal(visualContract(q).kind, "none");
});
test("roadmap references and cycles are rejected, while text is escaped by the HTML exporter", () => {
  const t = fixture(),
    a = roadmap();
  validateVisualArtifact(t, a);
  assert.equal(
    assessVisualArtifact(t, { ...t.answer!, visualArtifact: a }).status,
    "passed",
  );
  if (a.kind !== "life-roadmap") return;
  a.milestones[0]!.dependsOn = ["m2"];
  assert.throws(() => validateVisualArtifact(t, a), /循環/);
  a.milestones[0]!.dependsOn = [];
  a.milestones[0]!.laneId = "missing";
  assert.throws(() => validateVisualArtifact(t, a), /領域/);
  a.milestones[0]!.laneId = "work";
  a.milestones[0]!.basis = "source-backed";
  assert.throws(() => validateVisualArtifact(t, a), /出典/);
  a.milestones[0]!.basis = "proposal";
  a.title = '</script><img src=x onerror="alert(1)">';
  t.answer!.visualArtifact = a;
  const html = renderAnswerHtml(t);
  assert.ok(html.includes("\\u003c/script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /script-src 'sha256-/);
});
test("map coordinates must be quoted, linked to real steps, and never replace missing locations", () => {
  const t = fixture();
  t.query = "上野の日帰り行程";
  t.answer!.actionPlan = {
    steps: [0, 1].map((i) => ({
      id: "s" + i,
      when: "9:30",
      where: "店",
      action: "確認",
      how: "店頭の案内を読む",
      doneWhen: "所在地を照合した",
      locationStatus: "unconfirmed",
      evidenceIds: [],
      costItemIds: [],
    })),
    branches: [],
  };
  const a: VisualArtifact = {
    kind: "journey-map",
    title: "行程",
    description: "位置の出典付き",
    stops: [0, 1].map((i) => ({
      id: "p" + i,
      label: "場所" + i,
      stepIds: ["s" + i],
      primaryStepId: "s" + i,
      evidenceIds: [],
      optional: false,
      coordinates: { lat: 35.714, lon: 139.777, evidenceId: "ev-2" },
    })),
  };
  validateVisualArtifact(t, a);
  a.stops[0]!.coordinates!.lat = 0;
  assert.throws(() => validateVisualArtifact(t, a), /座標/);
  a.stops[0]!.coordinates = undefined;
  assert.equal(
    assessVisualArtifact(t, { ...t.answer!, visualArtifact: a }).status,
    "needs_visual",
  );
  a.stops[0]!.stepIds = ["invented"];
  assert.throws(() => validateVisualArtifact(t, a), /対応/);
});
test("JSON-LD coordinate extraction is bounded, typed and distinguishes metadata from visible text", () => {
  const page = extractPublicHtml(
    '<title>店</title><p>案内</p><script type="application/ld+json">{"geo":{"@type":"GeoCoordinates","latitude":"35.714","longitude":"139.777"},"description":"INJECTED SCRIPT TEXT"}</script>',
    url,
    ["www.hotpepper.jp"],
  );
  assert.match(
    page.text,
    /構造化データ GeoCoordinates latitude=35.714 longitude=139.777/,
  );
  assert.ok(!page.text.includes("INJECTED"));
  const bad = extractPublicHtml(
    '<script type="application/ld+json">{"@type":"GeoCoordinates","latitude":999,"longitude":139}</script>',
    url,
    ["www.hotpepper.jp"],
  );
  assert.ok(!bad.text.includes("latitude="));
});
test("common improvement loop adopts a visual artifact without changing factual evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-improve-"));
  const store = new Store(root),
    seed = fixture();
  try {
    await store.save(seed);
    assert.ok(
      diagnose(seed, seed.criteria, [url]).causes.includes(
        "insufficient_visual_artifact",
      ),
    );
    const loop = await improveTask(
      seed.id,
      { interactionMode: "auto", maxIterations: 1, timeoutSeconds: 10 },
      store,
      async (opts) => {
        const t = structuredClone(seed);
        t.id = crypto.randomUUID();
        t.parentId = opts.parentId;
        t.answer!.visualArtifact = roadmap();
        t.visualReview = assessVisualArtifact(t, t.answer!);
        await store.save(t);
        return t;
      },
    );
    assert.equal(loop.iterations[0]!.accepted, true);
    const best = await store.get(loop.bestTaskId);
    assert.deepEqual(best.evidence, seed.evidence);
    assert.ok(best.answer!.visualArtifact);
    assert.equal(diagnose(best, best.criteria, [url]).complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("actual finish_task path rejects a text-only life plan then saves the repaired interactive HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-runtime-")),
    seed = fixture(),
    old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [];
  const responses: any[] = [];
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      const call = async (name: string, args: any) =>
        JSON.parse(
          (await tools.find((t) => t.name === name).execute(name, args))
            .content[0].text,
        ).result;
      await call("plan_task", { criteria: seed.criteria });
      await call("open_page", { url });
      await call("record_evidence", {
        pageId: "page-1",
        quote: "予算 ランチ1000円。",
      });
      const input = {
        summary: "必要な条件を確認して進める",
        candidates: seed.answer!.candidates,
        limitations: ["将来の実現は未確認"],
      };
      responses.push(await call("finish_task", input));
      responses.push(
        await call("finish_task", { ...input, visualArtifact: roadmap() }),
      );
    }),
    mock.method(Browser.prototype, "init", async () => {}),
    mock.method(Browser.prototype, "close", async () => {}),
    mock.method(Browser.prototype, "open", async () =>
      structuredClone(seed.pages[0]!),
    ),
  ];
  try {
    const t = await runTask(
      {
        query: seed.query,
        urls: [url],
        agent: "codex",
        maxSteps: 30,
        maxPages: 6,
        timeoutSeconds: 15,
        deepenRounds: 0,
      },
      new Store(root),
    );
    assert.equal(responses[0].qualityGate, "visual-artifact");
    assert.equal(responses[0].accepted, false);
    assert.equal(responses[1].accepted, true);
    assert.equal(t.visualReview!.status, "passed");
    assert.ok(t.answer!.visualArtifact);
    assert.match(
      await readFile(join(root, "tasks", t.id, "answer.html"), "utf8"),
      /life-roadmap/,
    );
  } finally {
    mocks.forEach((m) => m.mock.restore());
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline model refinement is adopted while all unresolved factual conditions stay unknown", async () => {
  const { visualRefinementRunner } =
    await import("../src/visual-refinement.js");
  const root = await mkdtemp(join(tmpdir(), "visual-offline-")),
    store = new Store(root),
    seed = fixture(),
    old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  seed.criteria.push({
    id: "availability",
    description: "当日利用",
    weight: 1,
    required: true,
  });
  seed.answer!.candidates[0]!.matches.push({
    criterionId: "availability",
    status: "unknown",
    explanation: "当日の営業は未確認",
    evidenceIds: [],
  });
  seed.answer = validateAnswer(
    seed,
    seed.answer!.summary,
    seed.answer!.candidates,
    seed.answer!.limitations,
  );
  let tools: any[] = [];
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      const result = await tools[0].execute("finish_task", {
        visualArtifact: roadmap(),
      });
      assert.equal(JSON.parse(result.content[0].text).accepted, true);
    }),
    mock.method(Browser.prototype, "init", async () => {
      throw Error("Offline visual repair must not open a browser");
    }),
  ];
  try {
    await store.save(seed);
    const loop = await improveTask(
      seed.id,
      {
        interactionMode: "auto",
        maxIterations: 1,
        timeoutSeconds: 15,
        agent: "codex",
      },
      store,
      visualRefinementRunner(),
    );
    const best = await store.get(loop.bestTaskId);
    assert.equal(loop.iterations[0]!.accepted, true);
    assert.equal(loop.status, "completed_partial");
    assert.deepEqual(best.answer!.candidates, seed.answer!.candidates);
    assert.deepEqual(best.evidence, seed.evidence);
    assert.equal(best.visualRefinement!.mode, "captured-data-only");
    assert.match(
      await readFile(join(store.dir(best.id), "answer.html"), "utf8"),
      /life-roadmap/,
    );
  } finally {
    mocks.forEach((m) => m.mock.restore());
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("geocoding preserves the explicit host boundary, uses bounded GET data and caches exact-place captures", async () => {
  const { locatePlace } = await import("../src/geocoding.js");
  const root = await mkdtemp(join(tmpdir(), "geocode-contract-")),
    signal = new AbortController().signal;
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, undefined);
    return new Response('[{"name":"上野駅","lat":"35.714","lon":"139.777"}]', {
      status: 200,
    });
  };
  try {
    await assert.rejects(
      locatePlace("上野駅", ["www.hotpepper.jp"], root, signal, { fetcher }),
      /許可/,
    );
    assert.equal(calls, 0);
    const one = await locatePlace(
      "上野駅",
      ["nominatim.openstreetmap.org"],
      root,
      signal,
      { fetcher },
    );
    const two = await locatePlace(
      "上野駅",
      ["nominatim.openstreetmap.org"],
      root,
      signal,
      { fetcher },
    );
    assert.equal(calls, 1);
    assert.equal(one.capturedAt, two.capturedAt);
    assert.equal(one.text, two.text);
    await assert.rejects(
      locatePlace(
        "上野駅別照会",
        ["nominatim.openstreetmap.org"],
        root,
        signal,
        {
          fetcher: async () =>
            new Response("x", {
              status: 302,
              headers: { Location: "http://127.0.0.1/" },
            }),
        },
      ),
      /HTTP 302/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local answer endpoint serves the saved interactive artifact and preserves the origin boundary", async () => {
  const { createWorkbenchServer } = await import("../src/server.js");
  const { GoalEngine, GoalRepository } = await import("../src/goals.js");
  const root = await mkdtemp(join(tmpdir(), "visual-endpoint-")),
    store = new Store(root),
    task = fixture();
  task.answer!.visualArtifact = roadmap();
  await store.save(task);
  const engine = new GoalEngine(new GoalRepository(join(root, "goals")), 1),
    server = createWorkbenchServer(engine, store, {
      get: async () => ({ taskId: task.id }),
      shutdown: async () => {},
    } as any);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const response = await fetch(base + "/api/runs/demo/answer.html");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/html/);
    const html = await response.text();
    assert.match(html, /life-roadmap/);
    assert.match(html, /script-src 'sha256-/);
    const file = "a".repeat(64) + ".png";
    task.answerPhotos = {
      demo: {
        file,
        pageId: "p",
        imageIndex: 0,
        sourceUrl: url,
        type: "image/png",
        capturedAt: task.createdAt,
      },
    };
    await mkdir(join(store.dir(task.id), "answer-assets"), { recursive: true });
    await writeFile(
      join(store.dir(task.id), "answer-assets", file),
      "fixture-photo",
    );
    await store.save(task);
    const photo = await fetch(base + "/api/runs/demo/answer-assets/" + file);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("content-type"), "image/png");
    assert.equal(await photo.text(), "fixture-photo");
    assert.equal(
      (
        await fetch(
          base + "/api/runs/demo/answer-assets/" + "b".repeat(64) + ".png",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/runs/demo/answer-assets/" + file, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );

    assert.equal(
      (
        await fetch(base + "/api/runs/demo/answer.html", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
  } finally {
    engine.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("model exit after a visual rejection preserves the validated partial draft without claiming success", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-partial-")),
    seed = fixture(),
    old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [];
  let calls = 0;
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      const call = async (name: string, args: any) =>
        JSON.parse(
          (await tools.find((t) => t.name === name).execute(name, args))
            .content[0].text,
        ).result;
      // The model exits without submitting another answer on continuation turns.
      if (calls++) return;
      {
        await call("plan_task", { criteria: seed.criteria });
        await call("open_page", { url });
        await call("record_evidence", {
          pageId: "page-1",
          quote: "予算 ランチ1000円。",
        });
      }
      const response = await call("finish_task", {
        summary: "公開料金は1000円。将来の条件は未確認",
        candidates: seed.answer!.candidates,
        limitations: ["将来の実現は未確認"],
      });
      assert.equal(response.accepted, false);
    }),
    mock.method(Browser.prototype, "init", async () => {}),
    mock.method(Browser.prototype, "close", async () => {}),
    mock.method(Browser.prototype, "open", async () =>
      structuredClone(seed.pages[0]!),
    ),
  ];
  try {
    const t = await runTask(
      {
        query: seed.query,
        urls: [url],
        agent: "codex",
        maxSteps: 30,
        maxPages: 6,
        timeoutSeconds: 15,
        deepenRounds: 0,
      },
      new Store(root),
    );
    assert.equal(t.status, "partial");
    assert.ok(t.answer);
    assert.equal(t.visualReview!.status, "needs_visual");
    assert.match(t.answer!.limitations[0]!, /引用検証済みの草案/);
    assert.equal(t.answer!.candidates[0]!.matches[0]!.status, "supported");
    assert.ok(
      diagnose(t, t.criteria, [url]).causes.includes(
        "insufficient_visual_artifact",
      ),
    );
  } finally {
    mocks.forEach((m) => m.mock.restore());
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    await rm(root, { recursive: true, force: true });
  }
});
