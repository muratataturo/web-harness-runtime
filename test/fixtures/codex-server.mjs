#!/usr/bin/env node
// Deterministic App Server peer: no credentials, network, model or Codex installation.
import { createInterface } from "node:readline";
const mode =
  process.argv[2] === "app-server" ? "quota" : (process.argv[2] ?? "success");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let answered = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (!m.method) {
    if (mode === "forbidden") {
      if (!m.error) process.exit(4);
      send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { status: "completed" } },
      });
      return;
    }
    if (++answered === (mode === "duplicate" ? 2 : 1))
      send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { status: "completed" } },
      });
    return;
  }
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "account/read")
    send({
      id: m.id,
      result: {
        account: {
          type: mode === "api-key" ? "apiKey" : "chatgpt",
          planType: "test",
        },
      },
    });
  if (m.method === "model/list")
    send({
      id: m.id,
      result: {
        data: [{ model: "test-model", displayName: "Test", isDefault: true }],
        nextCursor: null,
      },
    });
  if (m.method === "thread/start") {
    if (
      m.params.sandbox !== "read-only" ||
      m.params.approvalPolicy !== "never" ||
      !m.params.ephemeral ||
      !m.params.dynamicTools.length
    )
      process.exit(3);
    send({
      id: m.id,
      result: { model: "test-model", thread: { id: "thread-1" } },
    });
  }
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-1" } } });
    if (mode === "hang") return;
    if (mode === "exit") {
      process.exit(2);
      return;
    }
    if (mode === "quota") {
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            status: "failed",
            error: { message: "usage_limit_reached: subscription limit" },
          },
        },
      });
      return;
    }
    if (mode === "forbidden") {
      send({
        id: "approval",
        method: "item/commandExecution/requestApproval",
        params: {},
      });
      return;
    }
    if (mode === "usage") {
      const notify = (
        threadId,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
      ) =>
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId: "turn-1",
            tokenUsage: {
              last: {},
              total: {
                inputTokens,
                outputTokens,
                cachedInputTokens,
                reasoningOutputTokens,
                totalTokens: inputTokens + outputTokens,
              },
            },
          },
        });
      notify("thread-1", 100, 20, 80, 5);
      notify("thread-1", 150, 30, 100, 8);
      notify("thread-1", 150, 30, 100, 8);
      notify("other-thread", 999, 999, 900, 800);
    }
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "lookup",
      arguments:
        mode === "invalid" ? { url: 123 } : { url: "https://example.com/" },
    };
    if (mode === "wrong-thread") params.threadId = "other";
    if (mode === "unknown") params.tool = "exec_command";
    send({ id: "tool-1", method: "item/tool/call", params });
    if (mode === "duplicate")
      send({ id: "tool-2", method: "item/tool/call", params });
  }
});
