import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rmdir,
  stat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { publicFetch } from "./public-fetch.js";
import { checkResearchNavigation } from "./runtime-profile.js";
import type { Page } from "./types.js";
/** Opt-in geographic source. One cached exact-place lookup, never autocomplete/bulk. */
export async function locatePlace(
  query: string,
  hosts: string[],
  root: string,
  signal: AbortSignal,
  deps: { fetcher?: typeof fetch } = {},
): Promise<Omit<Page, "id">> {
  if (!query.trim() || query.length > 180 || /[\x00-\x1f]/.test(query))
    throw Error("公開地点名と地域を180文字以内で指定してください");
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({ q: query, format: "jsonv2", limit: "3" });
  checkResearchNavigation(url, hosts);
  const cache = join(root, "geocode-cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const file = join(
    cache,
    createHash("sha256").update(url).digest("hex") + ".json",
  );
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (Date.now() - Date.parse(saved.capturedAt) < 7 * 86400000) return saved;
  } catch (e: any) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  const lock = join(cache, "request.lock");
  try {
    await mkdir(lock);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs > 60000) await rm(lock, { recursive: true });
    throw Error("地理検索は1件ずつ実行してください。現在別の検索が実行中です");
  }
  try {
    const last = Number(
      await readFile(join(cache, "last-request"), "utf8").catch(() => 0),
    );
    await delay(Math.max(0, 1100 - (Date.now() - last)), undefined, { signal });
    await writeFile(join(cache, "last-request"), String(Date.now()), {
      mode: 0o600,
    });
    const response = await (deps.fetcher ?? publicFetch)(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      headers: {
        Accept: "application/json",
        "User-Agent":
          "web-harness-runtime/0.3 (local interactive place research)",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        `地理検索HTTP ${response.status}。拒否時に再試行して回避しません`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("地理データ本文がありません");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32000) throw Error("地理データが取得上限を超えました");
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const raw = Buffer.concat(parts).toString("utf8"),
      parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 3)
      throw Error("地理データの形式が不正です");
    for (const p of parsed)
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon)))
        throw Error("座標が不正です");
    const page: Omit<Page, "id"> = {
      url,
      title: query + " — OpenStreetMap地理検索（施設代表点・入口未確認）",
      text: raw,
      links: [],
      capturedAt: new Date().toISOString(),
      truncated: false,
      acquisition: {
        kind: "public-json",
        status: response.status,
        contentType: "application/json",
      },
    };
    const temp = file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(page), { mode: 0o600 });
    await rename(temp, file);
    return page;
  } finally {
    await rmdir(lock);
  }
}
