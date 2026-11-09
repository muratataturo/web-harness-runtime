# Grok Bot / OpenMausBot / Rakazo の参照確認と再現方針

取得日: **2026-11-10 JST**。公開ページ、公式リポジトリの README、画面画像、関連ソースを確認した。各製品へログインしての実機比較は行っていない。この資料の「確認」は公開資料またはコード上での確認を指す。

## 参照の固定点

| 参照 | 確認した版 | 一次資料 |
| --- | --- | --- |
| Grok Bot | 取得時の公式公開ページ。製品版・commit は公開ページから特定していない | [x.ai/bot](https://x.ai/bot) |
| OpenMausBot | `e164d34250a76f3d6c2acc87170ae8eb31335052` | [README](https://github.com/milind-soni/OpenMausBot/blob/e164d34250a76f3d6c2acc87170ae8eb31335052/README.md)、[hero 画像](https://github.com/milind-soni/OpenMausBot/blob/e164d34250a76f3d6c2acc87170ae8eb31335052/docs/screenshots/hero.png) |
| Rakazo | `e444d9df32b3cb40fecacfe36b566e6856432feb` | [README](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/README.md)、[グループ画面](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/docs/screenshots/readme/groups.png)、[Computer 画面](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/docs/screenshots/readme/computer.png) |

画像は目視確認した。ローカル参照用ファイルは `/tmp/maus-hero.png`、`/tmp/rakazo-hero.png`、`/tmp/rakazo-groups.png`、`/tmp/rakazo-computer.png`。リポジトリへの画像の転載はしていない。`x.ai/bot` は Web 閲覧ツールで本文を取得できたが、直接 curl では HTTP 403。Grok の認証後画面のスクリーンショットを取得できたわけではない。

## 確認できた体験

### Grok Bot 公式

[公式ページ](https://x.ai/bot) は、同僚へのメッセージのように依頼し、複数 Bot が並行して作業し、必要な承認時に戻ってくる体験を説明している。同じスレッドの Bot 間で仕事を引き継ぐ。Computer を通じた操作と、人が一度実演した作業を routine として扱う説明もある。

**重要な構成差**: 公式 FAQ では、Bot ごとに独立 VM を持つのではなく、ユーザー単位の永続クラウド Computer を全 Bot で共有すると説明されている。今回の「タスクごとに OpenShell sandbox を発行する」設計は意図的な差分であり、Grok と同じ隔離モデルとは記載しない。

### OpenMausBot の公開画面

[hero 画像](https://github.com/milind-soni/OpenMausBot/blob/e164d34250a76f3d6c2acc87170ae8eb31335052/docs/screenshots/hero.png) では黒基調の会話アプリ。左に検索と Bot の連絡先一覧、各 Bot に色付きの小さなキャラクター、中央にメッセージ、下に丸い入力欄がある。上部に Bot 名、モデル選択、タスク追加、Computer を開く導線。左下には自動化・接続機能・ユーザー設定を置く。

[ApprovalCard.tsx](https://github.com/milind-soni/OpenMausBot/blob/e164d34250a76f3d6c2acc87170ae8eb31335052/src/components/ApprovalCard.tsx) は待機、回答済み、期限切れを区別し、要求の見出し、詳細、保留理由、決定結果を表示する。[ComputerPanel.tsx](https://github.com/milind-soni/OpenMausBot/blob/e164d34250a76f3d6c2acc87170ae8eb31335052/src/components/ComputerPanel.tsx) はブラウザ・Computer・ファイル、および起動待ち・実行可能状態を分ける。単一の常時成功するアニメーションだけで稼働を表現する実装ではない。

### Rakazo の公開画面と協調

[グループ画面](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/docs/screenshots/readme/groups.png) では左に Bot とチーム、中央にチーム会話。人の依頼は右寄せ、Bot の発言は色付き名前とアイコンで区別される。会話中のメンションで調査を依頼し、別 Bot が文章化し、さらに別 Bot が照合する様子を示す。[Computer 画面](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/docs/screenshots/readme/computer.png) は独立パネルでブラウザ画面と操作権の引き取り導線を示す。

[承認 E2E テスト](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/apps/web/e2e/consequential-approval.spec.ts) では一回の許可、継続的な許可、拒否を分け、結果が会話に残り入力を再開できること、400px 幅で横にはみ出さないことを検証している。[group-handoff.ts](https://github.com/elie222/rakazo/blob/e444d9df32b3cb40fecacfe36b566e6856432feb/packages/adapters/src/group-handoff.ts) ではメンバーと実行状態の確認、冪等な配送キー、引き継ぎ回数の制御を確認した。公開 README で協調を説明していることと、実際のコード上の保護を区別して参照した。

## Web Mock の再現対応表（設計基準）

これは実装前の受入れ基準であり、すべて実装済みであるという宣言ではない。最終対応状況は PR 検証資料で判定する。

| 参照の特徴 | 今回再現する体験 | 今回の用途向けの追加・差分 |
| --- | --- | --- |
| 左の Bot 連絡先とチーム一覧 | 役割・色・状態を持つ roster と会話の切り替え | Router / Travel / Stay / Food / Reviewer 等 |
| 中央のチーム会話 | 担当者、引き継ぎ、進捗、根拠、レビュー指摘を同じスレッドで読む | 目標とタスク ID に関連付ける内部メッセージ |
| Computer の独立パネル | 右に閲覧対象・Browser/Tasks 等の切り替え | 実画面とシミュレーションを明示、未接続を稼働中と表示しない |
| 必要なときだけ承認を返す | おすすめ案・代替案・決定結果を会話内で扱う | 予算、旅の主役、宿の雰囲気等の楽しみ・こだわりを承認点にする |
| 他 Bot の作業を照合 | Reviewer の指摘→担当者へ差し戻し→再調査 | 距離、総額、日程、条件不一致、根拠不足を対象にする |
| 複数 Bot の並行作業 | 独立した宿・飲食・観光の調査を同時実行 | 承認・依存タスクが未完了の作業は止める |
| 継続する会話と成果物 | 目標、承認履歴、改訂、結果を再表示 | この Mock の保存方式と実本番の永続性を区別 |
| 共有 Computer / 多様な sandbox | sandbox の実行先と状態の表示 | 今回は OpenShell のタスク単位隔離を選択 |

色、余白、吹き出し、左一覧、中央会話、Computer への導線を参照する。ロゴ・キャラクター・文言・スクリーンショットをそのまま転用しない。提供された3製品には相違があるため、3製品のすべてにピクセル単位で一致する単一画面は定義できない。今回は公開画像から確認できる会話中心の構成と操作フローを再現対象とする。

## UX の受入れ観点

1. 初回画面から「誰に何を依頼するか」が分かり、旅行と人生設計の例を入力できる。
2. 作業が会話とタスク一覧の両方で追跡でき、選択・レビュー・再調査と通常の発言を見分けられる。
3. 承認カードはおすすめの理由、2〜3案のトレードオフ、未確認情報を示す。未選択のまま依存作業や確定を進めない。
4. 選択後は選んだ案・選択者・対象改訂を記録する。画面更新や二重クリックで異なる決定を二重適用しない。
5. 好みを変えた際は影響するタスクだけを再調査し、旧案と承認を黙って現行案に流用しない。
6. Bot 間のレビューは「よさそう」だけにせず、欠けた条件・根拠・改善依頼と、その対応を追跡できる。
7. 実サイトのアクセス拒否、モデルの失敗、sandbox 未接続を別々の状態として表示する。
8. モバイル幅でナビと Computer が会話を圧迫せず、キーボードでも承認・選択できる。
9. 価格・掲載情報は Mock の例示データか実際の取得情報か明示し、例示の旅程や人生案を実在の予約可能候補と見せない。
10. 購入・予約・応募の承認を、好みの選択と同一視しない。今回のスコープで実行しない外部操作は完了扱いにしない。

## 未確認・今回の実装が自動的に得ないもの

- Grok Bot 認証後の全画面、内部の Router、モデル構成、Bot 間通信仕様。
- OpenMausBot / Rakazo をインストールしての全機能実行、承認の通信・期限切れの本番挙動。
- 外部 A2A 標準との互換性。内部の型付きメッセージで協調しても、そのまま外部 A2A 準拠とはならない。
- 記憶の共有や自動学習の本番運用。Mock の状態保存はその代替にはならない。
- VM の発行、リモート画面配信、ログイン引き継ぎの実稼働。これらは OpenShell の接続・ポリシー・ホスト環境の別検証が必要。
