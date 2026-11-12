export interface FreeQuota {
  checkedAt: string;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  resetsAtJapan: string;
  resetBasis: "next-utc-day";
}
/** Free request counters use the UTC day, independently of dollar-denominated key budgets. */
export function parseFreeQuota(
  data: unknown,
  serverDate: string | null = null,
): FreeQuota {
  const quota = (data as any)?.data?.free_model_daily_requests;
  if (
    !quota ||
    ![quota.used, quota.limit, quota.remaining].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error(
      "APIが無料リクエスト残量を返しませんでした。残量は不明です",
    );
  const time = serverDate ? new Date(serverDate) : new Date();
  if (Number.isNaN(time.getTime())) throw new Error("API応答の時刻が不正です");
  const reset = new Date(
    Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate() + 1),
  );
  return {
    checkedAt: time.toISOString(),
    used: quota.used,
    limit: quota.limit,
    remaining: quota.remaining,
    resetsAt: reset.toISOString(),
    resetsAtJapan: new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(reset),
    resetBasis: "next-utc-day",
  };
}
export async function freeQuota(signal?: AbortSignal): Promise<FreeQuota> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error(".envにOPENROUTER_API_KEYを設定してください");
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok)
    throw new Error(`OpenRouterキー情報の取得失敗 HTTP ${response.status}`);
  return parseFreeQuota(await response.json(), response.headers.get("date"));
}
