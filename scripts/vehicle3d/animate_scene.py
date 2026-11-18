"""Apply the Python trajectory to the generated mesh assembly; no rigid body solver."""

from pathlib import Path
import os
import json
import bpy
from mathutils import Vector

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(OUT / "vehicle.blend"))
root = bpy.data.objects["Vehicle_Root"]
rows = json.loads((OUT / "trajectory.json").read_text())
scene = bpy.context.scene
scene.render.fps = 20
scene.frame_start = 1
scene.frame_end = 241
names = {o.name: o for o in bpy.data.objects}
for r in rows[::2]:
    frame = 1 + round(r["t"] * 20)
    root.location = (r["x"], r["y"], 0)
    root.rotation_euler = (0, 0, r["yaw"])
    root.keyframe_insert(data_path="location", frame=frame)
    root.keyframe_insert(data_path="rotation_euler", frame=frame)
    # Spin around the model's axle Y; tire rolling is an illustrative no-slip rotation.
    for name in ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"]:
        obj = names.get(name)
        if obj:
            obj.rotation_euler.y = r["distance"] / 0.345
            obj.keyframe_insert(data_path="rotation_euler", frame=frame)
    # Front steering axes are discovered by parent relationship, not fuzzy name matching.
    for suffix, key in [("FL", "steer_left"), ("FR", "steer_right")]:
        w = names.get("Wheel_" + suffix)
        if w and w.parent and w.parent != root:
            w.parent.rotation_euler.z = r[key]
            w.parent.keyframe_insert(data_path="rotation_euler", frame=frame)
scene.frame_set(1)
# A separate broad overview camera covers the driving path; original studio camera remains.
bpy.ops.object.camera_add(location=(17, 4, 43))
camera = bpy.context.object
camera.name = "Driving_Overview"
target = Vector((17, 4, 0))
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 46
scene.camera = camera
scene.render.resolution_x = 1400
scene.render.resolution_y = 700
curve = bpy.data.curves.new("Calculated trajectory", "CURVE")
curve.dimensions = "3D"
curve.bevel_depth = 0.035
spline = curve.splines.new("POLY")
spline.points.add(len(rows) - 1)
for p, r in zip(spline.points, rows):
    p.co = (r["x"], r["y"], 0.012, 1)
path = bpy.data.objects.new("Python trajectory", curve)
scene.collection.objects.link(path)
mat = bpy.data.materials.new("Trajectory cyan")
mat.diffuse_color = (0.05, 0.8, 0.95, 1)
mat.use_nodes = True
bs = mat.node_tree.nodes.get("Principled BSDF")
bs.inputs["Base Color"].default_value = (0.05, 0.8, 0.95, 1)
bs.inputs["Emission Color"].default_value = (0.05, 0.8, 0.95, 1)
bs.inputs["Emission Strength"].default_value = 0.7
curve.materials.append(mat)
bpy.ops.object.light_add(type="SUN", rotation=(0.35, -0.5, -0.4))
bpy.context.object.data.energy = 2
scene["simulation_note"] = (
    "Kinematic bicycle demonstration, assumed dimensions, no tire forces/suspension/collision."
)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "driving.blend"))
assert root.animation_data is not None
print("Saved driving.blend: 241 frames / 20 fps, root animation and wheel animation.")
