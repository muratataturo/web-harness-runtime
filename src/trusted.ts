import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verificationLevel, type TrustLevel } from "./trust-levels.js";
import { Browser } from "./browser.js";
import { allowedHosts, routeSources, entityKey } from "./sources.js";
import {
  verifyDetail,
  detailContracts,
  type DetailVerification,
} from "./detail-contracts.js";
import { assessPage } from "./page-quality.js";
import { setTimeout as delay } from "node:timers/promises";
export interface CatalogSource {
  id: string;
  family: string;
  service: string;
  label: string;
  category: string;
  seedUrl: string;
  discoveryPattern?: string;
}
export interface SourceAudit {
  sourceId: string;
  service: string;
  seedUrl: string;
  status: "verified" | "insufficient_detail" | "blocked" | "retired" | "failed";
  checkedAt: string;
  expiresAt: string;
  minDetails: number;
  details: DetailVerification[];
  pages: {
    url: string;
    title: string;
    assessment: ReturnType<typeof assessPage>;
    level?: TrustLevel;
  }[];
  error?: string;
}
export interface TrustedUrl {
  level?: TrustLevel;
  url: string;
  sourceId: string;
  service: string;
  entityId: string;
  title: string;
  checkedAt: string;
  expiresAt: string;
  purpose: "detail-retrieval-only";
  evidence: DetailVerification;
}
export interface TrustedRegistry {
  schemaVersion: 1;
  purpose: "detail-retrieval-only";
  urls: TrustedUrl[];
  audits: SourceAudit[];
}
export const emptyRegistry = (): TrustedRegistry => ({
  schemaVersion: 1,
  purpose: "detail-retrieval-only",
  urls: [],
  audits: [],
});
export async function sourceCatalog(): Promise<CatalogSource[]> {
  return JSON.parse(
    await readFile(
      new URL("../config/source-catalog.json", import.meta.url),
      "utf8",
    ),
  ).sources;
}
export function auditComplete(audit: SourceAudit): boolean {
  return (
    audit.status === "verified" &&
    Number.isSafeInteger(audit.minDetails) &&
    audit.minDetails >= 2 &&
    new Set(
      audit.details
        .filter((d) => validDetail(d) && d.service === audit.service)
        .map((d) => d.entityId),
    ).size >= audit.minDetails
  );
}
function validDetail(d: DetailVerification): boolean {
  const required = detailContracts[d.service];
  return (
    d.status === "verified" &&
    !!d.entityId &&
    entityKey(d.url) === d.entityId &&
    !!required?.length &&
    !d.missingFields.length &&
    /^[a-f0-9]{64}$/.test(d.bodySha256) &&
    required.every((f) =>
      d.fields.some(
        (p) => p.id === f.id && p.quote.trim() && f.pattern.test(p.quote),
      ),
    )
  );
}
export function activeTrustedUrls(
  registry: TrustedRegistry,
  at = new Date(),
): TrustedUrl[] {
  return registry.urls
    .map((u) => ({ ...u, level: verificationLevel(u.evidence) }))
    .filter(
      (u) =>
        new Date(u.expiresAt) > at &&
        new Date(u.checkedAt) <= at &&
        u.purpose === "detail-retrieval-only" &&
        validDetail(u.evidence) &&
        u.evidence.url === u.url &&
        u.evidence.entityId === u.entityId &&
        u.evidence.service === u.service &&
        registry.audits.some(
          (a) =>
            a.sourceId === u.sourceId &&
            a.service === u.service &&
            a.checkedAt === u.checkedAt &&
            a.expiresAt === u.expiresAt &&
            auditComplete(a) &&
            a.details.some(
              (d) => d.url === u.url && d.bodySha256 === u.evidence.bodySha256,
            ),
        ),
    );
}
/** A failed revalidation removes current trust; per-run evidence remains in audit artifacts. */
export function reconcileAudit(
  registry: TrustedRegistry,
  audit: SourceAudit,
): TrustedRegistry {
  const latest = registry.audits.find((a) => a.sourceId === audit.sourceId);
  if (latest && new Date(latest.checkedAt) > new Date(audit.checkedAt))
    return registry;
  const urls = registry.urls.filter((u) => u.sourceId !== audit.sourceId);
  if (auditComplete(audit))
    for (const d of audit.details.filter((d) => d.status === "verified")) {
      if (
        d.service !== audit.service ||
        !d.entityId ||
        urls.some(
          (u) => u.sourceId === audit.sourceId && u.entityId === d.entityId,
        )
      )
        continue;
      urls.push({
        url: d.url,
        sourceId: audit.sourceId,
        service: d.service,
        entityId: d.entityId,
        title: d.title,
        checkedAt: audit.checkedAt,
        expiresAt: audit.expiresAt,
        purpose: "detail-retrieval-only",
        evidence: d,
        level: verificationLevel(d),
      });
    }
  return {
    ...registry,
    urls,
    audits: [
      ...registry.audits.filter((a) => a.sourceId !== audit.sourceId),
      audit,
    ],
  };
}
export class TrustedStore {
  public file: string;
  private bootstrap?: string;
  constructor(file?: string) {
    this.file = resolve(
      file ??
        process.env.TRUSTED_URLS_FILE ??
        join(process.env.RUNTIME_DIR ?? ".runtime", "trusted-urls.json"),
    );
    if (!file && !process.env.TRUSTED_URLS_FILE)
      this.bootstrap = fileURLToPath(
        new URL("../config/trusted-urls.json", import.meta.url),
      );
  }
  async load(): Promise<TrustedRegistry> {
    try {
      const r = JSON.parse(await readFile(this.file, "utf8"));
      if (
        r.schemaVersion !== 1 ||
        r.purpose !== "detail-retrieval-only" ||
        !Array.isArray(r.urls) ||
        !Array.isArray(r.audits)
      )
        throw new Error("trusted URL台帳の形式が不正です");
      return {
        ...r,
        urls: r.urls.map((u: TrustedUrl) => ({
          ...u,
          level: verificationLevel(u.evidence),
        })),
      };
    } catch (e: any) {
      if (e.code === "ENOENT") {
        if (this.bootstrap)
          try {
            const bundled = JSON.parse(await readFile(this.bootstrap, "utf8"));
            if (
              bundled.schemaVersion !== 1 ||
              bundled.purpose !== "detail-retrieval-only" ||
              !Array.isArray(bundled.urls) ||
              !Array.isArray(bundled.audits)
            )
              throw new Error("bundled trusted URL台帳の形式が不正です");
            return {
              ...bundled,
              urls: bundled.urls.map((u: TrustedUrl) => ({
                ...u,
                level: verificationLevel(u.evidence),
              })),
            };
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
        return emptyRegistry();
      }
      throw e;
    }
  }
  async save(registry: TrustedRegistry) {
    await mkdir(resolve(this.file, ".."), { recursive: true });
    const tmp = this.file + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(tmp, this.file);
  }
  /** Cross-process lock: reload after acquiring it so concurrent audits never overwrite each other. */
  async record(audit: SourceAudit): Promise<void> {
    await mkdir(resolve(this.file, ".."), { recursive: true });
    const lock = this.file + ".lock";
    let handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        handle = await open(lock, "wx", 0o600);
        break;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        await delay(50);
      }
    }
    if (!handle)
      throw new Error(
        "trusted台帳が使用中です。再実行してください（異常終了時はlockを確認）",
      );
    try {
      await this.save(reconcileAudit(await this.load(), audit));
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
  async urlsFor(sourceIds: string[], minLevel: 3 | 4 = 3): Promise<string[]> {
    if (minLevel !== 3 && minLevel !== 4)
      throw new Error("trusted実行にはL3またはL4が必要です");
    if (!sourceIds.length) throw new Error("trusted source IDが必要です");
    const r = await this.load(),
      active = activeTrustedUrls(r).filter((u) => (u.level ?? 3) >= minLevel);
    const missing = sourceIds.filter(
      (id) => !active.some((u) => u.sourceId === id),
    );
    if (missing.length)
      throw new Error(
        `詳細取得未確認・期限切れのsourceです: ${missing.join(", ")}`,
      );
    // Only the exact verified detail URLs are reused, not a domain-wide grant.
    return active
      .filter((u) => sourceIds.includes(u.sourceId))
      .map((u) => u.url);
  }
}
export async function auditSource(
  source: CatalogSource,
  options: {
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (s: string) => void;
    minDetails?: number;
    maxPages?: number;
  } = {},
): Promise<SourceAudit> {
  const now = new Date(),
    audit: SourceAudit = {
      sourceId: source.id,
      service: source.service,
      seedUrl: source.seedUrl,
      status: "insufficient_detail",
      checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
      minDetails: options.minDetails ?? 2,
      details: [],
      pages: [],
    };
  if (audit.minDetails < 2 || !Number.isSafeInteger(audit.minDetails))
    throw new Error("source登録には独立した詳細2件以上が必要です");
  if (
    !Number.isSafeInteger(options.timeoutSeconds ?? 75) ||
    (options.timeoutSeconds ?? 75) < 1
  )
    throw new Error("制限時間は1以上の整数です");
  const dir = resolve(
    process.env.RUNTIME_DIR ?? ".runtime",
    "trusted-audits",
    randomUUID(),
    source.id,
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const signal = AbortSignal.any([
    AbortSignal.timeout((options.timeoutSeconds ?? 75) * 1000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const hosts = allowedHosts(routeSources("audit", [source.seedUrl]));
  const browser = new Browser(
    `trust-${source.id}-${randomUUID().slice(0, 8)}`,
    dir,
    hosts,
    signal,
  );
  const visited = new Set<string>(),
    seenEntity = new Set<string>();
  let count = 0;
  const queue = [source.seedUrl];
  try {
    await browser.init();
    while (
      queue.length &&
      count < (options.maxPages ?? 5) &&
      audit.details.filter((d) => d.status === "verified").length <
        audit.minDetails
    ) {
      signal.throwIfAborted();
      const value = queue.shift()!;
      if (visited.has(value)) continue;
      if (seenEntity.has(entityKey(value) ?? "")) continue;
      visited.add(value);
      options.onProgress?.(`${source.id}: ${value}`);
      const page = await browser.open(value);
      count++;
      await writeFile(
        join(dir, `page-${count}.json`),
        JSON.stringify(page, null, 2),
        { mode: 0o600 },
      );
      const assessment = assessPage(page);
      audit.pages.push({
        url: page.url,
        title: page.title,
        assessment,
        level: verifyDetail(page, source.service).level,
      });
      if (assessment.shouldStop) {
        audit.status = assessment.kind === "retired" ? "retired" : "blocked";
        break;
      }
      const check = verifyDetail(page, source.service);
      if (check.entityId && !seenEntity.has(check.entityId)) {
        if (check.status === "verified") seenEntity.add(check.entityId);
        const prior = audit.details.findIndex(
          (d) => d.entityId === check.entityId,
        );
        if (prior >= 0) audit.details[prior] = check;
        else audit.details.push(check);
      }
      const detailLinks = page.links.filter((l) => {
        const id = entityKey(l.url);
        return id?.startsWith(source.service + ":") && !seenEntity.has(id);
      });
      // A seed/detail may expose nav links to other entities; this only proves those exact retrieved URLs.
      const same = detailLinks.filter(
        (l) => entityKey(l.url) === check.entityId && !visited.has(l.url),
      );
      const other = detailLinks.filter(
        (l) => entityKey(l.url) !== check.entityId,
      );
      same.sort(
        (a, b) =>
          Number(/詳細情報|基本情報|_std\.html/.test(b.text + " " + b.url)) -
          Number(/詳細情報|基本情報|_std\.html/.test(a.text + " " + a.url)),
      );
      queue.unshift(...same.map((l) => l.url));
      queue.push(...other.map((l) => l.url));
      if (!detailLinks.length && source.discoveryPattern)
        queue.push(
          ...page.links
            .filter((l) => new RegExp(source.discoveryPattern!).test(l.url))
            .slice(0, 2)
            .map((l) => l.url),
        );
    }
    if (
      new Set(
        audit.details
          .filter((d) => d.status === "verified")
          .map((d) => d.entityId),
      ).size >= audit.minDetails
    )
      audit.status = "verified";
  } catch (e) {
    audit.error = e instanceof Error ? e.message : String(e);
    audit.status = "failed";
  } finally {
    await browser.close().catch(() => {});
    await writeFile(
      join(dir, "audit.json"),
      JSON.stringify(audit, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  return audit;
}
export async function verifySources(
  options: {
    ids?: string[];
    family?: string;
    parallel?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (s: string) => void;
  } = {},
  store = new TrustedStore(),
): Promise<SourceAudit[]> {
  const catalog = await sourceCatalog(),
    selected = catalog.filter(
      (s) =>
        (!options.ids?.length || options.ids.includes(s.id)) &&
        (!options.family || s.family.startsWith(options.family)),
    );
  if (
    !selected.length ||
    options.ids?.some((id) => !selected.some((s) => s.id === id))
  )
    throw new Error("不明なsource IDまたはfamilyです");
  const parallel = options.parallel ?? 2;
  if (![1, 2].includes(parallel)) throw new Error("検証並列数は1または2です");
  const queue = [...selected],
    audits: SourceAudit[] = [];
  // Serialize registry writes across workers; network reads remain parallel.
  let writes = Promise.resolve();
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (;;) {
        const source = queue.shift();
        if (!source) return;
        const audit = await auditSource(source, options);
        audits.push(audit);
        writes = writes.then(async () => {
          await store.record(audit);
        });
        await writes;
      }
    }),
  );
  return selected.map((s) => audits.find((a) => a.sourceId === s.id)!);
}
