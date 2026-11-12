# 詳細取得の完了条件と楽天URLの実測

2026-11-10 JST。推論モデルを使わず、公開ページの取得だけを実行した。APIキーやログイン情報は送信していない。サイト一覧は[楽天公式サービス一覧](https://www.rakuten.co.jp/sitemap/)と公開ページを確認した。検証対象は生活・旅行の既存ユースケースに対応する領域と関連する買い物・ゴルフ。楽天の全ドメイン対応という意味ではない。

## 完了条件

1. 対応アダプターで個別のサロン・宿・店舗・物件・車両・商品などの対象IDを認識できること。
2. エラー・サービス終了・認証要求ではなく、200字以上の本文を文字化けなく取得すること。公開HTML/ブラウザDOM、日時、HTTP状態・文字コード（公開HTML）を記録する。
3. `src/detail-contracts.ts` の領域別必須項目を本文から確認すること。共通ナビゲーションにある「交通」「宿泊施設」などだけでは合格にしない。
4. 回答タスクは候補のすべてが詳細取得済みであることを成功の追加条件とする。満たさない回答はpartialとし、不足をlimitationsに付記する。ユーザーの必須条件を満たすか、主張と引用の意味が一致するかは別の検証が必要。

個別URLの取得証明は `DetailVerification` に残す。sourceの登録検証では異なる対象IDの合格2件を求め、合格した個別URLだけを登録する。同じ対象のクーポン・写真・レビューのURLを2対象には数えない。対象IDの異なる重複掲載の完全な名寄せは未対応だが、今回のSUUMOは別物件のjnc URL2件を確認した。

台帳は `purpose: detail-retrieval-only`。ドメイン全体、一覧、未取得の同じドメインのURLをtrustedにはしない。本文は外部データとして扱い、指示には従わない。クエリに対して探索を継続して見つけた新規URLも、詳細取得と根拠を改めて検査する。

## 実測

| source | 判定 | 詳細の必須項目・制約 |
| --- | --- | --- |
| rakuten-beauty | verified、2件 | 所在地/駅徒歩、数値価格、メニュー |
| rakuten-travel | verified、2件 | 所在地/駅徒歩、浴場/設備、客室情報。基本情報の子ページまで確認 |
| rakuten-gourmet | verified、2件 | 所在地/駅徒歩、数値価格、営業時間。楽天ぐるなびは提携サービスとして分類 |
| rakuten-realestate | blocked、0件 | `/rent/` は取得。確認した `/rent/item/` が認証用URLに転送。転送先は取得せず停止。別の公開物件導線は未確認 |
| rakuten-car-shaken | verified、2件 | 所在地、数値価格、車検費用の情報。中古車購入には使用しない |
| rakuten-car-used | retired、0件 | 中古車一覧がサービス終了案内に転送 |
| rakuten-careers | insufficient_detail、0件 | 楽天自社の採用トップを確認。一般転職求人検索の代替としては未対応 |
| rakuten-gora | verified、2件 | 所在地、ホール/ヤード数、設備・練習場 |
| rakuten-books | verified、2件 | 数値価格、発売/出版情報、ISBN等 |
| rakuten-ichiba | verified、2件・L4 | 一意のProduct/Offer Microdataで本人の価格帯を取得。SKU確定価格・送料・在庫は別途未確認 |

楽天7サービス、14個別URLを登録。既存のRecruit系はBeauty、グルメ、じゃらん、カーセンサー、SUUMOの5サービス各2件を再検証、Indeedはアクセス制限。合計12サービス24URL。正確なURL・時刻・取得項目の引用・ハッシュ・失敗理由は [同梱台帳](../config/trusted-urls.json) を参照。実行時の生本文は `.runtime/trusted-audits/` にのみ保存する。

[楽天Car中古車の公式終了案内](https://car.rakuten.co.jp/campaign/announce/usedcar/service_close/)は2026年1月7日08:59のサービス終了を告知している。HTTP200でも現行サービスの詳細と判定しない。

楽天トラベルの一覧には非表示領域のホテルリンクがあった。リンクは探索の手がかりとして抽出し、非表示本文は証拠に使わない。取得先の個別ページで改めて検証する。グルメのランチ子ページでは住所が取得不足だったため、同じ店舗の基本情報へ進んで合格を確認した。検索地域への適合は別途確認が必要で、美容の一覧上の周辺候補がすべて渋谷駅近辺であるとは扱わない。

## 再実行と運用

```sh
npm run build
npm start -- trusted verify --family rakuten --parallel 2 --timeout 75
npm start -- trusted verify --source rakuten-travel recruit-suumo
npm start -- trusted list --all
npm start -- trusted run 'この2宿を温泉とアクセスで比較して' --source rakuten-travel
```

検証にLLM推論は不要。`trusted run` は現在Codexを既定とし、ChatGPTログインを使う。`--agent pi-openrouter` なら無料モデルと残量チェックを使う。今回の検証は詳細取得の試験であり、楽天を使った自然言語比較の完走・推薦精度を保証しない。宿泊価格・動的空室・購入在庫は未確約。

合格時から7日で失効し、再検証が失敗したsourceの旧登録は削除する。定期再検証の自動スケジュールは未設定。台帳の更新はロック取得後に最新内容を再読み込みし、異なるプロセスの更新消失と古い検証結果による上書きを防ぐ。異常終了で `.runtime/trusted-urls.json.lock` が残った場合は実行中の検証がないことを確認してから削除して再実行する。

不動産の新規公開導線などは、catalogの入口、adapterの対象ID、領域別必須項目を追加してから再検証する。未検証URLを手作業でverifiedにしない。同梱台帳は今回の実測のスナップショットで、今後の状態を保証しない。OpenShellのコンテナにもcatalog/初期台帳を同梱するが、実gatewayでのsandbox発行は別の未完了検証である。

後続のCodex実行で楽天市場の対象商品の販売価格不足が判明して初期の2URL登録を取り下げ、その後本人Microdataの価格帯抽出に対応して再検証・登録した。[16サービスの実測と修正](codex-family-results.md)。


## レベル分類と追加取得

現在はL0取得不可、L1一覧、L2詳細不足、L3必須詳細確認、L4追加項目2つ以上確認に分類し、L3以上を登録する。旧データは証拠から再計算し、レベルの自己申告で昇格しない。楽天市場は公開Microdataの本人価格帯取得に対応し、今回の再検証で2URLを登録。現行は12サービス24URL（L3:4、L4:20）。[新しい仕様と実測](engines-and-depth.md)。22URLという旧記録は、価格帯抽出に対応する前の状態。
