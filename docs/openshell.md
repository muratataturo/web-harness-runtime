# Self-host VM 上の OpenShell task executor

本 PR には、1 調査タスクを 1 OpenShell sandbox に割り当てる実行アダプターと image/provider/policy の準備を含めています。Web Mock の sandbox 表示はデモであり、実際に VM を発行した証拠ではありません。実際の割り当てはホスト CLI から明示的に実行する経路です。

2026-11-10 時点の公式 `latest` は **v0.1.7**。この版の [Pi + OpenRouter チュートリアル](https://docs.nvidia.com/openshell/v0.1.7/tutorials/run-pi-with-openrouter) に合わせ、`node` のネットワークと credential placeholder を利用します。実装は `src/sandbox.ts`、image は `infra/openshell/Dockerfile` です。

## 構成と責務

```text
ユーザーの承認 / タスク router (control plane, trusted host)
     │  planOpenShellTask → writeOpenShellPlan
     │  executeOpenShellPlan (明示実行)
     ▼
OpenShell gateway ── provider credential store
     │                 └─ 実キーは OpenRouter 宛リクエストだけへ注入
     ├─ task A sandbox: pi + agent-browser + Chromium → 根拠/回答
     └─ task B sandbox: pi + agent-browser + Chromium → 根拠/回答
                         │
                         └─ 同一canonical taskごとに .runtime をdownload
```

router と approval state は sandbox 外に置きます。タスクの依存がなければ複数 sandbox を並列発行でき、現在の横断ルールレビューはsandbox外のホスト側で、調査結果の後に実行します。独立LLM reviewerを別sandboxで実行する機能は未実装です。同じ sandbox を無制限に再利用して過去タスクの秘密や cookies を共有する構成にはしません。

[公式 gateway docs](https://docs.nvidia.com/openshell/v0.1.7/how-it-works/gateways/overview) は Docker/Podman/Kubernetes/MicroVM の compute driver を区別しています。本アダプターは登録済み gateway に依頼するため driver に依存しません。「self-host VM 上の Docker sandbox」は「タスクごとの MicroVM」と同義ではありません。後者が必要なら gateway の compute driver を MicroVM に設定してください。

## 1. VM と gateway を準備

Linux VM に Docker、Node.js 22 以降、OpenShell v0.1.7 の gateway/CLI を準備します。インストールと driver 設定は [公式 installation](https://docs.nvidia.com/openshell/v0.1.7/about/installation) に従ってください。VM の provisioning や外部への port 公開はこの PR では実行していません。

VM 内で実行するなら既存 gateway 名を `openshell gateway list` で確認します。別ホストから既存の認証付き gateway を登録する場合の例は次です。

```sh
openshell gateway add https://gateway.example.com --name selfhost
openshell status -g selfhost
openshell gateway info -g selfhost
```

`gateway.example.com` を実際の endpoint に置き換え、公式の認証手順に従います。平文のリモート gateway や `--local` で認証を回避する手順は使いません。

## 2. agent/browser image をビルド

VM の信頼した Docker daemon 上で、repo root からビルドします。

```sh
docker build -t web-harness-runtime:local -f infra/openshell/Dockerfile .
```

`Dockerfile.dockerignore` は context を明示的な allowlist に限定し、`.env`、`.git`、`.runtime`、host の `node_modules` を daemon に送りません。image へは source と lockfile のみをコピーし、Node/Pi/agent-browser/Chromium を事前に用意します。runtime に package registry へのアクセスは与えません。

別マシンの gateway が image を pull する場合は、自分の registry に push した image reference を `image` に指定します。local Docker daemon の image が remote gateway に自動転送されるわけではありません。[公式 Pi tutorial の image 手順](https://docs.nvidia.com/openshell/v0.1.7/tutorials/run-pi-with-openrouter) もこの制約を説明しています。

image は uid/gid 1000 で動かします。Chromium の内部 SUID sandbox は wrapper で無効にし、外側の OpenShell/Landlock/seccomp を必須境界にします。これは `--privileged` や host filesystem の mount を要求する構成ではありません。VM の kernel、driver、Chromium の実起動の組み合わせは rollout 時に検証してください。

## 3. OpenRouter credential を gateway に登録

提供する profile は OpenRouter の endpoint と `/usr/local/bin/node` を指定します。API キーを Docker build arg、image layer、task JSON、`--env` や query に入れません。

```sh
openshell -g selfhost profile lint -f infra/openshell/provider-openrouter.yaml
openshell -g selfhost profile import -f infra/openshell/provider-openrouter.yaml

# キーを argv に含めず、既存の .env から host process の環境へロードする。
node --env-file=.env -e 'const {spawnSync}=require("node:child_process"); const r=spawnSync("openshell",["-g","selfhost","provider","create","--name","web-harness-openrouter","--type","web-harness-openrouter","--from-existing"],{stdio:"inherit",env:process.env}); process.exit(r.status??1)'
```

import は create-only なので、登録済みなら再 import せず profile を確認し、変更する場合は公式の `profile export/update` 手順を利用します。既存 provider を再 create する必要はありません。

[Provider profile の仕様](https://docs.nvidia.com/openshell/v0.1.7/how-it-works/providers/profiles) により、sandbox 内の `OPENROUTER_API_KEY` は placeholder になります。現行 runtime の SDK はその値を通常の Bearer credential として利用し、OpenShell proxy が許可された OpenRouter endpoint で実キーへ置換します。したがってこの構成は direct OpenRouter API であり、架空の汎用 `inference.local` URL へ切り替える実装ではありません。無料モデルのカタログ確認と `provider.max_price=0` の制約は runtime に残ります。

## 4. Plan と明示実行

ホスト側 API は次の通りです。CLI の `sandbox` コマンドも同じ関数を使用します。

```ts
import { planOpenShellTask, writeOpenShellPlan, executeOpenShellPlan, doctorOpenShell } from './src/sandbox.js';

const plan = planOpenShellTask({
  query: '渋谷駅から徒歩5分以内、予算4000円の和食店を比較して',
  urls: ['https://www.hotpepper.jp/'],
  gateway: 'selfhost',
  image: 'web-harness-runtime:local',
  name: 'dinner-001',
  maxPages: 12,
  maxSteps: 70,
  timeoutSeconds: 600,
});

// Pure dry-runで作られた policy/argv を保存してレビューできる。
await writeOpenShellPlan(plan);
console.log(await doctorOpenShell('selfhost'));
// 明示的な host action だけが sandbox を実発行する。
const execution = await executeOpenShellPlan(plan, { confirmed: true });
```

生成する lifecycle は `sandbox create --from ... --provider ... --policy ... -- <node> <CLI> run <query>`、その後に `sandbox download <name> .runtime <local destination>` です。source を image に含めるので、公式仕様上併用できない `create --upload` と trailing main command を混在させません。[公式 sandbox lifecycle/transfer docs](https://docs.nvidia.com/openshell/v0.1.7/how-it-works/sandboxes/overview)

plan は `.runtime/sandbox-plans/<name>/` に `policy.yaml` と `plan.json`、実行時は `execution.json` と download した artifacts を保存します。query は shell command へ連結せず独立 argv として渡します。gateway、provider、sandbox 名、image reference、件数/時間/CPU/memory の入力も検証します。

## 5. Egress と人の承認

生成 policy は提示 URL の host と登録アダプターの明示 host だけを許可します。browser 用 endpoint は `tls: skip` なので HTTPS の host 境界であり、HTTP method 単位の保証ではありません。OpenRouter は provider 側の REST enforcement を利用します。第三者 CDN、地図、広告、追加検索サイトなどは自動で許可しません。ページが追加 host を必要とする場合は、deny log を調べ、必要性を判断して狭い rule を人が承認します。

OpenShell の network-policy 承認と、UX の「旅行は食事重視か温泉重視か」の選択は別の承認です。商品選択を承認しても外部サービスへの予約・応募・支払を自動で許可する意味にはなりません。

sandbox はログ確認と artifact 保全のため retain します。エラーや中断で gateway 側の task が継続する可能性があるため、状態を確認してから明示的に停止・削除してください。ローカル CLI のキャンセルだけで remote task の停止を断定しません。

```sh
openshell -g selfhost sandbox get dinner-001 --output json
openshell -g selfhost policy get dinner-001 --full
openshell -g selfhost logs dinner-001 --tail
# 必要に応じて（完了/中断と保存先を確認してから実行）
openshell -g selfhost sandbox stop dinner-001
openshell -g selfhost sandbox delete dinner-001
```

## 検証状況と rollout gate

この開発環境は macOS arm64、Docker server 28.5.1。提供 Dockerfile の **Linux arm64 image build を実行して成功** しました。`sh infra/openshell/smoke.sh` で host mount/秘密なし・`--network none` の container を起動し、次を実測しました。

| 確認 | 実測結果 |
| --- | --- |
| Node.js | v24.22.2 |
| Pi CLI | 1.5.0 |
| agent-browser | 0.41.2 |
| Chromium | 156.0.8078.79 |
| runtime CLI | `--help` の起動成功 |
| process / secrets | uid 1000、image 内 `.env`/`.git`/API key なし |
| 実 browser | `data:` ページを open → title 取得 → close に成功 |
| BuildKit context | 最終統合版304.31KBのallowlist context（host node_modulesを送らない） |

最終統合版を2026-11-10 06:17 JSTに再ビルドし、`sandbox / goal / eval / web --help` とWeb資産・評価ケースの同梱も確認しました。image ID は `sha256:84724b4b5423c9bdb2701fa679bd0a0e8f8a7e250c8677c4b3460cfa0b3c57b0`、Docker inspectのimage sizeは620,562,276 bytes（約592MiB）です。再ビルド初回の `npm ci` は一時的な `ECONNRESET` で失敗し、同一ソースの再試行で成功しました。

既定 Docker credential helper による manifest 取得が待機したため、資格情報を含まない専用の一時 Docker 設定と Docker Desktop の BuildKit plugin でビルドしました。BuildKit が使えない場合に legacy builder の大きな context を送らないよう、root `.dockerignore` と Dockerfile-specific allowlist の両方を利用してください。

OpenShell CLI は未導入であり、接続先 VM/gateway も提供されていません。したがって **実 OpenShell sandbox 発行、gateway proxy の credential rewrite、Landlock/seccomp 下の Chromium 起動、Linux amd64 image は未検証** です。通常の Docker container 内での起動成功を、OpenShell 境界の検証成功とは表示しません。

自動テストでは dry-run の lifecycle argv、shell metacharacter の独立引数保持、入力検証、host/非root/Landlock policy、plan ファイル保存、明示実行 gate を確認しました。さらに SIGTERM を無視する実子プロセスに対して timeout → SIGKILL の終了、出力洪水の buffer 上限、中断済み command の未起動も検証しています。local timeout は124、出力上限は125、中断は130として記録します。`cleanupPolicy: retain` は削除しない方針で、sandbox の実在確認ではありません。`sandboxState` はartifact downloadが成功した場合のみ `created`、それ以外は `unknown` です。導入先で以下を順に確認してください。

1. OpenShell CLI/gateway v0.1.7 を揃え、`status` の接続と認証を確認。
2. image build、profile lint/import、provider attach が成功。
3. 公開の既知ページで単一 task が完了し、stdout と `task.json`/引用の download を確認。
4. 許可 host の取得が成功し、未許可 host は拒否される。
5. 同時に2 taskを発行し、cookie、書き込み、出力、sandbox名が混ざらない。
6. timeout/中断/429/アクセス拒否時に状態とartifactが残る。remote継続時のstop/deleteを確認。
7. 依存taskは前提結果まで待機し、review指摘による再調査にも予算上限が効く。
8. VM kernel の Landlock hard requirement、OpenShell credential rewrite、Chromium起動を実測してから本番 executor として有効化。

## Web/goal routerとの接続

`.env` に `RUNTIME_EXECUTOR=openshell` と `OPENSHELL_GATEWAY=selfhost` を設定すると、`src/executors.ts` が各実調査をsandboxへ発行します。`OPENSHELL_IMAGE` と `OPENSHELL_PROVIDER` でimage/providerを指定できます。体験モードはこの設定でも発行しません。downloadしたタスクはqueryとURL、終端状態等を照合してlocal Storeへ取り込み、goalId/runtimeTaskIdで関連付けます。ユーザーの改訂・停止はcontrol planeで制御しますが、remote taskの停止保証はなく、gateway上での確認が必要です。
