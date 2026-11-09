import type { Page } from "./types.js";
export interface PageAssessment {
  kind:
    | "available"
    | "degraded"
    | "maintenance"
    | "access_denied"
    | "not_found"
    | "empty"
    | "retired"
    | "login_required";
  shouldStop: boolean;
  reason: string;
}
/** Diagnose the captured page, never search-engine snippets or inferred availability. */
export function assessPage(
  page: Pick<Page, "title" | "text"> & Partial<Pick<Page, "acquisition">>,
): PageAssessment {
  if ([401, 403, 429].includes(page.acquisition?.status ?? 0))
    return {
      kind: "access_denied",
      shouldStop: true,
      reason: `公開HTML HTTP ${page.acquisition!.status}。アクセス制限を回避せず、取得不可として扱ってください。`,
    };
  if (page.acquisition?.status === 404)
    return {
      kind: "not_found",
      shouldStop: true,
      reason:
        "公開HTML HTTP 404。取得済みリンクから正しい詳細URLを確認してください。",
    };
  if ((page.acquisition?.status ?? 200) >= 400)
    return {
      kind: "access_denied",
      shouldStop: true,
      reason: `公開HTML HTTP ${page.acquisition!.status}。正常な個別詳細として扱いません。`,
    };
  const title = page.title.trim();
  const text = page.text.trim();
  if (
    /サービス.{0,6}終了/.test(title) ||
    /楽天Car中古車は[\s\S]{0,100}サービス終了/.test(text)
  )
    return {
      kind: "retired",
      shouldStop: true,
      reason: "サービス終了の告知です。現行の詳細情報源として登録しません。",
    };
  if (/^(?:ログイン|サインイン|Sign in|Log in)/i.test(title))
    return {
      kind: "login_required",
      shouldStop: true,
      reason: "ログインが必要なページです。公開詳細として登録しません。",
    };
  if (
    /blocked|access denied|just a moment|attention required|captcha/i.test(
      title,
    ) ||
    /Request Blocked|You have been blocked|Access Denied|verify you are human/i.test(
      text.slice(0, 2000),
    )
  ) {
    return {
      kind: "access_denied",
      shouldStop: true,
      reason:
        "アクセス制限・人間確認が表示されています。回避せず別の許可ソースか未確認回答へ進んでください。",
    };
  }
  if (
    /maintenance|メンテナンス/i.test(title) ||
    (text.length < 600 &&
      /システムメンテナンスのためご利用できません|メンテナンス中|メンテナンス終了まで/i.test(
        text,
      ))
  ) {
    return {
      kind: "maintenance",
      shouldStop: true,
      reason:
        "メンテナンス表示のため実候補を確認できません。サイトの正常稼働や推薦成功として扱わないでください。",
    };
  }
  if (
    /^(404|page not found|not found)|ページが見つかりません|お探しのページ.*見つかりません/i.test(
      title,
    )
  ) {
    return {
      kind: "not_found",
      shouldStop: true,
      reason:
        "ページが見つかりません。取得済みリンクから正しいURLへ戻ってください。",
    };
  }
  const body =
    title && text.startsWith(title) ? text.slice(title.length).trim() : text;
  if (body.length < 6)
    return {
      kind: "empty",
      shouldStop: true,
      reason:
        "根拠として使える本文を取得できません。読み込み失敗として扱ってください。",
    };
  if (
    /在庫状況や販売価格の変更が、現在の掲載情報に反映されていない|掲載情報が最新の情報ではない場合/.test(
      text,
    )
  ) {
    return {
      kind: "degraded",
      shouldStop: false,
      reason:
        "掲載情報の更新遅れが告知されています。在庫・料金を確定事項として扱わず制約に明記してください。",
    };
  }
  return {
    kind: "available",
    shouldStop: false,
    reason:
      "本文を取得しました。候補の個別詳細と条件の根拠は引き続き検証が必要です。",
  };
}
