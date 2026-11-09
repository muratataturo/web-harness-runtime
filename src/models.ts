export interface CatalogModel {
  id: string;
  name: string;
  context_length: number;
  pricing: Record<string, string>;
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
}
export async function freeModels(): Promise<CatalogModel[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`OpenRouter models HTTP ${response.status}`);
  const body = (await response.json()) as { data: CatalogModel[] };
  return body.data
    .filter(isFreeToolModel)
    .sort(
      (a, b) =>
        preference(b) - preference(a) || b.context_length - a.context_length,
    );
}
export function isFreeToolModel(m: CatalogModel): boolean {
  return (
    (m.id.endsWith(":free") || m.id === "openrouter/free") &&
    m.pricing.prompt !== undefined &&
    m.pricing.completion !== undefined &&
    Object.values(m.pricing).every((v) => Number(v) === 0) &&
    !!m.supported_parameters?.includes("tools") &&
    m.context_length >= 16000
  );
}
function preference(m: CatalogModel) {
  if (/nemotron-3-super/.test(m.id)) return 100;
  if (/qwen3.*coder/.test(m.id)) return 90;
  if (/qwen3.*235b|gpt-oss-120b/.test(m.id)) return 80;
  if (/nemotron/.test(m.id)) return 70;
  if (m.id === "openrouter/free") return -1;
  return 0;
}
export async function selectModel(requested?: string): Promise<CatalogModel> {
  const available = await freeModels();
  const model = requested
    ? available.find((m) => m.id === requested)
    : available[0];
  if (!model)
    throw new Error(
      requested
        ? `無料・ツール対応の現行モデルとして確認できません: ${requested}`
        : "無料・ツール対応モデルが見つかりません",
    );
  return model;
}

export function providerFailureKind(
  error: unknown,
): "daily_limit" | "rate_limit" | "auth" | "unavailable" | "other" {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /free-models-per-day|openrouter_free_tier_daily|daily.*limit/i.test(message)
  )
    return "daily_limit";
  if (/\b429\b|rate.limit/i.test(message)) return "rate_limit";
  if (/\b401\b|\b403\b|invalid.*api.?key/i.test(message)) return "auth";
  if (/\b404\b|\b502\b|\b503\b|no endpoints/i.test(message))
    return "unavailable";
  return "other";
}
