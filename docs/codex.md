# CodexのChatGPTログインで動かす

既定エンジンを公式Codexに変更した。pi + OpenRouterは `--agent pi-openrouter` で引き続き利用できる。Codexは公式CLIの保存済みChatGPTログインを使用し、資格情報の抽出・コピーやOpenAI APIキーへの切り替えは行わない。

## 起動

Node.js 22以上、公式Codex CLIをインストール済みであること。動作確認したCLIは0.167.0。

```sh
codex login
npm ci
npm run browser:install
npm run build
npm start -- codex-doctor
npm start -- doctor
npm start -- models
npm start -- trusted run 'この2宿を所在地・総部屋数・浴場で比較して' --source rakuten-travel
npm start -- run '渋谷駅から徒歩5分以内で髪質改善と韓国アイドル風に対応する美容室を2件比較して' \
  --url https://beauty.hotpepper.jp/svcSA/macAD/salon/
```

`RUNTIME_AGENT=codex` が既定。`CODEX_BIN` で実行ファイル、`CODEX_MODEL` / `--model` でアカウントのモデル一覧にあるモデルを選べる。指定なしはそのアカウントの既定モデル。特定モデルへ固定しない。`codex-doctor` は認証種別とモデルを確認するだけで推論しない。`run-file` の `agent` / `model` はCLI指定がなければ使う。retryは元のエンジンを引き継ぎ、旧形式のタスクはpi-openrouterとして扱う。

## 実行経路

公式 [App Server](https://learn.chatgpt.com/docs/app-server) のJSON-RPCをprivate stdioで使う。`initialize` → `account/read` → `model/list` → `thread/start` → `turn/start` と進む。OAuthトークンは公式CLIが管理する。認証の根拠は[公式認証仕様](https://learn.chatgpt.com/docs/auth)。

experimental APIを明示し、`dynamicTools` と `item/tool/call` で既存の `plan_task` / `open_page` / `inspect_page` / `record_evidence` / `finish_task` を呼ぶ。CodexがURL選択・探索・条件評価を判断し、ホストの既存コードが取得、ドメイン/DNS制約、引用一致、同一対象、詳細必須項目を検査する。

スレッドはephemeral、read-only、承認never。shell、apps、plugins、外部MCP、組み込みWeb検索、multi-agent機能は無効にし、調査に必要な既存ツールを使う。引数をJSON Schemaで検査し、未知のツール/別threadの呼び出しと調査以外のサーバー要求を拒否する。同一turn/call IDの配送は一度だけ処理する。stderrやトークン・アカウントのメールアドレスを成果物へ保存しない。子プロセスの環境は必要項目だけを引き継ぎ、OpenAI/OpenRouter等のAPIキーは渡さない。

ChatGPT利用上限は適用される。Codex実行時にはOpenRouter残量APIや無料モデル一覧を呼ばない。上限到達時は停止し、他のプロバイダーやAPI課金に切り替えない。`quota` コマンドはOpenRouterの無料枠専用で、Codexの枠とは別。

`maxSteps` はクライアントが開始するモデルturnと調査ツール呼び出しの合計。App Server内部のモデル要求回数やトークンの課金上限ではない。ページ数と全体のtimeoutも別に適用する。中断時はApp Serverを終了し、終了しない場合はkill、ブラウザもクリーンアップする。

## 実測：2026-11-10 JST

OpenAI/OpenRouterのAPIキーを使わず、この端末でChatGPTログインした公式Codex CLI 0.167.0を使用。モデル一覧の既定はgpt-6.1-solだった。

| ケース | 結果 | 内容 |
| --- | --- | --- |
| 楽天トラベル2宿 | succeeded | 所在地・総部屋数・浴場を引用し日本語で比較。public-html 2ページ、根拠6件、11ステップ |
| Beautyの渋谷検索 | partial | 一覧からacote @とZina渋谷本店の2店舗を選択。browser-dom 3ページ、根拠9件、15ステップ。徒歩・髪質改善・料金・口コミを確認。「韓国風」は確認したが「韓国アイドル風」そのものは未確認として断定しなかった |
| 複数ドメインからSUUMO比較 | succeeded | 美容とSUUMOのURLを渡し、SUUMO2ページだけを取得。家賃17万円+管理費1.5万円=18.5万円、間取りと同一駅への徒歩を引用して比較。根拠6件、11ステップ |

コンパクトな実測記録は [codex-validation.json](evidence/codex-validation.json)。生本文・完全なタスク・イベント・回答はgitignoreされた `.runtime/tasks/<id>/` にある。掲載料金・口コミ・空室の将来の状態を保証せず、全クエリの品質が合格したとはしない。実測後のタスクからの再利用も詳細を再取得する。

CIでは実Codexアカウントを使わない。模擬App Serverでprotocol、引数検査、未知要求、重複配送、APIキー認証拒否、利用枠切れ、途中中断、プロセス終了、バイナリ不在を確認する。既存OpenRouterのテストはエンジンを明示して継続する。

## Web・Router・OpenShell

Webのlive設定は、Codex選択時にAPIキーの有無ではなくChatGPTログインを確認する。Goal Routerからのローカル実調査でも同じCodexエンジンを使い、人の承認・並列制限・後続タスクの前提検査を維持する。

**CodexのOpenShell実行は未対応。** 既存イメージにはCodexを含めず、OpenRouter用providerとポリシーを維持する。Codex選択でGoal RouterからOpenShellへ進むと発行前にエラーにする。単独のsandbox planにはpi-openrouterを明示する。Codexのサブスク認証をVMへコピーして動作済みとはしない。self-hostで使うには公式認証・権限・通信先の連携と実機検証が必要。
