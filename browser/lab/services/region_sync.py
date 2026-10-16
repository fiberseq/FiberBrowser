"""Oriented comparison proposals for Synchronise regions.

Every window pair gets candidate correspondences: chains of collinear aligned blocks
from the sequence (indels of any size up to a limit inside one proposal), user anchors
and, only when strong and distinct, rigid whole-window profile shifts. Every requested
metric then scores each candidate along its own block map, so a candidate's status says
whether metrics agree, disagree or only one assessed it.

Coordinates: a block is ``{template: [a, b), window: [c, d)}`` with b - a == d - c. On
'+' template a maps to window c; on '-' template a maps to window d - 1. On a circular
window covering a whole turn, coordinates past its end continue across the origin.
"""
from __future__ import annotations

import logging
import math
import re
import subprocess
import tempfile
import threading
import time
import uuid
from services.byte_cache import shared_cache
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)
_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix='region-sync')
_LOCK = threading.Lock()
METRICS = {'sequence', 'accessibility', 'nfr', 'anchor', 'shape'}
STEP = 10                     # profile bin (bp)
TOLERANCE = 30                # bp: mappings this close are the same correspondence
MAX_PROFILE_READS = 3000      # profiles are means; a stable sample is enough
LOCAL_SPAN = 1000             # bp: profiles are compared over at least this much
LOCAL_SEARCH = 300            # bp: how far a profile may prefer another offset
MAX_SEGMENTS = 60             # aligned segments considered for chaining, per strand
WEIGHTS = {'sequence': 1.0, 'anchor': 1.0, 'accessibility': 0.5, 'nfr': 0.5, 'shape': 0.5}
# Adjustable in the panel's Advanced settings: (default, minimum, maximum).
THRESHOLDS = {
    'profileSupport': (0.3, 0.0, 1.0),   # local profile r that counts as support
    'profileAloneR': (0.4, 0.0, 1.0),    # a profile-only proposal needs this r ...
    'profileAloneZ': (5.0, 0.0, 50.0),   # ... and must stand out of its offset curve by this z
    'sequenceIdentity': (0.9, 0.0, 1.0), # minimum identity of shared sequence
    'sequenceCover': (0.5, 0.05, 1.0),   # share of a proposal shared sequence must cover
    'maxIndel': (2000, 0, 20000),        # largest indel (bp) inside one chained proposal
    'shapeMinR': (0.6, 0.0, 1.0),        # local chromatin-shape match: multi-channel r ...
    'shapeMinZ': (4.0, 0.0, 50.0),       # ... and z against scrambled template profiles
    'shapeWidth': (300, 100, 5000),      # smallest seed (bp); seeds are 1x, 2x and 4x this
    'shapeLandmarks': (0, 0, 1),         # 1: also propose NFR <-> NFR landmark pairs (any NFR resembles any NFR)
}


def thresholds(request):
    """Request thresholds with defaults; out-of-range values are refused."""
    given = request.get('thresholds') or {}
    out = {}
    for key, (default, lo, hi) in THRESHOLDS.items():
        value = given.get(key, default)
        if not isinstance(value, (int, float)) or not lo <= value <= hi:
            raise ValueError(f'{key} must be between {lo} and {hi}.')
        out[key] = value
    out['minimum'] = request.get('minimum', 200)
    return out


def block_key(b, strand):
    """'+': window = template + key. '-': window = key - template (key returned)."""
    return b['window'][0] - b['template'][0] if strand == '+' else b['window'][1] + b['template'][0]


def transform(p):
    return block_key(p, p['strand'])


def to_window(template, strand, key):
    """Template interval -> window interval under a rigid transform."""
    return [template[0] + key, template[1] + key] if strand == '+' else [key - template[1], key - template[0]]


def blocks_of(c):
    return c.get('blocks') or [dict(template=list(c['template']), window=list(c['window']))]


def map_point(c, t):
    """Window coordinate of template coordinate ``t`` (boundary convention); outside the
    chain or inside a gap, the nearest block's offset is used."""
    blocks = blocks_of(c)
    best = min(blocks, key=lambda b: 0 if b['template'][0] <= t < b['template'][1] else min(abs(t - b['template'][0]), abs(t - b['template'][1])))
    key = block_key(best, c['strand'])
    return t + key if c['strand'] == '+' else key - t


def parse_paf(paf):
    """PAF lines -> (strand, gap-free blocks [t0, t1, w0, w1, matched]) in forward window coordinates."""
    out = []
    for line in paf.splitlines():
        f = line.split('\t')
        if len(f) < 12:
            continue
        strand, qlen = f[4], int(f[1])
        t, q = int(f[7]), (int(f[2]) if strand == '+' else qlen - int(f[3]))
        cigar = next((x[5:] for x in f[12:] if x.startswith('cg:Z:')), '')
        blocks = []
        t0, q0, matched = t, q, 0
        for size, op in re.findall(r'(\d+)([MIDNSHP=X])', cigar) + [('0', 'D')]:
            size = int(size)
            if op in '=XM':
                t += size; q += size
                matched += size if op in '=M' else 0
                continue
            if t > t0:
                a, b = (q0, q) if strand == '+' else (qlen - q, qlen - q0)
                blocks.append([t0, t, a, b, matched])
            if op in 'DN': t += size
            if op in 'IS': q += size
            t0, q0, matched = t, q, 0
        if blocks:
            out.append((strand, blocks))
    return out


def junction(prev, nxt, strand):
    """(template gap, window gap) between consecutive blocks; negative = overlap."""
    gt = nxt[0] - prev[1]
    gw = nxt[2] - prev[3] if strand == '+' else prev[2] - nxt[3]
    return gt, gw


def trim_front(blocks, d, strand):
    """Drop the first ``d`` template bases of a segment (to remove an overlap)."""
    out, cut_at = [], blocks[0][0] + d
    for t0, t1, w0, w1, m in blocks:
        if t1 <= cut_at:
            continue
        if t0 < cut_at:
            cut = cut_at - t0
            m = round(m * (t1 - cut_at) / (t1 - t0))
            t0, w0, w1 = cut_at, (w0 + cut if strand == '+' else w0), (w1 if strand == '+' else w1 - cut)
        out.append([t0, t1, w0, w1, m])
    return out


def chain_hits(lines, max_indel, minimum, size_t=None, size_w=None):
    """Chains of collinear segments: each PAF line is split at indels above ``max_indel``,
    then segments chain (template and window both moving on) across gaps up to it.
    Chains are taken best first (most aligned bases), each segment used once."""
    segments = []
    for strand, blocks in lines:
        cur = [blocks[0]]
        for prev, b in zip(blocks, blocks[1:]):
            if max(junction(prev, b, strand)) > max_indel:
                segments.append((strand, cur)); cur = [b]
            else:
                cur.append(b)
        segments.append((strand, cur))
    chains = []
    for strand in '+-':
        segs = sorted([b for st, b in segments if st == strand], key=lambda b: -sum(x[1] - x[0] for x in b))[:MAX_SEGMENTS]
        segs.sort(key=lambda b: (b[0][0], b[-1][1]))
        aligned = [sum(x[1] - x[0] for x in b) for b in segs]
        free = set(range(len(segs)))
        while free:
            score, back, trims = {}, {}, {}
            for i in sorted(free):
                score[i], back[i] = aligned[i], None
                for j in sorted(free):
                    if j >= i:
                        break
                    gt, gw = junction(segs[j][-1], segs[i][0], strand)
                    if min(gt, gw) < -100 or max(gt, gw) > max_indel:
                        continue
                    trim = max(0, -gt, -gw)
                    value = score[j] + aligned[i] - trim - 0.05 * (max(gt, 0) + max(gw, 0)) - 10
                    if value > score[i]:
                        score[i], back[i], trims[i] = value, j, trim
            end = max(score, key=score.get)
            path, i = [], end
            while i is not None:
                path.append(i); i = back[i]
            path.reverse()
            blocks = [list(x) for x in segs[path[0]]]
            for i in path[1:]:
                nxt = trim_front(segs[i], trims.get(i, 0), strand) if trims.get(i) else [list(x) for x in segs[i]]
                while nxt and min(junction(blocks[-1], nxt[0], strand)) < 0:
                    nxt = trim_front(nxt, -min(junction(blocks[-1], nxt[0], strand)), strand)
                blocks += nxt
            free -= set(path)
            # On a doubled (circular) side a chain may run on into the second turn: keep its best turn.
            if size_t and blocks[-1][1] - blocks[0][0] > size_t:
                blocks = best_turn(blocks, strand, size_t, 0)
            if size_w and blocks and max(b[3] for b in blocks) - min(b[2] for b in blocks) > size_w:
                blocks = best_turn(blocks, strand, size_w, 2)
            if not blocks:
                continue
            chain = make_chain(blocks, strand)
            if chain['aligned'] >= minimum:
                chains.append(chain)
    return chains


def clip_raw(blocks, strand, lo, hi, side):
    """Raw blocks clipped to [lo, hi) on the template (side 0) or window (side 2)."""
    out = []
    for t0, t1, w0, w1, m in blocks:
        if side == 0:
            a, b = max(t0, lo), min(t1, hi)
            if b <= a: continue
            nw = (w0 + a - t0, w0 + b - t0) if strand == '+' else (w1 - (b - t0), w1 - (a - t0))
            out.append([a, b, nw[0], nw[1], round(m * (b - a) / (t1 - t0))])
        else:
            a, b = max(w0, lo), min(w1, hi)
            if b <= a: continue
            nt = (t0 + a - w0, t0 + b - w0) if strand == '+' else (t0 + (w1 - b), t1 - (a - w0))
            out.append([nt[0], nt[1], a, b, round(m * (b - a) / (w1 - w0))])
    return out


def best_turn(blocks, strand, size, side):
    """The one-turn stretch of a chain with the most aligned bases (earliest on ties)."""
    best, best_aligned = [], -1
    for x in sorted({b[side] for b in blocks}):
        clipped = clip_raw(blocks, strand, x, x + size, side)
        aligned = sum(b[1] - b[0] for b in clipped)
        if aligned > best_aligned:
            best, best_aligned = clipped, aligned
    return best


def make_chain(blocks, strand):
    aligned = sum(b[1] - b[0] for b in blocks)
    matched = sum(b[4] for b in blocks)
    gaps, inserted, deleted = [], 0, 0
    for prev, b in zip(blocks, blocks[1:]):
        gt, gw = junction(prev, b, strand)
        inserted += max(gw, 0); deleted += max(gt, 0)
        if max(gt, gw) >= 10:
            gaps.append(dict(template=prev[1], window=prev[3] if strand == '+' else prev[2], inserted=max(gw, 0), deleted=max(gt, 0)))
    window = [min(b[2] for b in blocks), max(b[3] for b in blocks)]
    identity = matched / max(1, aligned)
    return dict(template=[blocks[0][0], blocks[-1][1]], window=window, strand=strand, metric='sequence',
                score=identity, identity=identity, aligned=aligned,
                blocks=[dict(template=[b[0], b[1]], window=[b[2], b[3]]) for b in blocks],
                gaps=gaps, indels=dict(inserted=inserted, deleted=deleted, count=len(blocks) - 1))


def shift_chain(c, dt=0, dw=0):
    out = dict(c, template=[c['template'][0] + dt, c['template'][1] + dt], window=[c['window'][0] + dw, c['window'][1] + dw])
    out['blocks'] = [dict(template=[b['template'][0] + dt, b['template'][1] + dt], window=[b['window'][0] + dw, b['window'][1] + dw]) for b in c.get('blocks', [])]
    out['gaps'] = [dict(g, template=g['template'] + dt, window=g['window'] + dw) for g in c.get('gaps', [])]
    return out


def low_complexity(sequence):
    """Reject homopolymers and short tandem repeats by local 3-mer entropy.

    Require at least half the bases in informative 64-base tiles, so a short unique
    flank cannot rescue a long microsatellite alignment.
    """
    from collections import Counter
    sequence = sequence.upper()
    informative = 0
    for start in range(0, len(sequence), 64):
        tile = sequence[start:start + 64]
        counts = Counter(tile[i:i + 3] for i in range(len(tile) - 2) if set(tile[i:i + 3]) <= set('ACGT'))
        n = sum(counts.values())
        entropy = -sum((v / n) * math.log2(v / n) for v in counts.values()) if n else 0
        if entropy >= 3.5:
            informative += len(tile)
    return informative < len(sequence) / 2


def separate_copies(c, diagonal, minimum):
    """Split tandem chains into disjoint copy pairs, trimming incidental end overlap."""
    if not overlaps(c['template'], [x - diagonal for x in c['window']]):
        return [c]
    raw = [[*b['template'], *b['window'], round((b['template'][1] - b['template'][0]) * c['identity'])] for b in c['blocks']]
    out = []
    if c['strand'] == '+':
        width = min(abs(b[2] - b[0] - diagonal) for b in raw)
        if width < minimum:
            return []
        for start in range(c['template'][0], c['template'][1], width):
            part = clip_raw(raw, '+', start, start + width, 0)
            # Indels can move the next copy slightly inside this envelope.
            if part:
                if part[0][2] - diagonal > start:
                    boundary = min(b[2] - diagonal for b in part)
                    part = clip_raw(part, '+', start, min(start + width, boundary), 0)
                else:
                    boundary = max(b[3] - diagonal for b in part)
                    part = clip_raw(part, '+', max(start, boundary), start + width, 0)
            if part and sum(b[1] - b[0] for b in part) >= minimum:
                out.append(make_chain(part, '+'))
    else:
        boundary = (c['template'][0] + c['window'][1] - diagonal) // 2
        for lo, hi, wl, wh in ((-math.inf, boundary, boundary + diagonal, math.inf), (boundary, math.inf, -math.inf, boundary + diagonal)):
            part = clip_raw(clip_raw(raw, '-', lo, hi, 0), '-', wl, wh, 2)
            if part and sum(b[1] - b[0] for b in part) >= minimum:
                out.append(make_chain(part, '-'))
    return out


def same_locus(a, b, size=None):
    """Overlapping physical bases on the same reference and contig, including circular turns."""
    return ((a.get('genome') or None) == (b.get('genome') or None) and a['chrom'] == b['chrom']
            and any(overlaps([a['start'], a['end']], [b['start'] + shift, b['end'] + shift])
                    for shift in ([0] if not size else [(round((a['start'] - b['start']) / size) + k) * size for k in (-1, 0, 1)])))


def sequence_hits(template, query, minimum=100, circular=False, max_indel=2000, circular_template=False, diagonal=None, self_match=False, identity=0.0, period=None):
    """minimap2 (asm20, both strands, secondary hits) of the window on the template, chained.

    A circular window (or template) covering a whole turn is aligned twice over, so a match
    across its origin stays one chain: its coordinates continue past the contig end."""
    if diagonal is not None and (diagonal != 0 or template != query):
        origin = min(0, -diagonal)
        ta, qa = -origin, -diagonal - origin
        union = ['N'] * max(ta + len(template), qa + len(query))
        union[ta:ta + len(template)] = template
        union[qa:qa + len(query)] = query
        sequence = ''.join(union)
        hits, count = sequence_hits(sequence, sequence, minimum, diagonal=0, identity=identity, max_indel=max_indel, period=period)
        clipped = []
        for c in hits:
            raw = [[*b['template'], *b['window'], round((b['template'][1] - b['template'][0]) * c['identity'])] for b in c['blocks']]
            raw = clip_raw(clip_raw(raw, c['strand'], ta, ta + len(template), 0), c['strand'], qa, qa + len(query), 2)
            if raw:
                hit = shift_chain(make_chain(raw, c['strand']), -ta, -qa)
                if hit['aligned'] >= minimum:
                    clipped.append(hit)
        return clipped, count
    from services.insertion_identify import minimap2_path
    binary = minimap2_path()
    if not binary:
        raise ValueError('Sequence blocks need minimap2. Untick Sequence blocks or install minimap2.')
    size_w, size_t = len(query), len(template)
    with tempfile.TemporaryDirectory(prefix='fb_sync_') as tmp:
        target, source = Path(tmp) / 'template.fa', Path(tmp) / 'window.fa'
        target.write_text('>sequence\n' + (template + template if circular_template else template).upper() + '\n')
        source.write_text(('>sequence\n' if diagonal is not None else '>window\n') + (query + query if circular else query).upper() + '\n')
        # All chains, including shorter copies hidden by the main alignment. Remove the
        # diagonal before chaining so it cannot swallow a repeat. Short seeds find N1-sized copies.
        repeat_options = ['-DP', '-k', '11', '-w', '5', '-m', '40', '-s', '80'] if diagonal is not None else []
        process = subprocess.run([binary, '-x', 'asm5' if diagonal is not None else 'asm20', '-c', '--eqx', '--secondary=yes', '-N', '100',
                                  '-p', '0.01', '-t', '1', *repeat_options, str(target), str(source)],
                                 capture_output=True, text=True, timeout=60, check=True)
    lines = parse_paf(process.stdout)
    if diagonal is not None:
        period = period or (size_t if circular_template and circular and size_t == size_w else None)
        lines = [(st, [b for b in bs if st != '+' or ((b[2] - b[0] - diagonal) % period if period else b[2] - b[0] - diagonal) != 0]) for st, bs in lines]
        lines = [(st, bs) for st, bs in lines if bs]
        # Separate local alignments are copies, not collinear pieces of one large repeat.
        chains = [c for line in lines for c in chain_hits([line], min(max_indel, 10), minimum)]
        chains = [part for c in chains for part in separate_copies(c, diagonal, minimum)]
        chains = [c for c in chains if not low_complexity((template * (2 if circular_template else 1))[c['template'][0]:c['template'][1]])
                  and not low_complexity((query * (2 if circular else 1))[c['window'][0]:c['window'][1]])]
        for c in chains:
            c['identity'] *= c['aligned'] / max(1, c['aligned'] + c['indels']['inserted'] + c['indels']['deleted'])
            c['score'] = c['identity']
        if self_match:
            chains = [c for c in chains if c['template'][0] < c['window'][0]]
        chains = dedupe(chains, None, None)
    else:
        chains = chain_hits(lines, max_indel, minimum, size_t if circular_template else None, size_w if circular else None)
    chains = [c for c in chains if c['identity'] >= identity]
    if circular or circular_template:
        normal = []
        for c in chains:
            dt = -size_t if circular_template and c['template'][0] >= size_t else 0
            dw = -size_w if circular and c['window'][0] >= size_w else 0
            c = shift_chain(c, dt, dw) if dt or dw else c
            if c['template'][1] - c['template'][0] > size_t or c['window'][1] - c['window'][0] > size_w:
                continue
            normal.append(c)
        chains = dedupe(normal, size_t if circular_template else None, size_w if circular else None)
    chains.sort(key=lambda c: c['aligned'] * c['identity'], reverse=True)
    return chains[:100], process.stdout.count('\n')


def dedupe(chains, size_t, size_w):
    """Drop a chain at least half of whose aligned bases map like a better chain's (modulo
    the contig on a doubled side): the doubled sequence finds every match twice, in part or
    rotated. Chains inside one turn on both sides are preferred."""
    def outside(c):
        return (bool(size_t) and c['template'][1] > size_t) + (bool(size_w) and c['window'][1] > size_w)
    def agreeing(c, k):
        best = 0
        for dt in ([0, size_t, -size_t] if size_t else [0]):
            total = 0
            for bc in c['blocks']:
                kc = block_key(dict(template=[bc['template'][0] + dt, bc['template'][1] + dt], window=bc['window']), c['strand'])
                for bk in k['blocks']:
                    lo, hi = max(bc['template'][0] + dt, bk['template'][0]), min(bc['template'][1] + dt, bk['template'][1])
                    if hi <= lo:
                        continue
                    d = kc - block_key(bk, k['strand'])
                    if (min(d % size_w, -d % size_w) if size_w else abs(d)) <= TOLERANCE:
                        total += hi - lo
            best = max(best, total)
        return best
    kept = []
    for c in sorted(chains, key=lambda c: (-c['aligned'], outside(c))):
        if not any(k['strand'] == c['strand'] and agreeing(c, k) >= 0.5 * c['aligned'] for k in kept):
            kept.append(c)
    return kept


def correlate(template, query, step=STEP, minimum=100, overlap=0.25):
    """Masked Pearson correlation over rigid offsets and both orientations, with separated alternatives."""
    curve = correlation_curve(template, query, step, minimum, overlap)
    kept = []
    for p in sorted(curve, key=lambda p: p['score'], reverse=True):
        if p['score'] <= 0:
            break
        if all(p['strand'] != k['strand'] or abs(transform(p) - transform(k)) > TOLERANCE for k in kept):
            kept.append(p)
        if len(kept) == 8:
            break
    return kept


def correlation_curve(template, query, step=STEP, minimum=100, overlap=0.25):
    a, b = np.asarray(template, dtype=float), np.asarray(query, dtype=float)
    out = []
    min_bins = max(5, minimum // step, int(min(len(a), len(b)) * overlap))
    for strand, oriented in [('+', b), ('-', b[::-1])]:
        for offset in range(-len(b) + min_bins, len(a) - min_bins + 1):
            lo, hi = max(0, offset), min(len(a), offset + len(b))
            r = pearson(a[lo:hi], oriented[lo - offset:hi - offset], min_bins)
            if r is None:
                continue
            qs, qe = (lo - offset) * step, (hi - offset) * step
            if strand == '-':
                qs, qe = len(b) * step - qe, len(b) * step - qs
            out.append(dict(template=[lo * step, hi * step], window=[qs, qe], strand=strand, score=r))
    return out


def pearson(x, y, min_bins=20):
    mask = np.isfinite(x) & np.isfinite(y)
    if mask.sum() < min_bins:
        return None
    x, y = x[mask] - x[mask].mean(), y[mask] - y[mask].mean()
    denom = np.linalg.norm(x) * np.linalg.norm(y)
    return None if denom < 1e-9 else float(np.dot(x, y) / denom)


def profile_alone(template, query, minimum, min_r=0.4, min_z=5.0):
    """The whole-window profile shift per strand, only when it is both strong and distinct.
    These proposals are rigid (one offset): without an alignment they cannot follow indels."""
    curve = correlation_curve(template, query, STEP, minimum, overlap=0.5)
    if len(curve) < 20:
        return [], None
    scores = np.array([p['score'] for p in curve])
    median = float(np.median(scores)); mad = float(np.median(np.abs(scores - median))) * 1.4826 or 1e-6
    best = {}
    for p in curve:
        if p['score'] > best.get(p['strand'], {'score': -2})['score']:
            best[p['strand']] = p
    out = []
    for p in best.values():
        z = (p['score'] - median) / mad
        if p['score'] >= min_r and z >= min_z:
            out.append(dict(p, z=z))
    top = max(best.values(), key=lambda p: p['score'])
    return out, dict(r=round(top['score'], 3), z=round((top['score'] - median) / mad, 1))


def bin_pairs(c, n_a, n_b, wrap_a=False, wrap_b=False, span=LOCAL_SPAN):
    """Template and window profile bins that correspond along ``c``'s block map, over its
    extent widened to ``span`` (the end blocks' offsets extend it). Template bins inside
    an indel gap have no partner; window insertions are skipped."""
    blocks, strand = blocks_of(c), c['strand']
    centre = (c['template'][0] + c['template'][1]) / 2
    half = max(c['template'][1] - c['template'][0], span) / 2
    lo, hi = centre - half, centre + half
    if not wrap_a:
        lo, hi = max(0, lo), min(n_a * STEP, hi)
    t = np.arange(math.floor(lo / STEP), math.ceil(hi / STEP)) * STEP + STEP // 2
    w = np.full(len(t), np.nan)
    def place(mask, b):
        w[mask] = b['window'][0] + (t[mask] - b['template'][0]) if strand == '+' else b['window'][1] - 1 - (t[mask] - b['template'][0])
    for b in blocks:
        place((t >= b['template'][0]) & (t < b['template'][1]), b)
    place(t < blocks[0]['template'][0], blocks[0])
    place(t >= blocks[-1]['template'][1], blocks[-1])
    keep = np.isfinite(w)
    return (np.floor(t[keep] / STEP)).astype(int), (np.floor(w[keep] / STEP)).astype(int)


def local_profile(a, b, c, wrap_a=False, wrap_b=False, span=LOCAL_SPAN, search=LOCAL_SEARCH):
    """r along the candidate's block map, and the best r with the window shifted by up
    to ±``search`` bp: a profile supports a candidate it peaks at."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    ia, jb = bin_pairs(c, len(a), len(b), wrap_a, wrap_b, span)
    if wrap_a:
        ia = ia % len(a)
    valid_a = (ia >= 0) & (ia < len(a))
    results = []
    for d in range(-search // STEP, search // STEP + 1):
        j = jb + d
        if wrap_b:
            j = j % len(b)
        valid = valid_a & (j >= 0) & (j < len(b))
        r = pearson(a[ia[valid]], b[j[valid]], 20) if valid.sum() >= 20 else None
        results.append((d * STEP, r))
    at = dict(results).get(0)
    scored = [(d, r) for d, r in results if r is not None]
    if at is None or not scored:
        return None
    shift, best = max(scored, key=lambda x: x[1])
    return dict(r=round(at, 3), best=round(best, 3), shift=shift)


def profiles(reads, width, sample_seed='region-sync'):
    """Panel working-set intervals are relative to the requested window; uncovered positions stay masked."""
    from services.coaccessibility import _add_interval_bp, interval_matches_signal
    from services.read_metrics import get_layer_intervals, sample_stable_by_id
    n = max(1, int(math.ceil(width / STEP)))
    coverage = []
    for read in reads:
        # Merge primary coverage intervals so deletions/uncovered holes cannot count as covered.
        merged = []
        for a, b, _ in sorted(read.get('intervals', [])):
            if merged and a <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], int(b))
            else: merged.append([int(a), int(b)])
        coverage.append(merged)
    sampled = reads if len(reads) <= MAX_PROFILE_READS else sample_stable_by_id(reads, MAX_PROFILE_READS, seed=sample_seed)
    sums, counts, nuc_sums = np.zeros(n), np.zeros(n), np.zeros(n)
    units = []
    for read in sampled:
        total, accessible, occupied = np.zeros(n), np.zeros(n), np.zeros(n)
        ivs = read.get('intervals', [])
        for a, b, size in ivs:
            args = dict(bin_size=STEP, n_bins=n, region_width=n * STEP)
            _add_interval_bp(total, a, b, **args)
            if interval_matches_signal(size, 'accessibility'):
                _add_interval_bp(accessible, a, b, **args)
        nuc = [(int(a), int(b)) for a, b, size in get_layer_intervals(read, 'nuc') if size >= 90 or b - a >= 90]
        if not nuc: nuc = [(int(a), int(b)) for a, b, size in ivs if size >= 90]
        for a, b in nuc:
            _add_interval_bp(occupied, a, b, bin_size=STEP, n_bins=n, region_width=n * STEP)
        mask = total > 0
        sums[mask] += accessible[mask] / total[mask]; counts += mask
        nuc_sums[mask] += np.minimum(1, occupied[mask] / total[mask])
        units.append({'raw_nuc_intervals': nuc})
    acc = np.divide(sums, counts, out=np.full(n, np.nan), where=counts > 0)
    occupancy = np.divide(nuc_sums, counts, out=np.full(n, np.nan), where=counts > 0)
    try:
        from fiberhmm.inference.accessibility.gaps import nfr_profile
        _, cov, _, nfr = nfr_profile(units, 0, n * STEP, step=STEP)
    except ImportError:
        x = np.arange(n) * STEP; cov, hits = np.zeros(n), np.zeros(n)
        for u in units:
            nuc = sorted(u['raw_nuc_intervals'])
            if not nuc: continue
            cov += (x >= nuc[0][0]) & (x < nuc[-1][1])
            for (_, b), (a, _) in zip(nuc, nuc[1:]):
                if a - b >= 175: hits += (x >= b) & (x < a)
        nfr = hits / np.maximum(cov, 1)
    nfr = np.asarray(nfr, dtype=float)
    nfr[np.asarray(cov) == 0] = np.nan
    return {'accessibility': acc, 'nfr': nfr, 'nuc': occupancy, 'depth': counts}, coverage



SHAPE_CHANNELS = ('accessibility', 'nfr', 'nuc')
SHAPE_NULLS = 12
SHAPE_STRIDE = 10            # bins (100 bp) between seeds
SHAPE_MIN_COVERED = 0.8      # share of a seed's bins that must be covered in both windows


def shape_channels(signals):
    """Per-channel z-scores within the window, NaN where few reads cover it (amplicon edges and
    thin stretches would otherwise match each other by their coverage alone); flat channels
    left out."""
    out = {}
    depth = np.asarray(signals.get('depth', []), dtype=float)
    floor = max(10.0, 0.25 * float(np.median(depth[depth > 0]))) if (depth > 0).any() else 0.0
    for name in SHAPE_CHANNELS:
        x = np.asarray(signals.get(name, []), dtype=float)
        if len(depth) == len(x) and floor:
            x = np.where(depth >= floor, x, np.nan)
        m = np.isfinite(x)
        if m.sum() < 30 or np.nanstd(x) < 1e-6:
            continue
        out[name] = np.where(m, (x - np.nanmean(x)) / np.nanstd(x), np.nan)
    return out


def nfr_peaks(nfr, min_value=0.15, separation=30):
    """NFR landmarks: local maxima of the >=175-bp gap fraction, highest first, kept apart."""
    x = np.nan_to_num(np.asarray(nfr, dtype=float), nan=0.0)
    if len(x) < 5:
        return []
    smooth = np.convolve(x, np.ones(5) / 5, mode='same')
    floor = max(min_value, float(np.quantile(smooth, 0.9)))
    order = [i for i in np.argsort(-smooth) if smooth[i] >= floor]
    peaks = []
    for i in order:
        if all(abs(i - j) >= separation for j in peaks):
            peaks.append(int(i))
    return peaks


def _rows(windows):
    """Centre and scale rows to unit norm (zero rows stay zero)."""
    centred = windows - windows.mean(axis=1, keepdims=True)
    norm = np.linalg.norm(centred, axis=1, keepdims=True)
    return np.divide(centred, norm, out=np.zeros_like(centred), where=norm > 1e-9), norm[:, 0] > 1e-9


def _surrogate(chs, rng):
    """A phase-randomised copy of a window's channels: the same random phases for every
    channel keep each one's autocorrelation (power spectrum) and their cross-dependence,
    while any particular arrangement of elements is gone."""
    names = list(chs)
    n = len(chs[names[0]])
    phases = np.exp(2j * np.pi * rng.random(n // 2 + 1))
    phases[0] = 1
    if n % 2 == 0:
        phases[-1] = 1
    return {c: np.fft.irfft(np.fft.rfft(chs[c]) * phases, n) for c in names}


def _scramble(chs, block, rng):
    """Segment-shuffle a window's channels together: blocks in random order, half reversed."""
    n = len(next(iter(chs.values())))
    cuts = list(range(0, n, block))
    order = rng.permutation(len(cuts))
    flips = rng.random(len(cuts)) < .5
    idx = np.concatenate([np.arange(cuts[k], min(n, cuts[k] + block))[::-1 if flips[k] else 1] for k in order])
    return {name: x[idx] for name, x in chs.items()}


def shape_match(a_sig, b_sig, th, seed=0, diagonal=None):
    """Local chromatin-shape seeds: B segments (several widths, every SHAPE_STRIDE bins and
    centred on B's NFR peaks) against every A position on both strands by multi-channel
    normalised cross-correlation; z against the best match in segment-shuffled copies of A.
    Hits above the thresholds chain (same strand and offset, overlapping) into blocks."""
    a, b = shape_channels(a_sig), shape_channels(b_sig)
    names = [c for c in SHAPE_CHANNELS if c in a and c in b]
    if not names:
        return [], dict(channels=[], hits=0)
    na, nb = len(a[names[0]]), len(b[names[0]])
    base = max(5, int(th['shapeWidth']) // STEP)
    rng = np.random.default_rng(seed)
    a_peaks, b_peaks = nfr_peaks(a_sig.get('nfr', [])), nfr_peaks(b_sig.get('nfr', []))
    covered_a = np.mean([np.isfinite(a[c]) for c in names], axis=0)
    covered_b = np.mean([np.isfinite(b[c]) for c in names], axis=0)
    hits, best_seen = [], dict(r=-1.0, z=-99.0)
    filled_a = {c: np.nan_to_num(a[c]) for c in names}
    scale = 1 / np.sqrt(len(names))
    for w in (base, 2 * base, 4 * base):
        if w > min(na, nb):
            continue
        # Null: phase-randomised copies of A (autocorrelation and channel dependence kept).
        nulls = [_surrogate(filled_a, rng) for _ in range(SHAPE_NULLS)]
        # Longer seeds overlap more at one stride: step a sixth of the seed (at least SHAPE_STRIDE).
        starts = sorted(set(range(0, nb - w + 1, max(SHAPE_STRIDE, w // 6))) | {min(nb - w, max(0, p - w // 2)) for p in b_peaks})
        win = lambda x: np.lib.stride_tricks.sliding_window_view(x, w)
        ok_a = win(covered_a).mean(axis=1) >= SHAPE_MIN_COVERED
        ok_b = np.array([covered_b[s:s + w].mean() >= SHAPE_MIN_COVERED for s in starts])
        if not ok_b.any() or not ok_a.any():
            continue
        # Channels side by side, each row unit-normalised per channel: a dot product is the mean channel r.
        stack = lambda chs: np.concatenate([_rows(win(chs[c]))[0] for c in names], axis=1) * scale
        segs = {c: np.stack([np.nan_to_num(b[c][s:s + w]) for s in starts]) for c in names}
        B = {'+': np.concatenate([_rows(segs[c])[0] for c in names], axis=1) * scale,
             '-': np.concatenate([_rows(segs[c][:, ::-1])[0] for c in names], axis=1) * scale}
        A = stack(filled_a)[ok_a]
        null_best = []
        for n in nulls:
            An = stack(n)[ok_a]
            null_best.append(np.maximum((B['+'] @ An.T).max(axis=1), (B['-'] @ An.T).max(axis=1)))
        null_best = np.stack(null_best)
        mu = null_best.mean(axis=0)
        sd = np.maximum(null_best.std(axis=0), max(float((null_best - mu).std()), 1e-3))
        # Family-wise guard: a match must also beat every seed's best match in every null
        # copy of this width (hundreds of seed x replicate maxima), so searching many seeds
        # does not by itself produce matches.
        ceiling = float(null_best[:, ok_b].max()) if ok_b.any() else 1.0
        positions = np.flatnonzero(ok_a)
        for strand in '+-':
            m = B[strand] @ A.T
            if diagonal is not None:
                offsets = np.array(starts)[:, None] * STEP - positions[None, :] * STEP
                m[np.abs(offsets - diagonal) < th['shapeWidth']] = -np.inf
            arg = m.argmax(axis=1)
            r = m[np.arange(len(starts)), arg]
            z = (r - mu) / sd
            for k, s0 in enumerate(starts):
                if not ok_b[k] or not np.isfinite(r[k]):
                    continue
                if z[k] > best_seen['z']:
                    best_seen = dict(r=round(float(r[k]), 3), z=round(float(z[k]), 1))
                if r[k] >= th['shapeMinR'] and z[k] >= th['shapeMinZ'] and r[k] > ceiling:
                    a0 = int(positions[arg[k]])
                    near = lambda peaks, lo: next((p for p in peaks if lo <= p < lo + w and abs(p - (lo + w // 2)) <= max(10, w // 4)), None)
                    pa, pb = near(a_peaks, a0), near(b_peaks, s0)
                    paired = pa is not None and pb is not None
                    # Without an NFR landmark on both sides a match needs to stand out more (z + 2).
                    if not paired and z[k] < th['shapeMinZ'] + 2:
                        continue
                    hits.append(dict(template=[a0 * STEP, (a0 + w) * STEP], window=[s0 * STEP, (s0 + w) * STEP], strand=strand,
                                     score=float(r[k]), r=float(r[k]), z=float(z[k]),
                                     nfr=[pa * STEP, pb * STEP] if paired else None))
    blocks = chain_shape(hits, na * STEP, nb * STEP)
    landmarks = nfr_landmarks(a, b, names, a_peaks, b_peaks, base, diagonal)
    if th.get('shapeLandmarks'):
        taken = [blk for blk in blocks]
        for lm in landmarks:
            if lm['r'] >= th['shapeMinR'] and not any(blk['strand'] == lm['strand'] and abs(transform(blk) - transform(lm)) <= TOLERANCE for blk in taken):
                blocks.append(dict(lm, metric='shape', landmark=True, seeds=1))
                taken.append(lm)
    for blk in blocks:
        blk['channels'] = names
    return blocks, dict(channels=names, hits=len(hits), blocks=len(blocks), best=best_seen,
                        nfrPeaks=[len(a_peaks), len(b_peaks)],
                        landmarks=[dict(template=lm['nfr'][0], window=lm['nfr'][1], strand=lm['strand'], r=lm['r'], z=lm['z']) for lm in landmarks[:6]])


def nfr_landmarks(a, b, names, a_peaks, b_peaks, base, diagonal=None):
    """For each NFR of window B, the NFR of A whose surrounding multi-channel profile matches
    best (either strand, 1x and 2x the seed width), with z against matching that stretch of B
    anywhere in A. NFRs resemble one another in general, so these are landmark hypotheses."""
    out = []
    na, nb = len(a[names[0]]), len(b[names[0]])
    scale = 1 / np.sqrt(len(names))
    best_by_peak = {}
    for w in (base, 2 * base):
        if w > na or w > nb:
            continue
        A = np.concatenate([_rows(np.lib.stride_tricks.sliding_window_view(np.nan_to_num(a[c]), w))[0] for c in names], axis=1) * scale
        for pb in b_peaks:
            lo_b = pb - w // 2
            if lo_b < 0 or lo_b + w > nb:
                continue
            for strand in '+-':
                seg = np.concatenate([_rows((np.nan_to_num(b[c][lo_b:lo_b + w]) if strand == '+' else np.nan_to_num(b[c][lo_b:lo_b + w])[::-1])[None, :])[0][0] for c in names]) * scale
                curve = A @ seg
                med = float(np.median(curve)); mad = float(np.median(np.abs(curve - med))) * 1.4826 or 1e-3
                for pa in a_peaks:
                    lo_a = pa - w // 2
                    if diagonal is not None and abs((lo_b - lo_a) * STEP - diagonal) < base * STEP:
                        continue
                    if lo_a < 0 or lo_a + w > na:
                        continue
                    r = float(curve[lo_a])
                    best = best_by_peak.get(pb)
                    if best is None or r > best['r']:
                        best_by_peak[pb] = dict(template=[lo_a * STEP, (lo_a + w) * STEP], window=[lo_b * STEP, (lo_b + w) * STEP], strand=strand,
                                                r=round(r, 3), score=round(r, 3), z=round((r - med) / mad, 1), nfr=[pa * STEP, pb * STEP])
    out = list(best_by_peak.values())
    return sorted(out, key=lambda lm: -lm['r'])


def chain_shape(hits, wt, ww, gap=100):
    """Hits with one strand and offset (within TOLERANCE) whose template stretches overlap or
    nearly touch become one block. The best seed's offset defines the block: the template
    stretch grows and the window stretch follows it under that one mapping."""
    blocks = []
    for h in sorted(hits, key=lambda h: -h['z']):
        for blk in blocks:
            if (blk['strand'] == h['strand'] and abs(blk['key'] - transform(h)) <= TOLERANCE
                    and h['template'][0] <= blk['template'][1] + gap and blk['template'][0] <= h['template'][1] + gap):
                blk['template'] = [min(blk['template'][0], h['template'][0]), max(blk['template'][1], h['template'][1])]
                blk['seeds'] += 1
                if h['nfr'] and not blk['nfr']:
                    blk['nfr'] = h['nfr']
                break
        else:
            blocks.append(dict(h, metric='shape', seeds=1, key=transform(h)))
    out = []
    for blk in blocks:
        key = blk.pop('key')
        tpl = [max(0, blk['template'][0]), min(wt, blk['template'][1])]
        win = to_window(tpl, blk['strand'], key)
        lo, hi = max(0, win[0]), min(ww, win[1])
        if hi - lo < 50:
            continue
        # Clip the window side and carry the clip back to the template under the same mapping.
        tpl = [tpl[0] + (lo - win[0]), tpl[1] - (win[1] - hi)] if blk['strand'] == '+' else [tpl[0] + (win[1] - hi), tpl[1] - (lo - win[0])]
        out.append(dict(blk, template=tpl, window=[lo, hi], score=round(blk['r'], 3), r=round(blk['r'], 3), z=round(blk['z'], 1)))
    return sorted(out, key=lambda b: -b['z'])[:12]


def merge_candidates(candidates):
    """Sequence chains and anchors stay as they are. A rigid profile shift that matches one
    of them is its support (scored along its blocks), not a second proposal; profile
    shifts with the same offset and overlapping extents merge."""
    anchored = [c for c in candidates if c['metric'] in ('sequence', 'anchor')]
    merged = [dict(c, sources=[c['metric']]) for c in anchored]
    for c in sorted((c for c in candidates if c['metric'] not in ('sequence', 'anchor')), key=lambda c: c['template'][0]):
        if any(a['strand'] == c['strand'] and any(abs(block_key(b, a['strand']) - transform(c)) <= TOLERANCE
                                                  and (c['metric'] != 'shape' or overlaps(b['template'], c['template'])) for b in blocks_of(a)) for a in anchored):
            continue
        for m in merged:
            if (m['metric'] not in ('sequence', 'anchor') and (m['metric'] == 'shape') == (c['metric'] == 'shape')
                    and m['strand'] == c['strand'] and abs(transform(m) - transform(c)) <= TOLERANCE
                    and c['template'][0] < m['template'][1] and m['template'][0] < c['template'][1]):
                key = transform(m)
                m['template'] = [min(m['template'][0], c['template'][0]), max(m['template'][1], c['template'][1])]
                m['window'] = to_window(m['template'], m['strand'], key)
                m['sources'] = sorted(set(m['sources']) | {c['metric']})
                m['score'] = max(m['score'], c['score'])
                break
        else:
            merged.append(dict(c, sources=[c['metric']]))
    return merged


def agreeing_bp(c, chains, identity=0.0, same=True):
    """Template bases of ``c`` covered by chain blocks that map like ``c`` (``same``) or
    elsewhere (not ``same``), counting chains of at least ``identity``."""
    picked = []
    for h in chains:
        if h is c or h.get('identity', 1) < identity:
            continue
        for blk in blocks_of(h):
            if not overlaps(blk['template'], c['template']):
                continue
            mid = (max(blk['template'][0], c['template'][0]) + min(blk['template'][1], c['template'][1])) // 2
            agrees = h['strand'] == c['strand'] and abs(map_point(dict(h, blocks=[blk]), mid) - map_point(c, mid)) <= TOLERANCE
            if agrees == same:
                picked.append(blk['template'])
    return union_bp(picked, c['template'])


def assess(candidate, evidence, signals, metrics, th, wrap=(False, False)):
    """Score every requested metric along the candidate's own block map.

    Verdicts: supports, disagrees (a confident answer elsewhere for this stretch),
    weak (assessed, not supporting) or abstains (cannot assess)."""
    out = {}
    extent = max(1, candidate['template'][1] - candidate['template'][0])
    for metric in metrics:
        if metric == 'sequence':
            chains = evidence.get('sequence')
            if chains is None:
                out[metric] = dict(verdict='abstains', score=None, why='no sequence for one of the windows')
                continue
            if candidate['metric'] == 'sequence':
                share, identity = candidate['aligned'] / extent, candidate['identity']
            else:
                share = agreeing_bp(candidate, chains) / extent
                same = [h for h in chains if overlaps(h['template'], candidate['template'])]
                identity = max((h['identity'] for h in same), default=None)
            elsewhere = agreeing_bp(candidate, chains, identity=.8, same=False) / extent if candidate['metric'] != 'sequence' else 0
            if share >= th['sequenceCover'] and identity is not None:
                out[metric] = dict(verdict='supports', score=round(identity, 3), share=round(min(1, share), 3),
                                   **({'why': f'aligned over {share:.0%} of it'} if share < .95 else {}))
            elif elsewhere >= th['sequenceCover']:
                out[metric] = dict(verdict='disagrees', score=0.0, why='this template stretch aligns elsewhere')
            elif share > 0:
                out[metric] = dict(verdict='weak', score=round(identity or 0, 3), share=round(share, 3), why=f'shared sequence covers only {share:.0%} of it')
            else:
                out[metric] = dict(verdict='weak', score=0.0, why='no shared sequence here')
        elif metric == 'anchor':
            anchor = evidence.get('anchor')
            if not anchor:
                out[metric] = dict(verdict='abstains', score=None, why='no anchors')
                continue
            at = anchor['at']
            if anchor['strand'] == candidate['strand'] and abs(map_point(candidate, at) - map_point(anchor, at)) <= TOLERANCE:
                out[metric] = dict(verdict='supports', score=1.0)
            else:
                out[metric] = dict(verdict='disagrees', score=0.0, why='the anchors imply another offset or strand')
        elif metric == 'shape':
            a, b = signals
            ca, cb = shape_channels(a), shape_channels(b)
            names = [c for c in SHAPE_CHANNELS if c in ca and c in cb]
            # Along the candidate's own extent (no widening): the local match itself.
            locals_ = [local_profile(ca[c], cb[c], candidate, *wrap, span=0) for c in names]
            locals_ = [l for l in locals_ if l]
            if not locals_:
                out[metric] = dict(verdict='abstains', score=None, why='too little coverage for a local shape')
                continue
            r = round(float(np.mean([l['r'] for l in locals_])), 3)
            best = round(float(np.mean([l['best'] for l in locals_])), 3)
            shift = int(np.median([l['shift'] for l in locals_]))
            far = abs(shift) > TOLERANCE and best - r >= .15
            verdict = ('disagrees' if far and best >= th['shapeMinR'] else 'supports' if r >= th['shapeMinR'] else 'weak')
            out[metric] = dict(verdict=verdict, score=r, best=best, shift=shift, channels=names,
                               **({'z': candidate['z']} if candidate.get('metric') == 'shape' else {}),
                               **({'why': f'peaks {shift:+d} bp away (r {best:.2f})'} if verdict == 'disagrees' else {}))
        else:
            a, b = signals
            local = local_profile(a[metric], b[metric], candidate, *wrap)
            if local is None:
                out[metric] = dict(verdict='abstains', score=None, why='flat or uncovered profile')
                continue
            r, best, shift = local['r'], local['best'], local['shift']
            far = abs(shift) > TOLERANCE and best - r >= .15
            verdict = ('disagrees' if far and best >= th['profileSupport'] else
                       'supports' if r >= th['profileSupport'] else 'weak')
            out[metric] = dict(verdict=verdict, score=r, best=best, shift=shift,
                               **({'why': f'peaks {shift:+d} bp away (r {best:.2f})'} if verdict == 'disagrees' else {}))
    return out


def overlaps(a, b):
    return min(a[1], b[1]) > max(a[0], b[0])


def support_value(metric, assessment):
    """0–1 support: sequence identity times the share it covers; anchor 1/0; profile r scaled 0.1→0 to 0.6→1."""
    s = assessment.get('score')
    if s is None: return None
    if metric in ('accessibility', 'nfr', 'shape'):
        return float(min(1, max(0, (s - .1) / .5)))
    if metric == 'sequence':
        return 0.0 if assessment['verdict'] != 'supports' else float(s) * float(assessment.get('share', 1))
    return float(s)


def summarise(candidate, metrics):
    """Status and confidence from the per-metric verdicts (explained in the panel)."""
    verdicts = candidate['metrics']
    assessed = [m for m in metrics if verdicts[m]['verdict'] != 'abstains']
    supports = [m for m in assessed if verdicts[m]['verdict'] == 'supports']
    disagree = [m for m in assessed if verdicts[m]['verdict'] == 'disagrees']
    weight = sum(WEIGHTS[m] for m in assessed)
    confidence = sum(WEIGHTS[m] * (support_value(m, verdicts[m]) or 0) for m in assessed) / weight if weight else 0
    # Accessibility, NFR shape and local chromatin shape read the same reads: together they are
    # one line of evidence, so agreement needs sequence or an anchor as well.
    families = {('chromatin' if m in ('accessibility', 'nfr', 'shape') else m) for m in supports}
    status = ('disagreement' if supports and disagree else 'agreement' if len(families) >= 2 else
              'single-metric' if supports else 'weak')
    return dict(status=status, confidence=round(confidence, 3), supports=len(supports), assessed=len(assessed),
                disagree=len(disagree))


def contradicted_by_sequence(candidate, chains, identity=0.9, cover=0.5):
    """Sequence is the strong default: a profile-only shift is dropped when near-identical
    sequence places at least ``cover`` of its template stretch elsewhere."""
    return agreeing_bp(candidate, chains, identity=identity, same=False) >= cover * (candidate['template'][1] - candidate['template'][0])


def union_bp(intervals, within):
    """Bases of ``within`` covered by the union of ``intervals``."""
    total, end = 0, within[0]
    for a, b in sorted((max(a, within[0]), min(b, within[1])) for a, b in intervals):
        if b <= a: continue
        total += max(0, b - max(a, end)); end = max(end, b)
    return total


def anchor_candidate(template, window):
    a, b = template['anchor'], window['anchor']
    reverse = a.get('strand', '+') != b.get('strand', '+')
    ta, wa = a['position'] - template['start'], b['position'] - window['start']
    tw, ww = template['end'] - template['start'], window['end'] - window['start']
    if reverse:
        lo, hi = max(0, ta + wa + 1 - ww), min(tw, ta + wa + 1)
        qs, qe = ta + wa + 1 - hi, ta + wa + 1 - lo
    else:
        lo, hi = max(0, ta - wa), min(tw, ta + ww - wa)
        qs, qe = lo + wa - ta, hi + wa - ta
    return dict(template=[lo, hi], window=[qs, qe], strand='-' if reverse else '+', score=1.0, metric='anchor', at=ta)


def compare_pair(a, b, wa, wb, metrics, th):
    """Candidates for window ``b`` against partner ``a`` (coordinates relative to each window start)."""
    if not isinstance(th, dict):
        th = thresholds({'minimum': th})
    evidence, log = {}, {}
    period = a.get('circular') if a.get('circular') == b.get('circular') else None
    diagonal = wa['start'] - wb['start'] if same_locus(wa, wb, period) else None
    if diagonal is not None and period:
        diagonal -= round(diagonal / period) * period
    self_match = wa['panelId'] == wb['panelId']
    circ_a = a.get('circular') if a.get('whole') else None
    circ_b = b.get('circular') if b.get('whole') else None
    if 'sequence' in metrics:
        from services.insertion_identify import minimap2_path
        if a['sequence'] and b['sequence'] and not minimap2_path():
            evidence['sequence'] = None
            log['sequence'] = dict(missing='minimap2')
        elif a['sequence'] and b['sequence']:
            chains, lines = sequence_hits(a['sequence'], b['sequence'], th['minimum'], circular=bool(circ_b),
                                          max_indel=th['maxIndel'], circular_template=bool(circ_a),
                                          diagonal=diagonal, self_match=self_match, identity=th['sequenceIdentity'], period=period)
            evidence['sequence'] = chains
            log['sequence'] = dict(paf=lines, chains=len(chains),
                                   top=[dict(template=h['template'], window=h['window'], strand=h['strand'], blocks=len(h['blocks']),
                                             identity=round(h['identity'], 3), indels=h['indels']) for h in chains[:6]])
        else:
            evidence['sequence'] = None
            log['sequence'] = dict(missing='sequence', template=bool(a['sequence']), window=bool(b['sequence']))
    if 'anchor' in metrics and wa.get('anchor') and wb.get('anchor'):
        evidence['anchor'] = anchor_candidate(wa, wb)
    candidates = [dict(h) for h in evidence.get('sequence') or []]
    if evidence.get('anchor'):
        candidates.append(dict(evidence['anchor']))
    wt, ww = wa['end'] - wa['start'], wb['end'] - wb['start']
    for metric in ('accessibility', 'nfr'):
        if metric in metrics:
            alone, best = profile_alone(a['signals'][metric], b['signals'][metric], th['minimum'], th['profileAloneR'], th['profileAloneZ'])
            log[metric] = dict(best=best, proposed=len(alone))
            for p in alone:
                # Bin rounding can reach past a window end by under one bin.
                candidates.append(dict(p, metric=metric, template=[max(0, p['template'][0]), min(wt, p['template'][1])],
                                       window=[max(0, p['window'][0]), min(ww, p['window'][1])]))
    if 'shape' in metrics:
        t = time.perf_counter()
        blocks, shape_log = shape_match(a['signals'], b['signals'], th, diagonal=diagonal)
        shape_log['seconds'] = round(time.perf_counter() - t, 2)
        log['shape'] = shape_log
        candidates += blocks
    out, suppressed = [], 0
    for c in merge_candidates(candidates):
        if sum(b['template'][1] - b['template'][0] for b in blocks_of(c)) < th['minimum']:
            continue
        if diagonal is not None:
            if c['strand'] == '+' and all(block_key(blk, '+') == diagonal for blk in blocks_of(c)):
                continue
            if c['metric'] != 'sequence' and abs(c['window'][0] - c['template'][0] - diagonal) < th['shapeWidth']:
                continue
            if self_match and c['template'][0] >= c['window'][0]:
                continue
            c.setdefault('flags', []).append('internal-repeat')
        if c['metric'] in ('accessibility', 'nfr') and contradicted_by_sequence(c, evidence.get('sequence') or [], cover=th['sequenceCover']):
            suppressed += 1
            continue
        if c['metric'] == 'shape' and contradicted_by_sequence(c, evidence.get('sequence') or [], cover=th['sequenceCover']):
            c.setdefault('flags', []).append('contradicted-by-sequence')
        c['metrics'] = assess(c, evidence, (a['signals'], b['signals']), metrics, th, (bool(circ_a), bool(circ_b)))
        c.update(summarise(c, metrics))
        crosses = ([] if not circ_a or 0 <= c['template'][0] and c['template'][1] <= wt else ['template']) + \
                  ([] if not circ_b or 0 <= c['window'][0] and c['window'][1] <= ww else ['window'])
        if crosses:
            c.setdefault('flags', []).append('crosses-origin')
            c['crosses'] = crosses
        if c.get('indels') and (c['indels']['inserted'] or c['indels']['deleted']):
            c.setdefault('flags', []).append('indels')
        if c['metric'] != 'sequence':
            c['rigid'] = True
        if 'sequence' not in c['sources'] and c['metrics'].get('sequence', {}).get('verdict') != 'supports' and 'shape' in c['sources']:
            c.setdefault('flags', []).append('chromatin-only')
        c.pop('at', None)
        out.append(c)
    if suppressed:
        log['suppressed'] = suppressed
    # A template stretch matched in several places (copies): say so on each.
    for c in out:
        twins = [o for o in out if o is not c and o['metric'] == 'sequence' and c['metric'] == 'sequence'
                 and overlaps(o['template'], c['template']) and agreeing_bp(c, [o], same=False) > 0]
        if twins:
            c.setdefault('flags', []).append('repeat')
            c['alternatives'] = len(twins)
    rank = {'agreement': 0, 'single-metric': 1, 'disagreement': 2, 'weak': 3}
    out.sort(key=lambda c: (rank[c['status']], -c['confidence'], -(c['template'][1] - c['template'][0])))
    return out, log


def _window_key(w):
    ids = w.get('readIds')
    return (w['datasetId'], w.get('genome'), w['chrom'], w['start'], w['end'], w.get('readStrand'),
            None if ids is None else hash(tuple(sorted(ids))))


def fetch_sequence(view, chrom, start, end, circular_size):
    fasta = getattr(view, 'fasta', None)
    if not fasta:
        return None
    try:
        from utils.chrom import resolve_reference_name
        ref = resolve_reference_name(chrom, fasta.references, getattr(view, 'chrom_map', None))
        if ref is None:
            return None
        if circular_size:
            from services.circular_genome import circular_view_segments
            return ''.join(str(fasta.fetch(ref, s.ref_start, s.ref_end)) for s in circular_view_segments(start, end, circular_size))
        return str(fasta.fetch(ref, start, end))
    except (KeyError, ValueError):
        return None


def load_window(state, w, need_sequence):
    """Profiles, per-read coverage and sequence for one window, cached per session."""
    from services.panel_genomes import genome_view, dataset_genome
    from services.analysis_query import AnalysisReadQuery
    from services.circular_genome import circular_chrom_size
    from utils.chrom import resolve_reference_name
    reference = w.get('genome') or None
    if reference == getattr(state, 'current_genome', None): reference = None
    if dataset_genome(state, w['datasetId']) != reference:
        raise ValueError(f"{w['panelId']}: dataset reference changed; refresh the panel and search again.")
    view = genome_view(state, w.get('genome'))
    lengths = {c['name'] if isinstance(c, dict) else c.name:
               c['size'] if isinstance(c, dict) else c.size for c in (getattr(view, 'chroms', None) or [])}
    ref = resolve_reference_name(w['chrom'], lengths, getattr(view, 'chrom_map', None))
    circular = circular_chrom_size(view, ref or w['chrom']) if lengths else None
    width = w['end'] - w['start']
    if circular:
        if width > circular or w['start'] < 0 or w['end'] > 2 * circular:
            raise ValueError(f"{w['panelId']}: on a circular contig keep the window at most one turn ({circular:,} bp).")
    elif lengths and (ref is None or w['end'] > lengths[ref]):
        raise ValueError(f"{w['panelId']}: keep the window within chromosome bounds.")
    # Validated first; the key follows topology, read-loading settings and the loaded dataset object.
    cache = state.__dict__.setdefault('_region_sync_windows', shared_cache('profiles'))
    try:
        from services.working_sets import read_load_token
        loading = read_load_token(view, ref or w['chrom'])
    except Exception:  # pragma: no cover - a state without read-loading settings
        loading = None
    from services.dataset_generation import dataset_generation
    def population():
        return dataset_generation(state, w['datasetId']), int(getattr(view, 'max_working_reads', 0) or 0)
    population_key = population()
    key = (*_window_key(w), circular, loading, population_key,
           id((getattr(state, 'datasets', None) or {}).get(w['datasetId'])))
    if key in cache and (cache[key]['sequence'] is not None or not need_sequence):
        cache.move_to_end(key)
        return cache[key], True
    query = AnalysisReadQuery.from_request(view, chrom=w['chrom'], start=w['start'], end=w['end'],
                dataset_id=w['datasetId'], read_ids=w.get('readIds'), strand_by_dataset={w['datasetId']: w.get('readStrand')})
    if query.dataset_ids != [w['datasetId']]:
        raise ValueError(f"Dataset {w['datasetId']} is no longer loaded. Reopen it and search again.")
    # Interval geometry and the nucleosome layer are all the profiles need; skipping
    # deamination parsing is most of the load time.
    ws = query.build_working_set(view, w['datasetId'], include_methylation=bool(w.get('readStrand')),
                                 requested_layers=('nuc',), include_layer_qualities=False, broad_prefetch_multiplier=1)
    signals, coverage = profiles(ws.reads, width, sample_seed=f"region-sync:{w['datasetId']}")
    sequence = fetch_sequence(view, w['chrom'], w['start'], w['end'], circular) if need_sequence else None
    data = dict(signals=signals, coverage=coverage, sequence=sequence, reads=len(ws.reads),
                circular=circular, whole=bool(circular) and width == circular)
    if population() == population_key:
        cache[key] = data
    return data, False


def validate(request):
    windows = request.get('windows', [])
    if not 1 <= len(windows) <= 12: raise ValueError('Choose 1–12 windows.')
    if len({w['panelId'] for w in windows}) != len(windows): raise ValueError('Panel IDs must be unique.')
    for w in windows:
        if not isinstance(w.get('start'), int) or not isinstance(w.get('end'), int) or not 100 <= w['end'] - w['start'] <= 50000 or w['start'] < 0:
            raise ValueError('Each window must be 100–50,000 bp and start at or above zero.')
        if not w.get('datasetId') or not w.get('chrom'): raise ValueError('Each window needs a dataset and chromosome.')
        if w.get('anchor') is not None:
            anchor = w['anchor']
            if not isinstance(anchor.get('position'), int) or not w['start'] <= anchor['position'] < w['end']:
                raise ValueError('Anchors must be integer positions inside their window.')
            if anchor.get('strand', '+') not in ('+', '-'):
                raise ValueError('Anchor strands must be + or −.')
    if not isinstance(request.get('metrics'), list) or not request['metrics'] or not set(request['metrics']) <= METRICS: raise ValueError('Choose an available metric.')
    if not 30 <= request.get('minimum', 200) <= 50000: raise ValueError('Minimum block length must be 30–50,000 bp.')
    thresholds(request)
    return request


def find_regions(state, request, progress=lambda message, fraction: None, cancelled=lambda: False):
    windows, metrics = request['windows'], request['metrics']
    coverage_only = request.get('coverageOnly') is True
    th = thresholds(request)
    loaded, notes, timings = [], [], {}
    start = time.perf_counter()
    for i, w in enumerate(windows):
        if cancelled(): return None
        progress(f'Loading window {i + 1} of {len(windows)}', 0.6 * i / len(windows))
        t = time.perf_counter()
        data, cached = load_window(state, w, 'sequence' in metrics and not coverage_only)
        timings[f"load {w['panelId']}"] = round(time.perf_counter() - t, 2)
        if 'sequence' in metrics and not coverage_only and not data['sequence']:
            notes.append(dict(panelId=w['panelId'], kind='no-sequence',
                              text='has no reference sequence here (its reference has no FASTA, or the contig is missing), so sequence blocks could not run'))
        loaded.append(data)
    if coverage_only:
        timings['total'] = round(time.perf_counter() - start, 2)
        return dict(metrics=metrics, windows=windows, proposals=[], timings=timings,
                    notes=['Known correspondence: shared positions can be pooled; unaligned positions stay member-specific.'],
                    coverage={w['panelId']: d['coverage'] for w, d in zip(windows, loaded)},
                    reads={w['panelId']: d['reads'] for w, d in zip(windows, loaded)},
                    circular={w['panelId']: d['circular'] for w, d in zip(windows, loaded) if d['circular']})
    proposals, diagnostics = [], []
    pairs = [(i, i) for i in range(len(windows))]
    pairs += [(0, j) for j in range(1, len(windows))]
    if request.get('allPairs', True):
        pairs += [(i, j) for i in range(1, len(windows)) for j in range(i + 1, len(windows))]
    t = time.perf_counter()
    for n, (i, j) in enumerate(pairs):
        if cancelled(): return None
        progress(f'Comparing pair {n + 1} of {len(pairs)}, both strands', 0.6 + 0.4 * n / len(pairs))
        wa, wb = windows[i], windows[j]
        found, log = compare_pair(loaded[i], loaded[j], wa, wb, metrics, th)
        logger.info('region-sync %s~%s: %s', wa['panelId'], wb['panelId'], log)
        diagnostics.append(dict(partnerId=wa['panelId'], panelId=wb['panelId'], **log))
        for rank, c in enumerate(found):
            c = shift_chain(c, wa['start'], wb['start'])
            if not c['blocks']:
                c.pop('blocks'); c.pop('gaps')
            c.update(id=f'p{len(proposals)}', panelId=wb['panelId'], partnerId=wa['panelId'], rank=rank)
            proposals.append(c)
        if i != j and same_locus(wa, wb, loaded[i].get('circular') if loaded[i].get('circular') == loaded[j].get('circular') else None):
            notes.append(dict(panelId=wb['panelId'], kind='identical',
                              text='Same sequence in both windows — showing repeats within it'))
        elif i == 0 and not found:
            notes.append(dict(panelId=wb['panelId'], kind='nothing', text=nothing_found(log, metrics, th)))
    from services.insertion_identify import minimap2_path
    if 'sequence' in metrics and not minimap2_path():
        notes.insert(0, dict(panelId=None, kind='no-minimap2', text='minimap2 was not found, so sequence blocks could not run. Install minimap2 (or use the app, which bundles it) and find again.'))
    timings['compare'] = round(time.perf_counter() - t, 2)
    timings['total'] = round(time.perf_counter() - start, 2)
    return dict(metrics=metrics, windows=windows, proposals=proposals, notes=notes, timings=timings,
                diagnostics=diagnostics, thresholds=th,
                coverage={w['panelId']: d['coverage'] for w, d in zip(windows, loaded)},
                reads={w['panelId']: d['reads'] for w, d in zip(windows, loaded)},
                circular={w['panelId']: d['circular'] for w, d in zip(windows, loaded) if d['circular']})


CLUSTER_BIN = 50
CLUSTER_MAX_READS = 1500


def frame_index(w, length):
    """Frame position of every base of the window's loaded extent (-1 where it has none),
    from its block map ``{frame: [u0, u1), genomic: [g0, g1)}``; '-' runs the frame backwards."""
    width = w['end'] - w['start']
    out = np.full(width, -1, dtype=np.int64)
    blocks = w.get('blocks') or [dict(frame=[0, length], genomic=[w['start'], w['end']])]
    for blk in blocks:
        (u0, u1), (g0, g1) = blk['frame'], blk['genomic']
        if u1 - u0 != g1 - g0 or u0 < 0 or u1 > length or g0 < w['start'] or g1 > w['end'] or u1 <= u0:
            raise ValueError('Each block must map equal lengths inside the frame and its window.')
    for side in ('frame', 'genomic'):
        spans = sorted(blk[side] for blk in blocks)
        if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
            raise ValueError('Blocks must not overlap in the frame or the window.')
    for blk in blocks:
        (u0, u1), (g0, g1) = blk['frame'], blk['genomic']
        k = np.arange(g1 - g0)
        out[g0 - w['start']:g1 - w['start']] = u0 + k if w.get('strand', '+') == '+' else u1 - 1 - k
    return out


def _read_vector(read, index, n):
    """Accessible fraction per CLUSTER_BIN frame bin (NaN where uncovered) and the share of
    the window's mapped bases the read covers. Bases map through the block map, so indels
    and reversal never misalign bins."""
    from services.coaccessibility import interval_matches_signal
    width = len(index)
    total, accessible = np.zeros(width), np.zeros(width)
    for a, b, size in read.get('intervals', []):
        a, b = max(0, int(a)), min(width, int(b))
        if b <= a: continue
        total[a:b] = 1
        if interval_matches_signal(size, 'accessibility'):
            accessible[a:b] = 1
    mapped = index >= 0
    bins = index[mapped] // CLUSTER_BIN
    tb = np.bincount(bins, weights=total[mapped], minlength=n)[:n]
    ab = np.bincount(bins, weights=accessible[mapped], minlength=n)[:n]
    cover = float(total[mapped].sum() / max(1, mapped.sum()))
    return np.divide(ab, tb, out=np.full(n, np.nan), where=tb > 0), cover


def cluster_check(state, request):
    """Pool the reads of a frame's windows (block maps; several copies of one panel are
    separate windows), cluster them once (k-means fitted on an equal number of reads per
    window) and report how each window's reads distribute over the clusters, with
    per-cluster profile agreement between windows."""
    from services.panel_genomes import genome_view
    from services.analysis_query import AnalysisReadQuery
    from services.read_metrics import sample_stable_by_id
    from services.matched_view_clustering import _balanced_indices, _fit_predict, _nmi
    windows = request.get('windows') or []
    k = int(request.get('k', 3)); min_cover = float(request.get('minCover', 0.8))
    if len(windows) < 2: raise ValueError('Choose at least two windows.')
    length = request.get('length')
    if length is None:
        widths = {w['end'] - w['start'] for w in windows if not w.get('blocks')}
        if len(widths) != 1: raise ValueError('Windows must have equal lengths; refine the selection first.')
        length = widths.pop()
    if not isinstance(length, int) or length < 1: raise ValueError('The frame needs a length.')
    if not 2 <= k <= 8: raise ValueError('Choose 2–8 clusters.')
    if not 0.1 <= min_cover <= 1: raise ValueError('Coverage must be 10–100% of the sub-window.')
    n = max(1, int(math.ceil(length / CLUSTER_BIN)))
    t = time.perf_counter()
    rows, groups, per_window = [], [], []
    for w in windows:
        key = w.get('key') or w['panelId']
        index = frame_index(w, length)
        view = genome_view(state, w.get('genome'))
        query = AnalysisReadQuery.from_request(view, chrom=w['chrom'], start=w['start'], end=w['end'], dataset_id=w['datasetId'],
                                               read_ids=w.get('readIds'), strand_by_dataset={w['datasetId']: w.get('readStrand')})
        ws = query.build_working_set(view, w['datasetId'], include_methylation=bool(w.get('readStrand')),
                                     requested_layers=('nuc',), include_layer_qualities=False)
        kept = []
        for read in ws.reads:
            vector, cover = _read_vector(read, index, n)
            if cover >= min_cover:
                kept.append((read, vector))
        eligible = len(kept)
        if len(kept) > CLUSTER_MAX_READS:
            ids = {r['id'] for r in sample_stable_by_id([r for r, _ in kept], CLUSTER_MAX_READS, seed=f"region-sync-cluster:{key}")}
            kept = [(r, v) for r, v in kept if r['id'] in ids]
        per_window.append(dict(key=key, panelId=w['panelId'], eligible=eligible, used=len(kept), total=len(ws.reads)))
        groups.append(list(range(len(rows), len(rows) + len(kept))))
        rows += [v for _, v in kept]
    short = [p['key'] for p in per_window if p['used'] < 10]
    if short:
        raise ValueError(f"Too few reads cover {min_cover:.0%} of the sub-window in {', '.join(short)}; lower the coverage or shorten the sub-window.")
    observed = np.vstack(rows)
    fit = _balanced_indices(groups, np.random.default_rng(0))
    # Uncovered bins take the balanced training rows' mean (so a deep window does not set
    # it) for fitting only; agreement uses observed values.
    with np.errstate(all='ignore'):
        fill = np.nanmean(observed[fit], axis=0)
    fill = np.where(np.isfinite(fill), fill, 0.0)
    X = observed.copy()
    missing = ~np.isfinite(X)
    X[missing] = np.take(fill, np.where(missing)[1])
    labels = _fit_predict(X, fit, k, 'kmeans', 0)
    window_of = np.empty(len(X), dtype=object)
    for p, g in zip(per_window, groups):
        window_of[g] = p['key']
        p['clusters'] = [int(c) for c in np.bincount(labels[g], minlength=k)]
    clusters = []
    for c in range(k):
        means = {}
        for p, g in zip(per_window, groups):
            members = [i for i in g if labels[i] == c]
            if len(members) >= 10:
                with np.errstate(all='ignore'):
                    means[p['key']] = np.nanmean(observed[members], axis=0)
        rs = [pearson(means[a], means[b], 5) for i, a in enumerate(means) for b in list(means)[i + 1:]]
        rs = [r for r in rs if r is not None]
        clusters.append(dict(cluster=c, reads=int((labels == c).sum()), windows=len(means),
                             agreement=round(float(np.mean(rs)), 3) if rs else None))
    with np.errstate(all='ignore'):
        overall = [np.nanmean(observed[g], axis=0) for g in groups]
    rs = [pearson(overall[i], overall[j], 5) for i in range(len(overall)) for j in range(i + 1, len(overall))]
    rs = [r for r in rs if r is not None]
    return dict(windows=per_window, clusters=clusters, k=k, bin=CLUSTER_BIN, minCover=min_cover, fitted=int(len(fit)),
                separation=round(_nmi(list(window_of), labels) or 0, 3),
                agreement=round(float(np.mean(rs)), 3) if rs else None,
                seconds=round(time.perf_counter() - t, 2))


def nothing_found(log, metrics, th):
    """Why a window got no proposal with the template, in plain words."""
    parts = []
    seq = log.get('sequence')
    if 'sequence' in metrics:
        if seq is None or seq.get('missing') == 'sequence':
            parts.append('sequence blocks could not run (no reference sequence)')
        elif seq.get('missing') == 'minimap2':
            parts.append('sequence blocks could not run (minimap2 not found)')
        elif not seq.get('chains'):
            parts.append(f"no shared sequence of at least {th['minimum']:,} bp between the two windows")
    for metric, name in (('accessibility', 'accessibility'), ('nfr', 'NFR shape')):
        if metric in metrics and log.get(metric):
            best = log[metric].get('best')
            parts.append(f"{name} has no shift strong enough alone" + (f" (best r {best['r']:.2f}, z {best['z']:.1f}; needs r ≥ {th['profileAloneR']} and z ≥ {th['profileAloneZ']})" if best else ''))
    if 'shape' in metrics and log.get('shape'):
        best = log['shape'].get('best') or {}
        if best.get('r', -1) > -1:
            parts.append(f"no local chromatin shape matches well enough (best r {best['r']:.2f}, z {best['z']:.1f}; needs r ≥ {th['shapeMinR']} and z ≥ {th['shapeMinZ']}, or z ≥ {th['shapeMinZ'] + 2} away from NFRs)")
        lms = log['shape'].get('landmarks') or []
        if lms and not th.get('shapeLandmarks'):
            pairs = ', '.join(f"{lm['window']:,} ↔ {lm['template']:,} (r {lm['r']:.2f}, {lm['strand']})" for lm in lms[:3])
            parts.append(f"NFR landmarks of this window pair with template NFRs ({pairs}; positions within each window), but NFRs resemble one another in general: turn on NFR landmark pairs in Advanced to propose them as hypotheses")
    return ('nothing comparable with the template: ' + '; '.join(parts) + '. The shared region may lie outside these windows: '
            'search the template’s reference for this window’s sequence, widen or move the windows, lower the thresholds in Advanced, or add a feature anchor.')


LOCATE_GAP = 20_000


def locate(state, request, progress=lambda message, fraction: None, cancelled=lambda: False, runner=None):
    """Where a window's sequence aligns in the template's whole reference (minimap2 on a
    cached index), as loci: hits on one contig and strand within LOCATE_GAP bp."""
    from services.panel_genomes import genome_view
    from services.circular_genome import circular_chrom_size
    from services.insertion_identify import genome_minimap2_index, _Runner, minimap2_path, local_reference_fasta, parse_paf as parse_hits
    template, query = request.get('template') or {}, request.get('query') or {}
    for w in (template, query):
        if not w.get('chrom') or not isinstance(w.get('start'), int) or not isinstance(w.get('end'), int) or not 100 <= w['end'] - w['start'] <= 50000:
            raise ValueError('Choose two windows of 100–50,000 bp.')
    if not minimap2_path():
        raise ValueError('minimap2 was not found. Install minimap2 (or use the app, which bundles it).')
    qview = genome_view(state, query.get('genome'))
    sequence = fetch_sequence(qview, query['chrom'], query['start'], query['end'], circular_chrom_size(qview, query['chrom']))
    if not sequence:
        raise ValueError('This window has no reference sequence (its reference has no FASTA).')
    tview = genome_view(state, template.get('genome'))
    if not local_reference_fasta(tview):
        raise ValueError('The template’s reference has no local FASTA to search.')
    runner = runner or _Runner()
    progress('Indexing the template’s reference for minimap2 (once)', 0.1)
    index = genome_minimap2_index(tview, runner=runner)
    if cancelled(): return None
    progress('Searching the reference', 0.6)
    # Secondary hits down to 1% of the best: the window's own copy in the same reference
    # would otherwise hide every shorter match elsewhere.
    with tempfile.TemporaryDirectory(prefix='fb_sync_locate_') as tmp:
        query_fa, out = Path(tmp) / 'window.fa', Path(tmp) / 'hits.paf'
        query_fa.write_text('>window\n' + sequence.upper() + '\n')
        runner.run([minimap2_path(), '-c', '-x', 'asm20', '--secondary=yes', '-N', '500', '-p', '0.01', '-t', '4', index, str(query_fa)], stdout_path=str(out))
        hits = parse_hits(out.read_text())
    same_reference = (template.get('genome') or None) == (query.get('genome') or None)
    qsize = circular_chrom_size(qview, query['chrom'])
    def is_self(h):
        # The window's own sequence in the same reference: '+', at its own position (modulo a circular contig).
        if not same_reference or h['subject'] != query['chrom'] or h['strand'] != '+':
            return False
        d = h['sstart'] - (query['start'] + h['qstart'])
        return (min(d % qsize, -d % qsize) if qsize else abs(d)) <= TOLERANCE
    hits = [h for h in hits if not is_self(h)]
    loci = []
    for h in sorted(hits, key=lambda h: (h['subject'], h['strand'], h['sstart'])):
        last = loci[-1] if loci else None
        if last and last['chrom'] == h['subject'] and last['strand'] == h['strand'] and h['sstart'] - last['end'] <= LOCATE_GAP:
            last['end'] = max(last['end'], h['send']); last['hits'].append(h)
        else:
            loci.append(dict(chrom=h['subject'], start=h['sstart'], end=h['send'], strand=h['strand'], hits=[h]))
    out = []
    for locus in loci:
        hs = locus.pop('hits')
        aligned = union_bp([[h['qstart'], h['qend']] for h in hs], [0, len(sequence)])
        identity = sum(h['identity'] * h['length'] for h in hs) / max(1, sum(h['length'] for h in hs)) / 100
        tsize = circular_chrom_size(tview, template['chrom'])
        inside = locus['chrom'] == template['chrom'] and any(template['start'] <= locus['start'] + k and locus['end'] + k <= template['end']
                                                             for k in ([0, tsize, -tsize] if tsize else [0]))
        out.append(dict(locus, aligned=aligned, identity=round(identity, 3), query=[min(h['qstart'] for h in hs) + query['start'], max(h['qend'] for h in hs) + query['start']],
                        inTemplate=bool(inside)))
    # Matches on the template's own chromosome first: that is where its panel and reads are.
    out.sort(key=lambda o: (o['chrom'] != template['chrom'], -o['aligned']))
    return dict(loci=out[:10], length=len(sequence), searched=template.get('genome') or 'main reference')


def submit(state, request, kind='find'):
    if kind == 'find':
        validate(request)
    with _LOCK:
        jobs = state.__dict__.setdefault('_region_sync_jobs', {})
        if any(j['state'] in ('queued', 'running') for j in jobs.values()): raise ValueError('A region search is already running in this session.')
        for key in list(jobs)[:-4]: jobs.pop(key)
        job = {'id': uuid.uuid4().hex, 'kind': kind, 'state': 'queued', 'message': 'Queued', 'result': None, 'fraction': 0, 'startedAt': time.time()}
        jobs[job['id']] = job

    def work():
        try:
            if job['state'] == 'cancelled': return
            job['state'] = 'running'
            progress, cancelled = lambda msg, fraction: job.update(message=msg, fraction=fraction), lambda: job['state'] == 'cancelled'
            if kind == 'find':
                result = find_regions(state, request, progress, cancelled)
            else:
                from services.insertion_identify import _Runner
                runner = state.__dict__.setdefault('_region_sync_runners', {})[job['id']] = _Runner()
                try:
                    result = locate(state, request, progress, cancelled, runner)
                finally:
                    state.__dict__.get('_region_sync_runners', {}).pop(job['id'], None)
            done = 'Comparison map ready' if kind == 'find' else 'Search finished'
            if job['state'] != 'cancelled': job.update(state='complete', result=result, message=done, fraction=1)
        except Exception as error:
            logger.exception('region-sync failed')
            if job['state'] != 'cancelled': job.update(state='error', message=str(error))
    def limited_work():
        from services.background_work import worker_slot
        with worker_slot():
            work()
    _POOL.submit(limited_work)
    return dict(job)


def cancel(state, job_id):
    """Mark a queued or running job cancelled and stop its running tool, if any."""
    job = get_job(state, job_id)
    if job['state'] in ('queued', 'running'):
        job.update(state='cancelled', message='Search cancelled')
        runner = state.__dict__.get('_region_sync_runners', {}).get(job_id)
        if runner:
            runner.kill()
    return job


def get_job(state, job_id):
    return state.__dict__.get('_region_sync_jobs', {})[job_id]


def dispose(state):
    for job in state.__dict__.pop('_region_sync_jobs', {}).values():
        job.update(state='cancelled', result=None)
    state.__dict__.pop('_region_sync_windows', None)
