import { test } from "node:test";
import assert from "node:assert/strict";
import { newTask } from "../src/runtime.js";
import { captureSocial } from "../src/social.js";
import { validateDiscoveries, type Discovery } from "../src/discovery.js";
import { addEvidence } from "../src/evidence.js";
import { createResearchProfile } from "../src/runtime-profile.js";
import { allowedHosts } from "../src/sources.js";
import { renderDiscoveries } from "../src/discovery-html.js";
const venue = "https://www.sumida-aquarium.com/about/access/";
const postUrl = "https://bsky.app/profile/did:plc:abc/post/3abc123";
const input = () =>
  newTask({
    query: "SNSのトレンドを検討する日帰りの提案",
    urls: [venue],
    maxSteps: 30,
    maxPages: 10,
    timeoutSeconds: 60,
  });
const idea = (basis: Discovery["basis"] = "original-idea"): Discovery => ({
  anchorId: "aquarium",
  headline: "水中の違いを見つける",
  idea: "同じ水槽で違う動きを一つずつ探して話す。",
  whyNow: "見方を変えて楽しむ独自の提案です。",
  fit: "既存の見学時間内で実施。追加購入を前提にしない。",
  fallback: "疲れたら元の休憩案へ。",
  basis,
  evidenceIds: [],
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function captured() {
  const t = input();
  const result = await captureSocial(
    t,
    postUrl,
    new AbortController().signal,
    async () =>
      response({
        posts: [
          {
            uri: "at://did:plc:abc/app.bsky.feed.post/3abc123",
            record: {
              text: "すみだ水族館の水景を眺めた。",
              createdAt: t.createdAt,
            },
            author: { handle: "example.bsky.social" },
            likeCount: 12,
            repostCount: 2,
            replyCount: 0,
          },
        ],
      }),
  );
  if (!("signal" in result) || !result.signal) throw Error("fixture capture");
  addEvidence(t, result.signal.pageId, t.pages.at(-1)!.text.slice(0, 1100));
  return t;
}
test("SNS intent extends the trusted policy coherently and ordinary research keeps its boundary", () => {
  const t = input(),
    profile = createResearchProfile(t.urls, undefined, t.query);
  assert.deepEqual([...profile.hosts].sort(), allowedHosts(t.sources).sort());
  assert.ok(profile.hosts.includes("public.api.bsky.app"));
  assert.equal(createResearchProfile([venue]).hosts.includes("x.com"), false);
  const excluded = newTask({
    query: "SNSは使わずユニークな日帰りを提案",
    urls: [venue],
    maxSteps: 20,
    maxPages: 5,
    timeoutSeconds: 30,
  });
  assert.equal(allowedHosts(excluded.sources).includes("x.com"), false);
});
test("public social API snapshots preserve zero, reject tampered counts and cannot imply a trend", async () => {
  const t = await captured(),
    s = t.socialSignals![0]!;
  assert.equal(s.metrics.likes, 12);
  assert.equal(s.metrics.replies, 0);
  const d = {
    ...idea("social-snapshot"),
    signalId: s.id,
    evidenceIds: [t.evidence[0]!.id],
  };
  validateDiscoveries(t, [d], ["aquarium"]);
  assert.throws(
    () =>
      validateDiscoveries(
        t,
        [{ ...d, headline: "SNSで大人気、急上昇" }],
        ["aquarium"],
      ),
    /断定/,
  );
  s.metrics.likes = 9000;
  assert.throws(() => validateDiscoveries(t, [d], ["aquarium"]), /取得記録/);
});
test("denied social API requests stay unknown with one request and no fallback endpoint", async () => {
  const t = input();
  let calls = 0;
  const result = await captureSocial(
    t,
    postUrl,
    new AbortController().signal,
    async () => {
      calls++;
      return response({}, 403);
    },
  );
  assert.equal(result.attempt.status, "unavailable");
  assert.equal(calls, 1);
  assert.deepEqual(t.socialSignals, []);
  assert.ok(t.socialResearch![0]!.reason.includes("403"));
  await assert.rejects(
    captureSocial(
      t,
      "https://attacker.example/post",
      new AbortController().signal,
    ),
    /許可対象外/,
  );
  const d = { ...idea("social-snapshot"), signalId: "made-up" };
  assert.throws(() => validateDiscoveries(t, [d], ["aquarium"]), /signalId/);
});
test("missing reaction metrics stay null and old observations cannot become current popularity", async () => {
  const t = input();
  await captureSocial(t, postUrl, new AbortController().signal, async () =>
    response({
      posts: [
        {
          uri: "at://did:plc:abc/app.bsky.feed.post/3abc123",
          record: { text: "公開投稿", createdAt: t.createdAt },
        },
      ],
    }),
  );
  assert.deepEqual(t.socialSignals![0]!.metrics, {
    likes: null,
    reposts: null,
    replies: null,
  });
  addEvidence(t, t.pages[0]!.id, t.pages[0]!.text.slice(0, 1100));
  assert.throws(
    () =>
      validateDiscoveries(
        t,
        [
          {
            ...idea("social-snapshot"),
            signalId: "social-1",
            evidenceIds: [t.evidence[0]!.id],
          },
        ],
        ["aquarium"],
      ),
    /数値/,
  );
  const badDate = await captureSocial(
    input(),
    postUrl,
    new AbortController().signal,
    async () =>
      response({
        posts: [
          {
            uri: "at://did:plc:abc/app.bsky.feed.post/3abc123",
            record: { text: "投稿", createdAt: 1234 },
          },
        ],
      }),
  );
  assert.equal(badDate.attempt.status, "unavailable");
  const older = await captured();
  older.createdAt = new Date(
    Date.parse(older.createdAt) + 31 * 86400000,
  ).toISOString();
  assert.throws(
    () =>
      validateDiscoveries(
        older,
        [
          {
            ...idea("social-snapshot"),
            signalId: "social-1",
            evidenceIds: [older.evidence[0]!.id],
          },
        ],
        ["aquarium"],
      ),
    /古い/,
  );
});
test("seasonal ideas require actual official dates, match the target day and keep an independent fallback", () => {
  const t = input();
  t.createdAt = "2026-11-16T01:00:00Z";
  t.pages.push({
    id: "event",
    url: "https://www.sumida-aquarium.com/news/event/",
    title: "公式企画",
    text: "【開催期間】2026年10月1日（木）～11月16日（月）\n6階特設スペースに参加型クイズ。",
    capturedAt: t.createdAt,
    links: [],
    truncated: false,
  });
  addEvidence(t, "event", t.pages[0]!.text);
  const d = {
    ...idea("official-event"),
    evidenceIds: [t.evidence[0]!.id],
    validFrom: "2026-10-01",
    validTo: "2026-11-16",
  };
  validateDiscoveries(t, [d], ["aquarium"]);
  assert.throws(
    () =>
      validateDiscoveries(t, [{ ...d, validTo: "2026-11-30" }], ["aquarium"]),
    /両日付/,
  );
  t.query = "2026年11月17日 SNS 日帰り";
  assert.throws(() => validateDiscoveries(t, [d], ["aquarium"]), /対象日/);
  t.query = "2026年11月16日 SNS 日帰り";
  t.pages[0]!.url = "https://blog.example/post";
  t.evidence[0]!.url = t.pages[0]!.url;
  assert.throws(() => validateDiscoveries(t, [d], ["aquarium"]), /公式施設/);
});
test("discovery HTML labels unavailable popularity, escapes suggestions and exposes no invented counts", async () => {
  const t = await captured();
  const d = { ...idea(), headline: "<img onerror=alert(1)>" };
  t.socialResearch = [
    {
      url: "https://x.com/venue",
      checkedAt: t.createdAt,
      status: "unavailable",
      reason: "公開情報を確認できない",
    },
  ];
  t.answer = {
    summary: "提案",
    candidates: [],
    limitations: [],
    visualArtifact: {
      kind: "life-roadmap",
      title: "計画",
      description: "提案",
      lanes: [],
      milestones: [],
      discoveries: [d],
    },
  };
  const html = renderDiscoveries(t, () => "");
  assert.match(html, /&lt;img/);
  assert.match(html, /検証できない/);
  assert.equal(html.includes("いいね"), false);
});

test("social capture honors the page budget before issuing a provider request", async () => {
  const t = input();
  t.limits.maxPages = 1;
  t.pages.push({
    id: "existing",
    url: venue,
    title: "既存",
    text: "取得済みのページ",
    capturedAt: t.createdAt,
    links: [],
    truncated: false,
  });
  let calls = 0;
  const result = await captureSocial(
    t,
    postUrl,
    new AbortController().signal,
    async () => {
      calls++;
      throw Error("must not fetch");
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.attempt.status, "unavailable");
  assert.match(result.attempt.reason, /上限/);
});

test("the improvement gate requires social research and a distinct proposal, while unavailable metrics remain honest", async () => {
  const { readFile } = await import("node:fs/promises");
  const { assessVisualArtifact } = await import("../src/visual-artifact.js");
  const t = JSON.parse(
    await readFile("examples/visual-life-actual-answer.json", "utf8"),
  );
  t.query += " SNSとトレンドも加味したユニークな提案を追加";
  const missing = assessVisualArtifact(t, t.answer);
  assert.ok(missing.issues.some((s) => s.includes("read_social")));
  assert.ok(missing.issues.some((s) => s.includes("discoveries")));
  t.socialResearch = [
    {
      url: "https://x.com/example",
      checkedAt: t.createdAt,
      status: "unavailable",
      reason: "公開反応を検証できない",
    },
  ];
  t.answer.visualArtifact.discoveries = [
    { ...idea(), anchorId: t.answer.visualArtifact.milestones[0].id },
  ];
  assert.equal(assessVisualArtifact(t, t.answer).status, "passed");
});
