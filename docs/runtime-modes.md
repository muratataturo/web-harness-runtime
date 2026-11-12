# Auto / Approval と実 sandbox 実行

以前の3ペルソナの一日遊び実測は、ホスト上のCodex CLIで実行したものです。Codexのread-only設定を、OpenShellやVMの隔離と同一視しません。今回、Apple Silicon MacでOpenShell v0.1.7の`compute_driver = "vm"`を起動し、pi/OpenRouter無料モデルを使う実MicroVMで取得・推論・回答・成果物回収を確認しました。router、承認状態、独立検証、成果物Storeは信頼するホストに置き、各調査と自己改善の子タスクを別sandboxへ割り当てます。

## 2つの進め方

| 設定 | 実行中の判断 | 上限後に未確認が残る場合 | 次の操作 |
| --- | --- | --- | --- |
| `--mode auto` | 指定条件内で推奨を自動選択。選択者はruntimeとして記録 | `completed_partial`、質問なし、承認待ちなし。未確認と制約を保持 | 回答を受け取る。必要なら別途再調査 |
| `--mode approval`（既定） | Webの方針・楽しみポイントで推奨、説明、影響を表示 | `needs_input`と保存された承認ID・選択肢を返す | 未確認を明記して受領／同じ条件で再調査／同一候補の公開URL追加 |

Autoは「全条件を達成したことにする」モードではありません。必須条件や必要件数を削らず、unknownをsupportedに昇格しません。認証・無料枠・アクセス拒否・キャンセルはエラーや停止として返します。Approvalも、選択が不要な完全回答には待機を作りません。タスクレベルの選択と、Codex/OpenShellのセキュリティ権限承認は別です。Autoでもネットワーク許可や購入・予約を自動承認しません。

`run --mode approval`の部分回答は、個別候補と評価条件があれば追加推論なしに承認を作ります。`--self-improve`を付けた場合は、先に指定予算内の追加調査を行います。保存タスクは`improve --diagnose-only`で推論せず再診断できます。追加調査を選ぶ場合は、表示された回数・時間の新しい予算で子ループを作り、親ループ・元条件・エンジン・モデル・実行先を維持します。IDが古い承認や異なる選択の再送を拒否し、同一決定の再送はモデルを再実行しません。実行中の決定はロックします。プロセスの強制終了でロックが残った場合の自動復旧は未実装です。

```sh
# ホスト上のCodex。VM実行とは区別されます。
npm start -- run '調べたいこと' --url https://books.rakuten.co.jp/rb/18577690/ --mode auto --self-improve
npm start -- improve TASK_ID --mode approval --diagnose-only --json
npm start -- improvements show LOOP_ID --json
npm start -- improvements decide LOOP_ID --approval APPROVAL_ID --choice return_partial --json
# research_more / add_url を選ぶ場合だけ、追加調査の利用枠を使用します。
npm start -- improvements decide LOOP_ID --approval APPROVAL_ID --choice add_url --url PUBLIC_DETAIL_URL --json

# Webの進め方（体験／実調査とは独立した設定）。
npm start -- goal create --scenario travel --mode auto
npm start -- goal create --scenario travel --mode approval
```

Webでは新しい相談の「進め方」でAuto/Approvalを選択します。自動選択の履歴は「Autoで自動選択」、本人の承認は「あなたが選択」と表示します。CLIの`needs_input`は左メニュー「調査の確認待ち」で表示できます。推奨案は選択済み表示でも、ボタンを押すまで承認されません。追加URLの入力欄はその選択時だけ表示し、通常は1クリックで部分回答を受け取れます。モバイルはメニューから開きます。

## ローカルMicroVMの起動と利用

実検証はApple Silicon macOS、Docker Desktop、OpenShell v0.1.7、Pi 1.5.0を使用。公式releaseのCLI/gateway/VM driver/proverをSHA-256照合して`.runtime`配下へ導入します。VM driverの署名は公式Homebrew手順と同じhypervisor entitlementをローカル付与します。gatewayはloopbackと専用mTLS証明書を使用し、公開ポートやホストディレクトリのguestへのmountは追加しません。

[公式MicroVM driver説明](https://docs.nvidia.com/openshell/v0.1.7/how-it-works/sandboxes/runtimes)、[公式Pi provider設定](https://docs.nvidia.com/openshell/v0.1.7/tutorials/run-pi-with-openrouter)に従います。OpenShellの汎用OpenRouterサンプルはOpenCode向けの許可パスなので、このrepoの`provider-openrouter.yaml`を使います。

```sh
# 初回のみ。この検証環境では導入・登録済みです。
brew install e2fsprogs
npm run build
docker build -t web-harness-runtime:local -f infra/openshell/Dockerfile .
npm run sandbox:local -- setup
npm run sandbox:local -- start  # このターミナルでgatewayを維持

# 別ターミナル。初回のみregister / init-provider。
npm run sandbox:local -- register
npm run sandbox:local -- init-provider
# .envのキーをgatewayへ登録。キーはargv/imageへ入れません。

npm run sandbox:local -- run run '調べたいこと' --url https://books.rakuten.co.jp/rb/18577690/ --mode auto --json
npm run sandbox:local -- run improve TASK_ID --mode approval --iterations 1 --timeout 120 --json
npm run sandbox:local -- run web
```

最後のWeb起動なら、保存済みsandboxタスクの追加調査も同じgatewayへ再開します。通常のローカルWebからsandboxタスクの追加調査へ暗黙に切り替えません。受領だけの`return_partial`は推論しないため実行先設定なしでも利用できます。`RUNTIME_EXECUTOR=openshell`を指定した通常CLI、自己改善、Goal Router、実サイトの評価スクリプトは共通executorを使い、未接続や未対応エンジンならホスト実行に逃げず停止します。

結果の`execution`に`target`、sandbox名、gatewayから取得した実ID、image、回収場所、準備・回収・停止込みの時間を記録します。発行確認またはdownloadを確認できなければ取り込みません。回収後はVMをstopしてディスクと成果物を保持します。停止を確認できない場合は`cleanupStatus: unconfirmed`と操作案内を残します。sandboxの削除は別操作です。VMは2 vCPU・4GiB、overlay 8GiBを使用し、保持するディスクの累積上限は未実装です。

**CodexのVM内サブスク認証と実調査を追加しました。** [専用workerの起動・実測](codex-strata.md)。ホストから資格情報をコピーせず、本人がVM内で初回ログインします。piの都度発行とは異なり、Codexは認証を保持する同一VMを直列で再利用し、各タスク後に停止します。Claude Code / OpenCodeのOpenShell実行、Linux amd64・remote gateway・並列VMの障害注入は実測対象外です。以下の既存pi実測とは別記録です。

## 実測結果（2026-11-10）

[機械可読の記録](evidence/runtime-modes.json)。いずれも予約・購入なし。

| 実行 | 結果 | 時間 | トークン | API追加課金 |
| --- | --- | --- | --- | --- |
| MicroVM / Auto / 楽天ブックス1冊 | `succeeded`。書名・著者・1,430円・ISBNを引用確認 | guest 16.386秒、発行～回収52.287秒 | 入力49,710、出力2,123、合計51,833。入力内cache 13,008 | $0 |
| MicroVM / Approval / 押上一日遊び | `partial`→`needs_input`。2,700円の入場料と仮予算合計5,600円。11/14営業時間はunknown | guest 167.775秒、発行～回収169.723秒 | 入力336,164、出力17,192、合計353,356。入力内cache 234,144 | $0 |
| 同じ一日遊びのAuto再診断 | `completed_partial`、`questions: []`、承認なし、追加調査0回 | CLI全体711ms | 追加推論0。上の353,356を再度計上しない | $0追加 |

モデルは`nvidia/nemotron-3.5-super-vl:free`。これは異なるクエリとcache状態の機能確認であり、モード間の性能比較実験ではありません。トークンはPiのprovider応答に基づくsession合計。cacheは入力の内数で、推論トークンの内訳は不明です。将来日の営業時間、空き、在庫や推奨全体の意味的正確性を保証しません。特に一日遊びの自由文には「スカイツリー展望等」という未計上の有料体験を含み得る表現が残り、そのまま予算内の完成プランとして採用しません。改善・確認対象として生の回答と一緒に記録しています。

初回の汎用providerによる通信失敗、VMの書き込み先不一致、計画前の引用保存による再計画不能も記録します。修正では条件を定義する前の引用保存を拒否して回復可能にし、変更されていない計画の再送を冪等にしました。成功した実測だけを残す扱いにはしていません。

## 最終再確認と残る制約

最終版の新規実行は無料枠`0/50`を検出し、推論を送らず停止。gatewayの実IDを確認して失敗タスクも回収し、`cleanupStatus: stopped`を記録しました。APIが返した次回回復は2026-11-11 09:00 JSTです。成功済みの上記2実測を、この最終失敗で置き換えてはいません。

MicroVM内のagent-browser/Chromiumを別のdata URLで検証すると、現在のOpenShell制約下では`CDP response channel closed`で失敗しました。Chromiumのzygote権限制約とmemfd拒否を確認し、single-processやguest内/proc読み取りの限定追加でも解消しませんでした。これらの試験変更は本番policyへ入れず、外側の隔離を緩めていません。**今回成功した調査はpublic-html経路で、MicroVMのChromium DOM取得は未達です。** DOMが必要なURLまでVMで取得可能とは主張しません。ホストのtrusted URLレベルもVMでの実行可否の証明にはならず、各タスクで新たに取得・検証します。

型検査・145テスト・整形・ビルドと、Webの11フロー（デスクトップ/390pxモバイル）でAutoの無待機、Approvalの保存/再開、URL欄の条件表示、再読み込み後の履歴を検証しました。
