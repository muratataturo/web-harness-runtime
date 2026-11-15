import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkbenchServer } from "../src/server.js";
import { RunService } from "../src/run-service.js";
import { GoalEngine, GoalRepository } from "../src/goals.js";
import { Store } from "../src/store.js";
import { newTask } from "../src/runtime.js";
import { addEvidence, validateAnswer, normalized } from "../src/evidence.js";
import { verifyDetail } from "../src/detail-contracts.js";
import { researchProgress, progressPrefix } from "../src/progress.js";
import {
  acceptanceRevision,
  assertLiveAcceptance,
  requiredChatChecks,
} from "./chat-acceptance.mjs";

const live = process.argv.includes("--live");
if (
  process.argv.slice(2).some((a) => !["--live", "--local-gateway"].includes(a))
)
  throw Error("Unknown chat acceptance option");
const mode = live ? "live" : "fixture";
const root = resolve(`.runtime/chat-runtime-${mode}`);
const attempt = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(attempt, { recursive: true, mode: 0o700 });
const initialRevision = await acceptanceRevision();
// A failed attempt overwrites the latest receipt: yesterday's success cannot mask it.
await writeFile(
  join(root, "report.json"),
  JSON.stringify({
    schemaVersion: 1,
    mode,
    passed: false,
    startedAt: new Date().toISOString(),
  }),
);
const cases = [
  {
    family: "recruit",
    label: "Recruit",
    profileId: "recruit-public-research",
    query:
      "指定した1店舗の店舗名、住所、掲載ランチ価格を引用付きで確認してください。予約・問い合わせ・ログインはせず、当日の営業と空席は未確認と明記してfinish_taskに保存してください。",
    urls: [
      "https://www.hotpepper.jp/strJ001100102/",
      "https://www.hotpepper.jp/strJ001100102/lunch/",
    ],
    expected: /まいか|米香/,
    fixture: {
      title: "まいか 米香 UI fixture",
      text: "まいか 米香 UI fixture\n住所 東京都台東区上野7-1-1\nアクセス 上野駅 徒歩1分\nランチメニュー 天婦羅御膳1,880円。掲載価格のみ。当日の営業と空席は未確認。\n",
      quote: "ランチメニュー 天婦羅御膳1,880円。",
    },
  },
  {
    family: "rakuten",
    label: "Rakuten",
    profileId: "rakuten-public-research",
    query:
      "この公開商品詳細から書名、出版社、税込価格を引用付きで確認してください。購入やログインはせず、記載がない項目はunknownとしてfinish_taskに保存してください。送料・在庫・将来価格は確約しません。",
    urls: ["https://books.rakuten.co.jp/rb/18577690/"],
    expected: /るるぶ|箱根/,
    fixture: {
      title: "るるぶ 箱根 UI fixture",
      text: "るるぶ 箱根 UI fixture\n出版社 JTBパブリッシング\nISBN 9784533172731\n税込掲載価格1,430円。送料・在庫・将来価格は未確認。\n",
      quote: "税込掲載価格1,430円。",
    },
  },
];
async function freePort() {
  const s = createServer();
  await new Promise((ok, no) => {
    s.once("error", no);
    s.listen(0, "127.0.0.1", ok);
  });
  const port = s.address().port;
  await new Promise((ok) => s.close(ok));
  return port;
}
async function fixtureServer(c, stateRoot) {
  const old = Object.fromEntries(
    ["RUNTIME_PROFILE", "RUNTIME_SECURITY_MODE", "RUNTIME_EXECUTOR"].map(
      (k) => [k, process.env[k]],
    ),
  );
  process.env.RUNTIME_PROFILE = c.family;
  process.env.RUNTIME_SECURITY_MODE = "hardened";
  process.env.RUNTIME_EXECUTOR = "local";
  const store = new Store(stateRoot);
  const service = new RunService(store, async (o) => {
    const task = newTask(o);
    task.criteria = [
      {
        id: "published",
        description: "掲載情報を引用で確認",
        required: true,
        weight: 1,
      },
    ];
    const p = {
      id: "page-1",
      url: c.urls[0],
      title: c.fixture.title,
      text:
        c.fixture.text + "UI経路だけを確認する架空のfixtureです。\n".repeat(12),
      links: [],
      truncated: false,
      capturedAt: task.createdAt,
      acquisition: { kind: "public-html", status: 200 },
    };
    task.pages.push(p);
    const ev = addEvidence(task, p.id, c.fixture.quote);
    assert.equal(verifyDetail(p).status, "verified");
    o.onProgress?.(
      progressPrefix +
        JSON.stringify(
          researchProgress("open_page", "done", {
            url: p.url,
            pages: 1,
            evidence: 1,
          }),
        ) +
        "\n",
    );
    await delay(1200, undefined, { signal: o.signal });
    task.answer = validateAnswer(
      task,
      `${c.fixture.title}の掲載情報を確認。${c.fixture.quote} 実モデルを使用しないUI fixtureです。`,
      [
        {
          name: c.fixture.title,
          url: p.url,
          matches: [
            {
              criterionId: "published",
              status: "supported",
              explanation: "fixture本文の掲載値",
              evidenceIds: [ev.id],
            },
          ],
        },
      ],
      ["架空のUI fixture。実調査・実モデル・MicroVMの動作証明ではありません。"],
    );
    task.status = "succeeded";
    await store.save(task);
    return task;
  });
  const server = createWorkbenchServer(
    new GoalEngine(new GoalRepository(join(stateRoot, "goals")), 1),
    store,
    service,
  );
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.emit("shutdown");
      await service.shutdown();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
async function liveServer(c, stateRoot) {
  const port = await freePort();
  const env = {
    ...process.env,
    RUNTIME_DIR: stateRoot,
    RUNTIME_EXECUTOR: "openshell",
    RUNTIME_SECURITY_MODE: "hardened",
    RUNTIME_DEPLOYMENT: "single-user",
    RUNTIME_AGENT: "codex",
    RUNTIME_PROFILE: c.family,
  };
  if (process.argv.includes("--local-gateway"))
    Object.assign(env, {
      OPENSHELL_GATEWAY: "web-harness-local",
      OPENSHELL_BIN: resolve(".runtime/openshell-install/bin/openshell"),
      XDG_CONFIG_HOME: resolve(".runtime/openshell-local/config"),
      XDG_DATA_HOME: resolve(".runtime/openshell-local/data"),
      XDG_STATE_HOME: resolve(".runtime/openshell-local/state"),
      OPENSHELL_LOCAL_TLS_DIR: resolve(".runtime/openshell-local/tls"),
    });
  if (!env.OPENSHELL_GATEWAY || !env.OPENSHELL_BIN)
    throw Error(
      "Live Chat acceptance requires an authenticated OpenShell gateway; no local/replay fallback or skip.",
    );
  const child = spawn(
    process.execPath,
    ["dist/cli.js", "chat", "--port", String(port)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (b) => {
    output = (output + b).slice(-50000);
  });
  child.stderr.on("data", (b) => {
    output = (output + b).slice(-50000);
  });
  const exited = new Promise((ok) => child.once("close", ok));
  const base = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exited,
      new Promise((ok) => {
        timer = setTimeout(ok, 30000);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await writeFile(join(stateRoot, "daemon.log"), output, { mode: 0o600 });
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw Error(
          "Chat daemon exited before startup; inspect its local daemon.log",
        );
      try {
        const r = await fetch(base + "/api/runtime", {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) return { base, close };
      } catch {}
      await delay(100);
    }
    throw Error("Chat daemon startup timed out");
  } catch (e) {
    await close();
    throw e;
  }
}
let browser;
const results = [];
try {
  const executable =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executable ? { executablePath: executable } : {}),
  });
  for (const c of cases) {
    const dir = join(attempt, c.family);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const server = live
      ? await liveServer(c, dir)
      : await fixtureServer(c, dir);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    if (!live)
      await page.route("**/api/runs/*/artifacts/*/visual", (route) =>
        route.fulfill({
          json: {
            url: c.urls[0],
            capturedAt: new Date().toISOString(),
            images: [],
            imageError:
              "UI fixture: external images are outside this deterministic test.",
          },
        }),
      );
    const pageErrors = [],
      streams = new Set();
    let submittedRuns = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/runs")
        submittedRuns++;
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("response", (r) => {
      if (
        /\/api\/runs\/[a-zA-Z0-9-]+\/events$/.test(new URL(r.url()).pathname) &&
        r.status() === 200
      )
        streams.add(new URL(r.url()).pathname);
    });
    try {
      await page.goto(server.base + "/chat");
      await page.waitForFunction(
        () => document.querySelector("#chat-query")?.value.length > 0,
      );
      await page.getByRole("button", { name: c.label, exact: true }).click();
      await page.locator("#data-source").selectOption("live");
      await page.locator("#chat-mode").selectOption("auto");
      await page.locator("#chat-agent").selectOption("codex");
      await page.locator("#chat-query").fill(c.query);
      await page.locator("#url-options summary").click();
      await page.locator("#chat-urls").fill(c.urls.join("\n"));
      assert.equal(
        await page.locator("body").getAttribute("data-brand"),
        c.family,
      );
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/runs" &&
            r.request().method() === "POST",
        ),
        page.locator("#send-chat").click(),
      ]);
      assert.equal(response.status(), 202, await response.text());
      const created = await response.json();
      assert.equal(created.input.query, c.query);
      assert.deepEqual(created.input.urls, c.urls);
      assert.equal(created.input.source, "live");
      assert.equal(created.input.mode, "auto");
      assert.equal(created.input.agent, "codex");
      await page
        .locator(".progress-box")
        .waitFor({ state: "visible", timeout: 30000 });
      await page
        .getByText("● LIVE", { exact: true })
        .waitFor({ timeout: 30000 });
      await page.screenshot({ path: join(dir, "running.png") });
      const deadline = Date.now() + (live ? 360000 : 20000);
      let run;
      do {
        run = await (
          await page.request.get(server.base + "/api/runs/" + created.id)
        ).json();
        if (run.status !== "running") break;
        if (Date.now() > deadline)
          throw Error(
            "Chat runtime did not finish within the acceptance deadline",
          );
        await delay(250);
      } while (true);
      await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2), {
        mode: 0o600,
      });
      assert.equal(
        run.status,
        "succeeded",
        `${c.family}: ${run.error ?? run.task?.error ?? run.status}`,
      );
      assert.equal(run.task?.status, "succeeded");
      assert.equal(run.task.agent, "codex");
      assert.equal(run.task.evaluation, undefined);
      assert.equal(run.gate, undefined);
      assert.equal(run.decisions[0]?.decidedBy, "runtime");
      assert.equal(run.task.security.profileId, c.profileId);
      assert.equal(run.task.security.mode, "hardened");
      assert.ok(run.task.evidence.length > 0);
      if (live) {
        assert.equal(run.target, "openshell");
        assert.equal(run.task.execution.target, "openshell");
        assert.equal(run.task.execution.cleanupStatus, "stopped");
        assert.equal(run.task.security.artifactNonce, run.task.id);
        assert.ok(run.task.execution.sandboxId);
      }
      await page
        .locator(".answer")
        .waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await page.locator(".gate-card").count(), 0);
      assert.match(
        await page.locator(".decision-receipt").textContent(),
        /Auto/,
      );
      assert.ok(streams.has(`/api/runs/${created.id}/events`));
      await page.screenshot({ path: join(dir, "answer.png"), fullPage: true });
      await page.locator(".read-answer").click();
      assert.match(
        await page.locator("#answer-dialog .markdown-body").textContent(),
        c.expected,
      );
      await page.locator("#answer-close").click();
      await page.locator(".candidate-card").first().click();
      await page.locator("#answer-dialog blockquote").first().waitFor();
      const quote = normalized(
        await page.locator("#answer-dialog blockquote").first().textContent(),
      );
      assert.ok(run.task.evidence.some((e) => normalized(e.quote) === quote));
      await page.screenshot({ path: join(dir, "candidate-quote.png") });
      await page.locator("#answer-close").click();
      const card = page
        .locator(".artifact-card")
        .filter({ hasText: "取得済み" })
        .first();
      const original = await card.locator("a").getAttribute("href");
      await card.locator(".artifact-open").click();
      await page.getByRole("tab", { name: "本文・引用", exact: true }).click();
      await page.locator(".artifact-quote").first().waitFor();
      const body = normalized(
        await page.locator(".artifact-preview-body").textContent(),
      );
      const sourceQuote = normalized(
        await page.locator(".artifact-quote").first().textContent(),
      );
      assert.ok(body.includes(sourceQuote));
      assert.match(
        await page.locator("#artifact-text").textContent(),
        /取得時点に保存した範囲の本文/,
      );
      assert.equal(
        await page.locator(".artifact-external").getAttribute("href"),
        original,
      );
      await page.screenshot({ path: join(dir, "source-quote.png") });
      await page.locator("#artifact-close").click();
      await page.reload();
      await page
        .locator(".answer")
        .waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await page.locator(".gate-card").count(), 0);
      assert.equal(
        await page.locator("body").getAttribute("data-brand"),
        c.family,
      );
      assert.deepEqual(pageErrors, []);
      assert.equal(
        submittedRuns,
        1,
        "Reload must restore the saved answer without another model run",
      );
      const execution = Object.fromEntries(
        Object.entries(run.task.execution ?? {}).filter(
          ([k]) => k !== "artifactsDirectory",
        ),
      );
      results.push({
        family: c.family,
        runId: run.id,
        taskId: run.task.id,
        runStatus: run.status,
        taskStatus: run.task.status,
        source: run.input.source,
        mode: run.input.mode,
        security: run.task.security,
        execution,
        evidenceCount: run.task.evidence.length,
        agent: run.task.agent,
        modelTokens: run.task.metrics?.tokens?.totalTokens ?? 0,
        pageCount: run.task.pages.length,
        summary: run.task.answer.summary,
        checks: Object.fromEntries(requiredChatChecks.map((k) => [k, true])),
        screenshots: [
          "running.png",
          "answer.png",
          "candidate-quote.png",
          "source-quote.png",
        ].map(
          (f) => `${attempt.slice(process.cwd().length + 1)}/${c.family}/${f}`,
        ),
      });
      console.log(
        `${mode} Chat ${c.family}: passed (${run.task.evidence.length} citations)`,
      );
    } catch (e) {
      await page
        .screenshot({ path: join(dir, "failure.png"), fullPage: true })
        .catch(() => {});
      throw e;
    } finally {
      await context.close();
      await server.close();
    }
  }
  assert.equal(
    await acceptanceRevision(),
    initialRevision,
    "Code changed during Chat acceptance; rerun against one stable build",
  );
  const report = {
    schemaVersion: 1,
    mode,
    passed: true,
    completedAt: new Date().toISOString(),
    revision: initialRevision,
    cases: results,
  };
  if (live) assertLiveAcceptance(report, report.revision);
  await writeFile(
    join(attempt, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      mode,
      passed: true,
      families: results.map((c) => c.family),
      report: `${root.slice(process.cwd().length + 1)}/report.json`,
    }),
  );
} catch (e) {
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        mode,
        passed: false,
        completedAt: new Date().toISOString(),
        error: e.message,
        cases: results,
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  await browser?.close();
}
