"""Colour and labeling helpers for the read track (vectorised ports).

Ports of the browser helpers ReadTrackCanvas.ts imports:
  - utils/ruleMatching.ts   (buildRuleMatchContext, footprintMatchesRule, ruleTargetsLayer)
  - utils/ruleColors.ts     (buildRuleColorResolver: solid + size gradients)
  - utils/strandRescue.ts   (layer render rank, rescue action colours)
  - utils/tfFamilies.ts     (family metadata/colour, Cart family geometry)
  - read-track/constants.ts (cluster colours, MOD_COLORS)
  - the Cart ("footprintGroups") matcher inside drawReadTrack

Everything works on numpy arrays of intervals (one layer at a time) so a
figure with thousands of reads is coloured in a few vector operations.
"""
from __future__ import annotations

import math
import re
from typing import Any, Iterable, Optional

import numpy as np

from services.figure.defaults import layer_color
from services.figure.surface import parse_color

# --- constants.ts -----------------------------------------------------------
# The app's one cluster palette (utils/colors.py mirrors constants.ts).
from utils.colors import (  # noqa: E402
    CLUSTER_COLORS_HEX as CLUSTER_COLORS,
    UNASSIGNED_CLUSTER_COLOR_HEX as UNASSIGNED_CLUSTER_COLOR,
    UNASSIGNED_CLUSTER_ID,
    cluster_color_hex,
)

MOD_COLORS = {
    'm6a': '#6b21a8', 'mod': '#6b21a8', 'm5c': '#dc2626',
    'deam': '#2dd4bf', 'deam_r': '#2dd4bf', 'deam_y': '#115e59', 'deam_observed': '#111827',
    'deam_possible_ct': '#0d9488', 'deam_possible_ga': '#d97706',
    'msp': '#ea580c', 'fire': '#ea580c', 'footprint': '#16a34a', 'tf': '#e040fb', 'nuc': '#16a34a',
}

UNMATCHED_COLOR = '#cccccc'


def cluster_color(cluster: int) -> str:
    return cluster_color_hex(cluster)


def rgb(color) -> np.ndarray:
    """Any CSS colour the browser uses -> float RGB (0-255)."""
    r, g, b, _ = parse_color(color)
    return np.array([r, g, b], dtype=np.float32)


def rgba(color) -> tuple[np.ndarray, float]:
    r, g, b, a = parse_color(color)
    return np.array([r, g, b], dtype=np.float32), float(a)


def normalize_hex(value: Any, fallback: str) -> str:
    return value if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value) else fallback


def clamp01(value: Any, default: float = 1.0) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(v):
        return default
    return max(0.0, min(1.0, v))


def display_layer(name: str) -> str:
    return 'fire' if name == 'msp' else name


def layers_match(a: Optional[str], b: Optional[str]) -> bool:
    if a == b:
        return True
    return (a == 'fire' and b == 'msp') or (a == 'msp' and b == 'fire')


# --- strandRescue.ts ----------------------------------------------------------
_RESCUE_COLORS = {
    'nuc_sr': {'rescued': '#0f766e', 'harmonized': '#0891b2', 'configuration': '#0369a1', 'annotated': '#0f766e'},
    'tf_sr': {'rescued': '#7c3aed', 'harmonized': '#4f46e5', 'configuration': '#c026d3', 'annotated': '#7c3aed'},
}
_CONSENSUS_RANKS = {'tf_native_replay': 2.5, 'tf_sr_lattice': 3.5, 'tf_cr': 5.5, 'tf_rc': 5.6, 'tf_recall': 6, 'tf_cr_recalled': 6.5,
                    'tf_cr_manual': 6.75, 'nuc_cr_split': 7, 'cr_split_gap': 7.5, 'tf_xcr': 9}


def is_strand_rescue(name: str) -> bool:
    return name in ('nuc_sr', 'tf_sr')


def layer_render_rank(name: str) -> float:
    if name in _CONSENSUS_RANKS:
        return _CONSENSUS_RANKS[name]
    if name in ('msp', 'fire'):
        return 0
    if name == 'tf_consensus':
        return 4
    if name == 'tf_cross_consensus':
        return 5
    if is_strand_rescue(name):
        return 3
    if name == 'tf':
        return 2
    return 1


def rescue_action(kind: Optional[str], annotation: Optional[str]) -> str:
    k = (kind or '').strip().lower()
    if not k or k == '.':
        name = (annotation or '').strip()
        if not name or name == '.':
            return 'unchanged'
        if re.match(r'^fhlt_[0-9a-f]+_', name, re.I):
            return 'configuration'
        if re.search(r'_R\d+$', name, re.I):
            return 'rescued'
        if re.search(r'_H$', name, re.I):
            return 'harmonized'
        return 'annotated'
    if k in ('baseline', 'unchanged'):
        return 'unchanged'
    if k == 'rescued':
        return 'rescued'
    if k in ('edge_refined', 'harmonized'):
        return 'harmonized'
    if k == 'configuration':
        return 'configuration'
    return 'annotated'


def rescue_color(layer: str, action: str, baseline: str) -> str:
    return baseline if action == 'unchanged' else _RESCUE_COLORS[layer][action]


# --- tfFamilies.ts ------------------------------------------------------------
TF_FAMILY_SEPARATION_BP = 24


def _imul(a: int, b: int) -> int:
    return (a * b) & 0xFFFFFFFF


def tf_family_color(family_id: int, annotation_name: Optional[str] = None) -> str:
    named = None
    if annotation_name:
        h = 2166136261
        for ch in annotation_name.encode('utf-16-le').decode('utf-16-le'):
            h = _imul(h ^ ord(ch), 16777619)
        named = h
    normalized = named if named is not None else max(1, min(255, int(family_id)))
    hue = ((normalized - 1) * 137.50776405003785) % 360
    sat = 64 + ((normalized * 37) % 3) * 8
    light = 40 + ((normalized * 53) % 4) * 6
    chroma = (1 - abs(2 * light / 100 - 1)) * sat / 100
    sector = hue / 60
    second = chroma * (1 - abs(sector % 2 - 1))
    if sector < 1:
        r1, g1, b1 = chroma, second, 0
    elif sector < 2:
        r1, g1, b1 = second, chroma, 0
    elif sector < 3:
        r1, g1, b1 = 0, chroma, second
    elif sector < 4:
        r1, g1, b1 = 0, second, chroma
    elif sector < 5:
        r1, g1, b1 = second, 0, chroma
    else:
        r1, g1, b1 = chroma, 0, second
    off = light / 100 - chroma / 2
    return '#' + ''.join('%02x' % int(math.floor((c + off) * 255 + 0.5)) for c in (r1, g1, b1))


def family_metadata(layer: dict, n: int):
    """tfFamilyMetadata for every interval of a layer -> (fid, conf, kind, ann) arrays or None."""
    names = layer.get('quality_names') or []
    quals = layer.get('qualities')
    if 'fi' not in names or not quals:
        return None
    fi = np.asarray(_quality_row(quals, names.index('fi'), n), dtype=np.int64)
    anns = list(layer.get('annotation_names') or [])
    anns = [(a or '') for a in anns] + [''] * max(0, n - len(anns))
    ann = np.array(anns[:n], dtype=object)
    cross = np.array([a.startswith('fhxcr_') for a in ann], dtype=bool)
    fq = np.asarray(_quality_row(quals, names.index('fq'), n) if 'fq' in names else np.zeros(n))
    xq = np.asarray(_quality_row(quals, names.index('xq'), n) if 'xq' in names else np.zeros(n))
    conf = np.clip(np.where(cross, xq, fq) / 255.0, 0, 1)
    if layer.get('family_confidence_kind') == 'unavailable':
        kind = np.full(n, 'unavailable', dtype=object)
    else:
        kind = np.array(['latent-support' if a.startswith('fhlt_') else 'cross-support' if c else 'assignment'
                         for a, c in zip(ann, cross)], dtype=object)
    fi = np.where(fi > 0, fi, 0)
    return {'fid': fi, 'conf': conf, 'kind': kind, 'ann': ann}


def _quality_row(quals, idx: int, n: int) -> np.ndarray:
    row = quals[idx] if idx < len(quals) else None
    out = np.full(n, np.nan)
    if row:
        vals = np.array([np.nan if v is None else v for v in row[:n]], dtype=float)
        out[:len(vals)] = vals
    return out


def quality_row(layer: dict, name: str, n: int) -> Optional[np.ndarray]:
    names = layer.get('quality_names') or []
    quals = layer.get('qualities')
    if name not in names or not quals:
        return None
    return _quality_row(quals, names.index(name), n)


def passes_family_confidence(meta, minimum: float, n: int) -> np.ndarray:
    if minimum <= 0:
        return np.ones(n, dtype=bool)
    if meta is None:
        return np.zeros(n, dtype=bool)
    ok_kind = np.array([k not in ('latent-support', 'unavailable') for k in meta['kind']], dtype=bool)
    return (meta['fid'] > 0) & ok_kind & (meta['conf'] >= minimum)


def family_display(groups: list[dict], dataset_id: str, fid: int, call_start: float, call_end: float,
                   layer_name: str, conf: float, ann: Optional[str]):
    """tfFamilyDisplayGeometryFromIndex for one call -> (group id, mode, start, end) or None."""
    cands = []
    for g in groups:
        if not g.get('autoGeneratedFamily') or g.get('familyId') is None:
            continue
        if g.get('sourceDatasetId') and g.get('sourceDatasetId') != dataset_id:
            continue
        rs, re_ = g.get('referenceAbsStart'), g.get('referenceAbsEnd')
        if rs is None or re_ is None:
            continue
        if ann:
            if g.get('familyAnnotationName') != ann:
                continue
        elif g.get('familyId') != fid:
            continue
        if layer_name and g.get('layer') and g.get('layer') != layer_name:
            continue
        if conf < float(g.get('minFamilyConfidence') or 0):
            continue
        if not (call_end >= rs - TF_FAMILY_SEPARATION_BP and call_start <= re_ + TF_FAMILY_SEPARATION_BP):
            continue
        cands.append(g)
    if not cands:
        return None
    center = (call_start + call_end) / 2

    def dist(g):
        s = g.get('familyModelAbsStart', g.get('referenceAbsStart')) or 0
        e = g.get('familyModelAbsEnd', g.get('referenceAbsEnd')) or 0
        return abs((s + e) / 2 - center)

    match = sorted(cands, key=dist)[0]
    s = match.get('familyModelAbsStart')
    s = match.get('referenceAbsStart') if s is None else s
    e = match.get('familyModelAbsEnd')
    e = match.get('referenceAbsEnd') if e is None else e
    if s is None or e is None or e <= s:
        return None
    mode = match.get('familyBoundaryMode')
    mode = mode if mode in ('molecule', 'family') else 'both'
    return match.get('id'), mode, float(s), float(e)


# --- ruleColors.ts ------------------------------------------------------------
def _hex_or(value, fallback='#888888') -> str:
    return value.lower() if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value) else fallback


def _num_or_none(v):
    if v is None or v == '' or v == '∞':
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def rule_color_resolver(rule: dict):
    """size array -> (N,3) RGB, like buildRuleColorResolver."""
    color = _hex_or(rule.get('color'))
    solid = rgb(color)
    if (rule.get('colorMode') or 'solid') not in ('size_gradient', 'gradient'):
        return lambda size: np.broadcast_to(solid, (len(size), 3))
    raw = rule.get('gradient') if isinstance(rule.get('gradient'), dict) else {}
    start_color = _hex_or(raw.get('startColor', raw.get('start_color')), color)
    end_color = _hex_or(raw.get('endColor', raw.get('end_color')), color)
    has_min = 'sizeMin' in raw or 'size_min' in raw
    has_max = 'sizeMax' in raw or 'size_max' in raw
    gmin = _num_or_none(raw.get('sizeMin', raw.get('size_min'))) if has_min else _num_or_none(rule.get('sizeMin'))
    gmax = _num_or_none(raw.get('sizeMax', raw.get('size_max'))) if has_max else _num_or_none(rule.get('sizeMax'))
    if gmin is not None:
        gmin = max(0.0, gmin)
    if gmax is not None:
        gmax = max(0.0, gmax)
    lo = gmin if gmin is not None else _num_or_none(rule.get('sizeMin'))
    scale = raw.get('scale') if raw.get('scale') in ('linear', 'sqrt', 'log', 'square') else 'linear'
    s_rgb, e_rgb = rgb(start_color), rgb(end_color)
    if lo is None or gmax is None or gmax <= lo:
        return lambda size: np.broadcast_to(s_rgb, (len(size), 3))

    def resolve(size):
        t = np.clip((np.asarray(size, float) - lo) / (gmax - lo), 0, 1)
        if scale == 'sqrt':
            t = np.sqrt(t)
        elif scale == 'log':
            t = np.log1p(9 * t) / math.log(10)
        elif scale == 'square':
            t = t * t
        t = np.clip(t, 0, 1)[:, None]
        return np.clip(np.floor(s_rgb + (e_rgb - s_rgb) * t + 0.5), 0, 255).astype(np.float32)

    return resolve


# --- ruleMatching.ts ----------------------------------------------------------
def rule_targets_layer(rule: dict, layer: Optional[str]) -> bool:
    targets = rule.get('targetLayers') or []
    if not targets or not layer:
        return True
    if layer in targets:
        return True
    return (layer == 'msp' and 'fire' in targets) or (layer == 'fire' and 'msp' in targets)


def _merge(regions: list) -> tuple[np.ndarray, np.ndarray]:
    regions = sorted((float(s), float(e)) for s, e in regions if e > s)
    merged: list[list[float]] = []
    for s, e in regions:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    arr = np.array(merged, dtype=float).reshape(-1, 2)
    return arr[:, 0], arr[:, 1]


def overlaps_any(pos: np.ndarray, regions) -> np.ndarray:
    starts, ends = regions
    if len(starts) == 0:
        return np.zeros(len(pos), dtype=bool)
    idx = np.searchsorted(starts, pos, side='right') - 1
    ok = idx >= 0
    out = np.zeros(len(pos), dtype=bool)
    out[ok] = ends[idx[ok]] > pos[ok]
    return out


class RuleContext:
    """buildRuleMatchContext: region-relative gene/peak regions for this view."""

    def __init__(self, genes: Iterable[dict], peaks: Iterable[dict], start: int, end: int, chrom: str,
                 tracks=None):
        """``tracks``: optional loader for 'track'/'motif' conditions, with
        ``track(index) -> dict | None`` (a /api/tracks/batch item over the view:
        ``render_mode``, absolute ``intervals`` or view-binned ``values``) and
        ``motifs() -> list[dict]`` (every motif-category track's item)."""
        width = end - start
        self._tracks = tracks
        self._track_regions: dict = {}
        self._track_thresholds: dict = {}
        self._motif_regions = None
        self.chrom = chrom
        self.start = start
        self.width = width
        valid = [g for g in genes or [] if _num_or_none(g.get('start')) is not None and _num_or_none(g.get('end')) is not None]

        def clip(s, e):
            return max(0.0, float(s) - start), min(float(width), float(e) - start)

        self.gene_regions = _merge([clip(g['start'], g['end']) for g in valid])
        by_key: dict[str, list] = {}
        for g in valid:
            region = clip(g['start'], g['end'])
            if region[1] <= region[0]:
                continue
            by_key.setdefault(f"id:{g.get('id')}", []).append(region)
            if g.get('name'):
                by_key.setdefault(f"name:{str(g['name']).lower()}", []).append(region)
        self.genes_by_key = {k: _merge(v) for k, v in by_key.items()}
        peaks = list(peaks or [])
        self.peaks_by_layer = {
            layer: _merge([clip(p['start'], p['end']) for p in peaks if (p.get('layer') or 0) <= layer])
            for layer in range(4)
        }
        self.empty = (np.zeros(0), np.zeros(0))

    def condition(self, cond: dict, mid: np.ndarray) -> np.ndarray:
        target = cond.get('target')
        if target == 'gene':
            regions = None
            if cond.get('geneId'):
                r = self.genes_by_key.get(f"id:{cond['geneId']}")
                if r is not None and len(r[0]):
                    regions = r
            if regions is None and cond.get('geneName'):
                regions = self.genes_by_key.get(f"name:{str(cond['geneName']).lower()}", self.empty)
            if regions is None and (cond.get('geneId') or cond.get('geneName')):
                # A named gene that isn't in view matches nothing (not "any gene").
                regions = self.empty
            match = overlaps_any(mid, regions if regions is not None else self.gene_regions)
        elif target == 'peak':
            layer = cond.get('minPeakLayer')
            layer = 3 if layer is None else int(layer)
            match = overlaps_any(mid, self.peaks_by_layer.get(layer, self.empty))
        elif target == 'region':
            rs, re_ = _num_or_none(cond.get('regionStart')), _num_or_none(cond.get('regionEnd'))
            chrom_ok = not cond.get('regionChrom') or not self.chrom or cond.get('regionChrom') == self.chrom
            match = np.zeros(len(mid), dtype=bool)
            if rs is not None and re_ is not None and chrom_ok:
                s = max(0.0, min(rs, re_) - self.start)
                e = min(float(self.width), max(rs, re_) - self.start)
                if e > s:
                    match = (mid >= s) & (mid < e)
        elif target == 'motif':
            match = overlaps_any(mid, self._motifs())
        elif target == 'track' and cond.get('trackId'):
            match = self._track_match(cond, mid)
        else:
            match = np.zeros(len(mid), dtype=bool)
        return ~match if cond.get('negate') else match

    # 'track' / 'motif' conditions (ruleMatching.ts buildRuleMatchContext) ------
    def _intervals(self, item: Optional[dict]) -> list:
        out = []
        for iv in (item or {}).get('intervals') or []:
            s, e = _num_or_none(iv.get('start')), _num_or_none(iv.get('end'))
            if s is None or e is None:
                continue
            s, e = max(0.0, s - self.start), min(float(self.width), e - self.start)
            if e > s:
                out.append((s, e))
        return out

    def _motifs(self):
        if self._motif_regions is None:
            regions = []
            if self._tracks is not None:
                for item in self._tracks.motifs() or []:
                    regions.extend(self._intervals(item))
            self._motif_regions = _merge(regions)
        return self._motif_regions

    def _track_match(self, cond: dict, mid: np.ndarray) -> np.ndarray:
        none = np.zeros(len(mid), dtype=bool)
        try:
            index = int(str(cond['trackId']))
        except (TypeError, ValueError):
            return none  # e.g. 'removed': the track it named is gone
        item = self._tracks.track(index) if self._tracks is not None else None
        if not item:
            return none
        if item.get('render_mode') == 'annotation':
            if index not in self._track_regions:
                self._track_regions[index] = _merge(self._intervals(item))
            return overlaps_any(mid, self._track_regions[index])
        values = [float(v) if v is not None else 0.0 for v in item.get('values') or []]
        if not values:
            return none
        pct = _num_or_none(cond.get('trackThreshold'))
        pct = 50.0 if pct is None else pct
        key = (index, pct)
        if key not in self._track_thresholds:
            positive = sorted(v for v in values if v > 0)
            self._track_thresholds[key] = (
                positive[min(len(positive) - 1, int(math.floor(pct / 100 * len(positive))))] if positive else 0.0)
        bins = np.floor(mid / max(self.width, 1) * len(values)).astype(int)
        bins = np.clip(bins, 0, len(values) - 1)
        return np.asarray(values)[bins] >= self._track_thresholds[key]


def rule_mask(rule: dict, rctx: RuleContext, s, e, size, layer: Optional[str],
              qualities: Optional[dict] = None, annotations: Optional[np.ndarray] = None) -> np.ndarray:
    """footprintMatchesRule for arrays of intervals (region-relative)."""
    n = len(size)
    if not rule.get('enabled', True) or not rule_targets_layer(rule, layer):
        return np.zeros(n, dtype=bool)
    smin = _num_or_none(rule.get('sizeMin')) or 0.0
    mask = size >= smin
    smax = _num_or_none(rule.get('sizeMax'))
    if smax is not None:
        mask &= size <= smax
    if rule.get('requireAnnotationName'):
        if annotations is None:
            return np.zeros(n, dtype=bool)
        mask &= np.array([bool(a) for a in annotations], dtype=bool)
    gates = rule.get('qualityGates') or []
    if gates:
        if qualities is None:
            return np.zeros(n, dtype=bool)
        for gate in gates:
            v = qualities.get(gate.get('qualityName'))
            if v is None:
                return np.zeros(n, dtype=bool)
            ok = ~np.isnan(v) & (v >= float(gate.get('minValue') or 0))
            if gate.get('maxValue') is not None:
                ok &= v <= float(gate['maxValue'])
            mask &= ok
    conds = rule.get('conditions') or []
    if conds and mask.any():
        mid = (np.asarray(s, float) + np.asarray(e, float)) / 2
        for cond in conds:
            mask &= rctx.condition(cond, mid)
    return mask


def match_rules(rules: list[dict], rctx: RuleContext, s, e, size, layer: Optional[str],
                qualities: Optional[dict] = None, annotations=None, eligible=None, active=None):
    """First matching rule per interval -> (matched bool, rgb (N,3), opacity (N,)).

    ``eligible(rule)`` limits which rules are considered (the overlay loop
    only lets rules that explicitly target a non-TF layer recolour it);
    ``active`` limits which intervals are still looking for a rule.
    """
    n = len(size)
    matched = np.zeros(n, dtype=bool)
    colors = np.zeros((n, 3), dtype=np.float32)
    opac = np.ones(n, dtype=np.float32)
    todo = np.ones(n, dtype=bool) if active is None else active.copy()
    for rule in rules:
        if not todo.any():
            break
        if eligible is not None and not eligible(rule):
            continue
        idx = np.flatnonzero(todo)
        m = rule_mask(rule, rctx, s[idx], e[idx], size[idx], layer,
                      None if qualities is None else {k: v[idx] for k, v in qualities.items()},
                      None if annotations is None else annotations[idx])
        if not m.any():
            continue
        hit = idx[m]
        colors[hit] = rule_color_resolver(rule)(size[hit])
        opac[hit] = clamp01(rule.get('opacity', 1))
        matched[hit] = True
        todo[hit] = False
    return matched, colors, opac


# --- Cart ("footprintGroups") matcher ------------------------------------------
def cart_match(groups: list[dict], abs_start, abs_end, size, layer: Optional[str], meta=None, active=None):
    """cartMatch for arrays -> (matched, rgb). First matching Cart entry wins."""
    n = len(size)
    matched = np.zeros(n, dtype=bool)
    colors = np.zeros((n, 3), dtype=np.float32)
    if not groups or n == 0:
        return matched, colors
    todo = np.ones(n, dtype=bool) if active is None else active.copy()
    fid = meta['fid'] if meta is not None else np.zeros(n, dtype=np.int64)
    ann = meta['ann'] if meta is not None else None
    for g in groups:
        if not todo.any():
            break
        if g.get('layer') and not layers_match(g.get('layer'), layer):
            continue
        m = todo.copy()
        if g.get('familyAnnotationName'):
            if ann is None:
                continue
            m &= ann == g['familyAnnotationName']
        elif g.get('familyId') is not None:
            m &= fid == int(g['familyId'])
        smin = float(g.get('sizeMin') or 0)
        if smin > 0:
            m &= size >= smin
        if g.get('sizeMax') is not None:
            m &= size <= float(g['sizeMax'])
        m &= passes_family_confidence(meta, float(g.get('minFamilyConfidence') or 0), n)
        rs, re_ = g.get('referenceAbsStart'), g.get('referenceAbsEnd')
        if rs is not None and re_ is not None:
            rs, re_ = float(rs), float(re_)
            ovl = np.minimum(abs_end, re_) - np.maximum(abs_start, rs)
            m &= ovl > 0
            fp_cov = float(g.get('minFpCoverage') or 0)
            if fp_cov > 0:
                m &= ovl >= fp_cov * size
            tg_cov = float(g.get('minTargetCoverage') or 0)
            if tg_cov > 0:
                m &= ovl >= tg_cov * max(1.0, re_ - rs)
            frac_min = float(g.get('overlapFraction') or 0)
            if frac_min > 0:
                with np.errstate(divide='ignore', invalid='ignore'):
                    frac = np.minimum(ovl / size, ovl / (re_ - rs))
                m &= frac >= frac_min
        if not m.any():
            continue
        colors[m] = rgb(g.get('color') or '#888888')
        matched |= m
        todo &= ~m
    return matched, colors


def layer_color_rgb(name: str, layer_colors: Optional[dict] = None) -> np.ndarray:
    return rgb((layer_colors or {}).get(name) or layer_color(name))
