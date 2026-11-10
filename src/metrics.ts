export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheWriteInputTokens: number;
  source: "codex-thread-total";
}
/** Provider cumulative totals: replace observations; never add cached/reasoning subsets twice. */
export function codexUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  const keys = [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const;
  if (keys.some((k) => !Number.isSafeInteger(raw[k]) || (raw[k] as number) < 0))
    return;
  const cacheWrite = raw.cacheWriteInputTokens ?? 0;
  if (!Number.isSafeInteger(cacheWrite) || (cacheWrite as number) < 0) return;
  return {
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    cachedInputTokens: raw.cachedInputTokens as number,
    reasoningOutputTokens: raw.reasoningOutputTokens as number,
    totalTokens: raw.totalTokens as number,
    cacheWriteInputTokens: cacheWrite as number,
    source: "codex-thread-total",
  };
}
