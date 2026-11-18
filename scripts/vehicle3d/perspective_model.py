"""Perspective visual hull and camera interpolation from training-only SfM."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from reconstruction import foreground, smooth_mesh
from scipy import ndimage
from scipy.spatial.transform import Rotation, Slerp
from skimage.measure import marching_cubes


def photo_training_mask(image):
    """Keep neutral gray glass/highlights inside a conservatively detected car box.

    Used only to reconstruct/texture training photos. Evaluation masks/ROIs remain frozen.
    """
    rgb = np.asarray(image.convert("RGB"))
    seed = foreground(image)
    yy, xx = np.where(seed)
    allowed = np.zeros(seed.shape, bool)
    allowed[
        max(0, yy.min() - 3) : min(len(allowed), yy.max() + 4),
        max(0, xx.min() - 3) : min(allowed.shape[1], xx.max() + 4),
    ] = True
    mask = (rgb.min(2) < 245) & allowed
    mask = ndimage.binary_closing(mask, iterations=2)
    labels, n = ndimage.label(mask)
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    return ndimage.binary_fill_holes(labels == sizes.argmax())


def project(vertices, camera):
    points = vertices @ np.array(camera["R"]).T + np.array(camera["t"])
    K = np.array(camera["K"])
    uv = points[:, :2] / points[:, 2, None]
    return uv * np.diag(K)[:2] + K[:2, 2], points[:, 2]


def interpolate_cameras(training):
    """Periodic SLERP rotations and linear camera-space translations.

    This rule was selected using leave-one-out training projections. Interpolating
    camera centers independently caused large projection drift with SfM poses.
    Target image features and pixels do not enter this blind camera prediction.
    """
    transformed = dict(training)
    frames = sorted(training)
    times = np.array([frames[-1] - 36] + frames + [frames[0] + 36])
    rows = (
        [training[frames[-1]]] + [training[f] for f in frames] + [training[frames[0]]]
    )
    rotations = Slerp(times, Rotation.from_matrix([r["R"] for r in rows]))
    translations = np.array([r["t"] for r in rows])
    for frame in range(1, 37):
        if frame in transformed:
            continue
        R = rotations(frame).as_matrix()
        t = np.array(
            [np.interp(frame, times, translations[:, axis]) for axis in range(3)]
        )
        transformed[frame] = dict(
            R=R.tolist(),
            t=t.tolist(),
            K=rows[0]["K"],
            center=(-R.T @ t).tolist(),
            interpolated=True,
        )
    return transformed


def normalized_cameras(sfm):
    raw = json.loads((sfm / "perspective-cameras.json").read_text())
    points = np.load(sfm / "sparse-points.npz")["vertices"]
    up = np.mean([-np.array(c["R"])[1] for c in raw.values()], axis=0)
    up /= np.linalg.norm(up)
    center = np.median(points, axis=0)
    centered = points - center
    flat = centered - np.outer(centered @ up, up)
    _, _, v = np.linalg.svd(flat, full_matrices=False)
    x = v[0]
    x -= x @ up * up
    x /= np.linalg.norm(x)
    if (np.array(raw["spin-31.jpg"]["center"]) - center) @ x < 0:
        x = -x
    y = np.cross(up, x)
    basis = np.stack([x, y, up], axis=1)
    transformed = {}
    for name, c in raw.items():
        R = np.array(c["R"])
        t = np.array(c["t"])
        frame = int(name[5:7])
        transformed[frame] = dict(
            R=(R @ basis).tolist(),
            t=(R @ center + t).tolist(),
            K=c["K"],
            center=((np.array(c["center"]) - center) @ basis).tolist(),
        )
    transformed = interpolate_cameras(transformed)
    return (
        transformed,
        centered @ basis,
        dict(center=center.tolist(), basis=basis.tolist()),
    )


def build(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    cameras, points, transform = normalized_cameras(args.sfm)
    train = [f for f in range(1, 37) if not f % 3 == 0]
    masks = {
        f: ndimage.binary_dilation(
            photo_training_mask(
                Image.open(args.cache_dir / "references" / f"spin-{f:02}.jpg")
            ),
            iterations=1,
        )
        for f in train
    }
    # Sparse points include reflections/outliers. Quantiles define only a generous grid;
    # silhouette consistency decides which voxels survive.
    low, high = np.percentile(points, [1, 99], axis=0)
    span = high - low
    low -= span * 0.25
    high += span * 0.25
    step = (high[0] - low[0]) / args.resolution
    axes = [np.arange(a, b + step / 2, step) for a, b in zip(low, high)]
    shape = tuple(map(len, axes))
    grid = (
        np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)
        .reshape(-1, 3)
        .astype(np.float32)
    )
    count = np.zeros(len(grid), np.uint8)
    for frame in train:
        mask = masks[frame]
        h, w = mask.shape
        for start in range(0, len(grid), 200000):
            uv, depth = project(grid[start : start + 200000], cameras[frame])
            xy = np.rint(uv).astype(int)
            valid = (
                (depth > 0)
                & (xy[:, 0] >= 0)
                & (xy[:, 0] < w)
                & (xy[:, 1] >= 0)
                & (xy[:, 1] < h)
            )
            inside = np.zeros(len(xy), bool)
            inside[valid] = mask[xy[valid, 1], xy[valid, 0]]
            count[start : start + len(xy)] += inside
    volume = (count >= len(train) - args.outlier_views).reshape(shape)
    labels, n = ndimage.label(volume)
    if not n:
        raise ValueError("Empty perspective hull")
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    volume = labels == sizes.argmax()
    boundary = int(
        volume[0].sum()
        + volume[-1].sum()
        + volume[:, 0].sum()
        + volume[:, -1].sum()
        + volume[:, :, 0].sum()
        + volume[:, :, -1].sum()
    )
    if boundary:
        raise ValueError("Perspective hull clipped by grid boundary")
    vertices, faces, _, _ = marching_cubes(
        np.pad(volume, 1).astype(np.float32), 0.5, spacing=(step, step, step)
    )
    vertices += low - step
    vertices = smooth_mesh(vertices, faces)
    np.savez_compressed(
        out / "perspective-mesh.npz",
        vertices=vertices.astype(np.float32),
        faces=faces.astype(np.int32),
    )
    (out / "perspective-cameras.json").write_text(
        json.dumps({str(k): v for k, v in cameras.items()}, indent=2)
    )
    summary = dict(
        method="training-only COLMAP perspective cameras + robust multi-view silhouette hull",
        training_frames=train,
        test_frames=list(range(3, 37, 3)),
        resolution=args.resolution,
        vertices=len(vertices),
        faces=len(faces),
        grid_shape=shape,
        step_world=float(step),
        world_to_canonical=transform,
        source_reprojection_error=json.loads(
            (args.sfm / "sfm-result.json").read_text()
        )["mean_reprojection_error"],
    )
    (out / "perspective-result.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sfm", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resolution", type=int, default=256)
    parser.add_argument("--outlier-views", type=int, default=1)
    build(parser.parse_args())
