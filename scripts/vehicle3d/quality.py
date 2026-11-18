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
