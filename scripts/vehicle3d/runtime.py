#!/usr/bin/env python3
"""Bounded unattended reconstruction: acquire -> build -> carve -> validate -> adopt -> export.

No model-generated code is executed by this runtime. The checked-in Blender adapter is
the reviewed derivative of the earlier gpt-6.2-astra experiment.
"""

import argparse, base64, datetime, hashlib, json, math, os, shutil, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
import numpy as np
from PIL import Image
from quality import assess_precision, choose_candidate, apply_image_audit
from reconstruction import (
    foreground,
    calibrate,
    carve,
    evaluate,
    texture_assignment,
    fuse_vertex_colors,
    photometric_check,
)

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parent
ALLOWED_HOSTS = {
    "www3.nissan.co.jp",
    "www-asia.nissan-cdn.net",
    "img1.kakaku.k-img.com",
}


def validate_config(config):
    if config.get("schemaVersion") != 1:
        raise ValueError("Unsupported config schema")
    train = config["trainingFrames"]
    holdout = config["validationFrames"]
    test = config["testFrames"]
    if (
        not train
        or not holdout
        or not test
        or set(train) & set(holdout)
        or set(train) & set(test)
        or set(holdout) & set(test)
    ):
        raise ValueError(
            "Training, selection and final test sets must be nonempty and disjoint"
        )
    if (
        train != sorted(set(train))
        or holdout != sorted(set(holdout))
        or test != sorted(set(test))
        or any(
            not isinstance(f, int) or not 1 <= f <= 36 for f in train + holdout + test
        )
    ):
        raise ValueError("Invalid frame selection")
    if len(config["voxelResolutions"]) > 4 or any(
        not isinstance(v, int) or not 32 <= v <= 256 for v in config["voxelResolutions"]
    ):
        raise ValueError("Voxel resolution budget exceeded")
    spec = config["specification"]
    if any(
        not math.isfinite(spec[k]) or not 0 < spec[k] < 10
        for k in ("lengthM", "widthM", "heightM", "wheelbaseM")
    ):
        raise ValueError("Invalid physical dimensions")
    for url in (
        config["thumbnailUrl"],
        spec["url"],
        config["spinManifestUrl"],
        config["imageOrigin"],
    ):
        check_url(url)


def check_url(url):
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_HOSTS
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise ValueError("Unapproved reference URL")


class ApprovedRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, dest, offline=False):
    check_url(url)
    if offline:
        if not dest.is_file():
            raise FileNotFoundError(f"Offline cache missing: {dest.name}")
        if dest.stat().st_size > 10_000_000:
            raise ValueError("Cached reference exceeds 10 MB limit")
    else:
        with build_opener(ApprovedRedirect()).open(
            Request(url, headers={"User-Agent": "Vehicle3DResearch/1.0"}), timeout=30
        ) as response:
            check_url(response.url)
            raw = response.read(10_000_001)
            if len(raw) > 10_000_000:
                raise ValueError("Reference exceeds 10 MB limit")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
    return dict(
        url=url,
        sha256=hashlib.sha256(dest.read_bytes()).hexdigest(),
        bytes=dest.stat().st_size,
        mode="offline-cache" if offline else "network",
    )


def dimension_measure(vertices):
    # Nominal body width excludes mirror zone, tire sidewalls and trim at vehicle ends.
    body = vertices[
        (abs(vertices[:, 0]) < 1.0) & (vertices[:, 2] > 0.65) & (vertices[:, 2] < 1.1)
    ]
    if len(body) < 10:
        raise ValueError("Insufficient body surface for width constraint")
    return dict(
        lengthM=float(np.ptp(vertices[:, 0])),
        widthM=float(np.ptp(body[:, 1])),
        heightM=float(np.ptp(vertices[:, 2])),
    )


def constrain_dimensions(vertices, spec):
    out = vertices.copy()
    measured = dimension_measure(out)
    for axis, key in enumerate(("lengthM", "widthM", "heightM")):
        out[:, axis] *= spec[key] / measured[key]
    out[:, 2] -= out[:, 2].min()
    return out


def canonicalize(vertices, cameras, spec):
    """Fix the affine reconstruction's coordinate gauge using nominal body dimensions.

    Transform cameras with geometry, preserving every image projection. This enforces a
    coordinate convention; it does not turn affine cameras into physical calibration.
    """
    scale = np.ones(3)
    translation = np.zeros(3)
    result = vertices.astype(float).copy()
    # Re-evaluate the body band after height normalization; one pass may change which
    # vertices fall in that band. Any remaining residual is still reported, not hidden.
    for _ in range(4):
        measured = dimension_measure(result)
        step = np.array(
            [spec[k] / measured[k] for k in ("lengthM", "widthM", "heightM")]
        )
        shift = np.array([0.0, 0.0, -result[:, 2].min() * step[2]])
        result = result * step + shift
        scale *= step
        translation = translation * step + shift
    transformed = {}
    for frame, c in cameras.items():
        right = c["right"] / scale
        up = c["up"] / scale
        direction = c["direction"] * scale
        direction /= np.linalg.norm(direction)
        offset = c["offset"] + np.array(
            [-right @ translation * c["scale"][0], up @ translation * c["scale"][1]]
        )
        transformed[frame] = {
            **c,
            "right": right,
            "up": up,
            "direction": direction,
            "offset": offset,
        }
    return result.astype(np.float32), transformed, scale, translation


def blender(blender_bin, script, out, log, timeout=180):
    env = {**os.environ, "VEHICLE3D_OUT": str(out), "PYTHONDONTWRITEBYTECODE": "1"}
    with log.open("w") as output:
        subprocess.run(
            [
                blender_bin,
                "--background",
                "--factory-startup",
                "--python-exit-code",
                "1",
                "--python",
                str(SCRIPT / script),
            ],
            env=env,
            stdout=output,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=timeout,
            cwd=ROOT,
        )


def run(args):
    config = json.loads(Path(args.config).read_text())
    validate_config(config)
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache_dir).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    events = []

    def event(stage, **details):
        item = dict(
            sequence=len(events) + 1,
            stage=stage,
            elapsed_s=round(time.monotonic() - started, 3),
            **details,
        )
        events.append(item)
        with (out / "events.jsonl").open("a") as f:
            f.write(json.dumps(item) + "\n")
        print(json.dumps(item), flush=True)

    if (out / "events.jsonl").exists():
        raise ValueError("Output contains an existing run; choose a fresh directory")
    event("acquire_references", profile=config["profile"])
    evidence = []
    evidence.append(fetch(config["spinManifestUrl"], cache / "spin.json", args.offline))
    evidence.append(
        fetch(config["specification"]["url"], cache / "specsheet.pdf", args.offline)
    )
    evidence.append(
        fetch(config["thumbnailUrl"], cache / "reference.jpg", args.offline)
    )
    manifest = json.loads((cache / "spin.json").read_text())
    colour = next(c for c in manifest["colours"] if c["key"] == config["colour"])
    paths = colour["imagePaths"]["standard"]["large"]
    images = {}
    masks = {}
    reference_paths = {}
    for frame in sorted(
        config["trainingFrames"] + config["validationFrames"] + config["testFrames"]
    ):
        path = cache / "references" / f"spin-{frame:02}.jpg"
        if not paths[frame - 1].startswith("/content/dam/Nissan/jp/vehicles/kicks/"):
            raise ValueError("Unexpected manifest image path")
        evidence.append(
            fetch(config["imageOrigin"] + paths[frame - 1], path, args.offline)
        )
        images[frame] = Image.open(path).convert("RGB")
        masks[frame] = foreground(images[frame])
        reference_paths[frame] = str(path)
    (out / "evidence.json").write_text(json.dumps(evidence, indent=2))
    event(
        "build_baseline",
        origin="reviewed gpt-6.2-astra generated script from prior experiment",
    )
    base = out / "baseline"
    base.mkdir()
    shutil.copyfile(cache / "reference.jpg", base / "reference.jpg")
    blender(args.blender, "build_scene.py", base, out / "baseline.log")
    cloud = np.load(base / "baseline-cloud.npz")
    original = cloud["vertices"]
    faces = cloud["faces"]
    calibrated = constrain_dimensions(original, config["specification"])
    cameras = calibrate(calibrated, sorted(images), masks, config)
    (out / "cameras.json").write_text(
        json.dumps(
            {str(k): {n: v.tolist() for n, v in c.items()} for k, c in cameras.items()},
            indent=2,
        )
    )
    baseline, _ = evaluate(original, faces, cameras, masks, config["validationFrames"])
    event(
        "baseline_scored",
        **baseline,
        camera_model="estimated affine; holdout framing interpolated only from training frames",
    )
    best_score = baseline["mean_iou"]
    best = None
    rounds = []
    last_error = None
    for resolution in config["voxelResolutions"]:
        event(
            "carve", resolution=resolution, training_views=len(config["trainingFrames"])
        )
        try:
            vertices, triangles, stats = carve(
                calibrated, resolution, cameras, masks, config
            )
            vertices, candidate_cameras, gauge_scale, gauge_translation = canonicalize(
                vertices, cameras, config["specification"]
            )
            metrics, predictions = evaluate(
                vertices,
                triangles,
                candidate_cameras,
                masks,
                config["validationFrames"],
            )
            adopted = choose_candidate(
                baseline["mean_iou"],
                best_score,
                metrics["mean_iou"],
                config["quality"]["minImprovement"],
            )
            round_result = dict(
                resolution=resolution,
                **stats,
                **metrics,
                adopted=adopted,
                triangles=len(triangles),
            )
            rounds.append(round_result)
            event("candidate_reviewed", **round_result)
            if adopted:
                best_score = metrics["mean_iou"]
                best = (
                    vertices,
                    triangles,
                    stats,
                    predictions,
                    resolution,
                    candidate_cameras,
                    gauge_scale,
                    gauge_translation,
                )
        except ValueError as error:
            last_error = str(error)
            event("candidate_rejected", resolution=resolution, reason=last_error)
    if best is None:
        result = dict(
            status="no-improvement",
            baseline=baseline,
            rounds=rounds,
            precision_status="not-certified",
            error=last_error,
        )
        (out / "result.json").write_text(json.dumps(result, indent=2))
        event("finished", status="no-improvement")
        return 2
    (
        vertices,
        triangles,
        stats,
        predictions,
        resolution,
        selected_cameras,
        gauge_scale,
        gauge_translation,
    ) = best
    # Same-camera baseline check: a joint coordinate transform must preserve the baseline score.
    gauge_baseline, _ = evaluate(
        original * gauge_scale + gauge_translation,
        faces,
        selected_cameras,
        masks,
        config["validationFrames"],
    )
    if abs(gauge_baseline["mean_iou"] - baseline["mean_iou"]) > 0.0001:
        raise ValueError("Baseline projection changed during normalization")
    triangles, materials, uvs = texture_assignment(
        vertices, triangles, selected_cameras, config["trainingFrames"]
    )
    colors = fuse_vertex_colors(
        vertices, triangles, selected_cameras, images, masks, config["trainingFrames"]
    )
    event("final_test", test_views=len(config["testFrames"]), used_for_selection=False)
    test_baseline, _ = evaluate(original, faces, cameras, masks, config["testFrames"])
    test_selected, predictions = evaluate(
        vertices, triangles, selected_cameras, masks, config["testFrames"]
    )
    event(
        "check_photographic_reprojection",
        test_views=len(config["testFrames"]),
    )
    appearance = photometric_check(
        vertices,
        triangles,
        colors,
        selected_cameras,
        images,
        masks,
        config["testFrames"],
    )
    np.savez_compressed(
        out / "selected-mesh.npz",
        vertices=vertices,
        faces=triangles,
        materials=materials,
        uvs=uvs,
        colors=colors,
    )
    width, height = next(iter(images.values())).size
    (out / "export-request.json").write_text(
        json.dumps(
            dict(
                reference_paths=[reference_paths[f] for f in config["trainingFrames"]],
                image_width=width,
                image_height=height,
            )
        )
    )
    measured = dimension_measure(vertices)
    errors = {k: abs(measured[k] - config["specification"][k]) * 1000 for k in measured}
    assessment = assess_precision(test_selected["mean_iou"], errors, config["quality"])
    assessment["appearance_gate"] = appearance["mean_psnr_db"] >= config["quality"].get(
        "minAppearancePSNR", 20
    )
    result = dict(
        schemaVersion=1,
        status="improved"
        if all(
            assessment[k] for k in ("visual_gate", "dimension_gate", "appearance_gate")
        )
        else "improved-incomplete",
        profile=config["profile"],
        baseline=baseline,
        rounds=rounds,
        appearance=appearance,
        final_test=dict(
            baseline=test_baseline,
            reconstructed=test_selected,
            used_for_selection=False,
        ),
        test_improvement_pp=(test_selected["mean_iou"] - test_baseline["mean_iou"])
        * 100,
        selected_resolution=resolution,
        selected_validation_iou=best_score,
        improvement_pp=(best_score - baseline["mean_iou"]) * 100,
        dimensions_m=measured,
        constraint_residual_mm=errors,
        assessment=assessment,
        voxel_size_mm=stats["voxel_size_mm"],
        training_views=config["trainingFrames"],
        validation_views=config["validationFrames"],
        test_views=config["testFrames"],
        method="multi-view silhouette visual hull; fused projected photographic vertex colors",
        limitations=[
            "estimated affine cameras, not calibrated perspective",
            "foreground mask may include contact shadows",
            "silhouette visual hull does not recover concavities or hidden parts",
            "projected photographic textures contain lighting",
            "dimension residual is constraint satisfaction, not independently measured accuracy",
            "wheelbase and mechanisms are not reconstructed as separate engineering parts",
        ],
        baseline_generator="gpt-6.2-astra (prior experiment, not called by this deterministic run)",
        affine_gauge_scale=gauge_scale.tolist(),
        affine_gauge_translation=gauge_translation.tolist(),
        same_camera_baseline_iou=gauge_baseline["mean_iou"],
    )
    event(
        "export_selected_mesh",
        triangles=len(triangles),
        precision_status=assessment["precision_status"],
    )
    blender(args.blender, "export_reconstruction.py", out, out / "export.log")
    # A held-out silhouette overlay: green intersection, orange missed, purple excess.
    overlays = []
    for frame, (prediction, target) in predictions.items():
        rgb = np.full((*prediction.shape, 3), 248, np.uint8)
        rgb[prediction & target] = [43, 164, 136]
        rgb[target & ~prediction] = [239, 139, 58]
        rgb[prediction & ~target] = [151, 105, 196]
        overlays.append(Image.fromarray(rgb).resize((348, 196)))
    panel = Image.new("RGB", (1044, 196 * math.ceil(len(overlays) / 3)), "white")
    for i, image in enumerate(overlays):
        panel.paste(image, (i % 3 * 348, i // 3 * 196))
    panel.save(out / "validation-overlays.jpg", quality=82)
    result["duration_s"] = round(time.monotonic() - started, 3)
    # An intentionally coarse, compact real-mesh viewer for the portable report.
    event("build_report_preview", resolution=48)
    pv, pf, _ = carve(calibrated, 48, cameras, masks, config)
    pv, pc, _, _ = canonicalize(pv, cameras, config["specification"])
    pf, pm, puv = texture_assignment(pv, pf, pc, config["trainingFrames"])
    preview_colors = fuse_vertex_colors(
        pv, pf, pc, images, masks, config["trainingFrames"]
    )
    viewer = dict(
        vertices=base64.b64encode(
            np.rint(pv[pf] * 10000).astype("<i2").tobytes()
        ).decode(),
        colors=base64.b64encode(preview_colors[pf].tobytes()).decode(),
        count=int(len(pf) * 3),
    )
    result["status"] = "image-audit-pending"
    (out / "result.json").write_text(json.dumps(result, indent=2))
    event(
        "audit_actual_rendered_images",
        primary_metrics=["PSNR", "SSIM"],
        region="reference_roi",
    )
    with (out / "image-audit.log").open("w") as log:
        rendered_audit = subprocess.run(
            [
                sys.executable,
                str(SCRIPT / "audit_images.py"),
                "--run",
                str(out),
                "--cache-dir",
                str(cache),
                "--output",
                str(out / "image-audit"),
                "--blender",
                args.blender,
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=400,
        )
    if rendered_audit.returncode not in (0, 2):
        raise RuntimeError("Actual-render image audit failed; see image-audit.log")
    apply_image_audit(
        result,
        json.loads((out / "image-audit/image-metrics.json").read_text()),
        config["quality"],
    )
    result["duration_s"] = round(time.monotonic() - started, 3)
    (out / "result.json").write_text(json.dumps(result, indent=2))
    from report import write_report

    write_report(out, result, config, events, viewer)
    event(
        "finished",
        status=result["status"],
        visual_gate=assessment["visual_gate"],
        dimension_gate=assessment["dimension_gate"],
        appearance_gate=assessment["appearance_gate"],
        physical_accuracy_certified=False,
    )
    return 0 if result["deliverable_accepted"] else 2


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "examples/vehicle3d/kicks.json"))
    p.add_argument("--blender", default=os.environ.get("BLENDER_BIN", "blender"))
    p.add_argument(
        "--output",
        default=str(
            ROOT
            / ".runtime/vehicle3d"
            / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        ),
    )
    p.add_argument("--cache-dir", default=str(ROOT / ".runtime/vehicle3d/cache"))
    p.add_argument("--offline", action="store_true")
    args = p.parse_args()
    try:
        return run(args)
    except Exception as error:
        print(f"Vehicle3D failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
