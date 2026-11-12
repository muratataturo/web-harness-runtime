import type { PageArtifact } from "./artifacts.js";
export type ProgressStage = "prepare" | "plan" | "read" | "verify" | "answer";
export interface ResearchProgress {
  seq: number;
  at: string;
  stage: ProgressStage;
  title: string;
  status: "active" | "done" | "error";
  url?: string;
  artifact?: PageArtifact;
  pages: number;
  evidence: number;
  step?: number;
}
export const progressPrefix = "@harness-progress ";
export function researchProgress(
  name: string,
  status: ResearchProgress["status"],
  data: {
    url?: string;
    artifact?: PageArtifact;
    pages: number;
    evidence: number;
    step?: number;
  },
): Omit<ResearchProgress, "seq"> {
  const stage: ProgressStage = /finish/.test(name)
    ? "answer"
    : /record|evidence|deepen_details/.test(name)
      ? "verify"
      : /open|deepen_page|prefetch/.test(name)
        ? "read"
        : /plan|model/.test(name)
          ? "plan"
          : "prepare";
  const titles: Record<ProgressStage, string> = {
    prepare: "実行環境を準備",
    plan: "調べる条件を整理",
    read: "公開ページを取得",
    verify: "引用と条件を照合",
    answer: "回答をまとめる",
  };
  return {
    at: new Date().toISOString(),
    stage,
    title: titles[stage],
    status,
    ...data,
  };
}
function httpsUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4000) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === "https:" && !u.username && !u.password) return u.href;
  } catch {
    /* malformed URL */
  }
}
const isId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-zA-Z0-9-]{1,180}$/.test(id);
function decodeArtifact(a: any, url?: string): PageArtifact | undefined {
  if (
    !a ||
    !url ||
    httpsUrl(a.url) !== url ||
    !isId(a.id) ||
    !isId(a.taskId) ||
    !a.id.startsWith(a.taskId + "-") ||
    typeof a.title !== "string" ||
    typeof a.preview !== "string" ||
    typeof a.method !== "string" ||
    typeof a.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(a.capturedAt)) ||
    !["captured", "unavailable"].includes(a.state)
  )
    return;
  return {
    id: a.id,
    taskId: a.taskId,
    pageId: isId(a.pageId) ? a.pageId : undefined,
    url,
    title: a.title.slice(0, 300),
    preview: a.preview.slice(0, 420),
    capturedAt: a.capturedAt.slice(0, 40),
    method: a.method.slice(0, 50),
    statusCode:
      Number.isInteger(a.statusCode) &&
      a.statusCode >= 100 &&
      a.statusCode <= 599
        ? a.statusCode
        : undefined,
    state: a.state,
  };
}
/** Child stderr is a byte stream: buffer split markers, ignore stdout answer JSON, never parse prose as events. */
export class ProgressDecoder {
  private buffer = "";
  constructor(private emit: (event: Omit<ResearchProgress, "seq">) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop()!.slice(-16000);
    for (const line of lines) {
      const at = line.indexOf(progressPrefix);
      if (at < 0) continue;
      try {
        const e = JSON.parse(line.slice(at + progressPrefix.length));
        if (
          !["prepare", "plan", "read", "verify", "answer"].includes(e.stage) ||
          !["active", "done", "error"].includes(e.status) ||
          typeof e.title !== "string" ||
          e.title.length > 100 ||
          !Number.isSafeInteger(e.pages) ||
          e.pages < 0 ||
          !Number.isSafeInteger(e.evidence) ||
          e.evidence < 0
        )
          continue;
        const url = httpsUrl(e.url);
        this.emit({
          at:
            typeof e.at === "string" && Number.isFinite(Date.parse(e.at))
              ? e.at.slice(0, 40)
              : new Date().toISOString(),
          stage: e.stage,
          status: e.status,
          title: e.title,
          url,
          artifact: decodeArtifact(e.artifact, url),
          pages: e.pages,
          evidence: e.evidence,
          step: Number.isSafeInteger(e.step) ? e.step : undefined,
        });
      } catch {
        /* Incomplete or malformed diagnostics never become user-facing events. */
      }
    }
  }
}
