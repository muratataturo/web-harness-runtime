/** User intent first; a suggested window is never presented as a user-specified time. */
export function fullDayIntent(query: string) {
  return /朝から夜|午前中から夜|朝.{0,6}夜まで|丸一日|(?<![〇零一二三四五六七八九十百\d月])(?:一|1)日|日帰り|day trip|full[ -]day/i.test(
    query.normalize("NFKC"),
  );
}
export function tripBrief(query: string) {
  query = query.normalize("NFKC");
  if (
    !fullDayIntent(query) &&
    !/お出かけ|行程|旅程|旅行|遊ぶ|遊び|午後|半日|短時間|寄り道|afternoon|day out|itinerary/i.test(
      query,
    )
  )
    return undefined;
  const explicit = query.match(
    /([0-2]?\d[:：]\d{2})\s*[〜～~–-]\s*([0-2]?\d[:：]\d{2})/,
  );
  const afternoon = /午後(?:だけ|から|の|に)|半日|昼から|afternoon/i.test(
    query,
  );
  const short =
    /寄り道|短時間|[12１２]時間(?:だけ|程度|ほど)|さくっと|サクッと/i.test(
      query,
    );
  const full = fullDayIntent(query);
  const mode = explicit
    ? "custom"
    : afternoon && /午後だけ|半日|昼から|afternoon/i.test(query)
      ? "afternoon"
      : full
        ? "full-day"
        : afternoon
          ? "afternoon"
          : short
            ? "short"
            : "flexible";
  const range = explicit
    ? [explicit[1]!.replace("：", ":"), explicit[2]!.replace("：", ":")]
    : mode === "full-day"
      ? ["09:00", "20:00"]
      : mode === "afternoon"
        ? ["13:00", "17:00"]
        : mode === "short"
          ? ["14:00", "16:00"]
          : undefined;
  return {
    version: 1 as const,
    mode: mode as "custom" | "afternoon" | "short" | "full-day" | "flexible",
    timeRange: range,
    timeBasis: explicit ? ("user-specified" as const) : ("suggested" as const),
    pacing: /ゆっくり|のんびり|ちょっと|疲れ|気軽/.test(query)
      ? ("relaxed" as const)
      : /たくさん|満喫|アクティブ|充実/.test(query)
        ? ("active" as const)
        : ("balanced" as const),
    requiredMeals: mode === "full-day" ? ["lunch", "dinner"] : [],
    requiresStepResearch: ["full-day", "afternoon", "short"].includes(mode),
    assumptions:
      !explicit && range
        ? [
            `時刻の指定がないため${range[0]}〜${range[1]}を提案。出発地までの交通は別途。`,
          ]
        : [],
    policy:
      "明示時刻を優先。一日は午前の体験・昼食・午後の体験やカフェ・休憩・夕食・夜の帰路をつなぐ。午後だけや寄り道を一日へ膨らませない。移動で埋めず、体力と気分に合わせて訪問数を絞り、雨・満席・疲労の切替を用意する。",
  };
}
export function tripRhythmIssues(
  query: string,
  plan: {
    steps: {
      when: string;
      durationMinutes?: number;
      kind?: string;
      where: string;
      action: string;
    }[];
  },
) {
  const b = tripBrief(query);
  if (!b || !b.requiresStepResearch) return [];
  const clock = (s: string) => {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const end = (s: (typeof plan.steps)[number]) =>
    clock(s.when) + (s.durationMinutes ?? 0);
  const issues: string[] = [];
  const first = plan.steps[0],
    last = plan.steps.at(-1);
  if (!first || !last) return ["過ごし方に対応した行程がありません"];
  if (
    b.timeRange &&
    (clock(first.when) !== clock(b.timeRange[0]!) ||
      end(last) !== clock(b.timeRange[1]!))
  )
    issues.push(
      `提案した${b.timeRange.join("〜")}の開始から帰路までを構成してください。短い計画を一日と呼ばないでください`,
    );
  const meaningful = plan.steps.filter((s) =>
    ["activity", "cafe", "lunch", "dinner", "evening"].includes(s.kind ?? ""),
  );
  if (b.mode === "full-day") {
    if (
      !meaningful.some(
        (s) =>
          clock(s.when) < 12 * 60 &&
          end(s) > 9 * 60 &&
          (s.durationMinutes ?? 0) >= 30,
      )
    )
      issues.push("朝から夜の一日には午前の具体的な体験が必要です");
    for (const meal of b.requiredMeals)
      if (
        !plan.steps.some(
          (s) =>
            s.kind === meal &&
            (s.durationMinutes ?? 0) >= 30 &&
            clock(s.when) < (meal === "lunch" ? 15 : 21) * 60 &&
            end(s) > (meal === "lunch" ? 11 : 17) * 60,
        )
      )
        issues.push(
          `${meal === "lunch" ? "昼食" : "夕食"}を独立した滞在として確保してください`,
        );
    if (
      !meaningful.some(
        (s) => clock(s.when) >= 13 * 60 && clock(s.when) < 17 * 60,
      )
    )
      issues.push("午後の体験・カフェの枠が必要です");
    if (
      !plan.steps.some(
        (s) =>
          end(s) >= 19 * 60 &&
          ["dinner", "evening", "return"].includes(s.kind ?? ""),
      )
    )
      issues.push("夜の過ごし方と帰路までを確保してください");
  }
  if (!plan.steps.some((s) => s.kind === "rest" || s.kind === "cafe"))
    issues.push("疲れをためない休憩またはカフェの枠が必要です");
  if (
    b.pacing === "relaxed" &&
    b.mode !== "full-day" &&
    plan.steps.filter((s) => s.kind === "activity").length > 2
  )
    issues.push(
      "短くゆっくり過ごす依頼です。主な観光体験は2枠以内に絞ってください",
    );
  return issues;
}
