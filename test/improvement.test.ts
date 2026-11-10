import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  improveTask,
  diagnose,
  ImprovementStore,
  improvementPlan,
} from "../src/improvement.js";
import { newTask, type RunOptions } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { addEvidence, validateAnswer } from "../src/evidence.js";
const urls = [
  "https://item.rakuten.co.jp/shop/a/",
  "https://item.rakuten.co.jp/shop/b/",
];
const criteria = [
  { id: "capacity", description: "容量40L", required: true, weight: 5 },
];
function fixture(supported = [false, false], options?: RunOptions) {
  const task = newTask(
    options ?? {
      query: "この2商品の容量40Lを確認",
      urls,
      maxSteps: 30,
      maxPages: 6,
      timeoutSeconds: 60,
      agent: "codex",
    },
  );
  task.criteria = structuredClone(criteria);
  task.pages = urls.map((url, i) => ({
    id: `page-${i + 1}`,
    url,
    title: "旅行リュック",
    text: `対象商品の販売価格: 6990円\n商品詳細 サイズ 素材 ショップABC\n${supported[i] ? "容量は40Lです。" : "容量は確認中です。"}\n${"商品説明です。".repeat(50)}`,
    links: [{ url: url + "?view=detail", text: "容量の詳細" }],
    capturedAt: new Date().toISOString(),
    truncated: false,
  }));
  const candidates = urls.map((url, i) => ({
    name: "商品" + i,
    url,
    matches: [
      {
        criterionId: "capacity",
        status: supported[i] ? ("supported" as const) : ("unknown" as const),
        explanation: supported[i] ? "40Lと記載" : "未確認",
        evidenceIds: supported[i]
          ? [addEvidence(task, `page-${i + 1}`, "容量は40Lです。").id]
          : [],
      },
    ],
  }));
  task.answer = validateAnswer(task, "比較", candidates, []);
  task.status = supported.every(Boolean) ? "succeeded" : "partial";
  return task;
}
async function setup(supported = [false, false]) {
  const dir = await mkdtemp(join(tmpdir(), "improvement-test-"));
  const store = new Store(dir);
  const seed = fixture(supported);
  await store.save(seed);
  return {
    store,
    seed,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
test("improvement independently verifies quotes and ignores saved succeeded/eligible flags", () => {
  const t = fixture();
  t.status = "succeeded";
  t.answer!.candidates.forEach((c) => (c.eligible = true));
  const d = diagnose(t, criteria, urls);
  assert.equal(d.complete, false);
  assert.equal(d.supportedRequired, 0);
  const forged = fixture([true, true]);
  forged.pages[0]!.text = forged.pages[0]!.text.replace(
    "容量は40Lです。",
    "容量は確認中です。",
  );
  assert.equal(diagnose(forged, criteria, urls).complete, false);
});
test("changed contracts and dropped candidates cannot pass diagnosis", () => {
  const t = fixture([true, true]);
  t.criteria[0]!.required = false;
  assert.match(diagnose(t, criteria, urls).validationError!, /変更/);
  const omitted = fixture([true, true]);
  omitted.answer!.candidates.pop();
  assert.equal(diagnose(omitted, criteria, urls).complete, false);
});
test("loop applies a new plan, accepts verified improvements and stops on full completion", async () => {
  const f = await setup();
  let calls = 0;
  try {
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 4 },
      f.store,
      async (o, s) => {
        calls++;
        assert.equal(o.query, f.seed.query);
        assert.deepEqual(o.improvement!.criteria, criteria);
        assert.deepEqual(o.improvement!.candidateUrls, urls);
        assert.ok(o.improvement!.priorityUrls.length > 0);
        const t = fixture(calls === 1 ? [true, false] : [true, true], o);
        await s!.save(t);
        return t;
      },
    );
    assert.equal(calls, 2, JSON.stringify(loop));
    assert.equal(loop.status, "succeeded");
    assert.equal(loop.best.supportedRequired, 2);
    assert.equal(
      loop.iterations.every((i) => i.accepted),
      true,
    );
    assert.equal(loop.promotedStrategies.length, 2);
    assert.equal(
      (await new ImprovementStore(f.store).get(loop.id)).bestTaskId,
      loop.bestTaskId,
    );
    assert.equal((await f.store.get(f.seed.id)).status, "partial");
  } finally {
    await f.cleanup();
  }
});
test("same-score regression across candidates cannot replace a verified best result", async () => {
  const f = await setup([true, false]);
  try {
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 4 },
      f.store,
      async (o, s) => {
        const t = fixture([false, true], o);
        await s!.save(t);
        return t;
      },
    );
    assert.equal(loop.status, "needs_input");
    assert.equal(loop.iterations.length, 2);
    assert.equal(loop.bestTaskId, f.seed.id);
    assert.equal(
      loop.iterations.some((i) => i.accepted),
      false,
    );
    assert.equal(loop.questions.length, 1);
    assert.ok(loop.questions[0]!.missing.includes("容量40L"));
  } finally {
    await f.cleanup();
  }
});
test("quota/auth failures stop after one attempt and never switch engines/models", async () => {
  const f = await setup();
  let calls = 0;
  try {
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 5 },
      f.store,
      async (o, s) => {
        calls++;
        assert.equal(o.agent, "codex");
        const t = fixture(undefined, o);
        t.status = "failed";
        t.answer = undefined;
        t.failure = {
          kind: "quota_exhausted",
          retryable: false,
          action: "利用枠回復を待つ",
        };
        await s!.save(t);
        return t;
      },
    );
    assert.equal(calls, 1);
    assert.equal(loop.status, "blocked");
    assert.match(loop.stopReason!, /回復/);
  } finally {
    await f.cleanup();
  }
});
test("a complete baseline spends no inference and invalid budgets fail before a runner", async () => {
  const f = await setup([true, true]);
  let calls = 0;
  try {
    const runner = async (o: RunOptions) => {
      calls++;
      return fixture(undefined, o);
    };
    const loop = await improveTask(f.seed.id, {}, f.store, runner);
    assert.equal(loop.status, "succeeded");
    assert.equal(calls, 0);
    for (const maxIterations of [0, 6, NaN, 1.5])
      await assert.rejects(
        improveTask(f.seed.id, { maxIterations }, f.store, runner),
      );
    await assert.rejects(
      improveTask(f.seed.id, { timeoutSeconds: 3601 }, f.store, runner),
    );
    assert.equal(calls, 0);
    assert.throws(() => new ImprovementStore(f.store).dir("../bad"));
  } finally {
    await f.cleanup();
  }
});
test("cancelled loop preserves diagnostics and never starts a model", async () => {
  const f = await setup();
  const c = new AbortController();
  c.abort();
  let calls = 0;
  try {
    const loop = await improveTask(
      f.seed.id,
      { signal: c.signal },
      f.store,
      async (o) => {
        calls++;
        return fixture(undefined, o);
      },
    );
    assert.equal(loop.status, "cancelled");
    assert.equal(calls, 0);
    assert.equal(loop.bestTaskId, f.seed.id);
  } finally {
    await f.cleanup();
  }
});
test("whole-loop timeout aborts the current task and saves the original best", async () => {
  const f = await setup();
  try {
    const loop = await improveTask(
      f.seed.id,
      { timeoutSeconds: 1 },
      f.store,
      async (o) => {
        await new Promise<void>((resolve) =>
          o.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        const t = fixture(undefined, o);
        t.status = "cancelled";
        return t;
      },
    );
    assert.equal(loop.status, "timed_out");
    assert.equal(loop.bestTaskId, f.seed.id);
  } finally {
    await f.cleanup();
  }
});
test("discovery uses actual same-entity links and skips visited/tracking-equivalent links", async () => {
  const f = await setup();
  try {
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      async (o, s) => {
        const t = fixture(undefined, o);
        await s!.save(t);
        return t;
      },
    );
    const t = structuredClone(f.seed);
    t.pages.push({
      ...t.pages[0]!,
      id: "detail",
      url: urls[0] + "?view=detail&utm_source=old",
    });
    t.pages[0]!.links.push(
      { url: "https://attacker.invalid/", text: "容量" },
      { url: urls[1] + "other/", text: "他商品" },
    );
    const p = improvementPlan(loop, [t], 2);
    assert.equal(p.priorityUrls.includes(urls[0] + "?view=detail"), false);
    assert.equal(
      p.priorityUrls.some((u) => u.includes("attacker")),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("replacement requires explicit permission, the same contract and at least the original count", async () => {
  const f = await setup();
  const runner = async (o: RunOptions, s?: Store) => {
    const t = fixture([true, true], o);
    const replace = (u: string) =>
      u
        .replace("/shop/a/", "/shop/item-c/")
        .replace("/shop/b/", "/shop/item-d/");
    t.pages.forEach((p) => (p.url = replace(p.url)));
    t.evidence.forEach((e) => (e.url = replace(e.url)));
    t.answer!.candidates.forEach((c) => (c.url = replace(c.url)));
    await s!.save(t);
    return t;
  };
  try {
    const fixed = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      runner,
    );
    assert.notEqual(fixed.status, "succeeded");
    const permitted = await improveTask(
      f.seed.id,
      { maxIterations: 1, allowReplacements: true },
      f.store,
      runner,
    );
    assert.equal(permitted.status, "succeeded");
    assert.equal(permitted.best.supportedRequired, 2);
    assert.deepEqual(permitted.candidateUrls, urls);
    const one = fixture([true, true]);
    one.answer!.candidates.pop();
    assert.equal(diagnose(one, criteria, urls, true).complete, false);
  } finally {
    await f.cleanup();
  }
});
test("human supplied URLs are validated and prioritized but never treated as evidence", async () => {
  const f = await setup();
  try {
    for (const url of [
      "https://attacker.invalid/",
      "https://item.rakuten.co.jp/shop/other/",
      "http://item.rakuten.co.jp/shop/a/",
    ])
      await assert.rejects(
        improveTask(f.seed.id, { additionalUrls: [url] }, f.store),
      );
    const link = urls[0] + "?view=detail";
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 1, additionalUrls: [link] },
      f.store,
      async (o, s) => {
        assert.equal(o.improvement!.priorityUrls[0], link);
        assert.equal(o.improvement!.visitedUrls.includes(urls[0]!), true);
        const t = fixture(undefined, o);
        await s!.save(t);
        return t;
      },
    );
    assert.equal(loop.best.supportedRequired, 0);
    assert.equal(loop.status, "needs_input");
  } finally {
    await f.cleanup();
  }
});
test("small body changes on already visited URLs do not count as new research", async () => {
  const f = await setup();
  try {
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      async (o, s) => {
        const t = fixture(undefined, o);
        t.pages.forEach((p) => (p.text += "動的な更新表記です。"));
        await s!.save(t);
        return t;
      },
    );
    assert.equal(loop.iterations[0]!.newPages, 0);
  } finally {
    await f.cleanup();
  }
});
test("fresh contradictory evidence corrects an old result instead of recommending stale data", async () => {
  const f = await setup([true, false]);
  try {
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      async (o, s) => {
        const t = fixture([true, false], o);
        t.pages[0]!.text = t.pages[0]!.text.replace(
          "容量は40Lです。",
          "容量は10Lです。",
        );
        t.evidence[0]!.quote = "容量は10Lです。";
        t.answer!.candidates[0]!.matches[0]!.status = "contradicted";
        t.answer!.candidates[0]!.matches[0]!.explanation =
          "40L条件に対し10Lと確認";
        await s!.save(t);
        return t;
      },
    );
    assert.notEqual(loop.bestTaskId, f.seed.id);
    assert.equal(loop.best.supportedRequired, 0);
    assert.equal(loop.iterations[0]!.corrections!.length, 1);
    assert.equal(loop.promotedStrategies.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("only a verified successful recipe is reused for the same goal and contract", async () => {
  const f = await setup();
  const runner = async (o: RunOptions, s?: Store) => {
    const t = fixture([true, true], o);
    await s!.save(t);
    return t;
  };
  try {
    const first = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      runner,
    );
    const second = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      runner,
    );
    assert.equal(second.learnedFrom, first.id);
    assert.equal(second.learnedStrategy, "targeted-links");
  } finally {
    await f.cleanup();
  }
});
test("corrupt evidence in a previous success cannot become a learned recipe", async () => {
  const f = await setup();
  const runner = async (o: RunOptions, s?: Store) => {
    const t = fixture([true, true], o);
    await s!.save(t);
    return t;
  };
  try {
    const first = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      runner,
    );
    const old = await f.store.get(first.bestTaskId);
    old.pages[0]!.text = "内容が失われています";
    await f.store.save(old);
    const second = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      runner,
    );
    assert.equal(second.learnedFrom, undefined);
  } finally {
    await f.cleanup();
  }
});
test("an unfinished answer can recover from already captured individual pages", async () => {
  const f = await setup();
  try {
    f.seed.answer = undefined;
    f.seed.status = "partial";
    await f.store.save(f.seed);
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      async (o, s) => {
        const t = fixture([true, true], o);
        await s!.save(t);
        return t;
      },
    );
    assert.equal(loop.status, "succeeded");
    assert.equal(loop.minimumCandidates, 2);
    assert.ok(loop.baseline.validationError);
  } finally {
    await f.cleanup();
  }
});
test("explicit requested candidate count cannot be reduced to the baseline's smaller answer", async () => {
  const f = await setup([true, true]);
  try {
    f.seed.answer!.candidates.pop();
    await f.store.save(f.seed);
    const loop = await improveTask(
      f.seed.id,
      { maxIterations: 1 },
      f.store,
      async (o, s) => {
        assert.equal(o.improvement!.minimumCandidates, 2);
        const t = fixture([true, true], o);
        t.answer!.candidates.pop();
        await s!.save(t);
        return t;
      },
    );
    assert.notEqual(loop.status, "succeeded");
    assert.equal(loop.minimumCandidates, 2);
    assert.equal(loop.best.causes.includes("candidate_count_missing"), true);
  } finally {
    await f.cleanup();
  }
});
test("SUUMO conflicting cross-listings cannot manufacture a verified walk-time condition", () => {
  const t = newTask({
    query: "武蔵小杉駅徒歩10分以内",
    urls: ["https://suumo.jp/"],
    maxSteps: 30,
    maxPages: 8,
    timeoutSeconds: 60,
  });
  const c = [
    {
      id: "walk",
      description: "武蔵小杉駅から徒歩10分以内",
      weight: 5,
      required: true,
    },
  ];
  t.criteria = c;
  const page = (url: string, id: string, minutes: number, area = "33.53") => ({
    url,
    id,
    title: "【SUUMO】D Paina 中丸子／神奈川県川崎市中原区中丸子／武蔵小杉駅",
    text: `家賃\n14万円\n所在地\n神奈川県川崎市中原区中丸子\n専有面積\n${area}m2\n間取り\n1LDK\n管理費6000円\n武蔵小杉駅 徒歩${minutes}分\n${"物件の設備と建物情報です。".repeat(30)}`,
    links: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  });
  const a = "https://suumo.jp/chintai/bc_100531777248/",
    b = "https://suumo.jp/chintai/jnc_000110455233/";
  t.pages = [page(a, "p1", 10), page(b, "p2", 19)];
  const ev = addEvidence(t, "p1", "武蔵小杉駅 徒歩10分");
  t.answer = validateAnswer(
    t,
    "徒歩10分と掲載",
    [
      {
        name: "物件",
        url: a,
        matches: [
          {
            criterionId: "walk",
            status: "supported",
            explanation: "徒歩10分",
            evidenceIds: [ev.id],
          },
        ],
      },
    ],
    [],
  );
  assert.equal(diagnose(t, c, [a]).causes.includes("source_conflict"), true);
  assert.equal(diagnose(t, c, [a]).complete, false);
  // Different dimensions are not assumed to describe the same room.
  t.pages[1] = page(b, "p2", 19, "50.00");
  assert.equal(diagnose(t, c, [a]).complete, true);
});
test("two URLs for an apparently identical SUUMO room cannot satisfy a two-room goal", () => {
  const t = newTask({
    query: "2物件を比較",
    urls: ["https://suumo.jp/"],
    maxSteps: 30,
    maxPages: 8,
    timeoutSeconds: 60,
  });
  t.criteria = [
    { id: "layout", description: "1LDK", weight: 5, required: true },
  ];
  const roomUrls = [
    "https://suumo.jp/chintai/bc_100531777248/",
    "https://suumo.jp/chintai/jnc_000110455233/",
  ];
  t.pages = roomUrls.map((url, i) => ({
    url,
    id: "p" + i,
    title: "【SUUMO】D Paina 中丸子／神奈川県川崎市中原区中丸子",
    text: `家賃\n14万円\n所在地\n神奈川県川崎市中原区中丸子\n専有面積\n33.53m2\n間取り\n1LDK\n管理費6000円\n${"物件の設備と建物情報です。".repeat(30)}`,
    links: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
  }));
  t.answer = validateAnswer(
    t,
    "2掲載",
    roomUrls.map((url, i) => ({
      name: "部屋" + i,
      url,
      matches: [
        {
          criterionId: "layout",
          status: "supported",
          explanation: "1LDK",
          evidenceIds: [addEvidence(t, "p" + i, "間取り\n1LDK").id],
        },
      ],
    })),
    [],
  );
  assert.equal(
    diagnose(t, t.criteria, roomUrls, true).causes.includes(
      "possible_duplicate_room",
    ),
    true,
  );
  assert.equal(diagnose(t, t.criteria, roomUrls, true).complete, false);
});
