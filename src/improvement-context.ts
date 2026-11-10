import type { Criterion } from "./types.js";
export interface ImprovementContext {
  minimumCandidates?: number;
  allowReplacements?: boolean;
  loopId: string;
  iteration: number;
  criteria: Criterion[];
  candidateUrls: string[];
  gaps: { url: string; fields: string[] }[];
  priorityUrls: string[];
  visitedUrls: string[];
  strategy: "targeted-links" | "broader-links" | "render-and-recheck";
}
export const IMPROVEMENT_PROMPT = `
自己改善ループの実行です。improvement.criteriaは元の評価契約であり変更できません。plan_taskは同じ条件を返すか省略してください。
ユーザーのqueryを保持し、candidateUrlsの全対象を再評価してください。unknownを根拠なくsupportedに変えてはいけません。
ただしallowReplacements=trueは利用者が代替候補の探索を許可した場合です。この場合は同じ許可ソース内で、同じ必須条件を満たす別候補を探索できます。元候補の必須条件が解消できなければ、必ず取得済みリンクの一覧・検索導線から代替を探してください。minimumCandidates以上を新しく詳細取得・引用検証してください。元候補を繰り返し再提示するだけでは代替探索は完了していません。allowReplacements=falseまたは省略の場合、元候補の省略・差し替えは禁止です。
primedPagesはホストが今回新しく取得した未調査ページです。まずここから不足項目を確認してください。visitedUrlsの既読子ページを繰り返さず、priorityUrlsと今回新しく発見したリンクを優先してください。候補本体の再取得は許可します。
priorityUrlsは以前取得したページから発見した未調査リンクです。まず対象の本体を再取得し、次に不足項目に関連する未調査リンクを優先してください。取得していない過去の本文や回答は証拠として利用できません。
strategyがrender-and-recheckなら、公開HTMLの不足をdeepen_detailsでも確認してください。アクセス制限は回避しません。
必要なら同じ対象のスタイル・ブログ・口コミ・設備・費用・周辺環境を調べ、各対象の必須条件をすべて評価してfinish_taskを呼んでください。
不足が解消しなければunknownとし、何を取得し何が不足したかをlimitationsに記載してください。
`;
