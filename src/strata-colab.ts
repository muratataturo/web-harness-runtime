import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  open,
  chmod,
  lstat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { strataStateRoot, strataSettings } from "./strata-settings.js";
const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const remoteRoot = "/content/web-harness-strata";
export interface ColabConfig {
  colabCliVersion: string;
  strataRelease: string;
  installerSha256: string;
  modelId: string;
  context: number;
  gpu: string;
  vision: string;
  localPort: number;
  remotePort: number;
  session: string;
  idleMinutes: number;
  [key: string]: unknown;
}
export interface ColabState {
  session: string;
  endpoint: string;
  owned: boolean;
  cli: string;
  python: string;
  sshKeyFile: string;
  controlPath: string;
  alias: string;
  localPort: number;
  remotePort: number;
  phase: string;
  createdAt: string;
  monitorEnabled?: boolean;
  tunnelPid?: number;
  monitorPid?: number;
  [key: string]: unknown;
}
const strip = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
export function parseColabStatus(
  text: string,
  session: string,
): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(session))
    throw Error("不正なColab session名");
  const out = strip(text);
  const match = out.match(new RegExp("^\\[" + session + "\\] (\\S+) \\|", "m"));
  if (match) return match[1];
  if (out.includes(`Session '${session}' not found.`)) return;
  throw Error(
    "Colabの状態を確定できません。認証・接続を確認してください。自動割当しません。",
  );
}
export class IdleObservation {
  private marker = "";
  private last = 0;
  private poll = 0;
  reset() {
    this.marker = "";
    this.last = 0;
    this.poll = 0;
  }
  observe(
    sample: { busy: boolean; marker: string },
    now: number,
    seconds: number,
  ) {
    if (
      !this.poll ||
      now - this.poll > 45 ||
      now < this.poll ||
      sample.busy ||
      sample.marker !== this.marker
    )
      this.last = now;
    this.poll = now;
    this.marker = sample.marker;
    return {
      ready: !sample.busy && now - this.last >= seconds,
      idleSeconds: Math.max(0, now - this.last),
      marker: this.marker,
    };
  }
}
export function metricSample(data: any) {
  const live = data?.live,
    total = data?.totals;
  if (
    !Number.isSafeInteger(live?.queued) ||
    live.queued < 0 ||
    !Number.isSafeInteger(total?.requests) ||
    total.requests < 0 ||
    !total.since ||
    typeof live?.state !== "string"
  )
    throw Error("Strata metricsの形式を確認できません");
  return {
    busy: live.state !== "idle" || live.queued !== 0,
    marker: JSON.stringify([total.since, total.requests]),
  };
}
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export class StrataColab {
  readonly root: string;
  constructor(
    root = strataStateRoot(),
    private progress: (text: string) => void = () => {},
  ) {
    this.root = resolve(root);
  }
  async config(options: Partial<ColabConfig> = {}): Promise<ColabConfig> {
    const preset = JSON.parse(
      await readFile(join(project, "config/strata-colab.json"), "utf8"),
    );
    const c = {
      ...preset,
      session: process.env.STRATA_COLAB_SESSION ?? preset.session,
      localPort: Number(process.env.STRATA_LOCAL_PORT ?? preset.localPort),
      remotePort: Number(process.env.STRATA_REMOTE_PORT ?? preset.remotePort),
      ...options,
    };
    if (
      !/^[a-z][a-z0-9-]{0,40}$/.test(c.session) ||
      !["L4"].includes(c.gpu) ||
      !["gpu", "cpu", "off"].includes(c.vision) ||
      ![c.localPort, c.remotePort].every(
        (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
      ) ||
      !Number.isInteger(c.idleMinutes) ||
      c.idleMinutes < 1 ||
      c.idleMinutes > 1440
    )
      throw Error("Strata Colab設定が不正です");
    return c;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }
  private async json(name: string, value: unknown) {
    await this.init();
    const path = join(this.root, name),
      temp = path + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temp, path);
  }
  async state(): Promise<ColabState | undefined> {
    return readFile(join(this.root, "state.json"), "utf8")
      .then(JSON.parse)
      .catch((e) => {
        if (e.code === "ENOENT") return;
        throw e;
      });
  }
  private async locked<T>(fn: () => Promise<T>) {
    await this.init();
    const path = join(this.root, "control.lock");
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const old = JSON.parse(await readFile(path, "utf8"));
      let alive = true;
      try {
        process.kill(old.pid, 0);
      } catch (x: any) {
        alive = x.code !== "ESRCH";
      }
      if (alive) throw Error("別のStrata管理操作が実行中です");
      await rm(path);
      file = await open(path, "wx", 0o600);
    }
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    try {
      return await fn();
    } finally {
      await file.close();
      await rm(path, { force: true });
    }
  }
  private async command(
    bin: string,
    args: string[],
    label: string,
    timeout = 60000,
  ) {
    await this.init();
    const output = join(this.root, "operations.log");
    try {
      const r = await exec(bin, args, {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
        windowsHide: true,
      });
      if (label.startsWith("remote-")) {
        const log = await open(output, "a", 0o600);
        await log.write(
          `${new Date().toISOString()} ${label}\n${r.stdout}\n${r.stderr}\n`,
        );
        await log.close();
      }
      return { stdout: r.stdout, stderr: r.stderr };
    } catch (e: any) {
      const log = await open(output, "a", 0o600);
      await log.write(
        `${new Date().toISOString()} ${label}\n${e.stdout ?? ""}\n${e.stderr ?? ""}\n`,
      );
      await log.close();
      throw Error(
        `Strata ${label}に失敗しました。秘密を含み得るローカルoperations.logを確認してください。`,
      );
    }
  }
  async cli() {
    if (!["darwin", "linux"].includes(process.platform))
      throw Error("Colab起動管理はmacOS / Linux対応です");
    let cli = process.env.COLAB_BIN;
    if (!cli) {
      const local = join(this.root, "colab-cli/bin/colab"),
        saved = (await this.state())?.cli;
      cli = existsSync(local)
        ? local
        : saved && existsSync(saved)
          ? saved
          : "colab";
    }
    if (!cli.startsWith("/")) {
      try {
        cli = (await exec("which", [cli])).stdout.trim();
      } catch {
        throw Error(
          "Colab CLIがありません。strata installまたはCOLAB_BINを設定してください。",
        );
      }
    }
    if (!existsSync(cli))
      throw Error(
        "指定したColab CLIがありません。COLAB_BINを確認してください。",
      );
    const first = (await readFile(cli, "utf8")).split("\n")[0]!;
    const python = process.env.COLAB_PYTHON ?? first.match(/^#!(\/\S+)$/)?.[1];
    if (!python || !existsSync(python) || !/python[0-9.]*$/.test(python))
      throw Error(
        "Colab CLIのPython環境を確認できません。COLAB_PYTHONを設定してください。",
      );
    const version = await this.command(cli, ["version"], "cli-version");
    const expected = (await this.config()).colabCliVersion;
    if (
      !new RegExp("\\b" + expected.replaceAll(".", "\\.") + "\\b").test(
        strip(version.stdout + version.stderr),
      )
    )
      throw Error(
        `Colab CLI ${expected}で検証する設定です。異なる版へ自動切替しません。`,
      );
    return { cli, python };
  }
  async install() {
    return this.locked(async () => {
      const python = process.env.STRATA_PYTHON ?? "python3";
      const version = await exec(python, [
        "-c",
        "import sys; print(sys.version_info >= (3,12))",
      ]);
      if (version.stdout.trim() !== "True")
        throw Error("Python 3.12以降が必要です");
      this.progress("専用venvにColab CLIを導入");
      await this.command(
        python,
        ["-m", "venv", join(this.root, "colab-cli")],
        "venv",
      );
      await this.command(
        join(this.root, "colab-cli/bin/python"),
        ["-m", "pip", "install", "google-colab-cli==0.7.5"],
        "install-cli",
        300000,
      );
      return {
        installed: true,
        version: "0.7.5",
        authentication: "strata loginで本人認証",
      };
    });
  }
  async login() {
    const { cli } = await this.cli();
    return new Promise<void>((ok, no) => {
      const child = spawn(cli, ["sessions"], { stdio: "inherit" });
      child.once("error", no);
      child.once("exit", (c) =>
        c === 0 ? ok() : no(Error("Colab本人認証を完了してください")),
      );
    });
  }
  private async endpoint(cli: string, session: string) {
    const r = await this.command(
      cli,
      ["status", "-s", session],
      "session-status",
    );
    return parseColabStatus(r.stdout + "\n" + r.stderr, session);
  }
  async plan(options: Partial<ColabConfig> = {}) {
    const c = await this.config(options);
    return {
      ...c,
      root: "RUNTIME_DIR/strata-colab",
      allocatesGpu: false,
      modelFallback: false,
      localBind: "127.0.0.1",
      credentials:
        "Google本人認証はColab CLIが管理。APIキーはゲスト生成・0600で保存",
      runtime: "OpenCode調査はlocal、推論はColab。OpenShell隔離とは別",
    };
  }
  async status() {
    const state = await this.state();
    if (!state) {
      if (existsSync(join(this.root, "connection.json"))) {
        try {
          const d = await this.discover();
          return {
            configured: true,
            owned: false,
            apiReady: true,
            baseUrl: d.baseUrl,
            model: d.model,
            context: d.context,
          };
        } catch {
          return { configured: true, owned: false, apiReady: false };
        }
      }
      return { configured: false, allocatesGpu: false };
    }
    let found = false;
    try {
      found =
        (await this.endpoint(state.cli, state.session)) === state.endpoint;
    } catch {}
    const observation = await readFile(join(this.root, "monitor.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    let apiReady = false;
    try {
      await this.discover();
      apiReady = true;
    } catch {}
    return {
      configured: true,
      phase: state.phase,
      session: state.session,
      owned: state.owned,
      sessionMatches: found,
      apiReady,
      baseUrl: `http://127.0.0.1:${state.localPort}/v1`,
      monitor: observation
        ? {
            state: observation.state,
            idleSeconds: observation.idleSeconds,
            heartbeatAgeSeconds: Math.round(
              (Date.now() - observation.heartbeat) / 1000,
            ),
          }
        : null,
    };
  }
  private async freePort(port: number) {
    await new Promise<void>((ok, no) => {
      const s = createServer();
      s.once("error", () =>
        no(
          Error(
            `ポート${port}は使用中です。既存の接続を停止せずstrata connectで明示的に利用してください。`,
          ),
        ),
      );
      s.listen(port, "127.0.0.1", () => s.close(() => ok()));
    });
  }
  private async pinned(state: ColabState) {
    if ((await this.endpoint(state.cli, state.session)) !== state.endpoint)
      throw Error(
        "Colab sessionが消失・置換されています。別VMを作成・停止しません。",
      );
  }
  async up(options: Partial<ColabConfig> = {}) {
    return this.locked(async () => {
      if (
        process.env.STRATA_BASE_URL ||
        process.env.STRATA_KEY_FILE ||
        process.env.STRATA_API_KEY
      )
        throw Error(
          "up前に外部接続用STRATA環境変数を外してください。既存endpointはconnectで利用します",
        );
      const c = await this.config(options);
      const { cli, python } = await this.cli();
      const previous = await this.state();
      if (
        previous?.owned &&
        previous.phase !== "stopped" &&
        previous.session !== c.session
      )
        throw Error(
          "別名の所有Colabが残っています。strata stopで解放してからsessionを変更してください",
        );
      if (
        previous?.phase === "ready" &&
        (previous.localPort !== c.localPort ||
          previous.remotePort !== c.remotePort)
      )
        throw Error(
          "稼働中の転送ポートは変更しません。strata stop後に設定してください",
        );
      if (options.vision && previous?.phase === "ready") {
        const report = await readFile(
          join(this.root, "remote-report.json"),
          "utf8",
        )
          .then(JSON.parse)
          .catch(() => undefined);
        if (report?.vision && report.vision !== options.vision)
          throw Error(
            "稼働中のvision設定は変更しません。strata stop後に起動してください",
          );
      }
      let endpoint = await this.endpoint(cli, c.session);
      if (
        endpoint &&
        (!previous?.owned ||
          previous.endpoint !== endpoint ||
          previous.session !== c.session)
      )
        throw Error(
          "所有を確認できない既存Colab sessionです。接続のみ行う場合strata connectを使ってください。",
        );
      if (endpoint && previous) {
        try {
          await this.discover();
          previous.phase = "ready";
          await this.startMonitor(previous, c.idleMinutes);
          return { ...(await this.status()), reused: true };
        } catch {}
        await this.tunnel(previous);
        await this.publish(previous);
        await this.discover();
        previous.phase = "ready";
        await this.startMonitor(previous, c.idleMinutes);
        return { ...(await this.status()), reused: true };
      }
      await this.freePort(c.localPort);
      const control = join(
        tmpdir(),
        "whr-strata-" +
          createHash("sha256")
            .update(this.root + String(process.getuid?.()))
            .digest("hex")
            .slice(0, 14),
      );
      await mkdir(control, { recursive: true, mode: 0o700 });
      const info = await lstat(control);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.()
      )
        throw Error("SSH controlディレクトリの所有を確認できません");
      await chmod(control, 0o700);
      this.progress("Colab L4を割当（計算ユニットを使用）");
      await this.command(
        cli,
        ["new", "-s", c.session, "--gpu", c.gpu],
        "allocate",
        180000,
      );
      endpoint = await this.endpoint(cli, c.session);
      if (!endpoint) throw Error("Colabの割当を確認できません");
      const state: ColabState = {
        session: c.session,
        endpoint,
        owned: true,
        cli,
        python,
        sshKeyFile: join(this.root, "ssh-key"),
        controlPath: join(control, "control"),
        alias:
          "whr-" +
          createHash("sha256").update(endpoint).digest("hex").slice(0, 12),
        localPort: c.localPort,
        remotePort: c.remotePort,
        phase: "allocated",
        createdAt: new Date().toISOString(),
      };
      await this.json("state.json", state);
      try {
        const bootstrap = join(this.root, "bootstrap.json");
        await this.json("bootstrap.json", { ...c, action: "start" });
        this.progress("固定ハッシュのStrataを導入しQwen3.8 IQ2_XS / 64Kを起動");
        await this.pinned(state);
        // exec's fixed prelude only creates the application directory; no host credential forwarding.
        const setup = join(this.root, "mkdir.py");
        await writeFile(
          setup,
          "from pathlib import Path\nPath('/content/web-harness-strata').mkdir(mode=0o700,exist_ok=True)\n",
          { mode: 0o600 },
        );
        // A freshly assigned Colab kernel may not have its WebSocket ready yet.
        // Retry only this idempotent mkdir, never model inference or GPU allocation.
        for (let attempt = 0; attempt < 4; attempt++) {
          await this.pinned(state);
          try {
            await this.command(
              cli,
              ["exec", "-s", state.session, "-f", setup],
              "remote-mkdir",
              90000,
            );
            break;
          } catch (e) {
            if (attempt === 3) throw e;
            this.progress("Colabカーネルの接続準備を待機");
            await delay(5000);
          }
        }
        await this.command(
          cli,
          [
            "upload",
            "-s",
            state.session,
            bootstrap,
            remoteRoot + "/bootstrap.json",
          ],
          "upload-config",
        );
        state.phase = "bootstrapping";
        await this.json("state.json", state);
        const started = await this.command(
          cli,
          [
            "exec",
            "-s",
            state.session,
            "--timeout",
            "3600",
            "-f",
            join(project, "infra/strata/remote.py"),
          ],
          "remote-start",
          3660000,
        );
        const marker = started.stdout
          .split("\n")
          .find((l) => l.includes("@whr-strata-result "));
        const ready = marker
          ? JSON.parse(marker.slice(marker.indexOf("@whr-strata-result ") + 19))
          : undefined;
        if (
          ready?.phase !== "ready" ||
          ready?.model !== c.modelId ||
          ready?.context !== 65536
        )
          throw Error(
            "Colab内のモデル起動を確認できません。公開ログではなくremote launch.logを確認してください。",
          );
        await this.json("remote-report.json", ready);
        this.progress("生成したAPIキーを非公開ファイルへ回収");
        await this.command(
          cli,
          [
            "download",
            "-s",
            state.session,
            remoteRoot + "/api-key",
            join(this.root, "api-key"),
          ],
          "download-key",
        );
        await chmod(join(this.root, "api-key"), 0o600);
        this.progress("所有を固定したSSHトンネルを起動");
        await this.tunnel(state);
        await this.publish(state);
        await this.discover();
        state.phase = "ready";
        await this.json("state.json", state);
        await this.startMonitor(state, c.idleMinutes);
        return { ...(await this.status()), remote: ready, reused: false };
      } catch (error) {
        state.phase = "failed";
        await this.json("state.json", state);
        this.progress("起動失敗のため、この操作で確保したColabを解放");
        try {
          await this.stopOwned(state);
        } catch {
          this.progress(
            "Colab解放を確認できません。strata status / stopで確認してください。",
          );
        }
        throw error;
      }
    });
  }
  private async publish(state: ColabState) {
    await this.json("connection.json", {
      baseUrl: `http://127.0.0.1:${state.localPort}/v1`,
      keyFile: join(this.root, "api-key"),
      model: "strata-colab/qwen3.8-flash-next-iq2_xs",
      context: 65536,
      session: state.session,
    });
  }
  private async tunnel(state: ColabState) {
    await this.pinned(state);
    try {
      await this.command(
        "ssh",
        ["-S", state.controlPath, "-O", "check", "root@" + state.alias],
        "tunnel-check",
        10000,
      );
      return;
    } catch {}
    await this.freePort(state.localPort);
    if (!existsSync(state.sshKeyFile))
      await this.command(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-f", state.sshKeyFile],
        "ssh-keygen",
      );
    const proxy = [
      state.python,
      join(project, "infra/strata/proxy.py"),
      join(this.root, "state.json"),
    ]
      .map(shellQuote)
      .join(" ");
    const args = [
      "-M",
      "-S",
      state.controlPath,
      "-N",
      "-L",
      `127.0.0.1:${state.localPort}:127.0.0.1:${state.remotePort}`,
      "-i",
      state.sshKeyFile,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "UserKnownHostsFile=" + join(this.root, "known-hosts"),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "HostKeyAlias=" + state.alias,
      "-o",
      "ProxyCommand=" + proxy,
      "root@" + state.alias,
    ];
    const log = await open(join(this.root, "tunnel.log"), "a", 0o600);
    const child = spawn("ssh", args, {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise<void>((ok, no) => {
      child.once("spawn", ok);
      child.once("error", no);
    });
    state.tunnelPid = child.pid;
    child.unref();
    await log.close();
    await this.json("state.json", state);
    for (let i = 0; i < 30; i++) {
      try {
        await this.command(
          "ssh",
          ["-S", state.controlPath, "-O", "check", "root@" + state.alias],
          "tunnel-ready",
          3000,
        );
        return;
      } catch {}
      await delay(1000);
    }
    throw Error(
      "SSH転送を確認できません。tunnel.logをローカルで確認してください",
    );
  }
  async discover() {
    const settings = await strataSettings(this.root);
    if (!process.env.STRATA_API_KEY) {
      const info = await lstat(settings.keyFile);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()
      )
        throw Error(
          "Strataキーファイルは本人所有の通常ファイル、権限0600で指定してください",
        );
    }
    const key =
      process.env.STRATA_API_KEY ??
      (await readFile(settings.keyFile, "utf8")).trim();
    const endpoint = new URL(settings.baseUrl);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !["https:", "http:"].includes(endpoint.protocol) ||
      (endpoint.protocol === "http:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
    )
      throw Error("Strata接続はloopback HTTPまたはHTTPSで指定してください");
    const res = await fetch(settings.baseUrl.replace(/\/$/, "") + "/models", {
      headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw Error(`Strata models HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const id = settings.model.replace(/^strata-colab\//, "");
    if (id !== "qwen3.8-flash-next-iq2_xs")
      throw Error("Strata管理接続は指定のQwen3.8 IQ2_XSに固定しています");
    const m = data.data?.find((x: any) => x.id === id);
    if (!m || m.meta?.n_ctx !== 65536)
      throw Error(
        "指定Qwenモデルと64K contextを確認できません。fallbackしません。",
      );
    return {
      key,
      baseUrl: settings.baseUrl.replace(/\/$/, ""),
      model: id,
      context: 65536,
    };
  }
  async connect(baseUrl: string, keyFile: string) {
    return this.locked(async () => {
      const owned = await this.state();
      if (owned?.owned && owned.phase !== "stopped")
        throw Error(
          "所有中のColabがあります。接続先の変更前にstrata stopを実行してください",
        );
      if (
        process.env.STRATA_BASE_URL ||
        process.env.STRATA_KEY_FILE ||
        process.env.STRATA_API_KEY
      )
        throw Error(
          "既存のSTRATA接続環境変数を外してから管理接続を登録してください",
        );
      if (!keyFile.startsWith("/"))
        throw Error("キーファイルは絶対パスで指定してください");
      const prior = await readFile(
        join(this.root, "connection.json"),
        "utf8",
      ).catch(() => undefined);
      await this.json("connection.json", {
        baseUrl,
        keyFile,
        model: "strata-colab/qwen3.8-flash-next-iq2_xs",
      });
      try {
        const d = await this.discover();
        await rm(join(this.root, "state.json"), { force: true });
        return {
          connected: true,
          owned: false,
          baseUrl: d.baseUrl,
          model: d.model,
          context: d.context,
        };
      } catch (e) {
        if (prior)
          await writeFile(join(this.root, "connection.json"), prior, {
            mode: 0o600,
          });
        else await rm(join(this.root, "connection.json"), { force: true });
        throw e;
      }
    });
  }
  private async metrics() {
    const d = await this.discover();
    const response = await fetch(
      d.baseUrl.replace(/\/v1\/?$/, "") + "/metrics",
      {
        headers: { Authorization: "Bearer " + d.key },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw Error("Strata metricsを取得できません");
    return metricSample(await response.json());
  }
  private async stopOwned(s: ColabState, marker?: string) {
    if (!s.owned) throw Error("外部のColabは停止しません");
    await this.pinned(s);
    if (marker) {
      const sample = await this.metrics();
      if (sample.busy || sample.marker !== marker)
        throw Error("利用再開を検出したため停止しません");
    }
    await this.command(s.cli, ["stop", "-s", s.session], "stop-colab", 120000);
    if (await this.endpoint(s.cli, s.session))
      throw Error("Colabの解放を確認できません");
    s.phase = "stopped";
    s.monitorEnabled = false;
    await this.json("state.json", s);
    try {
      await this.command(
        "ssh",
        ["-S", s.controlPath, "-O", "exit", "root@" + s.alias],
        "close-tunnel",
        10000,
      );
    } catch {}
  }
  async stop() {
    return this.locked(async () => {
      const s = await this.state();
      if (!s?.owned)
        throw Error(
          "このruntimeが所有するColabがありません。外部sessionは停止しません。",
        );
      const endpoint = await this.endpoint(s.cli, s.session);
      if (!endpoint) {
        s.monitorEnabled = false;
        s.phase = "stopped";
        await this.json("state.json", s);
        return { stopped: true, alreadyAbsent: true };
      }
      await this.stopOwned(s);
      return { stopped: true, session: s.session };
    });
  }
  private async startMonitor(s: ColabState, minutes: number) {
    await this.metrics();
    s.monitorEnabled = true;
    s.idleMinutes = minutes;
    await this.json("state.json", s);
    const old = await readFile(join(this.root, "monitor.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (old && Date.now() - old.heartbeat < 45000) {
      try {
        process.kill(old.pid, 0);
        return;
      } catch {}
    }
    const log = await open(join(this.root, "monitor.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [join(project, "dist/cli.js"), "strata", "_watch"],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, STRATA_STATE_DIR: this.root },
      },
    );
    await new Promise<void>((ok, no) => {
      child.once("spawn", ok);
      child.once("error", no);
    });
    s.monitorPid = child.pid;
    child.unref();
    await log.close();
    await this.json("state.json", s);
    for (let i = 0; i < 25; i++) {
      const heartbeat = await readFile(join(this.root, "monitor.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (heartbeat?.pid === child.pid && heartbeat.state === "monitoring")
        return;
      await delay(200);
    }
    throw Error(
      "無操作停止の監視を確認できません。GPUはstrata stopで停止してください。",
    );
  }
  async watch() {
    await this.init();
    const lockPath = join(this.root, "watch.lock");
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      const pid = Number(await readFile(lockPath, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e: any) {
        alive = e.code !== "ESRCH";
      }
      if (alive)
        throw Error("監視ロックが存在します。既存monitorを確認してください。");
      await rm(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
    await lock.writeFile(String(process.pid));
    const timer = new IdleObservation();
    try {
      for (;;) {
        const s = await this.state();
        if (!s?.monitorEnabled) return;
        let status: any = {
          pid: process.pid,
          heartbeat: Date.now(),
          state: "monitoring",
        };
        try {
          const sample = await this.metrics(),
            observation = timer.observe(
              sample,
              Date.now() / 1000,
              Number(s.idleMinutes ?? 30) * 60,
            );
          status.idleSeconds = Math.round(observation.idleSeconds);
          if (observation.ready) {
            await delay(3000);
            await this.locked(async () => {
              const latest = await this.state();
              if (latest?.monitorEnabled && latest.endpoint === s.endpoint)
                await this.stopOwned(latest, observation.marker);
            });
            status.state = "stopped";
            await this.json("monitor.json", status);
            return;
          }
        } catch {
          timer.reset();
          status.state = "blocked";
          status.detail = "API/sessionの状態不明。停止せずタイマーをリセット";
        }
        await this.json("monitor.json", status);
        await delay(15000);
      }
    } finally {
      await lock.close();
      await rm(join(this.root, "watch.lock"), { force: true });
    }
  }
  async client(agent: string, args: string[] = []) {
    if (!["pi", "opencode"].includes(agent))
      throw Error("clientはpiまたはopencodeです");
    if (
      args.some((arg) =>
        /^(?:--(?:provider|model|config|api-key)(?:=|$)|-m$)/.test(arg),
      )
    )
      throw Error(
        "このlauncherでは接続モデル・provider・認証を引数で上書きできません",
      );
    const d = await this.discover();
    const directory = join(this.root, "clients");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let binary: string;
    let commandArgs: string[];
    let env = { ...process.env, STRATA_API_KEY: d.key };
    if (agent === "pi") {
      const piDir = join(directory, "pi");
      await mkdir(piDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(piDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              "strata-colab": {
                baseUrl: d.baseUrl,
                api: "openai-completions",
                apiKey: "$STRATA_API_KEY",
                authHeader: true,
                compat: {
                  supportsStore: false,
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: true,
                  maxTokensField: "max_tokens",
                },
                models: [
                  {
                    id: d.model,
                    name: "Qwen3.8 Flash Next / Colab",
                    reasoning: true,
                    thinkingLevelMap: { off: "none" },
                    input: ["text"],
                    contextWindow: d.context,
                    maxTokens: 8192,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await writeFile(
        join(piDir, "settings.json"),
        JSON.stringify({
          compaction: {
            enabled: true,
            reserveTokens: 24576,
            keepRecentTokens: 4096,
          },
        }),
        { mode: 0o600 },
      );
      binary =
        process.env.STRATA_PI_BIN ?? join(project, "node_modules/.bin/pi");
      if (!process.env.STRATA_PI_BIN && !existsSync(binary)) {
        let directory = dirname(
          fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
        );
        for (let i = 0; i < 4; i++) {
          const pkg = await readFile(join(directory, "package.json"), "utf8")
            .then(JSON.parse)
            .catch(() => undefined);
          if (pkg?.name === "@earendil-works/pi-coding-agent") {
            binary = join(directory, pkg.bin.pi);
            break;
          }
          directory = dirname(directory);
        }
      }
      commandArgs = [
        "--provider",
        "strata-colab",
        "--model",
        d.model,
        "--thinking",
        "low",
        ...args,
      ];
      env = { ...env, PI_CODING_AGENT_DIR: piDir } as any;
    } else {
      const { writeClientConfigs } = await import("./client-config.js");
      await writeClientConfigs(
        directory,
        process.env.HARNESS_URL ?? "http://127.0.0.1:4311",
      );
      const { opencodeBinary } = await import("./opencode.js");
      binary = opencodeBinary();
      commandArgs = args;
      env = {
        ...env,
        OPENCODE_CONFIG: join(directory, "opencode-strata.json"),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      } as any;
    }
    return new Promise<number>((ok, no) => {
      const child = spawn(binary, commandArgs, {
        stdio: "inherit",
        shell: false,
        env,
      });
      const stop = () => child.kill("SIGTERM");
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      child.once("error", no);
      child.once("exit", (code) => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        ok(code ?? 1);
      });
    });
  }
  async probe() {
    const d = await this.discover();
    const start = Date.now();
    const request = async (payload: unknown) => {
      const r = await fetch(d.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + d.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: d.model,
          reasoning_effort: "none",
          max_tokens: 256,
          ...(payload as any),
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw Error(`Strata probe HTTP ${r.status}`);
      return r;
    };
    const unauth = await fetch(d.baseUrl + "/models", {
      signal: AbortSignal.timeout(10000),
    });
    if (unauth.status !== 401)
      throw Error("認証なしリクエストの拒否を確認できません");
    const stream = await request({
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: true,
    });
    if (!stream.headers.get("content-type")?.includes("text/event-stream"))
      throw Error("SSEではありません");
    let buffer = "",
      done = false,
      text = false,
      first: number | undefined;
    const decoder = new TextDecoder();
    for await (const chunk of stream.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const value = line.slice(5).trim();
        if (value === "[DONE]") {
          done = true;
          continue;
        }
        const e = JSON.parse(value);
        if (e.error) throw Error("SSEエラー");
        if (e.choices?.some((c: any) => c.delta?.content)) {
          text = true;
          first ??= Date.now() - start;
        }
      }
    }
    if (!text || !done) throw Error("SSEの本文と完了を確認できません");
    const sseMs = Date.now() - start;
    const tools = [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo the given text",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        },
      ],
      user = { role: "user", content: "Call echo with text hello." };
    const tool = (await (
      await request({
        messages: [user],
        tools,
        tool_choice: { type: "function", function: { name: "echo" } },
      })
    ).json()) as any;
    const message = tool.choices?.[0]?.message,
      call = message?.tool_calls?.[0];
    if (
      call?.function?.name !== "echo" ||
      JSON.parse(call.function.arguments).text !== "hello"
    )
      throw Error("構造化tool callを確認できません");
    const answer = (await (
      await request({
        messages: [
          user,
          message,
          { role: "tool", tool_call_id: call.id, content: "hello" },
        ],
        tools,
        tool_choice: "none",
      })
    ).json()) as any;
    if (!answer.choices?.[0]?.message?.content)
      throw Error("tool result後の最終回答を確認できません");
    const report = {
      observedAt: new Date().toISOString(),
      model: d.model,
      context: d.context,
      unauthorizedStatus: unauth.status,
      sseDone: done,
      firstTextMs: first,
      sseMs,
      toolRoundTrip: true,
      elapsedMs: Date.now() - start,
    };
    await this.json("probe.json", report);
    return report;
  }
}
