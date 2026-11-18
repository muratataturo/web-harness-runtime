"""Render a fixed 3D surface with view-dependent projective photographic textures.

This is captured radiance, not recovered physical albedo. Texture selection depends
only on 3D viewing direction and training photographs, never on target RGB pixels.
"""

import hashlib
import json
import os
from pathlib import Path

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix

OUT = Path(os.environ["VEHICLE3D_OUT"]).resolve()
request = json.loads((OUT / "projective-request.json").read_text())
data = np.load(request["mesh"])
cameras = json.loads(Path(request["cameras"]).read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
mesh = bpy.data.meshes.new("Perspective reconstructed surface")
mesh.from_pydata(data["vertices"].tolist(), [], data["faces"].tolist())
mesh.update()
obj = bpy.data.objects.new("Vehicle_Projective", mesh)
scene.collection.objects.link(obj)
for p in mesh.polygons:
    p.use_smooth = True
material = bpy.data.materials.new("Training-view projective radiance")
material.use_nodes = True
nodes = material.node_tree.nodes
links = material.node_tree.links
nodes.clear()
geometry = nodes.new("ShaderNodeNewGeometry")


def math_node(operation, a, b=None):
    node = nodes.new("ShaderNodeMath")
    node.operation = operation
    for socket, value in zip(node.inputs, (a, b)):
        if value is None:
            continue
        if hasattr(value, "node"):
            links.new(value, socket)
        else:
            socket.default_value = value
    return node.outputs[0]


def vector_node(operation, a, b):
    node = nodes.new("ShaderNodeVectorMath")
    node.operation = operation
    for socket, value in zip(node.inputs, (a, b)):
        if hasattr(value, "node"):
            links.new(value, socket)
        else:
            socket.default_value = value
    return (
        node.outputs["Value"] if operation == "DOT_PRODUCT" else node.outputs["Vector"]
    )


weight_sum = None
color_sum = None
direction_sum = None
for frame in request["source_frames"]:
    c = cameras[str(frame)]
    R = np.array(c["R"])
    t = np.array(c["t"])
    K = np.array(c["K"])
    name = "input.png" if frame == "input" else f"spin-{frame:02}.png"
    image = bpy.data.images.load(str(Path(request["texture_dir"]) / name))
    image.pack()
    x = math_node(
        "ADD",
        vector_node("DOT_PRODUCT", geometry.outputs["Position"], R[0]),
        float(t[0]),
    )
    y = math_node(
        "ADD",
        vector_node("DOT_PRODUCT", geometry.outputs["Position"], R[1]),
        float(t[1]),
    )
    z = math_node(
        "ADD",
        vector_node("DOT_PRODUCT", geometry.outputs["Position"], R[2]),
        float(t[2]),
    )
    u = math_node(
        "ADD",
        math_node(
            "MULTIPLY", math_node("DIVIDE", x, z), float(K[0, 0] / image.size[0])
        ),
        float(K[0, 2] / image.size[0]),
    )
    v = math_node(
        "SUBTRACT",
        1.0,
        math_node(
            "ADD",
            math_node(
                "MULTIPLY", math_node("DIVIDE", y, z), float(K[1, 1] / image.size[1])
            ),
            float(K[1, 2] / image.size[1]),
        ),
    )
    combine = nodes.new("ShaderNodeCombineXYZ")
    links.new(u, combine.inputs["X"])
    links.new(v, combine.inputs["Y"])
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.extension = "CLIP"
    texture.interpolation = "Linear"
    links.new(combine.outputs[0], texture.inputs["Vector"])
    direction = vector_node("SUBTRACT", c["center"], geometry.outputs["Position"])
    normalization = nodes.new("ShaderNodeVectorMath")
    normalization.operation = "NORMALIZE"
    links.new(direction, normalization.inputs[0])
    cosine = vector_node(
        "DOT_PRODUCT", geometry.outputs["Incoming"], normalization.outputs[0]
    )
    positive = math_node("MAXIMUM", cosine, 0.0)
    direction_weight = math_node(
        "MULTIPLY",
        math_node("POWER", positive, float(request.get("weight_power", 256))),
        float(request.get("input_confidence", 4) if frame == "input" else 1),
    )
    direction_sum = (
        direction_weight
        if direction_sum is None
        else math_node("ADD", direction_sum, direction_weight)
    )
    weight = math_node("MULTIPLY", direction_weight, texture.outputs["Alpha"])
    weight_sum = weight if weight_sum is None else math_node("ADD", weight_sum, weight)
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    links.new(texture.outputs["Color"], scale.inputs[0])
    links.new(weight, scale.inputs[3])
    color_sum = (
        scale.outputs[0]
        if color_sum is None
        else vector_node("ADD", color_sum, scale.outputs[0])
    )
denominator = math_node("MAXIMUM", weight_sum, 1e-12)
color = vector_node("DIVIDE", color_sum, denominator)
emission = nodes.new("ShaderNodeEmission")
links.new(color, emission.inputs["Color"])
opacity = math_node("DIVIDE", weight_sum, math_node("MAXIMUM", direction_sum, 1e-12))
transparent = nodes.new("ShaderNodeBsdfTransparent")
mix = nodes.new("ShaderNodeMixShader")
links.new(opacity, mix.inputs[0])
links.new(transparent.outputs[0], mix.inputs[1])
links.new(emission.outputs[0], mix.inputs[2])
output = nodes.new("ShaderNodeOutputMaterial")
links.new(mix.outputs[0], output.inputs["Surface"])
mesh.materials.append(material)
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.cycles.max_bounces = 0
scene.cycles.transparent_max_bounces = 8
scene.cycles.use_denoising = False
scene.render.film_transparent = True
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.resolution_percentage = 100
bpy.ops.object.camera_add()
camera = bpy.context.object
scene.camera = camera
camera.data.type = "PERSP"
camera.data.sensor_fit = "HORIZONTAL"
camera.data.sensor_width = 36
camera.data.clip_start = 0.001
camera.data.clip_end = 1000
checks = []
for frame in request["render_frames"]:
    c = cameras[str(frame)]
    K = np.array(c["K"])
    R = np.array(c["R"])
    t = np.array(c["t"])
    width, height = c.get("image_size", [1160, 652])
    transform = np.eye(4)
    transform[:3, :3] = R
    transform[:3, 3] = t
    camera.matrix_world = Matrix(
        (np.linalg.inv(transform) @ np.diag([1, -1, -1, 1])).tolist()
    )
    camera.data.lens = float(K[0, 0]) * 36 / width
    camera.data.shift_x = (width / 2 - K[0, 2]) / width
    camera.data.shift_y = (K[1, 2] - height / 2) / width
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    bpy.context.view_layer.update()
    max_error = 0.0
    for vertex in list(mesh.vertices)[:: max(1, len(mesh.vertices) // 20)]:
        p = np.array(vertex.co)
        q = R @ p + t
        expected = K[:2, :2] @ (q[:2] / q[2]) + K[:2, 2]
        projected = world_to_camera_view(scene, camera, vertex.co)
        actual = np.array([projected.x * width, (1 - projected.y) * height])
        max_error = max(max_error, float(np.linalg.norm(actual - expected)))
    if max_error > 0.02:
        raise ValueError(f"Perspective camera projection mismatch: {max_error}")
    label = frame if frame == "input" else f"{frame:02}"
    file = OUT / f"frame-{label}.png"
    scene.render.filepath = str(file)
    bpy.ops.render.render(write_still=True)
    checks.append(
        dict(
            frame=frame,
            max_projection_error_px=max_error,
            sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
        )
    )
scene["method"] = (
    "training-only perspective reconstruction with view-dependent photographic radiance"
)
scene["physical_albedo_recovered"] = False
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "projective.blend"))
(OUT / "projective-render-checks.json").write_text(
    json.dumps(
        dict(
            checks=checks,
            source_frames=request["source_frames"],
            source_image_count=len(request["source_frames"]),
            renderer=bpy.app.version_string,
        ),
        indent=2,
    )
)
