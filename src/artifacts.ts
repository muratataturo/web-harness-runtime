import { assessPage } from "./page-quality.js";
import type { Page, Task } from "./types.js";
export interface PageArtifact {
  id: string;
  taskId: string;
  pageId?: string;
  url: string;
  title: string;
  preview: string;
  capturedAt: string;
  method: string;
  statusCode?: number;
  state: "captured" | "unavailable";
}
export function pageArtifact(
  t: Pick<Task, "id" | "createdAt" | "evidence">,
  p: Partial<Page> & { url: string },
  index = 0,
): PageArtifact {
  const quality = assessPage({
    title: p.title ?? "",
    text: p.text ?? "",
    acquisition: p.acquisition,
  });
  const quotes = t.evidence
    .filter((e) => e.url === p.url)
    .map((e) => e.quote)
    .join("\n");
  return {
    id: `${t.id}-${p.id ?? "page-" + (index + 1)}`,
    taskId: t.id,
    pageId: p.id,
    url: p.url,
    title: p.title ?? new URL(p.url).hostname,
    preview: (
      p.text ||
      quotes ||
      "本文抜粋はこの記録に含まれていません。"
    ).slice(0, 420),
    capturedAt: p.capturedAt ?? t.createdAt,
    method: p.acquisition?.kind ?? "recorded",
    statusCode: p.acquisition?.status,
    state:
      quality.shouldStop && p.text
        ? "unavailable"
        : p.acquisition?.status && p.acquisition.status >= 400
          ? "unavailable"
          : "captured",
  };
}
