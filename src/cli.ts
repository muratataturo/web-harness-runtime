#!/usr/bin/env node
import { config } from "dotenv";
import { Command, InvalidArgumentError, Option } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import {
  improveTask,
  ImprovementStore,
  renderImprovement,
  diagnose,
  decideImprovement,
} from "./improvement.js";
import {
  loadSemanticCases,
  gradeSemanticTask,
  semanticMetrics,
  runSemanticBenchmark,
} from "./semantic-benchmark.js";
import { taskReviewSignals } from "./reviews.js";
import { FeedbackStore } from "./feedback.js";
import { Store } from "./store.js";
import { assessPage } from "./page-quality.js";
import { configuredRuntime, runtimeTarget } from "./executors.js";
import { interactionMode } from "./interaction.js";
import { decodeImprovementContext } from "./improvement-context.js";
import {
  setupCodexSandbox,
  loginCodexSandbox,
  codexSandboxStatus,
} from "./codex-sandbox.js";
import { strataConnection } from "./opencode.js";
import {
  TrustedStore,
  verifySources,
  sourceCatalog,
  activeTrustedUrls,
} from "./trusted.js";
import { claudeAuthentication, claudeModels } from "./claude.js";
import { freeQuota } from "./quota.js";
import { CodexAgent, agentEngine } from "./codex.js";
import { freeModels } from "./models.js";
import { routeSources, adapters, entityKey } from "./sources.js";
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
  .description(
    "Codex / Claude Code / pi + agent-browser 自律調査タスク runtime",
  )
  .version("0.3.0");
const integer = (value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new InvalidArgumentError("1以上の整数を指定してください");
  return number;
};
const withRunOptions = (command: Command) =>
  command
    .addOption(new Option("--openshell-outer-sandbox").hideHelp())
    .option(
      "--improvement-context <base64url>",
      "sandboxへの検証契約転送",
      decodeImprovementContext,
    )
    .option(
      "--mode <mode>",
      "auto: 承認待ちなし / approval: 推奨案を承認して再開",
      interactionMode,
      "approval",
    )
    .option(
      "--agent <engine>",
      "codex（既定）/ claude-code / pi-openrouter / opencode",
    )
    .option("--model <id>", "選択エンジンのモデルID（既定: 各カタログ）")
    .option(
      "--max-steps <n>",
      "モデルturnと調査ツール呼び出しの上限",
      integer,
      70,
    )
    .option("--timeout <seconds>", "タスク全体の制限時間", integer, 600)
    .option("--max-pages <n>", "閲覧ページ上限", integer, 12)
    .option(
      "--deepen-rounds <n>",
      "不足情報の追加調査ラウンド0〜3",
      (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 3)
          throw new InvalidArgumentError("0〜3を指定してください");
        return n;
      },
      2,
    )
    .option(
      "--allow-replacements",
      "自己改善時に同じ条件・同数以上の代替候補を探索可能にする",
    )
    .option("--self-improve", "未達を診断して最大3回の自己改善を実行")
    .option("--improve-iterations <n>", "自己改善の実行回数1〜5", integer, 3)
    .option(
      "--improve-timeout <seconds>",
      "自己改善全体の制限時間（最大3600秒）",
      integer,
      1800,
    )
    .option("--headed", "ブラウザを画面表示")
    .option("--json", "JSON形式で結果を出力");
async function execute(
  query: string,
  urls: string[],
  opts: any,
  parentId?: string,
) {
  if (
    opts.selfImprove &&
    (opts.improveIterations > 5 || opts.improveTimeout > 3600)
  )
    throw new Error("自己改善は最大5回・3600秒です");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const task = await configuredRuntime()({
      outerSandbox: opts.openshellOuterSandbox ? "openshell" : undefined,
      interactionMode: interactionMode(opts.mode),
      improvement: opts.improvementContext,
      query,
      urls,
      model: opts.model,
      agent: agentEngine(opts.agent),
      maxSteps: opts.maxSteps,
      timeoutSeconds: opts.timeout,
      maxPages: opts.maxPages,
      headed: opts.headed,
      deepenRounds: opts.deepenRounds,
      parentId,
      signal: controller.signal,
      onProgress: (m) => process.stderr.write(m + "\n"),
    });
    if (
      (opts.selfImprove ||
        (opts.mode === "approval" && task.status === "partial")) &&
      !controller.signal.aborted &&
      task.pages.some((p) => {
        const key = entityKey(p.url);
        return key && !key.startsWith("generic:") && !assessPage(p).shouldStop;
      }) &&
      task.criteria.length
    ) {
      const loop = await improveTask(task.id, {
        diagnoseOnly: !opts.selfImprove,
        interactionMode: interactionMode(opts.mode),
        allowReplacements: opts.allowReplacements,
        maxIterations: opts.improveIterations,
        timeoutSeconds: opts.improveTimeout,
        signal: controller.signal,
        onProgress: (m) => process.stderr.write(m + "\n"),
      });
      const best = await new Store().get(loop.bestTaskId);
      console.log(
        opts.json
          ? JSON.stringify({ loop, task: best }, null, 2)
          : renderImprovement(loop) + "\n\n" + renderAnswer(best),
      );
      process.exitCode = improvementExitCode(loop.status);
      return;
    }
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
  await execute(definition.query, definition.urls, {
    ...opts,
    agent: opts.agent ?? definition.agent,
    model: opts.model ?? definition.model,
  });
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
  .description("選択エンジンで利用可能なモデル一覧")
  .option("--agent <engine>", "codex / claude-code / pi-openrouter / opencode")
  .action(async (opts) => {
    if (agentEngine(opts.agent) === "opencode") {
      const c = await strataConnection();
      console.log(`${c.model}\tcontext=${c.context}`);
      return;
    }
    if (
      agentEngine(opts.agent) === "codex" &&
      runtimeTarget() === "openshell"
    ) {
      const status = await codexSandboxStatus();
      if (!status.authenticated)
        throw new Error(
          "Codex workerの起動・ChatGPTログインを確認してください。ホストのモデル一覧には切り替えません",
        );
      for (const model of status.models) console.log(model);
      return;
    }
    if (agentEngine(opts.agent) === "claude-code") {
      await claudeAuthentication();
      for (const m of claudeModels) console.log(m);
      return;
    }
    if (agentEngine(opts.agent) === "pi-openrouter") {
      for (const m of await freeModels())
        console.log(`${m.id}\tcontext=${m.context_length}\t${m.name}`);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const client = new CodexAgent({
      cwd: process.cwd(),
      signal: controller.signal,
      onStep: async () => {},
    });
    try {
      await client.initialize();
      for (const m of await client.models())
        console.log(
          `${m.model}\t${m.isDefault ? "default" : "available"}\t${m.displayName}`,
        );
    } finally {
      clearTimeout(timer);
      await client.close();
    }
  });
const runsCommand = program
  .command("runs")
  .description("Chat / MCPと同じdaemon上の相談・承認を操作");
const endpointOption = (c: Command) =>
  c.option(
    "--endpoint <origin>",
    "local daemon",
    process.env.HARNESS_URL ?? "http://127.0.0.1:4310",
  );
endpointOption(
  runsCommand
    .command("start")
    .argument("<query>")
    .requiredOption("--url <urls...>")
    .option("--mode <mode>", "auto / approval", "approval")
    .option("--agent <agent>")
    .option("--model <model>")
    .option("--source <source>", "live / replay", "live")
    .option("--example <id>", "day-out / life-plan / books", "day-out")
    .option("--confirm-live", "実調査によるモデル利用枠の使用を明示"),
).action(async (query, opts) => {
  const { harnessCall } = await import("./public-mcp.js");
  console.log(
    JSON.stringify(
      await harnessCall(
        "harness_start",
        {
          query,
          urls: opts.url,
          mode: opts.mode,
          source: opts.source,
          example: opts.example,
          confirmLive: !!opts.confirmLive,
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        },
        opts.endpoint,
      ),
      null,
      2,
    ),
  );
});
for (const action of ["get", "cancel"] as const)
  endpointOption(runsCommand.command(action).argument("<id>")).action(
    async (id, opts) => {
      const { harnessCall } = await import("./public-mcp.js");
      console.log(
        JSON.stringify(
          await harnessCall(`harness_${action}`, { id }, opts.endpoint),
          null,
          2,
        ),
      );
    },
  );
endpointOption(runsCommand.command("list")).action(async (opts) => {
  const { harnessCall } = await import("./public-mcp.js");
  console.log(
    JSON.stringify(
      await harnessCall("harness_list", {}, opts.endpoint),
      null,
      2,
    ),
  );
});
endpointOption(
  runsCommand
    .command("decide")
    .argument("<id>")
    .requiredOption("--gate <id>")
    .requiredOption("--revision <n>", "表示されたrevision", integer)
    .requiredOption("--choice <id>")
    .option("--additional-url <urls...>"),
).action(async (id, opts) => {
  const { harnessCall } = await import("./public-mcp.js");
  console.log(
    JSON.stringify(
      await harnessCall(
        "harness_decide",
        {
          id,
          gateId: opts.gate,
          revision: opts.revision,
          choiceId: opts.choice,
          confirmedByUser: true,
          ...(opts.additionalUrl ? { additionalUrls: opts.additionalUrl } : {}),
        },
        opts.endpoint,
      ),
      null,
      2,
    ),
  );
});
program
  .command("clients")
  .description(
    "Codex / Claude Code / pi / OpenCode用のMCP設定を生成（既存設定を変更しない）",
  )
  .option("--output <directory>", "出力先", ".runtime/clients")
  .option("--url <origin>", "daemon origin", "http://127.0.0.1:4310")
  .action(async (opts) => {
    const { writeClientConfigs } = await import("./client-config.js");
    console.log(
      JSON.stringify(await writeClientConfigs(opts.output, opts.url), null, 2),
    );
  });
program
  .command("mcp")
  .description("MCP stdio bridge。先にchat/web daemonを起動してください")
  .option(
    "--url <origin>",
    "loopback daemon origin",
    process.env.HARNESS_URL ?? "http://127.0.0.1:4310",
  )
  .action(async (opts) => {
    const { startPublicMcp } = await import("./public-mcp.js");
    await startPublicMcp(opts.url);
  });
program
  .command("chat")
  .description("Recruit / RakutenスタイルのローカルChat UIと共有runtime API")
  .option("--port <port>", "loopback port", integer, 4310)
  .action(async (opts) => {
    await startWorkbench(opts.port);
  });
program
  .command("quota")
  .description("OpenRouter無料枠の残量と回復時刻を確認（Codex利用枠とは別）")
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
  if (task.evaluation)
    throw new Error("凍結ベンチマークはbenchmark runで再実行してください");
  await execute(
    task.query,
    task.urls,
    { ...opts, agent: opts.agent ?? task.agent ?? "pi-openrouter" },
    id,
  );
});
function improvementExitCode(status: string) {
  return status === "succeeded"
    ? 0
    : status === "cancelled"
      ? 130
      : ["needs_input", "completed_partial"].includes(status)
        ? 2
        : 1;
}
program
  .command("improve")
  .option(
    "--diagnose-only",
    "追加推論せず保存済み根拠だけでmodeの終了・承認を作る",
  )
  .option("--mode <mode>", "auto / approval", interactionMode, "approval")
  .description("保存タスクの未達を診断・計画・再実行・検証し最良結果を保存")
  .argument("<task-id>")
  .option("--allow-replacements", "同じ条件・同数以上の代替候補の探索を許可")
  .option("--url <urls...>", "確認に使う同一対象の追加公開URL（最大8件）")
  .option("--iterations <n>", "最大改善回数1〜5", integer, 3)
  .option(
    "--timeout <seconds>",
    "ループ全体の制限時間（最大3600秒）",
    integer,
    1800,
  )
  .option("--agent <engine>", "省略時は元タスクのエンジン")
  .option("--model <id>", "省略時は元タスクのモデル。別エンジンなら明示指定")
  .option("--json")
  .action(async (id, opts) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const loop = await improveTask(id, {
        diagnoseOnly: opts.diagnoseOnly,
        interactionMode: interactionMode(opts.mode),
        allowReplacements: opts.allowReplacements,
        additionalUrls: opts.url,
        maxIterations: opts.iterations,
        timeoutSeconds: opts.timeout,
        agent: opts.agent ? agentEngine(opts.agent) : undefined,
        model: opts.model,
        signal: controller.signal,
        onProgress: (m) => process.stderr.write(m + "\n"),
      });
      const task = await new Store().get(loop.bestTaskId);
      console.log(
        opts.json
          ? JSON.stringify({ loop, task }, null, 2)
          : renderImprovement(loop) + "\n\n" + renderAnswer(task),
      );
      process.exitCode = improvementExitCode(loop.status);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
const improvements = program
  .command("improvements")
  .description("自己改善の診断・採否・最良結果・要確認事項の履歴");
improvements
  .command("decide")
  .argument("<loop-id>")
  .requiredOption("--approval <id>", "表示された承認ID")
  .requiredOption("--choice <id>", "return_partial / research_more / add_url")
  .option("--url <urls...>", "同一候補の追加公開URL")
  .option("--json")
  .action(async (id, opts) => {
    const loop = await decideImprovement(id, {
      approvalId: opts.approval,
      choiceId: opts.choice,
      additionalUrls: opts.url,
    });
    const task = await new Store().get(loop.bestTaskId);
    console.log(
      opts.json
        ? JSON.stringify({ loop, task }, null, 2)
        : renderImprovement(loop) + "\n\n" + renderAnswer(task),
    );
    process.exitCode = improvementExitCode(loop.status);
  });
improvements
  .command("diagnose")
  .argument("<task-id>")
  .description("推論せず保存済み本文と引用から未達を再診断")
  .action(async (id) => {
    const task = await new Store().get(id);
    console.log(
      JSON.stringify(
        diagnose(
          task,
          task.criteria,
          task.answer?.candidates.map((c) => c.url) ?? [],
        ),
        null,
        2,
      ),
    );
  });
improvements.command("list").action(async () => {
  for (const l of await new ImprovementStore().list())
    console.log(
      `${l.id}\t${l.status}\t${l.sourceTaskId}\t${l.best.gaps.length}未達`,
    );
});
improvements
  .command("show")
  .argument("<id>")
  .option("--json")
  .action(async (id, opts) => {
    const loop = await new ImprovementStore().get(id);
    console.log(
      opts.json ? JSON.stringify(loop, null, 2) : renderImprovement(loop),
    );
  });
const benchmark = program
  .command("benchmark")
  .description("正解ラベル付き凍結資料による限定的な意味判定ベンチマーク");
benchmark.command("list").action(async () => {
  for (const c of await loadSemanticCases())
    console.log(
      `${c.id}\t${c.service}\t${c.expected.length}判定\t${c.provenance.annotationStatus}`,
    );
});
benchmark
  .command("inspect")
  .argument("<case-id>")
  .description("正解ラベルと根拠を人がレビューするため表示")
  .action(async (id) => {
    const c = (await loadSemanticCases()).find((c) => c.id === id);
    if (!c) throw new Error("不明なケースID");
    console.log(JSON.stringify(c, null, 2));
  });
benchmark
  .command("check")
  .description("データと根拠の整合性を確認。推論なし")
  .action(async () => {
    const cases = await loadSemanticCases();
    console.log(
      JSON.stringify(
        {
          cases: cases.length,
          labels: cases.reduce((s, c) => s + c.expected.length, 0),
          humanReviewed: cases.filter(
            (c) => c.provenance.independentHumanReview,
          ).length,
          scope: "targeted-entailment-regression",
          freeTextReview: "not_evaluated",
        },
        null,
        2,
      ),
    );
  });
benchmark
  .command("run")
  .option("--case <ids...>")
  .option("--agent <engine>")
  .option("--model <id>")
  .option("--max-steps <n>", "ケースごとのステップ上限", integer, 40)
  .option("--timeout <seconds>", "ケースごとの時間上限", integer, 120)
  .option("--json")
  .action(async (opts) => {
    const controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const report = await runSemanticBenchmark({
        caseIds: opts.case,
        agent: agentEngine(opts.agent),
        model: opts.model,
        maxSteps: opts.maxSteps,
        timeoutSeconds: opts.timeout,
        signal: controller.signal,
        onProgress: (m) => process.stderr.write(m + "\n"),
      });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = controller.signal.aborted
        ? 130
        : report.overallPass
          ? 0
          : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
benchmark
  .command("grade")
  .argument("<task-id>")
  .requiredOption("--case <id>")
  .action(async (id, opts) => {
    const c = (await loadSemanticCases()).find((c) => c.id === opts.case);
    if (!c) throw new Error("不明なケースID");
    const result = gradeSemanticTask(c, await new Store().get(id));
    console.log(
      JSON.stringify({ result, metrics: semanticMetrics([result]) }, null, 2),
    );
    process.exitCode = result.strictPass ? 0 : 2;
  });
program
  .command("reviews")
  .argument("<task-id>")
  .description("対象サービスの口コミ指標。回答満足度とは別")
  .option("--json")
  .action(async (id) => {
    const task = await new Store().get(id);
    console.log(
      JSON.stringify(
        {
          taskId: task.id,
          mode: task.evaluation?.mode ?? "captured-live-task",
          signals: taskReviewSignals(task),
          note: "評点はサービス利用者の参考指標。回答への満足度や満足者の割合ではありません。表示件数の集計期間は未確認",
        },
        null,
        2,
      ),
    );
  });
const feedback = program
  .command("feedback")
  .description("ローカル利用者による回答への評価。口コミと分離");
feedback
  .command("add")
  .argument("<task-id>")
  .requiredOption("--rating <1-5>", "回答の満足度", integer)
  .requiredOption("--helpful <yes-no>", "役に立ったか", (v) => {
    if (!["yes", "no"].includes(v))
      throw new InvalidArgumentError("yesまたはnoを指定");
    return v === "yes";
  })
  .option("--candidate-url <url>")
  .option("--note <text>")
  .action(async (id, opts) => {
    console.log(
      JSON.stringify(
        await new FeedbackStore().add(id, {
          rating: opts.rating,
          helpful: opts.helpful,
          candidateUrl: opts.candidateUrl,
          note: opts.note,
        }),
        null,
        2,
      ),
    );
  });
feedback
  .command("summary")
  .action(async () =>
    console.log(JSON.stringify(await new FeedbackStore().summary(), null, 2)),
  );
program
  .command("doctor")
  .description("実行エンジンの認証・モデル・ブラウザを確認")
  .option("--agent <engine>", "codex / claude-code / pi-openrouter / opencode")
  .action(async (opts) => {
    let ok = true;
    console.log(`Node: ${process.version}`);
    const engine = agentEngine(opts.agent);
    console.log(`Agent: ${engine}`);
    try {
      const { stdout } = await promisify(execFile)(browserBin, ["doctor"], {
        timeout: 25000,
      });
      console.log(stdout.trim());
    } catch (e: any) {
      ok = false;
      console.log(`browser: ${e.message}`);
    }
    if (engine === "claude-code") {
      try {
        const auth = await claudeAuthentication();
        console.log(
          `Claude Code: ${auth.authentication} / ${auth.subscriptionType}`,
        );
      } catch (e: any) {
        ok = false;
        console.log(e.message);
      }
    } else if (engine === "codex" && runtimeTarget() === "openshell") {
      const status = await codexSandboxStatus();
      console.log(JSON.stringify(status));
      ok = status.authenticated;
    } else if (engine === "codex") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const client = new CodexAgent({
        cwd: process.cwd(),
        signal: controller.signal,
        onStep: async () => {},
      });
      try {
        const auth = await client.initialize();
        const models = await client.models();
        console.log(
          `Codex: ${auth.authentication} / ${auth.planType} / ${models.length} models`,
        );
      } catch (e: any) {
        ok = false;
        console.log(e.message);
      } finally {
        clearTimeout(timer);
        await client.close();
      }
    } else if (engine === "opencode") {
      try {
        const c = await strataConnection();
        console.log(`OpenCode / ${c.model} / context=${c.context}`);
      } catch (e) {
        ok = false;
        console.log(e instanceof Error ? e.message : String(e));
      }
    } else {
      console.log(
        `OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? "設定済み（値は非表示）" : "未設定"}`,
      );
      if (!process.env.OPENROUTER_API_KEY) ok = false;
      try {
        const models = await freeModels();
        console.log(`無料・ツール対応モデル: ${models.length}件`);
        if (!models.length) ok = false;
      } catch (e: any) {
        ok = false;
        console.log(e.message);
      }
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
const sandboxCodex = sandbox
  .command("codex")
  .description("サブスク用の専用Codex MicroVMを初期設定・ログイン");
for (const action of ["setup", "login"] as const) {
  sandboxCodex
    .command(action)
    .requiredOption("--gateway <name>")
    .option("--name <name>", "アカウント専用worker名", "wh-codex")
    .option("--image <image>", "Codex同梱イメージ", "web-harness-codex:local")
    .action(async (opts) => {
      console.log(
        JSON.stringify(
          await (action === "setup"
            ? setupCodexSandbox(opts)
            : loginCodexSandbox(opts)),
          null,
          2,
        ),
      );
    });
}
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
  .option("--agent <engine>", "codex / claude-code / pi-openrouter / opencode")
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
        agent: agentEngine(opts.agent),
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
        result.some(
          (r) => !["validated", "details_verified"].includes(r.outcome),
        )
      )
        process.exitCode = 2;
    } finally {
      process.removeListener("SIGINT", cancel);
    }
  });

program
  .command("codex-doctor")
  .description("公式CodexのChatGPTログインとモデル一覧を確認（推論なし）")
  .action(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const client = new CodexAgent({
      cwd: process.cwd(),
      signal: controller.signal,
      onStep: async () => {},
    });
    try {
      console.log(
        JSON.stringify(
          { ...(await client.initialize()), models: await client.models() },
          null,
          2,
        ),
      );
    } finally {
      clearTimeout(timer);
      await client.close();
    }
  });
program
  .command("claude-doctor")
  .description("Claude Codeのサブスク認証と対応モデルを確認（推論なし）")
  .action(async () =>
    console.log(
      JSON.stringify(
        { ...(await claudeAuthentication()), models: claudeModels },
        null,
        2,
      ),
    ),
  );
const trusted = program
  .command("trusted")
  .description("個別詳細を実取得できたURLだけを台帳に登録する");
trusted
  .command("list")
  .option("--all", "未確認・失敗のsourceも表示")
  .option(
    "--min-level <n>",
    "L3またはL4",
    (value) => {
      const n = Number(value);
      if (n !== 3 && n !== 4) throw new InvalidArgumentError("3または4を指定");
      return n;
    },
    3,
  )
  .option("--json")
  .action(async (opts) => {
    const registry = await new TrustedStore().load();
    if (opts.json) {
      console.log(
        JSON.stringify(
          opts.all
            ? registry
            : activeTrustedUrls(registry).filter(
                (u) => (u.level ?? 3) >= opts.minLevel,
              ),
          null,
          2,
        ),
      );
      return;
    }
    for (const source of await sourceCatalog()) {
      const urls = activeTrustedUrls(registry).filter(
        (u) => u.sourceId === source.id && (u.level ?? 3) >= opts.minLevel,
      );
      const audit = registry.audits.find((a) => a.sourceId === source.id);
      const level = urls.length
        ? `L${Math.min(...urls.map((u) => u.level ?? 3))}–L${Math.max(...urls.map((u) => u.level ?? 3))}`
        : `L${audit?.status === "blocked" || audit?.status === "retired" ? 0 : Math.max(0, ...(audit?.details ?? []).map((d) => d.level ?? (d.status === "verified" ? 3 : 2)))}`;
      if (opts.all || urls.length)
        console.log(
          `${source.id}\t${urls.length ? "trusted" : audit?.status === "verified" ? "expired" : (audit?.status ?? "unverified")}\t${urls.length} URL\t${level}\t${source.label}`,
        );
    }
  });
trusted
  .command("verify")
  .option("--source <ids...>")
  .option("--family <name>", "recruit または rakuten")
  .option("--parallel <n>", "並列数1または2", integer, 2)
  .option("--timeout <seconds>", "sourceごとの制限時間", integer, 75)
  .action(async (opts) => {
    const results = await verifySources({
      ids: opts.source,
      family: opts.family,
      parallel: opts.parallel,
      timeoutSeconds: opts.timeout,
      onProgress: (m) => process.stderr.write(m + "\n"),
    });
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.status !== "verified")) process.exitCode = 2;
  });
withRunOptions(
  trusted
    .command("run")
    .argument("<query>")
    .requiredOption("--source <ids...>", "有効なtrusted source ID")
    .option(
      "--min-level <n>",
      "L3またはL4",
      (value) => {
        const n = Number(value);
        if (n !== 3 && n !== 4)
          throw new InvalidArgumentError("3または4を指定");
        return n;
      },
      3,
    ),
).action(async (query, opts) =>
  execute(
    query,
    await new TrustedStore().urlsFor(opts.source, opts.minLevel),
    opts,
  ),
);
trusted
  .command("plan")
  .argument("<query>")
  .action(async (query) => {
    const r = await new TrustedStore().load();
    console.log(
      JSON.stringify(
        routeSources(
          query,
          activeTrustedUrls(r).map((u) => u.url),
        ),
        null,
        2,
      ),
    );
  });
const goal = program
  .command("goal")
  .description("複数エージェントの目標・選択・履歴をCLIから操作");
goal
  .command("create")
  .option("--mode <mode>", "auto / approval", interactionMode, "approval")
  .argument("[text]")
  .option("--scenario <type>", "travel または life", "travel")
  .option("--live", "実サイト調査（既定はAPIを使わない体験）")
  .action(async (text, opts) => {
    const engine = new GoalEngine();
    const created = await engine.create({
      interactionMode: interactionMode(opts.mode),
      scenario: opts.scenario,
      text,
      mode: opts.live ? "live" : "demo",
    });
    console.log(
      JSON.stringify(
        opts.mode === "auto" ? await engine.settle(created.id) : created,
        null,
        2,
      ),
    );
  });
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
