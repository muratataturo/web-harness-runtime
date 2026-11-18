"""Copy only bounded review artifacts into docs; never copy models, raw photos or logs."""

import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def publish(run, destination):
    result = json.loads((run / "result.json").read_text())
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("report.html", "result.json", "evidence.json", "events.jsonl"):
        source = run / name
        if source.stat().st_size > 750_000:
            raise ValueError(f"Artifact too large for review snapshot: {name}")
        (destination / ("index.html" if name == "report.html" else name)).write_bytes(
            source.read_bytes()
        )
    for source_name, target_name in [
        ("image-audit.html", "image-audit.html"),
        ("image-metrics.json", "image-metrics.json"),
        ("render-checks.json", "image-render-checks.json"),
    ]:
        source = run / "image-audit" / source_name
        if source.is_file():
            if source.stat().st_size > 750_000:
                raise ValueError(f"Image audit review file too large: {source_name}")
            (destination / target_name).write_bytes(source.read_bytes())
    for relative, name in [
        ("baseline/preview.png", "before.jpg"),
        ("reconstructed.png", "after.jpg"),
        ("validation-overlays.jpg", "test-overlays.jpg"),
    ]:
        image = Image.open(run / relative).convert("RGB")
        image.thumbnail((900, 700))
        image.save(destination / name, quality=80, optimize=True)
    scripts = ROOT / "scripts/vehicle3d"
    receipt = dict(
        schemaVersion=1,
        status=result["status"],
        precisionStatus="not-certified",
        physicalAccuracyCertified=False,
        exitCode=0
        if result.get("deliverable_accepted", result["status"] == "improved")
        else 2,
        sourceFiles={
            str(p.relative_to(ROOT)): sha(p)
            for p in sorted(scripts.iterdir())
            if p.is_file()
        },
        configSha256=sha(ROOT / "examples/vehicle3d/kicks.json"),
        generatedFiles={
            name: dict(
                bytes=(run / name).stat().st_size,
                sha256=sha(run / name),
                includedInGit=False,
            )
            for name in (
                "reconstructed.blend",
                "reconstructed.glb",
                "reconstructed.stl",
                "selected-mesh.npz",
            )
        },
        reviewFiles={
            p.name: dict(bytes=p.stat().st_size, sha256=sha(p))
            for p in sorted(destination.iterdir())
            if p.is_file() and p.name != "receipt.json"
        },
    )
    (destination / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        json.dumps(
            dict(
                files=len(receipt["reviewFiles"]),
                largestBytes=max(v["bytes"] for v in receipt["reviewFiles"].values()),
                physicalAccuracyCertified=False,
            )
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--destination", type=Path, default=ROOT / "docs/vehicle3d")
    args = parser.parse_args()
    publish(args.run.resolve(), args.destination.resolve())
