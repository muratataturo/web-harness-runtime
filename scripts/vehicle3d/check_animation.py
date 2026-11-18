from pathlib import Path
import os
import json, math
import bpy

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(OUT / "driving.blend"))
scene = bpy.context.scene
root = bpy.data.objects["Vehicle_Root"]
poses = []
for frame in (1, 61, 121, 241):
    scene.frame_set(frame)
    poses.append(
        dict(
            frame=frame,
            position=list(root.location),
            yaw=root.rotation_euler.z,
            left_steer=bpy.data.objects["Steering_FL"].rotation_euler.z,
            right_steer=bpy.data.objects["Steering_FR"].rotation_euler.z,
            wheel_spin=bpy.data.objects["Wheel_FL"].rotation_euler.y,
        )
    )
assert poses[-1]["position"][0] - poses[0]["position"][0] > 30
assert abs(poses[1]["left_steer"]) > math.radians(4)
assert poses[1]["left_steer"] > poses[1]["right_steer"]
assert abs(poses[-1]["wheel_spin"]) > 100
assert sum(o.type == "MESH" for o in root.children_recursive) == 93
report = dict(
    status="passed",
    blender_version=bpy.app.version_string,
    frames=scene.frame_end,
    fps=scene.render.fps,
    sampled_poses=poses,
    vehicle_mesh_count=93,
)
(OUT / "animation-checks.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
