# 複数coding agent対応の自律調査CLI・承認型UX・trusted URL検証基盤

自然言語と候補URLから個別対象を調査し、引用付きの比較と未確認事項を返すruntimeを追加する。CodexのChatGPTログイン（既定）、Claude CodeのSonnet 5.5 / Haiku 5.5、pi × OpenRouterの無料モデルを同じ調査・完了判定へ接続する。旅行や仕事・住居・車の目標を分担し、好みを人が選びながら進めるWeb体験も用意する。

## 実装

- CLIのrun/run-file/retry/eval/trusted runとWebのlive実行でエンジンを選択。Codexは公式App Server、Claude Codeは公式CLIと専用MCPで連携し、APIキーや別モデルへ自動fallbackしない。
- 個別対象・領域別必須詳細・引用の本文一致を検証。情報不足は同一対象の子ページと公開HTMLの描画で追加調査し、既定2ラウンド・追加4ページで打ち切る。埋まらない条件はunknown/partialとして返す。
- 楽天市場の価格は対象URLに一致する一意のProduct/Offer Microdataも使用。価格帯とSKU確定価格・送料・在庫を区別し、クーポンや関連商品額を採用しない。美容の必須アイドル条件とSUUMO管理費「-」の扱いも補強する。
- trusted URLはL0〜L4の取得レベルを証拠から計算。L3以上の個別URLのみを7日有効で登録し、再検証失敗は除外する。台帳はロック・atomic更新・新旧検査で保護。現在12サービス24URL（L3:4 / L4:20）。L4は追加情報量を表し、予約可能性や条件適合は保証しない。
- Goal RouterはDAGに沿って最大2タスクを並列実行。旅行の宿・食事・観光は独立、暮らしの車は仕事・住居へ依存する。内部A2Aの配送検査とレビュー後の再調査を備える。
- Web MockはBot一覧・会話・Computerの構成、推奨案と選択肢、好み・予算の改訂、承認履歴、停止、履歴復元、日本語・モバイル操作に対応。
- OpenShellはself-host gateway用イメージ・provider・host限定policy・計画・発行・成果物回収を備える。control planeと人の承認はsandbox外に置く。

## 自己改善ループ

CLIに `run --self-improve` / `improve TASK_ID` と診断・履歴を追加。元の条件と必要件数を固定して未達を診断し、未読リンクを先行取得、調査予算を調整して再実行、本文と引用から独立検証する。確認済み条件を失う結果は拒否し、根拠付きの旧情報訂正は保存。代替候補探索は明示指定時のみ許可する。成功した同一目標の調査手順だけを次回再利用し、各回は再取得する。quota/中断/時間/停滞で停止し、解決できなければ要確認事項を返す。

Codex・楽天ブックスは6ステップで初回未完了を再現し、改善1回で2冊の10条件を確認。pi/OpenRouter無料でも同じ未完了から改善1回で回復し、検証済み手順を再利用した。Sonnet/Haikuの美容室・SUUMOも実行し、未公開根拠・管理費不明は残った。SUUMO代替探索で見つかった徒歩10分/19分の矛盾と同一部屋の別掲載を、最終独立検査で検出する。[仕様と実測](self-improvement.md) / [記録](evidence/self-improvement.json)。

## 意味判定・口コミ・回答満足度

8ケース28判定の正解ラベル付き凍結回帰セットを追加。正解をモデルに渡さず、同じ調査ツールと閉じたReplayBrowserで判定する。正解率、Macro F1、断定の精度、unknown再現率、引用とケースの合格率を記録。Codex/Haikuの実モデルで修正後の全28判定が一致。設問の曖昧さで初版に1件差が出た校正履歴も保存する。ラベルは全件暫定で独立人手レビュー0件、自由文全体の意味評価は未実装と明記し、一般化精度100%とはしない。

口コミはHot Pepper Beauty/楽天トラベルの平均・表示件数・出典・取得日時を抽出する参考指標。期間の異なる件数で統計的信頼度や満足率を捏造しない。回答への明示評価は別のfeedback CLIへ保存し、口コミやベンチマークを混ぜない。実フィードバックは0件で集計はnull。[仕様と実測](semantic-quality.md)。CI/コンテナに推論不要のデータ検証を追加。

## 3ペルソナの一日遊び提案と実測

同じCodexモデルでカップル・5歳児連れ家族・一人向けの実サイト調査を実行。初回に加えて各1回の自己改善も試行し、元の提案を保持。提案は3件生成したが、2件needs_input・1件は追加調査がtimed_out。全体509.209秒、受信した合計トークンは1,449,031以上。入力・出力・キャッシュ・中断時の観測範囲を記録し、API追加課金0とサブスク配賦未算定を区別する。未来館の全館休館を認識して除外した。新しい公式施設/飲食ページの取得契約を限定したURL形式で追加。再現CLIは `eval:day-out`、[実測・提案全文](day-out-results.md)。

## Auto / Approval と実OpenShell MicroVM

CLIの通常実行・自己改善・実サイト評価を共通executorに統一。OpenShell指定を無視してホストへ実行する経路を修正し、発行・回収を確認できなければ停止する。query/URL/終端状態に加えgatewayが返す実sandbox IDを記録する。終了・中断後はsandboxをstopしてディスクを保持し、停止を確認できなければ明示する。

`--mode auto`は推奨を自動選択し、未確認を保った部分回答を承認待ちなしに返す。`--mode approval`は推奨案・影響・時間予算と保存された選択IDを返し、選択後に同じ条件/実行先で再開する。Webの方針/楽しみポイントにも両モードを適用し、CLIの確認待ちもWebから操作可能。古い選択・二重実行・無断の条件緩和を防ぐ。

ローカルMicroVMで楽天ブックスのAuto完走と、押上一日遊びのApproval→needs_inputを実測。同じ一日遊びをAutoとして追加推論なしに再診断するとcompleted_partial・質問なし。無料モデルが計画前に引用を保存して再計画不能になる不具合も実機で発見・修正。Piの入力/出力/cacheトークンを保存する。[仕様・CLI・実測と限界](runtime-modes.md)。以前の3ペルソナのCodex実測はホスト実行と明記する。未来日営業時間や費用未確認の自由文は完成扱いにしない。

## 検証

- 型検査、145テスト、ビルド、整形チェック。CIはNode22/24とブラウザ試験を実行し、実ログインや推論キーを不要にする。
- Webのデスクトップ/390pxモバイルで11フローを確認。Dockerは非root・ホスト秘密情報なし・network noneでCLIとChromiumの起動を確認。
- Recruit/楽天16サービスを取得検証。詳細を取得できた12サービスを登録し、Indeedの制限・楽天不動産の認証・楽天中古車の終了・Careersの詳細未対応は登録しない。
- Sonnet 5.5で楽天トラベルを比較し、サロンのスタイル詳細も追加調査。Haiku 5.5で楽天市場を比較し、SUUMOの不明管理費は未確認を維持。回復したpi/OpenRouter無料枠でもRecruitグルメ・楽天市場を完走。共通機能追加後のCodexは楽天ブックスで回帰確認。
- 全16サービスのCodex実測と、今回の7件の代表実測はそれぞれ記録する。全サービス×全モデルの品質合格とはしない。

## 制約と確認資料

Web体験モードの施設・価格は架空。横断レビューはルール検証で、交通や料金の統合最適化は未実装。外部A2A規格への準拠は主張しない。公開画面を参照した会話構成であり、Grokの認証後機能全体の複製ではない。

Codex/Claude Codeはローカル実行のみ。OpenShell経由はpi/OpenRouterに限定し、他エンジンは発行前に拒否する。Apple Silicon Macの実OpenShell MicroVMでpi/OpenRouter無料モデルの取得・推論・成果物回収を確認。Linux amd64・remote gatewayの実行は未検証。MicroVMのChromium DOMはCDP/zygote制約で失敗し、成功した実調査はpublic-html経路に限定。外側の隔離は緩めていない。

追加調査後も意味的な条件判定にはモデルの誤りが残り得る。価格帯はSKU価格、空室や在庫の確約ではない。探索で見つかった誤りと修正・再実行も記録する。

- [エンジン・深掘り・レベル・代表実測](engines-and-depth.md) / [実行記録JSON](evidence/engines-and-depth.json)
- [trusted URLの取得検証](trusted-urls.md) / [Codexの16サービス実測](codex-family-results.md)
- [検証結果](verification-results.md) / [検証計画](verification-plan.md) / [参照UXとの差分](reference-ux.md)
