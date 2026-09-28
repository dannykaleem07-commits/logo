#!/usr/bin/env python3
"""Rebuild the Courtesy Cars UK logo as clean, print-ready vector artwork.

- Wordmark and labels are real font outlines (converted to paths, no font
  files needed by the printer), fitted to the original layout.
- Emblem and service icons are traced to smooth Bezier curves from the
  source artwork: each piece is outlined, smoothed along its length with
  corners kept sharp, and refitted as cubic Bezier curves.

Outputs go to ../print/.
"""
import io
import os

import numpy as np
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "source", "original.png")
FONTS = os.path.join(HERE, "fonts")
OUT = os.path.join(ROOT, "print")

# Brand colours (sampled from the original, cleaned up)
NAVY = "#072647"
BLUE = "#1466D2"
GRAY = "#A9A9A9"

W, H = 2000, 396  # artboard in source-pixel units

UPSCALE = 8  # tracing resolution multiplier


# --------------------------------------------------------------------------
# Text -> outlines
# --------------------------------------------------------------------------
_font_cache = {}


def font(name, axes=None):
    key = (name, tuple(sorted((axes or {}).items())))
    if key not in _font_cache:
        f = TTFont(os.path.join(FONTS, name))
        if axes:
            f = instancer.instantiateVariableFont(f, axes)
        _font_cache[key] = f
    return _font_cache[key]


def run_outline(f, text, scale, tracking, x, baseline):
    """Return an SVG path string for `text` set at `scale` with extra
    `tracking` (in output units) between glyphs."""
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    pen = SVGPathPen(gs)
    cx = x
    for ch in text:
        gname = cmap[ord(ch)]
        adv = hmtx[gname][0] * scale
        if ch != " ":
            tp = TransformPen(pen, (scale, 0, 0, -scale, cx, baseline))
            gs[gname].draw(tp)
        cx += adv + tracking
    return pen.getCommands()


def run_bounds(f, text, scale, tracking):
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    bp = BoundsPen(gs)
    cx = 0
    for ch in text:
        gname = cmap[ord(ch)]
        if ch != " ":
            tp = TransformPen(bp, (scale, 0, 0, scale, cx, 0))
            gs[gname].draw(tp)
        cx += hmtx[gname][0] * scale + tracking
    return bp.bounds  # xmin, ymin, xmax, ymax (y up)


def fit_text(f, text, box, word_gap=None):
    """Fit `text` so its ink bounding box matches box=(x0,y0,x1,y1).
    Height sets the scale; width sets letter tracking."""
    x0, y0, x1, y1 = box
    b = run_bounds(f, text, 1.0, 0)
    scale = (y1 - y0) / (b[3] - b[1])
    b = run_bounds(f, text, scale, 0)
    n = len(text) - 1
    tracking = ((x1 - x0) - (b[2] - b[0])) / n if n else 0
    b = run_bounds(f, text, scale, tracking)
    x = x0 - b[0]
    baseline = y1 + b[1]  # b[1] is ink bottom (usually ~0 or overshoot)
    return run_outline(f, text, scale, tracking, x, baseline)


# --------------------------------------------------------------------------
# Tracing
# --------------------------------------------------------------------------
def load_source():
    im = Image.open(SRC).convert("RGBA")
    arr = np.asarray(im).astype(np.float32) / 255.0
    return arr


def upscale_unpremultiplied(arr, box):
    """Crop and upscale with correct alpha handling."""
    x0, y0, x1, y1 = box
    c = arr[y0:y1, x0:x1]
    a = c[:, :, 3:4]
    pre = c[:, :, :3] * a
    size = ((x1 - x0) * UPSCALE, (y1 - y0) * UPSCALE)

    def up(ch):
        return np.asarray(
            Image.fromarray(ch.astype(np.float32), mode="F").resize(size, Image.BICUBIC)
        )

    pre_u = np.stack([up(pre[:, :, i]) for i in range(3)], -1)
    a_u = np.clip(up(a[:, :, 0]), 0, 1)
    rgb = pre_u / np.maximum(a_u[..., None], 1e-4)
    return np.clip(rgb, 0, 1), a_u


def smooth_field(v, sigma, thr=0.5):
    """Blur a continuous coverage field and threshold it."""
    return ndimage.gaussian_filter(v.astype(np.float32), sigma) > thr


def contour_path(field, offset, sigma_px, corner_deg=55, level=0.5):
    """Trace iso-contours of a coverage field and smooth each outline along
    its length (keeping genuine corners sharp), then emit Catmull-Rom
    splines as cubic Beziers. This removes the pixel ripple that a direct
    trace of aliased source artwork leaves behind."""
    from skimage import measure

    ox, oy = offset
    sc = 1.0 / UPSCALE
    cmds = []
    for c in measure.find_contours(field, level):
        if len(c) < 20:
            continue
        pts = c[:, ::-1]  # (x, y)
        # resample at 1 px spacing along the closed contour
        seg = np.diff(np.vstack([pts, pts[:1]]), axis=0)
        L = np.concatenate([[0], np.cumsum(np.hypot(*seg.T))])
        if L[-1] < 40:
            continue
        n = int(L[-1])
        t = np.linspace(0, L[-1], n, endpoint=False)
        loop = np.vstack([pts, pts[:1]])
        P = np.stack([np.interp(t, L, loop[:, 0]), np.interp(t, L, loop[:, 1])], 1)
        # corners: large turning angle over a short window
        w = 8
        a = P - np.roll(P, w, 0)
        b = np.roll(P, -w, 0) - P
        ang = np.degrees(np.abs(np.arctan2(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0],
                                           (a * b).sum(1))))
        corners = [i for i in range(n)
                   if ang[i] > corner_deg and ang[i] == ang[max(0, i - w):i + w + 1].max()]
        if not corners:
            Q = np.stack([ndimage.gaussian_filter1d(P[:, k], sigma_px, mode="wrap")
                          for k in (0, 1)], 1)
            segs = [np.vstack([Q, Q[:1]])]
        else:
            segs = []
            for j, i0 in enumerate(corners):
                i1 = corners[(j + 1) % len(corners)]
                idx = np.arange(i0, i1 + (n if i1 <= i0 else 0) + 1) % n
                S = P[idx]
                if len(S) > 6:
                    sg = min(sigma_px, len(S) / 6)
                    S = np.stack([ndimage.gaussian_filter1d(S[:, k], sg, mode="nearest")
                                  for k in (0, 1)], 1)
                    S[0], S[-1] = P[idx[0]], P[idx[-1]]
                segs.append(S)
        tf = lambda q: (ox + q[0] * sc, oy + q[1] * sc)
        first = True
        for S in segs:
            S = S[::4] if len(S) > 8 else S
            if len(S) < 2:
                continue
            if first:
                x, y = tf(S[0])
                cmds.append(f"M{x:.3f} {y:.3f}")
                first = False
            for i in range(len(S) - 1):
                p0 = S[max(i - 1, 0)]
                p1, p2 = S[i], S[i + 1]
                p3 = S[min(i + 2, len(S) - 1)]
                c1 = p1 + (p2 - p0) / 6
                c2 = p2 - (p3 - p1) / 6
                cmds.append("C%.3f %.3f %.3f %.3f %.3f %.3f" % (*tf(c1), *tf(c2), *tf(p2)))
        cmds.append("Z")
    return " ".join(cmds)


def trace_emblem(arr):
    """Each emblem piece is a separate island in the artwork, so trace every
    island on its own and colour it from its median source colour."""
    box = (0, 0, 440, 396)
    rgb, a = upscale_unpremultiplied(arr, box)
    # The source edges are aliased (staircase of whole pixels). A blur of
    # about one source pixel removes the steps before tracing.
    solid = smooth_field(a, 8.0)
    lbl, n = ndimage.label(solid)
    sizes = ndimage.sum(solid, lbl, range(1, n + 1))
    pieces = []
    for i in np.argsort(-sizes):
        if sizes[i] < 2000:
            continue
        m = lbl == (i + 1)
        r, g, b = np.median(rgb[m], 0)
        if abs(r - g) < 0.05 and abs(g - b) < 0.05:
            fill = GRAY
        elif b > 0.75:
            fill = BLUE
        elif g > 0.22:
            fill = "url(#midGrad)"
        else:
            fill = "url(#roadGrad)"
        field = ndimage.gaussian_filter(np.where(m, a, 0).astype(np.float32), 4.0)
        pieces.append((fill, contour_path(field, box[:2], sigma_px=32)))
    return pieces


def trace_blue_icon(arr, box):
    rgb, a = upscale_unpremultiplied(arr, box)
    # Composite on white and threshold on the red channel: the blue ink has
    # almost no red, while the thin white detail lines (finger gaps, door
    # slats) do - this keeps those details that an alpha mask would lose.
    red_on_white = rgb[:, :, 0] * a + (1 - a)
    field = ndimage.gaussian_filter((1 - red_on_white).astype(np.float32), 3.0)
    return contour_path(field, box[:2], sigma_px=5, level=0.45)


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
def build_svg():
    arr = load_source()
    head = font("Archivo[wdth,wght].ttf", {"wght": 900, "wdth": 70})
    head_uk = font("Archivo[wdth,wght].ttf", {"wght": 800, "wdth": 80})
    tag_font = font("BarlowSemiCondensed-Medium.ttf")
    lab_font = font("BarlowSemiCondensed-Medium.ttf")

    parts = []

    # ---- Emblem
    emb = trace_emblem(arr)
    g = []
    for fill, d in emb:
        g.append(f'<path fill="{fill}" fill-rule="evenodd" d="{d}"/>')
    parts.append('<g id="emblem">' + "".join(g) + "</g>")

    # ---- Divider bar
    parts.append(f'<rect id="divider" x="452" y="8" width="5" height="380" fill="{NAVY}"/>')

    # ---- Wordmark
    t = []
    t.append(f'<path fill="{NAVY}" d="{fit_text(head, "COURTESY", (481, 42, 1299, 178))}"/>')
    t.append(f'<path fill="{NAVY}" d="{fit_text(head, "CARS", (1320, 42, 1722, 178))}"/>')
    t.append(f'<path fill="{BLUE}" d="{fit_text(head_uk, "UK", (1753, 44, 1985, 176))}"/>')
    parts.append('<g id="wordmark">' + "".join(t) + "</g>")

    # ---- Tagline + rules
    t = []
    for word, box in (("ACCIDENT", (712, 209, 955, 246)),
                      ("MANAGEMENT", (982, 209, 1328, 246)),
                      ("SPECIALISTS", (1355, 209, 1665, 246))):
        t.append(f'<path d="{fit_text(tag_font, word, box)}"/>')
    parts.append(f'<g id="tagline" fill="{NAVY}">' + "".join(t) +
                 '<rect x="489" y="225" width="201" height="4"/>'
                 '<rect x="1689" y="225" width="298" height="4"/></g>')

    # ---- Services row
    t = []
    labels = [
        (("ACCIDENT", (619, 322, 787, 354)), ("CLAIMS", (796, 322, 920, 354))),
        (("CREDIT", (1082, 322, 1202, 354)), ("HIRE", (1213, 322, 1291, 354))),
        (("RECOVERY", (1485, 322, 1660, 354)),),
        (("STORAGE", (1835, 322, 1991, 354)),),
    ]
    for grp in labels:
        for word, box in grp:
            t.append(f'<path d="{fit_text(lab_font, word, box)}"/>')
    for x in (943, 1316, 1687):
        t.append(f'<rect x="{x}" y="291" width="5" height="90"/>')
    parts.append(f'<g id="service-labels" fill="{NAVY}">' + "".join(t) + "</g>")

    icons = []
    for name, box in (("handshake", (478, 284, 610, 386)),
                      ("car", (966, 284, 1068, 386)),
                      ("tow-truck", (1340, 284, 1470, 386)),
                      ("storage", (1712, 282, 1820, 386))):
        d = trace_blue_icon(arr, box)
        icons.append(f'<path id="{name}" fill-rule="evenodd" d="{d}"/>')
    parts.append(f'<g id="service-icons" fill="{BLUE}">' + "".join(icons) + "</g>")

    defs = f"""<defs>
<linearGradient id="midGrad" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#1F5BB8"/><stop offset="0.45" stop-color="#113E8E"/>
<stop offset="0.85" stop-color="#1A58B2"/><stop offset="1" stop-color="#2A74CA"/></linearGradient>
<linearGradient id="roadGrad" x1="0" y1="1" x2="0" y2="0">
<stop offset="0" stop-color="{NAVY}"/><stop offset="0.9" stop-color="{NAVY}"/>
<stop offset="0.95" stop-color="#113A86"/><stop offset="1" stop-color="#1A4A9E"/></linearGradient>
</defs>"""
    return defs, "\n".join(parts)


def write_svg(path, defs, body, width_mm=None):
    size = ""
    if width_mm:
        size = f' width="{width_mm}mm" height="{width_mm * H / W:.3f}mm"'
    svg = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
           f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}"{size}>\n'
           f'<title>Courtesy Cars UK</title>\n{defs}\n{body}\n</svg>\n')
    with open(path, "w") as fh:
        fh.write(svg)
    return svg


PNG_DPI = 3000
PNG_WIDTH_PX = 30000  # 10 in (254 mm) wide at 3000 DPI
PDF_WIDTH_MM = 1000   # vector: scales to any sign size without loss


def export():
    import cairosvg

    os.makedirs(OUT, exist_ok=True)
    defs, body = build_svg()
    base = os.path.join(OUT, "courtesy-cars-uk-logo")

    svg = write_svg(base + ".svg", defs, body, width_mm=PDF_WIDTH_MM)
    cairosvg.svg2pdf(bytestring=svg.encode(), write_to=base + ".pdf")
    cairosvg.svg2eps(bytestring=svg.encode(), write_to=base + ".eps")

    Image.MAX_IMAGE_PIXELS = None
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=PNG_WIDTH_PX)
    im = Image.open(io.BytesIO(png))
    im.save(base + f"-{PNG_DPI}dpi-transparent.png", dpi=(PNG_DPI, PNG_DPI), optimize=True)
    white = Image.new("RGB", im.size, "white")
    white.paste(im, mask=im.split()[3])
    white.save(base + f"-{PNG_DPI}dpi-white.png", dpi=(PNG_DPI, PNG_DPI), optimize=True)

    # small preview for quick viewing
    cairosvg.svg2png(bytestring=svg.encode(), write_to=base + "-preview.png",
                     output_width=2000, background_color="white")
    print("wrote", OUT, im.size)


if __name__ == "__main__":
    export()
