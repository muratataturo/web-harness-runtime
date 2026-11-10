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
) {
  return createServer(async (req, res) => {
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
        if (agent === "claude-code" && runtimeTarget() === "local")
          try {
            await claudeAuthentication(undefined, AbortSignal.timeout(10000));
            claudeReady = true;
          } catch {}
        send(res, 200, {
          claudeReady,
          scenarios: scenarioDefaults,
          agent,
          liveAvailable:
            agent === "claude-code"
              ? claudeReady
              : agent === "codex"
                ? codexReady
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
        send(res, 200, await new Store().list());
        return;
      }
      const taskMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
      if (taskMatch && req.method === "GET") {
        send(res, 200, await new Store().get(taskMatch[1]!));
        return;
      }
      if (path === "/api/sandbox" && req.method === "GET") {
        send(res, 200, await doctorOpenShell(process.env.OPENSHELL_GATEWAY));
        return;
      }
      const staticFiles: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
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
    `Relay Workbench: http://127.0.0.1:${port}\n体験モードは外部APIを使用しません。Ctrl+Cで終了します。`,
  );
  return server;
}
