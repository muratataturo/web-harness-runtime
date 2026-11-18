"""Compose actual Blender orthographic renders with concept dimension callouts."""

from pathlib import Path
import os
import json
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
fig = plt.figure(figsize=(16.54, 11.69), facecolor="white")
fig.text(
    0.05,
    0.95,
    "KICKS-INSPIRED SUV / CONCEPT GENERAL ARRANGEMENT",
    fontsize=21,
    weight="bold",
    color="#123044",
)
fig.text(
    0.05,
    0.922,
    "Single-image approximation  |  Dimensions in mm  |  Not for manufacturing  |  Sheet A3 / fit-to-page",
    fontsize=11,
    color="#52697c",
)


def dim(ax, a, b, label, offset=(0, 0)):
    ax.annotate(
        "", xy=b, xytext=a, arrowprops=dict(arrowstyle="<->", lw=0.9, color="#183b56")
    )
    ax.text(
        (a[0] + b[0]) / 2 + offset[0],
        (a[1] + b[1]) / 2 + offset[1],
        label,
        ha="center",
        va="center",
        fontsize=10,
        color="#183b56",
        bbox=dict(facecolor="white", edgecolor="none", pad=1.5),
    )


view_lines = json.loads((OUT / "drawing-lines.json").read_text())


def view(rect, image, label):
    ax = fig.add_axes(rect)
    key = image.split(".")[0].upper()
    ax.add_collection(
        LineCollection(view_lines[key], colors="#1c3545", linewidths=0.45)
    )
    ax.set(xlim=(-3, 3), ylim=((-1.5, 1.5) if key == "TOP" else (-1.25, 2.65)))
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(label, loc="left", fontsize=12, color="#123044")
    return ax


side = view([0.04, 0.51, 0.56, 0.35], "side.png", "01 / SIDE")
dim(
    side,
    (-2.1825, -0.45),
    (2.1825, -0.45),
    "4365 assumed body length",
    offset=(0, -0.15),
)
dim(side, (-1.328, -0.85), (1.328, -0.85), "2656 assumed wheelbase", offset=(0, -0.15))
dim(side, (2.55, 0), (2.55, 1.63), "1630", offset=(0.29, 0))
front = view([0.64, 0.51, 0.32, 0.35], "front.png", "02 / FRONT")
dim(front, (-0.9, -0.45), (0.9, -0.45), "1800 body", offset=(0, -0.18))
top = view([0.04, 0.10, 0.56, 0.35], "top.png", "03 / TOP")
dim(
    top,
    (-2.1825, -1.15),
    (2.1825, -1.15),
    "4365 assumed body length",
    offset=(0, -0.18),
)
geo = json.loads((OUT / "geometry.json").read_text())
ax = fig.add_axes([0.64, 0.12, 0.32, 0.31])
ax.axis("off")
lines = [
    "DESIGN BASIS / LIMITATIONS",
    "",
    "Reference: 240 x 180 px supplied product photo.",
    "Cyan body, black roof and grille: visual reference.",
    "Rear, underbody, cabin and mechanisms: inferred.",
    "",
    "Nominal envelope: 4365 x 1800 x 1630 mm.",
    "Wheelbase: 2656 mm. Track: 1560 mm.",
    "Tire radius: 345 mm. All adopted assumptions.",
    "Mirrors / trim may extend beyond nominal body.",
    "",
    "Views: mesh contours / creases, approximate occlusion.",
    "Dimensions: concept targets, not measured photo values.",
    "No tolerances, sections, fasteners, material or load spec.",
    "Not an OEM CAD model or a fabrication drawing.",
]
ax.text(
    0, 1, "\n".join(lines), va="top", fontsize=10, linespacing=1.55, color="#25465f"
)
fig.text(
    0.05,
    0.045,
    "IMAGE TO 3D  /  Generated Blender mesh + Python motion study  /  Revision 01",
    fontsize=10,
    color="#52697c",
)
fig.savefig(OUT / "drawing.pdf", dpi=180)
fig.savefig(OUT / "drawing.png", dpi=120)
plt.close(fig)
print("Saved drawing.pdf and drawing.png")
