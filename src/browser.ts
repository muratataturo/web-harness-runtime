import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { publicTarget } from "./net-policy.js";
export { privateAddress } from "./net-policy.js";
import { readPublicHtml, prefersPublicHtml } from "./html-reader.js";
import { assessPage } from "./page-quality.js";
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
 const detail=/\\/(?:sln\\/?H[0-9a-z]+|strJ[0-9]+|yad[0-9]+|usedcar\\/detail\\/|chintai\\/(?:bc|jnc)_[0-9]+|viewjob)/i;
 const rank=l=>/\\/chintai\\/bc_[0-9]+/i.test(l.url)?3:/\\/chintai\\/jnc_[0-9]+/i.test(l.url)?1:detail.test(l.url)?2:0;
 unique.sort((a,b)=>rank(b)-rank(a));
 const text=title+'\\n'+body;
 return {url:location.href,title,text:text.slice(0,32000),truncated:text.length>32000,links:unique.slice(0,220)};
})())`;

class BrowserCommandError extends Error {}
export class Browser {
  private count = 0;
  private htmlPage?: Page;
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
  async open(value: string, options: { render?: boolean } = {}): Promise<Page> {
    const url = await publicTarget(value, this.hosts);
    this.htmlPage = undefined;
    if (prefersPublicHtml(url) && !options.render) {
      try {
        const extracted = await readPublicHtml(url, this.hosts, this.signal);
        const quality = assessPage(extracted);
        if (quality.shouldStop || extracted.text.length >= 150) {
          const page: Page = { ...extracted, id: `page-${++this.count}` };
          this.htmlPage = page;
          return page;
        }
      } catch (error) {
        if (this.signal.aborted) throw error;
      }
    }
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
    if (this.htmlPage) return this.htmlPage;
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
      acquisition: { kind: "browser-dom" },
    };
  }
  async snapshot(): Promise<string> {
    if (this.htmlPage)
      throw new Error(
        "現在のページは公開HTMLとして取得しています。ブラウザのアクセシビリティツリーはありません。取得済み本文とリンクを使用してください。",
      );
    const data = await this.command(["snapshot", "-c", "-u"]);
    return String(data.snapshot ?? JSON.stringify(data)).slice(0, 20000);
  }
  async close() {
    if (this.started) await this.command(["close"], true);
  }
}
