# CLIの自己改善ループ

保存タスクの未達を診断し、調査戦略を変えて再実行し、元の条件で独立検証する。Codex / Claude Code / pi × OpenRouterの共通runtimeを使う。モデルが失敗を言い換えただけでは完了にせず、未確認が消えない場合も停止理由を残す。

## 使い方

```sh
npm run build

# 前回未達だったタスクを改善。元のエンジン・モデルを引き継ぐ
npm start -- improve TASK_ID --iterations 3 --timeout 600

# 通常実行後に未達があればそのまま改善
npm start -- run '武蔵小杉駅徒歩10分以内、1LDK、家賃と管理費合計15万円以下を2件比較して' \
  --url https://suumo.jp/chintai/ --self-improve \
  --improve-iterations 3 --improve-timeout 600

# 同じ必須条件・必要件数を維持して別候補を探すことも許可
npm start -- improve TASK_ID --allow-replacements --iterations 3

# 人が見つけた同一対象の詳細URLを追加。本文を取得するまで根拠にはしない
npm start -- improve TASK_ID --url 'https://beauty.hotpepper.jp/slnH000074059/blog/'

# モデルの明示切替（自動切替は行わない）
npm start -- improve TASK_ID --agent claude-code --model claude-sonnet-5-5
npm start -- improve TASK_ID --agent claude-code --model claude-haiku-5-5
npm start -- improve TASK_ID --agent pi-openrouter --model nvidia/nemotron-3.5-super-vl:free

# 推論を使わない診断・履歴確認
npm start -- improvements diagnose TASK_ID
npm start -- improvements list
npm start -- improvements show LOOP_ID --json
```

`run-file` / `retry` / `trusted run` も `--self-improve` を使える。`improve --json` と、自動改善が実行された `run --json` は `{loop, task}` を返す。自動改善が発動しなかったrunは従来どおりTaskを返す。独立検証の完了判定は `loop.status` / `loop.best.complete` を参照する。`task.status` は元のモデル実行の状態であり、独立検証に合格したこととは限らない。

改善には既存の評価条件と、少なくとも1つの個別対象が必要。ステップ上限で回答未保存でも、条件と個別ページが残っていれば回復可能。認証・利用枠切れは連続要求しない。`--self-improve` は初回のstatusがsucceededでも独立検証する。検証済みであれば再推論なしで完了する。

## ループの処理

1. 元のクエリ・評価条件・重み・必須指定を固定。候補も既定では固定する。クエリに明示された件数を下回らない。
2. 個別詳細、必須unknown/contradicted、候補欠落、引用不正、切れた本文、ステップ/追加調査上限を診断する。
3. 過去の取得リンクから不足項目に関連する未読ページを選び、各回の先頭で最大2ページをホスト側から取得する。モデルに任せきりにしない。先行取得のモデル入力は本文6,000字・24リンクに制限し、全文はopen_pageで参照できる。
4. 新しいタスクIDで再実行する。調査済み子ページを再巡回しないよう履歴を渡し、手法をtargeted-links / broader-links / render-and-recheckへ進め、実行予算も段階的に増やす。候補本体は再取得して情報の更新を確認する。
5. モデルのscore/eligible/succeededを信用せず、取得本文と引用を再照合し、条件と件数、詳細契約から完了を再計算する。引用の作成時検査だけでなく、保存済み引用の本文一致・出典・ID重複も確認する。
6. 候補ごとの確認済み条件を失わず改善した場合だけ最良結果を更新する。同じ合格数を別候補へ移しただけでは改善としない。新しい引用で旧supportedがcontradictedになった場合は、古い推薦を維持せず「訂正」として更新する。
7. 全条件を満たした成功手順のみ、同一クエリ・同一条件契約の次回実行に再利用する。以前の最良タスクも再検証し、出典URLと戦略のみを学習する。新実行ではページと引用を取得し直す。破損した証拠は学習しない。

`--allow-replacements` の場合のみ、元と同数以上かつ元の指定件数以上の別候補へ差し替えられる。実在する同じ許可ソースの別候補・駅一覧リンクも先行取得する。全候補の必須条件と詳細を検証し、元候補を確認済みに書き換えず、差し替え履歴を残す。

SUUMOは建物名・所在地・面積・間取り・家賃が一致する掲載を保守的に関連付ける。同じ部屋の別掲載らしい2URLを2物件として完了にしない。同じ部屋らしい掲載の駅徒歩が食い違えばsource_conflictとし、都合のよい分数のみを採用しない。部屋番号等がないため「同一部屋の可能性」の検査であり、同一性を確定するものではない。

## 上限・停止・成果物

- 追加実行は既定3回、最大5回。ループ全体は既定1,800秒、最大3,600秒。初回runの時間は別枠。
- 各回は最大160ステップ・32ページ。deepeningは最大3ラウンド。全体のAbortSignalも各回へ伝える。
- 2回続けて検証可能な改善がなければ停止。上限でも解決しなければ `needs_input` と、未解決項目・公式URL追加などの選択肢を返す。URLを追加して再実行できる。店舗への問い合わせは自動送信しない。
- 認証・quota・rate limit・モデル利用不可は `blocked`、時間上限は `timed_out`、SIGINT/SIGTERMは `cancelled`。別エンジン・有料APIへ自動fallbackしない。piは従来の無料モデル/無料枠検査を使う。
- 終了コードは成功0、要確認2、失敗/blocked/timeout1、中断130。
- `.runtime/improvements/<loop-id>/loop.json` に診断・各回の計画・採否・訂正・最良タスク・学習元・要確認事項を保存。本文は各Taskの成果物へ保存する。台帳はmode600・atomic更新、ディレクトリはmode700。

この自己改善は調査戦略と予算配分を改善するもの。実行中にソースコード・テスト・trusted判定を自動変更しない。trusted URLのレベルや有効期限を迂回せず、成功率を上げるための条件緩和も行わない。公開されていない情報や真に条件不一致の対象を、必ず条件適合へ変えることはできない。自然言語の意味判定全般は引き続きモデルの誤りが残り得る。

## 実サイトでの結果（2026-11-10）

[実行記録JSON](evidence/self-improvement.json)に初回・各改善回のID、計画、引用、採否を記録する。

| ケース | 実測 |
| --- | --- |
| Codex・楽天ブックス | 初回を6ステップに制限し回答未保存を再現。自動改善1回・14ステップで2冊×5条件の全10項目を引用付きで確認。未達を解消してsucceeded。初回 `977fdc55-d366-4466-9b79-2210a416962c`、改善 `74735162-c233-44c6-9118-c9c284edef29` |
| pi × OpenRouter無料・楽天ブックス | 同じ初回未完了を改善1回で回復し、2冊×5条件を引用確認。Codexで成功した調査手順を再検証して再利用し、新しい本文を取得。モデルはnvidia/nemotron-3.5-super-vl:free。 |
| Sonnet 5.5・美容室固定 | 未読のブログ/口コミ・スタイル等を先行取得し、2回で新規URL6件＋8件。必須条件3/4は維持したがアイドル風の明記が得られずneeds_input。Loop `df914e9b-32c0-47ce-97a3-0bff7af3b583` |
| Haiku 5.5・SUUMO固定 | 2回追加調査。管理費「-」は不明のまま。モデルの一部判定は悪化したため採用せず、needs_input。Loop `a4f93783-d329-4c63-b7fa-3601d6cd8b10` |
| Sonnet 5.5・SUUMO代替許可 | 取得済みリンクから別掲載・駅一覧を探索。D Painaは掲載により武蔵小杉駅徒歩10分/19分が食い違い、フレメゾンは管理費不明。旧徒歩判定を訂正したが、全条件を確認した別物件2件は揃わずneeds_input。Loop `5494ecb3-e335-4161-9236-ae6accbead56` |

SUUMO代替実測で見つかった掲載矛盾と重複の問題を受け、最終版に独立検査を追加し、保存した実本文へ適用して `source_conflict` / `possible_duplicate_room` を確認した。記録の `postRunIndependentSuumoReview` が最終検査結果。実行当時のモデル/loop判定は歴史として残し、後から全件成功へ書き換えない。

探索版では同じページへの再訪や、代替許可でも元候補ばかりを再提示する問題があった。未読リンクのホスト先行取得、既読URL履歴、代替リンク抽出を補強した。探索のLoop IDと課題も記録する。

119テスト・型・ビルド・整形を確認。改善採用と回帰拒否、引用改変、条件/件数の維持、代替許可、quota停止、中断・全体timeout、調査手順の再利用と証拠破損拒否、SUUMOの矛盾/二重計上を含む。全エンジン×全サービスの実モデル検証を完了した主張ではない。
