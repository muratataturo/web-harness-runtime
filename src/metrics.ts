export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number | null;
  totalTokens: number;
  cacheWriteInputTokens: number;
  source: "codex-thread-total" | "pi-session-total" | "opencode-step-total";
}
export function opencodeUsage(raw: any): TokenUsage | undefined {
  const values = [
    raw?.input,
    raw?.output,
    raw?.reasoning,
    raw?.total,
    raw?.cache?.read,
    raw?.cache?.write,
  ];
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0)) return;
  const input = raw.input + raw.cache.read + raw.cache.write;
  const output =
    input + raw.output === raw.total ? raw.output : raw.output + raw.reasoning;
  if (input + output !== raw.total) return;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: raw.cache.read,
    cacheWriteInputTokens: raw.cache.write,
    reasoningOutputTokens: raw.reasoning,
    totalTokens: raw.total,
    source: "opencode-step-total",
  };
}
export function piUsage(value: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}): TokenUsage | undefined {
  if (
    Object.values(value).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    value.total <= 0
  )
    return;
  const input = value.input + value.cacheRead + value.cacheWrite;
  if (input + value.output !== value.total) return;
  return {
    inputTokens: input,
    outputTokens: value.output,
    cachedInputTokens: value.cacheRead,
    cacheWriteInputTokens: value.cacheWrite,
    reasoningOutputTokens: null,
    totalTokens: value.total,
    source: "pi-session-total",
  };
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
