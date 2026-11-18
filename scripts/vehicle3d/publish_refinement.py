"""Publish bounded native-render evidence without raw photos or large 3D assets."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def publish(cache, render, destination):
    result = json.loads((render / "refinement-metrics.json").read_text())
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "refinement-metrics.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    (destination / "refinement-render-checks.json").write_bytes(
        (render / "projective-render-checks.json").read_bytes()
    )
    figures = []
    for frame in ["input", 12, 18, 24]:
        label = "input" if frame == "input" else f"{frame:02}"
        source = cache / (
            "reference.jpg" if frame == "input" else f"references/spin-{frame:02}.jpg"
        )
        reference = Image.open(source).convert("RGB")
        rgba = Image.open(render / f"frame-{label}.png").convert("RGBA")
        image = Image.new("RGBA", rgba.size, "white")
        image.alpha_composite(rgba)
        image = image.convert("RGB")
        # Diff is only a display; scoring always reads the original native PNG.
        diff = Image.fromarray(
            np.minimum(
                np.abs(
                    np.asarray(reference).astype(int) - np.asarray(image).astype(int)
                )
                * 4,
                255,
            ).astype(np.uint8)
        )
        for name, item in [("reference", reference), ("render", image), ("diff", diff)]:
            item.thumbnail((464, 360))
            item.save(
                destination / f"refinement-{label}-{name}.jpg",
                quality=85,
                optimize=True,
            )
        row = next(r for r in result["rows"] if r["frame"] == frame)["metrics"][
            "reference_roi"
        ]
        figures.append(
            f'<section><h2>{"元画像（学習参照）" if frame == "input" else f"未使用視点 {frame}"}</h2><p>PSNR {row["psnr_db"]:.2f} dB / SSIM {row["ssim"]:.3f}</p><div class="compare">'
            + "".join(
                f'<figure><img src="refinement-{label}-{name}.jpg" alt="{label} {name}"><figcaption>{title}</figcaption></figure>'
                for name, title in [
                    ("reference", "参照写真"),
                    ("render", "実際のBlenderレンダー"),
                    ("diff", "絶対差分 ×4"),
                ]
            )
            + "</div></section>"
        )
    b = result["blind_test"]["reference_roi"]
    a = result["input"]
    rows = "".join(
        f"<tr><td>{r['frame']}</td><td>{r['metrics']['reference_roi']['psnr_db']:.2f}</td><td>{r['metrics']['reference_roi']['ssim']:.3f}</td></tr>"
        for r in result["rows"]
    )
    html = f"""<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>車両3D・写真一致の改善</title><style>body{{font:16px/1.7 system-ui;margin:24px auto;padding:0 18px;max-width:1120px;color:#14222e;background:#f5f7f9}}h1{{font-size:28px}}section{{background:white;padding:18px;margin:20px 0;border:1px solid #ccd5df;border-radius:12px}}.compare{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}}figure{{margin:0}}img{{width:100%;height:auto}}table{{border-collapse:collapse;width:100%}}td,th{{text-align:left;padding:8px;border-bottom:1px solid #ccd5df}}a{{color:#0758a5}}@media(max-width:650px){{.compare{{grid-template-columns:1fr}}body{{margin:10px auto}}}}</style><h1>元画像は目標達成。未使用視点は未達。</h1><p>2026-11-19 実行。目標：車体固定ROIの <strong>SSIM ≥0.85、PSNR ≥20 dB</strong>。輪郭IoUは採否に使いません。</p><table><tr><th>評価対象</th><th>PSNR</th><th>SSIM</th><th>判定</th></tr><tr><td>元画像240×180・学習参照</td><td>{a["psnr_db"]:.2f} dB</td><td>{a["ssim"]:.3f}</td><td>達成（学習画像への適合）</td></tr><tr><td>未使用12視点1160×652</td><td>{b["pooled_psnr_db"]:.2f} dB</td><td>{b["mean_ssim"]:.3f}</td><td>未達・総合採用は拒否</td></tr></table><p>前回は元画像11.72 dB / 0.327、未使用12視点12.02 dB / 0.452でした。<a href="image-audit.html">旧モデルの実レンダー</a>と比較できます。</p><section><h2>何を変えたか</h2><p>公式36方向中24枚からSIFT/COLMAPで透視カメラと疎な3D点を推定し、512段階の車体占有格子から固定3D表面を作成。24枚と元画像を、その表面へ投影する視線依存マテリアルとしてBlender/Cyclesで描画しました。元画像の位置は48個の特徴点インライアで推定。24カメラの平均再投影誤差は0.798 pxです。</p><p><strong>写真を使った外観再現です。</strong> 元画像も学習に含めたため、その高得点だけで未知視点への再現性や精密CADを証明できません。物理的な材質・反射率の復元ではありません。画像を後から変形・位置合わせして採点していません。</p></section>{"".join(figures)}<section><h2>固定した評価条件</h2><p>車体の評価枠は参照写真のみで決定し、旧版と同じ image_metrics.py で計測。元の解像度でRGBを比較し、透過PNGを白に合成。SSIMはGaussian σ1.5、11×11、RGB、data_range=1。PSNRは領域内MSEから算出。12視点はMSEを画素数で集計したPSNRと視点平均SSIMを表示します。白背景全体の指標、車体のみ、和集合もJSONに併記します。</p><p>未使用フレームは3,6,…,36。写真をSfM・表面・マテリアルに使用せず、学習カメラの回転SLERPとカメラ空間並進の線形補間で予測。これは事前固定分割の再評価であり、改善過程で結果を確認したため完全な未知データでの最終保証ではありません。</p><table><tr><th>フレーム</th><th>PSNR dB</th><th>SSIM</th></tr>{rows}</table></section><section><h2>不採用にした実験</h2><p>カメラ中心の独立補間は投影ずれが大きく、学習視点のleave-one-out投影検査を根拠に並進補間へ変更しました。学習写真間の光学フローから奥行きを推定したPoisson表面も試しましたが、元画像17.33 dB / 0.847へ悪化したため不採用。未使用写真の特徴点でカメラだけを推定する別診断は18.22 dB / 0.735で、上の盲検評価には混ぜていません。</p></section><p><a href="refinement-metrics.json">全計測値・画像SHA256</a> / <a href="refinement-render-checks.json">Blender実行・カメラ投影検査</a> / <a href="README.md">再実行と制限</a></p></html>"""
    (destination / "photometric-refinement.html").write_text(html)
    receipt = dict(
        schema_version=1,
        accepted=result["accepted"],
        input_target_met=result["input_target_met"],
        blind_target_met=result["blind_target_met"],
        source_files={
            str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / "scripts/vehicle3d").glob("*"))
            if p.is_file()
        },
        generated_files={
            name: dict(
                bytes=(render / name).stat().st_size,
                sha256=hashlib.sha256((render / name).read_bytes()).hexdigest(),
                included_in_git=False,
            )
            for name in ["projective.blend"]
        },
        review_files={
            p.name: dict(
                bytes=p.stat().st_size,
                sha256=hashlib.sha256(p.read_bytes()).hexdigest(),
            )
            for p in sorted(destination.glob("*"))
            if p.name.startswith(("refinement-", "photometric-"))
            and p.name != "refinement-receipt.json"
        },
    )
    if any(v["bytes"] > 750000 for v in receipt["review_files"].values()):
        raise ValueError("Oversized review artifact")
    (destination / "refinement-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--render", type=Path, required=True)
    parser.add_argument("--destination", type=Path, default=ROOT / "docs/vehicle3d")
    args = parser.parse_args()
    publish(args.cache_dir.resolve(), args.render.resolve(), args.destination.resolve())
