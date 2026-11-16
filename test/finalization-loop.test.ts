import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTask, newTask } from "../src/runtime.js";
import { CodexAgent } from "../src/codex.js";
import { Store } from "../src/store.js";
import { finalizationState } from "../src/finalization.js";

const url = "https://books.rakuten.co.jp/rb/18577690/";
const criterion = {
  id: "price",
  description: "掲載価格1430円",
  required: true,
  weight: 1,
};
const page = {
  id: "source",
  url,
  title: "るるぶ箱根",
  text:
    "るるぶ箱根。出版社 JTBパブリッシング。ISBN 9784533172731。税込掲載価格1,430円。" +
    "書籍の公開詳細と旅行の見どころを紹介しています。".repeat(12),
  links: [],
  truncated: false,
  capturedAt: "2026-11-17T00:00:00Z",
};

test("unfinished model turn resumes from saved evidence and a rejected finish rather than requesting an empty answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "finalization-loop-"));
  const original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [];
  let turns = 0;
  const call = async (name: string, args: any) =>
    JSON.parse(
      (await tools.find((t) => t.name === name).execute(name, args)).content[0]
        .text,
    );
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async (text: string) => {
      turns++;
      if (turns === 1) {
        const opened = await call("open_page", { url });
        const pid = opened.result.untrustedPage.id;
        const photoError = await call("inspect_photo", {
          pageId: pid,
          imageIndex: 0,
        });
        assert.match(photoError.error, /画像参照/);
        await call("record_evidence", {
          pageId: pid,
          quote: "税込掲載価格1,430円。",
        });
        const rejected = await call("finish_task", {
          summary: "価格",
          candidates: [
            {
              name: "箱根",
              url: "https://books.rakuten.co.jp/rb/99999999/",
              matches: [],
            },
          ],
          limitations: [],
        });
        assert.match(rejected.error, /閲覧|候補/);
        return;
      }
      const request = JSON.parse(text);
      assert.match(request.instruction, /未完了/);
      assert.doesNotMatch(request.instruction, /候補なしも許可/);
      assert.match(request.checkpoint.lastError, /finish_task/);
      const state = (await call("read_task_state", {})).result;
      assert.equal(state.evidence.length, 1);
      assert.equal(state.pages[0].evidenceIds[0], state.evidence[0].id);
      assert.equal(state.pages[0].entityKey, "rakuten-books:18577690");
      const accepted = await call("finish_task", {
        summary: "掲載価格は1,430円です。",
        candidates: [
          {
            name: "るるぶ箱根",
            url,
            matches: [
              {
                criterionId: "price",
                status: "supported",
                explanation: "掲載価格1430円",
                evidenceIds: [state.evidence[0].id],
              },
            ],
          },
        ],
        limitations: [],
      });
      assert.equal(accepted.result.accepted, true);
    }),
  ];
  try {
    const t = await runTask(
      {
        query: "掲載価格を確認",
        urls: [url],
        agent: "codex",
        maxSteps: 20,
        maxPages: 3,
        timeoutSeconds: 15,
        benchmark: { id: "continuation", criteria: [criterion], pages: [page] },
      },
      new Store(root),
    );
    assert.equal(t.status, "succeeded");
    assert.equal(turns, 2);
    assert.equal(t.evidence.length, 1);
    const events = await readFile(
      join(root, "tasks", t.id, "events.jsonl"),
      "utf8",
    );
    assert.match(events, /finalization_continuation/);
  } finally {
    for (const m of mocks) m.mock.restore();
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("two stalled continuation turns stop without inventing a successful answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "stalled-finalization-"));
  const original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let turns = 0;
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async () => {}),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      turns++;
    }),
  ];
  try {
    const t = await runTask(
      {
        query: "価格を確認",
        urls: [url],
        agent: "codex",
        maxSteps: 20,
        maxPages: 3,
        timeoutSeconds: 15,
        benchmark: { id: "stalled", criteria: [criterion], pages: [page] },
      },
      new Store(root),
    );
    assert.equal(turns, 3);
    assert.equal(t.status, "failed");
    assert.equal(t.answer, undefined);
    assert.match(t.error!, /構造化回答/);
  } finally {
    for (const m of mocks) m.mock.restore();
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint groups venue subpages, bounds context, and never marks unstaged output complete", () => {
  const t = newTask({
    query: "一日旅行プラン",
    urls: [url],
    maxSteps: 20,
    maxPages: 50,
    timeoutSeconds: 30,
  });
  t.pages = Array.from({ length: 30 }, (_, i) => ({ ...page, id: `p${i}` }));
  t.evidence = Array.from({ length: 40 }, (_, i) => ({
    id: `ev${i}`,
    pageId: "p29",
    url,
    quote: "税込掲載価格1,430円。",
    capturedAt: page.capturedAt,
  }));
  const s = finalizationState(t);
  assert.equal(s.complete, false);
  assert.equal(s.pages.length, 24);
  assert.equal(s.evidence.length, 32);
  assert.equal(s.omittedPages, 6);
  assert.equal(s.omittedEvidence, 8);
  assert.equal(s.stagedPlan, null);
  assert.ok(s.pending.some((p) => p.includes("stage_plan")));
  assert.ok(s.pending.some((p) => p.includes("stage_visual")));
});

test("multi-venue itinerary rejects an unscoped plan before locking criteria with evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "scoped-finalization-"));
  const original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [];
  let turns = 0;
  const venueUrls = [
    "https://www.tokyo-zoo.net/ueno/visitor-info/tickets/",
    "https://shop.create-restaurants.co.jp/0941/",
  ];
  const mocks = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      if (turns++) return;
      const call = async (args: any) =>
        JSON.parse(
          (await tools.find((t) => t.name === "plan_task").execute("p", args))
            .content[0].text,
        );
      const bad = await call({ criteria: [criterion] });
      assert.match(bad.error, /appliesTo/);
      const state = JSON.parse(
        (await tools.find((t) => t.name === "read_task_state").execute("s", {}))
          .content[0].text,
      ).result;
      assert.deepEqual(state.criteria, []);
      await call({
        criteria: venueUrls.map((u, i) => ({
          ...criterion,
          id: `c${i}`,
          appliesTo: [u],
        })),
      });
    }),
  ];
  try {
    const task = await runTask(
      {
        query: "一日旅行の正式プラン",
        urls: venueUrls,
        agent: "codex",
        maxSteps: 20,
        maxPages: 3,
        timeoutSeconds: 10,
      },
      new Store(root),
    );
    assert.equal(task.criteria.length, 2);
    assert.ok(task.criteria.every((c) => c.appliesTo?.length === 1));
    assert.notEqual(task.status, "succeeded");
  } finally {
    for (const m of mocks) m.mock.restore();
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});
