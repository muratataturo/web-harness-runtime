import { productOffer, offerText } from "./product-offer.js";
import * as cheerio from "cheerio";
import { checkNavigation } from "./sources.js";
import { publicTarget, type HostResolver } from "./net-policy.js";
import type { Page } from "./types.js";
const MAX_BYTES = 4 * 1024 * 1024;
export const prefersPublicHtml = (value: string) =>
  [
    "www.jalan.net",
    "jalan.net",
    "suumo.jp",
    "www.suumo.jp",
    "beauty.rakuten.co.jp",
    "travel.rakuten.co.jp",
    "r.gnavi.co.jp",
    "realestate.rakuten.co.jp",
    "car.rakuten.co.jp",
    "gora.golf.rakuten.co.jp",
    "booking.gora.golf.rakuten.co.jp",
    "books.rakuten.co.jp",
    "search.rakuten.co.jp",
    "item.rakuten.co.jp",
  ].includes(new URL(value).hostname);
export class HtmlReadError extends Error {
  constructor(
    message: string,
    public readonly kind:
      "network" | "unsupported" | "encoding" | "too_large" | "redirect",
  ) {
    super(message);
  }
}
function encodingLabel(label: string): string {
  const value = label.trim().toLowerCase();
  if (/^(windows-31j|shift[-_]?jis|sjis|x-sjis|ms932|cp932)$/.test(value))
    return "shift_jis";
  if (value === "utf8") return "utf-8";
  if (!["utf-8", "euc-jp", "iso-2022-jp", "windows-1252"].includes(value))
    throw new HtmlReadError(`未対応のHTML文字コード: ${value}`, "encoding");
  return value;
}
/** Header/meta and BOM determine the encoding before parsing. Never decode Windows-31J as UTF-8. */
export function decodeHtml(
  bytes: Uint8Array,
  contentType: string,
): { html: string; charset: string } {
  const header = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  const ascii = Buffer.from(bytes.subarray(0, 8192)).toString("latin1");
  const meta = ascii.match(
    /<meta\b[^>]*\bcharset\s*=\s*["']?([a-z0-9_-]+)/i,
  )?.[1];
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const charset = encodingLabel(bom ? "utf-8" : (header ?? meta ?? "utf-8"));
  let html: string;
  try {
    html = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    throw new HtmlReadError(
      `HTMLの${charset}デコードに失敗しました。文字化け本文を根拠にしません`,
      "encoding",
    );
  }
  return { html, charset };
}
export function extractPublicHtml(
  html: string,
  url: string,
  hosts: string[],
): Omit<Page, "id" | "capturedAt" | "acquisition"> {
  const offer = productOffer(html, url);
  const $ = cheerio.load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  // Hidden anchors are discovery hints only. Their text never enters citation evidence.
  $("script,style,noscript,template,svg,canvas").remove();
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  const priority = new Map<string, number>();
  $("a[href]").each((_i, el) => {
    const a = $(el),
      text = (a.text().trim() || a.find("img").attr("alt") || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return;
    try {
      const target = checkNavigation(new URL(a.attr("href")!, url).href, hosts);
      const mainResult = a.closest("#js-bukkenList,.cassetteitem").length > 0;
      if (mainResult) priority.set(target, 20);
      if (!seen.has(target)) {
        seen.add(target);
        const label = a
          .closest(".cassetteitem")
          .find(".cassetteitem_content-title")
          .first()
          .text()
          .trim();
        links.push({
          text: (label ? label + " — " + text : text).slice(0, 180),
          url: target,
        });
      }
    } catch {
      /* not an allowed public link */
    }
  });
  const rank = (value: string) =>
    /\/s\d{8,}\/|\/HOTEL\/\d+\/|\/guide\/disp\/c_id\/\d+|\/rb\/\d+\//.test(
      value,
    ) || value.startsWith("https://item.rakuten.co.jp/")
      ? 5
      : /\/chintai\/bc_\d+/.test(value)
        ? 4
        : /\/yad\d+\//.test(value)
          ? 3
          : /\/chintai\/jnc_\d+/.test(value)
            ? 2
            : 0;
  links.sort(
    (a, b) =>
      (priority.get(b.url) ?? 0) +
      rank(b.url) -
      (priority.get(a.url) ?? 0) -
      rank(a.url),
  );
  // No script is executed. Explicitly hidden controls/markup are not treated as page evidence.
  $(
    'script,style,noscript,template,svg,canvas,[hidden],[aria-hidden="true"],input,select,button',
  ).remove();
  $("[style]").each((_i, el) => {
    if (
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
        $(el).attr("style") ?? "",
      )
    )
      $(el).remove();
  });
  $("br").replaceWith("\n");
  $(
    "p,div,section,article,header,footer,nav,h1,h2,h3,h4,h5,h6,li,tr,td,th,dt,dd,table",
  ).each((_i, el) => {
    $(el).prepend("\n");
    $(el).append("\n");
  });
  const body = $("body")
    .text()
    .split(/\r?\n/)
    .map((l) => l.replace(/[\t \u00a0\u3000]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const text = title + "\n" + (offer ? offerText(offer) + "\n" : "") + body;
  return {
    url,
    title,
    productOffer: offer,
    text: text.slice(0, 32000),
    links: links.slice(0, 220),
    truncated: text.length > 32000,
  };
}
/** Public GET only, no cookies/credentials, manual host/DNS checks at every redirect. */
export async function readPublicHtml(
  value: string,
  hosts: string[],
  signal: AbortSignal,
  deps: { fetcher?: typeof fetch; resolveHost?: HostResolver } = {},
): Promise<Omit<Page, "id">> {
  const fetcher = deps.fetcher ?? fetch;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  let url = checkNavigation(value, hosts);
  for (let redirects = 0; redirects <= 5; redirects++) {
    deadline.throwIfAborted();
    url = await publicTarget(url, hosts, deps.resolveHost);
    deadline.throwIfAborted();
    const response = await fetcher(url, {
      redirect: "manual",
      signal: deadline,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "web-harness-runtime/0.2 (public page research)",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new HtmlReadError("転送先が指定されていません", "redirect");
      const target = new URL(location, url);
      if (
        /^(?:login|auth|accounts?)\./i.test(target.hostname) ||
        /\/(?:login|signin|authorize)(?:\/|$)/i.test(target.pathname)
      ) {
        return {
          url,
          title: "ログイン・認証先への転送",
          text: `公開ページから認証用URL（${target.hostname}）へ転送されました。認証先は取得していません。`,
          links: [],
          truncated: false,
          capturedAt: new Date().toISOString(),
          acquisition: {
            kind: "public-html",
            status: response.status,
            contentType: response.headers.get("content-type") ?? undefined,
          },
        };
      }
      url = checkNavigation(target.href, hosts);
      continue;
    }
    // Access-denied pages are returned with their status; callers must not retry to evade them.
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new HtmlReadError(`公開HTML HTTP ${response.status}`, "network");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      [401, 403, 429].includes(response.status) &&
      !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)
    ) {
      await response.body?.cancel();
      return {
        url,
        title: `HTTP ${response.status} Access Denied`,
        text: `HTTP ${response.status}: 公開HTMLの取得がアクセス制限で拒否されました。`,
        links: [],
        truncated: false,
        capturedAt: new Date().toISOString(),
        acquisition: {
          kind: "public-html",
          status: response.status,
          contentType,
        },
      };
    }
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      await response.body?.cancel();
      throw new HtmlReadError("HTML以外のレスポンスです", "unsupported");
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new HtmlReadError(
        "HTMLが取得サイズ上限を超えています",
        "too_large",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HtmlReadError("HTML本文がありません", "network");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        deadline.throwIfAborted();
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > MAX_BYTES)
          throw new HtmlReadError(
            "HTMLが取得サイズ上限を超えています",
            "too_large",
          );
        chunks.push(chunk);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const bytes = Buffer.concat(chunks);
    const { html, charset } = decodeHtml(bytes, contentType);
    const page = extractPublicHtml(html, url, hosts);
    return {
      ...page,
      capturedAt: new Date().toISOString(),
      acquisition: {
        kind: "public-html",
        status: response.status,
        charset,
        contentType,
      },
    };
  }
  throw new HtmlReadError("HTMLの転送回数上限を超えました", "redirect");
}
