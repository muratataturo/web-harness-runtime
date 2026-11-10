import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strataModel } from "./opencode.js";
export async function writeClientConfigs(
  directory = ".runtime/clients",
  endpoint = "http://127.0.0.1:4310",
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("loopback originを指定してください");
  const root = fileURLToPath(new URL("../", import.meta.url)),
    node = process.execPath,
    args = [join(root, "dist/cli.js"), "mcp", "--url", url.origin];
  const entry = { command: node, args, cwd: root };
  const out = resolve(directory);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const configs: Record<string, unknown> = {
    "claude.mcp.json": { mcpServers: { harness: entry } },
    "pi.mcp.json": {
      mcpServers: { harness: { ...entry, exposure: "direct" } },
    },
    "opencode.json": {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        harness: { type: "local", command: [node, ...args], enabled: true },
      },
    },
  };
  configs["opencode-strata.json"] = {
    ...(configs["opencode.json"] as any),
    model: strataModel,
    small_model: strataModel,
    enabled_providers: ["strata-colab"],
    share: "disabled",
    provider: {
      "strata-colab": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: process.env.STRATA_BASE_URL ?? "http://127.0.0.1:18081/v1",
          apiKey: "{env:STRATA_API_KEY}",
        },
        models: {
          [strataModel.split("/")[1]!]: {
            name: strataModel.split("/")[1],
            tool_call: true,
            reasoning: false,
            options: {
              reasoningEffort: "none",
              chatTemplateKwargs: { enable_thinking: false },
            },
            limit: { context: 65536, output: 8192 },
          },
        },
      },
    },
  };
  for (const [name, value] of Object.entries(configs))
    await writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
  const toml = `[mcp_servers.harness]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\ncwd = ${JSON.stringify(root)}\nstartup_timeout_sec = 20\n`;
  await writeFile(join(out, "codex.toml"), toml, { mode: 0o600 });
  return {
    directory: out,
    daemon: url.origin,
    files: [...Object.keys(configs), "codex.toml"],
    codexOverrides: [
      "-c",
      `mcp_servers.harness.command=${JSON.stringify(node)}`,
      "-c",
      `mcp_servers.harness.args=${JSON.stringify(args)}`,
      "-c",
      `mcp_servers.harness.cwd=${JSON.stringify(root)}`,
    ],
    note: "生成のみ。既存アカウント設定、会話、provider認証を変更しません。MCP daemonを先に起動してください。",
  };
}
