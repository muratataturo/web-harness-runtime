/** Start the existing OpenCode client with the generated MCP+Strata profile. No GPU allocation. */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { config } from "dotenv";
import { opencodeBinary, strataConnection } from "../dist/opencode.js";
config({ quiet: true });
const args = process.argv.slice(2);
const discovery = args[0] === "mcp";
if (!discovery) await strataConnection();
const key =
  process.env.STRATA_API_KEY ??
  (
    await readFile(
      process.env.STRATA_KEY_FILE ?? "/private/tmp/strata-colab-api-key",
      "utf8",
    )
  ).trim();
const child = spawn(opencodeBinary(), args, {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    STRATA_API_KEY: key,
    OPENCODE_CONFIG: resolve(".runtime/clients/opencode-strata.json"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  },
});
child.on("error", () => {
  console.error(
    "OpenCodeの起動に失敗しました。既存CLIのパスを確認してください。",
  );
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
