# Vehicle3D runtime

前回の `gpt-6.2-astra` → Blender → 図面・走行デモを再現するコードと、公式の複数画像から形状を復元・検証する自律ループです。既存のRecruit/楽天調査やChatのURL権限は変更しません。実行入口は `npm run vehicle3d -- ...` の別コマンドです。ChatやMCPからこのコマンドを直接呼ぶ接続は未実装です。

## セットアップ

Python 3.13とBlender 4.5.3で実行確認しています。Python依存は専用環境に入れてください。Blenderやモデル・写真の常設ダウンロードはスクリプト側で行いません。

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r scripts/vehicle3d/requirements.txt
VEHICLE3D_PYTHON=.venv/bin/python npm run vehicle3d -- \
  --config examples/vehicle3d/kicks.json \
  --blender /Applications/Blender.app/Contents/MacOS/Blender \
  --output .runtime/vehicle3d/my-run
```

初回は日産公式360°マニフェスト、諸元PDF、36方向のJPEGと元の小画像を取得します。ネットワークとBlenderを使わないユニットテストは次で実行できます。

```sh
.venv/bin/python -m unittest discover -s scripts/vehicle3d -p 'test_*.py'
```

取得後は同じ `--cache-dir` と `--offline` で再実行可能です。`--output` は毎回新しいフォルダを指定します。既存の実行ログがあれば停止します。終了コード0は現在の輪郭・写真再投影・寸法拘束ゲートの通過、2は改善を保存したが未達あり、1は実行失敗です。**0でも実車精度の認証ではありません。**

## 自律実行する内容

1. 取得物のURL・SHA-256・バイト数・network/offline区分を記録。
2. 前回の生成コードを再実行し、改善前の実メッシュを作成。
3. 復元用12方向だけで白背景から輪郭を抽出し、推定アフィンカメラを枠合わせ。
4. 96・160・224格子のvisual hullを削り込み、Marching Cubesで実際の三角形メッシュ化。境界に接する復元は棄却し、Taubin型の平滑化を適用。
5. 選択用12方向でIoUを計測。改善前より0.01以上、現採用案より0.001超改善するときだけ採用。
6. 採用後に初めて、復元・カメラ校正・格子選択に使わなかった最終12方向を評価。色は復元用写真だけから、可視性・面法線を考慮して頂点に融合。
7. 最終12方向への色の再投影PSNR、寸法拘束の残差を輪郭と別に検査。閾値はこの試作用のポリシー値で、精密設計や人間の知覚品質の規格ではありません。
8. Blender/GLB/STL・画像・自己完結HTMLレポート・イベントログ・JSONを保存。

最終12方向も同じ公式360°画像系列です。実物を別条件で撮影した独立計測ではありません。写真の色・照明と幾何形状の正しさは区別します。面・内部機構・材質・公差・強度は検証していません。

カメラは写真測量で較正した透視カメラではなく、未知の切り出しを補正するアフィン推定です。車体寸法で座標系を正規化するときはカメラにも逆変換し、投影を変えません。改善前も同じ変換でスコアが不変であることを確認します。全幅はミラーを含めず、中央車体帯（|x|<1m、z=0.65〜1.1m）の幅を使う代理定義です。**その残差が小さいことは寸法拘束の成立であり、実車に対する誤差の独立検証ではありません。**

## 前回の図面・走行デモも再現する

`VEHICLE3D_OUT` に保存先を指定して、以下を順に実行します。これは前回の手続き型93部品モデルに対するデモです。画像から復元した車体に内部機構や可動部品を認識して組み込む処理ではありません。

```sh
export VEHICLE3D_OUT=.runtime/vehicle3d/legacy
blender --background --factory-startup --python-exit-code 1 --python scripts/vehicle3d/build_scene.py
.venv/bin/python scripts/vehicle3d/simulate.py
blender --background --factory-startup --python-exit-code 1 --python scripts/vehicle3d/animate_scene.py
blender --background --factory-startup --python-exit-code 1 --python scripts/vehicle3d/export_dxf.py
.venv/bin/python scripts/vehicle3d/make_drawing.py
blender --background --factory-startup --python-exit-code 1 --python scripts/vehicle3d/check_animation.py
.venv/bin/python scripts/vehicle3d/verify_outputs.py
```

93部品モデルの寸法と運動学的走行条件は前回の仮定値を保っています。新しい日本仕様プロファイルの諸元とは区別してください。GIFは俯瞰の2D可視化、`driving.blend` は操舵と車輪回転を含む3Dアニメーションです。図面は概略三面図であり、製造図ではありません。RCバギーや直列6気筒エンジンの組立モデルは含みません。

## 保存と公開範囲

生成した `.blend` / `.glb` / `.stl`、格子データ、原寸写真、PDF、実行ログは `.runtime/` に置き、Gitでは追跡しません。前回の `artifacts/` も除外します。PRにはコード・設定・小さなJSONとHTML・縮小画像だけを含めます。`docs/vehicle3d/index.html` は縮小写真と表示用の粗い実メッシュを内包し、外部通信なしで開けます。

`physical_accuracy_certified` は常にfalseです。実車精度の認定へ進むには、カメラの内部・外部パラメータ、独立した実測またはOEM CAD、凹面・下面・内部構造と公差の裏付けが必要です。写真から得られない部品をモデルの生成能力だけで確定しません。
