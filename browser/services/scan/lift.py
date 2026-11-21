"""Lifting a source-frame scan's hits onto the browser's reference (feature hub G1; DESIGN §4.3, §5.4).

A scan of a live-lift dataset's own BAM (an assembly such as HG002 MAT/PAT) lists its hits in source coordinates.
They are lifted to the target with graphlift's native ``liftbed``, the engine ``fiberhmm-lift --bed`` runs, through
the dataset's map and with fiberhmm-lift's settings: the split gap is the dataset's ``g_split`` (fiberhmm-lift's
``--split-gap``, 10,000 by default), no alternative chains, and the placement with the most projected bases is kept.
So a hit lands where ``fiberhmm-lift --bed`` puts it, and where the dataset's reads are lifted. Each hit keeps its
source coordinates and gets a status:

- **exact**: one placement, every base projected;
- **split**: the bases land in several placements (the one with the most projected bases is kept);
- **partial**: one placement, some bases have no target (an insertion or an assembly gap inside the hit);
- **unmapped**: no base projects. A hit wholly inside an insertion relative to the target gets the insertion's
  target junction as its anchor (``junction``), so it can still be placed, drawn in graph mode and clustered at.

A split hit that also lost bases is reported as split. liftbed's BED output has no per-row placement count, so three
runs give the status (each takes milliseconds): ``--split best`` (the interval), ``--split all`` (placements per row)
and ``--split best --min-match 1`` (rows whose best placement projects every base: exact).

``liftbed`` is found from ``FIBERBROWSER_LIFTBED``, else next to the graph helper (graphlift builds both into one
``target/release``), else in the app's bundled tools, else on ``PATH``.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

ENV_LIFTBED = 'FIBERBROWSER_LIFTBED'
LIFTBED = 'liftbed'
STATUSES = ('exact', 'split', 'partial', 'unmapped')
RUN_TIMEOUT_S = 60
_CACHE: 'OrderedDict[tuple, Dict[int, HitLift]]' = OrderedDict()
_CACHE_MAX = 64
_CACHE_LOCK = threading.Lock()


class LiftUnavailable(RuntimeError):
    """Hits cannot be lifted here (no liftbed, a plain UCSC chain, a map that is gone)."""


@dataclass
class HitLift:
    """One source interval's lift. ``chrom/start/end``: the kept placement on the target (None when unmapped).
    ``junction``: the target boundary ``(lo, hi)`` an unmapped interval sits at (an insertion), else None."""
    status: str
    chrom: Optional[str] = None
    start: Optional[int] = None
    end: Optional[int] = None
    flipped: bool = False
    placements: int = 0
    reason: Optional[str] = None
    junction: Optional[Tuple[int, int]] = None
    junction_chrom: Optional[str] = None
    # Every placement, for lifting callable territory without losing split pieces.
    parts: Optional[List[Tuple[str, int, int]]] = None

    def public(self) -> dict:
        out = asdict(self)
        out.pop('parts', None)
        if self.junction is not None:
            out['junction'] = list(self.junction)
        return out


# ── Finding liftbed ─────────────────────────────────────────────────────────

def liftbed_candidates(environ: Optional[dict] = None) -> List[Tuple[str, str]]:
    """(source, path) in resolution order; paths may not exist."""
    env = os.environ if environ is None else environ
    out: List[Tuple[str, str]] = []
    override = (env.get(ENV_LIFTBED) or '').strip()
    if override:
        out.append(('env', override))
    try:
        from services.graph_panel import helper
        for source, path in helper.candidates(env):
            out.append((f'next to the graph helper ({source})', os.path.join(os.path.dirname(path), LIFTBED)))
    except Exception:   # pragma: no cover - the graph package ships with the browser
        pass
    found = shutil.which(LIFTBED)
    if found:
        out.append(('PATH', found))
    return out


def find_liftbed(environ: Optional[dict] = None) -> Optional[str]:
    for _source, path in liftbed_candidates(environ):
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def unavailable_note() -> str:
    return ("graphlift's liftbed was not found (set FIBERBROWSER_LIFTBED, or build graphlift next to the graph helper): "
            "hits stay in source coordinates")


# ── Running liftbed ─────────────────────────────────────────────────────────

def _run(liftbed: str, bed: str, map_path: str, out: str, *, split: str, min_match: float, split_gap: int,
         unlifted: Optional[str] = None) -> None:
    cmd = [liftbed, '-i', bed, '-m', map_path, '-o', out, '--split', split, '--split-gap', str(int(split_gap)),
           '--alt', 'never', '--min-match', repr(float(min_match))]
    if unlifted:
        cmd += ['--unlifted', unlifted]
    proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=RUN_TIMEOUT_S, check=False)
    if proc.returncode != 0:
        tail = proc.stderr.decode('utf-8', 'replace').strip().splitlines()[-3:]
        raise LiftUnavailable(f"liftbed failed (exit {proc.returncode}): {' '.join(tail)}")


def _rows(path: str) -> Dict[int, List[Tuple[str, int, int, str]]]:
    """``{row index: [(target, start, end, strand), ...]}`` of a liftbed output whose names are ``h<index>``."""
    out: Dict[int, List[Tuple[str, int, int, str]]] = {}
    with open(path) as handle:
        for line in handle:
            if not line.strip() or line.startswith(('#', 'track', 'browser')):
                continue
            f = line.rstrip('\n').split('\t')
            if len(f) < 6 or not f[3].startswith('h'):
                continue
            try:
                out.setdefault(int(f[3][1:]), []).append((f[0], int(f[1]), int(f[2]), f[5]))
            except ValueError:
                continue
    return out


def _reasons(path: str) -> Dict[int, str]:
    out: Dict[int, str] = {}
    reason = None
    with open(path) as handle:
        for line in handle:
            line = line.rstrip('\n')
            if line.startswith('#') and reason is None:
                reason = line[1:]
                continue
            if reason is not None:
                f = line.split('\t')
                if len(f) > 3 and f[3].startswith('h') and f[3][1:].isdigit():
                    out[int(f[3][1:])] = reason
                reason = None
    return out


def lift_intervals(map_path: str, intervals: Sequence[Tuple[str, int, int]], *, split_gap: int = 10_000,
                   liftbed: Optional[str] = None) -> List[HitLift]:
    """The lift of each ``(source contig, start, end)`` through a graphlift sidecar, in input order."""
    if not intervals:
        return []
    exe = liftbed or find_liftbed()
    if not exe:
        raise LiftUnavailable(unavailable_note())
    with tempfile.TemporaryDirectory(prefix='fb-liftbed-') as tmp:
        bed = os.path.join(tmp, 'in.bed')
        with open(bed, 'w') as handle:
            for i, (contig, start, end) in enumerate(intervals):
                handle.write(f'{contig}\t{int(start)}\t{int(end)}\th{i}\t0\t+\n')
        best, every, exact = (os.path.join(tmp, n) for n in ('best.bed', 'all.bed', 'exact.bed'))
        unlifted = os.path.join(tmp, 'unlifted.bed')
        _run(exe, bed, map_path, best, split='best', min_match=0.0, split_gap=split_gap, unlifted=unlifted)
        _run(exe, bed, map_path, every, split='all', min_match=0.0, split_gap=split_gap)
        _run(exe, bed, map_path, exact, split='best', min_match=1.0, split_gap=split_gap)
        kept, placed, whole, reasons = _rows(best), _rows(every), _rows(exact), _reasons(unlifted)
    out = []
    for i in range(len(intervals)):
        rows = kept.get(i)
        if not rows:
            out.append(HitLift('unmapped', reason=reasons.get(i, 'not lifted')))
            continue
        target, start, end, strand = rows[0]
        n = len(placed.get(i) or ()) or 1
        status = 'split' if n > 1 else 'exact' if i in whole else 'partial'
        out.append(HitLift(status, target, start, end, flipped=strand == '-', placements=n,
                           parts=[(c, a, b) for c, a, b, _strand in placed.get(i, rows)]))
    return out


# ── Anchors of unmapped hits ────────────────────────────────────────────────

# Gaps a source interval with no projection can be placed at: sequence the source has and the target lacks (an
# insertion), or replaces with other sequence. Gaps graphlift marks too big or conflicting (possible inversions or
# transpositions) are not attachments.
JUNCTION_GAPS = ('source_insertion', 'aligned_indel', 'dissimilar')


def gap_candidates(lift_map, contig: str, start: int, end: int) -> List[tuple]:
    """``[(chain, reason, lo, hi)]``: every chain gap holding source ``[start, end)`` whole (``[lo, hi)`` forward source
    coordinates), across all the source's chains (graphlift_map.gap_span returns only the first)."""
    import bisect
    si = lift_map.sources.get(contig)
    if si is None:
        return []
    qsize = lift_map.m['sources'][si]['size']
    out = []
    for ci in lift_map.by_source.get(si, []):
        c = lift_map.chains[ci]
        if not (c['q_start_forward'] <= start and end <= c['q_end_forward']):
            continue
        d = lift_map.chain_data(ci)
        qs, qe = (start, end) if c['strand'] == '+' else (qsize - end, qsize - start)
        k = bisect.bisect_right(d['gq'], qs) - 1
        while k >= 0:
            g = d['gaps'][k]
            if g[1] <= qs and qe <= g[1] + g[3]:
                lo, hi = g[1], g[1] + g[3]
                if c['strand'] == '-':
                    lo, hi = qsize - hi, qsize - lo
                out.append((ci, lift_map.reasons[g[4]], lo, hi))
                break
            if g[1] + g[3] <= qs and g[3] > 0:
                break
            k -= 1
    return out


def insertion_junction(lift_map, contig: str, start: int, end: int, max_span: int = 10_000) -> Optional[Tuple[str, int, int]]:
    """``(target, lo, hi)``: where a source interval with no projection sits on the target, or None.

    The interval must lie whole in one chain's insertion or replacement gap (``JUNCTION_GAPS``), and the bases
    flanking that gap must project through the same chain, as primary: that says where the gap attaches (an
    insertion: ``lo == hi``; a replacement: the target stretch it replaces, at most ``max_span`` bp, the split gap).
    Every chain is considered, and the attachment must be one and the same whatever the chain order; anything else
    (a rearrangement, a conflict, competing chains, a stretch outside every chain) is not placed."""
    placed = set()
    for ci, reason, lo, hi in gap_candidates(lift_map, contig, int(start), int(end)):
        left = [p for p in lift_map.source_to_target(contig, max(0, lo - 1), lo) if p.primary and p.chain == ci] if lo > 0 else []
        right = [p for p in lift_map.source_to_target(contig, hi, hi + 1) if p.primary and p.chain == ci]
        # Only primary chains attach (liftbed runs with --alt never): an alternative chain's gap neither places nor vetoes.
        if not left or not right or left[0].strand != right[0].strand:
            continue
        if reason not in JUNCTION_GAPS:
            return None
        a, b = left[0], right[0]
        # On a + chain the left flank ends at the junction and the right one starts there; on a - chain the reverse.
        x, y = (a.t_end, b.t_start) if a.strand == '+' else (b.t_end, a.t_start)
        if abs(y - x) > max_span:
            return None
        placed.add((lift_map.m['targets'][lift_map.chains[ci]['target']]['name'], min(x, y), max(x, y)))
    return placed.pop() if len(placed) == 1 else None


# ── Hits of a scan ──────────────────────────────────────────────────────────

def _map_identity(path: str) -> tuple:
    st = os.stat(path)
    return (os.path.abspath(path), st.st_size, st.st_mtime_ns)


def lift_hits(config, hits: Sequence[dict]) -> Dict[int, HitLift]:
    """Lifts hit rows (``chrom start end`` on the map's source contigs) through a live-lift dataset's map
    (``LiveLiftConfig``); ``{row index: HitLift}``. Cached by map identity, split gap and the intervals."""
    handle = config.handle
    if getattr(handle, 'plain_chain', False):
        raise LiftUnavailable('the dataset uses a plain UCSC chain, which liftbed cannot read: open it with a graphlift '
                              'sidecar (.graphlift.json) to lift hits')
    intervals = [(str(h['chrom']), int(h['start']), int(h['end'])) for h in hits]
    split_gap = int(getattr(config.settings, 'g_split', 10_000))
    # The handle's fingerprint covers the manifest and every target payload file (a payload-only update changes it).
    key = (_map_identity(handle.path), getattr(handle, 'fingerprint', None), split_gap,
           hashlib.sha256(json.dumps(intervals, separators=(',', ':')).encode()).hexdigest())
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
    lifted = lift_intervals(handle.path, intervals, split_gap=split_gap)
    out: Dict[int, HitLift] = {}
    for i, (lift, (contig, start, end)) in enumerate(zip(lifted, intervals)):
        if lift.status == 'unmapped' and lift.reason == 'no_projection':
            j = insertion_junction(handle.map, contig, start, end, max_span=split_gap)
            if j is not None:
                lift.junction_chrom, lift.junction = j[0], (j[1], j[2])
        out[i] = lift
    with _CACHE_LOCK:
        _CACHE[key] = out
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return out


def source_windows(config, chrom: str, start: int, end: int) -> Dict[str, Tuple[int, int]]:
    """``{source contig: (lo, hi)}``: the hull of the source bases a target view's primary chains reach, per source
    contig of the dataset's haplotypes (insertions between them included, as the source path runs through them)."""
    handle = config.handle
    lm = handle.map
    if getattr(handle, 'plain_chain', False) or not hasattr(lm, 'target_to_source'):
        return {}
    wanted = set(getattr(config, 'haplotypes', None) or ())
    out: Dict[str, Tuple[int, int]] = {}
    for p in lm.target_to_source(chrom, max(0, int(start)), int(end)):
        if not p.primary:
            continue
        chain = lm.chains[p.chain]
        if wanted and chain.get('haplotype') not in wanted:
            continue
        name = lm.m['sources'][chain['source']]['name']
        lo, hi = out.get(name, (p.q_start, p.q_end))
        out[name] = (min(lo, p.q_start), max(hi, p.q_end))
    # One past the last base: a zero-width hit at a projected stretch's end (a contig end) is in the window too.
    return {name: (lo, hi + 1) for name, (lo, hi) in out.items()}


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def overlaps_target(lift: HitLift, chrom_ok, start: int, end: int) -> bool:
    """Whether a lifted hit (its placement, or its junction when unmapped) meets target ``[start, end)``."""
    if lift.chrom is not None and chrom_ok(lift.chrom):
        a, b = int(lift.start), int(lift.end)
        return (a < end and start < b) if b > a else start <= a < end
    if lift.junction is not None and lift.junction_chrom is not None and chrom_ok(lift.junction_chrom):
        lo, hi = lift.junction
        # A replacement's target stretch is half-open; an insertion's junction is a point.
        return (lo < end and start < hi) if hi > lo else start <= lo < end
    return False


def statuses(lifts: Iterable[HitLift]) -> Dict[str, int]:
    out = {s: 0 for s in STATUSES}
    for lift in lifts:
        out[lift.status] = out.get(lift.status, 0) + 1
    return out
