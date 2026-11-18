"""Render saved 3D models, compare against RGB references, and publish an image-first audit."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import numpy as np
from PIL import Image, ImageDraw
from skimage.metrics import structural_similarity
from image_metrics import compare_images, aggregate
from reconstruction import foreground

SCRIPT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected_cameras(run, result):
    cameras = json.loads((run / "cameras.json").read_text())
    scale = np.array(result["affine_gauge_scale"])
    translation = np.array(result["affine_gauge_translation"])
    selected = {}
    for frame, c in cameras.items():
        right = np.array(c["right"]) / scale
        up = np.array(c["up"]) / scale
        direction = np.array(c["direction"]) * scale
        direction /= np.linalg.norm(direction)
        offset = np.array(c["offset"]) + np.array(
            [-right @ translation * c["scale"][0], up @ translation * c["scale"][1]]
        )
        selected[frame] = {
            **c,
            "right": right.tolist(),
            "up": up.tolist(),
            "direction": direction.tolist(),
            "offset": offset.tolist(),
        }
    return selected


def bbox(mask):
    ys, xs = np.where(mask)
    return [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]


def input_camera(cache, cameras):
    """Target fit only: select a nearby official angle, fit framing from the input bbox.

    The user thumbnail has unknown camera calibration. This row is explicitly excluded
    from independent test averages. No rendered pixels are warped or color-corrected.
    """
    target = Image.open(cache / "reference.jpg").convert("RGB")
    tb = bbox(foreground(target))
    patch = np.array(target.crop(tb).resize((240, 140)), dtype=float) / 255
    ranked = []
    for frame in range(1, 37):
        image = Image.open(cache / "references" / f"spin-{frame:02}.jpg").convert("RGB")
        box = bbox(foreground(image))
        other = np.array(image.crop(box).resize((240, 140)), dtype=float) / 255
        score = structural_similarity(
            patch,
            other,
            data_range=1.0,
            channel_axis=-1,
            gaussian_weights=True,
            sigma=1.5,
            use_sample_covariance=False,
        )
        ranked.append((float(score), frame, box))
    _, frame, sb = max(ranked)
    ratio = np.array(
        [(tb[2] - tb[0]) / (sb[2] - sb[0]), (tb[3] - tb[1]) / (sb[3] - sb[1])]
    )
    c = cameras[str(frame)]
    offset = (np.array(c["offset"]) - np.array(sb[:2])) * ratio + np.array(tb[:2])
    return (
        {
            **c,
            "scale": (np.array(c["scale"]) * ratio).tolist(),
            "offset": offset.tolist(),
            "image_size": list(target.size),
        },
        dict(
            selected_official_frame=frame,
            classification="target-framing-fit, not an independent test",
            selection="SSIM of normalized official photo crops; no rendered image optimization",
            framing="input bbox fitted; no post-render registration",
        ),
        target,
    )


def composite(path):
    image = Image.open(path).convert("RGBA")
    alpha = np.array(image.getchannel("A"))
    white = Image.new("RGBA", image.size, "white")
    white.alpha_composite(image)
    return np.array(white.convert("RGB")), alpha


def make_panels(out, cache, frames):
    labels = [
        "REFERENCE",
        "BASELINE / actual render",
        "DELIVERED / actual render",
        "ABS ERROR x3",
        "50% OVERLAY",
    ]
    thumb_width = 240
    row_height = 190
    canvas = Image.new(
        "RGB", (thumb_width * 5, row_height * (len(frames) + 1)), "#f4f6f8"
    )
    draw = ImageDraw.Draw(canvas)
    for col, label in enumerate(labels):
        draw.text((col * thumb_width + 8, 8), label, fill="#173746")
    for index, frame in enumerate(frames):
        name = f"{frame:02}" if isinstance(frame, int) else str(frame)
        reference = np.array(
            Image.open(
                cache / "reference.jpg"
                if frame == "input"
                else cache / "references" / f"spin-{frame:02}.jpg"
            ).convert("RGB")
        )
        baseline, _ = composite(out / "baseline" / f"frame-{name}.png")
        rendered, _ = composite(out / "delivered" / f"frame-{name}.png")
        error = np.clip(
            np.abs(reference.astype(int) - rendered.astype(int)) * 3, 0, 255
        ).astype(np.uint8)
        overlay = ((reference.astype(float) + rendered) / 2).astype(np.uint8)
        box = bbox(foreground(Image.fromarray(reference)))
        pad = max(8, round((box[2] - box[0]) * 0.04))
        box = [
            max(0, box[0] - pad),
            max(0, box[1] - pad),
            min(reference.shape[1], box[2] + pad),
            min(reference.shape[0], box[3] + pad),
        ]
        for col, array in enumerate((reference, baseline, rendered, error, overlay)):
            image = Image.fromarray(array).crop(box)
            image.thumbnail((thumb_width - 8, 150))
            canvas.paste(
                image,
                (
                    col * thumb_width + (thumb_width - image.width) // 2,
                    35 + index * row_height,
                ),
            )
        draw.text((8, 190 + index * row_height), f"frame {name}", fill="#173746")
    canvas = canvas.crop((0, 0, thumb_width * 5, 35 + len(frames) * row_height))
    canvas.save(out / "comparisons.jpg", quality=84, optimize=True)


def number(value, precision=2):
    return "∞ (identical)" if value is None else f"{value:.{precision}f}"


def write_report(out, result):
    def embedded(path):
        return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()

    variants = result["variants"]
    current = variants["delivered"]["aggregate"]["reference_roi"]
    old = variants["baseline"]["aggregate"]["reference_roi"]
    rows = ""
    for frame in result["test_frames"]:
        a = variants["baseline"]["per_view"][str(frame)]["reference_roi"]
        b = variants["delivered"]["per_view"][str(frame)]["reference_roi"]
        d = variants["unlit"]["per_view"][str(frame)]["reference_roi"]
        rows += f"<tr><td>{frame:02}</td><td>{number(a['psnr_db'])}</td><td>{a['ssim']:.3f}</td><td>{number(b['psnr_db'])}</td><td>{b['ssim']:.3f}</td><td>{number(d['psnr_db'])}</td></tr>"
    region_rows = ""
    for region, label in [
        ("reference_roi", "参照車体の固定ROI"),
        ("full_frame", "全画面（白背景を含む）"),
        ("reference_foreground", "参照前景のみ"),
        ("foreground_union", "参照とレンダーの前景の和集合"),
    ]:
        m = variants["delivered"]["aggregate"][region]
        region_rows += f"<tr><td>{label}</td><td>{number(m['pooled_psnr_db'])}</td><td>{m['mean_ssim']:.3f}</td></tr>"
    target = variants["delivered"]["input_target_fit"]["reference_roi"]
    document = f'''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>車体画像の一致検査 — PSNR / SSIM</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f3f5f7;color:#183241;font:15px/1.8 system-ui,sans-serif}}header{{padding:40px max(6vw,20px);background:#172f3d;color:white}}header small{{color:#8bd0d7}}h1{{font-size:clamp(28px,4vw,42px);line-height:1.3}}main{{max-width:1260px;margin:auto;padding:25px 20px}}section,.card{{border:1px solid #dce4e9;background:white;border-radius:12px;padding:22px;margin-bottom:20px}}.cards{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}.card b{{font-size:31px;display:block}}.bad{{color:#b54434}}.note{{background:#fff1da;border-left:4px solid #ce9431;padding:15px}}h2{{font-size:21px;margin-top:0}}img{{width:100%;display:block}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{padding:10px;border-bottom:1px solid #e3e9ed;text-align:left}}.scroll{{overflow-x:auto}}a{{color:#087985}}li{{margin-bottom:8px}}code{{font-size:12px}}@media(max-width:650px){{.cards{{grid-template-columns:1fr}}header{{padding:25px 20px}}}}</style>
<header><small>RGB IMAGE AUDIT / BLENDER RENDERS</small><h1>輪郭ではなく、画像として一致するか。</h1><p>保存した3DをBlenderで同じ推定投影から実際にレンダリング。参照画像に固定した領域で色と構造を測りました。</p></header><main>
<section><h2 class="bad">判定：画像一致の基準に未達</h2><p class="note"><b>前回の「輪郭が改善した」は「綺麗に再現できた」を意味しません。画像全体の再現は不十分です。</b> 前回の約14.1 dBは簡易描画の前景共通領域の値でした。今回の主指標は実際のBlenderレンダリングに対する固定ROIのPSNR・SSIMです。</p></section>
<div class="cards"><div class="card">実レンダーのPSNR / 固定ROI<b>{number(old["pooled_psnr_db"])} → {number(current["pooled_psnr_db"])} dB</b>旧モデル → 前回提示した復元モデル</div><div class="card">実レンダーのSSIM / 固定ROI<b>{old["mean_ssim"]:.3f} → {current["mean_ssim"]:.3f}</b>12視点の平均。高い方が近い。</div><div class="card">最悪の視点<b>{number(current["worst_psnr_db"])} dB / {current["worst_ssim"]:.3f}</b>平均だけで失敗を隠さない。</div></div>
<section><h2>ご指定の元画像への一致</h2><p>240×180の元画像との比較：<b>PSNR {number(target["psnr_db"])} dB / SSIM {target["ssim"]:.3f}</b>。近い公式ビューを選び、元画像の車体枠でカメラのフレーミングを合わせた値です。この行はターゲットへのフィットであり、独立テスト12視点の集計には入れません。</p><p>参照／旧モデルの実レンダー／復元モデルの実レンダー／差分×3／50%重ね合わせ。差分は黒いほど一致。</p><img src="{embedded(out / "input-comparison.jpg")}" alt="元の指定画像と実レンダリングの比較"></section>
<section><h2>参照写真と実際のレンダーを並べる</h2><p>復元・格子選択に使わなかった12視点。可視化は一部を抜粋しています。どの画像もレンダー後の位置合わせ・色補正・非剛体変形はしていません。</p><img src="{embedded(out / "comparisons.jpg")}" alt="参照、旧モデル、復元モデル、差分、重ね合わせの比較"></section>
<section><h2>白背景で数値を良く見せない</h2><div class="scroll"><table><tr><th>評価範囲</th><th>PSNR dB</th><th>SSIM</th></tr>{region_rows}</table></div><p>主指標は参照車体の外接枠＋余白を固定したROIです。穴や欠落は背景に置き換わった誤差として残します。前景の共通領域だけに切り詰めません。PSNRはsRGB、data_range=1、全視点の画素数でMSEをプールして計算。SSIMはGaussian窓でROI内部を評価しています。</p></section>
<section><h2>全12視点の結果</h2><div class="scroll"><table><tr><th>視点</th><th>旧PSNR</th><th>旧SSIM</th><th>復元PSNR</th><th>復元SSIM</th><th>照明なし診断PSNR</th></tr>{rows}</table></div><p>照明なし診断は写真から得た頂点色をそのまま表示する別レンダーです。保存済みモデルの見た目と混同せず、再照明・トーン変換が誤差に寄与しているかを切り分けるためだけに使います。</p></section>
<section><h2>評価条件と限界</h2><ul><li>実レンダーはCycles CPU・16 samples・元写真と同じ1160×652。アルファを白背景へ合成し、画像のsRGB値を直接比較。</li><li>カメラは前回の推定アフィン投影を再現しています。物理カメラの較正や実車形状の正しさを保証しません。Blenderの投影位置と計算上の位置の差が0.01px以下であることを検査。</li><li>独立テストは同じ公式360°系列の12画像。元の小画像の比較は別枠のターゲットフィット。</li><li>今回の受入ポリシーは固定ROIのPSNR≥20 dBかつSSIM≥0.8。普遍的な品質規格ではなく、数値と比較画像を併せて判断します。</li><li>前回モデルには面の凹凸、色のにじみ、位置・カメラのずれが残っています。輪郭IoUは補助指標に降格し、これだけでは採用・完成を認めません。</li></ul><p><a href="https://scikit-image.org/docs/stable/api/skimage.metrics.html">scikit-imageのPSNR・SSIM仕様</a> / <a href="image-metrics.json">全計測値JSON</a> / <a href="index.html">以前の輪郭・3Dレポート（補助資料）</a></p></section></main></html>'''
    (out / "image-audit.html").write_text(document)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--blender", default="blender")
    parser.add_argument("--skip-render", action="store_true")
    args = parser.parse_args()
    run = args.run.resolve()
    cache = args.cache_dir.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    result = json.loads((run / "result.json").read_text())
    cameras = selected_cameras(run, result)
    camera, input_fit, target = input_camera(cache, cameras)
    cameras["input"] = camera
    gauge = np.eye(4)
    gauge[:3, :3] = np.diag(result["affine_gauge_scale"])
    gauge[:3, 3] = result["affine_gauge_translation"]
    variants = [
        dict(name="baseline", blend=str(run / "baseline/vehicle.blend")),
        dict(name="delivered", blend=str(run / "reconstructed.blend")),
        dict(name="unlit", blend=str(run / "reconstructed.blend")),
    ]
    for variant in variants:
        variant["sha256"] = sha(Path(variant["blend"]))
    frames = result["test_views"]
    mesh = np.load(run / "selected-mesh.npz")
    points = mesh["vertices"][:: max(1, len(mesh["vertices"]) // 12)][:12]
    request = dict(
        variants=variants,
        frames=frames + ["input"],
        cameras=cameras,
        image_size=[1160, 652],
        baseline_gauge=gauge.tolist(),
        oracle_points=points.tolist(),
    )
    (out / "render-request.json").write_text(json.dumps(request, indent=2))
    if not args.skip_render:
        with (out / "renderer.log").open("w") as log:
            subprocess.run(
                [
                    args.blender,
                    "--background",
                    "--factory-startup",
                    "--python-exit-code",
                    "1",
                    "--python",
                    str(SCRIPT / "render_image_audit.py"),
                ],
                env={**os.environ, "VEHICLE3D_OUT": str(out)},
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=360,
            )
    checks = json.loads((out / "render-checks.json").read_text())
    expected_models = [dict(name=v["name"], sha256=v["sha256"]) for v in variants]
    if checks.get("source_models") != expected_models:
        raise ValueError("Cached renders do not match the source model hashes")
    for check in checks["checks"]:
        label = (
            f"{check['frame']:02}"
            if isinstance(check["frame"], int)
            else str(check["frame"])
        )
        file = out / check["variant"] / f"frame-{label}.png"
        if sha(file) != check["sha256"] or check["max_projection_error_px"] > 0.01:
            raise ValueError(
                "Render integrity or actual-mesh camera projection check failed"
            )
    output = dict(
        schemaVersion=1,
        scope="actual Blender render vs reference RGB, no post-render registration or color correction",
        primary_metric="reference_roi PSNR + SSIM",
        test_frames=frames,
        input_camera_fit=input_fit,
        protocol=dict(
            color_domain="sRGB float [0,1]",
            psnr="pooled RGB MSE; explicit data_range=1",
            ssim="scikit-image Gaussian sigma=1.5, population covariance, 11x11 window; ROI eroded by 5px",
            roi="reference bbox + 2.5% margin; does not depend on prediction",
            camera="saved estimated affine projection; object-space realization in Blender, not physically calibrated",
            background="render alpha composited on white",
        ),
        inputs={
            p.name: dict(sha256=sha(p), bytes=p.stat().st_size)
            for p in (run / "reconstructed.blend", run / "baseline/vehicle.blend")
        },
        variants={},
    )
    for variant in variants:
        records = {}
        for frame in frames + ["input"]:
            name = f"{frame:02}" if isinstance(frame, int) else str(frame)
            reference = np.array(
                target
                if frame == "input"
                else Image.open(cache / "references" / f"spin-{frame:02}.jpg").convert(
                    "RGB"
                )
            )
            rendered, alpha = composite(out / variant["name"] / f"frame-{name}.png")
            records[str(frame)] = compare_images(
                reference, rendered, foreground(Image.fromarray(reference)), alpha
            )
        output["variants"][variant["name"]] = dict(
            aggregate=aggregate([records[str(f)] for f in frames]),
            per_view={str(f): records[str(f)] for f in frames},
            input_target_fit=records["input"],
        )
    measured = output["variants"]["delivered"]["aggregate"]["reference_roi"]
    input_measured = output["variants"]["delivered"]["input_target_fit"][
        "reference_roi"
    ]
    output["accepted"] = (
        (
            measured.get("perfect_match") is True
            or (
                measured["pooled_psnr_db"] is not None
                and measured["pooled_psnr_db"] >= 20
            )
        )
        and measured["mean_ssim"] >= 0.8
        and (
            input_measured.get("perfect_match") is True
            or (
                input_measured["psnr_db"] is not None
                and input_measured["psnr_db"] >= 20
            )
        )
        and input_measured["ssim"] >= 0.8
    )
    output["status"] = (
        "image-match-passed" if output["accepted"] else "image-match-failed"
    )
    output["reference_hashes"] = {
        f"spin-{f:02}.jpg": sha(cache / "references" / f"spin-{f:02}.jpg")
        for f in frames
    }
    output["reference_hashes"]["input.jpg"] = sha(cache / "reference.jpg")
    (out / "image-metrics.json").write_text(json.dumps(output, indent=2) + "\n")
    make_panels(out, cache, [3, 9, 15, 21, 27, 33])
    (out / "comparisons.jpg").rename(out / "test-comparisons.jpg")
    make_panels(out, cache, ["input"])
    (out / "comparisons.jpg").rename(out / "input-comparison.jpg")
    (out / "test-comparisons.jpg").rename(out / "comparisons.jpg")
    write_report(out, output)
    print(
        json.dumps(
            dict(
                status=output["status"],
                delivered=measured,
                input=output["variants"]["delivered"]["input_target_fit"][
                    "reference_roi"
                ],
            ),
            indent=2,
        ),
        flush=True,
    )
    return 0 if output["accepted"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
