"""``lift_compact_reads``: compact reads decoded in a source assembly's
coordinates, mapped to the target (main) genome through selected graphlift
pieces (DESIGN_LIVE_LIFT.md §3.4-§3.7). Pure: no I/O apart from the map's
``gap_span``/``source_to_target`` for parts of a read outside the pieces.

Per piece ``p`` (forward source coordinates):
- base ``T(x)``: ``p.t_start + (x - p.q_start)`` on ``+``, ``p.t_end - 1 - (x - p.q_start)`` on ``-``;
- span ``[a, b)``: ``[T(a), T(b-1)+1)`` on ``+``, ``[T(b-1), T(a)+1)`` on ``-``;
- boundary ``B(x)``: ``p.t_start + (x - p.q_start)`` on ``+``, ``p.t_end - (x - p.q_start)`` on ``-``.

A read's source body ``[reference_start, reference_end)`` is cut by the pieces
into fragments. Fragments form chain runs (a run breaks on a chain, strand or
primary change, or a target gap of at least ``g_split``); consecutive runs of
one orientation form a row. Inside a run a source gap is a badge (exact
molecular bp from the aligned runs) and a target gap a connector. Calls are
cut at fragment edges; parts keep their call's size and qualities. Parts
separated by gaps of at most ``rejoin_bp`` on both sides are one logical call
and share its record-local ``call_id`` (they count once), but their geometry
stays disconnected: no interval spans a connector or badge (v3.1). Parts
separated by a larger gap are distinct calls, ``<call_id>/<k>``.
The molecule's strand (``st``) never changes; on ``-`` rows only the
presentation flips (left/right edge qualities swap, insertion sequence is
reverse-complemented, clip sides swap).
"""
from __future__ import annotations

import bisect

import numpy as np

_COMPLEMENT = str.maketrans("ACGTNRYKMSWBDHVacgtnrykmswbdhv", "TGCANYRMKSWVHDBtgcanyrmkswvhdb")
# Left/right quality tracks that trade places when intervals reverse (bam_tags.parse_ma_aq_tags_into_layers).
_EDGE_PAIRS = (("lq", "rq"), ("el", "er"))
_SR_LAYERS = {"nuc_sr", "tf_sr"}
_POINT_FIELDS = ("methyl", "methyl_m6a", "methyl_m5c", "possible_deam_ct", "possible_deam_ga")
_ALIGNED_LIST_KEYS = ("annotation_names", "circular_ids")
_SOURCE_SPAN_KEYS = ("source_intervals", "family_intervals")
# Fields lifting replaces (everything else of a decoded read is copied).
_REPLACED = {"intervals", "qualities", "fire", "layers", "deam", "cigar", "sv", "reference_start", "reference_end",
             "alignment_orientation", "alignment_spans", "_fiberbrowser_terminal_gaps", *_POINT_FIELDS}


def revcomp(seq: str) -> str:
    return seq.translate(_COMPLEMENT)[::-1]


class _Frag:
    """A read's source body inside one piece: ``[s, e)`` forward source."""
    __slots__ = ("s", "e", "p", "t0", "t1", "minus")

    def __init__(self, s, e, p):
        self.s, self.e, self.p = s, e, p
        self.minus = p.strand == "-"
        if self.minus:
            self.t0, self.t1 = p.t_end - (e - p.q_start), p.t_end - (s - p.q_start)
        else:
            self.t0, self.t1 = p.t_start + (s - p.q_start), p.t_start + (e - p.q_start)

    def T(self, x):
        p = self.p
        return p.t_end - 1 - (x - p.q_start) if self.minus else p.t_start + (x - p.q_start)

    def B(self, x):
        p = self.p
        return p.t_end - (x - p.q_start) if self.minus else p.t_start + (x - p.q_start)

    def span(self, a, b):
        a, b = max(a, self.s), min(b, self.e)
        if b <= a:
            return None
        return (self.T(b - 1), self.T(a) + 1) if self.minus else (self.T(a), self.T(b - 1) + 1)


class _SeqRuns:
    """A record's aligned runs in SEQ order (hard clips included):
    ``(ref_start, seq_start, len)``, both ascending."""

    def __init__(self, runs, record):
        length, reverse = int(record.get("length") or 0), bool(record.get("reverse"))
        self.length, self.reverse = length, reverse
        rows = sorted((int(r0), (length - 1 - int(m0)) if reverse else int(m0), int(n)) for r0, m0, n in runs or ())
        self.ref = [r[0] for r in rows]
        self.seq = [r[1] for r in rows]
        self.len = [r[2] for r in rows]

    def seq_at(self, x):
        """SEQ index of the first aligned base at reference ``>= x``."""
        i = bisect.bisect_right(self.ref, x) - 1
        if i >= 0 and x < self.ref[i] + self.len[i]:
            return self.seq[i] + (x - self.ref[i])
        if i + 1 < len(self.ref):
            return self.seq[i + 1]
        return self.seq[-1] + self.len[-1] if self.ref else 0

    def mol_between(self, a, b):
        """Molecular bases (aligned or inserted) between source boundaries ``a <= b``."""
        return max(0, self.seq_at(b) - self.seq_at(a)) if self.ref else 0

    def has_aligned(self, mol_start, mol_end):
        """Whether the molecular span ``[mol_start, mol_end)`` holds an aligned base."""
        if not self.ref:
            return False
        a, b = (self.length - mol_end, self.length - mol_start) if self.reverse else (mol_start, mol_end)
        i = bisect.bisect_right(self.seq, b - 1) - 1
        return i >= 0 and self.seq[i] + self.len[i] > a


class _Row:
    """One output row: fragments in source order, grouped into chain runs."""

    def __init__(self, strand, alt):
        self.strand, self.alt = strand, alt
        self.frags, self.run_of = [], []
        self.joinable = []       # joinable[k]: frags k and k+1 rejoin calls
        self.inner = []          # inner[k]: (dq, dt) between frags k, k+1 of one run, else None
        self.badges, self.connectors = [], []

    def add_run(self, run, rejoin_bp):
        if self.frags:
            self.joinable.append(False)
            self.inner.append(None)
        for k, f in enumerate(run):
            if k:
                prev = run[k - 1]
                dq = f.s - prev.e
                dt = (prev.t0 - f.t1) if f.minus else (f.t0 - prev.t1)
                self.joinable.append(dq <= rejoin_bp and dt <= rejoin_bp)
                self.inner.append((dq, dt))
            self.frags.append(f)
            self.run_of.append(len(self.segments_runs) if hasattr(self, "segments_runs") else 0)
        self.segments_runs = getattr(self, "segments_runs", []) + [run]

    def index(self):
        """Lookup tables for the fast paths (fragments disjoint in source order)."""
        self.starts = [f.s for f in self.frags]
        self.disjoint = all(a.e <= b.s for a, b in zip(self.frags, self.frags[1:]))

    def inside(self, a, b):
        """The one fragment holding all of source ``[a, b)``, when fragments are disjoint."""
        if not self.disjoint:
            return None
        k = bisect.bisect_right(self.starts, a) - 1
        if k >= 0 and b <= self.frags[k].e:
            return self.frags[k]
        return None

    # Mapping of source positions (absolute, forward) through this row.
    def point(self, x):
        for f in self.frags:
            if f.s <= x < f.e:
                return f.T(x)
        return None

    def boundary(self, x):
        for f in self.frags:
            if f.s <= x < f.e:
                return f.B(x)
        for f in self.frags:
            if f.e == x or f.s == x:
                return f.B(x)
        return None

    def parts(self, a, b):
        """Target parts ``(t0, t1, logical)`` of source ``[a, b)``, one per
        fragment it crosses; ``logical`` counts the logical calls (parts across
        a joinable gap share it). Geometry is never merged."""
        out = []
        last_k, logical = None, -1
        for k, f in enumerate(self.frags):
            if f.e <= a or f.s >= b:
                continue
            span = f.span(a, b)
            if span is None:
                continue
            if not (out and last_k == k - 1 and self.joinable[k - 1]):
                logical += 1
            out.append((span[0], span[1], logical))
            last_k = k
        return out


def _runs_from_frags(frags, g_split):
    frags = sorted(frags, key=lambda f: (f.s, f.t0))
    runs = []
    for f in frags:
        if runs:
            prev = runs[-1][-1]
            gap = (prev.t0 - f.t1) if f.minus else (f.t0 - prev.t1)
            if (f.p.chain == prev.p.chain and f.p.strand == prev.p.strand and f.p.primary == prev.p.primary
                    and f.s >= prev.e and 0 <= gap < g_split):
                runs[-1].append(f)
                continue
        runs.append([f])
    return runs


def _rows_from_runs(runs, alt, rejoin_bp):
    rows = []
    for run in runs:
        strand = run[0].p.strand
        if not rows or rows[-1].strand != strand:
            rows.append(_Row(strand, alt))
        rows[-1].add_run(run, rejoin_bp)
    return rows


class _Ctx:
    def __init__(self, handle, plan, region_start, region_end, settings, key, dataset_id, molecules, counts,
                 loader_options):
        from services.compact_read_loader import normalize_layer_request, wants_layer

        self.handle, self.plan = handle, plan
        self.selection = plan.selection
        self.region_start, self.region_end = int(region_start), int(region_end)
        self.width = self.region_end - self.region_start
        self.settings, self.key, self.dataset_id = settings, key, dataset_id
        self.molecules = molecules or {}
        self.counts = counts if counts is not None else {}
        opts = dict(loader_options or {})
        self.hide_terminal_gaps = bool(opts.get("hide_terminal_gaps", True))
        self.infer_legacy = bool(opts.get("infer_legacy_layers", True))
        self.nuc_min_size = int(opts.get("legacy_nuc_min_size", 90) or 90)
        self.layer_qualities = bool(opts.get("include_layer_qualities", True))
        include, requested = normalize_layer_request(opts.get("include_layers", True), opts.get("requested_layers"))
        self.wants = {name: wants_layer(include, requested, *aliases) for name, aliases in
                      (("nuc", ("nuc", "footprint")), ("tf", ("tf",)), ("msp", ("msp", "fire")))}
        self.include_layers = include
        self.labels = handle.haplotype_labels if handle is not None else {}
        self.molecule_groups = {}
        self._gap_cache = {}

    def count(self, name, n=1):
        self.counts[name] = self.counts.get(name, 0) + n

    def gap_reason(self, contig, pos):
        key = (contig, pos)
        hit = self._gap_cache.get(key)
        if hit is None:
            hit = self._gap_cache[key] = self.handle.map.gap_span(contig, pos)[0] if self.handle else "unknown"
        return hit

    def outside(self, contig, u0, u1, haps):
        """Where source ``[u0, u1)`` of a read maps outside the selected pieces:
        ``('elsewhere', locus)`` when it lands in the view plus margin through
        another (non-selected) piece, ``None`` when it maps only beyond that,
        else ``(gap reason, None)``."""
        if self.handle is None:
            return ("unknown", None)
        with self.handle.lock:
            pieces = self.handle.map.source_to_target(contig, u0, u1)
        chains, targets = self.handle.map.chains, self.handle.manifest["targets"]
        pieces = [p for p in pieces if chains[p.chain]["haplotype"] in haps]
        if pieces:
            sel = self.selection
            inside = [p for p in pieces if targets[chains[p.chain]["target"]]["name"] == sel.chrom
                      and p.t_end > sel.start and p.t_start < sel.end]
            if not inside:
                return None
            return ("elsewhere", [sel.chrom, min(p.t_start for p in inside), max(p.t_end for p in inside)])
        return (self.gap_reason(contig, u0), None)


def lift_compact_reads(reads, plan, *, handle, region_start, region_end, settings, key, dataset_id,
                       molecules=None, counts=None, loader_options=None, molecule_groups=None) -> list:
    """Lifted rows for decoded source reads (``live_lift.decode_source_records``),
    relative to target ``region_start`` and clipped to the region like a
    native load. One row per (record, orientation run, alternative chain).
    ``molecule_groups``: ``{source path: provenance label}`` (§2.5; default:
    the dataset id)."""
    from services.background_work import checkpoint

    ctx = _Ctx(handle, plan, region_start, region_end, settings, key, dataset_id, molecules, counts, loader_options)
    ctx.molecule_groups = dict(molecule_groups or {})
    by_contig = {contig: sorted(pieces, key=lambda p: (p.q_start, p.q_end)) for contig, pieces in
                 plan.pieces_by_contig().items()}
    haps = {p.hap for pieces in by_contig.values() for p in pieces}
    out = []
    for i, read in enumerate(reads):
        if not i & 255:
            checkpoint()
        out.extend(_lift_read(read, by_contig, haps, ctx))
    return out


def _read_rows(read, pieces, settings):
    """A read's rows: primary fragments, then one row set per alternative chain."""
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    primary_frags, alt_frags = [], {}
    k = bisect.bisect_left([p.q_start for p in pieces], re_)
    for p in pieces[:k]:
        s, e = max(p.q_start, rs), min(p.q_end, re_)
        if e > s:
            (primary_frags if p.primary else alt_frags.setdefault(p.chain, [])).append(_Frag(s, e, p))
    rows = _rows_from_runs(_runs_from_frags(primary_frags, settings.g_split), False, settings.rejoin_bp)
    for chain in sorted(alt_frags):
        rows += _rows_from_runs(_runs_from_frags(alt_frags[chain], settings.g_split), True, settings.rejoin_bp)
    return rows


def project_aligned_runs(read, pieces, settings, *, alternatives=False):
    """A decoded read's aligned bases through its rows' fragments:
    ``[(seq_start, target_start, length, step, row_index)]`` where SEQ index
    ``seq_start + i`` (hard clips included) lands on ``target_start + step*i``.
    The primitive behind lifted coverage and the per-base equivalence harness;
    alternative rows only with ``alternatives``."""
    rec = read.get("_fiberbrowser_lift_record") or {}
    runs = _SeqRuns(read.get("_fiberbrowser_aligned_runs"), rec)
    out = []
    for idx, row in enumerate(_read_rows(read, sorted(pieces, key=lambda p: (p.q_start, p.q_end)), settings)):
        if row.alt and not alternatives:
            continue
        for r0, s0, n in zip(runs.ref, runs.seq, runs.len):
            for f in row.frags:
                a, b = max(r0, f.s), min(r0 + n, f.e)
                if b > a:
                    out.append((s0 + (a - r0), f.T(a), b - a, -1 if f.minus else 1, idx))
    return out


def _lift_read(read, by_contig, haps, ctx):
    rec = read.get("_fiberbrowser_lift_record") or {}
    contig = rec.get("contig")
    runs = _SeqRuns(read.get("_fiberbrowser_aligned_runs"), rec)
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    rows = _read_rows(read, by_contig.get(contig) or [], ctx.settings)
    if not rows:
        ctx.count("records_without_correspondence")
        return []
    for row in rows:
        row.index()
        _row_geometry(row, contig, runs, ctx)
    _outside_badges([r for r in rows if not r.alt], contig, rs, re_, runs, haps, ctx)
    return [_row_payload(read, row, idx, len(rows), contig, runs, ctx) for idx, row in enumerate(rows)]


def _row_geometry(row, contig, runs, ctx):
    """Segments (one per chain run), connectors and inner badges."""
    row.segments = []
    for run in row.segments_runs:
        p = run[0].p
        row.segments.append([min(f.t0 for f in run), max(f.t1 for f in run), p.chain, p.strand, p.primary])
    for k, gap in enumerate(row.inner):
        if gap is None:
            continue
        prev, f = row.frags[k], row.frags[k + 1]
        dq, dt = gap
        if dt > 0:
            row.connectors.append([f.t1, prev.t0] if f.minus else [prev.t1, f.t0])
        if dq > 0:
            pos = prev.t0 if f.minus else prev.t1
            row.badges.append([pos, ctx.gap_reason(contig, prev.e), runs.mol_between(prev.e, f.s), dq, "I"])


def _outside_badges(rows, contig, rs, re_, runs, haps, ctx):
    """Badges for a read's source body outside its primary fragments (§3.5 step 5)."""
    frags = sorted(((f.s, f.e, row, f) for row in rows for f in row.frags), key=lambda x: (x[0], x[1]))
    inner = set()
    for row in rows:
        for k, gap in enumerate(row.inner):
            if gap is not None:
                inner.add((row.frags[k].e, row.frags[k + 1].s))
    uncovered, pos = [], rs
    for s, e, _row, _f in frags:
        if s > pos:
            uncovered.append((pos, s))
        pos = max(pos, e)
    if pos < re_:
        uncovered.append((pos, re_))
    for u0, u1 in uncovered:
        if (u0, u1) in inner:
            continue
        before = [x for x in frags if x[1] == u0]
        after = [x for x in frags if x[0] == u1]
        anchor = before[-1] if before else (after[0] if after else None)
        if anchor is None:
            continue
        where = ctx.outside(contig, u0, u1, haps)
        if where is None:
            continue
        _s, _e, row, f = anchor
        at_end = anchor in before
        pos_t = f.B(u0 if at_end else u1)
        side = ("L" if f.minus else "R") if at_end else ("R" if f.minus else "L")
        badge = [pos_t, where[0], runs.mol_between(u0, u1), u1 - u0, side]
        if where[1] is not None:
            badge.append(where[1])
        row.badges.append(badge)


# ── Field mapping ───────────────────────────────────────────────────────────

def _map_group(ivs, calls, row, base, runs, ctx):
    """``[(t0, t1, i, logical)]``: target parts (region-relative, clipped) of a group's
    intervals ``ivs`` (region-relative source); an insertion-only call (no
    aligned base in its molecular span) is a zero-width marker at its
    insertion boundary. Gaps (negative size) are left out. ``logical`` is
    None for a call drawn as one logical call, else its logical part index.

    Intervals inside one fragment of a row with disjoint fragments (nearly
    all of them) are mapped in one vectorised pass; the rest one by one."""
    if not ivs:
        return []
    width, rs0 = ctx.width, ctx.region_start
    n = len(ivs)
    a = np.fromiter((iv[0] for iv in ivs), dtype=np.int64, count=n) + base
    b = np.fromiter((iv[1] for iv in ivs), dtype=np.int64, count=n) + base
    size = np.fromiter((iv[2] if len(iv) > 2 else 0 for iv in ivs), dtype=np.int64, count=n)
    todo = size >= 0
    out = []
    if row.disjoint and calls is not None:
        # Insertion-only candidates (one reference base) go the slow way.
        slow = todo & (b - a == 1)
    else:
        slow = np.zeros(n, dtype=bool)
    if row.disjoint:
        starts = np.asarray(row.starts, dtype=np.int64)
        ends = np.asarray([f.e for f in row.frags], dtype=np.int64)
        k = np.searchsorted(starts, a, side="right") - 1
        kk = np.maximum(k, 0)
        fast = todo & ~slow & (k >= 0) & (b <= ends[kk])
        if fast.any():
            idx = np.flatnonzero(fast)
            t0 = np.empty(len(idx), dtype=np.int64)
            t1 = np.empty(len(idx), dtype=np.int64)
            for j, f in enumerate(row.frags):
                m = kk[idx] == j
                if not m.any():
                    continue
                p, aa, bb = f.p, a[idx[m]], b[idx[m]]
                if f.minus:
                    t0[m] = p.t_end - 1 - (bb - 1 - p.q_start)
                    t1[m] = p.t_end - 1 - (aa - p.q_start) + 1
                else:
                    t0[m] = p.t_start + (aa - p.q_start)
                    t1[m] = p.t_start + (bb - 1 - p.q_start) + 1
            c0 = np.maximum(t0 - rs0, 0)
            c1 = np.minimum(t1 - rs0, width)
            keep = c1 > c0
            c0, c1, idx = c0[keep], c1[keep], idx[keep]
            order = np.lexsort((idx, c1, c0))
            out = list(zip(c0[order].tolist(), c1[order].tolist(), idx[order].tolist(), [None] * len(order)))
        rest = np.flatnonzero(todo & ~fast)
        if not len(rest):
            return out
    else:
        rest = np.flatnonzero(todo)
    for i in rest.tolist():
        ai, bi = int(a[i]), int(b[i])
        call = calls[i] if calls is not None and i < len(calls) else None
        # An insertion-only call decodes to the one reference base after its insertion.
        if call is not None and bi - ai == 1 and not runs.has_aligned(int(call[1]), int(call[2])):
            t = row.boundary(ai)
            if t is not None and 0 <= t - rs0 <= width:
                out.append((t - rs0, t - rs0, i, None))
            continue
        parts = row.parts(ai, bi)
        split = parts and parts[-1][2] > 0
        for t0, t1, logical in parts:
            c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
            if c1 > c0:
                out.append((c0, c1, i, logical if split else None))
    out.sort(key=lambda x: (x[0], x[1], x[2]))
    return out


def _call_ids(calls, parts):
    """Call ids of mapped parts, in order (``_call_id`` for many)."""
    if not calls:
        return [None] * len(parts)
    base = [c[0] if c else None for c in calls]
    n = len(base)
    return [(base[i] if i < n else None) if logical is None else
            (f"{base[i]}/{logical}" if i < n and base[i] else None) for _t0, _t1, i, logical in parts]


def _call_id(calls, part):
    """The call id of a mapped part (``<id>/<k>`` for a disconnected part)."""
    _t0, _t1, i, logical = part
    call = calls[i] if calls is not None and i < len(calls) else None
    if not call:
        return None
    return call[0] if logical is None else f"{call[0]}/{logical}"


def _swap_pairs(names, layer_name):
    pairs = list(_EDGE_PAIRS)
    if layer_name in _SR_LAYERS:
        pairs.append(("q1", "q2"))
    idx = {n: k for k, n in enumerate(names or ())}
    return [(idx[a], idx[b]) for a, b in pairs if a in idx and b in idx]


def _map_layer(name, layer, row, base, runs, ctx, call_ids_out):
    calls = layer.get("_fiberbrowser_calls")
    parts = _map_group(layer.get("intervals"), calls, row, base, runs, ctx)
    src = layer.get("intervals") or []
    out = {key: value for key, value in layer.items()
           if key not in ("intervals", "qualities", "_fiberbrowser_calls", *_ALIGNED_LIST_KEYS, *_SOURCE_SPAN_KEYS)}
    out["intervals"] = [[t0, t1, *src[i][2:]] for t0, t1, i, _l in parts]
    qualities = layer.get("qualities")
    if qualities is not None:
        tracks = [[track[i] if i < len(track) else 0 for _t0, _t1, i, _l in parts] for track in qualities]
        if row.strand == "-":
            for a, b in _swap_pairs(layer.get("quality_names"), name):
                if a < len(tracks) and b < len(tracks):
                    tracks[a], tracks[b] = tracks[b], tracks[a]
        out["qualities"] = tracks
    for key in _ALIGNED_LIST_KEYS:
        values = layer.get(key)
        if values:
            out[key] = [values[i] if i < len(values) else "" for _t0, _t1, i, _l in parts]
    for key in _SOURCE_SPAN_KEYS:
        values = layer.get(key)
        if values:
            out[key] = [_map_source_span(values[i] if i < len(values) else src[i], (t0, t1), row, base, ctx)
                        for t0, t1, i, _l in parts]
    call_ids_out[f"layer:{name}"] = _call_ids(calls, parts)
    return out


def _map_source_span(src, part, row, base, ctx):
    """A call's unclipped bounds, mapped and reduced to the part of them its
    visible part lies in."""
    t0, t1 = part
    rs0 = ctx.region_start
    pieces = [(a - rs0, b - rs0) for a, b, _l in row.parts(base + int(src[0]), base + int(src[1]))]
    hit = [p for p in pieces if p[0] <= t0 and p[1] >= t1] or [p for p in pieces if p[0] < t1 and p[1] > t0]
    if not hit:
        return [t0, t1, *src[2:]]
    return [min(p[0] for p in hit), max(p[1] for p in hit), *src[2:]]


def _map_points(values, row, base, ctx, pairs=False):
    """Point marks through the row's base map ``T`` (vectorised; first
    fragment holding a position wins, as ``_Row.point``)."""
    if not values:
        return [], 0
    rs0, width = ctx.region_start, ctx.width
    xs = np.asarray([v[0] for v in values] if pairs else values, dtype=np.int64) + base
    t = np.full(len(xs), -1, dtype=np.int64)
    for f in row.frags:
        m = (xs >= f.s) & (xs < f.e) & (t < 0)
        if m.any():
            p = f.p
            t[m] = (p.t_end - 1 - (xs[m] - p.q_start)) if f.minus else (p.t_start + (xs[m] - p.q_start))
    mapped = t >= 0
    dropped = int(len(xs) - mapped.sum())
    rel = t - rs0
    keep = np.flatnonzero(mapped & (rel >= 0) & (rel < width))
    keep = keep[np.argsort(rel[keep], kind="stable")]
    if pairs:
        return [[int(rel[k]), *values[k][1:]] for k in keep.tolist()], dropped
    return rel[keep].tolist(), dropped


def _map_cigar(events, row, base, ctx):
    out, dropped = [], 0
    rs0, width = ctx.region_start, ctx.width
    for ev in events or ():
        kind = ev.get("type")
        x = base + int(ev.get("pos", 0))
        if kind == "I":
            t = row.boundary(x)
            if t is None:
                dropped += 1
                continue
            if 0 <= t - rs0 < width:
                new = dict(ev, pos=t - rs0)
                if row.strand == "-" and ev.get("seq"):
                    new["seq"] = revcomp(ev["seq"])
                out.append(new)
        elif kind == "D":
            parts = row.parts(x, x + int(ev.get("len", 0)))
            if not parts:
                dropped += 1
            for t0, t1, _l in parts:
                c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
                if c1 > c0:
                    out.append(dict(ev, pos=c0, len=c1 - c0))
        # Mismatches (M/X) are source-relative: not emitted in v1 (§3.6).
    out.sort(key=lambda e: (e["pos"], e.get("type", "")))
    return out, dropped


def _map_sv(events, row, ctx):
    """SV events (absolute coordinates). ``SA`` segments move to
    ``live_lift.source.sa``; connectors never enter ``sv``."""
    out, sa, dropped = [], [], 0
    for ev in events or ():
        t = ev.get("t")
        if t == "SA":
            sa.append(ev)
            continue
        if t == "D":
            parts = row.parts(int(ev["ref"]), int(ev["ref"]) + int(ev["len"]))
            if not parts:
                dropped += 1
            for t0, t1, _l in parts:
                out.append(dict(ev, ref=t0, len=t1 - t0))
            continue
        pos = row.boundary(int(ev["ref"]))
        if pos is None:
            dropped += 1
            continue
        new = dict(ev, ref=pos)
        if row.strand == "-":
            if t == "I" and ev.get("seq"):
                new["seq"] = revcomp(ev["seq"])
            if t == "S":
                new["side"] = "R" if ev.get("side") == "L" else "L"
        out.append(new)
    out.sort(key=lambda e: (e.get("ref", 0), e.get("t", "")))
    return out, sa, dropped


def _body_spans(row, ctx):
    """Region-relative continuous body spans: segments minus connectors, also
    cut at inner badges (a gap interval never bridges unprojected sequence)."""
    rs0 = ctx.region_start
    spans = []
    for s0, s1, *_rest in row.segments:
        cuts = sorted([(c0, c1) for c0, c1 in row.connectors if c0 >= s0 and c1 <= s1]
                      + [(b[0], b[0]) for b in row.badges if b[4] == "I" and s0 < b[0] < s1])
        pos = s0
        for c0, c1 in cuts:
            if c0 > pos:
                spans.append((pos - rs0, c0 - rs0))
            pos = max(pos, c1)
        if s1 > pos:
            spans.append((pos - rs0, s1 - rs0))
    return sorted(spans)


def _with_gaps(intervals, spans, hide_terminal_gaps, width):
    """Footprint intervals plus the gaps between consecutive ones inside one
    continuous body span (never across a badge, connector or split)."""
    out = []
    for b0, b1 in spans:
        inside = [iv for iv in intervals if iv[0] >= b0 and iv[1] <= b1 and iv[2] > 0]
        prev = None if hide_terminal_gaps else b0
        for iv in inside:
            if prev is not None and iv[0] > prev:
                out.append([max(prev, 0), min(iv[0], width), -(iv[0] - prev)])
            prev = iv[1] if prev is None else max(prev, iv[1])
        if not hide_terminal_gaps and prev is not None and b1 > prev:
            out.append([max(prev, 0), min(b1, width), -(b1 - prev)])
    return [iv for iv in out if iv[1] > iv[0]]


def _row_payload(read, row, idx, count, contig, runs, ctx):
    from services.bam_tags import infer_legacy_layers_from_intervals

    base = int(read["_fiberbrowser_source_base"])
    rs0, width = ctx.region_start, ctx.width
    calls = read.get("_fiberbrowser_calls") or {}
    call_ids = {}
    dropped = {"points": 0, "events": 0}
    payload = {k: v for k, v in read.items() if k not in _REPLACED and not k.startswith("_fiberbrowser_")}

    # Top-level footprints: positive (and neutral size-0) intervals, gaps re-derived per body span.
    ivs = read.get("intervals") or []
    iv_calls = calls.get("intervals")
    parts = _map_group(ivs, iv_calls, row, base, runs, ctx)
    quals = read.get("qualities") or []
    rank, n = {}, 0
    for i, iv in enumerate(ivs):
        if len(iv) > 2 and iv[2] > 0:
            rank[i] = n
            n += 1
    spans = _body_spans(row, ctx)
    mapped = [[t0, t1, *ivs[i][2:]] for t0, t1, i, _l in parts]
    gaps = _with_gaps(mapped, [(max(a, 0), min(b, width)) for a, b in spans], ctx.hide_terminal_gaps, width)
    combined = mapped + gaps
    order = sorted(range(len(combined)), key=lambda j: (combined[j][0], combined[j][1], j))
    payload["intervals"] = [combined[j] for j in order]
    part_of = {j: parts[j][2] for j in range(len(parts))}
    part_ids = _call_ids(iv_calls, parts)
    payload_calls = [part_ids[j] if j < len(parts) else None for j in order]
    call_ids["intervals"] = payload_calls
    if quals:
        payload["qualities"] = [quals[rank[part_of[j]]] for j in order
                                if j in part_of and part_of[j] in rank and rank[part_of[j]] < len(quals)]

    if read.get("fire") is not None:
        fire_calls = calls.get("fire")
        fparts = _map_group(read["fire"], fire_calls, row, base, runs, ctx)
        payload["fire"] = [[t0, t1, *read["fire"][i][2:]] for t0, t1, i, _l in fparts]
        call_ids["fire"] = _call_ids(fire_calls, fparts)

    layers = {}
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            layers[name] = _map_layer(name, layer, row, base, runs, ctx, call_ids)
    legacy = read.get("_fiberbrowser_legacy")
    if ctx.infer_legacy and ctx.include_layers and legacy is not None:
        _infer_legacy(read, layers, payload, call_ids, spans, legacy, row, ctx, infer_legacy_layers_from_intervals)
    if read.get("layers") is not None or layers:
        payload["layers"] = layers

    for key in _POINT_FIELDS:
        if key in read:
            payload[key], d = _map_points(read[key], row, base, ctx)
            dropped["points"] += d
    if "deam" in read:
        payload["deam"], d = _map_points(read["deam"], row, base, ctx, pairs=True)
        dropped["points"] += d
    if "cigar" in read:
        payload["cigar"], d = _map_cigar(read["cigar"], row, base, ctx)
        dropped["events"] += d
    sa = []
    if "sv" in read:
        payload["sv"], sa, d = _map_sv(read["sv"], row, ctx)
        dropped["events"] += d
        if not payload["sv"]:
            del payload["sv"]
    if "_fiberbrowser_terminal_gaps" in read:
        gaps_t = []
        for a, b in read["_fiberbrowser_terminal_gaps"]:
            gaps_t += [[t0, t1] for t0, t1, _l in row.parts(int(a), int(b))]
        payload["_fiberbrowser_terminal_gaps"] = sorted(gaps_t)

    hull0 = min(s[0] for s in row.segments)
    hull1 = max(s[1] for s in row.segments)
    payload["reference_start"], payload["reference_end"] = hull0, hull1
    record_reverse = read.get("alignment_orientation") == "reverse"
    payload["alignment_orientation"] = "reverse" if record_reverse != (row.strand == "-") else "forward"
    body = []
    for a, b in spans:  # badge cuts are zero-width: rejoin touching spans
        if body and body[-1][1] == a + rs0:
            body[-1][1] = b + rs0
        else:
            body.append([a + rs0, b + rs0])
    payload["alignment_spans"] = body

    # Identity components (§3.4 v3.1) and molecule metadata (§3.5): haplotype
    # and strand are the primary record's. ``analysis_id`` is assigned per
    # fold mode later (P2, prepare_lift_cohort), not here.
    library = read.get("library_id") or read.get("source_path") or ""
    qname = read.get("id")
    group = ctx.molecule_groups.get(read.get("source_path")) or ctx.molecule_groups.get(library) or ctx.dataset_id
    molecule = f"{group}|{qname}"
    mol_meta = ctx.molecules.get((library, qname)) or {}
    record_hap = row.frags[0].p.hap
    hap = mol_meta.get("hap") or record_hap
    if mol_meta.get("strand") is not None:
        payload["strand"] = mol_meta["strand"]
    sha, occ = read.get("record_sha256"), read.get("alignment_occurrence")
    record = f"{sha}:{occ}" if sha else f"{read.get('reference_start')}-{read.get('reference_end')}"
    placement = f"alt{row.frags[0].p.chain}" if row.alt else str(
        next((seg[2] for seg in row.segments if seg[4]), row.segments[0][2]))
    prim = read.get("_fiberbrowser_primary") or {}
    payload["live_lift"] = {
        "v": 1,
        "key": ctx.key,
        "hap": hap,
        "hap_label": ctx.labels.get(hap, hap),
        "hap_source": mol_meta.get("source") or "record",
        "alt": row.alt,
        "placement": placement,
        "molecule": molecule,
        "record": record,
        "row_index": idx,
        "row_count": count,
        "source": {"contig": contig, "start": int(read["reference_start"]), "end": int(read["reference_end"]),
                   "orientation": read.get("alignment_orientation"),
                   "supplementary": bool(prim.get("is_supplementary")), "sa": sa or None},
        "segments": [[s0 - rs0, s1 - rs0, chain, strand, primary] for s0, s1, chain, strand, primary in row.segments],
        "connectors": [[c0 - rs0, c1 - rs0] for c0, c1 in sorted(row.connectors)],
        "badges": [[b[0] - rs0, *b[1:]] for b in sorted(row.badges, key=lambda b: b[0])],
        "calls": call_ids,
        "dropped": dropped,
    }
    return payload


def _infer_legacy(read, layers, payload, call_ids, spans, legacy, row, ctx, infer):
    """Legacy nuc/tf/msp inference from ns/nl footprints, per continuous body
    span after lifting (the loader ran with it off), so no MSP bridges a
    badge, connector or split."""
    ma_names = set(legacy.get("ma_names") or ())
    wants = ctx.wants
    infer_nuc = wants["nuc"] and "nuc" not in ma_names and "nuc" not in layers
    infer_tf = wants["tf"] and "tf" not in ma_names and "tf" not in layers
    infer_msp = (wants["msp"] and not legacy.get("explicit_msp") and "msp" not in ma_names and "msp" not in layers)
    if not (infer_nuc or infer_tf or infer_msp):
        return
    edge = read.get("_fiberbrowser_edge_qualities") or {}
    ivs, ids, quals = payload["intervals"], call_ids.get("intervals") or [], payload.get("qualities") or []
    pos = [k for k, iv in enumerate(ivs) if iv[2] > 0]
    nq = {k: quals[r] for r, k in enumerate(pos) if r < len(quals)}
    merged: dict = {}
    for b0, b1 in spans:
        idx = [k for k in pos if ivs[k][0] >= b0 and ivs[k][1] <= b1]
        if not idx:
            continue
        names, tracks = [], []
        if ctx.layer_qualities:
            if nq:
                names.append("nq")
                tracks.append([nq.get(k, 0) for k in idx])
            if edge:
                base_ids = [ids[k].split("/")[0] if k < len(ids) and ids[k] else None for k in idx]
                lq = [edge.get(cid, [0, 0])[0] for cid in base_ids]
                rq = [edge.get(cid, [0, 0])[1] for cid in base_ids]
                if row.strand == "-":
                    lq, rq = rq, lq
                names += ["lq", "rq"]
                tracks += [lq, rq]
        inferred = infer([ivs[k] for k in idx], quality_names=names, qualities=tracks, nuc_min_size=ctx.nuc_min_size,
                         infer_tf=infer_tf, infer_nuc=infer_nuc, infer_msp=infer_msp)
        size_class = {"nuc": lambda s: s >= ctx.nuc_min_size, "tf": lambda s: s < ctx.nuc_min_size}
        for name, layer in inferred.items():
            m = merged.setdefault(name, {"intervals": [], "qualities": None, "quality_names": layer["quality_names"],
                                         "_ids": []})
            m["intervals"] += layer["intervals"]
            if layer.get("qualities"):
                m["qualities"] = [a + b for a, b in zip(m["qualities"] or [[] for _ in layer["qualities"]],
                                                         layer["qualities"])]
            if name in size_class:
                m["_ids"] += [ids[k] if k < len(ids) else None for k in idx if size_class[name](ivs[k][2])]
            else:
                m["_ids"] += [None] * len(layer["intervals"])
    for name, m in merged.items():
        call_ids[f"layer:{name}"] = m.pop("_ids")
        layers[name] = m
