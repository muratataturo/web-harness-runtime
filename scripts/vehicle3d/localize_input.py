"""Localize the supplied photo against training-only SfM points; no test photos used."""

import argparse
import json
import sqlite3
from pathlib import Path

import cv2
import numpy as np
import pycolmap
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sfm", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frame", type=int)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    image_dir = out / "photo"
    image_dir.mkdir(exist_ok=True)
    source = (
        args.cache_dir / "reference.jpg"
        if args.frame is None
        else args.cache_dir / "references" / f"spin-{args.frame:02}.jpg"
    )
    image = Image.open(source).convert("RGB")
    factor = 1160 / image.width
    image.resize((1160, round(image.height * factor)), Image.Resampling.LANCZOS).save(
        image_dir / "input.jpg", quality=100
    )
    known = json.loads((args.model / "perspective-cameras.json").read_text())
    initial_focal = (
        900 * factor
        if args.frame is None
        else next(iter(known.values()))["K"][0][0] * factor
    )
    db = out / "input.db"
    if not db.is_file():
        reader = pycolmap.ImageReaderOptions()
        reader.camera_model = "SIMPLE_PINHOLE"
        reader.camera_params = f"{initial_focal},580,{image.height * factor / 2}"
        extraction = pycolmap.FeatureExtractionOptions()
        extraction.num_threads = 4
        extraction.sift.max_num_features = 4000
        pycolmap.extract_features(
            db,
            image_dir,
            reader_options=reader,
            extraction_options=extraction,
            device=pycolmap.Device.cpu,
        )
    with sqlite3.connect(db) as connection:
        rows, cols, blob = connection.execute(
            "SELECT rows,cols,data FROM descriptors"
        ).fetchone()
        query = np.frombuffer(blob, np.uint8).reshape(rows, cols)
        rows, cols, blob = connection.execute(
            "SELECT rows,cols,data FROM keypoints"
        ).fetchone()
        keypoints = np.frombuffer(blob, np.float32).reshape(rows, cols)[:, :2]
    reconstruction = pycolmap.Reconstruction(args.sfm / "best")
    descriptors = []
    point_ids = []
    with sqlite3.connect(args.sfm / "features.db") as connection:
        for image_id, registered in reconstruction.images.items():
            row, col, blob = connection.execute(
                "SELECT rows,cols,data FROM descriptors WHERE image_id=?", (image_id,)
            ).fetchone()
            d = np.frombuffer(blob, np.uint8).reshape(row, col)
            for index, p in enumerate(registered.points2D):
                if (
                    p.has_point3D()
                    and reconstruction.points3D[p.point3D_id].track.length() >= 3
                ):
                    descriptors.append(d[index])
                    point_ids.append(int(p.point3D_id))
    descriptors = np.array(descriptors, np.uint8)
    nearest = cv2.BFMatcher(cv2.NORM_L2).knnMatch(
        query, descriptors, k=min(15, len(descriptors))
    )
    chosen = {}
    for q, neighbors in enumerate(nearest):
        best = neighbors[0]
        pid = point_ids[best.trainIdx]
        second = next(
            (match for match in neighbors[1:] if point_ids[match.trainIdx] != pid), None
        )
        if second is not None and best.distance < 0.85 * second.distance:
            if pid not in chosen or best.distance < chosen[pid][0]:
                chosen[pid] = (best.distance, q)
    points3D = np.array([reconstruction.points3D[p].xyz for p in chosen])
    points2D = np.array([keypoints[q] for _, q in chosen.values()])
    camera = pycolmap.Camera(
        model="SIMPLE_PINHOLE",
        width=1160,
        height=round(image.height * factor),
        params=[initial_focal, 580, image.height * factor / 2],
    )
    estimation = pycolmap.AbsolutePoseEstimationOptions()
    estimation.estimate_focal_length = args.frame is None
    estimation.ransac.max_error = 8 if args.frame is None else 3
    estimation.ransac.min_num_trials = 1000
    estimation.ransac.max_num_trials = 30000
    refinement = pycolmap.AbsolutePoseRefinementOptions()
    refinement.refine_focal_length = args.frame is None
    pose = pycolmap.estimate_and_refine_absolute_pose(
        points2D,
        points3D,
        camera,
        estimation_options=estimation,
        refinement_options=refinement,
    )
    if pose is None or pose["num_inliers"] < 8:
        raise ValueError(
            f"Insufficient input-photo localization: matches={len(chosen)}, pose={pose}"
        )
    transform = json.loads((args.model / "perspective-result.json").read_text())[
        "world_to_canonical"
    ]
    B = np.array(transform["basis"])
    origin = np.array(transform["center"])
    R = pose["cam_from_world"].rotation.matrix()
    t = pose["cam_from_world"].translation
    Rt = R @ B
    tt = R @ origin + t
    K = camera.calibration_matrix()
    K[:2] /= factor
    cameras = json.loads((args.model / "perspective-cameras.json").read_text())
    cameras["input" if args.frame is None else str(args.frame)] = dict(
        R=Rt.tolist(),
        t=tt.tolist(),
        K=K.tolist(),
        center=(-Rt.T @ tt).tolist(),
        image_size=list(image.size),
        role="supervised input view"
        if args.frame is None
        else "held-out appearance; target image used only for camera pose localization",
    )
    (out / "cameras-with-input.json").write_text(json.dumps(cameras, indent=2))
    report = dict(
        matches=len(chosen),
        inliers=int(pose["num_inliers"]),
        input_keypoints=len(query),
        camera_K=K.tolist(),
        input_is_training_supervision=args.frame is None,
        test_frame_camera_localized=args.frame,
        used_for_appearance_training=False if args.frame is not None else True,
    )
    (out / "input-localization.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
