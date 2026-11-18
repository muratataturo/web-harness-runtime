"""Orthographic silhouette/crease extraction with midpoint occlusion check, ASCII DXF R12."""

from pathlib import Path
import os
from collections import defaultdict
import math, json
import bpy
from mathutils import Vector

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(OUT / "vehicle.blend"))
root = bpy.data.objects["Vehicle_Root"]
for obj in bpy.context.scene.objects:
    if obj.type == "MESH" and obj not in root.children_recursive:
        obj.hide_set(True)
dg = bpy.context.evaluated_depsgraph_get()
entities = []
count = defaultdict(int)
view_lines = defaultdict(list)


def entity(kind, *pairs):
    entities.extend(["0", kind])
    for k, v in pairs:
        entities.extend([str(k), str(v)])


def line(a, b, layer):
    entity(
        "LINE",
        (8, layer),
        (10, a[0]),
        (20, a[1]),
        (30, 0),
        (11, b[0]),
        (21, b[1]),
        (31, 0),
    )


def text(x, y, s, h=70):
    entity("TEXT", (8, "LABEL"), (10, x), (20, y), (30, 0), (40, h), (1, s))


views = [
    ("SIDE", Vector((0, -1, 0)), lambda p: (p.x, p.z), (0, 3000)),
    ("FRONT", Vector((1, 0, 0)), lambda p: (-p.y, p.z), (6500, 3000)),
    ("TOP", Vector((0, 0, 1)), lambda p: (p.x, p.y), (0, -500)),
]
for name, direction, project, offset in views:
    text(offset[0] - 2200, offset[1] + 2100, name + " / CONCEPT", 100)
    for original in root.children_recursive:
        if original.type != "MESH":
            continue
        obj = original.evaluated_get(dg)
        mesh = obj.to_mesh()
        matrix = obj.matrix_world
        normalmat = matrix.to_3x3().inverted().transposed()
        world = [matrix @ v.co for v in mesh.vertices]
        normals = [(normalmat @ f.normal).normalized() for f in mesh.polygons]
        adjacent = defaultdict(list)
        for f in mesh.polygons:
            for key in f.edge_keys:
                adjacent[tuple(sorted(key))].append(f.index)
        for (a, b), faces in adjacent.items():
            dots = [normals[i].dot(direction) for i in faces]
            if max(dots) < 1e-6:
                continue
            silhouette = len(faces) == 1 or min(dots) <= 0
            crease = len(faces) > 1 and normals[faces[0]].dot(
                normals[faces[1]]
            ) < math.cos(math.radians(32))
            if not (silhouette or crease):
                continue
            mid = (world[a] + world[b]) * 0.5
            hit, loc, _, _, hitobj, _ = bpy.context.scene.ray_cast(
                dg, mid + direction * 10, -direction, distance=10.03
            )
            if hit and (loc - mid).length > 0.012:
                continue
            pa, pb = project(world[a]), project(world[b])
            aa = (pa[0] * 1000 + offset[0], pa[1] * 1000 + offset[1])
            bb = (pb[0] * 1000 + offset[0], pb[1] * 1000 + offset[1])
            if math.hypot(aa[0] - bb[0], aa[1] - bb[1]) < 0.5:
                continue
            line(aa, bb, name)
            count[name] += 1
            view_lines[name].append([list(pa), list(pb)])
        obj.to_mesh_clear()


def horizontal(x1, x2, y, label):
    line((x1, y), (x2, y), "DIM")
    for x in (x1, x2):
        line((x - 35, y - 35), (x + 35, y + 35), "DIM")
    text((x1 + x2) / 2 - 300, y + 65, label, 65)


horizontal(-2182.5, 2182.5, 2600, "4365 ASSUMED")
horizontal(-1328, 1328, 2300, "2656 WHEELBASE")
horizontal(5600, 7400, 2600, "1800 BODY")
text(-2200, -2100, "UNITS: mm | DIMENSIONS ASSUMED | NOT FOR MANUFACTURE", 80)
text(-2200, -2300, "Mesh silhouettes/creases; midpoint hidden-line approximation.", 65)
text(
    -2200, -2450, "Single low-resolution photo; rear and unseen geometry inferred.", 65
)
header = [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1009",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
]
(OUT / "drawing.dxf").write_text(
    "\n".join(header + entities + ["0", "ENDSEC", "0", "EOF"]) + "\n"
)
(OUT / "dxf-checks.json").write_text(
    json.dumps(
        dict(
            units="mm by convention",
            lines=dict(count),
            hidden_line_method="midpoint ray cast, approximate",
        ),
        indent=2,
    )
)
(OUT / "drawing-lines.json").write_text(json.dumps(dict(view_lines)))
print("DXF view lines:", dict(count))
