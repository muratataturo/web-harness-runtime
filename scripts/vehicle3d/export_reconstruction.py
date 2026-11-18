"""Trusted Blender adapter: export actual reconstructed triangles with projected photo textures."""

import json, os
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector

OUT = Path(os.environ["VEHICLE3D_OUT"]).resolve()
payload = json.loads((OUT / "export-request.json").read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
data = np.load(OUT / "selected-mesh.npz")
vertices = data["vertices"]
faces = data["faces"]
materials = data["materials"]
uvs = data["uvs"]
mesh = bpy.data.meshes.new("MultiViewReconstructedSurface")
mesh.from_pydata(vertices.tolist(), [], faces.tolist())
mesh.update()
obj = bpy.data.objects.new("Vehicle_Multiview", mesh)
bpy.context.collection.objects.link(obj)
colors = data["colors"].astype(float) / 255
colors = np.where(colors <= 0.04045, colors / 12.92, ((colors + 0.055) / 1.055) ** 2.4)
attribute = mesh.color_attributes.new(
    name="ReferenceColor", type="FLOAT_COLOR", domain="POINT"
)
for item, color in zip(attribute.data, colors):
    item.color = (*color, 1)
material = bpy.data.materials.new("Fused photographic colors")
material.use_nodes = True
shader = material.node_tree.nodes.get("Principled BSDF")
shader.inputs["Roughness"].default_value = 0.8
shader.inputs["Specular IOR Level"].default_value = 0.05
color_node = material.node_tree.nodes.new("ShaderNodeVertexColor")
color_node.layer_name = "ReferenceColor"
material.node_tree.links.new(color_node.outputs["Color"], shader.inputs["Base Color"])
material.node_tree.links.new(
    color_node.outputs["Color"], shader.inputs["Emission Color"]
)
shader.inputs["Emission Strength"].default_value = 0.65
mesh.materials.append(material)
for polygon in mesh.polygons:
    polygon.use_smooth = True
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
bpy.ops.export_scene.gltf(filepath=str(OUT / "reconstructed.glb"), use_selection=True)
bpy.ops.wm.stl_export(
    filepath=str(OUT / "reconstructed.stl"), export_selected_objects=True
)
scene.world = bpy.data.worlds.new("White studio")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
for loc, power, size in [((2, -3, 6), 350, 5), ((-3, 3, 4), 180, 4)]:
    bpy.ops.object.light_add(type="AREA", location=loc)
    light = bpy.context.object
    light.data.energy = power
    light.data.size = size
    light.rotation_euler = (
        (Vector((0, 0, 0.8)) - light.location).to_track_quat("-Z", "Y").to_euler()
    )
bpy.ops.object.camera_add(location=(7, -8, 3.5))
camera = bpy.context.object
camera.data.type = "ORTHO"
camera.data.ortho_scale = 5.8
camera.rotation_euler = (
    (Vector((0, 0, 0.75)) - camera.location).to_track_quat("-Z", "Y").to_euler()
)
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 800
scene.render.resolution_percentage = 100
scene.render.filepath = str(OUT / "reconstructed.png")
scene["precision_status"] = "not-certified"
scene["source_method"] = (
    "multi-view silhouette visual hull with projected photo textures"
)
scene["limitations"] = (
    "Affine camera estimates; no concavity or hidden-part recovery; texture is projected photography."
)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "reconstructed.blend"))
bpy.ops.render.render(write_still=True)
# Orthographic images can also be inspected independently of the source cameras.
for name, loc in [
    ("side", (0, -9, 0.8)),
    ("front", (9, 0, 0.8)),
    ("rear", (-9, 0, 0.8)),
    ("top", (0, 0, 9)),
]:
    camera.location = loc
    target = Vector((0, 0, 0.8 if name != "top" else 0))
    camera.rotation_euler = (
        (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    scene.render.filepath = str(OUT / (name + ".png"))
    bpy.ops.render.render(write_still=True)
