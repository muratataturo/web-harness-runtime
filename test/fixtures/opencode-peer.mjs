#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
if (process.argv.includes("--version")) {
  console.log("1.19.5");
  process.exit(0);
}
const mode = basename(process.argv[1]).includes("invalid")
  ? "invalid"
  : basename(process.argv[1]).includes("repeat")
    ? "repeat"
    : "duplicate";
const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
if (
  config.permission["*"] !== "deny" ||
  config.tools["*"] !== false ||
  config.enabled_providers.join() !== "strata-colab" ||
  process.env.OPENAI_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  !process.argv.includes("--pure")
)
  process.exit(4);
const mcp = config.mcp.research;
const call = async (method, id, params, auth = true) =>
  fetch(mcp.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth ? mcp.headers.Authorization : "Bearer wrong",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
if ((await call("initialize", 1, {}, false)).status !== 403) process.exit(5);
await call("initialize", 1, {});
const tools = await (await call("tools/list", 2, {})).json();
if (tools.result.tools.map((t) => t.name).join() !== "lookup") process.exit(6);
console.log(
  JSON.stringify({
    type: "step_start",
    sessionID: "test",
    part: { id: "start" },
  }),
);
const params = {
  name: "lookup",
  arguments: mode === "invalid" ? { wrong: 1 } : { value: "ok" },
};
const response = await (await call("tools/call", 3, params)).json();
if (mode === "invalid" && !response.result.isError) process.exit(7);
if (mode === "duplicate") {
  await call("tools/call", 3, params);
  if (
    (
      await call("tools/call", 3, {
        ...params,
        arguments: { value: "different" },
      })
    ).status !== 400
  )
    process.exit(8);
}
const event = {
  type: "step_finish",
  sessionID: "test",
  part: {
    id: "finish",
    tokens: {
      input: 100,
      output: 20,
      reasoning: 0,
      cache: { read: 50, write: 0 },
      total: 170,
    },
  },
};
console.log(JSON.stringify(event));
console.log(JSON.stringify(event));
// OpenCode emits one more model step for final prose after an accepted tool.
console.log(
  JSON.stringify({
    type: "step_start",
    sessionID: "test",
    part: { id: "final" },
  }),
);

// A provider may keep its process alive after the authoritative finish tool.
if (mode === "repeat") setInterval(() => {}, 100);
