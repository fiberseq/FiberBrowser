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
primary change, a backwards step, or a target gap of at least ``g_split``);
consecutive runs of one orientation form a row unless a run overlaps the row
in target coordinates. Inside a run a source gap is a badge (exact molecular
bp from the aligned runs) and a target gap a connector; a *span* is a stretch
of fragments with neither between them.

Calls are cut at fragment edges; every part keeps its call's immutable,
record-local ``call_id`` (``live_lift.calls``), size and qualities. Logical
identity is separate and selection-independent (``live_lift.call_parts``,
``[part, group]`` as molecular coordinates): ``part`` is where the part starts
on the molecule; parts joined across gaps of at most ``rejoin_bp`` on both
sides (and the pieces of a call the decoder split at a deletion) share
``group``. Geometry is never merged: no interval spans a connector or badge
(v3.1). Gaps and inferred MSPs are rebuilt per span from whole calls, then
cut at the read's deletions, as the native decoder does.

The molecule's strand (``st``) never changes; on ``-`` rows only the
presentation flips (left/right edge qualities swap, insertion sequence is
reverse-complemented, clip sides swap).
"""
from __future__ import annotations

import bisect
import copy
from contextlib import ExitStack

import numpy as np

_COMPLEMENT = str.maketrans("ACGTNRYKMSWBDHVacgtnrykmswbdhv", "TGCANYRMKSWVHDBtgcanyrmkswvhdb")
# Left/right quality tracks that trade places when intervals reverse (bam_tags.parse_ma_aq_tags_into_layers).
_EDGE_PAIRS = (("lq", "rq"), ("el", "er"))
_SR_LAYERS = {"nuc_sr", "tf_sr"}
# ``methyl`` is the loader's alias of one of these; it is derived after lifting.
_POINT_FIELDS = ("methyl_m6a", "methyl_m5c", "possible_deam_ct", "possible_deam_ga")
_ALIGNED_LIST_KEYS = ("annotation_names", "circular_ids")
_SOURCE_SPAN_KEYS = ("source_intervals", "family_intervals")
# Fields lifting replaces (everything else of a decoded read is copied).
_REPLACED = {"intervals", "qualities", "fire", "layers", "deam", "cigar", "sv", "reference_start", "reference_end",
             "alignment_orientation", "alignment_spans", "_fiberbrowser_terminal_gaps", "methyl", "strand",
             "strand_conflict", *_POINT_FIELDS}
# Below this many intervals a group is mapped with plain Python (numpy setup costs more).
_SMALL_GROUP = 24


def revcomp(seq: str) -> str:
    return seq.translate(_COMPLEMENT)[::-1]


class _Frag:
    """A read's source body inside one piece: ``[s, e)`` forward source."""
    __slots__ = ("s", "e", "p", "t0", "t1", "minus", "span")

    def __init__(self, s, e, p):
        self.s, self.e, self.p = s, e, p
        self.minus = p.strand == "-"
        self.span = 0
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

    def span_of(self, a, b):
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
        self._arrays = None

    def seq_at(self, x):
        """SEQ index of the first aligned base at reference ``>= x``."""
        i = bisect.bisect_right(self.ref, x) - 1
        if i >= 0 and x < self.ref[i] + self.len[i]:
            return self.seq[i] + (x - self.ref[i])
        if i + 1 < len(self.ref):
            return self.seq[i + 1]
        return self.seq[-1] + self.len[-1] if self.ref else 0

    def mol_at(self, x):
        """Molecular coordinate of the first aligned base at reference ``>= x``."""
        seq = self.seq_at(x)
        return self.length - 1 - seq if self.reverse else seq

    def mol_at_many(self, xs):
        """``mol_at`` for many positions at once."""
        if not self.ref:
            return [0] * len(xs)
        # Every annotation group asks about these same CIGAR runs. Materialise
        # their arrays once per source record, not once per group/placement.
        if self._arrays is None:
            self._arrays = tuple(np.asarray(v, dtype=np.int64) for v in (self.ref, self.seq, self.len))
        ref, seq, ln = self._arrays
        x = np.asarray(xs, dtype=np.int64)
        i = np.searchsorted(ref, x, side="right") - 1
        ii = np.maximum(i, 0)
        inside = (i >= 0) & (x < ref[ii] + ln[ii])
        nxt = np.minimum(i + 1, len(ref) - 1)
        after = seq[nxt]
        end = seq[-1] + ln[-1]
        out = np.where(inside, seq[ii] + (x - ref[ii]), np.where(i + 1 < len(ref), after, end))
        if self.reverse:
            out = self.length - 1 - out
        return out.tolist()

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
        self.frags, self.runs = [], []
        self.joinable = []       # joinable[k]: frags k and k+1 rejoin calls
        self.inner = []          # inner[k]: (dq, dt) between frags k, k+1 of one run, else None
        self.badges, self.connectors = [], []
        self.badge_sources = []  # source spans parallel to badges; never part of analysis geometry

    def add_run(self, run, rejoin_bp):
        span = self.frags[-1].span + 1 if self.frags else 0
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
                if dq or dt:
                    span += 1
            f.span = span
            self.frags.append(f)
        self.runs.append(run)

    def overlaps(self, run):
        lo, hi = min(f.t0 for f in run), max(f.t1 for f in run)
        return any(f.t0 < hi and f.t1 > lo for f in self.frags)

    def index(self):
        self.starts = [f.s for f in self.frags]
        self.ends = [f.e for f in self.frags]
        self.disjoint = all(a.e <= b.s for a, b in zip(self.frags, self.frags[1:]))

    def boundary(self, x):
        """``(frag index, B(x))`` of the first fragment holding or touching ``x``."""
        for k, f in enumerate(self.frags):
            if f.s <= x < f.e:
                return k, f.B(x)
        for k, f in enumerate(self.frags):
            if f.e == x or f.s == x:
                return k, f.B(x)
        return None

    def parts(self, a, b):
        """Target parts ``(t0, t1, frag index)`` of source ``[a, b)``, one per fragment."""
        out = []
        for k, f in enumerate(self.frags):
            if f.e <= a or f.s >= b:
                continue
            span = f.span_of(a, b)
            if span is not None:
                out.append((span[0], span[1], k))
        return out

    def group_start(self, k, lo):
        """First fragment of the rejoin group frag ``k`` belongs to, for a call
        whose source extent starts at ``lo``."""
        while k > 0 and self.joinable[k - 1] and self.frags[k - 1].e > lo:
            k -= 1
        return k


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
    """Consecutive runs of one orientation share a row, unless the run overlaps
    the row in target coordinates (a tandem duplication): then a new row."""
    rows = []
    for run in runs:
        strand = run[0].p.strand
        if not rows or rows[-1].strand != strand or rows[-1].overlaps(run):
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
        self.loader_options = opts

    def count(self, name, n=1):
        self.counts[name] = self.counts.get(name, 0) + n

    def gap_reason(self, contig, pos):
        key = (contig, pos)
        hit = self._gap_cache.get(key)
        if hit is None:
            if self.handle is None:
                hit = "unknown"
            else:
                with self.handle.lock:  # gap_span may load another target's file
                    hit = self.handle.map.gap_span(contig, pos)[0]
            self._gap_cache[key] = hit
        return hit

    def projections(self, contig, a, b, haps):
        with self.handle.lock:
            pieces = self.handle.map.source_to_target(contig, a, b)
        chains = self.handle.map.chains
        return [p for p in pieces if chains[p.chain]["haplotype"] in haps]

    def outside(self, contig, u0, u1, haps, adjacent):
        """Where source ``[u0, u1)`` of a read maps outside the selected pieces:
        ``('elsewhere', locus)`` when it lands in the view plus margin through
        another (non-selected) piece; otherwise, when the base ``adjacent`` to
        the anchoring fragment has no projection, ``(gap reason, None)``;
        ``None`` when the part just continues beyond the view plus margin."""
        if self.handle is None:
            return ("unknown", None)
        pieces = self.projections(contig, u0, u1, haps)
        chains, targets = self.handle.map.chains, self.handle.manifest["targets"]
        sel = self.selection
        inside = [p for p in pieces if targets[chains[p.chain]["target"]]["name"] == sel.chrom
                  and p.t_end > sel.start and p.t_start < sel.end]
        if inside:
            return ("elsewhere", [sel.chrom, min(p.t_start for p in inside), max(p.t_end for p in inside)])
        if pieces and self.projections(contig, adjacent, adjacent + 1, haps):
            return None
        return (self.gap_reason(contig, adjacent), None)


def lift_compact_reads(reads, plan, *, handle, region_start, region_end, settings, key, dataset_id,
                       molecules=None, counts=None, loader_options=None, molecule_groups=None) -> list:
    """Lifted rows for decoded source reads (``live_lift.decode_source_records``),
    relative to target ``region_start`` and clipped to the region like a
    native load. One row per (record, orientation run, placement).
    ``molecules``: resolved primary metadata by ``(library, QNAME)``;
    ``molecule_groups``: ``{source path: provenance label}`` (§2.5; default:
    the dataset id)."""
    from services.background_work import checkpoint

    ctx = _Ctx(handle, plan, region_start, region_end, settings, key, dataset_id, molecules, counts, loader_options)
    ctx.molecule_groups = dict(molecule_groups or {})
    by_contig = {}
    for contig, pieces in plan.pieces_by_contig().items():
        pieces = sorted(pieces, key=lambda p: (p.q_start, p.q_end))
        by_contig[contig] = (pieces, [p.q_start for p in pieces])
    haps = {p.hap for pieces, _starts in by_contig.values() for p in pieces}
    out = []
    with ExitStack() as stack:
        ctx.source_fasta = None
        if ctx.loader_options.get("include_cigar") and ctx.loader_options.get("source_fasta"):
            import pysam
            ctx.source_fasta = stack.enter_context(pysam.FastaFile(ctx.loader_options["source_fasta"]))
        for i, read in enumerate(reads):
            if not i & 255:
                checkpoint()
            out.extend(_lift_read(read, by_contig, haps, ctx))
    return out


def _read_rows(read, indexed, settings):
    """A read's rows: primary fragments, then one row set per alternative chain."""
    pieces, starts = indexed
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    primary_frags, alt_frags = [], {}
    for p in pieces[:bisect.bisect_left(starts, re_)]:
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
    pieces = sorted(pieces, key=lambda p: (p.q_start, p.q_end))
    out = []
    for idx, row in enumerate(_read_rows(read, (pieces, [p.q_start for p in pieces]), settings)):
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
    rows = _read_rows(read, by_contig.get(contig) or ([], []), ctx.settings)
    if not rows:
        ctx.count("records_without_correspondence")
        return []
    for row in rows:
        row.index()
        _row_geometry(row, contig, runs, ctx)
    _outside_badges([r for r in rows if not r.alt], contig, rs, re_, runs, haps, ctx)
    key = (read.get("library_id") or read.get("source_path") or "", read.get("id"))
    if key not in ctx.molecules and (read.get("_fiberbrowser_primary") or {}).get("is_supplementary"):
        ctx.count("hap_from_record")
    # Row numbering is per placement (primary, or each alternative chain).
    numbering, per_placement = [], {}
    for row in rows:
        placement = _placement(row)
        numbering.append((placement, per_placement.get(placement, 0)))
        per_placement[placement] = per_placement.get(placement, 0) + 1
    call_lo = _call_starts(read)
    return [_row_payload(read, row, placement, idx, per_placement[placement], contig, runs, call_lo, ctx)
            for row, (placement, idx) in zip(rows, numbering)]


def _placement(row):
    if row.alt:
        return f"alt{row.frags[0].p.chain}"
    return str(next((f.p.chain for f in row.frags if f.p.primary), row.frags[0].p.chain))


def _call_starts(read):
    """Per interval group, ``{call_id: lowest source start}`` (relative to the
    decode base) over all pieces the decoder cut a call into."""
    out = {}
    calls = read.get("_fiberbrowser_calls") or {}
    groups = [("intervals", read.get("intervals"), calls.get("intervals")),
              ("fire", read.get("fire"), calls.get("fire"))]
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            groups.append((f"layer:{name}", layer.get("intervals"), layer.get("_fiberbrowser_calls")))
    for group, ivs, ids in groups:
        lo = {}
        for iv, call in zip(ivs or (), ids or ()):
            if call:
                lo[call[0]] = min(lo.get(call[0], iv[0]), iv[0])
        out[group] = lo
    return out


def _row_geometry(row, contig, runs, ctx):
    """Segments (one per chain run), connectors and inner badges."""
    row.segments = []
    for run in row.runs:
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
            row.badge_sources.append((prev.e, f.s, prev.p))


def _outside_badges(rows, contig, rs, re_, runs, haps, ctx):
    """Badges for a read's source body outside its primary fragments (§3.5
    step 5). Between two rows, both flanking rows get the badge."""
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
        anchors = []
        if before:
            anchors.append((before[-1], True))
        if after and not (before and after[0][2] is before[-1][2]):
            anchors.append((after[0], False))
        for (_s, _e, row, f), at_end in anchors:
            where = ctx.outside(contig, u0, u1, haps, u0 if at_end else u1 - 1)
            if where is None:
                continue
            pos_t = f.B(u0 if at_end else u1)
            side = ("L" if f.minus else "R") if at_end else ("R" if f.minus else "L")
            badge = [pos_t, where[0], runs.mol_between(u0, u1), u1 - u0, side]
            if where[1] is not None:
                badge.append(where[1])
            row.badges.append(badge)
            row.badge_sources.append((u0, u1, f.p))


# ── Field mapping ───────────────────────────────────────────────────────────

def _map_group(ivs, calls, row, base, runs, ctx):
    """``[(t0, t1, i, k)]``: target parts (region-relative, clipped) of a
    group's intervals ``ivs`` (region-relative source), with the interval index
    ``i`` and the fragment ``k`` each came from; an insertion-only call (no
    aligned base in its molecular span) is a zero-width marker at its
    insertion boundary. Gaps (negative size) are left out.

    Intervals inside one fragment of a row with disjoint fragments (nearly all)
    are mapped in one pass, vectorised for large groups; the rest one by one."""
    if not ivs:
        return []
    width, rs0 = ctx.width, ctx.region_start
    out, rest = [], []
    if row.disjoint and len(ivs) <= _SMALL_GROUP:
        starts, ends, frags = row.starts, row.ends, row.frags
        for i, iv in enumerate(ivs):
            if len(iv) > 2 and iv[2] < 0:
                continue
            a, b = base + iv[0], base + iv[1]
            k = bisect.bisect_right(starts, a) - 1
            if k < 0 or b > ends[k] or (b - a == 1 and calls is not None):
                rest.append(i)
                continue
            t0, t1 = frags[k].span_of(a, b)
            c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
            if c1 > c0:
                out.append((c0, c1, i, k))
    elif row.disjoint:
        n = len(ivs)
        a = np.fromiter((iv[0] for iv in ivs), dtype=np.int64, count=n) + base
        b = np.fromiter((iv[1] for iv in ivs), dtype=np.int64, count=n) + base
        size = np.fromiter((iv[2] if len(iv) > 2 else 0 for iv in ivs), dtype=np.int64, count=n)
        todo = size >= 0
        # Insertion-only candidates (one reference base) go the slow way.
        slow = todo & (b - a == 1) if calls is not None else np.zeros(n, dtype=bool)
        k = np.searchsorted(np.asarray(row.starts, dtype=np.int64), a, side="right") - 1
        kk = np.maximum(k, 0)
        fast = todo & ~slow & (k >= 0) & (b <= np.asarray(row.ends, dtype=np.int64)[kk])
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
                    t1[m] = p.t_end - (aa - p.q_start)
                else:
                    t0[m] = p.t_start + (aa - p.q_start)
                    t1[m] = p.t_start + (bb - p.q_start)
            c0 = np.maximum(t0 - rs0, 0)
            c1 = np.minimum(t1 - rs0, width)
            keep = c1 > c0
            out = list(zip(c0[keep].tolist(), c1[keep].tolist(), idx[keep].tolist(), kk[idx[keep]].tolist()))
        rest = np.flatnonzero(todo & ~fast).tolist()
    else:
        rest = [i for i, iv in enumerate(ivs) if not (len(iv) > 2 and iv[2] < 0)]
    for i in rest:
        ai, bi = base + int(ivs[i][0]), base + int(ivs[i][1])
        call = calls[i] if calls is not None and i < len(calls) else None
        # An insertion-only call decodes to the one reference base after its insertion.
        if call is not None and bi - ai == 1 and not runs.has_aligned(int(call[1]), int(call[2])):
            hit = row.boundary(ai)
            if hit is not None and 0 <= hit[1] - rs0 <= width:
                out.append((hit[1] - rs0, hit[1] - rs0, i, hit[0]))
            continue
        for t0, t1, k in row.parts(ai, bi):
            c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
            if c1 > c0:
                out.append((c0, c1, i, k))
    out.sort()
    return out


def _call_identity(calls, ivs, parts, row, base, runs, lo):
    """``(call ids, call parts)`` of mapped parts: the immutable record-local
    id, and ``[part, group]`` molecular keys (§3.5 v3.1). ``part`` is the
    molecular coordinate of the part's first source base; ``group`` that of the
    first part of its rejoin group (walking back over joinable gaps while the
    call extends there). Both depend only on the record and the chain, never on
    the view or the clipping."""
    n = len(parts)
    if not calls or not n:
        return [None] * n, [None] * n
    frags, joinable = row.frags, row.joinable
    ncalls = len(calls)
    ids, part_src, group_src, special = [], [], [], {}
    for j, (_t0, _t1, i, k) in enumerate(parts):
        call = calls[i] if i < ncalls else None
        iv = ivs[i]
        if not call:
            ids.append(None)
            special[j] = None
            part_src.append(0)
            group_src.append(0)
            continue
        ids.append(call[0])
        if iv[1] - iv[0] == 1 and not runs.has_aligned(int(call[1]), int(call[2])):
            special[j] = [int(call[1]), int(call[1])]  # insertion-only: its own molecular start
        a = base + iv[0]
        f = frags[k]
        part_src.append(a if a > f.s else f.s)
        first = base + lo.get(call[0], iv[0])
        g = row.group_start(k, first) if k and joinable[k - 1] else k
        group_src.append(max(first, frags[g].s))
    mols = runs.mol_at_many(part_src + group_src)
    keys = [special[j] if j in special else [mols[j], mols[n + j]] for j in range(n)]
    return ids, keys


def _swap_pairs(names, layer_name):
    pairs = list(_EDGE_PAIRS)
    if layer_name in _SR_LAYERS:
        pairs.append(("q1", "q2"))
    idx = {n: k for k, n in enumerate(names or ())}
    return [(idx[a], idx[b]) for a, b in pairs if a in idx and b in idx]


def _map_layer(name, layer, row, base, runs, ctx, lo, ids_out, parts_out):
    calls = layer.get("_fiberbrowser_calls")
    parts = _map_group(layer.get("intervals"), calls, row, base, runs, ctx)
    src = layer.get("intervals") or []
    out = {key: value for key, value in layer.items()
           if key not in ("intervals", "qualities", "_fiberbrowser_calls", *_ALIGNED_LIST_KEYS, *_SOURCE_SPAN_KEYS)}
    out["intervals"] = [[t0, t1, *src[i][2:]] for t0, t1, i, _k in parts]
    qualities = layer.get("qualities")
    if qualities is not None:
        tracks = [[track[i] if i < len(track) else 0 for _t0, _t1, i, _k in parts] for track in qualities]
        if row.strand == "-":
            for a, b in _swap_pairs(layer.get("quality_names"), name):
                if a < len(tracks) and b < len(tracks):
                    tracks[a], tracks[b] = tracks[b], tracks[a]
        out["qualities"] = tracks
    for key in _ALIGNED_LIST_KEYS:
        values = layer.get(key)
        if values:
            out[key] = [values[i] if i < len(values) else "" for _t0, _t1, i, _k in parts]
    for key in _SOURCE_SPAN_KEYS:
        values = layer.get(key)
        if values:
            out[key] = [_map_source_span(values[i] if i < len(values) else src[i], (t0, t1), row, base, ctx)
                        for t0, t1, i, _k in parts]
    ids_out[f"layer:{name}"], parts_out[f"layer:{name}"] = _call_identity(calls, src, parts, row, base, runs, lo)
    return out


def _map_source_span(src, part, row, base, ctx):
    """A call's unclipped bounds, mapped and reduced to the part of them its
    visible part lies in."""
    t0, t1 = part
    rs0 = ctx.region_start
    pieces = [(a - rs0, b - rs0) for a, b, _k in row.parts(base + int(src[0]), base + int(src[1]))]
    hit = [p for p in pieces if p[0] <= t0 and p[1] >= t1] or [p for p in pieces if p[0] < t1 and p[1] > t0]
    if not hit:
        return [t0, t1, *src[2:]]
    return [min(p[0] for p in hit), max(p[1] for p in hit), *src[2:]]


def _map_points(values, row, base, ctx, pairs=False):
    """Point marks through the row's base map ``T``. A base on several
    fragments (overlapping primary projections) gets a mark at each, as its
    intervals do; dropped counts marks on no fragment."""
    if not values:
        return [], 0
    rs0, width = ctx.region_start, ctx.width
    if row.disjoint and len(values) <= _SMALL_GROUP:
        out, dropped = [], 0
        for v in values:
            x = base + (v[0] if pairs else v)
            k = bisect.bisect_right(row.starts, x) - 1
            if k < 0 or x >= row.ends[k]:
                dropped += 1
                continue
            rel = row.frags[k].T(x) - rs0
            if 0 <= rel < width:
                out.append([rel, *v[1:]] if pairs else rel)
        out.sort()
        return out, dropped
    xs = np.asarray([v[0] for v in values] if pairs else values, dtype=np.int64) + base
    hits = np.zeros(len(xs), dtype=bool)
    rels, idxs = [], []
    for f in row.frags:
        m = (xs >= f.s) & (xs < f.e)
        if not m.any():
            continue
        hits |= m
        p = f.p
        sel = np.flatnonzero(m)
        t = (p.t_end - 1 - (xs[sel] - p.q_start)) if f.minus else (p.t_start + (xs[sel] - p.q_start))
        rels.append(t - rs0)
        idxs.append(sel)
    dropped = int(len(xs) - hits.sum())
    if not rels:
        return [], dropped
    rel = np.concatenate(rels)
    idx = np.concatenate(idxs)
    keep = (rel >= 0) & (rel < width)
    rel, idx = rel[keep], idx[keep]
    order = np.argsort(rel, kind="stable")
    if pairs:
        return [[r, *values[i][1:]] for r, i in zip(rel[order].tolist(), idx[order].tolist())], dropped
    return rel[order].tolist(), dropped


def _map_cigar(events, row, base, ctx):
    out, dropped = [], 0
    rs0, width = ctx.region_start, ctx.width
    for ev in events or ():
        kind = ev.get("type")
        x = base + int(ev.get("pos", 0))
        if kind == "I":
            hit = row.boundary(x)
            if hit is None:
                dropped += 1
                continue
            if 0 <= hit[1] - rs0 < width:
                new = dict(ev, pos=hit[1] - rs0, source="reads")
                if row.strand == "-" and ev.get("seq"):
                    new["seq"] = revcomp(ev["seq"])
                out.append(new)
        elif kind == "D":
            parts = row.parts(x, x + int(ev.get("len", 0)))
            if not parts:
                dropped += 1
            for t0, t1, _k in parts:
                c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
                if c1 > c0:
                    out.append(dict(ev, pos=c0, len=c1 - c0, source="reads"))
        # Native M/X are relative to HG002. row_mismatches compares SEQ/MD
        # with the loaded target FASTA and emits the target-relative X markers.
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
            for t0, t1, _k in parts:
                out.append(dict(ev, ref=t0, len=t1 - t0, source="reads"))
            continue
        hit = row.boundary(int(ev["ref"]))
        if hit is None:
            dropped += 1
            continue
        new = dict(ev, ref=hit[1], source="reads")
        if row.strand == "-":
            if t == "I" and ev.get("seq"):
                new["seq"] = revcomp(ev["seq"])
            if t == "S":
                new["side"] = "R" if ev.get("side") == "L" else "L"
        out.append(new)
    out.sort(key=lambda e: (e.get("ref", 0), e.get("t", "")))
    return out, sa, dropped


def _spans(row, ctx):
    """``{span id: (t0, t1)}`` region-relative body spans (fragments with no
    connector or badge between them)."""
    rs0 = ctx.region_start
    spans = {}
    for f in row.frags:
        lo, hi = spans.get(f.span, (f.t0, f.t1))
        spans[f.span] = (min(lo, f.t0), max(hi, f.t1))
    return {k: (a - rs0, b - rs0) for k, (a, b) in spans.items()}


def _subtract(iv, cuts):
    """``iv`` (``[a, b, *rest]``) minus the ``cuts`` spans; parts keep ``rest``."""
    out, pos = [], iv[0]
    for c0, c1 in cuts:
        if c1 <= pos or c0 >= iv[1]:
            continue
        if c0 > pos:
            out.append([pos, c0, *iv[2:]])
        pos = max(pos, c1)
    if pos < iv[1]:
        out.append([pos, iv[1], *iv[2:]])
    return out


def _logical(parts, mapped, ids, frags):
    """Per span, the footprint calls whole again: parts of one call (same id)
    in one span joined to their hull, as the decoder saw them before cutting
    them at deletions. ``{span: [[t0, t1, size], ...]}`` sorted."""
    by_span = {}
    for j, (_t0, _t1, _i, k) in enumerate(parts):
        iv = mapped[j]
        if iv[2] <= 0:
            continue
        span = frags[k].span
        key = ids[j] if ids[j] is not None else ("part", j)
        hulls = by_span.setdefault(span, {})
        h = hulls.get(key)
        hulls[key] = [iv[0], iv[1], iv[2]] if h is None else [min(h[0], iv[0]), max(h[1], iv[1]), h[2]]
    return {span: sorted(h.values()) for span, h in by_span.items()}


def _gaps(logical, spans, cuts, hide_terminal_gaps, width):
    """Gaps between consecutive calls inside one span (never across a badge,
    connector or split), then cut at the read's deletions."""
    out = []
    for span, (b0, b1) in spans.items():
        calls = logical.get(span, [])
        prev = None if hide_terminal_gaps else b0
        for iv in calls:
            if prev is not None and iv[0] > prev:
                out.append([prev, iv[0], -(iv[0] - prev)])
            prev = iv[1] if prev is None else max(prev, iv[1])
        if not hide_terminal_gaps and prev is not None and b1 > prev:
            out.append([prev, b1, -(b1 - prev)])
    gaps = []
    for iv in out:
        for part in _subtract(iv, cuts):
            part[0], part[1] = max(part[0], 0), min(part[1], width)
            if part[1] > part[0]:
                gaps.append(part)
    return gaps


def _row_payload(read, row, placement, idx, count, contig, runs, call_lo, ctx):
    base = int(read["_fiberbrowser_source_base"])
    rs0, width = ctx.region_start, ctx.width
    calls = read.get("_fiberbrowser_calls") or {}
    call_ids, call_parts = {}, {}
    dropped = {"points": 0, "events": 0}
    payload = {k: v for k, v in read.items() if k not in _REPLACED and not k.startswith("_fiberbrowser_")}

    sa = []
    cuts = []
    if "sv" in read:
        payload["sv"], sa, d = _map_sv(read["sv"], row, ctx)
        dropped["events"] += d
        cuts = sorted((e["ref"] - rs0, e["ref"] + e["len"] - rs0) for e in payload["sv"] if e.get("t") == "D")
        if not payload["sv"]:
            del payload["sv"]

    # Top-level footprints: positive (and neutral size-0) intervals; gaps rebuilt per span.
    ivs = read.get("intervals") or []
    iv_calls = calls.get("intervals")
    parts = _map_group(ivs, iv_calls, row, base, runs, ctx)
    quals = read.get("qualities") or []
    rank, n = {}, 0
    for i, iv in enumerate(ivs):
        if len(iv) > 2 and iv[2] > 0:
            rank[i] = n
            n += 1
    spans = _spans(row, ctx)
    mapped = [[t0, t1, *ivs[i][2:]] for t0, t1, i, _k in parts]
    ids, keys = _call_identity(iv_calls, ivs, parts, row, base, runs, call_lo.get("intervals", {}))
    logical = _logical(parts, mapped, ids, row.frags)
    gaps = _gaps(logical, spans, cuts, ctx.hide_terminal_gaps, width)
    combined = mapped + gaps
    order = sorted(range(len(combined)), key=lambda j: (combined[j][0], combined[j][1], j))
    payload["intervals"] = [combined[j] for j in order]
    np_ = len(parts)
    call_ids["intervals"] = [ids[j] if j < np_ else None for j in order]
    call_parts["intervals"] = [keys[j] if j < np_ else None for j in order]
    if quals:
        payload["qualities"] = [quals[rank[parts[j][2]]] for j in order
                                if j < np_ and parts[j][2] in rank and rank[parts[j][2]] < len(quals)]

    if read.get("fire") is not None:
        fire_calls = calls.get("fire")
        fparts = _map_group(read["fire"], fire_calls, row, base, runs, ctx)
        payload["fire"] = [[t0, t1, *read["fire"][i][2:]] for t0, t1, i, _k in fparts]
        call_ids["fire"], call_parts["fire"] = _call_identity(fire_calls, read["fire"], fparts, row, base, runs,
                                                              call_lo.get("fire", {}))

    layers = {}
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            layers[name] = _map_layer(name, layer, row, base, runs, ctx, call_lo.get(f"layer:{name}", {}),
                                      call_ids, call_parts)
    legacy = read.get("_fiberbrowser_legacy")
    if ctx.infer_legacy and ctx.include_layers and legacy is not None:
        _infer_legacy(read, layers, payload, parts, mapped, ids, keys, logical, cuts, legacy, row, ctx,
                      call_ids, call_parts)
    if read.get("layers") is not None or layers:
        payload["layers"] = layers

    for key in _POINT_FIELDS:
        if key in read:
            payload[key], d = _map_points(read[key], row, base, ctx)
            dropped["points"] += d
    if "deam" in read:
        payload["deam"], d = _map_points(read["deam"], row, base, ctx, pairs=True)
        dropped["points"] += d
    if "methyl" in read:  # the loader's alias, derived as it does
        payload["methyl"] = (payload.get("methyl_m6a") or payload.get("methyl_m5c")
                             or [e[0] for e in payload.get("deam") or ()])
    if "cigar" in read:
        payload["cigar"], d = _map_cigar(read["cigar"], row, base, ctx)
        dropped["events"] += d
    if (ctx.loader_options.get("include_cigar") and ctx.loader_options.get("include_mismatches", True)
            and ctx.loader_options.get("target_fasta") is not None):
        from services.lift.differences import row_mismatches
        payload.setdefault("cigar", []).extend(row_mismatches(read, row, ctx))
        payload["cigar"].sort(key=lambda e: (e["pos"], e["type"]))
    if "_fiberbrowser_terminal_gaps" in read:
        gaps_t = []
        for a, b in read["_fiberbrowser_terminal_gaps"]:
            gaps_t += [[t0, t1] for t0, t1, _k in row.parts(int(a), int(b))]
        payload["_fiberbrowser_terminal_gaps"] = sorted(gaps_t)

    hull0 = min(s[0] for s in row.segments)
    hull1 = max(s[1] for s in row.segments)
    payload["reference_start"], payload["reference_end"] = hull0, hull1
    record_reverse = read.get("alignment_orientation") == "reverse"
    payload["alignment_orientation"] = "reverse" if record_reverse != (row.strand == "-") else "forward"
    body = []
    for a, b in sorted(spans.values()):  # badge cuts are zero-width: rejoin touching spans
        if body and body[-1][1] >= a + rs0:
            body[-1][1] = max(body[-1][1], b + rs0)
        else:
            body.append([a + rs0, b + rs0])
    payload["alignment_spans"] = body

    # Identity components (§3.4 v3.1) and molecule metadata (§3.5): haplotype
    # and strand are the primary record's when it was found, else this
    # record's own. ``analysis_id`` is assigned per fold mode later (P2).
    library = read.get("library_id") or read.get("source_path") or ""
    qname = read.get("id")
    group = ctx.molecule_groups.get(read.get("source_path")) or ctx.molecule_groups.get(library) or ctx.dataset_id
    molecule = f"{group}|{qname}"
    mol_meta = ctx.molecules.get((library, qname))
    record_hap = row.frags[0].p.hap
    if mol_meta is not None:
        hap, hap_source = mol_meta.get("hap") or record_hap, "primary"
        strand_fields = {k: mol_meta[k] for k in ("strand", "strand_conflict") if mol_meta.get(k) is not None}
    else:
        hap, hap_source = record_hap, "record"
        strand_fields = {k: read[k] for k in ("strand", "strand_conflict") if k in read}
    payload.update(strand_fields)
    sha, occ = read.get("record_sha256"), read.get("alignment_occurrence")
    record = f"{sha}:{occ}" if sha else f"{read.get('reference_start')}-{read.get('reference_end')}"
    prim = read.get("_fiberbrowser_primary") or {}
    payload["live_lift"] = {
        "v": 1,
        "key": ctx.key,
        "hap": hap,
        "hap_label": ctx.labels.get(hap, hap),
        "hap_source": hap_source,
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
        "badge_ids": [],
        "insertions": {},
        "calls": call_ids,
        "call_parts": call_parts,
        "dropped": dropped,
    }
    _insertion_payloads(read, row, contig, runs, call_lo, payload, ctx)
    # Geometry clipped to the region, as intervals are (a broad-cache crop gives the same).
    from services.lift.reads import clip_geometry
    payload["live_lift"] = clip_geometry(payload["live_lift"], 0, width)
    return payload


def _insertion_payloads(read, row, contig, runs, call_lo, payload, ctx):
    """Retain hidden source calls for expansion, isolated from all target geometry.

    ``badge_ids`` parallels sorted ``badges`` (null for spans below 50 bp).
    ``insertions[id]`` is ``{pos, hap_label, src:[contig,a,b], length, mol_bp,
    orientation, covered:[x0,x1], intervals:[[x0,x1,size],...], layers:{...},
    qualities?, fire?, methyl_m6a?, methyl_m5c?, deam?, possible_deam_*?}``.
    Positions are insertion-local in target display order; ``pos`` alone is
    row-relative. ``covered`` allows partial carriers of the same full map gap.
    Over 50 kb the value is only ``{length, too_large:true}``. The synthetic
    row reuses the composer so gaps/MSPs, qualities and deletion cuts obey
    exactly the same rules as target calls, without entering the target row.
    """
    from services.lift.differences import difference_id, insertion_span

    ll = payload["live_lift"]
    for i in sorted(range(len(row.badges)), key=lambda i: row.badges[i][0]):
        badge = row.badges[i]
        a, b, p = row.badge_sources[i]
        a, b = insertion_span(ctx.handle, contig, a, b, p.chain)
        label = ctx.labels.get(p.hap, p.hap)
        ins_id = difference_id(label, contig, a, b, "insertion")
        length = b - a
        ll["badge_ids"].append(ins_id if length >= 50 else None)
        lo, hi = max(a, int(read["reference_start"])), min(b, int(read["reference_end"]))
        mol_bp = runs.mol_between(lo, hi)
        # A mapping badge is independent evidence that this read carries the
        # assembly insertion. Elsewhere projections are navigation, not an SV.
        if badge[1] != "elsewhere" and mol_bp >= int(ctx.loader_options.get("sv_min_len", 50)):
            payload.setdefault("sv", []).append({"t": "I", "ref": badge[0], "len": mol_bp,
                                                  "source": "assembly", "hap": label, "ins_id": ins_id})
        if length < 50:
            continue
        if length > 50_000:
            ll["insertions"][ins_id] = {"length": length, "too_large": True}
            continue
        local_ctx = copy.copy(ctx)
        local_ctx.region_start, local_ctx.region_end, local_ctx.width = 0, length, length
        # The synthetic block is not a target locus; never compare it to hg38.
        local_ctx.loader_options = dict(ctx.loader_options, include_cigar=False)
        local = _Row(row.strand, row.alt)
        local.add_run([_Frag(lo, hi, p._replace(q_start=a, q_end=b, t_start=0, t_end=length))], ctx.settings.rejoin_bp)
        local.index()
        _row_geometry(local, contig, runs, local_ctx)
        hidden = _row_payload(read, local, "insertion", 0, 1, contig, runs, call_lo, local_ctx)
        keep = ("intervals", "qualities", "layers", "fire", "deam", *_POINT_FIELDS)
        block = {k: hidden[k] for k in keep if k in hidden}
        covered = [lo - a, hi - a] if row.strand == "+" else [b - hi, b - lo]
        if row.strand == "-":
            # Expansion coordinates mirror boundaries x -> length-x, including
            # point marks, so source offset 10 in a 100 bp block is x=90.
            for key in _POINT_FIELDS:
                if key in block:
                    block[key] = [x + 1 for x in block[key]]
            if "deam" in block:
                block["deam"] = [[x + 1, *rest] for x, *rest in block["deam"]]
        block.update(pos=badge[0] - ctx.region_start, hap_label=label, src=[contig, a, b], length=length,
                     mol_bp=mol_bp, orientation=row.strand, covered=covered)
        ll["insertions"][ins_id] = block


def _infer_legacy(read, layers, payload, parts, mapped, ids, keys, logical, cuts, legacy, row, ctx,
                  call_ids, call_parts):
    """Legacy nuc/tf/msp inference from ns/nl footprints after lifting (the
    loader ran with it off). Nuc/tf follow the lifted parts; MSPs come from the
    gaps between whole nucleosome calls inside one span, cut at deletions, so
    no MSP bridges a badge, connector, split or deletion."""
    from services.bam_tags import generate_msp_from_nuc_gaps

    ma_names = set(legacy.get("ma_names") or ())
    wants = ctx.wants
    infer_nuc = wants["nuc"] and "nuc" not in ma_names and "nuc" not in layers
    infer_tf = wants["tf"] and "tf" not in ma_names and "tf" not in layers
    infer_msp = (wants["msp"] and not legacy.get("explicit_msp") and "msp" not in ma_names and "msp" not in layers)
    width = ctx.width
    if infer_nuc or infer_tf:
        edge = read.get("_fiberbrowser_edge_qualities") or {}
        quals = read.get("qualities") or []
        rank, n = {}, 0
        for i, iv in enumerate(read.get("intervals") or ()):
            if len(iv) > 2 and iv[2] > 0:
                rank[i] = n
                n += 1
        order = sorted((j for j, iv in enumerate(mapped) if iv[2] > 0), key=lambda j: (mapped[j][0], mapped[j][1], j))
        for name, wanted, keep in (("nuc", infer_nuc, lambda s: s >= ctx.nuc_min_size),
                                   ("tf", infer_tf, lambda s: s < ctx.nuc_min_size)):
            if not wanted:
                continue
            sel = [j for j in order if keep(mapped[j][2])]
            if not sel:
                continue
            names, tracks = [], []
            if ctx.layer_qualities:
                if quals:
                    names.append("nq")
                    tracks.append([quals[rank[parts[j][2]]] if parts[j][2] in rank else 0 for j in sel])
                if edge:
                    lq = [edge.get(ids[j], [0, 0])[0] for j in sel]
                    rq = [edge.get(ids[j], [0, 0])[1] for j in sel]
                    if row.strand == "-":
                        lq, rq = rq, lq
                    names += ["lq", "rq"]
                    tracks += [lq, rq]
            layers[name] = {"intervals": [mapped[j] for j in sel], "qualities": tracks or None,
                            "quality_names": names}
            call_ids[f"layer:{name}"] = [ids[j] for j in sel]
            call_parts[f"layer:{name}"] = [keys[j] for j in sel]
    if infer_msp:
        msp = []
        for span in sorted(logical):
            for iv in generate_msp_from_nuc_gaps(logical[span], min_nuc_size=ctx.nuc_min_size):
                for part in _subtract(iv, cuts):
                    part[0], part[1] = max(part[0], 0), min(part[1], width)
                    if part[1] > part[0]:
                        msp.append(part)
        if msp:
            msp.sort()
            layers["msp"] = {"intervals": msp, "qualities": None, "quality_names": []}
            call_ids["layer:msp"] = [None] * len(msp)
            call_parts["layer:msp"] = [None] * len(msp)
