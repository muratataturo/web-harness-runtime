import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ProgressDecoder,
  progressPrefix,
  researchProgress,
} from "../src/progress.js";
import { pageArtifact } from "../src/artifacts.js";
import { RunService } from "../src/run-service.js";
import { Store } from "../src/store.js";
import { newTask } from "../src/runtime.js";
import { createWorkbenchServer } from "../src/server.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";
test("progress decoder survives split events, ignores malformed diagnostics and includes only bounded public previews", () => {
  const events: any[] = [];
  const d = new ProgressDecoder((e) => events.push(e));
  const line =
    progressPrefix +
    JSON.stringify(
      researchProgress("open_page", "done", {
        url: "https://books.rakuten.co.jp/rb/18577690/",
        pages: 1,
        evidence: 0,
      }),
    ) +
    "\n";
  for (const part of [line.slice(0, 7), line.slice(7, 38), line.slice(38)])
    d.push(part);
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, "read");
  d.push(progressPrefix + '{"stage":"fake"}\n');
  d.push("ordinary log\n");
  assert.equal(events.length, 1);
});
test("SSE pushes captured links before completion, keeps previews safe, restores final artifacts and closes the terminal stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-sse-"));
  const store = new Store(root);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = new RunService(store, async (o) => {
    const t = newTask(o);
    const p = {
      id: "page-1",
      url: o.urls[0]!,
      title: "取得ページ <script>window.bad=1</script>",
      text: "本文から実際に取得した価格は1,430円。".repeat(30),
      capturedAt: new Date().toISOString(),
      links: [],
      truncated: false,
      acquisition: { kind: "public-html" as const, status: 200 },
    };
    t.pages = [p];
    await store.save(t);
    await gate;
    o.onProgress?.(
      progressPrefix +
        JSON.stringify(
          researchProgress("open_page", "done", {
            url: p.url,
            pages: 1,
            evidence: 0,
            artifact: pageArtifact(t, p),
          }),
        ) +
        "\n",
    );
    await delay(150);
    t.status = "partial";
    t.answer = {
      summary: "価格は取得、サインは不明",
      candidates: [],
      limitations: ["未確認"],
    };
    await store.save(t);
    return t;
  });
  const server = createWorkbenchServer(
    new GoalEngine(new GoalRepository(join(root, "goals")), 1),
    store,
    runs,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const r = await runs.create({
      query: "ストリーム検証",
      urls: ["https://books.rakuten.co.jp/rb/18577690/"],
      mode: "auto",
      source: "live",
      confirmLive: true,
    });
    const denied = await fetch(`${base}/api/runs/${r.id}/events`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(denied.status, 403);
    const res = await fetch(`${base}/api/runs/${r.id}/events`);
    assert.match(res.headers.get("content-type")!, /text\/event-stream/);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: run/);
    release();
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const snapshots = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const mid = snapshots.find(
      (v) => v.status === "running" && v.artifacts?.length,
    );
    assert.ok(mid, "page artifact should arrive while task is still running");
    assert.equal(
      mid.artifacts[0].url,
      "https://books.rakuten.co.jp/rb/18577690/",
    );
    const done = await runs.get(r.id);
    assert.equal(done.status, "completed_partial");
    assert.ok(snapshots.at(-1).updateSeq > r.updateSeq!);
    const artifact = (await (
      await fetch(
        `${base}/api/runs/${r.id}/artifacts/${done.artifacts![0]!.id}`,
      )
    ).json()) as any;
    assert.equal(artifact.excerptOnly, false);
    assert.match(artifact.body, /1,430円/);
    assert.equal(artifact.method, "public-html");
    const reloaded = await new RunService(store).get(r.id);
    assert.ok(reloaded.artifacts?.length);
  } finally {
    release();
    await runs.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
