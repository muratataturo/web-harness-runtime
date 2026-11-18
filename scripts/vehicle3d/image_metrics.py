"""Paired sRGB image metrics with a reference-defined ROI and explicit data range."""

import math
import numpy as np
from skimage.metrics import structural_similarity
from scipy.ndimage import binary_erosion


def region_metrics(reference, rendered, mask, ssim_map=None):
    if reference.dtype != np.uint8 or rendered.dtype != np.uint8:
        raise ValueError(
            "Expected uint8 sRGB arrays; no implicit value-range conversion"
        )
    if (
        reference.shape != rendered.shape
        or reference.ndim != 3
        or reference.shape[2] != 3
    ):
        raise ValueError(
            "Expected equally sized RGB images; alignment/resizing must be explicit"
        )
    if mask.shape != reference.shape[:2] or not mask.any():
        raise ValueError("Empty or mismatched metric region")
    a = np.asarray(reference, dtype=np.float64) / 255
    b = np.asarray(rendered, dtype=np.float64) / 255
    difference = (a - b)[mask]
    mse = float(np.mean(difference**2))
    psnr = None if mse == 0 else -10 * math.log10(mse)
    if ssim_map is None:
        _, ssim_map = structural_similarity(
            a,
            b,
            data_range=1.0,
            channel_axis=-1,
            gaussian_weights=True,
            sigma=1.5,
            use_sample_covariance=False,
            full=True,
        )
    # SSIM uses an 11x11 Gaussian window. Avoid leaking pixels outside the ROI.
    interior = binary_erosion(mask, iterations=5, border_value=0)
    if not interior.any():
        raise ValueError("Metric region too small for SSIM window")
    return dict(
        psnr_db=psnr,
        perfect_match=mse == 0,
        mse=mse,
        ssim=float(ssim_map.mean(2)[interior].mean()),
        mae_8bit=float(np.abs(difference).mean() * 255),
        pixels=int(mask.sum()),
        ssim_pixels=int(interior.sum()),
    )


def compare_images(reference, rendered, reference_mask, render_alpha=None):
    if reference.dtype != np.uint8 or rendered.dtype != np.uint8:
        raise ValueError("Expected uint8 sRGB arrays")
    if reference.shape != rendered.shape:
        raise ValueError("Image shapes differ; no implicit registration")
    height, width = reference.shape[:2]
    ys, xs = np.where(reference_mask)
    if not len(xs):
        raise ValueError("No reference foreground")
    margin = max(8, round(max(np.ptp(xs), np.ptp(ys)) * 0.025))
    left = max(0, int(xs.min()) - margin)
    right = min(width, int(xs.max()) + margin + 1)
    top = max(0, int(ys.min()) - margin)
    bottom = min(height, int(ys.max()) + margin + 1)
    roi = np.zeros((height, width), bool)
    roi[top:bottom, left:right] = True
    regions = {
        "reference_roi": roi,
        "full_frame": np.ones((height, width), bool),
        "reference_foreground": reference_mask,
    }
    if render_alpha is not None:
        if render_alpha.shape != reference_mask.shape:
            raise ValueError("Alpha shape differs")
        regions["foreground_union"] = reference_mask | (render_alpha > 0)
    _, ssim_map = structural_similarity(
        reference.astype(float) / 255,
        rendered.astype(float) / 255,
        data_range=1.0,
        channel_axis=-1,
        gaussian_weights=True,
        sigma=1.5,
        use_sample_covariance=False,
        full=True,
    )
    result = {
        name: region_metrics(reference, rendered, mask, ssim_map)
        for name, mask in regions.items()
    }
    result["reference_roi_xyxy"] = [left, top, right, bottom]
    return result


def aggregate(rows):
    result = {}
    for region in (
        "reference_roi",
        "full_frame",
        "reference_foreground",
        "foreground_union",
    ):
        values = [row[region] for row in rows if region in row]
        pixels = sum(v["pixels"] for v in values)
        pooled = sum(v["mse"] * v["pixels"] for v in values) / pixels
        psnrs = [v["psnr_db"] for v in values if v["psnr_db"] is not None]
        result[region] = dict(
            pooled_psnr_db=None if pooled == 0 else -10 * math.log10(pooled),
            pooled_mse=pooled,
            perfect_match=pooled == 0,
            mean_ssim=float(np.mean([v["ssim"] for v in values])),
            worst_psnr_db=min(psnrs) if psnrs else None,
            worst_ssim=min(v["ssim"] for v in values),
            views=len(values),
            pixels=pixels,
        )
    return result
