"""Protect camera prediction geometry and prevent training-only quality acceptance."""

import unittest

import numpy as np
from perspective_model import interpolate_cameras
from refine_photometric import passes
from scipy.spatial.transform import Rotation


class PhotometricTests(unittest.TestCase):
    def test_camera_predictions_preserve_training_and_extrinsic_consistency(self):
        training = {}
        for frame, angle in [(1, 0), (4, 0.3), (19, 1.8), (34, 3.3)]:
            R = Rotation.from_rotvec([0, angle, 0]).as_matrix()
            t = np.array([frame / 100, 0.1, 3.0])
            training[frame] = dict(
                R=R.tolist(),
                t=t.tolist(),
                K=np.eye(3).tolist(),
                center=(-R.T @ t).tolist(),
            )
        predicted = interpolate_cameras(training)
        self.assertEqual(len(predicted), 36)
        for frame, original in training.items():
            self.assertIs(predicted[frame], original)
        for camera in predicted.values():
            R, t, C = (np.array(camera[key]) for key in ["R", "t", "center"])
            np.testing.assert_allclose(R @ C + t, 0, atol=1e-12)
            np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-12)
        np.testing.assert_allclose(predicted[2]["t"], [0.02, 0.1, 3.0])

    def test_thresholds_require_both_metrics(self):
        self.assertTrue(passes(dict(psnr_db=20.0, ssim=0.85)))
        self.assertFalse(passes(dict(psnr_db=23.8, ssim=0.849)))
        self.assertFalse(passes(dict(psnr_db=19.99, ssim=0.91)))
        self.assertFalse(passes(dict(psnr_db=17.872, ssim=0.714)))
        self.assertTrue(passes(dict(psnr_db=None, ssim=1.0)))


if __name__ == "__main__":
    unittest.main()
