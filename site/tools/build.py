"""Build the translated landing pages from the English one.

index.html is the source and stays a plain page that opens as is. Each i18n/<lang>.json
maps an exact English fragment to its translation; the result is written to <lang>/index.html
with image paths pointed one level up.

    python tools/build.py

Fails if a fragment is no longer in index.html, so an edited English string cannot leave
a stale translation behind silently. A new English string, however, has to be added to the
dictionaries by hand: untranslated text is copied through as is.
"""
import json
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
GENERATED = '<!-- Generated from ../index.html and i18n/{lang}.json by tools/build.py: edit those, not this file. -->\n'


def build(lang: str, source: str) -> str:
    pairs = json.loads((SITE / 'i18n' / f'{lang}.json').read_text(encoding='utf-8'))
    missing = [en for en in pairs if en not in source]
    if missing:
        sys.exit(f'{lang}: not found in index.html:\n  ' + '\n  '.join(missing))
    page = source
    # Longest first, so a short fragment never rewrites part of a longer one.
    for en in sorted(pairs, key=len, reverse=True):
        page = page.replace(en, pairs[en])
    page = re.sub(r'''(src="|href="|')img/''', r'\1../img/', page)
    return page.replace('<!doctype html>\n', '<!doctype html>\n' + GENERATED.format(lang=lang), 1)


def main() -> None:
    source = (SITE / 'index.html').read_text(encoding='utf-8')
    for dictionary in sorted((SITE / 'i18n').glob('*.json')):
        lang = dictionary.stem
        out = SITE / lang / 'index.html'
        out.parent.mkdir(exist_ok=True)
        out.write_text(build(lang, source), encoding='utf-8', newline='\n')
        print(f'{out.relative_to(SITE)}')


if __name__ == '__main__':
    main()
