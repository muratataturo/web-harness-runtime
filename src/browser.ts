import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { checkNavigation } from "./sources.js";
import type { Page } from "./types.js";
const exec = promisify(execFile);
export const browserBin = fileURLToPath(
  new URL("../node_modules/.bin/agent-browser", import.meta.url),
);
// This script is fixed host code. The model never supplies JavaScript or shell commands.
export const EXTRACT = `JSON.stringify((()=>{
 const body=document.body?.innerText||'';
 const title=document.title;
 const links=Array.from(document.querySelectorAll('a[href]'))
  .filter(a=>a.innerText.trim()&&a.getClientRects().length)
  .map(a=>({text:a.innerText.trim().slice(0,180),url:a.href}));
 const seen=new Set();
 const unique=links.filter(l=>{if(seen.has(l.url))return false;seen.add(l.url);return true;});
 const detail=/\\/(?:sln\\/H[0-9a-z]+|strJ[0-9]+|yad[0-9]+|usedcar\\/detail\\/|chintai\\/(?:bc|jnc)_[0-9]+|viewjob)/i;
 const rank=l=>/\\/chintai\\/bc_[0-9]+/i.test(l.url)?3:/\\/chintai\\/jnc_[0-9]+/i.test(l.url)?1:detail.test(l.url)?2:0;
 unique.sort((a,b)=>rank(b)-rank(a));
 const text=title+'\\n'+body;
 return {url:location.href,title,text:text.slice(0,32000),truncated:text.length>32000,links:unique.slice(0,220)};
})())`;

export function privateAddress(ip: string): boolean {
  if (ip.includes(":"))
    return !/^2[0-9a-f]{3}:/i.test(ip) && !/^3[0-9a-f]{3}:/i.test(ip);
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
class BrowserCommandError extends Error {}
export class Browser {
  private count = 0;
  private started = false;
  private config: string;
  constructor(
    private id: string,
    private dir: string,
    private hosts: string[],
    private signal: AbortSignal,
    private headed = false,
  ) {
    this.config = join(dir, "browser-config.json");
  }
  async init() {
    await writeFile(this.config, "{}", { mode: 0o600 });
  }
  async command(args: string[], cleanup = false): Promise<any> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "SYSTEMROOT",
      "LANG",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "AGENT_BROWSER_EXECUTABLE_PATH",
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.AGENT_BROWSER_DEFAULT_TIMEOUT = "20000";
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = "120000";
    env.AGENT_BROWSER_NO_VERSION_CHECK = "1";
    const flags = [
      "--config",
      this.config,
      "--session",
      `whr-${this.id}`,
      "--allowed-domains",
      this.hosts.join(","),
      "--json",
    ];
    if (this.headed) flags.push("--headed");
    let stdout: string;
    try {
      ({ stdout } = await exec(browserBin, [...flags, ...args], {
        env,
        timeout: cleanup ? 8000 : 35000,
        maxBuffer: 4 * 1024 * 1024,
        signal: cleanup ? undefined : this.signal,
      }));
    } catch (error: any) {
      if (this.signal.aborted && !cleanup) throw error;
      // The CLI emits useful structured errors on stdout even when exitCode != 0.
      if (typeof error.stdout === "string" && error.stdout.trim()) {
        try {
          const result = JSON.parse(error.stdout);
          if (result.error) throw new BrowserCommandError(String(result.error));
        } catch (parsed) {
          if (parsed instanceof BrowserCommandError) throw parsed;
        }
      }
      if (error.killed || error.code === "ETIMEDOUT")
        throw new BrowserCommandError(
          "ブラウザ操作が制限時間を超えました。取得済みリンクを使って別のページを確認してください",
        );
      throw new BrowserCommandError(
        error.code === "ENOENT"
          ? "agent-browser が見つかりません。npm ci と npm run browser:install を実行してください"
          : String(error.message),
      );
    }
    const result = JSON.parse(stdout);
    if (!result.success)
      throw new BrowserCommandError(
        String(result.error ?? "ブラウザ操作に失敗しました"),
      );
    return result.data;
  }
  async open(value: string): Promise<Page> {
    const url = checkNavigation(value, this.hosts);
    const addresses = await lookup(new URL(url).hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some((a) => !isIP(a.address) || privateAddress(a.address))
    )
      throw new Error("公開 IP アドレス以外へ接続できません");
    this.started = true;
    try {
      await this.command(["open", url]);
    } catch (error) {
      // Some publisher pages never finish their load event. Recover only an already
      // rendered body at the exact requested URL; never relabel the previous page.
      if (this.signal.aborted) throw error;
      try {
        const page = await this.read();
        if (
          page.url === url &&
          page.text.trim().length >= 30 &&
          page.title.trim()
        )
          return page;
      } catch {
        /* preserve the navigation error */
      }
      throw error;
    }
    return this.read();
  }
  async read(): Promise<Page> {
    const data = await this.command(["eval", EXTRACT]);
    const page = JSON.parse(
      typeof data.result === "string"
        ? data.result
        : JSON.stringify(data.result),
    );
    page.url = checkNavigation(page.url, this.hosts);
    page.links = page.links.filter((l: { url: string }) => {
      try {
        checkNavigation(l.url, this.hosts);
        return true;
      } catch {
        return false;
      }
    });
    return {
      ...page,
      id: `page-${++this.count}`,
      capturedAt: new Date().toISOString(),
    };
  }
  async snapshot(): Promise<string> {
    const data = await this.command(["snapshot", "-c", "-u"]);
    return String(data.snapshot ?? JSON.stringify(data)).slice(0, 20000);
  }
  async close() {
    if (this.started) await this.command(["close"], true);
  }
}
