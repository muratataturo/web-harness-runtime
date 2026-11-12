# Codex MicroVM と既存 OpenCode × Strata

2026-11-10、本人によるVM内ログイン後、CodexのChatGPTサブスクで楽天ブックスの詳細取得・引用・構造化回答を完了しました。既存のOpenCode × Strataにも接続し、独立した調査セッションで回答しました。[実測データ](evidence/codex-strata.json)。

| エンジン | 調査プロセス | 推論・認証 | タスク間の扱い |
| --- | --- | --- | --- |
| Codex | OpenShell v0.1.7 / Apple Silicon MicroVM | 公式CLI 0.167.0、VM内のChatGPTログイン、gpt-6.1-sol | 専用worker wh-codexを直列で再利用、終了後stop、認証ディスク保持 |
| OpenCode | ホスト上の独立プロセス、VM隔離なし | 既存1.19.5 → Strata Colab L4、strata-colab/qwen3.8-flash-next-iq2_xs | 調査ごとに専用HOME/DB、元の会話を変更しない |
| pi / OpenRouter | OpenShell MicroVM | gatewayの専用provider、無料モデルのみ | 従来どおり調査ごとにsandbox発行 |

## Codexで実行

ローカルgatewayのsetup/start/registerは[既存の手順](runtime-modes.md)を使用します。既存の認証済みVMを削除・再作成する必要はありません。

```sh
npm run build
docker build --provenance=false -f infra/openshell/Dockerfile -t web-harness-runtime:local .
docker build --provenance=false -f infra/openshell/Dockerfile.codex -t web-harness-codex:local .
npm run sandbox:local -- codex-setup
# 初回のみ。公式device-code画面で本人がログイン。
npm run sandbox:local -- codex-login

npm run sandbox:local -- run-codex run \
  'この本の書名・著者・価格・ISBNを引用して教えて' \
  --url https://books.rakuten.co.jp/rb/18577690/ --mode auto --json
npm run sandbox:local -- run-codex run \
  'この本は著者本人の直筆サイン付き？記載がなければunknownを保持して' \
  --url https://books.rakuten.co.jp/rb/18577690/ --mode approval --json
npm run sandbox:local -- run-codex improve TASK_ID --mode auto --iterations 1 --timeout 240 --json
npm run sandbox:local -- run-codex web
```

通常CLIでは RUNTIME_EXECUTOR=openshell、RUNTIME_AGENT=codex、OPENSHELL_GATEWAY、OPENSHELL_BINを設定すると同じexecutorを使います。モデル指定が利用可能一覧にない場合やChatGPT認証がない場合は停止し、ホスト・APIキー・別providerへ切り替えません。購入・予約は実施しません。

workerのホスト側leaseで同一アカウントの同時実行を防ぎ、Goal Routerの調査並列数も1にします。piの「毎回新規VM」と同じ分離単位ではありません。異なるアカウントを共有するworker用途は想定していません。lease所有プロセスが異常終了した場合は、所有PIDと実行状態を確認してから当該leaseを手動で復旧する必要があります。

公式CLIの認証ファイルはゲストの /sandbox/.codex に残し、ホストの認証ファイルをコピー・取得しません。結果のdownload対象はタスクごとの /sandbox/results/UUID のみです。コード更新はdist/*.js、Web静的3ファイル、trusted URL設定、秘密を含まない合成package.jsonのallowlistをアーカイブ化して転送します。ファイルハッシュと依存SDKのversion/integrityを照合し、認証済みVMを作り直さずバージョン別ディレクトリから実行します。依存SDK変更時は対応するイメージ更新が必要です。

Codexのホスト実行は従来のread-onlyです。管理されたゲスト内だけ公式App Serverの externalSandbox を指定し、OpenShellのLandlock・非root・送信先/実行バイナリ制約を外側の隔離として使用します。公式パッケージのJSラッパーからnative本体を起動し、隣接するcodex-code-mode-hostを利用します。native本体だけを別パスへコピーして調査起動するとツールが起動せず、当初の失敗原因になりました。

## Strataの起動管理と既存接続

Colabの割当・モデル起動・鍵回収・SSH転送・無操作停止を行う`strata` CLIを追加しました。[新しい起動・接続ガイド](strata-colab.md)を参照してください。以下は既存endpointを利用する従来の構成と当時の実測です。通常の調査コマンドではGPUを自動割当しません。

### 既存Strataで実行

```sh
npm start -- models --agent opencode
npm start -- doctor --agent opencode
npm start -- run 'この本の書名・価格・ISBNを引用して教えて' \
  --agent opencode --url https://books.rakuten.co.jp/rb/18577690/ --mode auto --json
```

既存の /private/tmp/strata-opencode/node_modules/.bin/opencode、http://127.0.0.1:18081/v1、/private/tmp/strata-colab-api-key を既定値として利用します。環境差分は .env.example の OPENCODE_BIN / OPENCODE_MODEL / STRATA_BASE_URL / STRATA_KEY_FILE で設定できます。鍵をリポジトリやコマンド引数に書きません。

元のOpenCodeセッションへattach/continueしません。既存GPUを新規割当・再起動せず、モデル一覧に完全一致するモデルとコンテキストサイズを確認します。元の監視・idle停止設定も変更しません。専用設定はstrata-colabのみ許可し、--pureで外部プラグインを無効化、shell/ファイル操作/webfetchを禁止します。ランダムbearerで保護したloopback MCP経由で共通調査ツールだけを提供します。schema検証・実行直列化・同一request IDの重複排除を行います。

## 実測

すべて同一の楽天ブックス商品詳細URLを使用しました。性能比較ベンチマークではなく、認証・実取得・回答・不明点処理の動作確認です。

| 実行 | 結果 | 時間 | トークン（入力 / 出力 / 合計） |
| --- | --- | --- | --- |
| Codex MicroVM / Auto | succeeded、4項目・4引用。るるぶ 箱根 '27、JTB編集部、1,430円、ISBN 9784533172731 | guest 24.465秒、準備・回収36.780秒 | 60,780 / 682 / 61,462（入力内cache25,472） |
| Codex MicroVM / Approval | partial → needs_input。価格は確認、直筆サインはunknown | guest 22.829秒、準備・回収35.716秒 | 60,361 / 608 / 60,969（入力内cache42,752） |
| OpenCode × Strata / Auto | succeeded、1冊の詳細・5引用 | 87.097秒 | 初回はusage集計追加前で未記録 |
| OpenCode × Strata / Approval | partial → needs_input。価格は確認、直筆サインはunknown、5引用 | 48.353秒 | 112,676 / 1,389 / 114,065（入力内cache99,962） |

Codex MicroVMのAuto＋自己改善1回も実行しました。初回と子タスクの両方が同じworker内で取得・回答し、いずれも停止を確認。合計68.374秒（各VM実行の準備・回収を含む）、124,669トークンでした。追加取得可能なリンクがなくサイン条件は埋まらず、改善していない子回答を採用せず最良結果を保持。`completed_partial`・`questions: []`・承認なしで返しました。VM内の自己改善実行を、未達条件の解消とは区別しています。

Approvalは「未確認を明記して受領」「同じ条件で追加調査」「同一候補の公開URL追加」を保存し、推奨案・理由・追加時間上限を返します。OpenCodeではfinish_task受理後の最終文章用step_startが確定済みタスクを失敗扱いにする不具合を修正し、回帰テストと再実測で確認しました。

Codexの追加API課金は$0として記録しますが、サブスク固定費配賦・追加クレジット消費額は取得していません。Strataは既存GPUの稼働時間/クレジット消費額が未取得で、費用は不明です。設定上の単価0を実費0とは扱いません。Codexはthread累計、OpenCodeは重複排除したstep usageの和で、cacheは入力の内数です。

## 検証と限界

型検査、152テスト、ビルド、Webの11フローでプロトコル・認証拒否・無断fallback禁止・ツール重複排除・使用量集計・Auto/Approval・モバイル表示を確認しました。ライブ接続はCIに秘密を渡さず、ローカルの実測データとして分けています。

MicroVMで今回成功した取得経路は公開HTMLです。agent-browser/ChromiumのDOM取得は以前のCDP/zygote問題が残り、DOM必須URLへの対応完了とは扱いません。OpenCodeのVM実行、ClaudeのVM内サブスク実行、amd64/remote gateway、多アカウントworker、ディスク累積上限は未検証または未実装です。

公式仕様: [Codex認証](https://learn.chatgpt.com/docs/auth)、[App Server](https://learn.chatgpt.com/docs/app-server)、[OpenCode provider](https://opencode.ai/docs/providers)、[OpenCode CLI](https://opencode.ai/docs/cli/commands)。
