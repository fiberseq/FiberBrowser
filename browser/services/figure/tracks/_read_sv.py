"""SV display in figures (fb-n9-sv), as the read canvas draws it
(read-track/svDrawing.ts, svCanvas.ts): the SV summary band above the rows,
read bodies broken at deletions with a connector and size label, insertion
flags, clip end markers. Events are absolute (``ref - start`` in view)."""
from __future__ import annotations

from typing import Optional

import numpy as np

# The SV row (its own track in the browser since fb-n11-tracks; trackRegistry 'sv'): default and limits.
SV_BAND_HEIGHT = 44
SV_BAND_MIN = 24
SV_BAND_MAX = 240
COLORS = {
    'deletion': '#dc2626', 'insertion': '#7c3aed', 'clip': '#64748b', 'connector': '#64748b', 'text': '#64748b',
}


def _num(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def settings(fe: dict) -> tuple[bool, int, bool]:
    """(on, min size, retired collapse) from the browser state (a saved collapse draws the row at its minimum)."""
    on = fe.get('svDisplayEnabled')
    min_len = int(max(10, min(1_000_000, _num(fe.get('svMinLen'), 50))))
    return (True if on is None else bool(on)), min_len, bool(fe.get('svTrackCollapsed'))


def visible_summary(payload: dict, fe: dict) -> Optional[dict]:
    """Match the browser's size/support gates; None hides the band."""
    on, min_len, _collapsed = settings(fe)
    summary = (payload or {}).get('sv_summary')
    if not on or not isinstance(summary, dict):
        return None
    support = _num(fe.get('svMinSupport'), 3)
    min_support = int(max(1, min(1_000_000, support + 0.5))) if np.isfinite(support) else 3
    clusters = [c for c in summary.get('clusters') or []
                if int(c.get('len', 0)) >= min_len
                and c.get('support', 0) + (c.get('putative') or 0) >= min_support]
    clips = [c for c in summary.get('clips') or [] if c.get('n', 0) >= min_support]
    if not clusters and not clips:
        return None
    return {**summary, 'clusters': clusters, 'clips': clips}


def band_height(summary: Optional[dict], fe: dict, override=None, shown: bool = True) -> int:
    """The SV row's height: its heightOverride (clamped) or the default; 0 without SVs or the row."""
    on, _min_len, collapsed = settings(fe)
    if not on or not summary or not shown:
        return 0
    if override is None:
        return SV_BAND_MIN if collapsed else SV_BAND_HEIGHT
    return int(round(max(SV_BAND_MIN, min(SV_BAND_MAX, _num(override, SV_BAND_HEIGHT)))))


def metrics(height: float) -> dict:
    """svBandMetrics (svDrawing.ts): glyphs scale with the row."""
    h = max(16.0, float(height))
    label_px = round(min(12, max(9, h / 5.5)))
    caption_px = round(min(11, max(8, h / 6)))
    label_room = label_px + 4
    inner = max(6, h - 3 - label_room)
    flag_w = round(min(12, max(7, h / 6)))
    return {'label_px': label_px, 'caption_px': caption_px, 'inner': inner, 'flag_w': flag_w,
            'flag_h': round(flag_w * 0.85), 'clip_max': max(8, round(inner * 0.3)), 'line': 2 if h >= 90 else 1.5}


def size_text(t: str, length: int) -> str:
    """formatSvSize: '−1.8 kb', '+312'."""
    if length >= 10_000:
        s = f"{round(length / 1000)} kb"
    elif length >= 1000:
        s = f"{length / 1000:.1f} kb"
    else:
        s = str(length)
    return ('−' if t == 'D' else '+') + s


def read_draw(read: dict, start: int, end: int, min_len: int) -> dict:
    """readSvDraw: a read's deletions/insertions/clips to draw, view-relative."""
    out = {'deletions': [], 'insertions': [], 'clips': []}
    for ev in read.get('sv') or ():
        t = ev.get('t')
        if t == 'SA' or int(ev.get('len', 0)) < min_len:
            continue
        if t == 'S':
            ref = int(ev['ref'])
            if start <= ref <= end:
                out['clips'].append((ref - start, ev.get('side'), int(ev['len'])))
            continue
        for piece in ev.get('raw_pieces') or [ev]:
            ref, length = int(piece['ref']), int(piece['len'])
            if piece['t'] == 'D' and ref + length > start and ref < end:
                out['deletions'].append((ref - start, ref + length - start, length))
            elif piece['t'] == 'I' and start <= ref <= end:
                out['insertions'].append((ref - start, length))
    return out


def deleted_spans(reads: list, start: int, end: int, min_len: int):
    """(rows, rel starts, rel ends) of the deletions that break read bodies."""
    rows, a, b = [], [], []
    for i, read in enumerate(reads):
        for s, e, _len in read_draw(read, start, end, min_len)['deletions']:
            rows.append(i)
            a.append(s)
            b.append(e)
    return np.array(rows, dtype=np.int64), np.array(a, float), np.array(b, float)


def _label_fits(text: str, px: float, char_px: float = 5.4, pad: float = 6) -> bool:
    return px >= len(text) * char_px + pad


def draw_read_marks(surface, p, reads: list, top: float, stride: float, start: int, end: int, min_len: int) -> None:
    """drawReadSvMarks for every drawn row (vector, over the row image)."""
    fh = max(1.0, p.fh)
    font = 0 if fh < 7 else min(10, int(fh - 1))
    # Raster text under 8 output px can't be drawn by every font backend (and can't be read).
    if font and font * float(getattr(surface, 'scale', 2.0) or 2.0) < 8:
        font = 0
    surface.save()
    surface.clip_rect(p.sidebar, top, p.width - p.sidebar, len(reads) * stride)
    for i, read in enumerate(reads):
        sv = read_draw(read, start, end, min_len)
        if not (sv['deletions'] or sv['insertions'] or sv['clips']):
            continue
        y = top + i * stride
        mid = y + fh / 2
        for s, e, length in sv['deletions']:
            xa, xb = float(p.x(s)), float(p.x(e))
            x1, x2 = min(xa, xb), max(xa, xb)
            surface.line(x1, mid, x2, mid, COLORS['connector'], 1 if fh >= 6 else 0.75)
            text = size_text('D', length)
            if font and _label_fits(text, x2 - x1, font * 0.56):
                surface.text((x1 + x2) / 2, mid, text, size=font, color=COLORS['connector'], anchor='middle', baseline='middle')
        direction = -1 if p.rev else 1
        for pos, length in sv['insertions']:
            x = float(p.x(pos))
            surface.rect(x - 1, y, 2, fh, fill=COLORS['insertion'])
            if fh >= 5:
                h = min(5.0, fh / 2)
                surface.polygon([(x, y), (x + direction * 5, y + h / 2), (x, y + h)], fill=COLORS['insertion'])
                if font:
                    surface.text(x + direction * 6, mid, size_text('I', length), size=font, color=COLORS['insertion'],
                                 anchor='start' if direction > 0 else 'end', baseline='middle')
        for pos, side, _length in sv['clips']:
            x = float(p.x(pos))
            d = (-1 if side == 'L' else 1) * (-1 if p.rev else 1)
            surface.line(x, y, x, y + fh, COLORS['clip'], 1.5)
            if fh >= 4:
                surface.line(x, mid, x + d * 4, mid, COLORS['clip'], 1.5)
    surface.restore()


def _bezier(x1, x2, base, apex, h, steps=24):
    pts = []
    c = apex - h / 3
    for k in range(steps + 1):
        t = k / steps
        mt = 1 - t
        x = mt ** 3 * x1 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * x2
        y = mt ** 3 * base + 3 * mt * mt * t * c + 3 * mt * t * t * c + t ** 3 * base
        pts.append((x, y))
    return pts


def draw_band(surface, p, summary: dict, top: float, height: float, start: int, collapsed: bool = False) -> None:
    """drawSvBand: deletion arcs and insertion flags by support, clip pile ticks, scaled to the row."""
    m = metrics(height)
    lw, label_px = m['line'], m['label_px']
    surface.save()
    surface.clip_rect(p.sidebar, top, p.width - p.sidebar, height)
    surface.line(p.sidebar, top + height - 0.5, p.width, top + height - 0.5, COLORS['text'], 1, opacity=0.35)
    clusters = summary.get('clusters') or []
    loaded = ' · in loaded reads' if summary.get('scope') == 'loaded' else ''
    base = top + height - 3
    inner = m['inner']
    max_support = max([1] + [int(c.get('support', 0)) for c in clusters])
    for pile in summary.get('clips') or []:
        x = float(p.x(int(pile['ref']) - start))
        h = min(m['clip_max'], 2 + int(pile.get('n', 1)) * m['clip_max'] / 8)
        d = (-1 if pile.get('side') == 'L' else 1) * (-1 if p.rev else 1)
        surface.polyline([(x, base), (x, base - h), (x + d * max(3, m['flag_w'] / 2), base - h)], COLORS['clip'], lw)
    for c in sorted(clusters, key=lambda c: -(int(c['end']) - int(c['ref']))):
        color = COLORS['deletion'] if c['t'] == 'D' else COLORS['insertion']
        frac = int(c['support']) / max_support
        h = max(6, round(inner * (0.35 + 0.65 * frac)))
        label = f"{size_text(c['t'], int(c['len']))} {c['support']}/{c['informative']}"
        if c['t'] == 'D':
            xa, xb = float(p.x(int(c['ref']) - start)), float(p.x(int(c['end']) - start))
            x1, x2 = min(xa, xb), max(xa, xb)
            apex = base - h
            if x2 - x1 < 4:
                surface.line(x1, base, x1, apex, color, lw)
            else:
                surface.polyline(_bezier(x1, x2, base, apex, h), color, lw)
            short = f"{c['support']}/{c['informative']}"
            text = label if _label_fits(label, x2 - x1) else short if _label_fits(short, max(x2 - x1, 28)) else ''
            if text:
                surface.text((x1 + x2) / 2, max(top + label_px / 2 + 1, apex - label_px / 2 - 1), text, size=label_px,
                             color=color, anchor='middle', baseline='middle')
        else:
            x = float(p.x(int(c['ref']) - start))
            flag_top = base - h
            d = -1 if p.rev else 1
            fw, fh = m['flag_w'], m['flag_h']
            surface.line(x, base, x, flag_top, color, lw)
            surface.polygon([(x, flag_top), (x + d * fw, flag_top + fh / 2), (x, flag_top + fh)], fill=color)
            surface.text(x + d * (fw + 2), flag_top + fh / 2, label, size=label_px, color=color,
                         anchor='start' if d > 0 else 'end', baseline='middle')
    surface.text(p.sidebar + 3, top + m['caption_px'] / 2 + 2, f"SV{loaded}", size=m['caption_px'], color=COLORS['text'],
                 baseline='middle')
    surface.restore()
