import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GoalEngine, scenarioDefaults } from "./goals.js";
import { Store } from "./store.js";
import { claudeAuthentication } from "./claude.js";
import { agentEngine, CodexAgent } from "./codex.js";
import { runtimeTarget } from "./executors.js";
import { doctorOpenShell } from "./sandbox.js";
import { ImprovementStore, decideImprovement } from "./improvement.js";
import { codexSandboxStatus } from "./codex-sandbox.js";
import { strataConnection } from "./opencode.js";
import { VisualPreviewStore } from "./visual-preview.js";
import { RunService, runtimeCapabilities } from "./run-service.js";
const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16000) throw new Error("リクエストが大きすぎます");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
export function createWorkbenchServer(
  engine = new GoalEngine(),
  taskStore = new Store(),
  runs = new RunService(taskStore),
) {
  const streams = new Set<ServerResponse>();
  const visuals = new VisualPreviewStore(taskStore.root);
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
        send(res, 403, { error: "ローカルアクセスのみです" });
        return;
      }
      // No CORS: pages on other origins cannot issue mutations against this local runtime.
      const origin = req.headers.origin;
      if (origin && ![`http://${host}`, `https://${host}`].includes(origin)) {
        send(res, 403, { error: "別originからのアクセスは許可していません" });
        return;
      }
      if (
        req.method !== "GET" &&
        req.headers["content-type"]?.split(";")[0] !== "application/json"
      ) {
        send(res, 415, { error: "application/json が必要です" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path === "/api/runtime" && req.method === "GET") {
        send(res, 200, runtimeCapabilities());
        return;
      }
      if (path === "/api/examples" && req.method === "GET") {
        const examples = await Promise.all(
          ["day-out", "life-plan"].map(async (id) => ({
            id,
            ...JSON.parse(
              await readFile(
                new URL(`../examples/recruit-${id}.json`, import.meta.url),
                "utf8",
              ),
            ),
          })),
        );
        send(res, 200, [
          ...examples.map((example) => ({
            ...example,
            query:
              example.id === "day-out"
                ? "2026年11月14日（土）、大人2人と5歳児で上野を一日楽しみたい。家族予算16,000円、休憩2回。動物を主役に、科学博物館は無理のない範囲で。土曜に使えるランチと雨の日の案、交通・食事を含む予算も教えて。"
                : "武蔵小杉周辺で、リモート中心の仕事と駅近の家、週末に使える小さな車のある暮らしを考えたい。住居は1LDK・駅徒歩10分以内・家賃と管理費で月15万円以内。仕事は正社員・年収下限500万円以上を希望。車は支払総額150万円以内。仕事・住居・車を決める順番と、無理のない行動案を教えて。",
          })),
          {
            id: "books",
            title: "本の確認・承認モードを試す",
            query:
              "この本の価格と著者本人の直筆サイン付きを確認してください。記載がなければunknownを保持してください。",
            urls: ["https://books.rakuten.co.jp/rb/18577690/"],
          },
        ]);
        return;
      }
      if (path === "/api/runs") {
        if (req.method === "GET") send(res, 200, await runs.list());
        else if (req.method === "POST")
          send(res, 202, await runs.create(await body(req)));
        else send(res, 405, { error: "GET / POST only" });
        return;
      }
      const visualMatch = path.match(
        /^\/api\/runs\/([a-zA-Z0-9-]+)\/artifacts\/([a-zA-Z0-9-]+)\/visual(?:\/(image-[0-2]|screen\.png))?$/,
      );
      if (visualMatch) {
        const artifact = await runs.artifact(visualMatch[1]!, visualMatch[2]!);
        if (req.method === "GET" && visualMatch[3]) {
          const image = await visuals.file(artifact, visualMatch[3]);
          res.writeHead(200, {
            "Content-Type": image.type,
            "Cache-Control": "private, max-age=600",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(image.bytes);
        } else if (req.method === "POST" && !visualMatch[3]) {
          const input = await body(req);
          send(res, 200, await visuals.load(artifact, input.capture === true));
        } else if (req.method === "GET" && !visualMatch[3])
          send(res, 200, (await visuals.cached(artifact)) ?? null);
        else send(res, 405, { error: "GET / POST only" });
        return;
      }
      const artifactMatch = path.match(
        /^\/api\/runs\/([a-zA-Z0-9-]+)\/artifacts\/([a-zA-Z0-9-]+)$/,
      );
      if (artifactMatch && req.method === "GET") {
        send(
          res,
          200,
          await runs.artifact(artifactMatch[1]!, artifactMatch[2]!),
        );
        return;
      }
      const runMatch = path.match(
        /^\/api\/runs\/([a-zA-Z0-9-]+)(?:\/(decision|cancel|events))?$/,
      );
      if (runMatch) {
        if (req.method === "GET" && runMatch[2] === "events") {
          const current = await runs.get(runMatch[1]!);
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          });
          const sendEvent = (record: typeof current) =>
            res.write(
              `id: ${record.updatedAt}\nevent: run\ndata: ${JSON.stringify(record)}\n\n`,
            );
          sendEvent(current);
          if (!["running", "needs_input"].includes(current.status)) {
            res.end();
            return;
          }
          streams.add(res);
          const unsub = runs.subscribe(current.id, (record) => {
            if (res.destroyed || res.writableEnded) return;
            sendEvent(record);
            if (!["running", "needs_input"].includes(record.status)) {
              unsub();
              res.end();
            }
          });
          const heartbeat = setInterval(
            () => res.write(": heartbeat\n\n"),
            15000,
          );
          heartbeat.unref();
          res.once("close", () => {
            streams.delete(res);
            clearInterval(heartbeat);
            unsub();
          });
          return;
        }
        if (req.method === "GET" && !runMatch[2])
          send(res, 200, await runs.get(runMatch[1]!));
        else if (req.method === "POST" && runMatch[2] === "decision")
          send(res, 202, await runs.decide(runMatch[1]!, await body(req)));
        else if (req.method === "POST" && runMatch[2] === "cancel")
          send(res, 200, await runs.cancel(runMatch[1]!));
        else send(res, 405, { error: "Unsupported method" });
        return;
      }
      if (path === "/api/improvements" && req.method === "GET") {
        send(res, 200, await new ImprovementStore(taskStore).list());
        return;
      }
      const improvementMatch = path.match(
        /^\/api\/improvements\/([a-zA-Z0-9-]+)\/decision$/,
      );
      if (improvementMatch && req.method === "POST") {
        const loop = await decideImprovement(
          improvementMatch[1]!,
          await body(req),
          taskStore,
        );
        send(res, 200, { loop, task: await taskStore.get(loop.bestTaskId) });
        return;
      }
      if (path === "/api/config" && req.method === "GET") {
        const agent = agentEngine();
        let codexReady = false;
        let codexWorkerPhase: string | undefined;
        if (agent === "codex" && runtimeTarget() === "openshell") {
          try {
            const status = await codexSandboxStatus();
            codexReady = status.authenticated;
            codexWorkerPhase = status.phase;
          } catch {}
        }
        if (agent === "codex" && runtimeTarget() === "local") {
          const signal = AbortSignal.timeout(10000);
          const client = new CodexAgent({
            cwd: process.cwd(),
            signal,
            onStep: async () => {},
          });
          try {
            await client.initialize();
            codexReady = true;
          } catch {
          } finally {
            await client.close();
          }
        }
        let claudeReady = false;
        let opencodeReady = false;
        if (agent === "opencode" && runtimeTarget() === "local") {
          try {
            await strataConnection();
            opencodeReady = true;
          } catch {}
        }
        if (agent === "claude-code" && runtimeTarget() === "local")
          try {
            await claudeAuthentication(undefined, AbortSignal.timeout(10000));
            claudeReady = true;
          } catch {}
        send(res, 200, {
          claudeReady,
          opencodeReady,
          codexWorkerPhase,
          scenarios: scenarioDefaults,
          agent,
          liveAvailable:
            agent === "claude-code"
              ? claudeReady
              : agent === "codex"
                ? codexReady || codexWorkerPhase === "Stopped"
                : agent === "opencode"
                  ? opencodeReady
                  : runtimeTarget() === "openshell"
                    ? !!process.env.OPENSHELL_GATEWAY
                    : !!process.env.OPENROUTER_API_KEY,
          executor: runtimeTarget(),
          localKeyConfigured: !!process.env.OPENROUTER_API_KEY,
          codexReady,
          sandboxMode:
            runtimeTarget() === "openshell"
              ? "configured-unverified"
              : "host-process",
          a2a: "internal-v1",
        });
        return;
      }
      if (path === "/api/goals" && req.method === "GET") {
        send(res, 200, await engine.repo.list());
        return;
      }
      if (path === "/api/goals" && req.method === "POST") {
        const input = await body(req);
        if (input.mode === "live" && input.confirmLive !== true)
          throw new Error("実調査モードを明示的に選択してください");
        send(res, 201, await engine.create(input));
        return;
      }
      const match = path.match(
        /^\/api\/goals\/([a-zA-Z0-9-]+)(?:\/(decision|revise|cancel))?$/,
      );
      if (match) {
        const id = match[1]!,
          action = match[2];
        if (!action && req.method === "GET") {
          send(res, 200, await engine.repo.get(id));
          return;
        }
        if (req.method === "POST") {
          const input = await body(req);
          if (action === "decision") {
            send(res, 200, await engine.decide(id, input));
            return;
          }
          if (action === "revise") {
            send(res, 200, await engine.revise(id, input.text));
            return;
          }
          if (action === "cancel") {
            send(res, 200, await engine.cancel(id));
            return;
          }
        }
      }
      if (path === "/api/tasks" && req.method === "GET") {
        send(res, 200, await taskStore.list());
        return;
      }
      const taskMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
      if (taskMatch && req.method === "GET") {
        send(res, 200, await taskStore.get(taskMatch[1]!));
        return;
      }
      if (path === "/api/sandbox" && req.method === "GET") {
        send(res, 200, await doctorOpenShell(process.env.OPENSHELL_GATEWAY));
        return;
      }
      const staticFiles: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/chat": ["chat.html", "text/html"],
        "/presentation.js": ["presentation.js", "text/javascript"],
        "/chat.js": ["chat.js", "text/javascript"],
        "/chat.css": ["chat.css", "text/css"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      const file = staticFiles[path];
      if (req.method === "GET" && file) {
        const contents = await readFile(webRoot + file[0]);
        res.writeHead(200, {
          "Content-Type": `${file[1]}; charset=utf-8`,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(contents);
        return;
      }
      send(res, 404, { error: "見つかりません" });
    } catch (e: any) {
      const raw = e instanceof Error ? e.message : String(e);
      const key = process.env.OPENROUTER_API_KEY;
      const message = key ? raw.split(key).join("[REDACTED]") : raw;
      send(
        res,
        e?.code === "ENOENT"
          ? 404
          : /古い|確定済み|現在は/.test(message)
            ? 409
            : 400,
        { error: message },
      );
    }
  });
  server.once("close", () => {
    engine.shutdown();
    void runs.shutdown();
  });
  server.on("shutdown", () => {
    for (const response of streams) response.end();
    engine.shutdown();
    void runs.shutdown();
  });
  return server;
}
export async function startWorkbench(port = 4310) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("portは1024〜65535で指定してください");
  const server = createWorkbenchServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(
    `Harness Chat: http://127.0.0.1:${port}/chat\nRelay Workbench: http://127.0.0.1:${port}\n体験モードは外部APIを使用しません。Ctrl+Cで終了します。`,
  );
  const stop = () => {
    server.emit("shutdown");
    server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("close", () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
  return server;
}
