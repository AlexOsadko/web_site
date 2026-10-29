#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Збирає легкі шрифти сайту (assets/fonts/*.woff2) з повних шрифтів Google Fonts.

По одному варіативному файлу на гарнітуру: латиниця + українська кирилиця,
вісь opsz зафіксовано, ваги обмежено тими, що використовує css/style.css і
css/site.css. Потрібно: pip install fonttools brotli.

  python3 tools/subset_fonts.py <тека з Inter[opsz,wght].ttf, Onest[wght].ttf,
                                  SourceSerif4[opsz,wght].ttf, SourceSerif4-Italic[opsz,wght].ttf>
Джерело: github.com/google/fonts (ofl/inter, ofl/onest, ofl/sourceserif4).
"""
import io
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# Той самий діапазон — у css/fonts.css (unicode-range).
UNICODES = ("U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,"
            "U+0301,U+0304,U+0308,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2000-206F,U+20AC,"
            "U+20B4,U+2116,U+2122,U+2190-2193,U+2197,U+2212,U+2215,U+2260,U+2265")
JOBS = {
    "inter": ("Inter[opsz,wght].ttf", {"opsz": 14, "wght": (300, 700)}),
    "onest": ("Onest[wght].ttf", {"wght": (400, 800)}),
    "source-serif": ("SourceSerif4[opsz,wght].ttf", {"opsz": 20, "wght": (400, 700)}),
    "source-serif-italic": ("SourceSerif4-Italic[opsz,wght].ttf", {"opsz": 20, "wght": (400, 700)}),
    # Дизайн «E» (з жовтня 2026): заголовки — Oswald, текст — PT Sans, статті — PT Serif.
    "oswald": ("Oswald[wght].ttf", {"wght": (400, 600)}),
    "ptsans": ("PT_Sans-Web-Regular.ttf", None),
    "ptsans-bold": ("PT_Sans-Web-Bold.ttf", None),
    "ptserif": ("PT_Serif-Web-Regular.ttf", None),
    "ptserif-bold": ("PT_Serif-Web-Bold.ttf", None),
    "ptserif-italic": ("PT_Serif-Web-Italic.ttf", None),
}
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "fonts")


def main(src_dir, only=None):
    for name, (src, axes) in JOBS.items():
        if only and name not in only:
            continue
        font = TTFont(os.path.join(src_dir, src))
        if axes:                # варіативний: фіксуємо/обмежуємо осі
            font = instancer.instantiateVariableFont(font, axes)
            buf = io.BytesIO()
            font.save(buf)      # перечитуємо: subsetter не працює з «лінивими» таблицями instancer
            buf.seek(0)
            font = TTFont(buf)
        opt = subset.Options()
        opt.flavor = "woff2"
        opt.layout_features = ["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk", "tnum", "pnum", "case"]
        opt.name_IDs = ["*"]
        opt.notdef_outline = True
        opt.hinting = False      # хінтинг TrueType — до половини розміру файлу, на сучасних екранах не потрібен
        sub = subset.Subsetter(opt)
        sub.populate(unicodes=subset.parse_unicodes(UNICODES))
        sub.subset(font)
        font.flavor = "woff2"
        path = os.path.join(OUT, name + ".woff2")
        font.save(path)
        print(f"{path}: {os.path.getsize(path) // 1024} КБ")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".", sys.argv[2:] or None)
