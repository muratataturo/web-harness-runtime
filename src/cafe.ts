import { assertEvidenceIntegrity } from "./provenance.js";
import { entityKey, cafeRequested, cafeTerms } from "./sources.js";
export { cafeRequested, cafeTerms } from "./sources.js";
import type { Task, Answer } from "./types.js";
export function isCafeStay(step: { where: string; action: string }) {
  if (!cafeTerms.test(step.where + " " + step.action)) return false;
  if (
    /飲食|昼食|朝食|夕食|ランチ|ティータイム|カフェ休憩|甘味|食べ|味わ|注文する|注文して/.test(
      step.action,
    )
  )
    return true;
  return !/徒歩|移動|歩く|歩いて|帰路|帰宅|乗車|解散|待機|待ち|入店待|受付|会計/.test(
    step.action,
  );
}

export const CAFE_GUIDANCE =
  "カフェ・喫茶・コーヒーを求める旅程では、地域と好みで候補を検索し、個別店舗の住所・営業時間・メニューを確認する。営業日の臨時告知を優先し、古い店舗名・閉店情報を確認する。行程内にカフェの独立した滞在手順と前後の移動を確保する。actionPlanのwhereに店名、howに何を味わうか・選ぶ理由・注文予算・混雑時の切替条件を書く。店舗名を含む引用、住所、営業時間の引用を同一店舗から取得し、滞在手順のevidenceIdsに指定する。飲み物・甘味の費用をcostItemIdsと主案budgetに人数×単価で含める。平均予算を個別ドリンクの価格に転用しない。単価が確認できなければestimateの予算枠とする。写真・地図・YOUR DAYのexperienceにもカフェを掲載し、inspect_photoで店内や飲食物の実画像を確認する。休憩というactionでも写真付き体験を省略しない。未確認のテラス空席・静けさ・子ども設備・アレルギー対応は保証せず、満席・雨天・予算超過時の具体的な代替をbranchesへ。取得できなければlimitationsに不足を残し、架空の店や価格で埋めない。カフェ指定のない通常の旅程でも、休憩や食事の候補として適合するか検討し、観光施設だけを機械的に並べない。不要・持参のみなどの指定を優先する。" +
  "住所の出典が確認できた手順のlocationStatusはevidence-linked、場所の出典が未確認ならunconfirmed。空席の不確実性はlimitationsへ分ける。入店待機は別手順でよく、飲食の費用は実際に注文する滞在手順へ紐付ける。budget.itemsのbasisはpublishedかestimate。branchesはtrigger/action/how/evidenceIds。候補のmatchesは配列でcriterionId/status/explanation/evidenceIdsを持ち、満たせる項目だけsupported、未確認はunknownにする。";

/** Uses the existing itinerary, evidence and budget contracts rather than a second schedule. */
export function cafePlanIssues(task: Task, answer: Answer): string[] {
  if (!cafeRequested(task.query)) return [];
  const plan = answer.actionPlan;
  const cafes = plan?.steps.filter(isCafeStay) ?? [];
  if (!cafes.length)
    return [
      "カフェの指定があります。店名付きの滞在手順、前後の移動、飲み物・甘味の予算、満席時の代替を取得・具体化してください。取得できない場合は未確認として残してください",
    ];
  const issues: string[] = [];
  for (const s of cafes) {
    const groups = new Map<string, string[]>();
    for (const id of s.evidenceIds) {
      const e = assertEvidenceIntegrity(task, id);
      const page = task.pages.find((p) => p.id === e.pageId)!;
      const key = entityKey(page.url);
      if (!key) continue; // Directory pages cannot prove a single cafe's facts.
      groups.set(key, [...(groups.get(key) ?? []), e.quote]);
    }
    const verified = [...groups.values()].some((quotes) => {
      const text = quotes.join("\n");
      return (
        cafeTerms.test(text) &&
        /住所|所在地|アクセス|東京都|北海道|京都府|大阪府|.{2,3}県/.test(
          text,
        ) &&
        /営業時間|開店|閉店|定休日|L\.?O\.?/i.test(text)
      );
    });
    if (s.locationStatus !== "evidence-linked" || !verified)
      issues.push(
        `${s.id}: カフェの店舗名・住所・営業時間を同一店舗の引用で確認してください。他店の情報や施設一覧を混ぜないでください`,
      );
    if (
      !s.costItemIds.length ||
      !s.costItemIds.some((id) =>
        plan?.budget?.items.some((i) => i.id === id && i.unitYen > 0),
      )
    )
      issues.push(
        `${s.id}: カフェの飲み物・甘味の費用を主案budgetと手順のcostItemIdsに含めてください。未確認の単価はestimateと明示してください`,
      );
    for (const item of plan?.budget?.items.filter(
      (i) => s.costItemIds.includes(i.id) && i.basis === "published",
    ) ?? []) {
      const quotes = item.evidenceIds.map(
        (id) => assertEvidenceIntegrity(task, id).quote,
      );
      if (
        quotes.some((q) => /平均予算/.test(q)) &&
        !quotes.some((q) => !/平均予算/.test(q) && /円|[¥￥]/.test(q))
      )
        issues.push(
          `${s.id}: 店舗の平均予算を商品の掲載単価に使えません。注文内容の価格を引用するかestimateの予算枠にしてください`,
        );
    }
  }
  if (
    !plan?.branches.some((b) => /満席|混雑|行列|待ち|閉店|休業/.test(b.trigger))
  )
    issues.push(
      "カフェが満席・休業のとき、待ち時間の上限と次に行う具体的な行動をbranchesに示してください",
    );
  return issues;
}
