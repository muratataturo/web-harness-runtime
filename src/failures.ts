export interface RuntimeFailure {
  kind:
    | "quota_exhausted"
    | "authentication"
    | "rate_limited"
    | "model_unavailable"
    | "unknown";
  retryable: boolean;
  action: string;
}
export function classifyRuntimeFailure(message: string): RuntimeFailure {
  if (
    /free-models-per-day|per.day|daily|日次|quota.*exceed|limit_remaining.{0,5}0/i.test(
      message,
    )
  )
    return {
      kind: "quota_exhausted",
      retryable: false,
      action:
        "無料利用枠の回復を待って再実行してください。有料モデルには切り替えません。",
    };
  if (/\b(401|402|403)\b|invalid.api.key|unauthorized/i.test(message))
    return {
      kind: "authentication",
      retryable: false,
      action: "OpenRouterのキー・アカウント制限を確認してください。",
    };
  if (/\b429\b|rate.limit/i.test(message))
    return {
      kind: "rate_limited",
      retryable: true,
      action: "時間を置いて再実行してください。",
    };
  if (/\b(404|503)\b|no endpoints|unavailable/i.test(message))
    return {
      kind: "model_unavailable",
      retryable: true,
      action: "models一覧の別の無料モデルを指定して再実行してください。",
    };
  return {
    kind: "unknown",
    retryable: false,
    action: "タスク履歴とエラーを確認してください。",
  };
}
