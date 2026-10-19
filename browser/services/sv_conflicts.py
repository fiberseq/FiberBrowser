"""Conservative, sequence-free conflicts for a target's supporting clip.

Only an alignment explaining a substantial part of that clip can conflict.
Missing SA/geometry is absence of evidence, never evidence of absence.
"""
from __future__ import annotations

import json
import math

DEFAULT_CONFLICT_OPTIONS = dict(enabled=True, max_distance=100_000, min_mapq=20,
                                min_overlap=500, min_clip_fraction=0.5)


def normalize_conflict_options(value=None):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            value = None
    value = value if isinstance(value, dict) else {}
    out = dict(DEFAULT_CONFLICT_OPTIONS)
    out['enabled'] = value.get('enabled', True) is not False
    for key, low, high in (('max_distance', 0, 1_000_000_000), ('min_mapq', 0, 255),
                           ('min_overlap', 1, 1_000_000), ('min_clip_fraction', 0, 1)):
        try:
            n = float(value.get(key, out[key]))
            if math.isfinite(n):
                out[key] = max(low, min(high, n if key == 'min_clip_fraction' else int(n)))
        except (ValueError, TypeError, OverflowError):
            pass
    return out


def clip_conflict(read, clip, ref, target_end, chrom=None, options=None):
    """Return an auditable reason when another segment explains this clip elsewhere.

    Each segment's query interval is reference-oriented, includes hard clips,
    and must be reflected into the supporting alignment's frame on strand changes.
    A local inversion or small repeat fragment alone is deliberately insufficient.
    """
    policy = normalize_conflict_options(options)
    if not policy['enabled']:
        return None
    segments = read.get('sv_segments') or []
    anchors = [s for s in segments if s.get('t') != 'SA'
               and (chrom is None or s.get('chrom') == chrom)
               and (s.get('pos') if clip['side'] == 'L' else s.get('pos', 0) + s.get('cigar_ref_len', 0)) == clip['ref']
               and (s.get('q_start', 0) if clip['side'] == 'L' else s.get('query_length', 0) - s.get('q_end', 0)) == clip['len']]
    if clip.get('anchor'):
        anchors = [s for s in anchors if all(s.get(k) == v for k, v in clip['anchor'].items())]
    # Older payloads may lack an explicit origin. Never guess between frames.
    if not anchors or any(any(s.get(k) != anchors[0].get(k) for k in
                             ('chrom', 'pos', 'cigar_ref_len', 'strand', 'q_start', 'q_end', 'query_length'))
                          for s in anchors[1:]):
        return None
    reasons = []
    for anchor in anchors:
        total = anchor.get('query_length', 0)
        a, b = (0, anchor.get('q_start', 0)) if clip['side'] == 'L' else (anchor.get('q_end', total), total)
        if b <= a:
            continue
        for segment in segments:
            if segment == anchor or segment.get('query_length') != total or segment.get('mapq', 0) < policy['min_mapq']:
                continue
            blocks = []
            for x, y in segment.get('query_blocks') or []:
                if segment.get('strand') != anchor.get('strand'):
                    x, y = total - y, total - x
                x, y = max(a, x), min(b, y)
                if y > x:
                    blocks.append((x, y))
            overlap = 0
            covered_end = a
            for x, y in sorted(blocks):
                overlap += max(0, y - max(x, covered_end))
                covered_end = max(covered_end, y)
            fraction = overlap / (b - a)
            if overlap < policy['min_overlap'] or fraction < policy['min_clip_fraction']:
                continue
            other_chrom = segment.get('chrom') != anchor.get('chrom')
            distance = max(0, segment['pos'] - target_end, ref - segment['pos'] - segment.get('cigar_ref_len', 0))
            if not other_chrom and distance <= policy['max_distance']:
                continue
            reasons.append(dict(code='clip_elsewhere', chrom=segment['chrom'], pos=segment['pos'],
                                end=segment['pos'] + segment.get('cigar_ref_len', 0),
                                mapq=segment['mapq'], overlap=overlap, clip_fraction=fraction,
                                distance=None if other_chrom else distance,
                                message=f"Supporting clip aligns elsewhere ({segment['chrom']}:{segment['pos'] + 1:,}; "
                                        f"{overlap:,} bp, {fraction:.0%} of clip; MAPQ {segment['mapq']})"))
    return min(reasons, key=lambda r: (-r['overlap'], -r['mapq'], r['chrom'], r['pos'])) if reasons else None
