# 正解ラベル・口コミ・回答フィードバック

回答品質を「根拠と主張の意味的な一致」「推薦候補の評判」「回答に対する利用者の評価」に分けて記録する。店舗の星が高いことから回答が正しい・利用者が満足したとは判断しない。自己改善の完了条件やtrustedレベルを口コミで緩和しない。

## 正解ラベル付きの意味判定ベンチマーク

[semantic-v1.json](../benchmarks/semantic-v1.json) は8ケース・28判定の初期回帰セット。7ケースは架空の反例、1ケースは2026-11-10取得の実ページ抜粋。全件がCodex補助で作成した暫定ラベルで、人による独立レビューは0件。人が確認済みの正解や、未見のholdoutセットとは呼ばない。

| ケース | 検証する混同 |
| --- | --- |
| beauty-idol-entailment | 韓国風が得意でもアイドル風対応は未確認 |
| suumo-missing-fee | 管理費「-」を0円としない |
| suumo-monthly-arithmetic | 14万円＋6,000円を146,000円と計算 |
| suumo-station-identity | 向河原駅6分を武蔵小杉駅の徒歩に流用しない |
| market-price-scope | 価格帯・選択SKU価格・クーポン額を区別 |
| books-edition-identity | サイズ別ISBN・寸法を区別 |
| hotel-cross-entity | 別施設の客室数を流用しない |
| review-proxy-boundary | 4.81点・978件からruntimeの満足率を作らない |

各記述にsupported / contradicted / unknownの正解と、出典の根拠範囲を持たせる。モデルに渡すのは同一の本文・対象URL・評価する記述だけで、正解ラベルと採点用の根拠アンカーは渡さない。Codex/Claude Code/piが通常と同じ調査・引用・finish_taskツールを使うが、ReplayBrowserは凍結資料以外のURLを拒否し、ライブ取得へfallbackしない。取得日時も固定値を維持する。

引用の出典対象・本文一致・正解に必要な根拠アンカー、条件契約、候補集合、入力ハッシュを独立検査する。データセットと各ケースにもハッシュを保存する。入力や契約が改変されたケースは集計上不正解として扱う。モデルが自分で付けたscoreやsucceededは採点に使わない。凍結資料が短い抜粋なら通常の詳細取得契約でpartialとなる場合があるが、それと意味判定の合否は別である。

| 指標 | 定義 |
| --- | --- |
| targetedEntailmentAccuracy | 正解ラベルと一致した判定数 / 全判定数 |
| macroF1 | supported / contradicted / unknownのF1の平均 |
| supportedPrecision | supportedと断定したうち正解もsupportedの割合 |
| unsupportedAssertionRate | supportedと断定したうち正解が別ラベルの割合 |
| unknownRecall | 正解がunknownのうちunknownと返せた割合 |
| citationAccuracy | supported/contradictedと回答した判定の引用検査合格率。断定なしはnull |
| strictCasePassRate | 全判定・引用・入力・対象集合の検査に合格したケースの割合 |
| coverage | 予定ケース、実行ケース、quota等で未実行のケースIDを併記 |

比率は0〜1。分母0はnull。未回答は正解にしない。未実行ケースを隠して全体合格にしない。正解ラベルのレビュー状態も報告する。CIは推論を使わず、データと根拠の整合性・採点器の正例/反例を検証する。

これは構造化された記述の含意・反証・未確認判定を測るもの。自由文のsummaryやexplanation全体の意味の正しさを自動採点する仕組みではなく、`freeTextReview=not_evaluated` を明示する。自然な言い換え、説明の一貫性、推薦の妥当性を全面保証しない。引用のアンカー検査も、汎用的な文章含意判定器ではない。自由文評価、人によるラベル確定、独立した大きなholdoutは次の評価段階である。

```sh
npm run build
npm start -- benchmark check
npm start -- benchmark list
npm start -- benchmark inspect beauty-idol-entailment
npm start -- benchmark run --agent codex --model gpt-6.1-sol --json
npm start -- benchmark run --agent claude-code --model claude-haiku-5-5 --json
npm start -- benchmark run --agent pi-openrouter --case suumo-missing-fee --json
npm start -- benchmark grade TASK_ID --case suumo-missing-fee
```

`--case` でケースを限定、`--max-steps` / `--timeout` はケースごとの上限。結果は `.runtime/benchmarks/<run-id>/report.json`、回答は通常のTaskに保存。認証・quota・rate limitでは後続を停止し、未実行を記録する。有料へ切り替えない。終了コードは全件合格0、不合格/未実行2、中断130。データ不正は実行前にエラーにする。凍結Taskを通常のretry/improveへ渡してライブ調査に変換することは拒否する。

## 実モデルでの実測

2026-11-10、同じr2データ・同じハッシュの8ケース28判定を実行した。

| モデル | ラベル一致 | Macro F1 | unknown再現率 | 引用適合率 | 全項目合格 |
| --- | --- | --- | --- | --- | --- |
| Codex / gpt-6.1-sol | 28/28 | 1.00 | 4/4 | 1.00 | 8/8ケース |
| Claude Code / Haiku 5.5 | 28/28 | 1.00 | 4/4 | 1.00 | 8/8ケース |

これは選んだ小さな初期回帰セットの結果で、一般的な回答精度100%を意味しない。初版r1では「対応を確認できる」が未確認/不一致の両解釈を許し、Haikuが1件異なるラベルを返した。モデルの誤りと断定せず、設問を「施術に対応している」という事実の主張に直し、正解ラベルを変えず両モデルの全8ケースを再実行した。初版の結果もcalibrationとして残し、設問を訂正したことを隠さない。

[実行結果・各Task ID・回答・校正履歴](evidence/semantic-quality.json)。全件実測後、口コミの解釈を通常回答にも明示する指示を追加し、該当するreview-proxy-boundaryを両モデルで再検証して各3判定の一致を確認した。followUpChecksに記録する。

piも同じ実行経路に対応するが、このデータセットの実測比較はCodexとHaikuの2モデルである。

## 口コミはサービス満足度の代理指標

現在の抽出対象はHot Pepper Beautyと楽天トラベル。個別詳細を検証したページのヘッダーから、平均点、1〜5の尺度、表示件数、短い引用、出典URL、取得日時を保存する。取得失敗や未対応サービスは欠測で、0点にしない。複数観測の不一致は表示し、件数を足さず新しい観測を選ぶ。取得日時はサイトの口コミ投稿日時や評価の新しさそのものではない。

- [Hot Pepper Beauty公式](https://beauty.hotpepper.jp/doc/review_guide/review_average_point.html)：直近1年間の総合評価を平均する。
- [楽天トラベル公式](https://travel.faq.rakuten.net/detail/000004323)：総合スコアは通常過去1年。該当期間に投稿がなければ過去2年を使い、一定数に満たない場合は表示されない。

公式ルールの確認日は2026-11-10として記録する。表示件数が平均点の算出対象と同じ期間・同じ標本かは未確認なので `countPeriodConfirmed=false`。件数を標本数とする信頼区間やBayesian補正、星÷5を満足率へ変換する処理は行わない。異なる媒体の平均も単純合算しない。

```sh
npm start -- reviews TASK_ID --json
```

保存済みの実取得本文への適用で、acote @は4.81点・978件、箱根強羅グアムドッグ本店は4.18点・108件、HOTEL RaKuunは3.99点・625件を抽出した。これは2026-11-10の取得記録に基づく値で、回答に満足した人数や現在の評点を保証するものではない。出典・引用は実測JSONに記録する。推薦条件の適合性とこの評判指標は別で、評点を理由に必須条件やtrustedを昇格させない。

## 回答そのものへの満足度

ローカルCLIから、利用者が明示した回答への5段階評価・役立ち度・選んだ候補・コメントを保存できる。実調査の回答にだけ紐付け、ベンチマークTaskや外部口コミを自動投入しない。同一Taskの再投稿は上書きするので回答数が膨らまない。保存値の形式が壊れていたら集計を拒否する。

```sh
npm start -- feedback add TASK_ID --rating 4 --helpful yes --note '条件と根拠が分かりやすかった'
npm start -- feedback summary
```

集計は評価済みタスク数、平均点、4〜5点の割合（csat4or5）、役立った割合。未回答は分母に含めない。複数利用者の本人確認・母集団管理は未実装なので、scopeをlocal-user-answer-feedbackとし、全ユーザーの満足率とは呼ばない。実フィードバックは現在0件で、平均・割合はnull。テスト用の評価を実利用者の結果として計上していない。

134テスト、型、ビルド、整形、データチェックを確認。採点器の正例・誤判定・捏造/別対象引用・入力改変・正解漏洩防止・quota停止、欠測の扱い、口コミと回答評価の分離、再投稿と不正保存値を検証する。
