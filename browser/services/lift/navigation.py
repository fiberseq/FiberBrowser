"""Navigation tables for linked lift panels (DESIGN_LIVE_LIFT.md §5.1).

1. **Map summary** (per sidecar): one row per chain, for cross-chromosome
   discovery from a source position on an unloaded chromosome.
2. **Outline** (per target chromosome): primary runs merged within a chain
   across gaps of at most ``OUTLINE_GAP`` on both sides; each row carries its
   maximum drift, the largest ``|Δq − Δt|`` (along the chain) of an absorbed
   piece, so approximate mapping has a known error bound. A row closes before
   its drift would pass ``OUTLINE_MAX_DRIFT`` (P1 deviation: unbounded rows
   reached 20 kb of drift on chr1).
3. **Exact tiles**: the primary pieces of a 1 Mb target tile, or of a 1 Mb
   source tile, as delta-varint binary.

Tile format (little-endian varints, ``zz`` = zigzag):
``b'GLT1'``, side (0 target, 1 source), varint tile index, varint count, then
per run sorted by the side's start: ``zz(start - previous end)``, ``len``,
``zz(other start - previous other start)``, ``chain*2 + (strand == '-')``.
Runs are ungapped (target and source lengths are equal); coordinates are the
side's own (target, or forward source).
"""
from __future__ import annotations

import bisect
import json
import threading
from collections import OrderedDict, defaultdict

TILE_BP = 1_000_000
OUTLINE_GAP = 2_000
# Drift accumulates across many small indels; a row whose drift would pass this
# is closed and a new one started, so the approximate map stays useful.
OUTLINE_MAX_DRIFT = 1_000
MAGIC = b"GLT1"


# ── Summary and outline ─────────────────────────────────────────────────────

def map_summary(handle) -> list:
    """``[target, t_start, t_end, source, q_start, q_end, strand, hap,
    primary_span_bp, aligned_bp]`` per chain (forward source coordinates).
    ``primary_span_bp``: target bp of the net rows where the chain is primary
    (spans, so target gaps inside them count); ``aligned_bp``: the chain's
    aligned bases (manifest ``aligned``)."""
    m = handle.manifest
    primary_bp = defaultdict(int)
    for rows in m["nets"].values():
        for _t, s, e, p, _alts in rows:
            primary_bp[p] += e - s
    out = []
    for ci, c in enumerate(handle.map.chains):
        out.append([m["targets"][c["target"]]["name"], c["t_start"], c["t_end"], m["sources"][c["source"]]["name"],
                    c["q_start_forward"], c["q_end_forward"], c["strand"], c["haplotype"], primary_bp[ci],
                    int(c.get("aligned") or 0)])
    return out


def primary_pieces(handle, chrom: str) -> list:
    """Every primary piece (``live_lift.LiftPiece``) of a target chromosome,
    sorted by target start."""
    from services.lift.live_lift import _as_lift_pieces
    size = handle.target_size(chrom) or 0
    with handle.lock:
        pieces = handle.map.target_to_source(chrom, 0, size)
    return sorted((p for p in _as_lift_pieces(handle, pieces) if p.primary), key=lambda p: (p.t_start, p.chain))


def outline(handle, chrom: str, pieces=None, gap: int = OUTLINE_GAP, max_drift: int = OUTLINE_MAX_DRIFT) -> list:
    """``[t_start, t_end, q_start, q_end, strand, chain, max_drift]`` rows.
    Approximate map inside a row: ``q = q_start + (t - t_start)`` on ``+``,
    ``q_end - 1 - (t - t_start)`` on ``-``, off by at most ``max_drift``."""
    pieces = primary_pieces(handle, chrom) if pieces is None else pieces
    by_chain = defaultdict(list)
    for p in pieces:
        by_chain[p.chain].append(p)
    rows = []
    for chain, ps in by_chain.items():
        ps.sort(key=lambda p: p.t_start)
        cur = None
        for p in ps:
            if cur is not None:
                dt = p.t_start - cur[1]
                dq = (p.q_start - cur[3]) if p.strand == "+" else (cur[2] - p.q_end)
                # Drift of this piece against the row's linear map.
                along = (p.q_start - cur[2]) if p.strand == "+" else (cur[3] - p.q_end)
                drift = abs(along - (p.t_start - cur[0]))
                if 0 <= dt <= gap and 0 <= dq <= gap and (max_drift is None or drift <= max_drift):
                    cur[6] = max(cur[6], drift)
                    cur[1] = p.t_end
                    cur[2], cur[3] = min(cur[2], p.q_start), max(cur[3], p.q_end)
                    continue
                rows.append(cur)
            cur = [p.t_start, p.t_end, p.q_start, p.q_end, p.strand, chain, 0]
        if cur is not None:
            rows.append(cur)
    rows.sort(key=lambda r: (r[0], r[5]))
    return rows


class Outline:
    """An outline with lookup indexes both ways. ``chain_sources``: chain ->
    source contig (``outline_chain_sources``), for source -> target lookups."""

    def __init__(self, rows: list, chain_sources: dict = None):
        self.rows = rows
        self.starts = [r[0] for r in rows]
        self.reach, top = [], 0
        for r in rows:
            top = max(top, r[1])
            self.reach.append(top)
        self.by_source = {}
        for r in rows:
            src = (chain_sources or {}).get(r[5])
            if src is not None:
                self.by_source.setdefault(src, []).append(r)
        self.source_index = {}
        for src, rs in self.by_source.items():
            rs.sort(key=lambda r: r[2])
            reach, top = [], 0
            for r in rs:
                top = max(top, r[3])
                reach.append(top)
            self.source_index[src] = ([r[2] for r in rs], reach)

    def lookup_source(self, source: str, q: int) -> list:
        """``[(chain, t, max_drift)]`` of forward source position ``q`` (approximate)."""
        rows = self.by_source.get(source)
        if not rows:
            return []
        starts, reach = self.source_index[source]
        out = []
        i = bisect.bisect_right(starts, q) - 1
        while i >= 0 and reach[i] > q:
            r = rows[i]
            if q < r[3]:
                d = (q - r[2]) if r[4] == "+" else (r[3] - 1 - q)
                out.append((r[5], min(max(r[0] + d, r[0]), r[1] - 1), r[6]))
            i -= 1
        return out

    def lookup(self, t: int) -> list:
        """``[(chain, q, max_drift)]`` of target position ``t`` (approximate)."""
        out = []
        i = bisect.bisect_right(self.starts, t) - 1
        while i >= 0 and self.reach[i] > t:
            r = self.rows[i]
            if t < r[1]:
                d = t - r[0]
                q = r[2] + d if r[4] == "+" else r[3] - 1 - d
                out.append((r[5], min(max(q, r[2]), r[3] - 1), r[6]))
            i -= 1
        return out


def encode_json(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":")).encode()


# ── Exact tiles ─────────────────────────────────────────────────────────────

def _uvarint(n: int, out: bytearray) -> None:
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def _zz(n: int) -> int:
    return (n << 1) if n >= 0 else ((-n << 1) - 1)


def _unzz(n: int) -> int:
    return (n >> 1) if not n & 1 else -((n + 1) >> 1)


def _clip(p, a, b, side):
    """Piece clipped to ``[a, b)`` on ``side`` (0 target, 1 forward source)."""
    from services.lift.live_lift import clip_piece
    if side == 0:
        return clip_piece(p, a, b)
    s, e = max(p.q_start, a), min(p.q_end, b)
    if e <= s:
        return None
    if p.strand == "+":
        return p._replace(q_start=s, q_end=e, t_start=p.t_start + (s - p.q_start), t_end=p.t_end - (p.q_end - e))
    return p._replace(q_start=s, q_end=e, t_start=p.t_start + (p.q_end - e), t_end=p.t_end - (s - p.q_start))


def tile_runs(pieces, side: int, tile: int) -> list:
    """Pieces of one tile, clipped to it and sorted by that side's start."""
    a, b = tile * TILE_BP, (tile + 1) * TILE_BP
    out = []
    for p in pieces:
        c = _clip(p, a, b, side)
        if c is not None:
            out.append(c)
    key = (lambda p: (p.t_start, p.chain)) if side == 0 else (lambda p: (p.q_start, p.chain))
    return sorted(out, key=key)


def outline_chain_sources(handle) -> dict:
    return {ci: handle.manifest["sources"][c["source"]]["name"] for ci, c in enumerate(handle.map.chains)}


def build_source_tiles(pieces) -> dict:
    """``{(source contig, tile index): encoded tile}``: source-indexed tiles,
    one set per source contig."""
    by_source = defaultdict(list)
    for p in pieces:
        by_source[p.source].append(p)
    return {(src, k): blob for src, ps in by_source.items() for k, blob in build_tiles(ps, 1).items()}


def source_tile(handle, source: str, tile: int, haplotypes=None) -> bytes:
    """One source-indexed tile straight from the map (``source_to_target``,
    primary pieces of the selected haplotypes, every target)."""
    from services.lift.live_lift import _as_lift_pieces
    with handle.lock:
        raw = handle.map.source_to_target(source, tile * TILE_BP, (tile + 1) * TILE_BP)
    pieces = [p for p in _as_lift_pieces(handle, raw) if p.primary and (haplotypes is None or p.hap in haplotypes)]
    return encode_tile(tile_runs(pieces, 1, tile), 1, tile)


def build_tiles(pieces, side: int) -> dict:
    """``{tile index: encoded tile}`` of every tile the pieces touch, in one
    pass. Source-side tiles need pieces of one source contig
    (``build_source_tiles`` groups them)."""
    if side == 1 and len({p.source for p in pieces}) > 1:
        raise ValueError("source tiles hold one source contig: use build_source_tiles")
    buckets = defaultdict(list)
    for p in pieces:
        lo, hi = (p.t_start, p.t_end) if side == 0 else (p.q_start, p.q_end)
        for k in range(lo // TILE_BP, (hi - 1) // TILE_BP + 1):
            buckets[k].append(p)
    return {k: encode_tile(tile_runs(ps, side, k), side, k) for k, ps in buckets.items()}


def encode_tile(runs, side: int, tile: int) -> bytes:
    out = bytearray(MAGIC)
    out.append(side)
    _uvarint(tile, out)
    _uvarint(len(runs), out)
    prev_end, prev_other = tile * TILE_BP, 0
    for p in runs:
        start, end, other = (p.t_start, p.t_end, p.q_start) if side == 0 else (p.q_start, p.q_end, p.t_start)
        _uvarint(_zz(start - prev_end), out)
        _uvarint(end - start, out)
        _uvarint(_zz(other - prev_other), out)
        _uvarint(p.chain * 2 + (p.strand == "-"), out)
        prev_end, prev_other = end, other
    return bytes(out)


def decode_tile(data: bytes) -> dict:
    """``{side, tile, start, end, other, chain, minus, reach}`` (parallel lists;
    ``reach`` is the running maximum of ``end``, which bounds lookups)."""
    if data[:4] != MAGIC:
        raise ValueError("not a graphlift navigation tile")
    pos = 5
    side = data[4]

    def uv():
        nonlocal pos
        shift = result = 0
        while True:
            b = data[pos]
            pos += 1
            result |= (b & 0x7F) << shift
            if b < 0x80:
                return result
            shift += 7

    tile = uv()
    n = uv()
    start, end, other, chain, minus = [], [], [], [], []
    prev_end, prev_other = tile * TILE_BP, 0
    for _ in range(n):
        s = prev_end + _unzz(uv())
        e = s + uv()
        o = prev_other + _unzz(uv())
        c = uv()
        start.append(s)
        end.append(e)
        other.append(o)
        chain.append(c >> 1)
        minus.append(bool(c & 1))
        prev_end, prev_other = e, o
    reach, top = [], 0
    for e in end:
        top = max(top, e)
        reach.append(top)
    return {"side": side, "tile": tile, "start": start, "end": end, "other": other, "chain": chain, "minus": minus,
            "reach": reach}


def tile_lookup(tile: dict, x: int) -> list:
    """Every ``(chain, mapped position)`` of position ``x`` on the tile's side
    (several where pieces overlap, e.g. both haplotypes)."""
    out = []
    starts = tile["start"]
    i = bisect.bisect_right(starts, x) - 1
    reach = tile["reach"]
    while i >= 0 and reach[i] > x:
        if x < tile["end"][i]:
            d = x - starts[i]
            length = tile["end"][i] - starts[i]
            out.append((tile["chain"][i], tile["other"][i] + (length - 1 - d if tile["minus"][i] else d)))
        i -= 1
    return out


# ── Served tables (routers/lift.py; P3 linked panels) ───────────────────────
#
# Everything is scoped by the dataset's selected haplotypes: a MAT source panel
# must never map through a PAT chain. Chain indexes are the summary's row
# indexes (the summary lists every chain, with ``selected`` flags), so outline
# and tile rows resolve to (target, source contig, haplotype) on the client.

_SERVED_LOCK = threading.Lock()
_OUTLINE_CACHE: "OrderedDict[tuple, list]" = OrderedDict()
_TILE_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_OUTLINE_CACHE_MAX = 64
_TILE_CACHE_MAX = 512
MAX_RIBBON_PIECES = 4_000


def _cached(cache, limit, key, build):
    with _SERVED_LOCK:
        if key in cache:
            cache.move_to_end(key)
            return cache[key]
    value = build()
    with _SERVED_LOCK:
        cache[key] = value
        while len(cache) > limit:
            cache.popitem(last=False)
    return value


def clear_served_caches() -> None:
    with _SERVED_LOCK:
        _OUTLINE_CACHE.clear()
        _TILE_CACHE.clear()


def served_summary(config) -> dict:
    """``chains``: :func:`map_summary` rows (index = chain); ``selected``: per
    chain, whether its haplotype is one of the dataset's; ``sources``: source
    contig -> haplotype key of the selected haplotypes."""
    handle = config.handle
    haps = set(config.haplotypes)
    rows = map_summary(handle)
    labels = config.labels()
    return {"key": config.key(), "chains": rows, "selected": [r[7] in haps for r in rows],
            "haplotypes": list(config.haplotypes), "labels": labels,
            "sources": {src: hap for src, hap in handle.source_haplotype.items() if hap in haps},
            "targets": {t["name"]: t.get("size") for t in handle.manifest["targets"]},
            "outline_gap": OUTLINE_GAP, "outline_max_drift": OUTLINE_MAX_DRIFT, "tile_bp": TILE_BP}


def _target_outline(handle, chrom: str) -> list:
    """Every haplotype's outline rows of a target chromosome (cached per map)."""
    return _cached(_OUTLINE_CACHE, _OUTLINE_CACHE_MAX, (handle.fingerprint, chrom), lambda: outline(handle, chrom))


def served_outline(config, *, chrom: str = None, source: str = None) -> dict:
    """Outline rows of a target chromosome (``chrom``) or of one source contig
    over every target it maps to (``source``), selected haplotypes only.
    Source rows also carry their target name (row index 7)."""
    handle = config.handle
    haps = set(config.haplotypes)
    chains = handle.map.chains
    sources = handle.manifest["sources"]
    targets = handle.manifest["targets"]
    if chrom is not None:
        if chrom not in handle.map.targets:
            raise KeyError(chrom)
        rows = [r for r in _target_outline(handle, chrom) if chains[r[5]]["haplotype"] in haps]
        return {"key": config.key(), "chrom": chrom, "rows": rows}
    if source not in handle.source_haplotype or handle.source_haplotype[source] not in haps:
        raise KeyError(source)
    names = sorted({targets[c["target"]]["name"] for c in chains if sources[c["source"]]["name"] == source})
    rows = []
    for name in names:
        for r in _target_outline(handle, name):
            if sources[chains[r[5]]["source"]]["name"] == source:
                rows.append([*r, name])
    rows.sort(key=lambda r: (r[2], r[5]))
    return {"key": config.key(), "source": source, "rows": rows}


def served_tile(config, side: str, contig: str, tile: int) -> bytes:
    """One exact tile (``side`` 'target' or 'source'), selected haplotypes only."""
    from services.lift.live_lift import _as_lift_pieces
    handle = config.handle
    haps = tuple(sorted(config.haplotypes))
    if side == "target":
        if contig not in handle.map.targets:
            raise KeyError(contig)

        def build():
            with handle.lock:
                raw = handle.map.target_to_source(contig, tile * TILE_BP, (tile + 1) * TILE_BP)
            pieces = [p for p in _as_lift_pieces(handle, raw) if p.primary and p.hap in haps]
            return encode_tile(tile_runs(pieces, 0, tile), 0, tile)
    elif side == "source":
        if handle.source_haplotype.get(contig) not in haps:
            raise KeyError(contig)

        def build():
            return source_tile(handle, contig, tile, set(haps))
    else:
        raise ValueError("side must be 'target' or 'source'")
    return _cached(_TILE_CACHE, _TILE_CACHE_MAX, (handle.fingerprint, side, contig, int(tile), haps), build)


def _coarsen(pieces: list, min_bp: int) -> list:
    """Merge consecutive pieces of one chain (same flags) whose target and
    source gaps are both at most ``min_bp`` (sub-pixel at the ribbon's scale)."""
    if min_bp <= 0:
        return pieces
    out = []
    last = {}
    for p in sorted(pieces, key=lambda p: (p[5], p[6], p[0])):
        k = (p[5], p[6], p[4])
        q = last.get(k)
        if q is not None:
            dt = p[0] - q[1]
            dq = (p[2] - q[3]) if p[4] == "+" else (q[2] - p[3])
            if 0 <= dt <= min_bp and 0 <= dq <= min_bp:
                q[1] = p[1]
                q[2], q[3] = min(q[2], p[2]), max(q[3], p[3])
                continue
        q = list(p)
        out.append(q)
        last[k] = q
    return sorted(out, key=lambda p: (p[0], p[5]))


def served_pieces(config, chrom: str, start: int, end: int, *, hap: str = None, alternatives: bool = None,
                  min_bp: int = 0) -> dict:
    """Ribbon data for target ``[start, end)``: pieces
    ``[t_start, t_end, q_start, q_end, strand, chain, alt, source, hap]``
    (forward source coordinates, clipped to the window) and the primary
    chains' raw gaps ``[chain, t_start, t_end, q_start, q_end, reason, source, strand]``.
    Alternatives (the 16 best chains, as for display) only with
    ``alternatives`` (default: the dataset's display setting)."""
    from services.lift.live_lift import BIN_BP, MAX_ALTERNATIVE_CHAINS, _bin_pieces, clip_piece, _merge_contiguous
    from services.lift.differences import primary_gaps_for_region, _source_span
    handle = config.handle
    if chrom not in handle.map.targets:
        raise KeyError(chrom)
    haps = set(config.haplotypes)
    if hap is not None:
        wanted = set(handle.resolve_haplotypes([hap]))
        if not wanted <= haps:
            raise KeyError(hap)
        haps = wanted
    alternatives = config.settings.alternatives if alternatives is None else bool(alternatives)
    key = config.key()
    raw = []
    for b in range(start // BIN_BP, (max(end, start + 1) - 1) // BIN_BP + 1):
        for p in _bin_pieces(handle, key, chrom, b):
            c = clip_piece(p, start, end)
            if c is not None and c.hap in haps:
                raw.append(c)
    raw = _merge_contiguous(raw)
    keep_alt = set()
    alt_chains = sorted({p.chain for p in raw if not p.primary}, key=lambda ci: handle.chain_rank[ci])
    capped = 0
    if alternatives:
        keep_alt = set(alt_chains[:MAX_ALTERNATIVE_CHAINS])
        capped = max(0, len(alt_chains) - MAX_ALTERNATIVE_CHAINS)
    pieces = [[p.t_start, p.t_end, p.q_start, p.q_end, p.strand, p.chain, not p.primary, p.source, p.hap]
              for p in raw if p.primary or p.chain in keep_alt]
    bp = max(0, int(min_bp))
    pieces = _coarsen(pieces, bp)
    truncated = False
    span = max(1, end - start)
    while len(pieces) > MAX_RIBBON_PIECES:
        if bp >= span:
            # Merging can no longer shrink the list (distinct chains never merge): keep the longest pieces.
            pieces = sorted(sorted(pieces, key=lambda p: (p[0] - p[1], p[0], p[5]))[:MAX_RIBBON_PIECES], key=lambda p: (p[0], p[5]))
            truncated = True
            break
        bp = max(1, bp) * 2
        pieces = _coarsen(pieces, bp)
    gaps = []
    with handle.lock:
        for h in sorted(haps):
            for ci, (t, q, dt, dq, reason), _claims in primary_gaps_for_region(handle, chrom, h, start, end):
                if max(dt, dq) <= bp:
                    continue
                c = handle.map.chains[ci]
                q0, q1 = _source_span(handle, c, q, dq)
                gaps.append([ci, t, t + dt, q0, q1, handle.map.reasons[reason],
                             handle.manifest["sources"][c["source"]]["name"], c["strand"]])
    gaps.sort(key=lambda g: (g[1], g[0]))
    return {"key": key, "chrom": chrom, "start": start, "end": end, "pieces": pieces, "gaps": gaps[:MAX_RIBBON_PIECES],
            "min_bp": bp, "alternatives_capped": capped, "alternatives": bool(alternatives), "truncated": truncated}
