#!/usr/bin/env node
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
const mode = basename(process.argv[1]).replace("claude-", "");
if (process.argv[2] === "auth") {
  console.log(
    JSON.stringify({
      loggedIn: mode !== "noauth",
      authMethod: mode === "apikey" ? "apiKey" : "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "test",
      email: "must-not-log@example.com",
    }),
  );
  process.exit(0);
}
if (process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY)
  process.exit(7);
const args = process.argv.slice(2),
  model = args[args.indexOf("--model") + 1];
if (
  !args.includes("--restricted") ||
  args[args.indexOf("--tools") + 1] !== "" ||
  !args.includes("--strict-mcp-config")
)
  process.exit(8);
const emit = (m) => console.log(JSON.stringify(m));
emit({
  type: "system",
  subtype: "init",
  model: mode === "wrongmodel" ? "other-model" : model,
  tools: ["mcp__research__lookup"],
  mcp_servers: [{ name: "research", status: "connected" }],
});
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "quota") {
  emit({
    type: "result",
    subtype: "error",
    is_error: true,
    errors: ["usage_limit_reached"],
  });
} else {
  const config = JSON.parse(
      await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"),
    ),
    c = config.mcpServers.research;
  const call = async (body, headers = c.headers) => {
    const r = await fetch(c.url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  if ((await call({ id: 0, method: "tools/list" }, {})).status !== 403)
    process.exit(9);
  await call({ id: 1, method: "initialize", params: {} });
  const request = {
    id: 3,
    method: "tools/call",
    params: {
      name: mode === "unknown" ? "Bash" : "lookup",
      arguments:
        mode === "invalid" ? { url: 123 } : { url: "https://example.com/" },
    },
  };
  const r = await call(request);
  if (mode === "duplicate") await call(request);
  if (mode === "invalid" || mode === "unknown") {
    if (!r.body.result.isError) process.exit(10);
  } else if (!r.body.result.content) process.exit(11);
  emit({ type: "result", subtype: "success", is_error: false });
}
