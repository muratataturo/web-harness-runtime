from pathlib import Path
import os
import hashlib, json, math, struct

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
required = [
    "vehicle.blend",
    "driving.blend",
    "vehicle.glb",
    "vehicle.stl",
    "preview.png",
    "front.png",
    "side.png",
    "top.png",
    "drawing.pdf",
    "drawing.png",
    "drawing.dxf",
    "motion.gif",
    "trajectory.csv",
    "trajectory.json",
    "simulation-checks.json",
    "geometry.json",
    "animation-checks.json",
]
assert all(
    (OUT / name).is_file() and (OUT / name).stat().st_size > 0 for name in required
)
raw = (OUT / "vehicle.glb").read_bytes()
magic, version, length = struct.unpack_from("<4sII", raw)
assert magic == b"glTF" and version == 2 and length == len(raw)
chunk_size, chunk_type = struct.unpack_from("<I4s", raw, 12)
assert chunk_type == b"JSON"
doc = json.loads(raw[20 : 20 + chunk_size])
assert doc.get("meshes") and len(doc.get("materials", [])) >= 5
node_names = [n.get("name", "") for n in doc["nodes"]]
assert all(
    n in node_names
    for n in ["Vehicle_Root", "Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"]
)
assert not any(
    "Hidden design reference" in n or "Studio floor" in n for n in node_names
)
assert not doc.get("cameras")
states = json.loads((OUT / "trajectory.json").read_text())
assert len(states) == 481 and abs(states[-1]["t"] - 12) < 1e-9
assert all(math.isfinite(v) for state in states for v in state.values())
assert (OUT / "drawing.pdf").read_bytes().startswith(b"%PDF")
assert (OUT / "motion.gif").read_bytes().startswith(b"GIF8")
assert (OUT / "drawing.dxf").read_text().rstrip().endswith("EOF")
geo = json.loads((OUT / "geometry.json").read_text())
report = dict(
    status="passed",
    model_requested="gpt-6.2-astra",
    code_generator_evidence="generation.log",
    blender_version="4.5.3 LTS",
    render_engine="Cycles CPU",
    mesh_count=geo["mesh_count"],
    glb_meshes=len(doc["meshes"]),
    glb_nodes=len(doc["nodes"]),
    vehicle_only_export=True,
    simulation_samples=len(states),
    limitations=[
        "approximate appearance",
        "assumed dimensions",
        "not a manufacturing drawing",
        "kinematic motion only",
    ],
    files={
        name: dict(
            bytes=(OUT / name).stat().st_size,
            sha256=hashlib.sha256((OUT / name).read_bytes()).hexdigest(),
        )
        for name in required
    },
)
(OUT / "verification.json").write_text(json.dumps(report, indent=2))
print(json.dumps({k: v for k, v in report.items() if k != "files"}, indent=2))
