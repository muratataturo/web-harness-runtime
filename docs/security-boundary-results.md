# 境界強化の実装・検証結果

後続で[チャットUI経由の両family実測と必須ゲート](chat-runtime-acceptance.md)も完了した。以下の境界強化時点の記録と区別し、最新の通常テストは190件成功。

2026-11-13 JST。[設計](security-boundary-design.md)に基づき、単一利用者向けのRecruit／Rakuten公開調査を実装・検証した。**強化モードの通常実行とOpenShell MicroVM実行の両方で、Recruit／Rakutenの公開調査、成果物回収、ホストの独立照合が成功した。GET許可とPOST・未許可host・metadata・許可外pathの拒否も実機で確認済み。** [機械可読記録](evidence/security-boundary-results.json)。

## 実装した境界

| 対象 | 実装 |
| --- | --- |
| 固定権限 | `runtime-profile.ts`でservice／host／pathを固定。`recruit`／`rakuten`指定時は別familyを拒否。profileはfreezeし、ページ本文やAutoの判断で広げない |
| 取得操作 | 既定の`hardened`は公開HTML専用。任意header、cookie、認証、POST、認証・予約・購入・応募等のpath、不正queryを拒否。HTTP拒否をbrowserで回避しない |
| 接続先 | IPv4／IPv6の特殊用途・不正アドレス、混在DNS回答を拒否。direct HTTPSは検証済みのDNS snapshotをsocket lookupに使い、元hostのTLS証明書を検証 |
| OpenShell policy | source用Nodeに固定pathのGET／HEADのみ。`protocol: rest`、`enforcement: enforce`、public CIDRを設定。Chromiumの許可はdevelopment限定 |
| 管理された通信 | OpenShell guestではsupervisorの合成DNSと標準HTTP処理を使い、実接続先のpublic CIDR・L7検査をgatewayで強制。明示proxyも管理worker専用。TLS検証は維持 |
| 成果物 | 実行nonceをtask IDに使い、query／URL順序／agent／profile／予算を照合。完全な主要schema、8MiB上限、走査件数、symlink／hardlinkを検査 |
| 引用・回答 | guestのscore／eligible／retrievalを再計算。公開HTMLの引用元と候補ページをホストで独立再取得し、実本文にない引用を拒否。metricsは形式検査したguest申告値として保持 |
| プレビュー | ソースごとの固定asset hostと全redirect検査。安全な画像形式・容量だけを保存。旧policyのキャッシュを強化モードで再利用しない。画面描画は提供しない |
| 提供範囲 | `RUNTIME_DEPLOYMENT=single-user`専用。別値は起動時に拒否。`security status`で取得方式と対応範囲を表示 |
| 起動前確認 | `sandbox:local preflight`と`run`／`run-codex`でDocker応答を5秒上限で確認。利用可能容量も表示し、Docker無応答時はVM／modelを開始しない |

`Task.security.policyHash`はアプリケーションの固定profile制約のfingerprintであり、gatewayが返すeffective policy hashそのものではない。VMに適用されたpolicyの実測は別の確認項目になる。

## 実調査

公式Codex CLIの既存ログインを利用し、executorを明示的に`local`として実施。VM失敗時に自動fallbackした結果ではない。予約・購入・問い合わせ・応募・対象サイトへのログインは実施していない。

| family | 対象 | 結果 |
| --- | --- | --- |
| Recruit | Hot Pepperグルメ：まいかアトレ上野店の店舗・ランチ詳細 | `succeeded`、2ページ、引用6件。店舗情報・掲載ランチを取得。当日の営業・空席は未確認 |
| Rakuten | 楽天ブックス：るるぶ 箱根 '27 | `succeeded`、1ページ、引用3件。書名、出版社、税込掲載価格1,430円を取得 |

両成果物のコピーに実行nonceを付けた取込試験も行い、ホストの独立再取得と引用照合を両方で通過した。これは取込処理のライブ検証であり、VM実行の証拠ではない。2ケースから全サービスの動作率や性能分布は推定しない。

## 自動検証とimage

- `npm run build`、`npm run check`、`npm run format:check`、`git diff --check`が成功。
- 全188テスト成功。境界テストはfamily不一致、suffix偽装、encoded action path、不正query、DNS切替、public CIDRとの整合、偽造引用、独立取得本文の不一致、過去nonce、不正schema、symlink、巨大成果物、browser未起動を含む。
- 既存ローカルimageをベースに`infra/openshell/Dockerfile.release`で`web-harness-codex:boundary`のビルドが成功。秘密・認証・個人履歴をcontextに含めない既存allowlistを利用。
- 最終policyは、nested pathと大文字小文字を扱うREST deny ruleを含み、OpenShell prover v0.1.7が`unsupported_policy_shape`を返す。形式検証済みとはしない。実gatewayへの適用・L7拒否・アプリ回帰テストを検証根拠とする。

## OpenShell上の最終実測と復旧

新imageのrootfs展開は当初、ホスト容量不足で失敗し、続いてDocker APIが無応答となった。ユーザー承認後にDocker Desktopを再起動して復旧し、キャッシュ済みimageと最新の検証済みsnapshotで実測を完了した。localへの自動fallbackは行っていない。

| family | 実行場所 | 結果 | 根拠 | 起動・回収・独立照合込み |
| --- | --- | --- | --- | --- |
| Rakuten | Codex account-worker / OpenShell MicroVM | succeeded | 楽天ブックス1ページ・引用3件 | 37.431秒 |
| Recruit | Codex account-worker / OpenShell MicroVM | succeeded | Hot Pepper店舗・ランチ2ページ・引用6件 | 47.062秒 |

両実行のruntime revisionは`def0cd91648cfd917590338c`。nonceとtask IDを照合し、ホストで引用元を独立再取得してから保存した。単発実測であり、全サービスの動作率やp50／p95の性能保証ではない。modelの利用量はJSONに記録したが、サブスク固定費やVM費用を含む総費用は未計測。

認証providerを持たない別のprobe MicroVMでも、両sourceの正しい詳細本文をHTTP 200で取得した。source許可外pathはHTTP 403、未許可hostとmetadataはEACCESとなり、OCSFのdeny記録を保存した。POSTは実サイトへ送信せず、固定JSONを返すだけのローカルfixtureで検証。GETは200、POSTはgatewayのL7で403となり、fixtureの受信記録はGETだけだった。一時fixture許可は試験後に削除した。

実機で判明し修正した点：

- OpenShell MicroVMのDNSは`198.18.0.0/15`の合成アドレスを返す。管理guestの識別条件が揃う場合だけrelayとして扱い、実接続先の許可CIDRにはこの範囲を追加しない。ホストや通常プロセスでは引き続き拒否する。
- OpenShellのpath matcherでは`**`がsegment全体を占める場合だけ`/`を跨ぐ。サービスprefixを単一segmentと子孫pathに展開し、アプリの判定も同じ解釈へ揃えた。
- 独自HTTPS transportとTLS検査経路の組合せで楽天ブックスがsoft 404になった。同じheaderの標準HTTP処理との比較で互換性の問題と切り分け、管理OpenShell内では標準処理を使って正しい本文を取得した。ホストのdirect HTTPSは接続時IP固定を維持する。

合成DNSとmatcherの仕様は[公式policy解説](https://docs.nvidia.com/openshell/latest/sandboxes/policies)、[v0.1.7 matcher仕様](https://docs.nvidia.com/openshell/v0.1.7/how-it-works/policies/schema)を参照。広域public CIDRについてgatewayが警告を出すが、exact hostで限定し、非公開・特殊用途IPはCIDR集合から除外している。任意hostや内部接続を許可する構成ではない。

既存`wh-codex`は両試験後にstopを確認し、認証を含む保持diskは残した。今回のprobe sandboxとローカルfixtureは削除・停止済み。無関係なimage、container、cache、個人データは削除していない。

## 実行手順

```sh
npm run build
npm start -- security status

# 固定権限の確認。外部接続・VM発行なし
RUNTIME_PROFILE=recruit npm start -- security plan --url https://www.hotpepper.jp/strJ001100102/
RUNTIME_PROFILE=rakuten npm start -- security plan --url https://books.rakuten.co.jp/rb/18577690/

# 通常実行。公式CLIのログインが必要
RUNTIME_PROFILE=rakuten RUNTIME_EXECUTOR=local npm start -- run-file examples/rakuten-books.json --mode auto --json
RUNTIME_PROFILE=recruit RUNTIME_EXECUTOR=local npm start -- run-file examples/recruit-day-out.json --mode auto --json

# OpenShell基盤の稼働確認と明示実行
npm run sandbox:local -- preflight
RUNTIME_PROFILE=rakuten npm run sandbox:local -- run-codex run-file examples/rakuten-books.json --mode auto --json

npm run security:check
```

`development`は従来のbrowser取得を調べるための明示設定。強化modeの失敗時に自動で使わない。共有SaaS、認証workerと取得workerのOS分離、外部TTL回収、Fabric adapter、全16サービスの再評価は今回の対応範囲に含めない。NeMo Fabricは実行契約の統一が必要になった段階で追加し、現在の境界実装の必須依存にはしない。
