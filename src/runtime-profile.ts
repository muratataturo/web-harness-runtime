import { createHash } from "node:crypto";
import {
  adapters,
  allowedHosts,
  checkNavigation,
  routeSources,
} from "./sources.js";

export type SecurityMode = "hardened" | "development";
export function securityMode(): SecurityMode {
  const value = process.env.RUNTIME_SECURITY_MODE ?? "hardened";
  if (value !== "hardened" && value !== "development")
    throw new Error(
      "RUNTIME_SECURITY_MODE は hardened または development です",
    );
  return value;
}

// Trusted, versioned source configuration. Page content never adds rules here.
const paths: Record<string, string[]> = {
  "recruit-agent": ["/", "/job_search/**", "/viewjob/**"],
  "hotpepper-beauty": ["/", "/svc**", "/slnH**", "/kr/**"],
  "hotpepper-gourmet": [
    "/",
    "/strJ**",
    "/CSP/psh010/doBasic",
    "/SA**",
    "/Y**",
    "/top_party**",
  ],
  jalan: ["/", "/yad**", "/[0-9]**", "/onsen/**", "/ryokan/**", "/uw/uwp**"],
  carsensor: ["/", "/usedcar/**"],
  suumo: ["/", "/chintai/**", "/ms/**", "/ikkodate/**", "/tochi/**"],
  indeed: ["/", "/jobs", "/viewjob", "/rc/clk"],
  "rakuten-beauty": [
    "/",
    "/s[0-9]**",
    "/addr**",
    "/area**",
    "/pre**",
    "/eki**",
    "/men/**",
  ],
  "rakuten-travel": [
    "/",
    "/yado/**",
    "/HOTEL/**",
    "/hotelinfo/**",
    "/review/**",
  ],
  "rakuten-gourmet": ["/**"],
  "rakuten-realestate": ["/", "/rent/**", "/chintai/**"],
  "rakuten-car": ["/", "/shaken/**"],
  "rakuten-gora": ["/", "/doc/**", "/guide/**", "/search", "/search/**"],
  "rakuten-books": [
    "/",
    "/rb/**",
    "/search",
    "/search/**",
    "/book/**",
    "/ranking/**",
  ],
  "rakuten-ichiba": ["/**"],
};
// Expand prefix families into a segment plus its descendants. OpenShell's **
// only crosses '/' when it occupies an entire segment (not in /strJ**).
export function researchPaths(host: string): string[] {
  const service = adapters.find((a) => a.hosts.includes(host))?.id;
  return (paths[service ?? ""] ?? ["/**"])
    .flatMap((p) =>
      p.includes("[0-9]")
        ? Array.from({ length: 10 }, (_, i) => p.replace("[0-9]", String(i)))
        : [p],
    )
    .flatMap((p) =>
      p.endsWith("**") && !p.endsWith("/**")
        ? [p.slice(0, -1), p.slice(0, -1) + "/**"]
        : [p],
    );
}
function pathMatches(pattern: string, path: string): boolean {
  const expression = pattern
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "[^/]*(?:/[^/]*)*"
        : segment
            .split("*")
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
    )
    .join("/");
  return new RegExp(`^${expression}$`).test(path);
}
export const forbiddenSegments = [
  "login",
  "signin",
  "sign-in",
  "logout",
  "auth",
  "oauth",
  "authorize",
  "account",
  "accounts",
  "mypage",
  "my-page",
  "cart",
  "basket",
  "checkout",
  "purchase",
  "payment",
  "order",
  "orders",
  "reserve",
  "reservation",
  "booking",
  "entry",
  "apply",
  "application",
  "contact",
  "inquiry",
  "delete",
  "update",
  "unsubscribe",
  "register",
  "registration",
];
export const forbiddenResearchPaths = forbiddenSegments.flatMap((segment) => {
  const p = [...segment]
    .map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c))
    .join("");
  return [`/*${p}*`, `/*${p}*/**`, `/**/*${p}*`, `/**/*${p}*/**`];
});
const forbiddenQuery =
  /^(?:access_token|refresh_token|token|api_?key|authorization|password|passwd|secret|session|cookie|redirect|redirect_uri|return_?url|callback|email|phone|address|action|command|operation|_method)$/i;

export function checkResearchNavigation(
  value: string,
  hosts: readonly string[],
  asset = false,
): string {
  const href = checkNavigation(value, [...hosts]);
  const url = new URL(href);
  if (href.length > 8192 || url.search.length > 2048)
    throw new Error("調査URLの長さ上限です");
  let path = url.pathname;
  for (let i = 0; i < 3; i++) {
    const decoded = decodeURIComponent(path);
    if (decoded === path) break;
    path = decoded;
  }
  if (/%[0-9a-f]{2}|[\\\x00-\x20\x7f]/i.test(path))
    throw new Error("不正な調査pathです");
  const segments = [
    ...path.toLowerCase().split("/"),
    ...path.toLowerCase().split(/[\/;._-]+/),
  ];
  if (
    segments.some((p) => forbiddenSegments.includes(p)) ||
    forbiddenSegments.some((s) => path.toLowerCase().includes(s)) ||
    (!asset && !researchPaths(url.hostname).some((p) => pathMatches(p, path)))
  )
    throw new Error("公開調査の許可対象外のpathです");
  if (
    [...url.searchParams].length > 40 ||
    [...url.searchParams].some(
      ([k, v]) =>
        forbiddenQuery.test(k) ||
        k.length > 80 ||
        v.length > 1024 ||
        /[\x00-\x1f\x7f]/.test(k + v),
    )
  )
    throw new Error("公開調査の許可対象外のqueryです");
  url.hash = "";
  return url.href;
}

export interface ResearchProfile {
  readonly version: 1;
  readonly id:
    "recruit-public-research" | "rakuten-public-research" | "public-research";
  readonly mode: SecurityMode;
  readonly hosts: readonly string[];
  readonly services: readonly string[];
  readonly policyHash: string;
}
export function createResearchProfile(
  urls: string[],
  mode = securityMode(),
  query = "research",
): ResearchProfile {
  if (!urls.length || urls.length > 20) throw new Error("公開URLは1〜20件です");
  const sources = routeSources(query, urls);
  const services = [...new Set(sources.map((s) => s.kind))].sort();
  const requested = process.env.RUNTIME_PROFILE ?? "auto";
  if (!["auto", "recruit", "rakuten", "public"].includes(requested))
    throw new Error("不正なRUNTIME_PROFILE");
  const recruit = (s: string) =>
    [
      "recruit-agent",
      "hotpepper-beauty",
      "hotpepper-gourmet",
      "jalan",
      "carsensor",
      "suumo",
      "indeed",
      "official-visit",
      "official-dining",
      "official-cafe",
    ].includes(s);
  const rakuten = (s: string) => s.startsWith("rakuten-");
  if (
    (requested === "recruit" && !services.every(recruit)) ||
    (requested === "rakuten" && !services.every(rakuten))
  )
    throw new Error("選択したruntime profile以外のサービスは許可できません");
  const hosts = Object.freeze(allowedHosts(sources).sort());
  if (mode === "hardened")
    urls.forEach((u) => checkResearchNavigation(u, hosts));
  const id: ResearchProfile["id"] = services.every(recruit)
    ? "recruit-public-research"
    : services.every(rakuten)
      ? "rakuten-public-research"
      : "public-research";
  const data = {
    version: 1 as const,
    id,
    mode,
    hosts,
    services: Object.freeze(services),
  };
  const policyHash = createHash("sha256")
    .update(
      JSON.stringify({
        ...data,
        paths: hosts.map((h) => [h, researchPaths(h)]),
        forbiddenSegments,
      }),
    )
    .digest("hex");
  return Object.freeze({ ...data, policyHash });
}

export function assetHosts(pageHost: string): string[] {
  const allowed = [pageHost];
  const is = (domain: string) =>
    pageHost === domain || pageHost.endsWith("." + domain);
  if (is("hotpepper.jp")) allowed.push("imgfp.hotp.jp", "img.recruit.co.jp");
  if (is("rakuten.co.jp"))
    allowed.push(
      "thumbnail.image.rakuten.co.jp",
      "image.books.rakuten.co.jp",
      "r.r10s.jp",
    );
  if (is("jalan.net")) allowed.push("cdn.jalan.jp");
  return allowed;
}
