import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTask, runTask } from "../src/runtime.js";
import { routeSources, checkNavigation, publicUrl } from "../src/sources.js";
import { isFreeToolModel } from "../src/models.js";
import { privateAddress } from "../src/browser.js";
import {
  addEvidence,
  setCriteria,
  validateAnswer,
  renderAnswer,
} from "../src/evidence.js";
import { Store } from "../src/store.js";
const URL_A = "https://beauty.hotpepper.jp/sln/H000000001/";
const URL_B = "https://beauty.hotpepper.jp/sln/H000000002/";
function fixture() {
  const task = newTask({
    query: "渋谷駅近の髪質改善サロン",
    urls: ["https://beauty.hotpepper.jp/"],
    maxSteps: 30,
    timeoutSeconds: 60,
    maxPages: 8,
  });
  setCriteria(task, [
    { id: "near", description: "渋谷駅徒歩5分以内", weight: 5, required: true },
    { id: "hair", description: "髪質改善", weight: 3, required: false },
  ]);
  task.pages.push(
    {
      id: "page-1",
      url: URL_A,
      title: "A",
      text: "渋谷駅から徒歩3分。髪質改善トリートメント対応。",
      links: [],
      capturedAt: new Date().toISOString(),
      truncated: false,
    },
    {
      id: "page-2",
      url: URL_B,
      title: "B",
      text: "渋谷駅から徒歩8分。髪質改善トリートメント対応。",
      links: [],
      capturedAt: new Date().toISOString(),
      truncated: false,
    },
  );
  return task;
}
test("multiple URLs are routed by query relevance rather than input order", () => {
  const sources = routeSources("渋谷の髪質改善サロン", [
    "https://www.jalan.net/",
    "https://beauty.hotpepper.jp/",
  ]);
  assert.equal(sources[0]?.kind, "hotpepper-beauty");
  assert.equal(
    routeSources("温泉旅館", [
      "https://beauty.hotpepper.jp/",
      "https://www.jalan.net/",
    ])[0]?.kind,
    "jalan",
  );
});
test("navigation rejects credentials, IPs, internal hosts, HTTP, and unlisted domains", () => {
  for (const url of [
    "http://beauty.hotpepper.jp/",
    "https://user:pass@beauty.hotpepper.jp/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://service.internal/",
    "https://example.com:8443/",
  ])
    assert.throws(() => publicUrl(url));
  assert.throws(() =>
    checkNavigation("https://attacker.com/", ["beauty.hotpepper.jp"]),
  );
  assert.equal(checkNavigation(URL_A, ["beauty.hotpepper.jp"]), URL_A);
});
test("private address ranges are rejected before browser navigation", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.2",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])
    assert.ok(privateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(privateAddress(ip), false, ip);
});
test("free model selection requires a free ID, zero prices, tools, and sufficient context", () => {
  const model = {
    id: "test/model:free",
    name: "test",
    context_length: 32000,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
  };
  assert.ok(isFreeToolModel(model));
  for (const change of [
    { id: "test/paid" },
    { pricing: { prompt: "0.1", completion: "0" } },
    { pricing: { prompt: "0", completion: "0", request: "0.1" } },
    { supported_parameters: [] },
    { context_length: 4096 },
  ])
    assert.equal(isFreeToolModel({ ...model, ...change }), false);
});
test("invented or empty quotes cannot become evidence; whitespace normalization works", () => {
  const task = fixture();
  assert.throws(() =>
    addEvidence(task, "page-1", "韓国アイドル御用達の大人気サロン"),
  );
  assert.throws(() => addEvidence(task, "missing", "渋谷駅から徒歩3分"));
  assert.throws(() => addEvidence(task, "page-1", "  "));
  const evidence = addEvidence(task, "page-1", "渋谷駅から徒歩3分");
  assert.equal(evidence.id, "ev-1");
  assert.equal(addEvidence(task, "page-1", "渋谷駅から徒歩3分").id, "ev-1");
  assert.throws(() => setCriteria(task, task.criteria));
});
test("candidate validation rejects unknown URLs, missing criteria, fabricated IDs, and another candidate evidence", () => {
  const task = fixture();
  const ev = addEvidence(task, "page-1", "渋谷駅から徒歩3分");
  const candidate = {
    name: "A",
    url: URL_A,
    matches: [
      {
        criterionId: "near",
        status: "supported" as const,
        explanation: "徒歩3分",
        evidenceIds: [ev.id],
      },
      {
        criterionId: "hair",
        status: "unknown" as const,
        explanation: "未確認",
        evidenceIds: [],
      },
    ],
  };
  assert.throws(() =>
    validateAnswer(
      task,
      "候補",
      [{ ...candidate, url: "https://beauty.hotpepper.jp/invented" }],
      [],
    ),
  );
  assert.throws(() =>
    validateAnswer(task, "候補", [{ ...candidate, matches: [] }], []),
  );
  assert.throws(() =>
    validateAnswer(
      task,
      "候補",
      [
        {
          ...candidate,
          matches: candidate.matches.map((m) => ({
            ...m,
            evidenceIds: ["invented"],
          })),
        },
      ],
      [],
    ),
  );
  assert.throws(() =>
    validateAnswer(task, "候補", [{ ...candidate, url: URL_B }], []),
  );
  assert.throws(() =>
    validateAnswer(
      task,
      "候補",
      [
        {
          ...candidate,
          matches: candidate.matches.map((m) => ({
            ...m,
            status: "supported" as const,
            evidenceIds: [],
          })),
        },
      ],
      [],
    ),
  );
  const answer = validateAnswer(task, "候補", [candidate], ["韓国風は未確認"]);
  assert.equal(answer.candidates[0]?.score, 63);
  assert.equal(answer.candidates[0]?.eligible, true);
  task.answer = answer;
  assert.match(renderAnswer(task), /ev-1/);
});
test("same salon child pages may supply evidence while required unknowns prevent eligibility", () => {
  const task = fixture();
  task.pages.push({
    ...task.pages[0]!,
    id: "page-3",
    url: URL_A + "coupon/",
    text: "髪質改善トリートメント対応。",
  });
  const ev = addEvidence(task, "page-3", "髪質改善トリートメント対応");
  const answer = validateAnswer(
    task,
    "未確認条件あり",
    [
      {
        name: "A",
        url: URL_A,
        matches: [
          {
            criterionId: "near",
            status: "unknown",
            explanation: "未確認",
            evidenceIds: [],
          },
          {
            criterionId: "hair",
            status: "supported",
            explanation: "メニューあり",
            evidenceIds: [ev.id],
          },
        ],
      },
    ],
    [],
  );
  assert.equal(answer.candidates[0]?.eligible, false);
  assert.equal(answer.candidates[0]?.score, 38);
});
test("task limits reject NaN, zero, fractional values", () => {
  for (const value of [NaN, 0, -1, 1.5])
    assert.throws(() =>
      newTask({
        query: "q",
        urls: ["https://example.com"],
        maxSteps: value,
        timeoutSeconds: 10,
        maxPages: 3,
      }),
    );
});
test("store persists task, events and history and rejects path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "whr-test-"));
  try {
    const store = new Store(root);
    const task = fixture();
    await store.save(task);
    await store.event(task.id, "test");
    assert.equal((await store.get(task.id)).query, task.query);
    assert.equal((await store.list()).length, 1);
    assert.throws(() => store.dir("../.env"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime saves a failed task and error artifact when the API key is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "whr-failure-"));
  const key = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const store = new Store(root);
    const task = await runTask(
      {
        agent: "pi-openrouter",
        query: "test",
        urls: ["https://example.com/"],
        maxSteps: 10,
        timeoutSeconds: 10,
        maxPages: 2,
      },
      store,
    );
    assert.equal(task.status, "failed");
    assert.match(task.error!, /OPENROUTER_API_KEY/);
    assert.equal((await store.get(task.id)).status, "failed");
  } finally {
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
    await rm(root, { recursive: true, force: true });
  }
});
test("an already-cancelled task does not call the model or browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "whr-cancel-"));
  const controller = new AbortController();
  controller.abort();
  try {
    const task = await runTask(
      {
        query: "test",
        urls: ["https://example.com/"],
        maxSteps: 10,
        timeoutSeconds: 10,
        maxPages: 2,
        signal: controller.signal,
      },
      new Store(root),
    );
    assert.equal(task.status, "cancelled");
    assert.equal(task.steps, 0);
    assert.equal(task.pages.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
