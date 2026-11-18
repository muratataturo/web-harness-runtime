"""Recover perspective cameras from training photos; test images are not registered."""

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import pycolmap
from PIL import Image
from reconstruction import foreground


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    images = out / "train"
    masks = out / "masks"
    images.mkdir(exist_ok=True)
    masks.mkdir(exist_ok=True)
    test = list(range(3, 37, 3))
    train = [i for i in range(1, 37) if i not in test]
    for frame in train:
        file = f"spin-{frame:02}.jpg"
        source = args.cache_dir / "references" / file
        shutil.copyfile(source, images / file)
        mask = foreground(Image.open(source)).astype(np.uint8) * 255
        Image.fromarray(mask).save(masks / (file + ".png"))
    db = out / "features.db"
    (out / "sparse").mkdir(exist_ok=True)
    (out / "best").mkdir(exist_ok=True)
    if not db.exists():
        extraction = pycolmap.FeatureExtractionOptions()
        extraction.num_threads = 8
        extraction.sift.max_num_features = 5000
        reader = pycolmap.ImageReaderOptions()
        reader.camera_model = "SIMPLE_PINHOLE"
        reader.camera_params = "1392,580,326"
        reader.mask_path = masks
        pycolmap.extract_features(
            db,
            images,
            camera_mode=pycolmap.CameraMode.SINGLE,
            reader_options=reader,
            extraction_options=extraction,
            device=pycolmap.Device.cpu,
        )
        matching = pycolmap.FeatureMatchingOptions()
        matching.num_threads = 8
        matching.guided_matching = True
        pairs = out / "pairs.txt"
        pairs.write_text(
            "\n".join(
                f"spin-{a:02}.jpg spin-{b:02}.jpg"
                for a in train
                for b in train
                if a < b and min((b - a) % 36, (a - b) % 36) <= 4
            )
            + "\n"
        )
        pairing = pycolmap.ImportedPairingOptions()
        pairing.match_list_path = pairs
        pycolmap.match_image_pairs(
            db,
            matching_options=matching,
            pairing_options=pairing,
            device=pycolmap.Device.cpu,
        )
    mapping = pycolmap.IncrementalPipelineOptions()
    mapping.num_threads = 8
    mapping.max_runtime_seconds = 240
    mapping.min_model_size = 6
    mapping.max_num_models = 3
    mapping.random_seed = 42
    mapping.mapper.init_min_num_inliers = 60
    mapping.mapper.init_min_tri_angle = 10
    mapping.ba_global_max_num_iterations = 60
    mapping.ba_local_max_num_iterations = 30
    import sqlite3

    with sqlite3.connect(db) as connection:
        ids = dict(connection.execute("SELECT name,image_id FROM images").fetchall())
    mapping.init_image_id1 = ids["spin-01.jpg"]
    mapping.init_image_id2 = ids["spin-04.jpg"]
    saved = [p for p in (out / "sparse").iterdir() if (p / "cameras.bin").is_file()]
    reconstructions = (
        {i: pycolmap.Reconstruction(p) for i, p in enumerate(saved)}
        if saved
        else pycolmap.incremental_mapping(db, images, out / "sparse", options=mapping)
    )
    if not reconstructions:
        raise ValueError("No perspective reconstruction was recovered")
    best = max(reconstructions.values(), key=lambda r: r.num_reg_images())
    best.write(out / "best")
    cameras = {}
    for image_id, image in best.images.items():
        if not image.has_pose:
            continue
        pose = image.cam_from_world()
        camera = best.cameras[image.camera_id]
        cameras[image.name] = dict(
            R=pose.rotation.matrix().tolist(),
            t=pose.translation.tolist(),
            center=image.projection_center().tolist(),
            K=camera.calibration_matrix().tolist(),
            width=camera.width,
            height=camera.height,
        )
    reliable = [
        p for p in best.points3D.values() if p.track.length() >= 4 and p.error < 1.5
    ]
    points = np.array([p.xyz for p in reliable])
    colors = np.array([p.color for p in reliable])
    np.savez_compressed(out / "sparse-points.npz", vertices=points, colors=colors)
    (out / "perspective-cameras.json").write_text(json.dumps(cameras, indent=2))
    report = dict(
        method="COLMAP feature matching + perspective bundle adjustment",
        registered=len(cameras),
        requested_training_frames=train,
        held_out_test_frames=test,
        points=len(points),
        mean_reprojection_error=best.compute_mean_reprojection_error(),
        cameras={
            int(k): dict(model=str(v.model), params=v.params.tolist())
            for k, v in best.cameras.items()
        },
    )
    (out / "sfm-result.json").write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str), flush=True)


if __name__ == "__main__":
    main()
