"""Build the README's first screenshot: the agents frame with each tab labelled by its CLI.

    python tools/readme-hero.py

Takes img/readme-agents-base.png, adds a band above the window with a label per CLI and a
line down to each of its tabs (one label forks to several tabs of the same CLI), outlines
the tabs, and writes img/readme-agents.webp. The tab boxes are measured on that shot;
re-measure them if the shot is retaken.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SITE = Path(__file__).resolve().parent.parent
SOURCE = SITE / 'img' / 'readme-agents-base.png'
OUT = SITE / 'img' / 'readme-agents.webp'

BLUE = (79, 163, 255)
VIOLET = (124, 92, 255)
# (label, color, [(left, right) of each of its tabs]); all tabs span the same rows.
LABELS = [
    ('Orchestrator', VIOLET, [(258, 515)]),
    ('Claude Code', BLUE, [(518, 678), (681, 797)]),
    ('Codex', BLUE, [(800, 895)]),
    ('OpenCode', BLUE, [(898, 1092)]),
    ('Cursor', BLUE, [(1095, 1219)]),
]
TAB_TOP, TAB_BOTTOM = 122, 152

BAND = 96
PILL_TOP, PILL_H = 14, 42
FORK_Y = 76              # where a line to several tabs splits
BG = (15, 17, 21)
FONT = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)


def main() -> None:
    shot = Image.open(SOURCE).convert('RGB')
    out = Image.new('RGB', (shot.width, shot.height + BAND), BG)
    out.paste(shot, (0, BAND))
    d = ImageDraw.Draw(out)
    tab_top = BAND + TAB_TOP
    for label, color, tabs in LABELS:
        centers = [(left + right) // 2 for left, right in tabs]
        for left, right in tabs:
            d.rounded_rectangle((left + 1, tab_top, right - 1, BAND + TAB_BOTTOM), radius=4, outline=color, width=3)
        cx = (centers[0] + centers[-1]) // 2
        bottom = PILL_TOP + PILL_H
        if len(centers) == 1:
            d.line((cx, bottom, cx, tab_top), fill=color, width=3)
        else:
            d.line((cx, bottom, cx, FORK_Y), fill=color, width=3)
            d.line((centers[0], FORK_Y, centers[-1], FORK_Y), fill=color, width=3)
            for c in centers:
                d.line((c, FORK_Y, c, tab_top), fill=color, width=3)
        w = d.textlength(label, font=FONT)
        d.rounded_rectangle((cx - w / 2 - 16, PILL_TOP, cx + w / 2 + 16, bottom), radius=PILL_H // 2, fill=color)
        d.text((cx, PILL_TOP + PILL_H / 2), label, font=FONT, fill=(255, 255, 255), anchor='mm')
    out.save(OUT, 'WEBP', quality=88)
    print(OUT.relative_to(SITE))


if __name__ == '__main__':
    main()
