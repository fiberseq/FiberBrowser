"""One drawing surface, three outputs: SVG, PDF and PNG.

Tracks draw once, in browser (CSS) pixels, with the calls below; the backend
decides how that becomes a file. Reads and other dense images go in as RGBA
arrays (``image``), everything else stays vector in SVG/PDF, like the
browser's Export. No browser and no extra dependencies: PNG uses Pillow, SVG
and PDF are written directly.

Clipping is geometric (shapes are cut to the clip box, text outside it is
dropped) rather than clip paths, which some editors (Illustrator) mishandle.
"""
from __future__ import annotations

import base64
import io
import math
import os
import zlib
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Helvetica advance widths (1/1000 em) for ASCII 32..126, from the standard
# AFM. Used to measure text identically in every backend.
_HELVETICA = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
_HELVETICA_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]
MONO_WIDTH = 600  # Courier


def measure_text(text: str, size: float, weight: str = "normal", mono: bool = False) -> float:
    """Width of ``text`` in px at ``size`` px (Helvetica / Courier metrics)."""
    if mono:
        return len(text) * MONO_WIDTH * size / 1000
    table = _HELVETICA_BOLD if weight == "bold" else _HELVETICA
    total = 0
    for ch in text:
        code = ord(ch)
        total += table[code - 32] if 32 <= code <= 126 else 556
    return total * size / 1000


def parse_color(color) -> tuple[int, int, int, float]:
    """'#rgb', '#rrggbb', '#rrggbbaa', 'rgb(...)', 'rgba(...)' -> (r, g, b, alpha)."""
    if color is None:
        return (0, 0, 0, 0.0)
    if isinstance(color, (tuple, list)):
        r, g, b = (int(c) for c in color[:3])
        return (r, g, b, float(color[3]) if len(color) > 3 else 1.0)
    text = str(color).strip().lower()
    if text in ("none", "transparent", ""):
        return (0, 0, 0, 0.0)
    if text.startswith("#"):
        hexa = text[1:]
        if len(hexa) in (3, 4):
            hexa = "".join(ch * 2 for ch in hexa)
        r, g, b = int(hexa[0:2], 16), int(hexa[2:4], 16), int(hexa[4:6], 16)
        a = int(hexa[6:8], 16) / 255 if len(hexa) == 8 else 1.0
        return (r, g, b, a)
    if text.startswith("hsl"):
        import colorsys
        inner = text[text.index("(") + 1:text.rindex(")")].replace(",", " ").replace("/", " ").replace("%", "")
        parts = inner.split()
        h, sat, light = (float(v) for v in parts[:3])
        r, g, b = colorsys.hls_to_rgb((h % 360) / 360, light / 100, sat / 100)
        return (round(r * 255), round(g * 255), round(b * 255), float(parts[3]) if len(parts) > 3 else 1.0)
    if text.startswith("rgb"):
        inner = text[text.index("(") + 1:text.rindex(")")]
        parts = [p.strip() for p in inner.replace("/", ",").split(",") if p.strip()]
        r, g, b = (int(float(p)) for p in parts[:3])
        a = float(parts[3]) if len(parts) > 3 else 1.0
        return (r, g, b, a)
    named = {"white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0), "gray": (128, 128, 128), "grey": (128, 128, 128)}
    r, g, b = named.get(text, (0, 0, 0))
    return (r, g, b, 1.0)


def _hex(rgb) -> str:
    return "#%02x%02x%02x" % tuple(int(c) for c in rgb[:3])


@dataclass
class _State:
    dx: float = 0.0
    dy: float = 0.0
    clip: Optional[tuple[float, float, float, float]] = None  # x0, y0, x1, y1 in page px


def _clip_segment(x1, y1, x2, y2, box):
    """Liang-Barsky; None when the segment is outside ``box``."""
    x0, y0, xa, ya = box
    t0, t1 = 0.0, 1.0
    dx, dy = x2 - x1, y2 - y1
    for p, q in ((-dx, x1 - x0), (dx, xa - x1), (-dy, y1 - y0), (dy, ya - y1)):
        if abs(p) < 1e-12:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return None
    return (x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy)


class Surface:
    """Drawing API in page pixels; subclasses write the output."""

    _style_italic = False  # set around _text calls (keeps backend signatures stable)

    def __init__(self, width: float, height: float, background: str = "#ffffff"):
        self.width = float(width)
        self.height = float(height)
        self._stack: list[_State] = [_State()]
        if background:
            self._rect(0, 0, self.width, self.height, parse_color(background), None, 0, 1.0)

    # --- state -----------------------------------------------------------
    @property
    def _s(self) -> _State:
        return self._stack[-1]

    def save(self) -> None:
        s = self._s
        self._stack.append(_State(s.dx, s.dy, s.clip))

    def restore(self) -> None:
        if len(self._stack) > 1:
            self._stack.pop()

    def translate(self, dx: float, dy: float) -> None:
        self._s.dx += dx
        self._s.dy += dy

    def clip_rect(self, x: float, y: float, w: float, h: float) -> None:
        """Cut everything drawn after this to the box (until restore)."""
        box = (x + self._s.dx, y + self._s.dy, x + self._s.dx + w, y + self._s.dy + h)
        if self._s.clip:
            c = self._s.clip
            box = (max(box[0], c[0]), max(box[1], c[1]), min(box[2], c[2]), min(box[3], c[3]))
        self._s.clip = box

    # --- drawing (local coordinates) -------------------------------------
    def rect(self, x, y, w, h, fill=None, stroke=None, stroke_width: float = 1.0, opacity: float = 1.0) -> None:
        if w < 0:
            x, w = x + w, -w
        if h < 0:
            y, h = y + h, -h
        x0, y0 = x + self._s.dx, y + self._s.dy
        x1, y1 = x0 + w, y0 + h
        c = self._s.clip
        if c:
            cx0, cy0, cx1, cy1 = max(x0, c[0]), max(y0, c[1]), min(x1, c[2]), min(y1, c[3])
            if cx1 <= cx0 or cy1 <= cy0:
                return
            if stroke is not None and (cx0, cy0, cx1, cy1) != (x0, y0, x1, y1):
                # Stroke only the sides that are still visible.
                if fill is not None:
                    self._rect(cx0, cy0, cx1 - cx0, cy1 - cy0, parse_color(fill), None, 0, opacity)
                for seg in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
                    cut = _clip_segment(*seg, c)
                    if cut:
                        self._line(*cut, parse_color(stroke), stroke_width, None, opacity)
                return
            x0, y0, x1, y1 = cx0, cy0, cx1, cy1
        self._rect(x0, y0, x1 - x0, y1 - y0, parse_color(fill) if fill is not None else None,
                   parse_color(stroke) if stroke is not None else None, stroke_width, opacity)

    def line(self, x1, y1, x2, y2, color="#000000", width: float = 1.0, dash: Optional[Sequence[float]] = None,
             opacity: float = 1.0) -> None:
        pts = (x1 + self._s.dx, y1 + self._s.dy, x2 + self._s.dx, y2 + self._s.dy)
        if self._s.clip:
            pts = _clip_segment(*pts, self._s.clip)
            if pts is None:
                return
        self._line(*pts, parse_color(color), width, dash, opacity)

    def polyline(self, points: Iterable[tuple[float, float]], color="#000000", width: float = 1.0,
                 opacity: float = 1.0) -> None:
        pts = [(x + self._s.dx, y + self._s.dy) for x, y in points]
        if len(pts) < 2:
            return
        if self._s.clip:
            # Split into visible runs.
            runs, run = [], []
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                cut = _clip_segment(ax, ay, bx, by, self._s.clip)
                if cut is None:
                    if len(run) > 1:
                        runs.append(run)
                    run = []
                    continue
                if not run or (abs(run[-1][0] - cut[0]) > 1e-6 or abs(run[-1][1] - cut[1]) > 1e-6):
                    if len(run) > 1:
                        runs.append(run)
                    run = [(cut[0], cut[1])]
                run.append((cut[2], cut[3]))
            if len(run) > 1:
                runs.append(run)
            for r in runs:
                self._polyline(r, parse_color(color), width, opacity)
            return
        self._polyline(pts, parse_color(color), width, opacity)

    def polygon(self, points: Iterable[tuple[float, float]], fill="#000000", opacity: float = 1.0,
                stroke=None, stroke_width: float = 1.0) -> None:
        pts = [(x + self._s.dx, y + self._s.dy) for x, y in points]
        if self._s.clip:
            pts = _clip_polygon(pts, self._s.clip)
        if len(pts) < 3:
            return
        self._polygon(pts, parse_color(fill) if fill is not None else None,
                      parse_color(stroke) if stroke is not None else None, stroke_width, opacity)

    def text(self, x, y, text: str, size: float = 10, color="#000000", anchor: str = "start",
             baseline: str = "alphabetic", weight: str = "normal", mono: bool = False, opacity: float = 1.0,
             max_width: Optional[float] = None, italic: bool = False) -> None:
        """``anchor``: start|middle|end; ``baseline``: alphabetic|middle|top|bottom."""
        text = str(text)
        if max_width is not None:
            while text and measure_text(text, size, weight, mono) > max_width:
                text = text[:-1]
        if not text:
            return
        w = measure_text(text, size, weight, mono)
        px, py = x + self._s.dx, y + self._s.dy
        left = px - (w / 2 if anchor == "middle" else w if anchor == "end" else 0)
        # Baseline position from the requested alignment (Helvetica ascent ~0.72 em).
        base = py + (0.35 * size if baseline == "middle" else 0.72 * size if baseline == "top"
                     else -0.21 * size if baseline == "bottom" else 0)
        c = self._s.clip
        if c:
            if left > c[2] or left + w < c[0] or base - 0.72 * size > c[3] or base < c[1]:
                return
            if left + w > c[2] and anchor == "start":
                while text and left + measure_text(text, size, weight, mono) > c[2]:
                    text = text[:-1]
                if not text:
                    return
                w = measure_text(text, size, weight, mono)
        self._style_italic = italic
        self._text(left, base, text, size, parse_color(color), weight, mono, opacity)
        self._style_italic = False

    def image(self, x, y, w, h, rgba: np.ndarray) -> None:
        """Place an HxWx4 (or HxWx3) uint8 array in the box (cropped to the clip)."""
        if rgba is None or rgba.size == 0 or w <= 0 or h <= 0:
            return
        arr = rgba if rgba.shape[2] == 4 else np.dstack([rgba, np.full(rgba.shape[:2], 255, np.uint8)])
        x0, y0 = x + self._s.dx, y + self._s.dy
        c = self._s.clip
        if c:
            cx0, cy0, cx1, cy1 = max(x0, c[0]), max(y0, c[1]), min(x0 + w, c[2]), min(y0 + h, c[3])
            if cx1 <= cx0 or cy1 <= cy0:
                return
            sx, sy = arr.shape[1] / w, arr.shape[0] / h
            arr = arr[int(round((cy0 - y0) * sy)):max(int(round((cy1 - y0) * sy)), int(round((cy0 - y0) * sy)) + 1),
                      int(round((cx0 - x0) * sx)):max(int(round((cx1 - x0) * sx)), int(round((cx0 - x0) * sx)) + 1)]
            x0, y0, w, h = cx0, cy0, cx1 - cx0, cy1 - cy0
        self._image(x0, y0, w, h, np.ascontiguousarray(arr))

    # --- backend hooks (page coordinates) ----------------------------------
    def _rect(self, x, y, w, h, fill, stroke, stroke_width, opacity): raise NotImplementedError
    def _line(self, x1, y1, x2, y2, color, width, dash, opacity): raise NotImplementedError
    def _polyline(self, pts, color, width, opacity): raise NotImplementedError
    def _polygon(self, pts, fill, stroke, stroke_width, opacity): raise NotImplementedError
    def _text(self, left, base, text, size, color, weight, mono, opacity): raise NotImplementedError
    def _image(self, x, y, w, h, rgba): raise NotImplementedError

    def to_bytes(self) -> bytes:
        raise NotImplementedError


def _clip_polygon(points, box):
    x0, y0, x1, y1 = box
    edges = [
        (lambda p: p[0] >= x0, lambda p, q: (x0, p[1] + (q[1] - p[1]) * (x0 - p[0]) / (q[0] - p[0]))),
        (lambda p: p[0] <= x1, lambda p, q: (x1, p[1] + (q[1] - p[1]) * (x1 - p[0]) / (q[0] - p[0]))),
        (lambda p: p[1] >= y0, lambda p, q: (p[0] + (q[0] - p[0]) * (y0 - p[1]) / (q[1] - p[1]), y0)),
        (lambda p: p[1] <= y1, lambda p, q: (p[0] + (q[0] - p[0]) * (y1 - p[1]) / (q[1] - p[1]), y1)),
    ]
    out = list(points)
    for keep, cross in edges:
        src, out = out, []
        for i, p in enumerate(src):
            prev = src[i - 1]
            if keep(p):
                if not keep(prev):
                    out.append(cross(prev, p))
                out.append(p)
            elif keep(prev):
                out.append(cross(prev, p))
        if not out:
            break
    return out


def _alpha(color, opacity) -> float:
    return max(0.0, min(1.0, (color[3] if color else 1.0) * opacity))


# ---------------------------------------------------------------------------
# SVG
# ---------------------------------------------------------------------------

def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _n(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".") if not float(v).is_integer() else str(int(v))


class SvgSurface(Surface):
    def __init__(self, width, height, background="#ffffff"):
        self._parts: list[str] = []
        super().__init__(width, height, background)

    def _fill_attrs(self, color, opacity, prefix="fill"):
        if color is None or _alpha(color, opacity) <= 0:
            return f' {prefix}="none"'
        a = _alpha(color, opacity)
        return f' {prefix}="{_hex(color)}"' + (f' {prefix}-opacity="{a:.3f}"' if a < 0.999 else "")

    def _rect(self, x, y, w, h, fill, stroke, stroke_width, opacity):
        attrs = self._fill_attrs(fill, opacity)
        if stroke is not None:
            attrs += self._fill_attrs(stroke, opacity, "stroke") + f' stroke-width="{_n(stroke_width)}"'
        self._parts.append(f'<rect x="{_n(x)}" y="{_n(y)}" width="{_n(w)}" height="{_n(h)}"{attrs}/>')

    def _line(self, x1, y1, x2, y2, color, width, dash, opacity):
        dash_attr = f' stroke-dasharray="{",".join(_n(d) for d in dash)}"' if dash else ""
        self._parts.append(f'<line x1="{_n(x1)}" y1="{_n(y1)}" x2="{_n(x2)}" y2="{_n(y2)}"'
                           f'{self._fill_attrs(color, opacity, "stroke")} stroke-width="{_n(width)}"{dash_attr}/>')

    def _polyline(self, pts, color, width, opacity):
        d = " ".join(f"{_n(x)},{_n(y)}" for x, y in pts)
        self._parts.append(f'<polyline points="{d}" fill="none"{self._fill_attrs(color, opacity, "stroke")}'
                           f' stroke-width="{_n(width)}" stroke-linejoin="round"/>')

    def _polygon(self, pts, fill, stroke, stroke_width, opacity):
        d = " ".join(f"{_n(x)},{_n(y)}" for x, y in pts)
        attrs = self._fill_attrs(fill, opacity)
        if stroke is not None:
            attrs += self._fill_attrs(stroke, opacity, "stroke") + f' stroke-width="{_n(stroke_width)}"'
        self._parts.append(f'<polygon points="{d}"{attrs}/>')

    def _text(self, left, base, text, size, color, weight, mono, opacity):
        family = "Courier, monospace" if mono else "Helvetica, Arial, sans-serif"
        bold = ' font-weight="bold"' if weight == "bold" else ""
        if self._style_italic:
            bold += ' font-style="italic"'
        self._parts.append(f'<text x="{_n(left)}" y="{_n(base)}" font-family="{family}" font-size="{_n(size)}"'
                           f'{bold}{self._fill_attrs(color, opacity)}>{_esc(text)}</text>')

    def _image(self, x, y, w, h, rgba):
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
        href = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        self._parts.append(f'<image x="{_n(x)}" y="{_n(y)}" width="{_n(w)}" height="{_n(h)}"'
                           f' preserveAspectRatio="none" image-rendering="pixelated" href="{href}"/>')

    def to_bytes(self) -> bytes:
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{_n(self.width)}" height="{_n(self.height)}"'
                f' viewBox="0 0 {_n(self.width)} {_n(self.height)}">')
        return (head + "".join(self._parts) + "</svg>").encode("utf-8")


# ---------------------------------------------------------------------------
# PDF (minimal writer: vector paths, Helvetica/Courier text, Flate images)
# ---------------------------------------------------------------------------

PX_TO_PT = 0.75  # the browser's Export uses 1 CSS px = 0.75 pt
# Standard-font PDF text is Latin-1: spell out the symbols the tracks use.
_PDF_TEXT = {"◄": "<", "►": ">", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "−": "-", "…": "...",
             "–": "-", "—": "-", "“": '"', "”": '"', "‘": "'", "’": "'", "▸": ">", "▾": "v", "•": "·"}


class PdfSurface(Surface):
    def __init__(self, width, height, background="#ffffff"):
        self._ops: list[str] = []
        self._images: list[tuple[int, int, bytes, Optional[bytes]]] = []
        self._alphas: dict[float, str] = {}
        super().__init__(width, height, background)

    def _y(self, y: float) -> float:
        return (self.height - y) * PX_TO_PT

    def _gs(self, a: float) -> str:
        a = round(a, 3)
        if a >= 0.999:
            return ""
        name = self._alphas.setdefault(a, f"GS{len(self._alphas)}")
        return f"/{name} gs "

    @staticmethod
    def _rgb(color) -> str:
        return " ".join(f"{c / 255:.4f}" for c in color[:3])

    def _rect(self, x, y, w, h, fill, stroke, stroke_width, opacity):
        X, Y, W, H = x * PX_TO_PT, self._y(y + h), w * PX_TO_PT, h * PX_TO_PT
        if fill is not None and _alpha(fill, opacity) > 0:
            self._ops.append(f"q {self._gs(_alpha(fill, opacity))}{self._rgb(fill)} rg {X:.2f} {Y:.2f} {W:.2f} {H:.2f} re f Q")
        if stroke is not None and _alpha(stroke, opacity) > 0:
            self._ops.append(f"q {self._gs(_alpha(stroke, opacity))}{self._rgb(stroke)} RG {stroke_width * PX_TO_PT:.2f} w"
                             f" {X:.2f} {Y:.2f} {W:.2f} {H:.2f} re S Q")

    def _line(self, x1, y1, x2, y2, color, width, dash, opacity):
        if _alpha(color, opacity) <= 0:
            return
        d = f"[{' '.join(f'{v * PX_TO_PT:.2f}' for v in dash)}] 0 d " if dash else ""
        self._ops.append(f"q {self._gs(_alpha(color, opacity))}{self._rgb(color)} RG {width * PX_TO_PT:.2f} w {d}"
                         f"{x1 * PX_TO_PT:.2f} {self._y(y1):.2f} m {x2 * PX_TO_PT:.2f} {self._y(y2):.2f} l S Q")

    def _path(self, pts):
        head = f"{pts[0][0] * PX_TO_PT:.2f} {self._y(pts[0][1]):.2f} m "
        return head + " ".join(f"{x * PX_TO_PT:.2f} {self._y(y):.2f} l" for x, y in pts[1:])

    def _polyline(self, pts, color, width, opacity):
        if _alpha(color, opacity) <= 0:
            return
        self._ops.append(f"q {self._gs(_alpha(color, opacity))}{self._rgb(color)} RG {width * PX_TO_PT:.2f} w 1 j "
                         f"{self._path(pts)} S Q")

    def _polygon(self, pts, fill, stroke, stroke_width, opacity):
        if fill is not None and _alpha(fill, opacity) > 0:
            self._ops.append(f"q {self._gs(_alpha(fill, opacity))}{self._rgb(fill)} rg {self._path(pts)} h f Q")
        if stroke is not None and _alpha(stroke, opacity) > 0:
            self._ops.append(f"q {self._gs(_alpha(stroke, opacity))}{self._rgb(stroke)} RG {stroke_width * PX_TO_PT:.2f} w"
                             f" {self._path(pts)} h S Q")

    def _text(self, left, base, text, size, color, weight, mono, opacity):
        mapped = text
        for src, dst in _PDF_TEXT.items():
            mapped = mapped.replace(src, dst)
        try:
            mapped.encode("latin-1")
        except UnicodeEncodeError:
            # Beyond the standard fonts (Greek, CJK, ...): place the label as a
            # high-resolution image so it reads correctly instead of as "?".
            self._text_image(left, base, text, size, color, weight, opacity)
            return
        font = "F3" if mono else ("F5" if weight == "bold" else "F4") if self._style_italic else ("F2" if weight == "bold" else "F1")
        for src, dst in _PDF_TEXT.items():
            text = text.replace(src, dst)
        safe = text.encode("latin-1", "replace").decode("latin-1")
        safe = safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        self._ops.append(f"q {self._gs(_alpha(color, opacity))}{self._rgb(color)} rg BT /{font} {size * PX_TO_PT:.2f} Tf"
                         f" {left * PX_TO_PT:.2f} {self._y(base):.2f} Td ({safe}) Tj ET Q")

    def _text_image(self, left, base, text, size, color, weight, opacity):
        zoom = 4
        font = _font("unicode_bold" if weight == "bold" else "unicode", max(1, int(round(size * zoom))))
        try:
            width = font.getlength(text)
        except Exception:
            width = measure_text(text, size, weight) * zoom
        img = Image.new("RGBA", (max(1, int(math.ceil(width)) + 2), max(1, int(round(size * zoom * 1.3)))), (0, 0, 0, 0))
        ascent = font.getmetrics()[0] if hasattr(font, "getmetrics") else int(size * zoom * 0.8)
        ImageDraw.Draw(img).text((1, int(size * zoom * 0.95) - ascent), text, font=font,
                                 fill=tuple(int(c) for c in color[:3]) + (int(round(255 * _alpha(color, opacity))),))
        self._image(left, base - size * 0.95, img.width / zoom, img.height / zoom, np.asarray(img))

    def _image(self, x, y, w, h, rgba):
        index = len(self._images)
        rgb = rgba[:, :, :3].tobytes()
        alpha = rgba[:, :, 3]
        mask = zlib.compress(alpha.tobytes()) if (alpha < 255).any() else None
        self._images.append((rgba.shape[1], rgba.shape[0], zlib.compress(rgb), mask))
        self._ops.append(f"q {w * PX_TO_PT:.2f} 0 0 {h * PX_TO_PT:.2f} {x * PX_TO_PT:.2f} {self._y(y + h):.2f} cm /Im{index} Do Q")

    def to_bytes(self) -> bytes:
        objects: list[bytes] = []

        def add(body: bytes) -> int:
            objects.append(body)
            return len(objects)

        content = zlib.compress("\n".join(self._ops).encode("latin-1"))
        fonts = {
            "F1": add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
            "F2": add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
            "F3": add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
            "F4": add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"),
            "F5": add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>"),
        }
        image_ids = []
        for w, h, data, mask in self._images:
            smask = ""
            if mask is not None:
                mid = add(f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray"
                          f" /BitsPerComponent 8 /Filter /FlateDecode /Length {len(mask)} >>\nstream\n".encode()
                          + mask + b"\nendstream")
                smask = f" /SMask {mid} 0 R"
            image_ids.append(add(f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB"
                                 f" /BitsPerComponent 8 /Filter /FlateDecode{smask} /Length {len(data)} >>\nstream\n".encode()
                                 + data + b"\nendstream"))
        gstates = " ".join(f"/{name} << /ca {a} /CA {a} >>" for a, name in self._alphas.items())
        resources = ("<< /Font << " + " ".join(f"/{k} {v} 0 R" for k, v in fonts.items()) + " >>"
                     + (" /XObject << " + " ".join(f"/Im{i} {oid} 0 R" for i, oid in enumerate(image_ids)) + " >>" if image_ids else "")
                     + (f" /ExtGState << {gstates} >>" if gstates else "") + " >>")
        content_id = add(f"<< /Filter /FlateDecode /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
        pages_id = len(objects) + 2
        page_id = add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {self.width * PX_TO_PT:.2f} {self.height * PX_TO_PT:.2f}]"
                      f" /Resources {resources} /Contents {content_id} 0 R >>".encode())
        add(f"<< /Type /Pages /Kids [{page_id} 0 R] /Count 1 >>".encode())
        catalog_id = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())

        out = io.BytesIO()
        out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for number, body in enumerate(objects, start=1):
            offsets.append(out.tell())
            out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
        xref = out.tell()
        out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
        for off in offsets:
            out.write(f"{off:010d} 00000 n \n".encode())
        out.write(f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
        return out.getvalue()


# ---------------------------------------------------------------------------
# PNG
# ---------------------------------------------------------------------------

_FONT_CANDIDATES = {
    "normal": [
        "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ],
    "bold": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ],
    "italic": [
        "/System/Library/Fonts/Supplemental/Arial Italic.ttf", "/Library/Fonts/Arial Italic.ttf", "C:/Windows/Fonts/ariali.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", "/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
    ],
    "unicode": [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf",
        "C:/Windows/Fonts/seguisym.ttf", "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/System/Library/Fonts/Helvetica.ttc",
    ],
    "unicode_bold": [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ],
    "mono": [
        "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Courier.ttc", "C:/Windows/Fonts/consola.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    ],
}
_FONTS: dict[tuple[str, int], ImageFont.ImageFont] = {}


def _matplotlib_font(name: str) -> Optional[str]:
    try:
        import matplotlib  # optional; ships DejaVu
        path = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf", name)
        return path if os.path.isfile(path) else None
    except Exception:
        return None


def _font(kind: str, size: int):
    key = (kind, size)
    if key in _FONTS:
        return _FONTS[key]
    fallback = {"normal": "DejaVuSans.ttf", "bold": "DejaVuSans-Bold.ttf", "italic": "DejaVuSans-Oblique.ttf",
                "mono": "DejaVuSansMono.ttf", "unicode": "DejaVuSans.ttf", "unicode_bold": "DejaVuSans-Bold.ttf"}[kind]
    for path in _FONT_CANDIDATES[kind] + [p for p in [_matplotlib_font(fallback)] if p]:
        try:
            font = ImageFont.truetype(path, size)
            _FONTS[key] = font
            return font
        except (OSError, IOError):
            continue
    _FONTS[key] = ImageFont.load_default()
    return _FONTS[key]


class PngSurface(Surface):
    """Raster output at ``scale`` output pixels per page pixel."""

    def __init__(self, width, height, background="#ffffff", scale: float = 2.0):
        self.scale = float(scale)
        self._img = Image.new("RGBA", (max(1, int(round(width * scale))), max(1, int(round(height * scale)))), (255, 255, 255, 0))
        super().__init__(width, height, background)

    def _draw(self, alpha: float, fn, bbox=None):
        """Opaque shapes draw directly; translucent ones through a small
        overlay the size of their bounding box, so they blend."""
        if alpha >= 0.999:
            fn(ImageDraw.Draw(self._img), 0, 0)
            return
        W, H = self._img.size
        if bbox is None:
            x0, y0, x1, y1 = 0, 0, W, H
        else:
            x0 = max(0, int(math.floor(bbox[0])) - 2)
            y0 = max(0, int(math.floor(bbox[1])) - 2)
            x1 = min(W, int(math.ceil(bbox[2])) + 3)
            y1 = min(H, int(math.ceil(bbox[3])) + 3)
        if x1 <= x0 or y1 <= y0:
            return
        layer = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        fn(ImageDraw.Draw(layer), x0, y0)
        self._img.alpha_composite(layer, (x0, y0))

    @staticmethod
    def _c(color, a):
        return tuple(int(v) for v in color[:3]) + (int(round(255 * a)),)

    def _rect(self, x, y, w, h, fill, stroke, stroke_width, opacity):
        s = self.scale
        box = [x * s, y * s, (x + w) * s - 1, (y + h) * s - 1]
        # Keep hairline boxes visible (a 1 px read is at least one output pixel).
        box[2] = max(box[2], box[0])
        box[3] = max(box[3], box[1])
        shift = lambda ox, oy: [box[0] - ox, box[1] - oy, box[2] - ox, box[3] - oy]
        if fill is not None and _alpha(fill, opacity) > 0:
            a = _alpha(fill, opacity)
            self._draw(a, lambda d, ox, oy: d.rectangle(shift(ox, oy), fill=self._c(fill, a)), box)
        if stroke is not None and _alpha(stroke, opacity) > 0:
            a = _alpha(stroke, opacity)
            wpx = max(1, int(round(stroke_width * s)))
            self._draw(a, lambda d, ox, oy: d.rectangle(shift(ox, oy), outline=self._c(stroke, a), width=wpx), box)

    def _line(self, x1, y1, x2, y2, color, width, dash, opacity):
        a = _alpha(color, opacity)
        if a <= 0:
            return
        s = self.scale
        wpx = max(1, int(round(width * s)))
        segs = [(x1 * s, y1 * s, x2 * s, y2 * s)]
        if dash:
            length = math.hypot(x2 - x1, y2 - y1)
            if length <= 0:
                return
            ux, uy = (x2 - x1) / length, (y2 - y1) / length
            segs, pos, on, i = [], 0.0, True, 0
            while pos < length:
                step = max(0.1, dash[i % len(dash)])
                if on:
                    end = min(length, pos + step)
                    segs.append(((x1 + ux * pos) * s, (y1 + uy * pos) * s, (x1 + ux * end) * s, (y1 + uy * end) * s))
                pos += step
                on = not on
                i += 1
        bbox = (min(min(g[0], g[2]) for g in segs) - wpx, min(min(g[1], g[3]) for g in segs) - wpx,
                max(max(g[0], g[2]) for g in segs) + wpx, max(max(g[1], g[3]) for g in segs) + wpx)
        fill = self._c(color, a)
        self._draw(a, lambda d, ox, oy: [d.line([g[0] - ox, g[1] - oy, g[2] - ox, g[3] - oy], fill=fill, width=wpx)
                                        for g in segs], bbox)

    def _polyline(self, pts, color, width, opacity):
        a = _alpha(color, opacity)
        if a <= 0:
            return
        s = self.scale
        spts = [(x * s, y * s) for x, y in pts]
        wpx = max(1, int(round(width * s)))
        bbox = (min(p[0] for p in spts) - wpx, min(p[1] for p in spts) - wpx,
                max(p[0] for p in spts) + wpx, max(p[1] for p in spts) + wpx)
        fill = self._c(color, a)
        self._draw(a, lambda d, ox, oy: d.line([(x - ox, y - oy) for x, y in spts], fill=fill, width=wpx, joint="curve"), bbox)

    def _polygon(self, pts, fill, stroke, stroke_width, opacity):
        s = self.scale
        spts = [(x * s, y * s) for x, y in pts]
        bbox = (min(p[0] for p in spts), min(p[1] for p in spts), max(p[0] for p in spts), max(p[1] for p in spts))
        if fill is not None and _alpha(fill, opacity) > 0:
            a = _alpha(fill, opacity)
            c = self._c(fill, a)
            self._draw(a, lambda d, ox, oy: d.polygon([(x - ox, y - oy) for x, y in spts], fill=c), bbox)
        if stroke is not None and _alpha(stroke, opacity) > 0:
            a = _alpha(stroke, opacity)
            c = self._c(stroke, a)
            wpx = max(1, int(round(stroke_width * s)))
            self._draw(a, lambda d, ox, oy: d.line([(x - ox, y - oy) for x, y in spts + [spts[0]]], fill=c, width=wpx), bbox)

    def _text(self, left, base, text, size, color, weight, mono, opacity):
        a = _alpha(color, opacity)
        if a <= 0:
            return
        s = self.scale
        kind = "mono" if mono else "bold" if weight == "bold" else "italic" if self._style_italic else "normal"
        font = _font(kind, max(1, int(round(size * s))))
        try:
            ascent = font.getmetrics()[0]
        except Exception:
            ascent = int(size * s * 0.8)
        c = self._c(color, a)
        tx, ty = left * s, base * s - ascent
        bbox = (tx, ty, tx + measure_text(text, size, weight, mono) * s * 1.2 + 4, ty + size * s * 1.4)
        self._draw(a, lambda d, ox, oy: d.text((tx - ox, ty - oy), text, font=font, fill=c), bbox)

    def _image(self, x, y, w, h, rgba):
        s = self.scale
        tw, th = max(1, int(round(w * s))), max(1, int(round(h * s)))
        img = Image.fromarray(rgba, "RGBA").resize((tw, th), Image.NEAREST)
        self._img.alpha_composite(img, (int(round(x * s)), int(round(y * s))))

    def to_image(self) -> Image.Image:
        return self._img.convert("RGB")

    def to_bytes(self) -> bytes:
        buf = io.BytesIO()
        self.to_image().save(buf, "PNG", optimize=True)
        return buf.getvalue()


def make_surface(fmt: str, width: float, height: float, scale: float = 2.0, background: str = "#ffffff") -> Surface:
    fmt = (fmt or "png").lower()
    if fmt == "svg":
        return SvgSurface(width, height, background)
    if fmt == "pdf":
        return PdfSurface(width, height, background)
    if fmt == "png":
        return PngSurface(width, height, background, scale=scale)
    raise ValueError(f"Unknown figure format {fmt!r} (png, svg or pdf)")
