import type { Task } from "../src/types.js";
export function markdown(text: string): string;
export function escapeHtml(value: unknown): string;
export function normalizeMarkdown(value: unknown): string;
export function safeLink(value: string): string | null;
export function presentation(record: { task?: Partial<Task> }): {
  raw: string;
  title: string;
  intro: string;
  sections: { title: string; lines: string[] }[];
  timeline: { stepIndex?: number; time: string; text: string }[];
};
