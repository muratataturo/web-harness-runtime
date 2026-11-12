/** Workspace-local OpenShell MicroVM bootstrap. Never imports subscription auth. */
import { mkdir, readFile, writeFile, chmod, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "dotenv";
const version = "v0.1.7";
const root = resolve(".runtime/openshell-local"),
  install = resolve(".runtime/openshell-install"),
  bin = join(install, "bin");
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  OPENSHELL_LOCAL_TLS_DIR: join(root, "tls"),
};
const run = (name, args, extra = {}) =>
  new Promise((ok, no) => {
    const p = spawn(name, args, {
      env: { ...env, ...extra },
      shell: false,
      stdio: "inherit",
    });
    const interrupt = () => p.kill("SIGINT"),
      terminate = () => p.kill("SIGTERM");
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    p.once("error", (error) => {
      cleanup();
      no(error);
    });
    p.once("exit", (code) => {
      cleanup();
      code === 0
        ? ok()
        : no(
            Object.assign(new Error(`${name} exited ${code}`), {
              exitCode: code ?? 1,
            }),
          );
    });
  });
const cli = (...args) => run(join(bin, "openshell"), args);
async function download(name) {
  const response = await fetch(
    `https://github.com/NVIDIA/OpenShell/releases/download/${version}/${name}`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok)
    throw new Error(`download ${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  const action = process.argv[2] ?? "start";
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "このbootstrapはApple Silicon macOS用です。Linux/remoteは既存gatewayを指定してください。",
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (action === "setup") {
    await mkdir(bin, { recursive: true, mode: 0o700 });
    const checks = new Map();
    for (const file of [
      "openshell-checksums-sha256.txt",
      "openshell-gateway-checksums-sha256.txt",
      "openshell-prover-checksums-sha256.txt",
    ]) {
      for (const line of (await download(file)).toString().trim().split("\n")) {
        const [hash, name] = line.trim().split(/\s+/);
        checks.set(name?.replace(/^\*/, ""), hash);
      }
    }
    for (const name of [
      "openshell",
      "openshell-gateway",
      "openshell-driver-vm",
      "openshell-prover",
    ]) {
      const file = `${name}-aarch64-apple-darwin.tar.gz`,
        dest = join(install, file);
      let bytes;
      try {
        bytes = await readFile(dest);
      } catch {
        bytes = await download(file);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== checks.get(file))
        throw new Error(`SHA256 mismatch: ${file}`);
      await writeFile(dest, bytes, { mode: 0o600 });
      await run("tar", ["-xzf", dest, "-C", bin]);
      console.log(`SHA256 verified: ${file}`);
    }
    const entitlements = join(root, "entitlements.plist");
    await writeFile(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>',
    );
    await run("codesign", [
      "--entitlements",
      entitlements,
      "--force",
      "-s",
      "-",
      join(bin, "openshell-driver-vm"),
    ]);
    const state = join("/private/tmp", `whr-vm-${process.getuid()}`);
    await mkdir(state, { mode: 0o700, recursive: true });
    const stat = await lstat(state);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid()
    )
      throw new Error("VM state directory ownership mismatch");
    await chmod(state, 0o700);
    const configuration = `[openshell]\nversion = 2\n[openshell.gateway]\ncompute_driver = "vm"\nguest_tls_ca = ${JSON.stringify(join(root, "tls/ca.crt"))}\n[openshell.drivers.vm]\ndriver_dir = ${JSON.stringify(bin)}\nstate_dir = ${JSON.stringify(state)}\ndefault_image = "web-harness-runtime:local"\nbootstrap_image = "web-harness-runtime:local"\nvcpus = 2\nmem_mib = 4096\noverlay_disk_mib = 8192\n`;
    try {
      await readFile(join(root, "gateway.toml"));
    } catch {
      await writeFile(join(root, "gateway.toml"), configuration, {
        mode: 0o600,
      });
    }
    try {
      await lstat(join(root, "tls/ca.crt"));
    } catch {
      await run(join(bin, "openshell-gateway"), [
        "generate-certs",
        "--output-dir",
        join(root, "tls"),
        "--server-san",
        "host.openshell.internal",
      ]);
    }
    await run(join(bin, "openshell-gateway"), [
      "config",
      "preflight",
      "--path",
      join(root, "gateway.toml"),
    ]);
    console.log(
      "設定完了。イメージをビルドして start を実行してください。e2fsprogsが必要です。",
    );
  } else if (action === "start") {
    await run(join(bin, "openshell-gateway"), [
      "--config",
      join(root, "gateway.toml"),
      "--name",
      "web-harness-local",
      "--port",
      "17670",
    ]);
  } else if (action === "register") {
    await cli(
      "gateway",
      "add",
      "https://localhost:17670",
      "--local",
      "--name",
      "web-harness-local",
    );
  } else if (action === "init-provider") {
    config({ quiet: true });
    if (!process.env.OPENROUTER_API_KEY)
      throw new Error(".envにOPENROUTER_API_KEYが必要です");
    await cli(
      "-g",
      "web-harness-local",
      "profile",
      "import",
      "-f",
      "infra/openshell/provider-openrouter.yaml",
    );
    await run(
      join(bin, "openshell"),
      [
        "-g",
        "web-harness-local",
        "provider",
        "create",
        "--name",
        "wh-pi-router",
        "--type",
        "wh-pi-openrouter",
        "--from-existing",
      ],
      { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    );
  } else if (action === "codex-setup" || action === "codex-login") {
    await run(
      process.execPath,
      [
        "dist/cli.js",
        "sandbox",
        "codex",
        action === "codex-setup" ? "setup" : "login",
        "--gateway",
        "web-harness-local",
        ...process.argv.slice(3),
      ],
      { OPENSHELL_BIN: join(bin, "openshell") },
    );
  } else if (action === "run-codex") {
    await run(process.execPath, ["dist/cli.js", ...process.argv.slice(3)], {
      RUNTIME_EXECUTOR: "openshell",
      RUNTIME_AGENT: "codex",
      OPENSHELL_GATEWAY: "web-harness-local",
      OPENSHELL_CODEX_SANDBOX:
        process.env.OPENSHELL_CODEX_SANDBOX ?? "wh-codex",
      OPENSHELL_BIN: join(bin, "openshell"),
    });
  } else if (action === "cli") {
    await cli(...process.argv.slice(3));
  } else if (action === "run") {
    await run(process.execPath, ["dist/cli.js", ...process.argv.slice(3)], {
      RUNTIME_EXECUTOR: "openshell",
      RUNTIME_AGENT: "pi-openrouter",
      OPENSHELL_GATEWAY: "web-harness-local",
      OPENSHELL_PROVIDER: "wh-pi-router",
      OPENSHELL_BIN: join(bin, "openshell"),
    });
  } else
    throw new Error(
      "setup / start / register / init-provider / codex-setup / codex-login / run-codex / cli / run から指定してください",
    );
} catch (error) {
  if (!Number.isInteger(error.exitCode)) console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
