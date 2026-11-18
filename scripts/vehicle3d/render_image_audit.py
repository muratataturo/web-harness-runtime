"""Blender renderer adapter: reproduce saved affine projections, with pixel oracle checks.

The estimated cameras are not physically calibrated. Realize the exact affine mapping
as an object-space matrix and an orthographic camera; do not register resulting images.
"""

import hashlib
import json
import os
from pathlib import Path
import bpy
import bmesh
import numpy as np
from mathutils import Matrix
from bpy_extras.object_utils import world_to_camera_view

OUT = Path(os.environ["VEHICLE3D_OUT"]).resolve()
request = json.loads((OUT / "render-request.json").read_text())
checks = []
for variant in request["variants"]:
    if (
        hashlib.sha256(Path(variant["blend"]).read_bytes()).hexdigest()
        != variant["sha256"]
    ):
        raise ValueError("Source model changed before rendering")
    bpy.ops.wm.open_mainfile(filepath=variant["blend"])
    scene = bpy.context.scene
    root = (
        bpy.data.objects.get("Vehicle_Root")
        if variant["name"] == "baseline"
        else bpy.data.objects["Vehicle_Multiview"]
    )
    vehicle = [root] + list(root.children_recursive)
    for obj in scene.objects:
        if obj.type == "MESH" and obj not in vehicle:
            obj.hide_render = True
    for obj in vehicle:
        obj.hide_render = False
    bpy.ops.object.select_all(action="DESELECT")
    meshes = [obj for obj in vehicle if obj.type == "MESH"]
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.join()
    root = bpy.context.object
    original = np.array([list(root.matrix_world @ v.co) for v in root.data.vertices])
    gauge = (
        np.array(request["baseline_gauge"])
        if variant["name"] == "baseline"
        else np.eye(4)
    )
    canonical = original @ gauge[:3, :3].T + gauge[:3, 3]
    root.parent = None
    root.matrix_world = Matrix.Identity(4)
    if root.data.has_custom_normals:
        root.data.normals_split_custom_set([(0.0, 0.0, 0.0)] * len(root.data.loops))
    flipped = False
    if variant["name"] == "unlit":
        material = bpy.data.materials.new("Diagnostic captured colors, no relighting")
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        color = nodes.new("ShaderNodeVertexColor")
        color.layer_name = "ReferenceColor"
        emission = nodes.new("ShaderNodeEmission")
        output = nodes.new("ShaderNodeOutputMaterial")
        material.node_tree.links.new(color.outputs["Color"], emission.inputs["Color"])
        material.node_tree.links.new(emission.outputs[0], output.inputs["Surface"])
        root.data.materials.clear()
        root.data.materials.append(material)
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0
        scene.view_settings.gamma = 1
    bpy.ops.object.camera_add(location=(0, 0, 10))
    camera = bpy.context.object
    camera.rotation_euler = (0, 0, 0)
    camera.data.type = "ORTHO"
    camera.data.shift_x = camera.data.shift_y = 0
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    folder = OUT / variant["name"]
    folder.mkdir(exist_ok=True)
    for frame in request["frames"]:
        c = request["cameras"][str(frame)]
        width, height = c.get("image_size", request["image_size"])
        k = 200.0
        matrix = np.eye(4)
        matrix[0, :3] = np.array(c["right"]) * c["scale"][0] / k
        matrix[1, :3] = np.array(c["up"]) * c["scale"][1] / k
        matrix[2, :3] = np.array(c["direction"])
        # Bake into actual mesh coordinates. Object.matrix_world would decompose
        # shear into location/rotation/scale and silently change this projection.
        transformed = canonical @ matrix[:3, :3].T
        root.data.vertices.foreach_set("co", transformed.astype(np.float32).ravel())
        needs_flip = np.linalg.det(matrix[:3, :3]) < 0
        if needs_flip != flipped:
            bm = bmesh.new()
            bm.from_mesh(root.data)
            bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
            bm.to_mesh(root.data)
            bm.free()
            flipped = needs_flip
        root.data.update()
        camera.location = (
            (width / 2 - c["offset"][0]) / k,
            (c["offset"][1] - height / 2) / k,
            10,
        )
        camera.data.ortho_scale = width / k
        scene.render.resolution_x = width
        scene.render.resolution_y = height
        bpy.context.view_layer.update()
        # Verify Blender's projection, not a screenshot alignment optimized against the answer.
        max_error = 0.0
        indices = np.linspace(0, len(canonical) - 1, min(30, len(canonical)), dtype=int)
        for index in indices:
            point = canonical[index]
            world = root.matrix_world @ root.data.vertices[index].co
            ndc = world_to_camera_view(scene, camera, world)
            got = np.array([ndc.x * width, (1 - ndc.y) * height])
            expected = np.array(
                [
                    np.dot(c["right"], point) * c["scale"][0] + c["offset"][0],
                    -np.dot(c["up"], point) * c["scale"][1] + c["offset"][1],
                ]
            )
            max_error = max(max_error, float(np.linalg.norm(got - expected)))
        if max_error > 0.01:
            raise ValueError(f"Projection mismatch: {max_error} px")
        label = f"{frame:02}" if isinstance(frame, int) else str(frame)
        file = folder / f"frame-{label}.png"
        scene.render.filepath = str(file)
        bpy.ops.render.render(write_still=True)
        checks.append(
            dict(
                variant=variant["name"],
                frame=frame,
                max_projection_error_px=max_error,
                view_transform=scene.view_settings.view_transform,
                bytes=file.stat().st_size,
                sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
            )
        )
(OUT / "render-checks.json").write_text(
    json.dumps(
        dict(
            renderer=bpy.app.version_string,
            engine="Cycles CPU, 16 samples",
            source_models=[
                dict(name=v["name"], sha256=v["sha256"]) for v in request["variants"]
            ],
            checks=checks,
        ),
        indent=2,
    )
)
