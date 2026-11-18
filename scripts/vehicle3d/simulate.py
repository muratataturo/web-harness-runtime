"""Low-speed kinematic bicycle demonstration; not a validated KICKS dynamics model."""

from pathlib import Path
import os
import csv, json, math
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter
from matplotlib.patches import Polygon

OUT = Path(os.environ.get("VEHICLE3D_OUT", ".runtime/vehicle3d/manual")).resolve()
OUT.mkdir(parents=True, exist_ok=True)
L, TRACK, R = 2.656, 1.560, 0.345
DT, T, SPEED = 0.025, 12.0, 3.0


def run():
    # State position is rear axle midpoint. Body center is L/2 forward of this.
    rows = []
    x = y = yaw = distance = 0.0
    for t in np.arange(0, T + DT / 2, DT):
        delta = math.radians(5) * math.sin(2 * math.pi * t / T)
        yaw_rate = SPEED / L * math.tan(delta)
        cx = x + L / 2 * math.cos(yaw)
        cy = y + L / 2 * math.sin(yaw)
        # Individual Ackermann front angles (positive left, wheel y positive left).
        left = math.atan2(L * math.tan(delta), L - TRACK / 2 * math.tan(delta))
        right = math.atan2(L * math.tan(delta), L + TRACK / 2 * math.tan(delta))
        rows.append(
            dict(
                t=float(t),
                rear_x=x,
                rear_y=y,
                x=cx,
                y=cy,
                yaw=yaw,
                speed=SPEED,
                steering=delta,
                steer_left=left,
                steer_right=right,
                yaw_rate=yaw_rate,
                lateral_accel=SPEED * yaw_rate,
                distance=distance,
            )
        )
        # Midpoint heading integration; no lateral slip, flat road.
        x += SPEED * math.cos(yaw + 0.5 * DT * yaw_rate) * DT
        y += SPEED * math.sin(yaw + 0.5 * DT * yaw_rate) * DT
        yaw += yaw_rate * DT
        distance += SPEED * DT
    with (OUT / "trajectory.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (OUT / "trajectory.json").write_text(json.dumps(rows, indent=2))
    ts = np.array([r["t"] for r in rows])
    xs = np.array([r["x"] for r in rows])
    ys = np.array([r["y"] for r in rows])
    plt.style.use("dark_background")
    fig, (ax, control) = plt.subplots(
        2, 1, figsize=(11, 6), gridspec_kw={"height_ratios": [3, 1]}
    )
    fig.patch.set_facecolor("#111b29")
    for a in (ax, control):
        a.set_facecolor("#111b29")
        a.grid(alpha=0.14)
    ax.plot(xs, ys, "--", color="#647b91", linewidth=1)
    ax.set(
        xlim=(xs.min() - 4, xs.max() + 4),
        ylim=(ys.min() - 4, ys.max() + 4),
        xlabel="X [m]",
        ylabel="Y [m]",
    )
    ax.set_aspect("equal")
    ax.set_title(
        "IMAGE TO MOTION / low-speed steering demonstration", loc="left", pad=14
    )
    (path,) = ax.plot([], [], color="#55dbef", lw=2)
    car = Polygon(np.zeros((4, 2)), facecolor="#67c9db", edgecolor="white", lw=1)
    ax.add_patch(car)
    wheel_patches = []
    for _ in range(4):
        p = Polygon(np.zeros((4, 2)), facecolor="#05080c", edgecolor="#a4b5c8", lw=0.7)
        ax.add_patch(p)
        wheel_patches.append(p)
    info = ax.text(0.01, 0.97, "", transform=ax.transAxes, va="top", fontsize=10)
    control.plot(
        ts,
        [math.degrees(r["steering"]) for r in rows],
        color="#55dbef",
        label="Steering [deg]",
    )
    cursor = control.axvline(0, color="white", alpha=0.7)
    control.set(xlabel="Time [s]", ylabel="Steer [deg]", ylim=(-7, 7))
    control.legend(loc="upper right", frameon=False)
    fig.text(
        0.06,
        0.018,
        "ASSUMED: 3 m/s | wheelbase 2.656 m | no slip / suspension / collision | not vehicle validation",
        fontsize=9,
        color="#afbed1",
    )
    fig.tight_layout(rect=(0, 0.045, 1, 1))

    def rect(cx, cy, length, width, angle):
        c, s = math.cos(angle), math.sin(angle)
        p = np.array(
            [
                [-length / 2, -width / 2],
                [length / 2, -width / 2],
                [length / 2, width / 2],
                [-length / 2, width / 2],
            ]
        )
        return p @ np.array([[c, s], [-s, c]]) + np.array([cx, cy])

    def update(k):
        r = rows[k]
        a = r["yaw"]
        c, s = math.cos(a), math.sin(a)
        car.set_xy(rect(r["x"], r["y"], 4.365, 1.8, a))
        for patch, (long, lat, steer) in zip(
            wheel_patches,
            [
                (L / 2, TRACK / 2, r["steer_left"]),
                (L / 2, -TRACK / 2, r["steer_right"]),
                (-L / 2, TRACK / 2, 0),
                (-L / 2, -TRACK / 2, 0),
            ],
        ):
            patch.set_xy(
                rect(
                    r["x"] + long * c - lat * s,
                    r["y"] + long * s + lat * c,
                    0.69,
                    0.215,
                    a + steer,
                )
            )
        path.set_data(xs[: k + 1], ys[: k + 1])
        cursor.set_xdata([r["t"], r["t"]])
        info.set_text(
            f"t {r['t']:4.1f} s    speed {SPEED * 3.6:.1f} km/h    lateral accel {r['lateral_accel']:+.2f} m/s²"
        )
        return car, path, cursor, info, *wheel_patches

    anim = FuncAnimation(
        fig, update, frames=range(0, len(rows), 4), interval=100, blit=False
    )
    anim.save(OUT / "motion.gif", writer=PillowWriter(fps=10), dpi=90)
    update(len(rows) - 1)
    fig.savefig(OUT / "trajectory.png", dpi=150)
    plt.close(fig)
    # Numerical evidence: straight line and constant curvature limiting cases.
    assert abs(SPEED / L * math.tan(0)) < 1e-12
    angle = math.radians(5)
    radius = L / math.tan(angle)
    omega = SPEED / radius
    xx = yy = heading = 0.0
    for _ in range(400):
        xx += SPEED * math.cos(heading + omega * DT / 2) * DT
        yy += SPEED * math.sin(heading + omega * DT / 2) * DT
        heading += omega * DT
    err = math.hypot(
        xx - radius * math.sin(heading), yy - radius * (1 - math.cos(heading))
    )
    assert err < 0.001
    report = dict(
        model="kinematic bicycle, midpoint integrator",
        validated_vehicle_model=False,
        duration_s=T,
        speed_m_s=SPEED,
        wheelbase_m=L,
        track_m=TRACK,
        max_steer_deg=5,
        max_lateral_accel_m_s2=max(abs(r["lateral_accel"]) for r in rows),
        constant_turn_integration_error_m=err,
        samples=len(rows),
        excluded=[
            "tire forces",
            "slip",
            "roll",
            "suspension",
            "braking dynamics",
            "collision",
        ],
    )
    (OUT / "simulation-checks.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    run()
