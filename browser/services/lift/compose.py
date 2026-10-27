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

Speed: ``lift_compact_reads`` first builds every read's rows, then maps the
intervals, calls, marks and molecular spans of all rows of the window at once
(``compose_columns``), then assembles each row's payload; the hidden
insertion blocks follow in one more columnar pass. The per-row functions here
(``_map_group``, ``_call_identity``, ``_map_points``, ``_molecular_spans``,
``_logical``/``_gaps``) define the output and handle whatever the columnar
pass leaves to them; it reproduces them exactly.

Rows are read row format 2 (``services/read_columns.py``): the intervals,
FIRE, layer intervals and point marks the columnar pass maps are
``IntColumn`` slices of its window arrays rather than lists (the rows it
leaves to the per-row functions keep lists). Either reads the same.
"""
from __future__ import annotations

import bisect
import copy
from contextlib import ExitStack

import numpy as np

from services.lift.compose_columns import LazyParts, precompute
from services.read_columns import IntColumn

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
             "sv_evidence", "aligned_blocks", "sv_segments", "sv_alignments", "sequence_span",
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
        self._ascending = None

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

    def _disjoint(self):
        if self._ascending is None:
            ref, ln = self.ref, self.len
            self._ascending = all(n >= 0 for n in ln) and all(ref[i] + ln[i] <= ref[i + 1] for i in range(len(ref) - 1))
        return self._ascending

    def coverage(self, lo, hi, x, y):
        """``(aligned bases in [lo, hi), whether x is aligned, whether y is aligned)``."""
        ref, ln = self.ref, self.len
        if not self._disjoint():
            return (sum(max(0, min(hi, r + n) - max(lo, r)) for r, n in zip(ref, ln)),
                    any(r <= x < r + n for r, n in zip(ref, ln)), any(r <= y < r + n for r, n in zip(ref, ln)))
        aligned = 0
        i = max(bisect.bisect_right(ref, lo) - 1, 0)
        while i < len(ref) and ref[i] < hi:
            aligned += max(0, min(hi, ref[i] + ln[i]) - max(lo, ref[i]))
            i += 1
        i = bisect.bisect_right(ref, x) - 1
        j = bisect.bisect_right(ref, y) - 1
        return aligned, i >= 0 and x < ref[i] + ln[i], j >= 0 and y < ref[j] + ln[j]

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
        self._pre = None         # compose_columns.RowColumns for rows of a lifted window

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
        from services.sv_events import SV_MIN_LEN_DEFAULT
        # Calls are cut only at indel events of at least this length, as the native loader cuts them.
        self.sv_min_len = int(SV_MIN_LEN_DEFAULT if opts.get("sv_min_len") is None else opts["sv_min_len"])
        self.layer_qualities = bool(opts.get("include_layer_qualities", True))
        include, requested = normalize_layer_request(opts.get("include_layers", True), opts.get("requested_layers"))
        self.wants = {name: wants_layer(include, requested, *aliases) for name, aliases in
                      (("nuc", ("nuc", "footprint")), ("tf", ("tf",)), ("msp", ("msp", "fire")))}
        self.include_layers = include
        self.labels = handle.haplotype_labels if handle is not None else {}
        self.molecule_groups = {}
        self.library_index = {}
        self._gap_cache = {}
        self._source_gaps = {}
        self._owned_gap_items = None
        self._owned_gap_ranges = {}
        self.pending_insertions = None  # hidden blocks to compose after the window's rows (lift_compact_reads)
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

    def source_only_gap(self, contig, a, b, chain):
        """``differences.source_only_gap``, memoised for the load (the map does not change)."""
        key = (contig, a, b, chain)
        hit = self._source_gaps.get(key, self)
        if hit is self:
            from services.lift.differences import source_only_gap
            hit = self._source_gaps[key] = source_only_gap(self.handle, contig, a, b, chain)
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
    # Library index of each source BAM (dataset path order): a linked source panel
    # opening the same files tells its rows' molecules apart by it (P3 hover).
    ctx.library_index = {path: i for i, path in enumerate(ctx.molecule_groups)}
    by_contig = {}
    for contig, pieces in plan.pieces_by_contig().items():
        pieces = sorted(pieces, key=lambda p: (p.q_start, p.q_end))
        reach, top = [], None
        for p in pieces:  # running maximum of q_end: pieces before a read's start skip at once
            top = p.q_end if top is None or p.q_end > top else top
            reach.append(top)
        by_contig[contig] = (pieces, [p.q_start for p in pieces], reach)
    haps = {p.hap for pieces, _starts, _reach in by_contig.values() for p in pieces}
    out = []
    with ExitStack() as stack:
        ctx.source_fasta = None
        if ctx.loader_options.get("include_cigar") and ctx.loader_options.get("source_fasta"):
            import pysam
            from services.lift.dataset import open_source_fasta
            ctx.source_fasta = stack.enter_context(open_source_fasta(ctx.loader_options["source_fasta"]))
        # Rows and their geometry first, for every read; then the window's
        # intervals, calls, marks and molecular spans in one columnar pass
        # (compose_columns); then each row's payload.
        items = []
        for i, read in enumerate(reads):
            if not i & 255:
                checkpoint()
            item = _read_geometry(read, by_contig, haps, ctx)
            if item is not None:
                items.append(item)
        precompute(items, ctx, point_fields=_POINT_FIELDS, rest_parts=_rest_parts, small_group=_SMALL_GROUP)
        ctx.pending_insertions = []
        for i, (read, rows, runs) in enumerate(items):
            if not i & 255:
                checkpoint()
            out.extend(_read_payloads(read, rows, runs, ctx))
        _compose_pending_insertions(ctx)
    return out


def _read_rows(read, indexed, settings):
    """A read's rows: primary fragments, then one row set per alternative chain.
    ``indexed``: ``(pieces, their q_starts[, running max of q_end])``, pieces
    sorted by ``(q_start, q_end)``."""
    pieces, starts = indexed[0], indexed[1]
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    # Pieces ending at or before the read's start contribute nothing.
    first = bisect.bisect_right(indexed[2], rs) if len(indexed) > 2 else 0
    primary_frags, alt_frags = [], {}
    for p in pieces[first:bisect.bisect_left(starts, re_)]:
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
    item = _read_geometry(read, by_contig, haps, ctx)
    return [] if item is None else _read_payloads(*item, ctx)


def _read_geometry(read, by_contig, haps, ctx):
    """``(read, rows, runs)`` with each row's geometry, or None (counted) for
    a read with no fragment in the selected pieces."""
    rec = read.get("_fiberbrowser_lift_record") or {}
    contig = rec.get("contig")
    runs = _SeqRuns(read.get("_fiberbrowser_aligned_runs"), rec)
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    rows = _read_rows(read, by_contig.get(contig) or ([], [], []), ctx.settings)
    if not rows:
        ctx.count("records_without_correspondence")
        return None
    for row in rows:
        row.index()
        _row_geometry(row, contig, runs, ctx)
    _outside_badges([r for r in rows if not r.alt], contig, rs, re_, runs, haps, ctx)
    key = (read.get("library_id") or read.get("source_path") or "", read.get("id"))
    if key not in ctx.molecules and (read.get("_fiberbrowser_primary") or {}).get("is_supplementary"):
        ctx.count("hap_from_record")
    return read, rows, runs


def _read_payloads(read, rows, runs, ctx):
    contig = (read.get("_fiberbrowser_lift_record") or {}).get("contig")
    # Row numbering is per placement (primary, or each alternative chain).
    numbering, per_placement = [], {}
    for row in rows:
        placement = _placement(row)
        numbering.append((placement, per_placement.get(placement, 0)))
        per_placement[placement] = per_placement.get(placement, 0) + 1
    call_lo = _LazyCallStarts(read)
    return [_row_payload(read, row, placement, idx, per_placement[placement], contig, runs, call_lo, ctx)
            for row, (placement, idx) in zip(rows, numbering)]


def _placement(row):
    if row.alt:
        return f"alt{row.frags[0].p.chain}"
    return str(next((f.p.chain for f in row.frags if f.p.primary), row.frags[0].p.chain))


class _LazyCallStarts:
    """``_call_starts(read)``, computed on first use (the columnar pass needs
    it only for rows and groups it leaves to the per-row functions)."""
    __slots__ = ("read", "value")

    def __init__(self, read):
        self.read, self.value = read, None

    def get(self, group, default=None):
        if self.value is None:
            self.value = _call_starts(self.read)
        return self.value.get(group, default)


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
        prev, f = row.frags[k], row.frags[k + 1]
        if (gap is None and ctx.handle is not None and prev.p.primary and f.p.primary
                and prev.p.chain == f.p.chain and prev.p.strand == f.p.strand):
            # g_split remains a display-run boundary. Preserve the exact owned
            # edit across it without rejoining calls or alternative placements.
            from services.lift.differences import primary_gaps_for_region, _source_span
            t = f.t1 if f.minus else prev.t1
            dt = prev.t0 - f.t1 if f.minus else f.t0 - prev.t1
            with ctx.handle.lock:
                for ci, (gt, q, gdt, dq, _reason), _ in primary_gaps_for_region(
                        ctx.handle, ctx.selection.chrom, prev.p.hap, t, t + max(dt, 1)):
                    if (ci == prev.p.chain and (gt, gdt) == (t, dt)
                            and _source_span(ctx.handle, ctx.handle.map.chains[ci], q, dq) == (prev.e, f.s)):
                        gap = (dq, dt)
                        break
        if gap is None:
            continue
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
        # Owned edits across g_split already have an inner display badge,
        # although their call runs intentionally remain separate.
        inner.update((a, b) for a, b, _p in row.badge_sources)
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
        # The rest one by one; an interval overlapping none of the fragments
        # has no parts (row.parts) unless it may be an insertion-only marker.
        starts, ends = np.asarray(row.starts, dtype=np.int64), np.asarray(row.ends, dtype=np.int64)
        nxt = np.minimum(k + 1, len(starts) - 1)
        overlaps = ((k >= 0) & (ends[kk] > a)) | ((k + 1 < len(starts)) & (starts[nxt] < b))
        rest = np.flatnonzero(todo & ~fast & (slow | overlaps)).tolist()
    else:
        rest = [i for i, iv in enumerate(ivs) if not (len(iv) > 2 and iv[2] < 0)]
    for i in rest:
        out += _rest_parts(i, ivs, calls, row, base, runs, rs0, width)
    out.sort()
    return out


def _rest_parts(i, ivs, calls, row, base, runs, rs0, width):
    """``_map_group``'s parts of interval ``i`` outside the one-fragment case."""
    ai, bi = base + int(ivs[i][0]), base + int(ivs[i][1])
    call = calls[i] if calls is not None and i < len(calls) else None
    # An insertion-only call decodes to the one reference base after its insertion.
    if call is not None and bi - ai == 1 and not runs.has_aligned(int(call[1]), int(call[2])):
        hit = row.boundary(ai)
        if hit is not None and 0 <= hit[1] - rs0 <= width:
            return [(hit[1] - rs0, hit[1] - rs0, i, hit[0])]
        return []
    out = []
    for t0, t1, k in row.parts(ai, bi):
        c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
        if c1 > c0:
            out.append((c0, c1, i, k))
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


def _group(name, ivs, calls, row, base, runs, ctx, lo):
    """``(parts, mapped, ids, keys)`` of one interval group: ``_map_group``,
    its intervals ``[t0, t1, *rest]`` and ``_call_identity``; from the
    window's columnar pass when it covered the group."""
    pre = row._pre
    if pre is not None:
        hit = pre.groups.get(name)
        if hit is not None:
            return hit
    parts = _map_group(ivs, calls, row, base, runs, ctx)
    src = ivs or []
    mapped = [[t0, t1, *src[i][2:]] for t0, t1, i, _k in parts]
    ids, keys = _call_identity(calls, src, parts, row, base, runs, lo.get(name, {}))
    return parts, mapped, ids, keys


def _swap_pairs(names, layer_name):
    pairs = list(_EDGE_PAIRS)
    if layer_name in _SR_LAYERS:
        pairs.append(("q1", "q2"))
    idx = {n: k for k, n in enumerate(names or ())}
    return [(idx[a], idx[b]) for a, b in pairs if a in idx and b in idx]


def _map_layer(name, layer, row, base, runs, ctx, lo, ids_out, parts_out):
    calls = layer.get("_fiberbrowser_calls")
    src = layer.get("intervals") or []
    parts, mapped, ids, keys = _group(f"layer:{name}", layer.get("intervals"), calls, row, base, runs, ctx, lo)
    out = {key: value for key, value in layer.items()
           if key not in ("intervals", "qualities", "_fiberbrowser_calls", *_ALIGNED_LIST_KEYS, *_SOURCE_SPAN_KEYS)}
    out["intervals"] = mapped
    qualities = layer.get("qualities")
    if qualities is not None:
        index = parts.index() if isinstance(parts, LazyParts) else [part[2] for part in parts]
        top = max(index) if index else -1
        tracks = [list(map(track.__getitem__, index)) if top < len(track) else
                  [track[i] if i < len(track) else 0 for i in index] for track in qualities]
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
    ids_out[f"layer:{name}"], parts_out[f"layer:{name}"] = ids, keys
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
    """Display SV events in absolute target coordinates.

    Source query offsets, clip origins, normalized endpoints and raw CIGAR
    pieces cannot be interpreted in this frame. Retain only display fields;
    SA witnesses stay explicitly under live_lift.source.sa. A future guarded
    adapter must project all evidence fields together before exposing them.
    """
    out, sa, dropped = [], [], 0
    for ev in events or ():
        t = ev.get("t")
        if t == "SA":
            sa.append(ev)
            continue
        display = {k: ev[k] for k in ("t", "ref", "len", "side", "h", "seq") if k in ev}
        display.update(source="reads", method="display_projection", display_only=True)
        if t == "D":
            parts = row.parts(int(ev["ref"]), int(ev["ref"]) + int(ev.get("ref_len", ev["len"])))
            if not parts:
                dropped += 1
            for t0, t1, _k in parts:
                out.append(dict(display, ref=t0, len=t1 - t0))
            continue
        hit = row.boundary(int(ev["ref"]))
        if hit is None:
            dropped += 1
            continue
        new = dict(display, ref=hit[1])
        if row.strand == "-":
            if t == "I" and ev.get("seq"):
                new["seq"] = revcomp(ev["seq"])
            if t == "S":
                new["side"] = "R" if ev.get("side") == "L" else "L"
        out.append(new)
    out.sort(key=lambda e: (e.get("ref", 0), e.get("t", "")))
    return out, sa, dropped


def _event_len(ev):
    """An indel event's length as ``sv_alleles.cigar_replacements`` measures its raw CIGAR (inserted or deleted
    bases, whichever is more)."""
    raw = ev.get("raw_pieces")
    if raw:
        return max(sum(int(p.get("len", 0)) for p in raw if p.get("t") == "I"),
                   sum(int(p.get("len", 0)) for p in raw if p.get("t") == "D"))
    return int(ev.get("len", 0))


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


def _logical(parts, mapped, ids, frags, groups=None):
    """Per span, the footprint calls whole again: parts of one call (same id)
    in one span joined to their hull, as the decoder saw them before cutting
    them at deletions. ``{span: [[t0, t1, size], ...]}`` sorted. With
    ``groups`` (``_span_groups``), per rejoin group instead: a call cut at a
    deletion is whole again across a map hole inside it."""
    by_span = {}
    for j, (_t0, _t1, _i, k) in enumerate(parts):
        iv = mapped[j]
        if iv[2] <= 0:
            continue
        span = frags[k].span if groups is None else groups[frags[k].span]
        key = ids[j] if ids[j] is not None else ("part", j)
        hulls = by_span.setdefault(span, {})
        h = hulls.get(key)
        hulls[key] = [iv[0], iv[1], iv[2]] if h is None else [min(h[0], iv[0]), max(h[1], iv[1]), h[2]]
    return {span: sorted(h.values()) for span, h in by_span.items()}


def _span_groups(row):
    """``{span id: rejoin group}``: spans whose boundary is joinable (a badge
    and/or connector of at most ``rejoin_bp``) share a group."""
    out, start = {}, 0
    for k, f in enumerate(row.frags):
        if k and not row.joinable[k - 1]:
            start = k
        out.setdefault(f.span, start)
    return out


def _gaps(logical, spans, cuts, hide_terminal_gaps, width, groups=None, grouped=None):
    """Gaps between consecutive calls inside one span, then cut at the read's
    deletions. With terminal gaps hidden, a gap between calls of two spans of
    one rejoin group (``groups``, ``_span_groups``) is kept, cut at the spans'
    edges, so no gap crosses a badge or connector yet a 1-bp map hole drops no
    linker (shown terminal gaps already reach the span edges). ``grouped()``:
    the calls per rejoin group (``_logical`` with ``groups``)."""
    out = []
    if hide_terminal_gaps and groups and len(set(groups.values())) < len(groups):
        by_group = {}
        for span, bounds in spans.items():
            by_group.setdefault(groups[span], []).append((bounds, span))
        whole = grouped() if grouped is not None else None
        for group, members in by_group.items():
            members.sort()
            prev = None
            calls = (whole.get(group, []) if whole is not None
                     else sorted(iv for _b, span in members for iv in logical.get(span, [])))
            for iv in calls:
                if prev is not None and iv[0] > prev:
                    for (b0, b1), _span in members:
                        g0, g1 = max(prev, b0), min(iv[0], b1)
                        if g1 > g0:
                            out.append([g0, g1, -(iv[0] - prev)])
                prev = iv[1] if prev is None else max(prev, iv[1])
        spans = {}
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
    # (Internal fields stay with the decoded record, except the molecule scalars every row of a record shares:
    # services/nuc/scalars.py.)
    payload = {k: v for k, v in read.items() if k not in _REPLACED
               and (not k.startswith("_fiberbrowser_") or k == "_fiberbrowser_scalars")}

    sa = []
    cuts = []
    if "sv" in read:
        payload["sv"], sa, d = _map_sv(read["sv"], row, ctx)
        dropped["events"] += d
        # Every deleted base of the CIGAR (raw pieces: a replacement and a deletion shifted to its canonical
        # position included) of events of at least sv_min_len (the record's events go down to the evidence
        # floor), as the native loader cuts calls (sv_events.read_deletion_cuts).
        from services.sv_events import deletion_spans
        cuts = sorted((t0 - rs0, t1 - rs0) for a, b in deletion_spans(e for e in read["sv"] if _event_len(e) >= ctx.sv_min_len)
                      for t0, t1, _k in row.parts(a, b))
        if not payload["sv"]:
            del payload["sv"]

    # Top-level footprints: positive (and neutral size-0) intervals; gaps rebuilt per span.
    ivs = read.get("intervals") or []
    iv_calls = calls.get("intervals")
    parts, mapped, ids, keys = _group("intervals", ivs, iv_calls, row, base, runs, ctx, call_lo)
    spans = _spans(row, ctx)
    logical = None
    top = row._pre.intervals if row._pre is not None and not cuts else None
    if top is not None:  # laid out by the window's columnar pass (compose_columns._top_level)
        payload["intervals"], call_ids["intervals"], call_parts["intervals"], quals_out = top
        if quals_out is not None:
            payload["qualities"] = quals_out
    else:
        if type(mapped) is IntColumn:  # a columnar group on a row laid out here (deletion cuts)
            mapped = mapped.tolist()
        quals = read.get("qualities") or []
        rank, n = {}, 0
        for i, iv in enumerate(ivs):
            if len(iv) > 2 and iv[2] > 0:
                rank[i] = n
                n += 1
        logical = _logical(parts, mapped, ids, row.frags)
        groups = _span_groups(row)
        gaps = _gaps(logical, spans, cuts, ctx.hide_terminal_gaps, width, groups,
                     lambda: _logical(parts, mapped, ids, row.frags, groups))
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
        _fparts, payload["fire"], call_ids["fire"], call_parts["fire"] = _group(
            "fire", read["fire"], calls.get("fire"), row, base, runs, ctx, call_lo)

    layers = {}
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            layers[name] = _map_layer(name, layer, row, base, runs, ctx, call_lo, call_ids, call_parts)
    legacy = read.get("_fiberbrowser_legacy")
    if ctx.infer_legacy and ctx.include_layers and legacy is not None:
        _infer_legacy(read, layers, payload, parts, mapped, ids, keys,
                      logical if logical is not None else (lambda: _logical(parts, mapped, ids, row.frags)),
                      cuts, legacy, row, ctx, call_ids, call_parts)
    if read.get("layers") is not None or layers:
        payload["layers"] = layers

    pre_points = row._pre.points if row._pre is not None else {}
    for key in _POINT_FIELDS:
        if key in read:
            hit = pre_points.get(key)
            payload[key], d = hit if hit is not None else _map_points(read[key], row, base, ctx)
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
    if "_fiberbrowser_terminal_gaps" in read:
        gaps_t = []
        for a, b in read["_fiberbrowser_terminal_gaps"]:
            gaps_t += [[t0, t1] for t0, t1, _k in row.parts(int(a), int(b))]
        payload["_fiberbrowser_terminal_gaps"] = sorted(gaps_t)

    clipped_spans = row._pre.molecular_spans if row._pre is not None else None
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
    from services.lift.joint import group_for, molecule_key
    group = group_for(ctx.molecule_groups, read.get("source_path"), library) or ctx.dataset_id
    molecule = molecule_key(group, qname)
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
        "library": ctx.library_index.get(read.get("source_path"), 0),
        "record": record,
        "row_index": idx,
        "row_count": count,
        "source": {"contig": contig, "start": int(read["reference_start"]), "end": int(read["reference_end"]),
                   "orientation": read.get("alignment_orientation"),
                   "supplementary": bool(prim.get("is_supplementary")), "sa": sa or None},
        "molecular_spans": clipped_spans if clipped_spans is not None else _molecular_spans(row, runs, rs0),
        "segments": [[s0 - rs0, s1 - rs0, chain, strand, primary] for s0, s1, chain, strand, primary in row.segments],
        "connectors": [[c0 - rs0, c1 - rs0] for c0, c1 in sorted(row.connectors)],
        "badges": [[b[0] - rs0, *b[1:]] for b in sorted(row.badges, key=lambda b: b[0])],
        "badge_ids": [],
        "insertions": {},
        "calls": call_ids,
        "call_parts": call_parts,
        "dropped": dropped,
    }
    if (ctx.loader_options.get("include_cigar") and ctx.loader_options.get("include_mismatches", True)
            and ctx.loader_options.get("target_fasta") is not None):
        from services.lift.differences import row_mismatches
        payload.setdefault("cigar", []).extend(row_mismatches(read, row, ctx, payload["live_lift"]["hap"]))
        payload["cigar"].sort(key=lambda e: (e["pos"], e["type"]))
    _assembly_gap_metadata(read, row, contig, runs, payload, ctx)
    _insertion_metadata(read, row, contig, runs, call_lo, payload, ctx)
    # Geometry clipped to the region, as intervals are (a broad-cache crop gives the same).
    from services.lift.reads import clip_geometry
    payload["live_lift"] = clip_geometry(payload["live_lift"], 0, width, spans_clipped=clipped_spans is not None)
    return payload


def _assembly_gap_metadata(read, row, contig, runs, payload, ctx):
    """Map observations at the evidence floor, separate from read SV evidence.

    These describe expected assembly geometry and observed source coverage.
    They do not compose read deviations/cancellation or certify an allele.
    Absolute target/source endpoints survive cropping; pos is view-relative.
    """
    from services.lift.differences import primary_gaps_for_region, _item, _source_span
    from services.sv_events import SV_EVIDENCE_FLOOR

    if ctx.handle is None or ctx.loader_options.get("_insertion_local") or row.alt:
        return
    if ctx._owned_gap_items is None:
        grouped = {}
        haps = {p.hap for p in ctx.selection.pieces if p.primary}
        with ctx.handle.lock:
            for hap in haps:
                for ci, (t, q, dt, dq, reason), _ in primary_gaps_for_region(
                        ctx.handle, ctx.selection.chrom, hap, ctx.selection.start, ctx.selection.end + 1):
                    if max(dt, dq) < SV_EVIDENCE_FLOOR or t > ctx.selection.end or t + dt < ctx.selection.start:
                        continue
                    c = ctx.handle.map.chains[ci]
                    a, b = _source_span(ctx.handle, c, q, dq)
                    kind = "replacement" if dt and dq else "insertion" if dq else "deletion"
                    grouped.setdefault(ci, []).append(_item(ctx.handle, hap, ci, kind, ctx.handle.map.reasons[reason], t, t + dt, a, b))
        ctx._owned_gap_items = grouped
    observations = []
    rs, re = int(read["reference_start"]), int(read["reference_end"])
    for ci in sorted({f.p.chain for f in row.frags}):
        for item in _owned_gaps_near(ctx, ci, contig, rs, re):
            a, b = item["src"]["start"], item["src"]["end"]
            if item["src"]["contig"] != contig or re < a or rs > b:
                continue
            lo, hi = max(rs, a), min(re, b)
            aligned, left, right = runs.coverage(lo, hi, a - 1, b)
            mol_bp = runs.mol_between(lo, hi)
            covered = [lo - a, hi - a] if item["strand"] == "+" else [b - hi, b - lo]
            obs = dict(item, pos=item["t_start"] - ctx.region_start, method="assembly_projection",
                       display_only=True, sequence_status="unresolved", read_deviations="unassessed",
                       coverage=dict(source=covered, aligned_bp=aligned, mol_bp=mol_bp,
                                     left_flank=left, right_flank=right,
                                     full=left and right))
            observations.append(obs)
            # The glyph uses the native mixed-edit geometry, without entering
            # sv_evidence. Partial source insertions retain observed lengths.
            if item["kind"] == "insertion":
                length = mol_bp
                if length < SV_EVIDENCE_FLOOR:
                    continue
                t = "I"
            else:
                if not (left and right):
                    continue
                length = max(item["ref_bp"], item["alt_bp"])
                t = "I" if item["alt_bp"] >= item["ref_bp"] else "D"
            marker = dict(t=t, ref=item["t_start"], ref_end=item["t_end"], len=length,
                          ref_len=item["ref_bp"], alt_len=item["alt_bp"], source="assembly",
                          method="assembly_projection", display_only=True, hap=item["hap_label"],
                          difference_id=item["id"], kind=item["kind"], coverage=obs["coverage"])
            if item["alt_bp"] >= 50:
                marker["ins_id"] = item["id"]
            payload.setdefault("sv", []).append(marker)
    payload["live_lift"]["gap_observations"] = observations
    if payload.get("sv"):
        payload["sv"].sort(key=lambda e: (e.get("ref", 0), e.get("t", "")))


def _owned_gaps_near(ctx, ci, contig, rs, re):
    """The owned gap items of chain ``ci`` (in their order) that may meet
    source ``[rs, re]`` on ``contig``: a superset of the overlapping ones,
    found by bisection when the chain's items are disjoint and ascending in
    source (else all of them)."""
    items = ctx._owned_gap_items.get(ci, ())
    if len(items) < 8:
        return items
    index = ctx._owned_gap_ranges.get(ci)
    if index is None:
        order = sorted(range(len(items)), key=lambda j: (items[j]["src"]["start"], items[j]["src"]["end"]))
        starts = [items[j]["src"]["start"] for j in order]
        ends = [items[j]["src"]["end"] for j in order]
        ok = (all(items[j]["src"]["contig"] == items[order[0]]["src"]["contig"] for j in order)
              and all(ends[x] <= starts[x + 1] for x in range(len(order) - 1)))
        index = ctx._owned_gap_ranges[ci] = (order, starts, ends, items[order[0]]["src"]["contig"]) if ok else False
    if index is False:
        return items
    order, starts, ends, gap_contig = index
    if gap_contig != contig:
        return ()
    lo = bisect.bisect_left(ends, rs)        # first item with end >= rs
    hi = bisect.bisect_right(starts, re)     # items with start <= re
    if hi - lo == len(order):
        return items
    return [items[j] for j in sorted(order[lo:hi])]


def _insertion_metadata(read, row, contig, runs, call_lo, payload, ctx):
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
    from services.lift.differences import difference_id

    ll = payload["live_lift"]
    for i in sorted(range(len(row.badges)), key=lambda i: row.badges[i][0]):
        badge = row.badges[i]
        a, b, p = row.badge_sources[i]
        gap = ctx.source_only_gap(contig, a, b, p.chain)
        if gap is None or badge[1] == "elsewhere":
            ll["badge_ids"].append(None)
            continue
        a, b = gap
        label = ctx.labels.get(p.hap, p.hap)
        observed = next((g for g in ll.get("gap_observations", ()) if g["chain"] == p.chain
                         and (g["src"]["start"], g["src"]["end"]) == (a, b)), None)
        ins_id = observed["id"] if observed else difference_id(label, contig, a, b, "insertion")
        length = b - a
        ll["badge_ids"].append(ins_id if length >= 50 else None)
        lo, hi = max(a, int(read["reference_start"])), min(b, int(read["reference_end"]))
        mol_bp = runs.mol_between(lo, hi)
        if length < 50:
            continue
        if length > 50_000:
            ll["insertions"][ins_id] = {"length": length, "too_large": True}
            continue
        requested = ctx.loader_options.get("insertion_ids")
        if requested is not None and ins_id not in requested:
            continue
        args = (read, row, contig, runs, call_lo, ctx, p, a, b, lo, hi, length, label, mol_bp, badge)
        if ctx.pending_insertions is not None:
            # Composed with the window's other hidden blocks in one columnar
            # pass (_compose_pending_insertions); the slot keeps its place.
            ll["insertions"][ins_id] = {}
            ctx.pending_insertions.append((payload, ins_id, observed, args))
            continue
        ll["insertions"][ins_id] = _insertion_payloads(*args)
        if observed:
            ll["insertions"][ins_id].update(_observed_fields(observed))


def _observed_fields(observed):
    return {key: observed[key] for key in ("kind", "t_start", "t_end", "ref_bp", "alt_bp")}


def _compose_pending_insertions(ctx):
    """Compose the hidden blocks ``_insertion_metadata`` deferred, all in one
    columnar pass (each block is its own frame ``[0, length)``), and put each
    where it would have been: in its row's clipped ``insertions`` (as
    ``clip_geometry`` copies it), if the row kept that badge."""
    jobs, ctx.pending_insertions = ctx.pending_insertions, None
    if not jobs:
        return
    from services.background_work import checkpoint

    hidden = []
    for j, (_payload, _ins_id, _observed, args) in enumerate(jobs):
        if not j & 255:
            checkpoint()
        hidden.append(_insertion_row(*args))
    precompute([(args[0], [local], args[3]) for (_p, _i, _o, args), (_c, local) in zip(jobs, hidden)], ctx,
               point_fields=_POINT_FIELDS, rest_parts=_rest_parts, small_group=_SMALL_GROUP,
               regions=[(0, args[11]) for _p, _i, _o, args in jobs])
    for j, ((payload, ins_id, observed, args), local) in enumerate(zip(jobs, hidden)):
        if not j & 255:
            checkpoint()
        block = _insertion_payloads(*args, local=local)
        if observed:
            block.update(_observed_fields(observed))
        kept = payload["live_lift"]["insertions"]
        if ins_id in kept:
            kept[ins_id] = dict(block, pos=block["pos"])


def _insertion_row(read, row, contig, runs, call_lo, ctx, p, a, b, lo, hi, length, label, mol_bp, badge):
    """``(local ctx, synthetic row)`` of a hidden block: the read's source
    ``[lo, hi)`` inside the insertion, in the block's own frame ``[0, length)``."""
    local_ctx = copy.copy(ctx)
    local_ctx.region_start, local_ctx.region_end, local_ctx.width = 0, length, length
    # The synthetic block is not a target locus; never compare it to hg38.
    local_ctx.loader_options = dict(ctx.loader_options, include_cigar=False, _insertion_local=True)
    local_ctx.pending_insertions = None
    local = _Row(row.strand, row.alt)
    local.add_run([_Frag(lo, hi, p._replace(q_start=a, q_end=b, t_start=0, t_end=length))], ctx.settings.rejoin_bp)
    local.index()
    _row_geometry(local, contig, runs, local_ctx)
    return local_ctx, local


def _insertion_payloads(read, row, contig, runs, call_lo, ctx, p, a, b, lo, hi, length, label, mol_bp, badge,
                        local=None):
    """Compose annotations only for an explicitly requested hidden block
    (``local``: its ``_insertion_row``, when already built)."""
    local_ctx, local = local or _insertion_row(read, row, contig, runs, call_lo, ctx, p, a, b, lo, hi, length,
                                               label, mol_bp, badge)
    hidden = _row_payload(read, local, "insertion", 0, 1, contig, runs, call_lo, local_ctx)
    keep = ("intervals", "qualities", "layers", "fire", "deam", *_POINT_FIELDS)
    block = {k: hidden[k] for k in keep if k in hidden}
    covered = [lo - a, hi - a] if row.strand == "+" else [b - hi, b - lo]
    # _Frag.T already mirrors bases as length - 1 - offset; covered
    # and interval endpoints use the separate boundary transform.
    block.update(pos=badge[0] - ctx.region_start, hap_label=label, src=[contig, a, b], length=length,
                 mol_bp=mol_bp, orientation=row.strand, covered=covered)
    return block


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
        column = mapped.array if type(mapped) is IntColumn else None
        if column is not None:
            # The same order, selection and intervals from the group's array.
            pos = np.flatnonzero(column[:, 2] > 0)
            order_a = pos[np.lexsort((pos, column[pos, 1], column[pos, 0]))]
            big = column[order_a, 2] >= ctx.nuc_min_size
        else:
            order = sorted((j for j, iv in enumerate(mapped) if iv[2] > 0), key=lambda j: (mapped[j][0], mapped[j][1], j))
        for name, wanted, keep in (("nuc", infer_nuc, lambda s: s >= ctx.nuc_min_size),
                                   ("tf", infer_tf, lambda s: s < ctx.nuc_min_size)):
            if not wanted:
                continue
            if column is not None:
                picked = order_a[big] if name == "nuc" else order_a[~big]
                sel = picked.tolist()
            else:
                sel = [j for j in order if keep(mapped[j][2])]
            if not sel:
                continue
            names, tracks = [], []
            if ctx.layer_qualities:
                if quals:
                    names.append("nq")
                    index = parts.index() if isinstance(parts, LazyParts) else [part[2] for part in parts]
                    tracks.append([quals[rank[index[j]]] if index[j] in rank else 0 for j in sel])
                if edge:
                    lq = [edge.get(ids[j], [0, 0])[0] for j in sel]
                    rq = [edge.get(ids[j], [0, 0])[1] for j in sel]
                    if row.strand == "-":
                        lq, rq = rq, lq
                    names += ["lq", "rq"]
                    tracks += [lq, rq]
            layers[name] = {"intervals": (IntColumn(column[picked]) if column is not None
                                          else [mapped[j] for j in sel]),
                            "qualities": tracks or None, "quality_names": names}
            call_ids[f"layer:{name}"] = [ids[j] for j in sel]
            call_parts[f"layer:{name}"] = [keys[j] for j in sel]
    if infer_msp:
        if callable(logical):
            logical = logical()
        msp = []
        # Nucleosomes of one rejoin group together; an MSP across a 1-bp map
        # hole is cut at the spans' edges (as top-level gaps are).
        spans, members, groups = _spans(row, ctx), {}, _span_groups(row)
        for span, group in groups.items():
            members.setdefault(group, []).append(span)
        whole = (_logical(parts, mapped, ids, row.frags, groups) if len(members) < len(groups)
                 else {groups[s]: calls for s, calls in logical.items()})
        for group in sorted(members):
            bounds = sorted(spans[s] for s in members[group])
            for iv in generate_msp_from_nuc_gaps(whole.get(group, ()), min_nuc_size=ctx.nuc_min_size):
                pieces = [[max(iv[0], b0), min(iv[1], b1), *iv[2:]] for b0, b1 in bounds
                          if min(iv[1], b1) > max(iv[0], b0)]
                for part in (p for piece in pieces for p in _subtract(piece, cuts)):
                    part[0], part[1] = max(part[0], 0), min(part[1], width)
                    if part[1] > part[0]:
                        msp.append(part)
        if msp:
            msp.sort()
            layers["msp"] = {"intervals": msp, "qualities": None, "quality_names": []}
            call_ids["layer:msp"] = [None] * len(msp)
            call_parts["layer:msp"] = [None] * len(msp)


def _molecular_spans(row, runs, origin):
    """[target start, end, molecule at start, step, primary chain]."""
    out = []
    for frag in row.frags:
        for r0, length in zip(runs.ref, runs.len):
            a, b = max(frag.s, r0), min(frag.e, r0 + length)
            if b <= a:
                continue
            t0, t1 = frag.span_of(a, b)
            m0 = runs.mol_at(b - 1 if frag.minus else a)
            step = (-1 if runs.reverse else 1) * (-1 if frag.minus else 1)
            out.append([t0 - origin, t1 - origin, m0, step, bool(frag.p.primary)])
    return sorted(out)
