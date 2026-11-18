import copy
import unittest
import numpy as np
from skimage.metrics import peak_signal_noise_ratio, structural_similarity
from image_metrics import compare_images, region_metrics, aggregate
from quality import apply_image_audit


class ImageMetricTests(unittest.TestCase):
    def setUp(self):
        self.reference = np.full((100, 140, 3), 255, np.uint8)
        self.mask = np.zeros((100, 140), bool)
        self.mask[30:70, 40:100] = True
        self.reference[self.mask] = [30, 110, 180]

    def test_identical_pixels_are_explicit_perfect_match(self):
        m = compare_images(self.reference, self.reference, self.mask)["reference_roi"]
        self.assertIsNone(m["psnr_db"])
        self.assertTrue(m["perfect_match"])
        self.assertEqual(m["ssim"], 1.0)

    def test_white_background_can_inflate_full_frame_metrics(self):
        blank = np.full_like(self.reference, 255)
        m = compare_images(self.reference, blank, self.mask)
        self.assertGreater(
            m["full_frame"]["psnr_db"], m["reference_roi"]["psnr_db"] + 3
        )
        self.assertGreater(m["full_frame"]["ssim"], m["reference_roi"]["ssim"] + 0.15)

    def test_missing_car_pixels_are_not_removed_by_intersection(self):
        missing = self.reference.copy()
        missing[30:70, 40:70] = 255
        m = compare_images(self.reference, missing, self.mask)
        self.assertGreater(m["reference_roi"]["mse"], 0)
        self.assertLess(m["reference_roi"]["ssim"], 0.9)
        self.assertEqual(
            m["reference_roi_xyxy"],
            compare_images(
                self.reference, np.full_like(self.reference, 255), self.mask
            )["reference_roi_xyxy"],
        )

    def test_psnr_and_ssim_match_library_with_explicit_range(self):
        rendered = self.reference.copy()
        rendered[self.mask] = [80, 120, 150]
        all_pixels = np.ones(self.mask.shape, bool)
        m = region_metrics(self.reference, rendered, all_pixels)
        a = self.reference / 255.0
        b = rendered / 255.0
        self.assertAlmostEqual(
            m["psnr_db"], peak_signal_noise_ratio(a, b, data_range=1.0), places=12
        )
        self.assertAlmostEqual(
            m["ssim"],
            structural_similarity(
                a,
                b,
                data_range=1.0,
                channel_axis=-1,
                gaussian_weights=True,
                sigma=1.5,
                use_sample_covariance=False,
            ),
            places=12,
        )

    def test_pooled_psnr_uses_mse_not_average_db(self):
        row = compare_images(
            self.reference, np.full_like(self.reference, 255), self.mask
        )
        other = copy.deepcopy(row)
        for key in ("reference_roi", "full_frame", "reference_foreground"):
            other[key]["mse"] *= 0.1
            other[key]["psnr_db"] += 10
        row["foreground_union"] = row["reference_foreground"]
        other["foreground_union"] = other["reference_foreground"]
        m = aggregate([row, other])["reference_roi"]
        self.assertAlmostEqual(
            m["pooled_psnr_db"], -10 * np.log10(row["reference_roi"]["mse"] * 0.55)
        )

    def test_silhouette_success_does_not_accept_bad_rgb_match(self):
        result = {"assessment": {"visual_gate": True, "dimension_gate": True}}
        metric = {"pooled_psnr_db": 14.0, "mean_ssim": 0.3}
        audit = {
            "variants": {
                "delivered": {
                    "aggregate": {"reference_roi": metric},
                    "input_target_fit": {
                        "reference_roi": {"psnr_db": 12.0, "ssim": 0.3}
                    },
                }
            }
        }
        apply_image_audit(result, audit, {})
        self.assertFalse(result["deliverable_accepted"])
        self.assertEqual(result["status"], "image-match-failed")

    def test_shapes_and_empty_foreground_fail_without_automatic_alignment(self):
        with self.assertRaises(ValueError):
            compare_images(self.reference, self.reference[:90], self.mask)
        with self.assertRaises(ValueError):
            compare_images(self.reference, self.reference, np.zeros_like(self.mask))
        with self.assertRaises(ValueError):
            compare_images(self.reference / 255.0, self.reference / 255.0, self.mask)

    def test_original_input_mismatch_blocks_otherwise_good_test_views(self):
        result = {"assessment": {"visual_gate": True, "dimension_gate": True}}
        metric = {"pooled_psnr_db": 30.0, "mean_ssim": 0.95}
        audit = {
            "variants": {
                "delivered": {
                    "aggregate": {"reference_roi": metric},
                    "input_target_fit": {
                        "reference_roi": {"psnr_db": 12.0, "ssim": 0.3}
                    },
                }
            }
        }
        apply_image_audit(result, audit, {})
        self.assertFalse(result["deliverable_accepted"])
        self.assertFalse(result["assessment"]["original_image_gate"])


if __name__ == "__main__":
    unittest.main()
