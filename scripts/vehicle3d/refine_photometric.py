"""Reconstruct training photos, render fixed geometry, and enforce RGB quality gates.

Requires acquired cache from runtime.py and optional requirements-photometric.txt.
No target image may supply appearance or geometry for the twelve blind test views.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from image_metrics import aggregate, compare_images
from perspective_model import photo_training_mask
from PIL import Image
from reconstruction import foreground

SCRIPTS = Path(__file__).resolve().parent
TRAIN = [f for f in range(1, 37) if f % 3]
TEST = list(range(3, 37, 3))
TARGET = dict(psnr_db=20.0, ssim=0.85)


def passes(metrics):
    return (
        metrics["psnr_db"] is None or metrics["psnr_db"] >= TARGET["psnr_db"]
    ) and metrics["ssim"] >= TARGET["ssim"]


def evaluate(cache, rendered):
    rows = []
    for frame in ["input"] + TEST:
        source = cache / (
            "reference.jpg" if frame == "input" else f"references/spin-{frame:02}.jpg"
        )
        reference = Image.open(source).convert("RGB")
        name = "input" if frame == "input" else f"{frame:02}"
        output = rendered / f"frame-{name}.png"
        rgba = Image.open(output).convert("RGBA")
        if reference.size != rgba.size:
            raise ValueError(
                "Evaluation requires native resolution without registration/warping"
            )
        white = Image.new("RGBA", rgba.size, "white")
        white.alpha_composite(rgba)
        row = dict(
            frame=frame,
            source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            render_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
            metrics=compare_images(
                np.asarray(reference),
                np.asarray(white.convert("RGB")),
                foreground(reference),
                np.asarray(rgba)[:, :, 3] > 127,
            ),
        )
        rows.append(row)
    blind = aggregate([row["metrics"] for row in rows[1:]])
    blind_score = dict(
        psnr_db=blind["reference_roi"]["pooled_psnr_db"],
        ssim=blind["reference_roi"]["mean_ssim"],
    )
    fitted = rows[0]["metrics"]["reference_roi"]
    accepted = passes(fitted) and passes(blind_score)
    result = dict(
        schema_version=1,
        target=TARGET,
        input_is_training_supervision=True,
        training_frames=TRAIN,
        input_training_images=1,
        blind_test_frames=TEST,
        method="fixed perspective visual hull with view-dependent photographic radiance",
        physical_accuracy_certified=False,
        physical_albedo_recovered=False,
        evaluation="frozen source-defined vehicle ROI; native RGB; white compositing; no post-render alignment",
        input=fitted,
        blind_test=blind,
        rows=rows,
        input_target_met=passes(fitted),
        blind_target_met=passes(blind_score),
        accepted=accepted,
        status="accepted" if accepted else "novel-view-target-unmet",
    )
    (rendered / "refinement-metrics.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--blender", type=Path)
    parser.add_argument(
        "--evaluate-only",
        type=Path,
        help="Score an existing render directory without refitting",
    )
    args = parser.parse_args()
    cache = args.cache_dir.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.evaluate_only:
        result = evaluate(cache, args.evaluate_only.resolve())
    else:
        if not args.blender:
            parser.error("--blender is required for reconstruction")
        events = out / "events.jsonl"

        def run(stage, command):
            with events.open("a") as log:
                log.write(
                    json.dumps(
                        dict(
                            stage=stage,
                            state="started",
                            command=[str(c) for c in command],
                        )
                    )
                    + "\n"
                )
            with (out / f"{stage}.log").open("w") as log:
                subprocess.run(
                    [str(c) for c in command],
                    check=True,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    env={**os.environ, "VEHICLE3D_OUT": str(out / "render")},
                )
            with events.open("a") as log:
                log.write(json.dumps(dict(stage=stage, state="completed")) + "\n")

        run(
            "sfm",
            [
                sys.executable,
                SCRIPTS / "sfm_refine.py",
                "--cache-dir",
                cache,
                "--output",
                out / "sfm",
            ],
        )
        run(
            "hull",
            [
                sys.executable,
                SCRIPTS / "perspective_model.py",
                "--sfm",
                out / "sfm",
                "--cache-dir",
                cache,
                "--output",
                out / "model",
                "--resolution",
                "512",
            ],
        )
        run(
            "input-pose",
            [
                sys.executable,
                SCRIPTS / "localize_input.py",
                "--sfm",
                out / "sfm",
                "--model",
                out / "model",
                "--cache-dir",
                cache,
                "--output",
                out / "input-pose",
            ],
        )
        textures = out / "textures"
        textures.mkdir(exist_ok=True)
        for frame in TRAIN + ["input"]:
            file = "input.png" if frame == "input" else f"spin-{frame:02}.png"
            source = cache / (
                "reference.jpg"
                if frame == "input"
                else f"references/spin-{frame:02}.jpg"
            )
            image = Image.open(source).convert("RGBA")
            image.putalpha(
                Image.fromarray(photo_training_mask(image).astype(np.uint8) * 255)
            )
            image.save(textures / file)
        render = out / "render"
        render.mkdir(exist_ok=True)
        request = dict(
            mesh=str(out / "model/perspective-mesh.npz"),
            cameras=str(out / "input-pose/cameras-with-input.json"),
            texture_dir=str(textures),
            source_frames=TRAIN + ["input"],
            render_frames=["input"] + TEST,
            weight_power=256,
            input_confidence=4,
        )
        (render / "projective-request.json").write_text(json.dumps(request, indent=2))
        run(
            "render",
            [
                args.blender,
                "--background",
                "--threads",
                "8",
                "--python",
                SCRIPTS / "render_projective.py",
            ],
        )
        result = evaluate(cache, render)
    print(
        json.dumps(
            {
                k: result[k]
                for k in [
                    "status",
                    "input",
                    "input_target_met",
                    "blind_target_met",
                    "accepted",
                ]
            },
            indent=2,
        )
    )
    return 0 if result["accepted"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
