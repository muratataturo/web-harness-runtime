# 自律調査CLI、承認型チームUX、OpenShell executorを追加

自然言語と候補URLを受け、pi + OpenRouter無料モデル + agent-browserで条件付き比較を返すruntimeを追加する。さらに「箱根の2泊3日」と「仕事・住居・車をまとめて考える暮らし」のWeb体験を用意し、目標を分担・並列調査・レビュー・再調査し、重要な好みを人の選択で決める流れを操作可能にする。

## 実装

- CLI: run/run-file、モデル・ソース一覧、状態・履歴・retry、5サービスの評価ケースとbrowser-only切り分け。
- 調査品質: 個別エンティティの判定、同じ候補への引用対応、一覧/制限画面の推薦拒否、引用修復の案内、無料枠切れの分類。
- Router: DAG検証、上限2の並列実行、未確認の前提を持つタスクのskip、タスクと目標の関連付け。
- 協調: 内部A2A envelope、メンバー/配送ID/hop検査、会話内の指摘と差し戻し。外部A2A規格への準拠はうたわない。
- 人の選択: 推奨案と2〜3択、トレードオフ、予算・追加のこだわり、改訂と承認履歴、停止、古い処理の結果書き戻し防止。
- UI: Grok Bot/OpenMausBot/Rakazoの公開画面を参照した、左Bot一覧・中央会話・右Computer。日本語、モバイル、キーボード、履歴復元。
- OpenShell: self-host gateway向けイメージ・provider・host限定policy・dry-run・sandbox発行・成果物回収・router executor。実キーをimageやsandboxへ保存しない。
- CI: Node22/24の型・テスト・ビルド、APIキーなしのブラウザ試験。

## 関連性と並列性

実装はCLI品質、OpenShell、参照UX、Router/Webを並行して進め、共通Task/RunOptions契約で統合した。実行時の並列性は目標ごとに制限する。旅行の宿・食事・観光は独立。暮らしの車は仕事と住居に依存。レビュー後の再調査は先行結果の後にだけ進める。control planeと承認はsandbox外に置く。

## 検証

- `npm run check`、`npm test`（55件）、`npm run build`、整形チェック。
- `npm run test:ui`: デスクトップ/390pxモバイルで8フロー。両シナリオ、好みの反映、再読み込み、改訂、停止、JSエラー0。
- `npm start -- eval --browser-only --case gourmet-kyoto-lunch`: 一覧→個別ランチ詳細2件を取得。
- `eval --retrieval-only --case jalan-hakone-onsen suumo-kosugi-rental`: 公開HTMLで一覧→詳細2件ずつを取得。
- `quota`: 無料残量と日本時間の次回リセットを表示。残量0ならruntimeは推論要求前に終了。
- Docker Linux arm64: image build、uid1000・秘密なし・network noneでCLI/Chromium起動とページ取得。
- sandbox発行計画のargv/policyと、timeout・出力上限・中断を実プロセスでテスト。

## レビュー時の重要な制約

このPRはUXを仕上げるためのMockと、実行基盤の段階実装。体験モードの施設・価格・レビューは架空。liveの横断レビューはルール検証で、交通/料金の統合最適化は実装していない。方針改訂は全再計画。

他サービスの回答品質を全面合格とはしない。グルメ/カーセンサーに加え、じゃらん/SUUMOも公開HTMLから詳細2件ずつを取得できた。取得方式・文字コード・HTTP状態を記録し、Windows-31Jのデコード、転送先とDNSの検査、非表示要素/スクリプトの除外を実装。以前失敗した宿/部屋の同じURLも取得を確認した。Indeedのアクセス制限は残る。実評価で無料日次枠に達したため、改善後のLLM完走は再評価が必要。有料へ切り替えていない。

self-host VM/gatewayが未指定のため、実OpenShell発行・credential rewrite・Landlock下のChromeは未検証。Docker起動と別の検証ゲートとする。sandboxは成果物回収後もretainする。

参照画面に似た会話構成を実装したが、認証後のGrok全機能の複製ではない。参照commitと再現/差分は [docs/reference-ux.md](reference-ux.md)、結果は [docs/verification-results.md](verification-results.md)、次の検証は [docs/verification-plan.md](verification-plan.md)。
