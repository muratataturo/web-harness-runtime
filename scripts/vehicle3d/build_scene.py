import bpy
import json
import math
import numpy as np
from pathlib import Path
import os
from mathutils import Vector

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0
vehicle = bpy.data.collections.new("Vehicle")
studio = bpy.data.collections.new("Studio")
for collection in (vehicle, studio):
    scene.collection.children.link(collection)


def empty(name, parent=None, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    vehicle.objects.link(obj)
    obj.parent = parent
    obj.location = location
    obj.empty_display_size = 0.12
    return obj


root = empty("Vehicle_Root")


def material(name, color, metallic=0, rough=0.35, coat=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bs = mat.node_tree.nodes.get("Principled BSDF")
    for key, value in {
        "Base Color": (*color, 1),
        "Metallic": metallic,
        "Roughness": rough,
        "Coat Weight": coat,
        "Coat Roughness": 0.16,
        "Emission Color": (*color, 1),
        "Emission Strength": emission,
    }.items():
        bs.inputs[key].default_value = value
    return mat


paint = material("Glacier cyan pearl", (0.085, 0.52, 0.70), 0.62, 0.245, 0.5)
roof = material("Obsidian lacquer", (0.009, 0.014, 0.018), 0, 0.38, 0.05)
glass = material("Smoked solar glass", (0.012, 0.025, 0.033), 0, 0.30, 0.05)
for dark_material in (roof, glass):
    dark_material.node_tree.nodes.get("Principled BSDF").inputs[
        "Specular IOR Level"
    ].default_value = 0.10
trim = material("Graphite molded cladding", (0.025, 0.031, 0.035), 0.09, 0.42)
black = material("Intake shadow", (0.006, 0.009, 0.011), 0.1, 0.48)
rubber = material("Tire rubber", (0.014, 0.016, 0.017), 0, 0.56)
alloy = material("Diamond cut aluminum", (0.64, 0.70, 0.73), 0.88, 0.23)
gun = material("Satin gunmetal", (0.095, 0.11, 0.12), 0.78, 0.32)
white = material("Ice LED", (0.82, 0.95, 1), 0.16, 0.19, 0.3, 3)
red = material("Ruby light guide", (0.68, 0.012, 0.018), 0.26, 0.22, 0.5, 1.3)


def finish(obj, name, mat, parent=root, bevel=0):
    obj.name = name
    if vehicle not in obj.users_collection:
        for col in list(obj.users_collection):
            col.objects.unlink(obj)
        vehicle.objects.link(obj)
    obj.parent = parent
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Soft tooling edges", "BEVEL")
        mod.width, mod.segments = bevel, 3
    mod = obj.modifiers.new("Surface normals", "WEIGHTED_NORMAL")
    mod.keep_sharp = True
    return obj


def mesh(name, verts, faces, mat, parent=root, bevel=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    vehicle.objects.link(obj)
    return finish(obj, name, mat, parent, bevel)


def loft(name, rings, mat, bevel=0.012, parent=root):
    n = len(rings[0])
    faces = [tuple(reversed(range(n)))]
    for j in range(len(rings) - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            faces.append((a, b, b + n, a + n))
    faces.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    return mesh(name, sum(rings, []), faces, mat, parent, bevel)


def box(name, loc, size, mat, bevel=0.015, parent=root):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    for v in obj.data.vertices:
        for i in range(3):
            v.co[i] *= size[i]
    return finish(obj, name, mat, parent, bevel)


def cylinder(name, loc, radius, depth, mat, parent=root, bevel=0.004):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=64,
        radius=radius,
        depth=depth,
        rotation=(math.pi / 2, 0, 0),
        location=loc,
    )
    return finish(bpy.context.object, name, mat, parent, bevel)


def tube(name, points, radius, mat, parent=root):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions, curve.bevel_depth, curve.bevel_resolution = "3D", radius, 3
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for p, co in zip(spline.points, points):
        p.co = (*co, 1)
    obj = bpy.data.objects.new(name, curve)
    vehicle.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return finish(obj, name, mat, parent)


# Longitudinal cross sections run aft to fore, winding outward around +X.
stations = [
    (-2.1825, 0.735, 0.97),
    (-2.08, 0.838, 1.08),
    (-1.75, 0.882, 1.115),
    (-1.33, 0.90, 1.125),
    (-0.68, 0.892, 1.11),
    (0.42, 0.892, 1.085),
    (0.91, 0.899, 1.065),
    (1.33, 0.90, 1.04),
    (1.81, 0.873, 0.997),
    (2.10, 0.83, 0.96),
    (2.1825, 0.75, 0.91),
]
rings = []
for x, w, h in stations:
    cross = [
        (-w * 0.89, 0.285),
        (w * 0.89, 0.285),
        (w * 0.981, 0.41),
        (w, 0.76),
        (w * 0.983, h - 0.065),
        (w * 0.89, h),
        (0, h + 0.016),
        (-w * 0.89, h),
        (-w * 0.983, h - 0.065),
        (-w, 0.76),
        (-w * 0.981, 0.41),
    ]
    rings.append([(x, y, z) for y, z in cross])
body = loft("Pearl body shell", rings, paint, 0)
for x in (-1.328, 1.328):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=96,
        radius=0.39,
        depth=3,
        location=(x, 0, 0.345),
        rotation=(math.pi / 2, 0, 0),
    )
    cutter = bpy.context.object
    mod = body.modifiers.new("Open wheel well", "BOOLEAN")
    mod.operation, mod.object, mod.solver = "DIFFERENCE", cutter, "EXACT"
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
bev = body.modifiers.new("Stamped radii", "BEVEL")
bev.width, bev.segments = 0.012, 3
body.modifiers.move(len(body.modifiers) - 1, 0)

# Cabin section gives side glazing and pillars a shared outer surface.
cab = [
    (-1.99, 0.78, 1.075, 0.756, 1.13),
    (-1.60, 0.81, 1.095, 0.665, 1.545),
    (-1.38, 0.815, 1.10, 0.672, 1.597),
    (-0.45, 0.82, 1.085, 0.683, 1.61),
    (0.18, 0.815, 1.075, 0.68, 1.585),
    (0.33, 0.813, 1.07, 0.69, 1.54),
    (0.94, 0.802, 1.045, 0.78, 1.092),
]
loft(
    "Floating black canopy",
    [
        [(x, -w, z), (x, w, z), (x, v, h), (x, 0, h + 0.02), (x, -v, h)]
        for x, w, z, v, h in cab
    ],
    roof,
    0.016,
)


def cabin_point(x, t, s):
    a, b = next((a, b) for a, b in zip(cab, cab[1:]) if a[0] <= x <= b[0])
    k = (x - a[0]) / (b[0] - a[0])
    w, z, v, h = [a[i] + k * (b[i] - a[i]) for i in range(1, 5)]
    return (x, s * (w + (v - w) * t + 0.004), z + (h - z) * t)


for s in (-1, 1):
    for name, start, end in [
        ("Quarter", -1.805, -1.415),
        ("Rear", -1.355, -0.53),
        ("Front", -0.445, 0.825),
    ]:
        xs = [start] + [row[0] for row in cab if start < row[0] < end] + [end]
        verts = [cabin_point(x, t, s) for x in xs for t in (0.082, 0.91)]
        faces = [(i, i + 1, i + 3, i + 2) for i in range(0, len(verts) - 2, 2)]
        mesh(
            name + " side glass",
            verts,
            [f if s == 1 else f[::-1] for f in faces],
            glass,
        )
    for x in (-1.02, 0.68):
        box("Flush door pull", (x, s * 0.887, 1.0), (0.15, 0.031, 0.029), roof, 0.012)
    for x, dx in [(-1.19, -0.21), (-0.49, 0.045), (0.80, 0.048)]:
        tube(
            "Door shut line",
            [
                (x, s * 0.881, 1.042),
                (x + dx * 0.3, s * 0.897, 0.83),
                (x + dx, s * 0.895, 0.74),
                (x + dx * 0.86, s * 0.886, 0.49 if x > -1 else 0.752),
            ],
            0.004,
            trim,
        )
    box("Lower rocker", (0.005, s * 0.852, 0.342), (1.85, 0.098, 0.15), trim, 0.037)
    tube(
        "Sill brightwork",
        [(-0.89, s * 0.899, 0.34), (-0.72, s * 0.905, 0.363), (0.87, s * 0.904, 0.375)],
        0.012,
        alloy,
    )
    tube(
        "Mirror stalk", [(0.54, s * 0.80, 1.14), (0.48, s * 0.946, 1.181)], 0.029, trim
    )
    box("Mirror cap", (0.48, s * 0.975, 1.205), (0.183, 0.133, 0.092), roof, 0.036)
    for x in (-1.328, 1.328):
        verts = []
        for i in range(73):
            a = -0.14 + (math.pi + 0.28) * i / 72
            for r in (0.39, 0.432):
                verts.append(
                    (
                        x + r * math.cos(a),
                        s * (0.903 - 0.012 * abs(math.cos(a))),
                        0.345 + r * math.sin(a),
                    )
                )
        mesh(
            "Wheel opening molding",
            verts,
            [(i, i + 1, i + 3, i + 2) for i in range(0, 144, 2)],
            trim,
        )

for name, ends in [("Windshield", (0.365, 0.885)), ("Liftgate glass", (-1.94, -1.645))]:
    verts = []
    for x in ends:
        a, b = next((a, b) for a, b in zip(cab, cab[1:]) if a[0] <= x <= b[0])
        k = (x - a[0]) / (b[0] - a[0])
        v = a[3] + k * (b[3] - a[3])
        h = a[4] + k * (b[4] - a[4])
        for fraction in (-0.94, 0, 0.94):
            verts.append((x, v * fraction, h + 0.014 + 0.02 * (1 - abs(fraction))))
    mesh(name, verts, [(0, 3, 4, 1), (1, 4, 5, 2)], glass)
box("Cantilever rear spoiler", (-1.62, 0, 1.548), (0.315, 1.37, 0.047), roof, 0.023)


# A shallow wrap at each end follows the narrowing bumper corners.
def fascia(name, x, z, half, height, depth, bow, mat):
    rings = []
    for y in [-half, -half * 0.83, 0, half * 0.83, half]:
        xc = x - bow * (abs(y) / half) ** 3
        rings.append(
            [
                (xc - depth, y, z - height / 2),
                (xc - depth, y, z + height / 2),
                (xc, y, z + height / 2),
                (xc, y, z - height / 2),
            ]
        )
    return loft(name, rings, mat, 0.008)


fascia("Wide grille surround", 2.222, 0.735, 0.795, 0.325, 0.042, 0.018, black)
for i in range(5):
    fascia(
        "Horizontal grille blade",
        2.234,
        0.610 + i * 0.061,
        0.782,
        0.015,
        0.010,
        0.018,
        gun,
    )
for s in (-1, 1):
    tube(
        "Headlamp bezel",
        [
            (2.184, s * 0.39, 0.899),
            (2.161, s * 0.664, 0.907),
            (2.097, s * 0.814, 0.929),
            (1.86, s * 0.857, 0.948),
        ],
        0.032,
        roof,
    )
    tube(
        "Slim headlight",
        [
            (2.193, s * 0.40, 0.909),
            (2.17, s * 0.662, 0.917),
            (2.106, s * 0.813, 0.937),
            (1.87, s * 0.858, 0.956),
        ],
        0.013,
        white,
    )
    tube(
        "Vertical running lamp",
        [
            (2.112, s * 0.813, 0.887),
            (2.127, s * 0.811, 0.805),
            (2.139, s * 0.801, 0.688),
        ],
        0.012,
        white,
    )
    tube(
        "Rear lamp housing",
        [
            (-2.182, s * 0.34, 0.941),
            (-2.169, s * 0.741, 0.95),
            (-2.07, s * 0.839, 0.994),
            (-1.86, s * 0.867, 1.012),
        ],
        0.036,
        roof,
    )
    tube(
        "Ruby rear signature",
        [
            (-2.19, s * 0.35, 0.95),
            (-2.181, s * 0.736, 0.96),
            (-2.077, s * 0.845, 1.004),
            (-1.86, s * 0.871, 1.022),
        ],
        0.017,
        red,
    )
for x, direction in [(2.18, 1), (-2.18, -1)]:
    fascia(
        "Impact fascia",
        x,
        0.39,
        0.811,
        0.185,
        0.12 * direction,
        0.075 * direction,
        trim,
    )
    fascia(
        "Silver skid insert",
        x + 0.008 * direction,
        0.325,
        0.58,
        0.034,
        0.03 * direction,
        0.027 * direction,
        alloy,
    )

for x, axle in [(1.328, "F"), (-1.328, "R")]:
    for s, side in [(1, "L"), (-1, "R")]:
        tag = axle + side
        mount = (
            empty("Steering_" + tag, root, (x, s * 0.780, 0.345))
            if axle == "F"
            else root
        )
        wheel = empty(
            "Wheel_" + tag, mount, (0, 0, 0) if axle == "F" else (x, s * 0.780, 0.345)
        )
        profile = [
            (0.235, -0.094),
            (0.293, -0.105),
            (0.329, -0.093),
            (0.345, -0.067),
            (0.345, 0.067),
            (0.329, 0.093),
            (0.293, 0.105),
            (0.235, 0.094),
        ]
        verts = [
            (r * math.cos(a), y, r * math.sin(a))
            for i in range(80)
            for a in [math.tau * i / 80]
            for r, y in profile
        ]
        faces = [
            (
                8 * i + j,
                8 * i + (j + 1) % 8,
                8 * ((i + 1) % 80) + (j + 1) % 8,
                8 * ((i + 1) % 80) + j,
            )
            for i in range(80)
            for j in range(8)
        ]
        tire = mesh("Touring tire " + tag, verts, faces, rubber, wheel)
        for p in tire.data.polygons:
            p.use_smooth = True
        cylinder("Rim lip " + tag, (0, 0, 0), 0.245, 0.189, alloy, wheel)
        cylinder("Wheel barrel " + tag, (0, s * 0.096, 0), 0.231, 0.009, black, wheel)
        cylinder("Brake rotor " + tag, (0, s * 0.102, 0), 0.177, 0.005, gun, wheel)
        for i in range(5):
            angle = math.tau * i / 5
            outline = [
                (0.047, -0.024),
                (0.214, -0.048),
                (0.234, -0.033),
                (0.227, 0.013),
                (0.104, 0.024),
                (0.055, 0.037),
            ]
            layers = [
                [
                    (
                        r * math.cos(angle) - t * math.sin(angle),
                        y,
                        r * math.sin(angle) + t * math.cos(angle),
                    )
                    for r, t in outline
                ]
                for y in (0.105, 0.122)
            ]
            loft("Machined swept spoke " + tag, layers, alloy, 0.004, wheel)
            if s < 0:
                spoke = vehicle.objects.get("Machined swept spoke " + tag)
                # Reflect the newest spoke around the wheel center plane.
                layers_obj = next(
                    o
                    for o in reversed(list(wheel.children))
                    if o.name.startswith("Machined swept spoke") and o.scale.y > 0
                )
                layers_obj.scale.y = -1
        cylinder("Hub cap " + tag, (0, s * 0.119, 0), 0.06, 0.024, gun, wheel)

refpath = next(
    (
        p
        for p in [OUT / "reference.jpg", OUT / "artifacts/image-to-3d/reference.jpg"]
        if p.is_file()
    ),
    None,
)
if refpath:
    ref = bpy.data.objects.new("Hidden design reference", None)
    studio.objects.link(ref)
    ref.empty_display_type = "IMAGE"
    ref.data = bpy.data.images.load(str(refpath))
    ref.data.pack()
    ref.hide_viewport = ref.hide_render = True

bpy.ops.object.select_all(action="DESELECT")
for obj in vehicle.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
graph = bpy.context.evaluated_depsgraph_get()
objects = [o for o in vehicle.objects if o.type == "MESH"]
coords = [
    o.matrix_world @ v.co
    for original in objects
    for o in [original.evaluated_get(graph)]
    for v in o.data.vertices
]
report = dict(
    mesh_objects=[o.name for o in objects],
    mesh_count=len(objects),
    vertex_total=len(coords),
    world_bounds_m={
        f.__name__: [f(p[i] for p in coords) for i in range(3)] for f in (min, max)
    },
    assumptions=dict(
        concept_only=True,
        length_m=4.365,
        body_width_m=1.8,
        height_m=1.63,
        wheelbase_m=2.656,
        track_m=1.56,
        tire_radius_m=0.345,
    ),
)
cloud_vertices = []
cloud_faces = []
for original in objects:
    evaluated = original.evaluated_get(graph)
    data = evaluated.data
    data.calc_loop_triangles()
    offset = len(cloud_vertices)
    cloud_vertices.extend([list(evaluated.matrix_world @ v.co) for v in data.vertices])
    cloud_faces.extend(
        [[v + offset for v in triangle.vertices] for triangle in data.loop_triangles]
    )
np.savez_compressed(
    OUT / "baseline-cloud.npz",
    vertices=np.array(cloud_vertices, dtype=np.float32),
    faces=np.array(cloud_faces, dtype=np.int32),
)
(OUT / "geometry.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
bpy.ops.export_scene.gltf(
    filepath=str(OUT / "vehicle.glb"), use_selection=True, export_apply=True
)
try:
    bpy.ops.wm.stl_export(
        filepath=str(OUT / "vehicle.stl"), export_selected_objects=True
    )
except (AttributeError, RuntimeError) as exc:
    print("Warning: STL export unavailable:", exc)

bpy.ops.mesh.primitive_plane_add(size=200)
ground = bpy.context.object
ground.name = "Studio floor"
ground.location.z = -0.002
ground.data.materials.append(material("Slate cyclorama", (0.075, 0.096, 0.12), 0, 0.52))
scene.world = bpy.data.worlds.new("Slate studio")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.15, 0.2, 0.26, 1)
for name, loc, power, size in [
    ("Softbox", (3, -4, 6), 820, 5),
    ("Fill", (2, 4, 3.8), 620, 4),
    ("Rim", (-4, 1, 5), 1100, 4),
]:
    bpy.ops.object.light_add(type="AREA", location=loc)
    light = bpy.context.object
    light.name, light.data.energy, light.data.size = name, power, size
    light.rotation_euler = (
        (Vector((0, 0, 0.8)) - light.location).to_track_quat("-Z", "Y").to_euler()
    )
bpy.ops.object.camera_add()
cam = scene.camera = bpy.context.object
cam.data.type = "ORTHO"
scene.render.engine = "CYCLES"
scene.cycles.device, scene.cycles.samples = "CPU", 24
scene.cycles.use_denoising = True
scene.render.film_transparent = False
scene.render.resolution_percentage = 100


def view(name, loc, target, beauty=False):
    cam.location = loc
    cam.rotation_euler = (
        (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    )
    cam.data.ortho_scale = 6.8 if beauty else 5.6
    scene.render.resolution_x, scene.render.resolution_y = (
        (1400, 1000) if beauty else (1200, 700)
    )
    scene.render.filepath = str(OUT / (name + ".png"))
    ground.hide_render = not beauty


def beauty_view():
    view("preview", (7, -8, 5), (0, 0, 0.8), True)


beauty_view()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "vehicle.blend"))
bpy.ops.render.render(write_still=True)
for name, loc, target in [
    ("side", (0, -9, 0.8), (0, 0, 0.8)),
    ("front", (9, 0, 0.8), (0, 0, 0.8)),
    ("top", (0, 0, 9), (0, 0, 0)),
]:
    view(name, loc, target)
    bpy.ops.render.render(write_still=True)
beauty_view()
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "vehicle.blend"))
