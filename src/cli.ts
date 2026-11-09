#!/usr/bin/env node
import { config } from "dotenv";
import { Command, InvalidArgumentError } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { Store } from "./store.js";
import { runTask } from "./runtime.js";
import { freeQuota } from "./quota.js";
import { freeModels } from "./models.js";
import { routeSources, adapters } from "./sources.js";
import { browserBin } from "./browser.js";
import { GoalEngine } from "./goals.js";
import { startWorkbench } from "./server.js";
import {
  runServiceEvaluations,
  probeServiceCases,
  loadServiceCases,
} from "./service-evals.js";
import {
  planOpenShellTask,
  writeOpenShellPlan,
  executeOpenShellPlan,
  doctorOpenShell,
} from "./sandbox.js";
import { renderAnswer } from "./evidence.js";
config({ quiet: true });
process.umask(0o077);
const program = new Command()
  .name("web-harness")
  .description("Pi + OpenRouter + agent-browser 自律調査タスク runtime")
  .version("0.2.0");
const integer = (value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new InvalidArgumentError("1以上の整数を指定してください");
  return number;
};
const withRunOptions = (command: Command) =>
  command
    .option(
      "--model <id>",
      "無料・ツール対応モデルID（既定: カタログから選択）",
    )
    .option(
      "--max-steps <n>",
      "モデル要求とツール呼び出しの合計上限",
      integer,
      70,
    )
    .option("--timeout <seconds>", "タスク全体の制限時間", integer, 600)
    .option("--max-pages <n>", "閲覧ページ上限", integer, 12)
    .option("--headed", "ブラウザを画面表示")
    .option("--json", "JSON形式で結果を出力");
async function execute(
  query: string,
  urls: string[],
  opts: any,
  parentId?: string,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const task = await runTask({
      query,
      urls,
      model: opts.model,
      maxSteps: opts.maxSteps,
      timeoutSeconds: opts.timeout,
      maxPages: opts.maxPages,
      headed: opts.headed,
      parentId,
      signal: controller.signal,
      onProgress: (m) => process.stderr.write(m + "\n"),
    });
    console.log(opts.json ? JSON.stringify(task, null, 2) : renderAnswer(task));
    process.stderr.write(
      `status: ${task.status}\nartifacts: ${new Store().dir(task.id)}\n`,
    );
    if (task.status === "cancelled") process.exitCode = 130;
    else if (
      ["failed", "timed_out", "blocked"].includes(task.status) ||
      !task.answer
    )
      process.exitCode = 1;
    else if (task.status === "partial") process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
withRunOptions(
  program
    .command("run")
    .description("URLから調査し、根拠付きの比較回答を作成")
    .argument("<query>", "自然言語クエリ")
    .option("-u, --url <url...>", "候補URL（複数指定可能）", [
      "https://beauty.hotpepper.jp/",
    ]),
).action(async (query, opts) => execute(query, opts.url, opts));
withRunOptions(
  program
    .command("run-file")
    .description("JSONタスク定義を実行")
    .argument("<file>"),
).action(async (file, opts) => {
  const definition = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof definition.query !== "string" ||
    !Array.isArray(definition.urls) ||
    !definition.urls.every((u: unknown) => typeof u === "string")
  )
    throw new Error("定義には query:string と urls:string[] が必要です");
  await execute(definition.query, definition.urls, opts);
});
program
  .command("plan")
  .description("モデルやブラウザを使わずソース選択を確認")
  .argument("<query>")
  .requiredOption("-u, --url <url...>", "候補URL")
  .action((query, opts) =>
    console.log(JSON.stringify(routeSources(query, opts.url), null, 2)),
  );
program
  .command("models")
  .description("現在の無料・ツール対応モデル一覧")
  .action(async () => {
    for (const m of await freeModels())
      console.log(`${m.id}\tcontext=${m.context_length}\t${m.name}`);
  });
program
  .command("quota")
  .description("無料枠の残量と次の回復時刻を確認（推論は実行しない）")
  .option("--json")
  .action(async (opts) => {
    const quota = await freeQuota();
    console.log(
      opts.json
        ? JSON.stringify(quota, null, 2)
        : `無料枠: 残り ${quota.remaining}/${quota.limit} リクエスト（本日使用 ${quota.used}）\n次の日次リセット: ${quota.resetsAtJapan} 日本時間（00:00 UTC）`,
    );
  });
program
  .command("sources")
  .description("登録済みサイトアダプター一覧")
  .action(() => {
    for (const a of adapters)
      console.log(`${a.id}\t${a.hosts.join(", ")}\n  ${a.guidance}`);
  });
program
  .command("tasks")
  .description("保存済みタスク一覧")
  .action(async () => {
    for (const task of await new Store().list())
      console.log(`${task.id}\t${task.status}\t${task.query}`);
  });
program
  .command("show")
  .description("保存済み回答を表示")
  .argument("<id>")
  .option("--json")
  .action(async (id, opts) => {
    const task = await new Store().get(id);
    console.log(opts.json ? JSON.stringify(task, null, 2) : renderAnswer(task));
  });
withRunOptions(
  program
    .command("retry")
    .description("元タスクのクエリとURLで新規調査（parentIdで関連付け）")
    .argument("<id>"),
).action(async (id, opts) => {
  const task = await new Store().get(id);
  await execute(task.query, task.urls, opts, id);
});
program
  .command("doctor")
  .description("キー設定・ブラウザ・無料モデル一覧への接続を確認")
  .action(async () => {
    let ok = true;
    console.log(`Node: ${process.version}`);
    console.log(
      `OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? "設定済み（値は非表示）" : "未設定"}`,
    );
    if (!process.env.OPENROUTER_API_KEY) ok = false;
    try {
      const { stdout } = await promisify(execFile)(browserBin, ["doctor"], {
        timeout: 25000,
      });
      console.log(stdout.trim());
    } catch (e: any) {
      ok = false;
      console.log(`browser: ${e.stdout || e.message}`);
    }
    try {
      const models = await freeModels();
      console.log(
        `無料・ツール対応モデル: ${models.length}件 / 既定候補: ${models[0]?.id ?? "なし"}`,
      );
      if (!models.length) ok = false;
    } catch (e: any) {
      ok = false;
      console.log(`models: ${e.message}`);
    }
    if (!ok) process.exitCode = 1;
  });
program
  .command("web")
  .description("会話・承認・チーム作業のWeb Mockを起動")
  .option("--port <n>", "ローカルport", integer, 4310)
  .action(async (opts) => {
    await startWorkbench(opts.port);
  });
const sandbox = program
  .command("sandbox")
  .description("OpenShellの計画・実行・環境確認");
function sandboxOptions(command: Command) {
  return command
    .argument("<query>")
    .requiredOption("--gateway <name>", "登録済みgateway名")
    .requiredOption("-u, --url <url...>", "候補URL")
    .option("--image <reference>", "runtimeイメージ")
    .option("--provider <name>", "gateway provider")
    .option("--name <name>", "sandbox名")
    .option("--directory <path>", "成果物保存先");
}
sandboxOptions(
  sandbox.command("plan").description("VMへ接続せず発行計画とpolicyを保存"),
).action(async (query, opts) => {
  const plan = planOpenShellTask({ query, urls: opts.url, ...opts });
  await writeOpenShellPlan(plan);
  console.log(JSON.stringify(plan, null, 2));
});
sandboxOptions(
  sandbox
    .command("run")
    .description("登録済みgatewayへsandboxを発行しタスクを実行"),
).action(async (query, opts) => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const plan = planOpenShellTask({ query, urls: opts.url, ...opts });
    const execution = await executeOpenShellPlan(plan, {
      confirmed: true,
      signal: controller.signal,
      onOutput: (_stream, text) => process.stderr.write(text),
    });
    console.log(JSON.stringify(execution, null, 2));
    if (execution.status !== "completed") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
});
sandbox
  .command("doctor")
  .option("--gateway <name>")
  .action(async (opts) => {
    const result = await doctorOpenShell(opts.gateway);
    console.log(JSON.stringify(result, null, 2));
    if (!result.available) process.exitCode = 1;
  });
program
  .command("eval")
  .description("5サービスの条件付きクエリを再現可能に評価")
  .option("--list", "ケース一覧のみ表示")
  .option("--case <ids...>", "評価ケースID")
  .option(
    "--browser-only",
    "モデルを使わず本文と詳細導線のみ検証（公開HTML/ブラウザ）",
  )
  .option("--retrieval-only", "取得のみ検証する（--browser-onlyの別名）")
  .option("--parallel <n>", "並列数1または2", integer, 1)
  .option("--model <id>")
  .option("--timeout <seconds>", "ケースごとの制限時間", integer, 180)
  .action(async (opts) => {
    if (opts.list) {
      console.log(JSON.stringify(await loadServiceCases(), null, 2));
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    try {
      const options = {
        caseIds: opts.case,
        parallel: opts.parallel,
        model: opts.model,
        timeoutSeconds: opts.timeout,
        signal: controller.signal,
        onProgress: (m: string) => process.stderr.write(m + "\n"),
      };
      const result =
        opts.browserOnly || opts.retrievalOnly
          ? await probeServiceCases(options)
          : await runServiceEvaluations(options);
      console.log(JSON.stringify(result, null, 2));
      if (
        result.some((r) => !["validated", "details_read"].includes(r.outcome))
      )
        process.exitCode = 2;
    } finally {
      process.removeListener("SIGINT", cancel);
    }
  });
const goal = program
  .command("goal")
  .description("複数エージェントの目標・選択・履歴をCLIから操作");
goal
  .command("create")
  .argument("[text]")
  .option("--scenario <type>", "travel または life", "travel")
  .option("--live", "実サイト調査（既定はAPIを使わない体験）")
  .action(async (text, opts) =>
    console.log(
      JSON.stringify(
        await new GoalEngine().create({
          scenario: opts.scenario,
          text,
          mode: opts.live ? "live" : "demo",
        }),
        null,
        2,
      ),
    ),
  );
goal
  .command("list")
  .action(async () =>
    console.log(JSON.stringify(await new GoalEngine().repo.list(), null, 2)),
  );
goal
  .command("show")
  .argument("<id>")
  .action(async (id) =>
    console.log(JSON.stringify(await new GoalEngine().repo.get(id), null, 2)),
  );
goal
  .command("decide")
  .argument("<id>")
  .requiredOption("--gate <id>")
  .requiredOption("--revision <n>", "対象改訂", integer)
  .requiredOption("--choice <id>")
  .option("--note <text>")
  .action(async (id, opts) => {
    const engine = new GoalEngine();
    await engine.decide(id, {
      gateId: opts.gate,
      revision: opts.revision,
      choiceId: opts.choice,
      note: opts.note,
    });
    console.log(JSON.stringify(await engine.settle(id), null, 2));
  });
goal
  .command("revise")
  .argument("<id>")
  .option("--text <text>")
  .action(async (id, opts) =>
    console.log(
      JSON.stringify(await new GoalEngine().revise(id, opts.text), null, 2),
    ),
  );
goal
  .command("cancel")
  .argument("<id>")
  .action(async (id) =>
    console.log(JSON.stringify(await new GoalEngine().cancel(id), null, 2)),
  );
program.parseAsync().catch((e) => {
  const key = process.env.OPENROUTER_API_KEY;
  const message = e instanceof Error ? e.message : String(e);
  console.error(key ? message.split(key).join("[REDACTED]") : message);
  process.exitCode = 1;
});
