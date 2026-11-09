export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";
export interface Criterion {
  id: string;
  description: string;
  weight: number;
  required: boolean;
}
export interface Source {
  id: string;
  kind: string;
  url: string;
  score: number;
  reason: string;
  guidance: string;
}
export interface Page {
  acquisition?: {
    kind: "browser-dom" | "public-html";
    status?: number;
    charset?: string;
    contentType?: string;
  };
  id: string;
  url: string;
  title: string;
  text: string;
  links: { text: string; url: string }[];
  capturedAt: string;
  truncated: boolean;
}
export interface Evidence {
  id: string;
  pageId: string;
  url: string;
  quote: string;
  capturedAt: string;
}
export interface Match {
  criterionId: string;
  status: "supported" | "unknown" | "contradicted";
  explanation: string;
  evidenceIds: string[];
}
export interface Candidate {
  name: string;
  url: string;
  matches: Match[];
  score: number;
  eligible: boolean;
}
export interface Answer {
  summary: string;
  candidates: Candidate[];
  limitations: string[];
}
export interface Task {
  id: string;
  parentId?: string;
  goalId?: string;
  query: string;
  urls: string[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  model?: string;
  sources: Source[];
  failure?: import("./failures.js").RuntimeFailure;
  criteria: Criterion[];
  pages: Page[];
  evidence: Evidence[];
  answer?: Answer;
  error?: string;
  limits: { maxSteps: number; timeoutSeconds: number; maxPages: number };
  steps: number;
}
