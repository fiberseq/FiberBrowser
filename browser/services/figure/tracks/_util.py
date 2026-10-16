"""Small helpers shared by the non-read track ports."""
from __future__ import annotations

from typing import Any

SIDEBAR_WIDTH = 16  # read-track/constants.ts SIDEBAR_WIDTH (cluster gutter)


def cluster_sidebar_width(ctx) -> float:
    """useSubTrackDispatch: tracks leave a cluster gutter once any panel has clusters."""
    assignments = ctx.fe.get("clusterAssignments") or {}
    if isinstance(assignments, dict) and any(isinstance(v, dict) and v for v in assignments.values()):
        return float(SIDEBAR_WIDTH)
    return 0.0


def track_x(ctx, pos: float, sidebar: float = 0.0) -> float:
    """genomeToScreen with a left gutter: sidebar + frac * (width - sidebar), mirrored when reversed."""
    frac = (pos - ctx.start) / max(1, ctx.end - ctx.start)
    plot = max(0.0, ctx.width - sidebar)
    return sidebar + ((1 - frac) if ctx.reversed else frac) * plot


def run_sync(coro) -> Any:
    """Run a FastAPI route coroutine from sync code (they rarely await anything)."""
    try:
        coro.send(None)
    except StopIteration as done:
        return done.value
    coro.close()
    raise RuntimeError("route coroutine awaited; call its sync helper instead")


# --- colour helpers (utils/peakColors.ts) ------------------------------------

def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _hex_to_hsl(hex_color: str) -> tuple[float, float, float]:
    r, g, b = (v / 255 for v in _hex_to_rgb(hex_color))
    mx, mn = max(r, g, b), min(r, g, b)
    light = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, light
    d = mx - mn
    sat = d / (2 - mx - mn) if light > 0.5 else d / (mx + mn)
    if mx == r:
        hue = ((g - b) / d + (6 if g < b else 0)) / 6
    elif mx == g:
        hue = ((b - r) / d + 2) / 6
    else:
        hue = ((r - g) / d + 4) / 6
    return hue * 360, sat, light


def _hsl_to_hex(h: float, s: float, l: float) -> str:
    h = ((h % 360) + 360) % 360
    a = s * min(l, 1 - l)

    def f(n: int) -> int:
        k = (n + h / 30) % 12
        color = l - a * max(min(k - 3, 9 - k, 1), -1)
        return int(_js_round(255 * max(0.0, min(1.0, color))))

    return "#" + "".join(f"{v:02x}" for v in (f(0), f(8), f(4)))


def _js_round(v: float) -> float:
    import math
    return math.floor(v + 0.5)


def _rgba(hex_color: str, alpha: float) -> str:
    r, g, b = _hex_to_rgb(hex_color)
    return f"rgba({r}, {g}, {b}, {alpha})"


def generate_layer_colors(base_hex: str, opacity: float, use_gradient: bool) -> list[dict]:
    """Port of generateLayerColors: 4 {fill, stroke} layer colours for a peak rule."""
    base_hex = to_hex(base_hex)
    if not use_gradient:
        return [{"fill": _rgba(base_hex, opacity), "stroke": base_hex}] * 4
    h, s, l = _hex_to_hsl(base_hex)
    out = []
    for mult, shift in ((0.85, -10), (0.70, 0), (0.55, 15), (0.40, 25)):
        stroke = _hsl_to_hex(h, s, max(0.0, min(1.0, l + shift / 100)))
        out.append({"fill": _rgba(stroke, opacity * mult), "stroke": stroke})
    return out


def to_hex(color: str) -> str:
    """Any CSS colour the tracks use -> '#rrggbb' (alpha dropped)."""
    from services.figure.surface import parse_color
    text = str(color or "").strip()
    if text.startswith("#") and len(text) in (4, 7):
        return text
    r, g, b, _ = parse_color(text)
    return "#%02x%02x%02x" % (r, g, b)


def with_alpha(color: str, hex_alpha: str) -> str:
    """JS ``color + '30'`` for hex colours; other formats get the same alpha explicitly."""
    from services.figure.surface import parse_color
    text = str(color or "")
    if text.startswith("#") and len(text) == 7:
        return text + hex_alpha
    r, g, b, _ = parse_color(text)
    return f"rgba({r}, {g}, {b}, {int(hex_alpha, 16) / 255:.4f})"


def rounded_rect_points(x: float, y: float, w: float, h: float, radius: float, steps: int = 4) -> list[tuple[float, float]]:
    """Polygon for a rounded rectangle (surface has no arc primitive)."""
    import math
    r = max(0.0, min(radius, w / 2, h / 2))
    if r <= 0.01:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    pts: list[tuple[float, float]] = []
    corners = ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180))
    for cx, cy, a0 in corners:
        for i in range(steps + 1):
            a = math.radians(a0 + 90 * i / steps)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

