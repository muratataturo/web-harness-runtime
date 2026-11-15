# 公開harness調査と品質改善・生成比較

調査・実装日: 2026-11-14。対象は単一利用者向けの公開サイト調査runtime。開始時点の未コミット変更を含む実装を比較元として保存し、その上に今回の改善を追加した。外部runtimeをインストールして置き換える調査ではなく、一次資料で設計を比較し、このruntimeのコード・評価・自己改善に反映した。

## 公開成果物から採用したこと

検索語は `pi-harness-runtime`、`browser-use browser runtime harness`、`web harness runtime github`、`web agent harness runtime`。ユーザー指定のbrowser-userは、検索で対応するBrowser Use / browser-harnessとして調査した。以下は各プロジェクトの公開説明・コードに基づく比較であり、外部製品を同一環境で実測したランキングではない。

| 一次資料 | 着目点 | このruntimeへの反映・判断 |
| --- | --- | --- |
| [pi-harness-runtime](https://github.com/ManotLuijiu/pi-harness-runtime) | 利用量の追跡、中断を扱うタスク進行、作成→レビュー→修正 | 既存の永続化・独立検証を維持し、改善ごとの品質差分と消費量を追加。公開README自身がbetaとするため、機能の数を成熟度と同一視しない |
| [Browser Harness](https://github.com/browser-use/browser-harness)、[公開手順](https://github.com/browser-use/browser-harness/blob/main/SKILL.md) | HTTPで読める情報はHTTP、必要な箇所だけを抽出、操作結果を観測 | 取得本文の保存とモデル入力の量を分離。read_pageで再通信せず必要箇所を読む。hardenedでは描画戦略を選ばない |
| [Browser Use実装](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py) | セッション、実行履歴、時間・ステップ境界、利用量 | 各改善回の計測と終了結果を保存。任意Python実行や個人ブラウザ接続は、この公開調査runtimeの権限に追加しない |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | コンパクトな観測、操作と再観測、セッション | 既存のブラウザ実装は維持。HTML調査に不要なブラウザ起動を増やさず、保存本文の再読取を追加 |
| [Stagehand](https://github.com/browserbase/stagehand) | observe / act / extract、スキーマによる抽出 | 取得・引用・確定の分離を継続。構造検査だけで意味的正しさを証明したとしない |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 構造化観測、CLIとMCPでの文脈量の違い | エンジンを替えず、共通ツールの返却量を制限。既存ChatのE2Eも確認 |
| [Harness](https://github.com/lenileiro/harness) | モデルと、権限・検証・復旧を担うruntimeの分離 | finish_task、サービス評価、改善診断に同じ引用検査を適用 |
| [WebdriverIO benchmark](https://github.com/webdriverio/benchmark) | 同じモデル・課題・環境での比較 | 同じ取得本文・クエリ・条件・モデル・上限を使う再生成スクリプトを追加 |
| [BrowserMesh](https://github.com/scrollDynasty/BrowserMesh) | セッション分離、永続状態、stdoutとMCPの分離 | 既存のタスク別保存とMCP境界を確認。共有SaaS化や個人ブラウザ共有は今回の変更に含めない |

Browser Harnessの[公開比較](https://github.com/browser-use/browser-harness/blob/main/README.md)も条件付きの評価として読む。別モデル・別課題の公表成功率を、このruntimeの成功率として引用しない。

## 発見と実装

| 優先度 | 発見した問題 | 対応 |
| --- | --- | --- |
| High | finish_taskの保存済み根拠には、作成時ほどの完全性検査がなかった | 本文の連続一致、URL、取得日時、根拠ID・ページIDの一意性、取得可否を回答確定時にも検証。service-evalsも同じ検証を使い、eligibleを再計算 |
| High | 回答保存後の追加ツール呼出しで「回答確定済みです」が伝播し、保存済みの部分回答までfailedになり得た | 確定後のツール呼出しはfinalizedとして終了し、回答・根拠・ステップ数を変更しない。凍結比較で発見し、実ツールを通す回帰テストを追加 |
| Medium | 通常取得は大量の本文・リンクをモデルへ渡す一方、先行取得は先頭6,000字だけに偏った | 全文はStoreへ保存。通常返却は本文6,000字・48リンク、条件に関連する後半の連続抜粋は合計最大4,000字。read_pageは本文最大6,000字を検索・分割読取 |
| Medium | 抜粋の省略と元の取得本文の欠落を混同しやすい | sourceTruncated、contextTruncated、totalCharsを返し、保存本文の後半を読めることを明示。切れた取得本文を復元したとは扱わない |
| Medium | hardenedの3回目や学習済み手順に描画戦略名が残った | hardenedはbroader-linksに置換。制限された対象を先行取得で再巡回しない。404の子ページだけで健全な別子ページまで禁止しない |
| Medium | 全候補の取得拒否でもunknownの併存によってモデルを再実行し得た | 代替探索が許可されず全対象が取得不可ならblockedで停止 |
| Medium | 改善したかと、どれだけ資源を消費したかを比較しにくかった | 各iteration.measurementに実測時間、総トークン、追加API費用、再取得数、必須確認数・詳細数の差分、既確認成果の維持を保存。不明な費用・トークンはnull |
| Medium | 凍結評価でも未収録URLの追加取得を繰り返した | 凍結評価のfinish_taskでは自動追加取得をせず、unknownを保持。ライブ調査の追加取得は継続 |

read_pageの各windowは保存本文の連続部分で、start/endは元本文の文字位置。別windowを結合した架空引用は作らない。外部本文・リンク・タイトルは引き続き命令として扱わない。省略されたリンクもStoreに残り、deepen_detailsは全保存リンクから探索する。

## 自己改善ループへの組込み

既存の `improve` / `--self-improve` とChatの共通executorを通す。別の独立したデモ専用ループは作っていない。

1. 元クエリ・候補・条件・必要件数を固定し、保存本文・引用を独立検証。
2. 取得拒否・既読・実行モードを考慮して未読リンクを選択。
3. 先行取得の先頭と関連する後半の抜粋を渡す。モデルはread_pageで保存本文を再確認できる。
4. 新タスクを実行し、同じ引用検査で再評価。
5. 品質差分・消費量・採否をloop.jsonへ保存。既確認成果を失う回は採用しない。反証による訂正は別途保持。
6. 全条件を確認した手順だけ既存の学習経路で再利用。次回も本文と引用を新しく取得する。

ここでの自己改善対象は調査手順であり、実行中のコードや検証条件をモデルが書き換える機構ではない。ソースコードの改善は今回の開発変更としてテスト・比較している。

## 実生成の検証

実測値・タスクID・生成回答・引用・採否は [harness-quality.json](evidence/harness-quality.json)。全試行は `.runtime/quality-study/` に保存。失敗した試行も削除していない。

通常のライブ調査は楽天ブックス1商品とHot Pepper1店舗で、旧版・新版とも確認3項目/3項目。短い入力では新版の時間・トークンは微増した。したがって一律に高速化・省コスト化したとは結論しない。

初回を3ステップに制限した楽天の未完了タスクでは、同じクエリ・条件・候補・初回保存データから旧版と新版の改善を各1回実行し、両方が必須確認0→3、詳細0→1で完了。新版の測定値はloop.iterations[].measurementに残った。

ストレス試験は、実際に取得した本文の前に合成の案内文24,000字を追加し、同じ資料をモデルに再読取させたもの。ライブWebの成功率を表す試験ではない。条件を固定し、同じgpt-6.1-solと同じ上限を使い、独立検証は現在の同一コードで両者に実施した。結果表はJSONのfrozenFinalを参照。未知の条件は合格へ書き換えない。

| 固定本文＋合成案内文 | 必須項目の確認・未確認 | 総トークン 旧→新 | 実時間 旧→新 |
| --- | --- | --- | --- |
| 楽天ブックス | 両方3/3確認 | 75,049→68,693（8.5%減） | 20.33→21.59秒 |
| Hot Pepper | 両方2/3確認、時間帯別予算は未確認 | 122,073→100,329（17.8%減） | 39.67→29.24秒 |

通常ライブの総トークンは楽天57,471→58,548、Recruit67,499→69,126。自己改善の追加1回は59,614→60,751。ツール定義・メタデータを増やす固定負担があり、短い入力での削減は確認できなかった。長いページの省略と、凍結資料での不要な追加取得停止の両方を含む変更の比較なので、削減量を本文省略だけの効果と帰属しない。初回の探索的な凍結試験で旧版は回答確定後の再呼出しによるfailedを生じたが、最終比較では旧版もpartialだった。発生頻度を推定できる試行数ではない。

引用健全性の決定的比較では、ライブ成功タスクに対する引用本文改変・URL改変・取得日時改変・根拠ID重複・ページID重複の5ケースを、旧finish_task検査は受け入れ、新検査はすべて拒否した。旧改善診断には既に本文・URL等の再検査があったため、「従来のすべての入口で改変を受け入れていた」という意味ではない。

## 網羅点検と残る課題

| 観点 | 現時点の根拠と判断 | 残課題 |
| --- | --- | --- |
| 製品・利用者 | 公開URLから条件・引用付き比較。Chat / CLI / MCP共通runtime | 全サービスの課題を今回の少数生成だけで代表させない |
| UX・アクセシビリティ | 進捗、部分回答、停止、再相談、dialog、focus-visible、reduced-motionを確認。Chat fixture E2E両family成功 | 人によるキーボード・スクリーンリーダー評価は未実施 |
| コード・境界 | 共通の引用検査とツール返却、個別Store、atomic保存 | 型付きJSONの全永続化データへの移行は別途設計 |
| セキュリティ | 公開HTTPS、固定profile、SSRF検査、loopback/origin制限、外部本文の非命令化 | VM実配備と共有SaaSのtenant境界は今回の試験外 |
| 例外・復旧 | quota/auth停止、全体timeout、キャンセル、回答確定後の再呼出し、取得拒否を検査 | daemon再起動はinterruptedとして回復する。透過的なモデル会話再開とは異なる |
| AI品質 | 完全性の共通検査、unknown保持、固定条件比較、改変5ケース | 引用が主張を意味的に含意するかの汎用判定は未解決。予算の時間帯対応のような曖昧性を残す。人手ラベル付きの評価拡張が必要 |
| 信頼性・負荷 | ステップ/ページ/時間の上限、改善停止、ローカル保存 | プロセス全体の同時実行制限・負荷試験・p95は未検証。公開共有サービスのSLOを主張しない |
| 観測性 | タスク・イベント・SSE、改善ごとの品質と消費量 | 外部の稼働監視・通知・インシデント運用は未配備 |
| 費用 | 実モデルのprovider報告トークン・実時間・追加API費用を保存 | サブスク固定費配賦、追加クレジット消費、VM/GPU月額は不明。additionalApiUsd=0を総費用ゼロと解釈しない |
| データ・保存 | 本文と引用の取得時刻、タスク別ディレクトリ、権限制限、atomic更新 | 保存容量・保持期間・自動削除の製品仕様が必要。今回は既存証拠を自動削除しない |
| リリース | 型・ビルド・全回帰・Chat fixture E2Eで確認 | release:verify / 当該revisionでのlive Chat受入 / package:cli / VM imageは別のリリース条件。今回公開・配備していない |

優先して次に増やす評価は、複数候補比較、価格の合算、駅徒歩の掲載矛盾、SKU未指定、認証切れ、途中停止後の再開、長いページの重要情報の位置を変えた複数試行。現在のsemantic benchmarkの既存ケースと組み合わせ、人手で含意ラベルを確認する。ローカル単一利用者の範囲を超える前に、同時実行制御・保持期間・監視と分離を設計する。

## 再実行

```sh
npm run build
# baselineは比較前にdistとconfigを保存したディレクトリ。
# captureには成功したライブTask JSONを渡す。実モデルの利用枠を消費する。
npm run eval:harness -- \
  --baseline .runtime/quality-study/baseline \
  --capture .runtime/quality-study/before.json \
  --capture .runtime/quality-study/recruit-before.json \
  --stress --out .runtime/harness-quality-repeat

node --import tsx --test --test-concurrency=1 test/*.test.ts
npm run test:chat:runtime
```

比較スクリプトは保存本文と条件にSHA-256を付け、未知URLからライブ取得へfallbackしない。afterの実行失敗、引用検査失敗、beforeから必須確認数が減った場合は終了コード2。構造的に正しい部分回答は結果として保持する。これは意味的同等性や統計的な非劣性の証明ではない。順序は旧版→新版、各条件1試行なのでキャッシュや負荷の影響が残る。
