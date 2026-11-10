# Relay / web-harness-runtime

**目標をチームで調べ、互いに見直し、大切な選択を人に戻す自律タスク runtime。** 公式CodexのChatGPTログインを既定の調査エンジンとし、Claude Code Sonnet 5.5 / Haiku 5.5、pi + OpenRouter無料モデルも選択できるCLIです。Vercel agent-browserで調査し、Grok Bot / OpenMausBot / Rakazoの公開画面を参照した会話中心のWeb Mockと、self-host VM向けNVIDIA OpenShell executorを備えています。

## Web Mock を試す

```sh
npm ci
npm run web
# http://127.0.0.1:4310
```

API キーなしで体験できます。左の Bot 一覧、中央のチーム会話、右の Team Computer を使い、「箱根の2泊3日」と「湘南の暮らし」の2シナリオを操作できます。体験データは架空で、宿・店・求人・物件・車両の実在や価格を保証しません。独自の目標文や追加のこだわりは保存しますが、体験モードの旅程・レビューはこの2シナリオのテンプレートです。

1. 旅／暮らしの主役を、おすすめ案と代替案から選ぶ。予算やこだわりも入力。
2. 独立タスクは最大2件を並列実行。依存タスクは前提が揃うまで待つ。
3. チーム会話でレビュー指摘→担当への差し戻し→再調査を確認。
4. 温泉・夕食などのご褒美、または仕事・内見・固定費など次の一歩を選ぶ。
5. 選んだ内容に合わせたプランを見る。更新しても履歴と承認が残る。

方針変更では旧承認を再利用せず、改訂番号を上げて再計画します。現段階では影響タスク限定の差分再計画ではなく、同じ目標の全タスクを作り直します。停止後に古い処理が結果を書き戻さないことも検証しています。

UI の「実調査に切り替え」は、選択エンジンの利用枠（既定はCodexのChatGPTログイン）を実際に使う操作です。実調査は数分かかり、公開サイトにアクセスできない場合もあります。体験モードとは別の明示操作にしています。

![会話とComputerの画面](docs/screenshots/welcome.png)

## CLI で実サイトを調べる

Node.js 22 以降が必要です。既存 `.env` は上書きしないでください。

```sh
# 公式Codex CLIをインストール済みであること（動作確認: 0.167.0）
codex login
# .envはOpenRouterなど追加設定にのみ必要。既存ファイルを上書きしない。
npm run browser:install
npm run build
npm start -- codex-doctor
npm start -- doctor

npm start -- run '髪質改善で有名な渋谷の駅から近い韓国アイドル風になれるサロンを教えて欲しい'

npm start -- run '京都駅から近い和食ランチを予算3000円以内で2件比較して' \
  --url https://www.hotpepper.jp/top_party38/SA22/Y435/X434/G004/

# 複数URLの初期優先順と、モデルによる必要な情報源の選択
npm start -- run '渋谷で髪質改善と韓国風ヘアが得意なサロンを比較して' \
  --url https://www.jalan.net/ https://beauty.hotpepper.jp/ https://www.hotpepper.jp/
```

`run` の既定 URL は Hot Pepper Beauty。検索・エリア・個別詳細 URL を起点にもできます。開発時は `npm start --` の代わりに `npm run dev --`。`--max-steps`、`--max-pages`、`--timeout`、`--model`、`--json` を指定できます。

```sh
npm start -- run-file examples/beauty.json
npm start -- plan '温泉旅館を比較して' --url https://www.jalan.net/ https://beauty.hotpepper.jp/
npm start -- models
npm start -- quota # OpenRouter無料枠のみ。Codex利用枠とは別
npm start -- sources
npm start -- tasks
npm start -- show TASK_ID --json
npm start -- retry TASK_ID
```

Codexは公式App Serverのモデル一覧からアカウントの既定モデルを選び、APIキーではなくChatGPTログインを要求します。`--model` または `CODEX_MODEL` で利用可能なモデルを指定できます。APIキーやOpenRouterへの自動fallbackは行いません。実行結果に `agent` と `model` を保存します。

`--agent pi-openrouter`（または `RUNTIME_AGENT=pi-openrouter`）の場合、モデルは現行 OpenRouter カタログから、無料 ID、全料金ゼロ、tools 対応、16K 以上のコンテキストを確認して選びます。`provider.max_price` もゼロに設定し、有料への fallback はしません。`OPENROUTER_MODEL` で特定の無料モデルを選べます。開始前にキー情報APIで無料残量を確認できた場合、残量0ならモデル要求を送らず次の回復時刻を返します。日次枠切れと短期の429を区別し、エラー後に同じ要求を繰り返しません。

Codexでの実測は、楽天トラベル2宿と複数ドメインから選んだSUUMO2物件が `succeeded`。Hot Pepper Beautyはサロン2件の詳細取得と日本語比較を完了し、「韓国アイドル風」への厳密な適合を未確認として `partial`。79テストと実測の詳細は [Codex接続と検証](docs/codex.md) を参照。

## Claude Code・追加調査・trustedレベル

```sh
npm start -- claude-doctor
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel --agent claude-code --model claude-sonnet-5-5
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel --agent claude-code --model claude-haiku-5-5
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel --agent pi-openrouter
npm start -- trusted list --all
npm start -- trusted list --min-level 4 --json
```

不足情報は同一対象の子ページ・描画を追加調査し、解消しなければ未確認を残します。楽天市場は対象商品の公開Microdataから価格帯を取得できるようになりました。trustedはL0〜L4で情報量を分類し、L3以上を登録・実行対象とします。現行台帳はL3:4URL / L4:20URL。L4は希望条件への完全適合や在庫の保証ではありません。[接続・深掘り・レベルの仕様と実測](docs/engines-and-depth.md)。

## Recruit・楽天の実行結果

[16サービスのCodex実測](docs/codex-family-results.md)を追加しました。11サービスで詳細2件以上を取得。当時は楽天市場の仕様を読めても販売価格が不足し、trustedから除外しました。その後のMicrodata対応で対象商品の価格帯を取得し、再検証して登録しています。Indeed・楽天不動産・楽天Car中古車・楽天Careersは個別比較に進めていません。

```sh
npm run build
npm run eval:families
npm run eval:families -- recruit-jalan rakuten-travel
```

## サービスごとの品質を確認する

```sh
npm start -- eval --list
# APIを使わず、検索一覧→個別詳細の導線だけを切り分ける
npm start -- eval --browser-only --case gourmet-kyoto-lunch --timeout 90
npm start -- eval --browser-only --case carsensor-family-sienta --timeout 90
# Codexで自然言語から比較回答までを評価（OpenRouter版は --agent pi-openrouter）
npm start -- eval --case gourmet-kyoto-lunch --parallel 1 --timeout 360
```

5サービスの条件付きクエリは [examples/service-evals.json](examples/service-evals.json)。`--retrieval-only`（`--browser-only`と互換）で返る `mode: retrieval-only / details_verified` は領域別必須項目まで確認した詳細取得の成功であり、自然言語回答の合格ではありません。

| サービス | 今回の実測 |
| --- | --- |
| Hot Pepper Beauty | 正式な `/slnH.../` 形式を修正し、一覧→個別サロン2件の詳細を取得 |
| Hot Pepper グルメ | 検索一覧→ランチ詳細2件の取得成功。引用修復を改善、改善後LLM回答は再評価が必要 |
| カーセンサー | 一覧→個別車両2台の取得成功。総額・走行距離の不一致事例を確認 |
| じゃらん | 公開HTMLをWindows-31Jで解析し、箱根一覧→宿詳細2件を取得。温泉・露天風呂・アクセスの本文を確認 |
| SUUMO | 公開HTMLから検索結果本体→物件詳細2件を取得。家賃・管理費・間取り・対象駅の本文を確認 |
| Indeed | Request Blocked。回避せず、取得不可として扱う |

じゃらん・SUUMOはサーバーが公開するHTMLを優先し、他サイトや動的ページにはagent-browserを利用します。取得方式・HTTP状態・文字コードをページに記録し、公開HTMLの取得をブラウザ描画確認と混同しません。両方式とも同じ引用・候補検証を通します。

以前のOpenRouter実評価では無料日次枠（50件）を消費したため、当時の5サービスの自然言語回答品質が合格したとはしていません。[実測レポート](docs/cli-service-validation.md) に task ID、具体的な失敗、改善、再評価手順を記録しました。引用は取得本文との一致と同一対象への対応を検証し、一覧ページや制限画面の候補化を拒否します。引用の意味と主張が一致するかには、モデルの誤りが残り得ます。

## 詳細取得を完了条件にする trusted URL台帳

```sh
# 推論APIを使わず一覧→個別詳細を確認。楽天ぐるなびも含む
npm start -- trusted verify --family rakuten --parallel 2 --timeout 75
# 制限・終了・未対応が含まれる一括検証の終了コードは2
npm start -- trusted list --all
npm start -- trusted list --json
npm start -- trusted plan '箱根の温泉宿を比較して'
npm start -- trusted run '温泉とアクセスを重視して2件比較して' --source rakuten-travel
```

トップや一覧が開くだけでは完了にしません。個別対象のURL、本文、文字品質、住所や価格など領域別必須項目を検査し、各候補の詳細取得を満たした場合だけ調査タスクを `succeeded` にします。推薦条件への適合も従来通り別途検査します。未知のドメイン・詳細形式は `unsupported` になり、取得成功にはしません。

source登録の検証では異なる対象IDの詳細2件以上を確認し、合格した**個別URLだけ**を台帳に記録します。タイトル、確認日時、方式、項目の短い引用、本文SHA-256を保持。有効期限は7日、期限切れは使用不可、再検証失敗では登録を外します。台帳の更新はプロセス間ロックで保護します。trustedは「詳細取得できた」という意味で、ページの命令・広告や推薦品質を信頼する意味ではありません。価格・在庫・空室は再取得時点でも確認が必要です。

[検証済み台帳](config/trusted-urls.json)を初期データとして同梱し、実行時の更新はgitignore対象の `.runtime/trusted-urls.json` に保存します。`TRUSTED_URLS_FILE` または `RUNTIME_DIR` で保存先を変更できます。未作成の実行時台帳は同梱データを読み、期限判定を通して利用します。新しい検証対象の入口は [source-catalog.json](config/source-catalog.json)、詳細URL形式は `src/sources.ts`、必須項目は `src/detail-contracts.ts` に追加します。

楽天の対象は美容・宿泊・飲食・住居・車・求人と、旅行/生活に関連するゴルフ・本・買い物です。金融や通信を含む楽天全サービスを検証したものではありません。実測の対象URLと失敗・未対応の区分は [楽天・trusted URL検証](docs/trusted-urls.md) に記録しています。

## 目標ルーターと内部A2A

```mermaid
flowchart TD
  G[目標] --> A{方針の承認}
  A -->|旅行| T1[宿]
  A -->|旅行| T2[食事]
  A -->|旅行| T3[観光]
  A -->|暮らし| L1[仕事]
  A -->|暮らし| L2[住居]
  L1 --> L3[車]
  L2 --> L3
  T1 --> R[横断レビュー]
  T2 --> R
  T3 --> R
  L1 --> R
  L2 --> R
  L3 --> R
  R --> F[差し戻し・再調査]
  F --> D{こだわりの選択}
  D --> P[統合・候補表示]
```

旅行なら宿・食事・観光が独立し、最大2件同時実行。暮らしなら仕事と住居を並列に、車は両方の条件を確認後に実行します。前提が失敗・未確認なら依存タスクを進めません。

目標・改訂・タスク・配送・関連 ID、送信元・送信先、message kind、hop を持つ内部メッセージで引き継ぎます。メンバー確認、重複配送防止、hop上限を設けています。**外部 A2A 標準の互換実装ではありません。** 体験モードのレビューはスクリプト。実調査モードの横断レビューは未確認条件等のルール検証で、交通・料金・生活の成立性を推論する独立 LLM reviewer は未実装です。

実調査では複数の pi runtime を呼び出し、こだわり承認後に該当分野の確認済み候補があれば1回再調査します。生成した候補だけを表示し、取得できない分野を Mock で埋めません。実旅程の最適化・費用合算や予約実行は範囲外です。

```sh
npm start -- goal create --scenario travel
npm start -- goal show GOAL_ID
# show が返した gate ID、revision、choice ID を使用
npm start -- goal decide GOAL_ID --gate GATE_ID --revision 1 --choice relax
npm start -- goal list
npm start -- goal revise GOAL_ID
npm start -- goal cancel GOAL_ID
```

CLI の `goal` 操作は一つの制御プロセスで使用します。同じ保存先を複数の Web サーバーや CLI プロセスから同時に書き換える分散ロックは未実装です。Web の同一プロセス内の二重承認と競合はテストしています。

## self-host VM / OpenShell

[導入手順・ポリシー・検証状況](docs/openshell.md) を参照してください。

```sh
docker build -t web-harness-runtime:local -f infra/openshell/Dockerfile .
npm run test:image

# dry-run: VMへ接続せず、発行計画とpolicyを保存
npm start -- sandbox plan '箱根で温泉のある宿を比較して' \
  --gateway selfhost --url https://www.jalan.net/

npm start -- sandbox doctor --gateway selfhost
# 設定済みgateway/providerへ実sandboxを発行
npm start -- sandbox run '箱根で温泉のある宿を比較して' \
  --gateway selfhost --url https://www.jalan.net/
```

Web/goal router の実調査を sandbox ごとに発行する場合、ホストの `.env` に設定します。

```dotenv
RUNTIME_EXECUTOR=openshell
OPENSHELL_GATEWAY=selfhost
OPENSHELL_IMAGE=web-harness-runtime:local
OPENSHELL_PROVIDER=web-harness-openrouter
```

`src/executors.ts` が各調査を別 sandbox に割り当て、downloadした `task.json` を目標に関連付けます。実キーは gateway provider で保持し、sandbox 内は placeholder を使います。APIキーを image、task JSON、ブラウザに渡しません。control plane の承認とルールレビューはホスト側です。

Linux arm64 イメージのビルドと、秘密・ネットワークなしコンテナ内での Node/Pi/agent-browser/Chromium 起動・ページ取得を確認しました。**接続先 VM/gateway が未指定のため、実 OpenShell 発行・credential rewrite・Landlock 下での起動は未検証**です。Docker の検証を OpenShell の検証と同一視しません。sandbox は成果物回収後も retain するため、状態を確認して stop/delete する運用が必要です。

## 保存・制限

`.runtime/tasks/` にタスク、ページ本文、引用、JSONLイベント、pi会話、回答を保存。`.runtime/goals/` に目標・選択・改訂・メッセージ・プラン、`.runtime/sandbox-plans/` に発行計画と成果物を保存します。`.env` / `.runtime` / `.pi` / node_modules / dist は Git から除外し、Docker context も allowlist に制限します。

単一調査の既定は70ステップ（モデル要求＋ツール呼び出し）、12ページ、600秒。目標内の初回実調査は各50ステップ・7ページ・210秒、こだわり再調査は1回・35ステップ・5ページ・180秒です。並列上限2は目標ごとの上限で、目標を横断する分散的な同時実行制御ではありません。

単一タスクの終了コードは成功0、部分回答2、失敗・時間切れ・候補なし1、中断130。`retry` は新規調査で、元会話の途中からの再開ではありません。強制終了の途中状態は Web 再起動時に interrupted とし、再計画します。

提供ツール以外の shell/ファイル編集をモデルに渡さず、公開HTTPS・許可host・固定DOM抽出コードで閲覧します。公開HTMLの転送先もホストと公開IPを検証し、スクリプトを実行せず、本文を4MiBで制限します。サイトのCAPTCHA・ログイン・制限を回避しません。予約・購入・応募はしません。

## 検証とレビュー

```sh
npm run check
npm test
npm run build
npm run test:ui
```

UI試験は Playwright を使います。既存 Chrome/Chromium を自動検出し、なければ `npx playwright install chromium`。`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` も指定できます。試験では APIキーを無効にし、隔離保存先で実行します。画面画像と結果は `.runtime/ui-qa/` に出力します。GitHub Actions に型・テスト・ビルドと、APIキーなしのUX試験を設定しています。

- [検証計画](docs/verification-plan.md)
- [検証結果と残課題](docs/verification-results.md)
- [参照実装と再現対応](docs/reference-ux.md)
- [PR説明](docs/pr.md)

参照: [agent-browser](https://github.com/vercel-labs/agent-browser)、[pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)、[OpenRouter無料モデル](https://openrouter.ai/docs/guides/routing/model-variants/free)、[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)、[Grok Bot](https://x.ai/bot)、[OpenMausBot](https://github.com/milind-soni/OpenMausBot)、[Rakazo](https://github.com/elie222/rakazo)。

## CLIの自己改善ループ

`run --self-improve` で初回の未達を診断・再計画・再実行・独立検証します。保存済みタスクは `improve TASK_ID`。既定3回、条件と必要件数は保持し、改善を採用するか旧情報を訂正した履歴を残します。許可した場合だけ `--allow-replacements` で別候補を探索します。公開情報で埋められない項目は `needs_input` として質問・選択肢を返します。

```sh
npm start -- improve TASK_ID --iterations 3 --timeout 600
npm start -- improve TASK_ID --allow-replacements --iterations 3
npm start -- improvements diagnose TASK_ID
npm start -- improvements list
```

楽天ブックスではCodexとpi/OpenRouter無料モデルの両方で、実際に初回未完了から改善1回で2冊・全10条件の比較へ回復しました。美容室のアイドル風根拠やSUUMO管理費は追加調査後も未確認が残り、未達ゼロを装わず停止しています。[仕様・CLI・実測結果](docs/self-improvement.md)。

## 正解ラベル・口コミ・回答満足度

8ケース28判定の凍結回帰ベンチマークと、口コミ指標・回答フィードバックを追加しました。ラベルは人の独立レビュー前の暫定版で、自由文全体の採点は別途必要です。同じ資料でCodex/Haikuを実行し、どちらも28判定が一致しました。

```sh
npm start -- benchmark check
npm start -- benchmark run --agent codex --json
npm start -- reviews TASK_ID --json
npm start -- feedback add TASK_ID --rating 4 --helpful yes
npm start -- feedback summary
```

口コミはサービスの評判、feedbackは回答への評価です。取得元・件数・期間を分け、口コミの星を回答の満足率へ変換しません。[仕様・評価の範囲・実測](docs/semantic-quality.md)。

## 3ペルソナの一日遊び提案を実行

```sh
npm run eval:day-out -- --agent codex --model gpt-6.1-sol --parallel 2
```

カップル・5歳児連れ家族・一人向けに、実サイトから提案・予算・雨天代替を生成します。実測は [一日遊びの提案結果](docs/day-out-results.md)。Codexのネイティブ入力/出力/キャッシュトークンと実行時間を保存し、サブスク費用の未配賦や中断時の観測不足を明示します。API追加課金0を総コスト0とは扱いません。
