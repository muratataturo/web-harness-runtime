import { assessPage } from "./page-quality.js";
import type { Task } from "./types.js";
export const normalized = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, " ").trim();
export function assertEvidenceIntegrity(task: Task, id: string) {
  const evidence = task.evidence.find((e) => e.id === id);
  const page = task.pages.find((p) => p.id === evidence?.pageId);
  if (
    !evidence ||
    !page ||
    task.evidence.filter((e) => e.id === id).length !== 1 ||
    task.pages.filter((p) => p.id === evidence.pageId).length !== 1 ||
    page.url !== evidence.url ||
    page.capturedAt !== evidence.capturedAt ||
    assessPage(page).shouldStop ||
    normalized(evidence.quote).length < 6 ||
    evidence.quote.length > 1200 ||
    !normalized(page.text).includes(normalized(evidence.quote))
  )
    throw new Error(`根拠の本文・出典・取得日時・IDを検証できません: ${id}`);
  return evidence;
}
