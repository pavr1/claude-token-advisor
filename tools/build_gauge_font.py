"""Build media/budget-icons.woff: the option-D budget gauge as a colour (COLRv0) icon font.

A status bar glyph normally takes the item's text colour; COLR layers with a fixed
palette entry keep their own colour instead. E001 is the resting gauge, E002..E007
are needle positions 1..6 (left to right) used by the sweep animation.

Needs: pip install fonttools brotli
"""

import math
import sys
from pathlib import Path

from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

OUT = Path(__file__).resolve().parent.parent / "media" / "budget-icons.woff"
# The drawing is cropped to its own bounds (no background tile) so it fills the item.
X0, Y0, DRAW_H = 16, 36, 75  # top-left of the drawing in the SVG's 128 viewBox, and its height
HEIGHT = 1000  # glyph height in em units
TOP = 850  # glyph top above the baseline, so the gauge sits centred on the text
DROP = 300  # descent reserved below the baseline
S = HEIGHT / DRAW_H  # SVG units -> em units
ADVANCE = round(96 * S) + 80  # drawing width plus a gap to the text
CX, CY = 64, 84  # gauge hub in SVG coordinates

PALETTE = ["#14212e", "#8a9bad", "#3fe0c5", "#ffd166", "#ff7a59", "#000000", "#f8ac45"]
BG, TRACK, TEAL, AMBER, CORAL, NEEDLE, HUB = range(7)

# Needle angle per frame (degrees, 180 = far left, 0 = far right); rest is option D's.
FRAME_ANGLES = [165, 135, 105, 75, 45, 15]
REST_ANGLE = math.degrees(math.atan2(26, -20))
NEEDLE_LEN = 32.8


def pt(x: float, y: float) -> tuple[float, float]:
    return (round((x - X0) * S), round(TOP - (y - Y0) * S))


def polar(r: float, deg: float) -> tuple[float, float]:
    a = math.radians(deg)
    return pt(CX + r * math.cos(a), CY - r * math.sin(a))


def circle(cx: float, cy: float, r: float, n: int = 48):
    return [pt(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def rounded_rect(w: float, h: float, r: float, n: int = 10):
    pts = []
    for (ccx, ccy, start) in ((w - r, r, -90), (w - r, h - r, 0), (r, h - r, 90), (r, r, 180)):
        for i in range(n + 1):
            a = math.radians(start + 90 * i / n)
            pts.append(pt(ccx + r * math.cos(a), ccy + r * math.sin(a)))
    return pts


def arc_band(r: float, width: float, a0: float, a1: float, n: int = 40):
    """Stroke of an arc from angle a0 to a1 (deg), as one polygon, with round caps added separately."""
    outer = [polar(r + width / 2, a0 + (a1 - a0) * i / n) for i in range(n + 1)]
    inner = [polar(r - width / 2, a1 - (a1 - a0) * i / n) for i in range(n + 1)]
    return [outer + inner]


def cap(r: float, width: float, deg: float):
    a = math.radians(deg)
    return circle(CX + r * math.cos(a), CY - r * math.sin(a), width / 2)


def stroked_arc(r, width, a0, a1):
    return arc_band(r, width, a0, a1) + [cap(r, width, a0), cap(r, width, a1)]


def thick_line(x0, y0, x1, y1, w):
    dx, dy = x1 - x0, y1 - y0
    d = math.hypot(dx, dy)
    nx, ny = -dy / d * w / 2, dx / d * w / 2
    body = [pt(x0 + nx, y0 + ny), pt(x1 + nx, y1 + ny), pt(x1 - nx, y1 - ny), pt(x0 - nx, y0 - ny)]
    return [body, circle(x0, y0, w / 2), circle(x1, y1, w / 2)]


def needle(deg):
    a = math.radians(deg)
    return thick_line(CX, CY, CX + NEEDLE_LEN * math.cos(a), CY - NEEDLE_LEN * math.sin(a), 6)


def hole(pts):
    return ("hole", pts)


def glyph(contours):
    """TrueType fills clockwise (y up) with non-zero winding; force every contour that way
    (holes the other way round, so they cut out of the shape they sit in)."""
    pen = TTGlyphPen(None)
    for pts in contours:
        is_hole = isinstance(pts, tuple) and pts[0] == "hole"
        if is_hole:
            pts = pts[1]
        area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
        if (area > 0) != is_hole:
            pts = pts[::-1]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


def build() -> None:
    shared = {
        "l_track": (stroked_arc(42, 12, 180, 0), TRACK),
        "l_teal": (stroked_arc(42, 12, 180, 121.4), TEAL),
        "l_amber": (stroked_arc(42, 12, 109.3, 70.7), AMBER),
        "l_coral": (stroked_arc(42, 12, 58.6, 0), CORAL),
        "l_base": (thick_line(30, 108, 98, 108, 6), TRACK),
        "l_hub": ([circle(CX, CY, 14), hole(circle(CX, CY, 6))], HUB),
    }
    angles = [REST_ANGLE] + FRAME_ANGLES
    needles = {f"l_needle{i}": (needle(a), NEEDLE) for i, a in enumerate(angles)}
    layers = {**shared, **needles}
    bases = ["claude-budget-gauge"] + [f"claude-budget-gauge-{i}" for i in range(1, 7)]

    order = [".notdef"] + list(layers) + bases
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE001 + i: name for i, name in enumerate(bases)})
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    for name, (contours, _) in layers.items():
        glyphs[name] = glyph(contours)
    for name in bases:  # monochrome fallback: the track plus the resting needle
        glyphs[name] = glyph(shared["l_track"][0] + needles["l_needle0"][0])
    fb.setupGlyf(glyphs)
    # The left side bearing must equal each glyph's xMin or the renderer shifts it.
    table = fb.font["glyf"]
    metrics = {}
    for n in order:
        g = table[n]
        g.recalcBounds(table)
        metrics[n] = (ADVANCE if n != ".notdef" else 500, getattr(g, "xMin", 0))
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1000, descent=-DROP)
    fb.setupNameTable({"familyName": "Claude Budget Icons", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=1000, sTypoDescender=-DROP, usWinAscent=1000, usWinDescent=DROP)
    fb.setupPost()

    colr = {}
    for i, base in enumerate(bases):
        stack = ["l_track", "l_teal", "l_amber", "l_coral", "l_base", f"l_needle{i}", "l_hub"]
        colr[base] = [(n, layers[n][1]) for n in stack]
    fb.font["COLR"] = buildCOLR(colr, version=0)
    fb.font["CPAL"] = buildCPAL([[tuple(int(c[k : k + 2], 16) / 255 for k in (1, 3, 5)) + (1.0,) for c in PALETTE]])
    fb.font.flavor = "woff"
    fb.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    sys.exit(build())
