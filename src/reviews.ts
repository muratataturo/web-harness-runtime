import { entityKey } from "./sources.js";
import { verifyDetail } from "./detail-contracts.js";
import type { Page, Task } from "./types.js";
export interface ReviewSignal {
  candidateEntity: string;
  url: string;
  provider: "hotpepper-beauty" | "rakuten-travel";
  average: number;
  scale: { min: 1; max: 5 };
  displayedCount: number;
  countPeriodConfirmed: false;
  meanWindowPolicy: string;
  policyUrl: string;
  policyCheckedAt: string;
  quote: string;
  capturedAt: string;
  interpretation: "service-review-proxy-not-answer-satisfaction";
}
export function extractReviewSignal(page: Page): ReviewSignal | undefined {
  const detail = verifyDetail(page);
  if (detail.status !== "verified" || !detail.entityId) return;
  const provider = detail.service;
  if (provider !== "hotpepper-beauty" && provider !== "rakuten-travel") return;
  const boundary = page.text.indexOf(
    provider === "hotpepper-beauty" ? "サロン情報" : "施設紹介",
  );
  const header = page.text.slice(
    0,
    boundary >= 0 ? Math.min(boundary, 2500) : 2500,
  );
  const pattern =
    provider === "hotpepper-beauty"
      ? /(?<![\d.])([1-5]\.\d{1,2})\s*[（(]([\d,]+)件[）)]\s*口コミ・平均点について/
      : /(?<![\d.])([1-5]\.\d{1,2})\s*[（(]([\d,]+)件[）)]/;
  const m = pattern.exec(header);
  if (!m) return;
  if (!/^\d+(?:,\d{3})*$/.test(m[2]!)) return;
  const average = Number(m[1]),
    displayedCount = Number(m[2]!.replaceAll(",", ""));
  if (
    average < 1 ||
    average > 5 ||
    !Number.isSafeInteger(displayedCount) ||
    displayedCount < 1
  )
    return;
  return {
    candidateEntity: entityKey(page.url)!,
    url: page.url,
    provider,
    average,
    scale: { min: 1, max: 5 },
    displayedCount,
    countPeriodConfirmed: false,
    meanWindowPolicy:
      provider === "hotpepper-beauty"
        ? "直近1年の総合評価の単純平均"
        : "過去1年。投稿がない場合は過去2年の総合スコア",
    policyUrl:
      provider === "hotpepper-beauty"
        ? "https://beauty.hotpepper.jp/doc/review_guide/review_average_point.html"
        : "https://travel.faq.rakuten.net/detail/000004323",
    policyCheckedAt: "2026-11-10",
    quote: m[0],
    capturedAt: page.capturedAt,
    interpretation: "service-review-proxy-not-answer-satisfaction",
  };
}
export function taskReviewSignals(task: Task) {
  const candidates = new Set(
    task.answer?.candidates.map((c) => entityKey(c.url)) ?? [],
  );
  const signals = task.pages
    .map(extractReviewSignal)
    .filter(
      (r): r is ReviewSignal =>
        !!r && (!task.answer || candidates.has(r.candidateEntity)),
    );
  const groups = new Map<string, ReviewSignal[]>();
  for (const r of signals) {
    const group = groups.get(r.candidateEntity) ?? [];
    group.push(r);
    groups.set(r.candidateEntity, group);
  }
  return [...groups.values()].map((group) => ({
    latest: [...group].sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt),
    )[0]!,
    conflictingObservations:
      new Set(group.map((r) => r.average + ":" + r.displayedCount)).size > 1,
    observations: group.length,
  }));
}
