# Claude Code・pi/OpenRouter・追加調査・trustedレベル

既定のCodexに加え、Claude Code Sonnet 5.5 / Haiku 5.5と、回復したOpenRouter無料枠を使うpiを同じ調査ツールへ接続した。エンジン間で詳細取得・引用の検証・追加調査・完了判定を共通化する。

## CLI

Claude Codeをインストールし `claude auth login` でサブスク認証を済ませる。今回の動作確認はClaude Code 2.1.307。APIキーを渡さず、認証先がclaude.ai/firstPartyであることを確認する。

```sh
npm run build
npm start -- claude-doctor
npm start -- models --agent claude-code
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel \
  --agent claude-code --model claude-sonnet-5-5
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel \
  --agent claude-code --model claude-haiku-5-5
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel \
  --agent pi-openrouter
```

`RUNTIME_AGENT=claude-code` と `CLAUDE_MODEL=claude-haiku-5-5` でも指定できる。`CLAUDE_BIN` でCLIの場所を指定可能。モデルは5.5の明示IDに固定し、別モデルへ自動fallbackしない。`models --agent claude-code` の一覧はアダプターが扱うモデルIDで、実際のアカウントの利用権限は実行時に確認する。Sonnet/Haikuの短縮指定は `sonnet-5.5` / `haiku-5.5`。既定エンジンは引き続きCodex。

公式 [headless実行](https://code.claude.com/docs/en/headless) と [CLI reference](https://code.claude.com/docs/en/cli-reference) を確認。`claude -p --restricted --tools "" --strict-mcp-config` を使い、capability認証付きloopback MCPに共通調査ツールだけを公開する。built-in tools、外部MCP、ユーザー/プロジェクト設定、hooks、Chrome連携を読み込まず、許可するMCPツールを明示。`--bare` はサブスク認証を読まないため使用しない。公開ポートを設けず、接続用の一時ファイルはmode600、終了時に削除する。Claude Codeのcredentialを抽出・コピーせず、APIキーも子へ渡さない。

モデルIDは [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) / [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview) の公式仕様と実呼び出しで確認した。利用上限・認証・モデル利用不可では停止し、API課金へ切り替えない。Claude CodeとCodexは現在ローカル専用。OpenShell経由は既存のpi/OpenRouter構成のみで、他エンジンは発行前に拒否する。

## 不足情報の追加調査

`deepen_details` は取得済みの個別対象から、同じ対象IDを持つ実在の子ページへ進む。料金、スタイル、温泉、部屋など不足項目に合わせてリンクを優先。取得可能だった公開HTMLに不足がある場合はブラウザ描画でも再確認する。HTTP拒否・ログイン・CAPTCHA・サービス終了は追加取得の対象にしない。

`finish_task` に必須条件のunknownや詳細不足が残ると、追加取得できる範囲を確認して `accepted:false` と新しい本文を返す。モデルは引用を追加して回答し直す。上限後も不足する項目はunknown・limitationsに残す。既定は最大2ラウンド・追加4ページ、全体のページ数・ステップ数・時間上限も適用する。`--deepen-rounds 0` で追加調査を無効化、最大3まで変更できる。

同じページのハッシュリンクや追跡パラメーターの差で調査枠を消費しない。未知URLを推測して巡回したり、別店舗・別物件の根拠を足したりしない。引用は以前と同じく対象・本文一致で検証する。後続取得失敗でも、既に取得した公開情報から未確認を明記して返せる。

前回の品質課題も補強した。

- 韓国アイドル風という明示条件をplanが任意に落とさない。一般的な韓国風の引用だけではアイドル対応をsupportedにしない。
- SUUMOの管理費「-」を0円とみなす合計額はunknownにする。
- ユーザーがSKU確定価格を未確認でよいと明示した場合、その取得を必須にしない。上限未指定の比較へ数値上限を新設しないようプロンプトも補強。
- 全候補の必須条件と詳細取得を満たしたときだけsucceededとする。1候補だけの合格ではpartial。

## 楽天市場の価格不足を補完

表示本文に対象商品の価格がなかったが、公開HTMLにProduct/Offer Microdataが存在していた。canonicalが現在の商品URLと一致し、Productが一意、OfferがそのProductの直下のスコープで一意、JPY、妥当な数値であることを検査して抽出する。複数Product、別商品URL、通貨違い、不正な上下限は採用しない。クーポン額・関連商品価格は使わない。

今回の商品はAggregateOfferで、sa80ssは6,990〜7,990円、sa80prossは8,990〜10,190円の価格帯だった。選択SKUの確定価格として扱わず、送料・在庫は未確認。構造化データの出所と未確認範囲を明示して本文へ加えるため、モデルは通常と同じ引用機構で参照できる。スクリプトは実行しない。価格帯が予算上限をまたぐ場合、全SKUが予算内とは判断しない。

## trusted URLのレベル

| レベル | 意味 | trusted実行 |
| --- | --- | --- |
| L0 unavailable | 拒否・認証・終了・本文不足 | 不可 |
| L1 discovery | 一覧/入口は読める。個別詳細は未検証・未対応 | 不可 |
| L2 partial-detail | 個別本文はあるが領域別必須項目が不足 | 不可 |
| L3 verified-detail | 個別本文・領域別必須項目・文字品質を確認 | 可 |
| L4 enriched-detail | L3に加え、同一対象の追加項目を2つ以上引用確認 | 可 |

追加項目は領域別に定義する。例：宿のチェックイン/アウトや駐車場、物件の面積・築年、商品の容量・素材・サイズ。レベルは証拠から計算し、台帳のlevelを書き換えても昇格しない。旧台帳に追加情報の証拠がなければL3から移行し、L4は再取得して確認する。L0〜L2はauditに残し、trusted URLとしては登録しない。

レベルは情報取得の範囲を表し、事業者の信頼性・人気・ユーザー条件への完全適合・在庫・予約可能性を保証しない。有効期限7日・再検証失敗による除外・個別URLのみの範囲は維持する。2026-11-10の16サービス再検証では24URL（L3:4、L4:20）。じゃらんと楽天Car車検がL3、他の登録ソースがL4。Indeed/楽天不動産/中古車終了はL0、楽天CareersはL1で個別詳細未対応。

```sh
npm start -- trusted verify --family rakuten
npm start -- trusted list --all
npm start -- trusted list --min-level 4 --json
npm start -- trusted run 'この2宿を比較して' --source rakuten-travel --min-level 4
```

## 実行検証

[実行記録](evidence/engines-and-depth.json)にTask ID・クエリ・取得URL・引用数・結果・追加調査の記録を残す。今回のClaude/Pi比較はRecruitと楽天の代表ケースであり、全16ケース×全モデルの合格を主張しない。

| エンジン | 対象 | 結果 |
| --- | --- | --- |
| Sonnet 5.5 | 楽天トラベル2宿 | 引用付き比較がsucceeded |
| Sonnet 5.5 | Recruitの美容サロン | 本体＋スタイル一覧＋詳細3件まで調べ、アイドル根拠は未確認としてpartial |
| Haiku 5.5 | 楽天市場2商品 | 対象商品の価格帯・容量・素材・サイズを比較してsucceeded。送料・在庫は未確認 |
| Haiku 5.5 | SUUMO2物件 | 追加調査後も管理費「-」を未確認にし、1件は合計額を確定できずpartial |
| pi + OpenRouter無料 | Recruitのグルメ2店 | ランチ・税込価格・駅徒歩・更新日を引用してsucceeded |
| pi + OpenRouter無料 | 楽天市場2商品 | 価格帯と仕様を比較してsucceeded。SKU確定価格は明示的に未確認でよい条件 |
| Codex | 楽天ブックス | 共通機能追加後の比較を回帰確認 |

探索時には、piがSKU確定価格を必須にして追加描画でOSのリソースエラーを受けpartialとなったケース、Haikuが徒歩上限未指定の比較に5分基準を追加したケースもあった。前者は未確認でよい条件の固定、後者はプロンプトと上限明示の再現クエリを補強し、記録は残す。追加取得で埋められない条件を実際に確認済みとすることはない。自然言語の意味的な判定全般はモデルの誤りが残り得る。

ケースを再実行する場合：

```sh
npm run eval:families -- --agent claude-code --model claude-sonnet-5-5 recruit-jalan rakuten-travel
npm run eval:families -- --agent claude-code --model claude-haiku-5-5 recruit-gourmet rakuten-books
npm run eval:families -- --agent pi-openrouter recruit-gourmet rakuten-ichiba
```

piはその時点の無料・tools対応カタログから選び、無料残量を事前確認する。今回のモデルは `nvidia/nemotron-3.5-super-vl:free`。枠切れ後の後続ケースは停止する。
