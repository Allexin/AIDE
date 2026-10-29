"""Convert showcase screenshots from shots/ (PNG/JPG) into img/*.webp for the site.

    python tools/to-webp.py [quality]
"""
import sys
from pathlib import Path

from PIL import Image

SITE = Path(__file__).resolve().parent.parent
SRC, DST = SITE / "shots", SITE / "img"
QUALITY = int(sys.argv[1]) if len(sys.argv) > 1 else 88
MAX_WIDTH = 1920

for src in sorted(SRC.iterdir()):
    if src.suffix.lower() not in (".png", ".jpg", ".jpeg"):
        continue
    dst = DST / (src.stem + ".webp")
    with Image.open(src) as im:
        im = im.convert("RGB")
        # Shots taken at >100% Windows scaling are larger than Full HD; bring them back.
        if im.width > MAX_WIDTH:
            im = im.resize((MAX_WIDTH, round(im.height * MAX_WIDTH / im.width)), Image.LANCZOS)
        im.save(dst, "WEBP", quality=QUALITY, method=6)
    print(f"{src.name}: {src.stat().st_size // 1024} KB -> {dst.name}: {dst.stat().st_size // 1024} KB")
