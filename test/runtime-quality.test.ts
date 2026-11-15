import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { CodexAgent } from "../src/codex.js";
import { runTask } from "../src/runtime.js";
import { Store } from "../src/store.js";

test("captured-page reading and repeated finalization preserve an honest partial answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-quality-"));
  const old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = resolve("test/fixtures/codex-server.mjs");
  let tools: any[] = [];
  const stubs = [
    mock.method(CodexAgent.prototype, "initialize", async () => ({})),
    mock.method(CodexAgent.prototype, "start", async (t: any[]) => {
      tools = t;
    }),
    mock.method(CodexAgent.prototype, "prompt", async () => {
      const call = async (name: string, args: unknown) =>
        JSON.parse(
          (await tools.find((t) => t.name === name).execute(name, args))
            .content[0].text,
        ).result;
      const opened = await call("open_page", { url });
      assert.equal(opened.sourceTruncated, false);
      assert.equal(opened.contextTruncated, true);
      const read = await call("read_page", {
        pageId: "page-1",
        terms: ["出版社"],
      });
      assert.ok(
        read.untrustedWindows.some((w: any) =>
          w.text.includes("出版社：テスト出版"),
        ),
      );
      const answer = {
        summary: "在庫は未確認",
        candidates: [
          {
            name: "書籍",
            url,
            matches: [
              {
                criterionId: "stock",
                status: "unknown",
                explanation: "凍結資料に在庫の根拠なし",
                evidenceIds: [],
              },
            ],
          },
        ],
        limitations: ["在庫未確認"],
      };
      assert.equal((await call("finish_task", answer)).accepted, true);
      assert.equal(
        (await call("finish_task", { ...answer, summary: "後続の上書き" }))
          .finalized,
        true,
      );
      assert.equal((await call("open_page", { url })).finalized, true);
    }),
  ];
  const url = "https://books.rakuten.co.jp/rb/18577690/";
  try {
    const task = await runTask(
      {
        query: "書籍の在庫を確認",
        urls: [url],
        agent: "codex",
        maxSteps: 10,
        maxPages: 3,
        timeoutSeconds: 10,
        benchmark: {
          id: "unknown-stock",
          criteria: [
            { id: "stock", description: "在庫あり", required: true, weight: 1 },
          ],
          pages: [
            {
              id: "source",
              url,
              title: "書籍",
              text:
                "案内".repeat(5000) + "出版社：テスト出版\n税込価格：1000円\n",
              links: [{ url: url + "?view=detail", text: "詳細" }],
              capturedAt: new Date().toISOString(),
              truncated: false,
            },
          ],
        },
      },
      new Store(root),
    );
    assert.equal(task.status, "partial", task.error);
    assert.equal(task.answer!.summary, "在庫は未確認");
    assert.equal(task.pages.length, 1);
    assert.equal(task.research!.attempts.length, 0);
    assert.equal(task.steps, 3);
    assert.equal(task.error, undefined);
    const html = await readFile(
      join(root, "tasks", task.id, "answer.html"),
      "utf8",
    );
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /在庫は未確認/);
  } finally {
    stubs.forEach((s) => s.mock.restore());
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    await rm(root, { recursive: true, force: true });
  }
});
