import copy
import json
import unittest
from pathlib import Path
import numpy as np
from PIL import Image
from quality import iou, choose_candidate, assess_precision
from reconstruction import foreground, calibrate, projection, photometric_check
from runtime import (
    validate_config,
    check_url,
    canonicalize,
    dimension_measure,
    ApprovedRedirect,
)

CONFIG = json.loads(
    (Path(__file__).resolve().parents[2] / "examples/vehicle3d/kicks.json").read_text()
)


class QualityTests(unittest.TestCase):
    def test_empty_masks_do_not_pass(self):
        with self.assertRaises(ValueError):
            iou(np.zeros((3, 3), bool), np.zeros((3, 3), bool))
        with self.assertRaises(ValueError):
            foreground(Image.new("RGB", (100, 60), "white"))

    def test_regressions_and_nonfinite_scores_rejected(self):
        self.assertFalse(choose_candidate(0.8, 0.91, 0.90, 0.01))
        self.assertFalse(choose_candidate(0.8, 0.8, 0.805, 0.01))
        self.assertTrue(choose_candidate(0.8, 0.85, 0.9, 0.01))
        with self.assertRaises(ValueError):
            choose_candidate(0.8, 0.85, float("nan"), 0.01)

    def test_visual_success_cannot_certify_physical_accuracy(self):
        result = assess_precision(
            0.999, {"length": 0, "width": 0, "height": 0}, CONFIG["quality"]
        )
        self.assertTrue(result["visual_gate"])
        self.assertTrue(result["dimension_gate"])
        self.assertFalse(result["physical_accuracy_certified"])
        self.assertEqual(result["precision_status"], "not-certified")
        self.assertFalse(
            assess_precision(0.999, {"length": 17}, CONFIG["quality"])["dimension_gate"]
        )

    def test_photographic_gate_detects_color_error_despite_exact_silhouette(self):
        from PIL import ImageDraw

        vertices = np.array([[5, -5, 0], [25, -5, 0], [25, -25, 0], [5, -25, 0]], float)
        faces = np.array([[0, 1, 2], [0, 2, 3]])
        camera = dict(
            right=np.array([1, 0, 0]),
            up=np.array([0, 1, 0]),
            direction=np.array([0, 0, 1]),
            scale=np.ones(2),
            offset=np.zeros(2),
        )
        image = Image.new("RGB", (32, 32), "white")
        ImageDraw.Draw(image).rectangle((5, 5, 25, 25), fill="red")
        mask = np.zeros((32, 32), bool)
        mask[5:26, 5:26] = True
        red = np.tile([255, 0, 0], (4, 1))
        blue = np.tile([0, 0, 255], (4, 1))
        perfect = photometric_check(
            vertices, faces, red, {3: camera}, {3: image}, {3: mask}, [3], scale=1
        )
        wrong = photometric_check(
            vertices, faces, blue, {3: camera}, {3: image}, {3: mask}, [3], scale=1
        )
        self.assertEqual(perfect["mean_psnr_db"], 99)
        self.assertLess(wrong["mean_psnr_db"], 5)

    def test_holdout_masks_never_calibrate_cameras(self):
        vertices = np.array([[-2, -1, 0], [2, -1, 0], [2, 1, 2], [-2, 1, 2]], float)
        frames = CONFIG["trainingFrames"] + CONFIG["validationFrames"]
        masks = {
            f: np.pad(np.ones((25, 50), bool), ((20, 15), (15, 35))) for f in frames
        }
        first = calibrate(vertices, frames, masks, CONFIG)
        for f in CONFIG["validationFrames"]:
            masks[f] = np.roll(masks[f], 17, axis=0)
        second = calibrate(vertices, frames, masks, CONFIG)
        for f in frames:
            for key in first[f]:
                np.testing.assert_array_equal(first[f][key], second[f][key])

    def test_gauge_preserves_projection_for_baseline_and_candidate(self):
        vertices = np.array(
            [[-2, -1, 0], [2, 1, 2]]
            + [
                [x, y, z]
                for x in (-0.8, 0, 0.8)
                for y in (-1.0, 1.0)
                for z in (0.95, 1.05)
            ],
            np.float32,
        )
        cameras = {
            1: dict(
                right=np.array([1.0, 0.2, 0]),
                up=np.array([0, 0.1, 1]),
                direction=np.array([0, 1, 0.0]),
                scale=np.array([100.0, 80]),
                offset=np.array([200.0, 200.0]),
            )
        }
        before = projection(vertices, cameras[1])
        after, transformed, scale, offset = canonicalize(
            vertices, cameras, CONFIG["specification"]
        )
        np.testing.assert_allclose(
            before, projection(after, transformed[1]), atol=0.00005
        )
        for k, v in dimension_measure(after).items():
            self.assertAlmostEqual(v, CONFIG["specification"][k], places=5)

    def test_shared_or_invalid_frame_sets_fail(self):
        bad = copy.deepcopy(CONFIG)
        bad["validationFrames"] = [1]
        with self.assertRaises(ValueError):
            validate_config(bad)
        bad = copy.deepcopy(CONFIG)
        bad["voxelResolutions"] = [1000]
        with self.assertRaises(ValueError):
            validate_config(bad)

    def test_untrusted_downloads_and_redirects_fail_before_fetch(self):
        for url in [
            "file:///etc/passwd",
            "http://www3.nissan.co.jp/a",
            "https://localhost/a",
            "https://www3.nissan.co.jp:8443/a",
            "https://user:pass@www3.nissan.co.jp/a",
        ]:
            with self.assertRaises(ValueError):
                check_url(url)
        with self.assertRaises(ValueError):
            ApprovedRedirect().redirect_request(
                None, None, 302, "", {}, "https://localhost/private"
            )


if __name__ == "__main__":
    unittest.main()
