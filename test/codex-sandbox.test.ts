import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import {
  codexSandboxConfig,
  codexSandboxPolicy,
  runCodexSandbox,
} from "../src/codex-sandbox.js";
import {
  buildRuntimeSnapshot,
  snapshotAssets,
  snapshotInstallScript,
} from "../src/runtime-snapshot.js";
import { Store } from "../src/store.js";

test("Codex worker policy is native-binary scoped and has no OpenRouter credentials or private mounts", () => {
  const policy = codexSandboxPolicy([
    "https://books.rakuten.co.jp/rb/18577690/",
  ]);
  assert.match(policy, /codex-native/);
  assert.match(policy, /auth.openai.com/);
  assert.match(policy, /hard_requirement/);
  const native =
    "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex";
  assert.ok(codexSandboxPolicy([], native).includes(`path: ${native}`));
  assert.throws(() => codexSandboxPolicy([], "/usr/local/bin/node"));
  assert.doesNotMatch(
    policy,
    /OPENROUTER_API_KEY|Authorization|allowed_ips|privileged/,
  );
  assert.throws(() => codexSandboxConfig({ gateway: "--bad" }));
  assert.throws(() => codexSandboxConfig({ gateway: "safe", name: "../auth" }));
});

test("Runtime snapshots include only compiled code/public assets, exclude secrets, and produce valid installer JS", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-snapshot-"));
  try {
    for (const dir of ["dist", "web", "config", "examples", "docs"])
      await mkdir(join(root, dir));
    for (const file of ["dist/cli.js", "dist/codex.js", ...snapshotAssets]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "public");
    }
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, ".env"), "private-secret");
    await writeFile(join(root, "dist/auth.json"), "private-secret");
    const snapshot = await buildRuntimeSnapshot(join(root, "out"), root);
    const manifest = JSON.parse(
      await readFile(join(root, "out/snapshot/manifest.json"), "utf8"),
    );
    assert.ok(
      Object.keys(manifest.hashes).every(
        (f) => !f.includes("auth.json") && !f.includes(".env"),
      ),
    );
    const script = snapshotInstallScript(
      snapshot.revision,
      "/sandbox/bundles/test.tar.gz",
    );
    assert.doesNotThrow(() => new Script(script));
    assert.match(script, /runtime dependency\/revision mismatch/);
    assert.throws(() =>
      snapshotInstallScript("bad", "/sandbox/bundles/test.tar.gz"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Missing VM login stops before research; no host authentication or provider fallback, and worker is stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-noauth-"));
  const old = {
    bin: process.env.OPENSHELL_BIN,
    xdg: process.env.XDG_CONFIG_HOME,
    runtime: process.env.RUNTIME_DIR,
  };
  const file = join(root, "openshell.mjs");
  await writeFile(
    file,
    `#!/usr/bin/env node
import fs from 'node:fs';const a=process.argv.slice(2),root=process.env.XDG_CONFIG_HOME;fs.appendFileSync(root+'/commands.jsonl',JSON.stringify(a)+'\\n');
if(a.includes('get'))console.log(JSON.stringify({id:'test-vm-id',name:'wh-codex',phase:'Ready',labels:{'web-harness-role':'codex-worker'}}));
else if(a.includes('--check')){console.log(JSON.stringify({authenticated:false,authentication:'chatgpt-required',models:[]}));process.exitCode=1;}
else if(a.includes('stop'))console.log('stopped');else process.exitCode=5;
`,
  );
  await chmod(file, 0o755);
  process.env.OPENSHELL_BIN = file;
  process.env.XDG_CONFIG_HOME = root;
  process.env.RUNTIME_DIR = root;
  try {
    await assert.rejects(
      runCodexSandbox(
        {
          query: "book",
          urls: ["https://books.rakuten.co.jp/rb/18577690/"],
          agent: "codex",
          maxPages: 2,
          maxSteps: 10,
          timeoutSeconds: 10,
        },
        new Store(root),
        { gateway: "test" },
      ),
      /ChatGPTログイン/,
    );
    const calls = (await readFile(join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(calls.some((a: string[]) => a.includes("stop")));
    assert.ok(
      !calls.some(
        (a: string[]) =>
          a.includes("upload") || a.includes("--model") || a.includes("run"),
      ),
    );
    const leases = await readdir(join(root, "codex-workers/test-wh-codex"));
    assert.ok(!leases.includes("lease"));
  } finally {
    for (const [key, value] of [
      ["OPENSHELL_BIN", old.bin],
      ["XDG_CONFIG_HOME", old.xdg],
      ["RUNTIME_DIR", old.runtime],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
