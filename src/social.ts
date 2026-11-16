import { Type, type Static } from "@sinclair/typebox";
import { publicFetch } from "./public-fetch.js";
import { readPublicHtml } from "./html-reader.js";
import { checkResearchNavigation } from "./runtime-profile.js";
import { allowedHosts } from "./sources.js";
import type { Task } from "./types.js";
const short = Type.String({ minLength: 1, maxLength: 200 });
const count = Type.Union([
  Type.Null(),
  Type.Integer({ minimum: 0, maximum: 1e12 }),
]);
export const socialSignalSchema = Type.Object(
  {
    id: short,
    pageId: short,
    url: Type.String({ maxLength: 2048 }),
    provider: Type.Literal("bluesky"),
    publishedAt: short,
    observedAt: short,
    metrics: Type.Object(
      { likes: count, reposts: count, replies: count },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type SocialSignal = Static<typeof socialSignalSchema>;
export const socialAttemptSchema = Type.Object(
  {
    url: Type.String({ maxLength: 2048 }),
    checkedAt: short,
    status: Type.Union([Type.Literal("captured"), Type.Literal("unavailable")]),
    reason: Type.String({ maxLength: 250 }),
  },
  { additionalProperties: false },
);
export type SocialAttempt = Static<typeof socialAttemptSchema>;

/** Only public, fixed provider endpoints; no authentication, search bypass or proxy rotation. */
export async function captureSocial(
  task: Task,
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = publicFetch,
) {
  if (task.evaluation?.mode === "frozen-replay")
    throw Error("凍結評価ではSNSの新規取得はできません");
  const hosts = allowedHosts(task.sources),
    target = checkResearchNavigation(url, hosts),
    u = new URL(target);
  if (!(task.socialResearch?.length ?? 0) && !task.socialSignals)
    task.socialSignals = [];
  if ((task.socialResearch?.length ?? 0) >= 6)
    throw Error("SNS確認は1タスク6件までです");
  if (
    !["bsky.app", "x.com", "www.instagram.com", "www.youtube.com"].includes(
      u.hostname,
    )
  )
    throw Error("対応する公開SNSのURLが必要です");
  const observedAt = new Date().toISOString();
  const fail = (reason: string) => {
    const attempt: SocialAttempt = {
      url: target,
      checkedAt: observedAt,
      status: "unavailable",
      reason,
    };
    (task.socialResearch ??= []).push(attempt);
    return {
      attempt,
      instruction:
        "SNS人気・反応数は未確認。拒否を回避せず、許可された公式告知と独自の楽しみ方を区別して提案する。",
    };
  };
  if (u.hostname === "bsky.app" && task.pages.length >= task.limits.maxPages)
    return fail("保存ページ上限のためSNSを追加取得できません");
  const get = async (endpoint: string) => {
    checkResearchNavigation(endpoint, hosts);
    const response = await fetcher(endpoint, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      headers: {
        Accept: "application/json",
        "User-Agent": "web-harness-runtime/0.3 (public social evidence)",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`SNS API HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("json")) {
      await response.body?.cancel();
      throw Error("SNS APIのJSONを確認できません");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("SNSの応答本文がありません");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256000) throw Error("SNS応答が上限を超えました");
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  };
  try {
    if (u.hostname !== "bsky.app") {
      // A publisher HTML page is not a verified reaction-count API. Never infer counts from snippets.
      const page = await readPublicHtml(target, hosts, signal, { fetcher });
      return fail(
        `公開HTMLの取得状態: ${page.acquisition?.status ?? "不明"}。公開投稿の日時と反応数を検証できませんでした`,
      );
    }
    const match = u.pathname.match(
      /^\/profile\/([a-zA-Z0-9.:%_-]+)\/post\/([a-zA-Z0-9]+)\/?$/,
    );
    if (!match)
      return fail(
        "Blueskyは個別の公開投稿URLが必要です。検索APIの拒否を迂回しません",
      );
    const actor = decodeURIComponent(match[1]!);
    let did = actor;
    if (!actor.startsWith("did:plc:") && !actor.startsWith("did:web:")) {
      const resolved = await get(
        "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?" +
          new URLSearchParams({ handle: actor }),
      );
      did = resolved.did;
    }
    if (
      typeof did !== "string" ||
      !/^did:(?:plc|web):[a-zA-Z0-9.:%_-]+$/.test(did)
    )
      throw Error("投稿者の公開IDを確認できません");
    const uri = `at://${did}/app.bsky.feed.post/${match[2]}`;
    const apiUrl =
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?" +
      new URLSearchParams({ uris: uri });
    const data = await get(apiUrl),
      post = data.posts?.find((p: any) => p.uri === uri);
    const publishedAt = post?.record?.createdAt;
    if (
      !post ||
      typeof post.record?.text !== "string" ||
      typeof publishedAt !== "string" ||
      publishedAt.length > 80 ||
      !Number.isFinite(Date.parse(publishedAt)) ||
      Date.parse(publishedAt) > Date.now() + 300000
    )
      throw Error("公開投稿の本文・日時を確認できません");
    const metric = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e12
        ? v
        : null;
    const metrics = {
      likes: metric(post.likeCount),
      reposts: metric(post.repostCount),
      replies: metric(post.replyCount),
    };
    let index = (task.socialSignals?.length ?? 0) + 1;
    while (
      task.pages.some((p) => p.id === "social-page-" + index) ||
      task.socialSignals?.some((s) => s.id === "social-" + index)
    )
      index++;
    const id = "social-" + index,
      pageId = "social-page-" + index;
    const entry: SocialSignal = {
      id,
      pageId,
      url: target,
      provider: "bluesky",
      publishedAt,
      observedAt,
      metrics,
    };
    const text = JSON.stringify({
      signal: entry,
      apiUrl,
      text: post.record.text.slice(0, 1000),
      authorHandle: post.author?.handle,
      interpretation:
        "単一投稿の取得時点の反応。世間全体の人気・成長率・品質ではない",
    });
    task.pages.push({
      id: pageId,
      url: target,
      title: "Bluesky公開投稿の取得記録",
      text,
      capturedAt: observedAt,
      links: [],
      truncated: post.record.text.length > 1000,
      acquisition: {
        kind: "public-json",
        status: 200,
        contentType: "application/json",
      },
    });
    (task.socialSignals ??= []).push(entry);
    const attempt: SocialAttempt = {
      url: target,
      checkedAt: observedAt,
      status: "captured",
      reason: "公開APIで投稿と取得時点の反応数を確認",
    };
    (task.socialResearch ??= []).push(attempt);
    return {
      attempt,
      signal: entry,
      page: task.pages.at(-1),
      instruction:
        "関係する相談・施設の投稿だけを参照する。反応数は単一投稿のスナップショット。時系列の急増やSNS全体の人気とは呼ばない。引用をrecord_evidenceで保存して使う。",
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return fail(
      error instanceof Error
        ? error.message.slice(0, 220)
        : "SNS情報を取得できませんでした",
    );
  }
}
export function verifySocialSignal(task: Task, entry: SocialSignal) {
  const page = task.pages.find((p) => p.id === entry.pageId);
  try {
    if (
      !Number.isFinite(Date.parse(entry.observedAt)) ||
      !Number.isFinite(Date.parse(entry.publishedAt)) ||
      Date.parse(entry.publishedAt) > Date.parse(entry.observedAt) + 300000
    )
      throw Error();
    if (new URL(entry.url).hostname !== "bsky.app") throw Error();
    if (
      !page ||
      page.url !== entry.url ||
      page.capturedAt !== entry.observedAt ||
      JSON.stringify(JSON.parse(page.text).signal) !== JSON.stringify(entry)
    )
      throw Error();
  } catch {
    throw Error("SNS反応数と取得記録が一致しません");
  }
}
