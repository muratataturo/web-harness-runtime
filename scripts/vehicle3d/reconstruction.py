"""Multi-view silhouette carving. Estimated affine cameras; no metric certification."""

import math
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.sparse import coo_matrix
from skimage.measure import marching_cubes
from quality import iou


def foreground(image):
    a = np.asarray(image.convert("RGB"), dtype=np.int16)
    # White studio backdrop and low-saturation floor shadows. No learned segmentation.
    raw = (a.max(2) < 75) | ((a.max(2) - a.min(2) > 24) & (a.min(2) < 220))
    raw = ndimage.binary_closing(raw, iterations=2)
    labels, n = ndimage.label(raw)
    if not n:
        raise ValueError("No foreground object")
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    mask = ndimage.binary_fill_holes(labels == sizes.argmax())
    if mask.sum() < image.width * image.height * 0.02:
        raise ValueError("Foreground too small")
    return mask


def basis(frame, config):
    c = config["camera"]
    azimuth = math.radians(c["initialAzimuthDeg"] + (frame - 1) * c["frameStepDeg"])
    elevation = math.radians(c["elevationDeg"])
    direction = np.array(
        [
            math.cos(azimuth) * math.cos(elevation),
            -math.sin(azimuth) * math.cos(elevation),
            math.sin(elevation),
        ]
    )
    right = np.array([-math.sin(azimuth), -math.cos(azimuth), 0])
    up = np.cross(right, direction)
    return right, up, direction


def projection(vertices, camera):
    return np.stack(
        [
            vertices @ camera["right"] * camera["scale"][0] + camera["offset"][0],
            -vertices @ camera["up"] * camera["scale"][1] + camera["offset"][1],
        ],
        axis=-1,
    )


def calibrate(vertices, frames, masks, config):
    """Fit training framing only. Validation transforms interpolate training framing.

    U/V scales are independent: an affine framing estimate, not physical camera calibration.
    This compensates unknown camera cropping and perspective approximately.
    """
    train = config["trainingFrames"]
    cameras = {}
    params = []
    for frame in train:
        right, up, direction = basis(frame, config)
        projected = np.stack([vertices @ right, -vertices @ up], axis=-1)
        low, high = projected.min(0), projected.max(0)
        y, x = np.where(masks[frame])
        target_low = np.array([x.min(), y.min()])
        target_high = np.array([x.max(), y.max()])
        scale = (target_high - target_low) / (high - low)
        offset = target_low - low * scale
        params.append(np.r_[scale, offset])
    cyclic_x = np.array([train[-1] - 36] + train + [train[0] + 36])
    cyclic_p = np.array([params[-1]] + params + [params[0]])
    for frame in frames:
        right, up, direction = basis(frame, config)
        values = np.array(
            [np.interp(frame, cyclic_x, cyclic_p[:, i]) for i in range(4)]
        )
        cameras[frame] = dict(
            right=right, up=up, direction=direction, scale=values[:2], offset=values[2:]
        )
    return cameras


def carve(vertices, resolution, cameras, masks, config):
    margin = np.array([0.4, 0.4, 0.25], dtype=np.float32)
    lower = vertices.min(0) - margin
    upper = vertices.max(0) + margin
    step = (upper[0] - lower[0]) / resolution
    axes = [np.arange(a, b + step * 0.5, step) for a, b in zip(lower, upper)]
    shape = tuple(len(a) for a in axes)
    grid = (
        np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)
        .reshape(-1, 3)
        .astype(np.float32)
    )
    inside = np.ones(len(grid), dtype=bool)
    # Small segmentation tolerance prevents a single JPEG contour erasing thin surfaces.
    for frame in config["trainingFrames"]:
        mask = ndimage.binary_dilation(masks[frame], iterations=2)
        camera = cameras[frame]
        height, width = mask.shape
        for start in range(0, len(grid), 200_000):
            points = (
                projection(grid[start : start + 200_000], camera).round().astype(int)
            )
            x, y = points[:, 0], points[:, 1]
            valid = (x >= 0) & (x < width) & (y >= 0) & (y < height)
            selected = np.zeros(len(points), bool)
            selected[valid] = mask[y[valid], x[valid]]
            inside[start : start + len(points)] &= selected
    volume = inside.reshape(shape)
    if volume.sum() < 100:
        raise ValueError("Camera/mask inconsistency: empty visual hull")
    boundary = int(
        volume[0].sum()
        + volume[-1].sum()
        + volume[:, 0].sum()
        + volume[:, -1].sum()
        + volume[:, :, 0].sum()
        + volume[:, :, -1].sum()
    )
    if boundary:
        raise ValueError(
            "Visual hull touches reconstruction boundary; increase grid margin"
        )
    # One-voxel boundary pad is essential for a closed surface at the grid extent.
    volume = np.pad(volume, 1)
    mesh, faces, normals, _ = marching_cubes(
        volume.astype(np.float32),
        0.5,
        spacing=(step, step, step),
        allow_degenerate=False,
    )
    mesh += lower - step
    mesh = smooth_mesh(mesh, faces)
    return (
        mesh.astype(np.float32),
        faces.astype(np.int32),
        dict(
            voxel_size_mm=float(step * 1000),
            occupied_voxels=int(inside.sum()),
            grid_shape=shape,
            boundary_voxels=boundary,
        ),
    )


def smooth_mesh(vertices, faces):
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    rows = np.r_[edges[:, 0], edges[:, 1]]
    cols = np.r_[edges[:, 1], edges[:, 0]]
    adjacency = coo_matrix(
        (np.ones(len(rows)), (rows, cols)), shape=(len(vertices), len(vertices))
    ).tocsr()
    degree = np.maximum(np.asarray(adjacency.sum(1)), 1)
    result = vertices.copy()
    for _ in range(8):
        for amount in (0.5, -0.53):
            result += amount * (adjacency @ result / degree - result)
    return result


def fuse_vertex_colors(vertices, faces, cameras, images, masks, frames):
    triangles = vertices[faces]
    face_normal = np.cross(
        triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    )
    normal = np.zeros_like(vertices)
    for corner in range(3):
        np.add.at(normal, faces[:, corner], face_normal)
    if np.median(np.sum(normal * (vertices - vertices.mean(0)), axis=1)) < 0:
        normal = -normal
    normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-10)
    total = np.zeros((len(vertices), 3))
    weights = np.zeros(len(vertices))
    fallback = np.zeros_like(total)
    best = np.full(len(vertices), -1.0)
    for frame in frames:
        camera = cameras[frame]
        pixels = np.asarray(images[frame])
        height, width = pixels.shape[:2]
        uv = projection(vertices, camera).round().astype(int)
        x = np.clip(uv[:, 0], 0, width - 1)
        y = np.clip(uv[:, 1], 0, height - 1)
        facing = np.clip(normal @ camera["direction"], 0, 1)
        depth = vertices @ camera["direction"]
        zbuffer = np.full((height, width), -np.inf)
        np.maximum.at(zbuffer, (y, x), depth)
        zbuffer = ndimage.maximum_filter(zbuffer, size=3)
        visible = (depth >= zbuffer[y, x] - 0.04) & masks[frame][y, x]
        weight = (facing**6) * visible
        total += pixels[y, x] * weight[:, None]
        weights += weight
        candidate = facing * masks[frame][y, x]
        chosen = candidate > best
        fallback[chosen] = pixels[y[chosen], x[chosen]]
        best[chosen] = candidate[chosen]
    result = np.where(
        (weights > 1e-10)[:, None],
        total / np.maximum(weights[:, None], 1e-10),
        fallback,
    )
    return np.clip(result, 0, 255).astype(np.uint8)


def photometric_check(
    vertices, faces, colors, cameras, images, masks, frames, scale=0.25
):
    """Held-out photographic reprojection check in sRGB. No silhouette-score substitution."""
    means = vertices[faces].mean(1)
    face_colors = colors[faces].mean(1).round().astype(np.uint8)
    scores = {}
    for frame in frames:
        target = images[frame]
        width, height = target.size
        size = (round(width * scale), round(height * scale))
        camera = {
            **cameras[frame],
            "scale": cameras[frame]["scale"] * scale,
            "offset": cameras[frame]["offset"] * scale,
        }
        uv = projection(vertices, camera)
        image = Image.new("RGB", size, "white")
        mask_image = Image.new("1", size)
        draw = ImageDraw.Draw(image)
        mask_draw = ImageDraw.Draw(mask_image)
        for index in np.argsort(means @ camera["direction"]):
            polygon = [tuple(p) for p in uv[faces[index]]]
            draw.polygon(polygon, fill=tuple(face_colors[index]))
            mask_draw.polygon(polygon, fill=1)
        reference_mask = np.asarray(
            Image.fromarray(masks[frame]).resize(size, Image.Resampling.NEAREST), bool
        )
        intersection = np.asarray(mask_image, bool) & reference_mask
        if intersection.sum() < 100:
            raise ValueError("Insufficient photographic overlap")
        reference = (
            np.asarray(target.resize(size, Image.Resampling.LANCZOS), dtype=float) / 255
        )
        predicted = np.asarray(image, dtype=float) / 255
        mse = float(np.mean((predicted[intersection] - reference[intersection]) ** 2))
        scores[str(frame)] = min(99.0, -10 * math.log10(max(mse, 1e-10)))
    return dict(
        mean_psnr_db=float(np.mean(list(scores.values()))),
        per_view_psnr_db=scores,
        domain="sRGB, foreground intersection, held-out cameras",
        rendering="flat triangle vertex-color averages, depth sorted",
    )


def rasterize(vertices, faces, camera, size):
    uv = projection(vertices, camera)
    image = Image.new("1", size)
    draw = ImageDraw.Draw(image)
    for triangle in faces:
        draw.polygon([tuple(p) for p in uv[triangle]], fill=1)
    return np.asarray(image, dtype=bool)


def evaluate(vertices, faces, cameras, masks, frames, scale=0.4):
    scores = {}
    predictions = {}
    for frame in frames:
        mask = masks[frame]
        height, width = mask.shape
        w, h = round(width * scale), round(height * scale)
        camera = {
            **cameras[frame],
            "scale": cameras[frame]["scale"] * scale,
            "offset": cameras[frame]["offset"] * scale,
        }
        target = np.asarray(
            Image.fromarray(mask).resize((w, h), Image.Resampling.NEAREST), bool
        )
        prediction = rasterize(vertices, faces, camera, (w, h))
        scores[str(frame)] = iou(prediction, target)
        predictions[frame] = (prediction, target)
    return dict(
        mean_iou=float(np.mean(list(scores.values()))), per_view_iou=scores
    ), predictions


def texture_assignment(vertices, faces, cameras, frames):
    tris = vertices[faces]
    normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-10)
    center = vertices.mean(0)
    if np.median(np.sum(normal * (tris.mean(1) - center), axis=1)) < 0:
        faces = faces[:, ::-1].copy()
        normal = -normal
    directions = np.array([cameras[f]["direction"] for f in frames])
    materials = np.argmax(normal @ directions.T, axis=1).astype(np.int32)
    uvs = np.empty((len(faces), 3, 2), dtype=np.float32)
    for i, frame in enumerate(frames):
        selected = materials == i
        if selected.any():
            uvs[selected] = projection(vertices[faces[selected]], cameras[frame])
    return faces, materials, uvs
