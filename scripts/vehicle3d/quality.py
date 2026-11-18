"""Independent numeric gates. A visual score never certifies physical accuracy."""

import math


def iou(predicted, reference):
    intersection = (predicted & reference).sum()
    union = (predicted | reference).sum()
    if not union:
        raise ValueError("Empty reference and prediction cannot be scored")
    return float(intersection / union)


def choose_candidate(baseline, incumbent, candidate, minimum_improvement):
    scores = [baseline, incumbent, candidate, minimum_improvement]
    if not all(math.isfinite(v) for v in scores):
        raise ValueError("Non-finite quality metric")
    return candidate >= baseline + minimum_improvement and candidate > incumbent + 0.001


def apply_image_audit(result, audit, config):
    """Actual RGB renders decide acceptance. Silhouette overlap is auxiliary only."""
    metrics = audit["variants"]["delivered"]["aggregate"]["reference_roi"]
    psnr = metrics["pooled_psnr_db"]
    ssim = metrics["mean_ssim"]
    perfect = (
        psnr is None
        and metrics.get("perfect_match") is True
        and metrics.get("pooled_mse") == 0
    )
    if (not perfect and (psnr is None or not math.isfinite(psnr))) or not math.isfinite(
        ssim
    ):
        raise ValueError("Invalid image similarity score")
    input_score = audit["variants"]["delivered"]["input_target_fit"]["reference_roi"]
    input_passed = (
        input_score.get("perfect_match") is True
        or (
            input_score["psnr_db"] is not None
            and input_score["psnr_db"] >= config.get("minAppearancePSNR", 20)
        )
    ) and input_score["ssim"] >= config.get("minAppearanceSSIM", 0.8)
    passed = (
        (perfect or psnr >= config.get("minAppearancePSNR", 20))
        and ssim >= config.get("minAppearanceSSIM", 0.8)
        and input_passed
    )
    result["image_audit"] = dict(
        status="image-match-passed" if passed else "image-match-failed",
        primary_region="reference_roi",
        metrics=metrics,
        original_input=audit["variants"]["delivered"]["input_target_fit"][
            "reference_roi"
        ],
        source="actual Blender render; not software projection or silhouette",
    )
    result["assessment"]["appearance_gate"] = passed
    result["assessment"]["original_image_gate"] = input_passed
    result["deliverable_accepted"] = passed and result["assessment"]["dimension_gate"]
    result["status"] = (
        "image-match-passed" if result["deliverable_accepted"] else "image-match-failed"
    )
    return result


def assess_precision(visual_score, dimension_errors_mm, config, multiview=True):
    if (
        not 0 <= visual_score <= 1
        or not dimension_errors_mm
        or not all(math.isfinite(v) and v >= 0 for v in dimension_errors_mm.values())
    ):
        raise ValueError("Invalid score or dimension errors")
    return dict(
        visual_gate=multiview and visual_score >= config["minValidationIoU"],
        dimension_gate=max(dimension_errors_mm.values())
        <= config["maxDimensionErrorMm"],
        physical_accuracy_certified=False,
        precision_status="not-certified",
        missing_evidence=[
            "calibrated camera intrinsics/extrinsics",
            "independent physical measurements or OEM CAD",
            "surface and hidden-part tolerances",
        ],
    )
