"""Validate generated source art against Art/manifest.json.

Every manifest entry must point to an existing PNG with power-of-two sides
(16..2048), RGBA when the entry says it needs alpha, and every PNG under Art/
must be listed. Exit code 1 lists every problem.
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "Art"
problems = []

manifest_path = ART / "manifest.json"
if not manifest_path.exists():
    print(f"missing {manifest_path.relative_to(ROOT)}")
    sys.exit(1)

entries = json.loads(manifest_path.read_text(encoding="utf-8")).get("assets", [])
listed = set()
for e in entries:
    rel = e.get("file", "")
    path = ART / rel
    listed.add(path.resolve())
    if not path.exists():
        problems.append(f"{rel}: listed in manifest but missing")
        continue
    with Image.open(path) as im:
        w, h = im.size
        for side in (w, h):
            if side < 16 or side > 2048 or side & (side - 1):
                problems.append(f"{rel}: {w}x{h} is not a power of two in 16..2048")
                break
        if e.get("alpha") and im.mode != "RGBA":
            problems.append(f"{rel}: needs alpha, image mode is {im.mode}")
    print(f"ok  {rel}  {w}x{h}  {e.get('purpose', '')}")

for png in ART.rglob("*.png"):
    if png.resolve() not in listed:
        problems.append(f"{png.relative_to(ART)}: not listed in manifest")

for p in problems:
    print(f"FAIL {p}")
print(f"{len(entries)} assets, {len(problems)} problems")
sys.exit(1 if problems else 0)
