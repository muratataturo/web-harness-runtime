import type { Page } from "./types.js";
import { checkNavigation } from "./sources.js";
/** No browser process or fetch fallback. Unknown URLs fail closed. */
export class ReplayBrowser {
  private count = 0;
  constructor(
    private pages: Page[],
    private hosts: string[],
    private signal: AbortSignal,
  ) {}
  async init() {
    this.signal.throwIfAborted();
  }
  async open(value: string, _options?: { render?: boolean }): Promise<Page> {
    this.signal.throwIfAborted();
    const url = checkNavigation(value, this.hosts);
    const page = this.pages.find((p) => p.url === url);
    if (!page)
      throw new Error(
        "凍結ベンチマークに存在しないURLです。ライブ取得には切り替えません",
      );
    return { ...structuredClone(page), id: `page-${++this.count}` };
  }
  async snapshot(): Promise<string> {
    throw new Error("凍結本文を使ってください。ライブブラウザは使用しません");
  }
  async close() {}
}
