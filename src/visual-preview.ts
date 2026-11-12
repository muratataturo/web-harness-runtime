import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Browser } from "./browser.js";
import { readPublicHtml } from "./html-reader.js";
import { publicTarget } from "./net-policy.js";
import { assessPage } from "./page-quality.js";
import type { PageArtifact } from "./artifacts.js";
type Input = PageArtifact & { images?: { url: string; alt: string }[] };
export interface VisualPreview {
  url: string;
  capturedAt: string;
  images: { file: string; alt: string; sourceUrl: string; type: string }[];
  screen?: {
    file: string;
    capturedAt: string;
    width: number;
    height: number;
    url?: string;
  };
  imageError?: string;
  screenError?: string;
}
const maxBytes = 4 * 1024 * 1024;
export async function fetchPreviewImage(
  value: string,
  signal: AbortSignal,
  fetcher = fetch,
  resolver?: Parameters<typeof publicTarget>[2],
) {
  let url = value;
  for (let i = 0; i < 4; i++) {
    url = await publicTarget(url, [new URL(url).hostname], resolver);
    const response = await fetcher(url, {
      redirect: "manual",
      signal,
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const to = response.headers.get("location");
      await response.body?.cancel();
      if (!to) throw Error("画像の転送先がありません");
      url = new URL(to, url).href;
      continue;
    }
    const type = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (
      !response.ok ||
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
      ].includes(type)
    ) {
      await response.body?.cancel();
      throw Error("公開画像を取得できませんでした");
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw Error("画像サイズ上限");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("画像なし");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > maxBytes) throw Error("画像サイズ上限");
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    const signature =
      type === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : type === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216
          : type === "image/gif"
            ? bytes.subarray(0, 6).toString().startsWith("GIF8")
            : type === "image/webp"
              ? bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP"
              : bytes.subarray(4, 8).toString() === "ftyp" &&
                /avif|avis/.test(bytes.subarray(8, 32).toString());
    if (!signature) throw Error("画像形式を確認できませんでした");
    return { bytes, type, sourceUrl: url };
  }
  throw Error("画像の転送回数上限");
}
/** Display-only captures stay separate from research evidence. No arbitrary URLs from the API. */
export class VisualPreviewStore {
  private pending = new Map<string, Promise<VisualPreview>>();
  private screenQueue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private directory(url: string) {
    return join(
      this.root,
      "visuals",
      createHash("sha256").update(url).digest("hex"),
    );
  }
  async cached(a: Input): Promise<VisualPreview | undefined> {
    const p = await readFile(join(this.directory(a.url), "visual.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (p?.url !== a.url) return undefined;
    const paths = new Set<string>();
    p.images = (p.images ?? []).filter((i: { sourceUrl: string }) => {
      const path = new URL(i.sourceUrl).pathname;
      if (paths.has(path) || /(?:\/SYS\/|\/common\/|_98\.)/i.test(path))
        return false;
      paths.add(path);
      return true;
    });
    return p;
  }
  async load(a: Input, capture = false): Promise<VisualPreview> {
    if (a.state === "unavailable")
      throw Error(
        "取得不可のページは画像・画面を再取得しません。元ページから確認してください。",
      );
    const key = a.url + (capture ? ":screen" : ":images");
    const existing = this.pending.get(key);
    if (existing) return existing;
    // Serialize a URL's image and screen updates so one never overwrites the other.
    const preceding = this.pending.get(
      a.url + (capture ? ":images" : ":screen"),
    );
    const job = (async () => {
      await preceding?.catch(() => {});
      const dir = this.directory(a.url);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const cached = await this.cached(a);
      if (cached && (!capture || cached.screen)) return cached;
      const result: VisualPreview = cached ?? {
        url: a.url,
        capturedAt: new Date().toISOString(),
        images: [],
      };
      if (!cached) {
        try {
          const page = await readPublicHtml(
            a.url,
            [new URL(a.url).hostname],
            AbortSignal.timeout(18000),
          );
          if (assessPage(page).shouldStop)
            throw Error("公開ページを表示できません");
          const images = page.images?.length ? page.images : (a.images ?? []);
          for (const image of images.slice(0, 5)) {
            if (result.images.length >= 3) break;
            try {
              const asset = await fetchPreviewImage(
                image.url,
                AbortSignal.timeout(8000),
              );
              const file = `image-${result.images.length}`;
              await writeFile(join(dir, file), asset.bytes, { mode: 0o600 });
              result.images.push({
                file,
                alt: image.alt,
                sourceUrl: asset.sourceUrl,
                type: asset.type,
              });
            } catch {
              /* Skip a missing image, never substitute unrelated photos. */
            }
          }
          if (!result.images.length)
            result.imageError =
              "このページでは表示できる公開画像が見つかりませんでした。Web画面または本文をご覧ください。";
        } catch {
          result.imageError =
            "ページ画像を取得できませんでした。保存本文は引き続き確認できます。";
        }
      }
      if (capture) {
        const work = async () => {
          const signal = AbortSignal.timeout(45000);
          const host = new URL(a.url).hostname;
          const assets = result.images.map(
            (i) => new URL(i.sourceUrl).hostname,
          );
          const cdns = host.endsWith("hotpepper.jp")
            ? ["imgfp.hotp.jp", "img.recruit.co.jp"]
            : host.endsWith("rakuten.co.jp")
              ? [
                  "thumbnail.image.rakuten.co.jp",
                  "image.books.rakuten.co.jp",
                  "books.rakuten.co.jp",
                  "r.r10s.jp",
                ]
              : host.endsWith("jalan.net")
                ? ["www.jalan.net", "cdn.jalan.jp"]
                : [];
          const hosts = [...new Set([host, ...assets, ...cdns])];
          const verified = [];
          for (const h of hosts) {
            try {
              await publicTarget(`https://${h}/`, [h]);
              verified.push(h);
            } catch {
              /* unavailable asset host */
            }
          }
          const browser = new Browser(
            "visual-" + randomUUID(),
            dir,
            verified,
            signal,
          );
          try {
            await browser.init();
            await browser.command(["set", "viewport", "1280", "900"]);
            const page = await browser.open(a.url, { render: true });
            if (assessPage(page).shouldStop) throw Error("取得不可の画面");
            await browser.command(["screenshot", join(dir, "screen.png")]);
            result.screen = {
              file: "screen.png",
              capturedAt: new Date().toISOString(),
              width: 1280,
              height: 900,
              url: page.url,
            };
            delete result.screenError;
          } catch {
            result.screenError =
              "Web画面を取得できませんでした。ページ画像・保存本文または元ページで確認してください。";
          } finally {
            await browser.command(["close"], true).catch(() => {});
          }
        };
        const queued = this.screenQueue.catch(() => {}).then(work);
        this.screenQueue = queued;
        await queued;
      }
      const tmp = join(dir, randomUUID() + ".tmp");
      await writeFile(tmp, JSON.stringify(result), { mode: 0o600 });
      const { rename } = await import("node:fs/promises");
      await rename(tmp, join(dir, "visual.json"));
      return result;
    })();
    this.pending.set(key, job);
    try {
      return await job;
    } finally {
      this.pending.delete(key);
    }
  }
  async file(a: Input, file: string) {
    const meta = await this.cached(a);
    const image = meta?.images.find((i) => i.file === file);
    if (!image && !(file === "screen.png" && meta?.screen))
      throw Error("表示画像がありません");
    return {
      bytes: await readFile(join(this.directory(a.url), file)),
      type: image?.type ?? "image/png",
    };
  }
}
