"""``lift_compact_reads``: compact reads decoded in a source assembly's
coordinates, mapped to the target (main) genome through selected graphlift
pieces (DESIGN_LIVE_LIFT.md §3.4-§3.7). Pure: no I/O apart from the map's
``gap_span``/``source_to_target`` for parts of a read outside the pieces.

Per piece ``p`` (forward source coordinates):
- base ``T(x)``: ``p.t_start + (x - p.q_start)`` on ``+``, ``p.t_end - 1 - (x - p.q_start)`` on ``-``;
- span ``[a, b)``: ``[T(a), T(b-1)+1)`` on ``+``, ``[T(b-1), T(a)+1)`` on ``-``;
- boundary ``B(x)``: ``p.t_start + (x - p.q_start)`` on ``+``, ``p.t_end - (x - p.q_start)`` on ``-``.

A read's source body ``[reference_start, reference_end)`` is cut by the pieces
into fragments. Fragments form record runs (a run breaks on a strand or
primary change, a backwards step, or a read or target gap of at least ``g_split``);
consecutive runs of one orientation form a row unless a run overlaps the row
in target coordinates. Inside a run a source gap is a badge (exact molecular
bp from the aligned runs) and a target gap a connector; a *span* is a stretch
of fragments with neither between them.

Each run is one record of ``fiberhmm-lift`` (graphlift ``liftbam``), which
writes every junction inside a run as ``I`` (the read's bases there) then
``D`` (the connector), and the rows reproduce what the browser's decoder makes
of that record (lift parity, ``scripts/lift_parity.py``):

- a call runs across a junction (one interval across its badge and
  connector) unless the junction's map gap is part of an indel event of at
  least ``sv_min_len`` (``_junction_cuts``, map pieces only): there the
  lifted record's ``D`` is deleted bases, cut as the decoder cuts calls;
- a legacy tag call (ns/nl, as/al) ending inside the lifted record's
  insertion takes the decoder's base after it, and one inside an insertion
  is the 1-bp interval there (``_legacy_ends``); an MA call ends at aligned
  bases (``_aligned_ends``);
- gaps and inferred MSPs are rebuilt per run from whole calls, bounded by the
  run's other footprint calls when terminal gaps are hidden, then cut at the
  read's deletions and the junctions that cut;
- the terminal-gap filter and the no-footprint rule apply to each run
  (``_run_filter``), as the decoder applies them to each lifted record.

Every part keeps its call's immutable, record-local ``call_id``
(``live_lift.calls``), size and qualities. Logical identity is separate and
selection-independent (``live_lift.call_parts``, ``[part, group]`` as
molecular coordinates): ``part`` is where the part starts on the molecule;
parts joined across gaps of at most ``rejoin_bp`` on both sides (and the
pieces of a call the decoder split at a deletion) share ``group``. A row's
body breaks only at its holes (``live_lift.holes``: the deleted bases of the
junctions that cut); connectors stay drawn.

The molecule's strand (``st``) never changes; on ``-`` rows only the
presentation flips (left/right edge qualities swap, insertion sequence is
reverse-complemented, clip sides swap).

Speed: ``lift_compact_reads`` first builds every read's rows, then maps the
intervals, calls, marks and molecular spans of all rows of the window at once
(``compose_columns``), then assembles each row's payload; the hidden
insertion blocks follow in one more columnar pass. The per-row functions here
(``_map_group``, ``_call_identity``, ``_map_points``, ``_molecular_spans``,
``_logical``/``_gaps``) define the output and handle whatever the columnar
pass leaves to them (among them every interval whose ends may take the
decoder's end rules); it reproduces them exactly.

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

from services.lift.compose_columns import LazyParts, precompute, prepare_runs, prepare_ma
from services.read_columns import IntColumn

_COMPLEMENT = str.maketrans("ACGTNRYKMSWBDHVacgtnrykmswbdhv", "TGCANYRMKSWVHDBtgcanyrmkswvhdb")
# Left/right quality tracks that trade places when intervals reverse (bam_tags.parse_ma_aq_tags_into_layers).
_EDGE_PAIRS = (("lq", "rq"), ("el", "er"))
_SR_LAYERS = {"nuc_sr", "tf_sr"}
# Call ids of legacy tag calls (ns/nl footprints, as/al MSPs), placed with the decoder's insertion rule.
_LEGACY_PREFIXES = ("ns:", "as:")
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
    __slots__ = ("s", "e", "p", "t0", "t1", "minus", "span", "run", "_aligned")

    def __init__(self, s, e, p):
        self.s, self.e, self.p = s, e, p
        self.minus = p.strand == "-"
        self.span = 0
        self.run = 0
        self._aligned = None
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
        if type(runs) is IntColumn:
            a = runs.array
            ref, seq, ln = a[:, 0], length - 1 - a[:, 1] if reverse else a[:, 1], a[:, 2]
            if np.any(ref[1:] <= ref[:-1]):
                order = np.lexsort((ln, seq, ref))
                ref, seq, ln = ref[order], seq[order], ln[order]
            self.ref, self.seq, self.len = ref.tolist(), seq.tolist(), ln.tolist()
            self._arrays = (ref, seq, ln)
        else:
            rows = sorted((int(r0), (length - 1 - int(m0)) if reverse else int(m0), int(n)) for r0, m0, n in runs or ())
            self.ref = [r[0] for r in rows]
            self.seq = [r[1] for r in rows]
            self.len = [r[2] for r in rows]
            self._arrays = None
        self._ascending = None
        self._split_gaps = {}
        self._ma_indexable = None
        self._gap_totals = None

    def arrays(self):
        """Aligned-block columns, shared by geometry and the window pre-pass."""
        if self._arrays is None:
            self._arrays = tuple(np.asarray(v, dtype=np.int64) for v in (self.ref, self.seq, self.len))
        return self._arrays

    def fragment_bounds(self, f):
        """First/last aligned reference bases and SEQ coverage of a fragment.
        Used only for positive blocks disjoint in both frames. Joining,
        trimming, junction edges and MA rules reuse these same searches.
        The owner check also permits callers to reuse fragments with another
        record's CIGAR without reading stale coordinates.
        """
        cached = f._aligned
        if cached is not None and cached[0] is self:
            return cached[1]
        ref, seq, ln = self.ref, self.seq, self.len
        i = bisect.bisect_right(ref, f.s) - 1
        if i < 0 or f.s >= ref[i] + ln[i]:
            i += 1
        j = bisect.bisect_right(ref, f.e - 1) - 1
        if i >= len(ref) or j < i or ref[i] >= f.e:
            bounds = (None, None, None, None)
        else:
            x, y = max(f.s, ref[i]), min(f.e - 1, ref[j] + ln[j] - 1)
            bounds = (x, y, seq[i] + x - ref[i], seq[j] + y - ref[j] + 1)
        f._aligned = (self, bounds)
        return bounds

    def split_gaps(self, g_split):
        """Large gaps between positive, disjoint blocks, computed once per record.
        Unusual overlapping/empty blocks keep the scalar split rules."""
        if g_split not in self._split_gaps:
            try:
                ref, seq, ln = self.arrays()
            except OverflowError:  # Python-int coordinates outside the columnar range
                self._split_gaps[g_split] = None
                return None
            if np.any(ln <= 0) or np.any(ref[:-1] + ln[:-1] > ref[1:]):
                gaps = None
            else:
                ends = ref[:-1] + ln[:-1]
                large = ((ref[1:] - ends >= g_split) |
                         (seq[1:] - (seq[:-1] + ln[:-1]) >= g_split))
                gaps = (ends[large].tolist(), ref[1:][large].tolist())
            self._split_gaps[g_split] = gaps
        return self._split_gaps[g_split]

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
        ref, seq, ln = self.arrays()
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

    def ref_span(self, mol_start, mol_end):
        """The aligned source span ``[r0, r1)`` of the molecular span ``[mol_start, mol_end)``
        (its first and last aligned bases, as ``aligned_query_interval_to_ref``), or None."""
        if not self.ref or mol_end <= mol_start:
            return None
        a, b = (self.length - mol_end, self.length - mol_start) if self.reverse else (mol_start, mol_end)
        seq, ref, ln = self.seq, self.ref, self.len
        i = bisect.bisect_right(seq, a) - 1
        if i < 0 or a >= seq[i] + ln[i]:
            i += 1
            if i >= len(seq) or seq[i] >= b:
                return None
            r0 = ref[i]
        else:
            r0 = ref[i] + (a - seq[i])
        j = bisect.bisect_right(seq, b - 1) - 1
        if j < 0:
            return None
        r1 = ref[j] + min(b - seq[j], ln[j])
        return (r0, r1) if r1 > r0 else None

    def last_aligned_before(self, x, lo):
        """The last aligned reference base in ``[lo, x)``, else None."""
        ref, ln = self.ref, self.len
        i = bisect.bisect_right(ref, x - 1) - 1
        if i < 0:
            return None
        y = min(x - 1, ref[i] + ln[i] - 1)
        return y if y >= lo else None

    def first_aligned_at(self, x, hi):
        """The first aligned reference base in ``[x, hi)``, else None."""
        ref, ln = self.ref, self.len
        i = bisect.bisect_right(ref, x) - 1
        if i >= 0 and x < ref[i] + ln[i]:
            return x
        i += 1
        return ref[i] if i < len(ref) and ref[i] < hi else None

    def clipped(self, m):
        """Whether molecular base ``m`` lies outside the aligned body (a soft or hard clip)."""
        seq = self.seq
        if not seq:
            return True
        s = self.length - 1 - m if self.reverse else m
        return s < seq[0] or s >= seq[-1] + self.len[-1]

    def inserted(self, m):
        """Whether molecular base ``m`` lies inside the aligned body on no aligned base (a read insertion;
        never a clipped base)."""
        seq = self.seq
        if not seq:
            return False
        s = self.length - 1 - m if self.reverse else m
        if s < seq[0] or s >= seq[-1] + self.len[-1]:
            return False
        i = bisect.bisect_right(seq, s) - 1
        return not (i >= 0 and s < seq[i] + self.len[i])

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
        # Junctions (between frags k and k+1; _row_junctions): merge[k] when a call runs across it as the
        # decoder runs a call across the lifted record's CIGAR I/D (same run, not a cut); cut[k] when the map
        # gap's indel event reaches sv_min_len (the decoder cuts calls at its deleted bases); pi[k] the target
        # position of its insertion on the lifted record (liftbam writes I then D: the end of the target-left
        # fragment), where the decoder places a position inside the insertion; ri[k] the start of the
        # target-right fragment's first aligned block (pi..ri: the lifted record's D at the junction).
        self.merge, self.cut, self.pi, self.ri = [], [], [], []
        self.blank_runs = {}     # run -> neutral (lo, hi) or None (the run): footprints blanked (_run_filter)
        self.extents = {}        # run -> target (lo, hi) of its other footprint calls (hidden terminal gaps)
        self.payload_cuts = []   # target deletion cuts applied after mapping call ends
        self.precut = {}         # legacy call id -> (t0, t1, run, size) before a junction that cuts trimmed it

    def add_run(self, run, rejoin_bp):
        span = self.frags[-1].span + 1 if self.frags else 0
        index = len(self.runs)
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
            f.run = index
            self.frags.append(f)
        self.runs.append(run)

    def overlaps(self, run):
        lo, hi = min(f.t0 for f in run), max(f.t1 for f in run)
        return any(f.t0 < hi and f.t1 > lo for f in self.frags)

    def index(self):
        self.starts = [f.s for f in self.frags]
        self.ends = [f.e for f in self.frags]
        self.disjoint = all(a.e <= b.s for a, b in zip(self.frags, self.frags[1:]))
        # after_junction[k]: frag k follows a junction of its run (a call may start inside its insertion)
        self.after_junction = [False] + [gap is not None for gap in self.inner]

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

    def stretches(self, a, b):
        """``[t0, t1, first frag, last frag]`` of source ``[a, b)``: its parts joined across every junction
        a call runs across (``merge``), in source order; unclipped."""
        out = []
        merge = self.merge
        for t0, t1, k in self.parts(a, b):
            if out and out[-1][3] == k - 1 and merge[k - 1]:
                s = out[-1]
                s[0], s[1], s[3] = min(s[0], t0), max(s[1], t1), k
            else:
                out.append([t0, t1, k, k])
        if out and any(self.cut):
            # A junction that cuts loses its whole D on the lifted record, from the target-left fragment's last
            # aligned block to the target-right one's first (a read deletion at a fragment's edge is in it).
            cut, n = self.cut, len(self.frags)
            minus = self.strand == "-"
            for s in out:
                k0, k1 = s[2], s[3]
                if k0 > 0 and cut[k0 - 1] and a < self.frags[k0].s:
                    if minus:
                        s[1] = min(s[1], self.pi[k0 - 1])
                    else:
                        s[0] = max(s[0], self.ri[k0 - 1])
                if k1 < n - 1 and cut[k1] and b > self.frags[k1].e:
                    if minus:
                        s[0] = max(s[0], self.ri[k1])
                    else:
                        s[1] = min(s[1], self.pi[k1])
            out = [s for s in out if s[1] > s[0]]
        return out

    def badge_at(self, x):
        """The junction ``j`` whose source-only stretch ``[frags[j].e, frags[j+1].s)`` holds source
        position ``x`` (inside one run), else None."""
        frags, inner = self.frags, self.inner
        if self.disjoint:
            k = bisect.bisect_right(self.starts, x) - 1
            if 0 <= k < len(frags) - 1 and frags[k].e <= x < frags[k + 1].s and inner[k] is not None:
                return k
            return None
        for k in range(len(frags) - 1):
            if inner[k] is not None and frags[k].e <= x < frags[k + 1].s:
                return k
        return None

    def run_at(self, x):
        """The run holding source position ``x`` (in a fragment or inside a junction's source-only stretch),
        else None."""
        k = self.frag_at(x)
        if k is not None:
            return self.frags[k].run
        j = self.badge_at(x)
        return None if j is None else self.frags[j].run

    def frag_at(self, x):
        """Index of the fragment holding source position ``x``, else None."""
        frags = self.frags
        if self.disjoint:
            k = bisect.bisect_right(self.starts, x) - 1
            return k if k >= 0 and x < frags[k].e else None
        for k, f in enumerate(frags):
            if f.s <= x < f.e:
                return k
        return None

    def group_start(self, k, lo):
        """First fragment of the rejoin group frag ``k`` belongs to, for a call
        whose source extent starts at ``lo``."""
        while k > 0 and self.joinable[k - 1] and self.frags[k - 1].e > lo:
            k -= 1
        return k


def _runs_from_frags(frags, g_split, seq_runs=None):
    """Liftbam record runs, grouped by projected aligned blocks, including CIGAR gaps within a piece.
    Collinear pieces may continue across chains. Runs end at projected aligned bases."""
    aligned = seq_runs if seq_runs is not None and seq_runs.ref else None
    if aligned is not None:
        split = []
        gaps = aligned.split_gaps(g_split)
        for f in frags:
            if gaps is not None:
                ends, starts = gaps
                lo = bisect.bisect_right(ends, f.s)
                hi = bisect.bisect_left(starts, f.e)
                start = f.s
                for j in range(lo, hi):
                    split.append(_Frag(start, ends[j], f.p))
                    start = starts[j]
                split.append(f if start == f.s else _Frag(start, f.e, f.p))
                continue
            start, prev = f.s, None
            i = max(0, bisect.bisect_right(aligned.ref, f.s) - 1)
            while i < len(aligned.ref) and aligned.ref[i] < f.e:
                a, b = max(f.s, aligned.ref[i]), min(f.e, aligned.ref[i] + aligned.len[i])
                if b > a:
                    if prev is not None and (a - prev >= g_split or
                            aligned.seq_at(a) - aligned.seq_at(prev - 1) - 1 >= g_split):
                        split.append(_Frag(start, prev, f.p))
                        start = a
                    prev = b
                i += 1
            split.append(f if start == f.s else _Frag(start, f.e, f.p))
        frags = split
    frags = sorted(frags, key=lambda f: (f.s, f.t0))
    runs = []
    last_aligned = None
    for f in frags:
        if runs and _continues(runs[-1][-1], f, g_split, aligned, last_aligned, runs[-1]):
            runs[-1].append(f)
        else:
            runs.append([f])
            last_aligned = None
        if aligned is not None and not aligned._ma_indexable:
            y = aligned.last_aligned_before(f.e, f.s)
            if y is not None:
                last_aligned = (f, y)
    if aligned is not None:
        runs = [t for t in (_trim_run(run, aligned) for run in runs) if t]
    return runs


def _continues(prev, f, g_split, seq_runs, last_aligned, run=None):
    """Whether fragment ``f`` extends ``run`` (fragments sorted by source start)."""
    if (f.p.strand != prev.p.strand or f.p.primary != prev.p.primary
            or f.s < prev.e):
        return False
    gap = (prev.t0 - f.t1) if f.minus else (f.t0 - prev.t1)
    if not 0 <= gap < g_split:
        return False
    if seq_runs is None:
        return f.s - prev.e < g_split
    totals = seq_runs._gap_totals
    if totals is not None:
        deleted, inserted = totals
        # Both fragments must contain aligned bases. Within the record's
        # aligned body a fragment longer than all deleted bases cannot be
        # empty. Edge deletions can enlarge dt by at most `deleted`, and
        # inserted bases can enlarge dq by at most `inserted`.
        if (gap + deleted < g_split and f.s - prev.e + inserted < g_split
                and prev.e - prev.s > deleted and f.e - f.s > deleted
                and seq_runs.ref[0] <= prev.s and f.e <= seq_runs.ref[-1] + seq_runs.len[-1]):
            return True
    if seq_runs._ma_indexable and run is not None:
        for previous in reversed(run):
            _x, y, _q0, q1 = seq_runs.fragment_bounds(previous)
            if y is not None:
                last_aligned = (previous, y, q1 - 1)
                break
    if last_aligned is not None and len(last_aligned) == 3:
        x, _y, qx, _q1 = seq_runs.fragment_bounds(f)
        if x is None:
            return True
        fy, y, qy = last_aligned
        ty, tx = fy.T(y), f.T(x)
        dt = (ty - tx - 1) if f.minus else (tx - ty - 1)
        return dt < g_split and qx - qy - 1 < g_split
    x = seq_runs.first_aligned_at(f.s, f.e)
    if x is None or last_aligned is None:  # no aligned block on one side yet: nothing for liftbam to split
        return True
    fy, y = last_aligned
    ty, tx = fy.T(y), f.T(x)
    dt = (ty - tx - 1) if f.minus else (tx - ty - 1)
    dq = seq_runs.seq_at(x) - seq_runs.seq_at(y) - 1
    return dt < g_split and dq < g_split


def _trim_run(run, seq_runs):
    """The run from its first aligned base to its last (empty without one)."""
    x = next((x for f in run if (x := (seq_runs.fragment_bounds(f)[0] if seq_runs._ma_indexable
                                     else seq_runs.first_aligned_at(f.s, f.e))) is not None), None)
    y = next((y for f in reversed(run) if (y := (seq_runs.fragment_bounds(f)[1] if seq_runs._ma_indexable
                                               else seq_runs.last_aligned_before(f.e, f.s))) is not None), None)
    if x is None or y is None:
        return []
    if x == run[0].s and y + 1 == run[-1].e:
        return run
    out = []
    for f in run:
        s, e = max(f.s, x), min(f.e, y + 1)
        if e > s:
            trimmed = f if s == f.s and e == f.e else _Frag(s, e, f.p)
            trimmed._aligned = f._aligned
            out.append(trimmed)
    return out


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
        # The decoder's per-record footprint rules, applied per lifted record (_run_filter).
        self.terminal_gap_threshold = int(opts.get("terminal_gap_threshold", 500) or 0)
        self.min_footprints = int(opts.get("min_footprints", 0) or 0)
        self.min_fp_quality = int(opts.get("min_fp_quality", 0) or 0)
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
        self.requested_layer_set = requested
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
        source_runs = [_SeqRuns(read.get("_fiberbrowser_aligned_runs"),
                                read.get("_fiberbrowser_lift_record") or {}) for read in reads]
        prepare_runs(source_runs, settings.g_split)
        for i, (read, runs) in enumerate(zip(reads, source_runs)):
            if not i & 255:
                checkpoint()
            item = _read_geometry(read, by_contig, haps, ctx, runs)
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


def _read_rows(read, indexed, settings, seq_runs=None):
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
    rows = _rows_from_runs(_runs_from_frags(primary_frags, settings.g_split, seq_runs), False, settings.rejoin_bp)
    for chain in sorted(alt_frags):
        rows += _rows_from_runs(_runs_from_frags(alt_frags[chain], settings.g_split, seq_runs), True,
                                settings.rejoin_bp)
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
    for idx, row in enumerate(_read_rows(read, (pieces, [p.q_start for p in pieces]), settings, runs)):
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


def _read_geometry(read, by_contig, haps, ctx, runs=None):
    """``(read, rows, runs)`` with each row's geometry, or None (counted) for
    a read with no fragment in the selected pieces."""
    rec = read.get("_fiberbrowser_lift_record") or {}
    contig = rec.get("contig")
    if runs is None:
        runs = _SeqRuns(read.get("_fiberbrowser_aligned_runs"), rec)
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    rows = _read_rows(read, by_contig.get(contig) or ([], [], []), ctx.settings, runs)
    if not rows:
        ctx.count("records_without_correspondence")
        return None
    for row in rows:
        row.index()
        _row_geometry(row, contig, runs, ctx)
    rows = _run_filter(read, rows, runs, ctx)
    if not rows:
        # The decoder's footprint rules leave every lifted record of it out (a loader filter, as on a native
        # load); graph reads report it so (graph_panel/reads.py).
        ctx.count("records_terminal_gap_filtered")
        read["_fiberbrowser_footprint_filtered"] = True
        return None
    _outside_badges([r for r in rows if not r.alt], contig, rs, re_, runs, haps, ctx)
    key = (read.get("library_id") or read.get("source_path") or "", read.get("id"))
    if not (ctx.molecules.get(key) or {}).get("hap") and (read.get("_fiberbrowser_primary") or {}).get("is_supplementary"):
        ctx.count("hap_from_record")
    return read, rows, runs


def _hull_in_run(a, b, row, lo, hi, legacy):
    """Target hull ``(t0, t1)`` of source ``[a, b)`` on frags ``lo..hi`` (one run), as the decoder places a
    call on that run's lifted record: its aligned bases there; a legacy call's end inside a source-only
    stretch at the stretch's insertion (and one inside such a stretch the 1-bp ``[P, P + 1)``). None when
    nothing of it lands there."""
    frags = row.frags
    t0 = t1 = None
    # A run is monotone in target order; on disjoint source fragments its
    # outer intersecting fragments determine the hull. Interior fragments
    # cannot change either edge.
    if row.disjoint:
        first = bisect.bisect_right(row.ends, a, lo, hi + 1)
        last = bisect.bisect_left(row.starts, b, first, hi + 1) - 1
        intersecting = (first, last) if last > first else range(first, last + 1)
    else:
        intersecting = range(lo, hi + 1)
    for k in intersecting:
        f = frags[k]
        if f.e <= a or f.s >= b:
            continue
        s0, s1 = f.span_of(a, b)
        t0 = s0 if t0 is None else min(t0, s0)
        t1 = s1 if t1 is None else max(t1, s1)
    minus = frags[lo].minus
    if not legacy:
        if t0 is None:
            return None
        js, je = (row.badge_at(b - 1), row.badge_at(a)) if minus else (row.badge_at(a), row.badge_at(b - 1))
        if js is not None and lo <= js < hi:
            t0 = max(t0, row.ri[js])
        if je is not None and lo <= je < hi:
            t1 = min(t1, row.pi[je])
        return (t0, t1) if t1 > t0 else None
    jl, jr = row.badge_at(a), row.badge_at(b - 1)
    jl = jl if jl is not None and lo <= jl < hi else None
    jr = jr if jr is not None and lo <= jr < hi else None
    # The decoder judges a record's footprints before it cuts them at deletions: a junction that cuts
    # changes nothing here.
    if t0 is None:
        if jl is None or jl != jr:
            return None
        return row.pi[jl], row.pi[jl] + 1
    inside = frags[lo].s <= a and b <= frags[hi].e
    # The target start (source start on '+', source end on '-') must lie on the run (else aligned bases only).
    js, je = (jr, jl) if minus else (jl, jr)
    if (frags[hi].e >= b) if minus else (frags[lo].s <= a):
        if js is not None:
            t0 = min(t0, row.pi[js])
        if inside and je is not None:
            t1 = max(t1, row.pi[je] + 1)
    return t0, t1


def _first_last(spans, a, b, starts=None):
    """Indices of the first and last of the sorted ``[s, e]`` spans overlapping ``[a, b)``, or None
    (``starts``: their starts, when kept)."""
    if starts is None:
        starts = [s[0] for s in spans]
    i = bisect.bisect_left(starts, a)
    # Starts alone cannot exclude an earlier interval containing nested calls.
    i = next((k for k in range(i) if spans[k][1] > a), i)
    j = bisect.bisect_left(starts, b) - 1
    while i <= j and spans[i][1] <= a:
        i += 1
    if i > j:
        return None
    return i, j


def _ma_spans(read, runs, named=False):
    """The record's MA footprint calls (nuc, tf, fp_v2) as aligned source spans ``[r0, r1]`` (or
    ``(r0, r1, name)``), parsed from the call bounds the source decode kept."""
    bounds = read.get("_fiberbrowser_call_bounds") or {}
    out = bounds.get("_ma_named")
    if out is None:
        ma = bounds.get("ma")
        out = []
        if ma is not None:
            lead = ma[4]
            calls = _ma_queries(bounds)
            out = _ma_block_spans(calls, lead, runs)
        out.sort()
        # Presence by name and the unnamed call extents use the same aligned
        # blocks. Parsing and projecting the MA tags twice dominates cold loads.
        bounds["_ma_named"] = out
    return out if named else [[a, b] for a, b, _name in out]


def _ma_queries(bounds):
    """Whole-record MA calls, reusing the source decoder's parsed query spans."""
    calls = bounds.get("_ma_query")
    if calls is None:
        from services.compact_read_loader import ma_footprint_query_spans
        tags, length, reverse, contracts, _lead = bounds["ma"]
        calls = bounds["_ma_query"] = ma_footprint_query_spans(
            tags, read_length=length, is_reverse=reverse, family_contracts=contracts)
    return calls


def _ma_block_spans(calls, lead, runs):
    """Project all MA calls onto aligned blocks in one pass, retaining block boundaries."""
    if not calls or not runs.ref:
        return []
    try:
        ref, seq, ln = runs.arrays()
        ab = np.asarray([(a + lead, b + lead) for _name, a, b in calls], dtype=np.int64)
        # The scalar loop below also defines behaviour for unusual SEQ order
        # and Python-int coordinates outside safe columnar arithmetic.
        safe = (np.all(seq[:-1] <= seq[1:]) and
                all(int(v.min()) > -(1 << 40) and int(v.max()) < (1 << 40)
                    for v in (ref, seq, ln, ab)))
    except OverflowError:
        safe = False
    if safe:
        a, b = ab[:, 0], ab[:, 1]
        lo = np.maximum(np.searchsorted(seq, a, side="right") - 1, 0)
        hi = np.searchsorted(seq, b, side="left")
        count = np.maximum(hi - lo, 0)
        ci = np.repeat(np.arange(len(calls)), count)
        off = np.zeros(len(calls) + 1, dtype=np.int64)
        np.cumsum(count, out=off[1:])
        j = lo[ci] + np.arange(len(ci)) - off[ci]
        x, y = np.maximum(a[ci], seq[j]), np.minimum(b[ci], seq[j] + ln[j])
        keep = y > x
        ci, j, x, y = ci[keep], j[keep], x[keep], y[keep]
        r0, r1 = ref[j] + x - seq[j], ref[j] + y - seq[j]
        return [(s, e, calls[i][0]) for s, e, i in zip(r0.tolist(), r1.tolist(), ci.tolist())]
    out = []
    for name, q0, q1 in calls:
        a, b = q0 + lead, q1 + lead
        i = max(0, bisect.bisect_right(runs.seq, a) - 1)
        while i < len(runs.seq) and runs.seq[i] < b:
            r, q, n = runs.ref[i], runs.seq[i], runs.len[i]
            x, y = max(a, q), min(b, q + n)
            if y > x:
                out.append((r + x - q, r + y - q, name))
            i += 1
    return out


def _ma_ref_spans(read, runs):
    """Aligned MA coverage for call extents, once per record.

    Extents need the union of the calls, without their names or identities.
    Merge their query spans before projecting onto CIGAR blocks: overlapping
    MA families otherwise project the same bases many times.
    """
    bounds = read["_fiberbrowser_call_bounds"]
    cached = bounds.get("_ma_ref")
    if cached is None:
        ma = bounds.get("ma")
        merged = []
        if ma is not None:
            for a, b in sorted((a, b) for _name, a, b in _ma_queries(bounds) if b > a):
                if merged and a <= merged[-1][2]:
                    merged[-1][2] = max(merged[-1][2], b)
                else:
                    merged.append([None, a, b])
        cached = sorted([a, b] for a, b, _name in _ma_block_spans(merged, ma[4], runs)) if merged else []
        bounds["_ma_ref"] = cached
    return cached


def _extreme_hull(spans, a, b, row, lo, hi, legacy, order=None, starts=None):
    """Target extent ``(t0, t1)`` of the sorted ``[s, e]`` spans overlapping source ``[a, b)`` on run frags
    ``lo..hi``, from the outermost ones (first by start, last by end) that land on that run (placement is
    monotone along a run), or None. ``order``: the spans' indices by descending end, ``starts`` their starts,
    when known."""
    got = _first_last(spans, a, b, starts)
    if got is None:
        return None
    i, j = got
    left = None
    for idx in range(i, j + 1):
        left = _hull_in_run(spans[idx][0], spans[idx][1], row, lo, hi, legacy)
        if left is not None:
            break
    if left is None:
        return None
    right = None
    for idx in (order if order is not None else sorted(range(i, j + 1), key=lambda x: -spans[x][1])):
        if i <= idx <= j:
            right = _hull_in_run(spans[idx][0], spans[idx][1], row, lo, hi, legacy)
            if right is not None:
                break
    return min(left[0], right[0]), max(left[1], right[1])


def _run_calls(read, bounds, row, lo, hi, runs, whole, extent=True):
    """``(has footprints, footprint extent, extent)`` of run frags ``lo..hi`` as the decoder finds them on
    that run's lifted record: its kept ns/nl footprints (target ``(t0, t1)`` of the outermost, or None)
    and the extent ``(lo, hi)`` of its other footprint calls (MA nuc/tf/fp_v2, dropped read-end calls) or
    None. ``whole``: the run holds every call of the record, so the record's bounds apply."""
    frags = row.frags
    a, b = frags[lo].s, frags[hi].e
    fp = bounds.get("fp") or ()
    if whole:  # every footprint is on the run: the record's footprint extent placed on it
        span = bounds.get("fp_extent")
        has_fp = span is not None
        fp_ext = _hull_in_run(span[0], span[1], row, lo, hi, True) if has_fp else None
    else:
        starts = bounds.get("_fp_starts")
        if starts is None:
            starts = bounds["_fp_starts"] = [s[0] for s in fp]
            bounds["_fp_by_end"] = sorted(range(len(fp)), key=lambda x: -fp[x][1])
        has_fp = bool(fp) and _first_last(fp, a, b, starts) is not None
        fp_ext = _extreme_hull(fp, a, b, row, lo, hi, True, bounds["_fp_by_end"], starts) if has_fp else None
    ext = None
    if not extent:  # shown terminal gaps: the decoder neither filters nor bounds gaps by the call extent
        return has_fp, fp_ext, None
    span = bounds.get("extent") if whole else None
    if whole and (span is None or (row.frag_at(span[0]) is not None and row.frag_at(span[1] - 1) is not None)):
        if span is not None:
            ext = _hull_in_run(span[0], span[1], row, lo, hi, False)
    else:  # per call (an outermost call may lie in a source-only stretch: the decoder then takes the next)
        if row.disjoint and "_ma_query_union" not in bounds:
            prepare_ma([read], [runs], _ma_queries)
        query_union = bounds.get("_ma_query_union")
        if query_union is not None and row.disjoint:
            ext = _ma_hull(query_union, row, lo, hi, runs)
            ma_spans = ()
        else:
            ma_spans = _ma_ref_spans(read, runs)
        for spans, legacy in ((ma_spans, False), (bounds.get("dropped") or (), True)):
            h = _extreme_hull(spans, a, b, row, lo, hi, legacy) if spans else None
            if h is not None:
                ext = h if ext is None else (min(ext[0], h[0]), max(ext[1], h[1]))
    return has_fp, fp_ext, ext


def _ma_hull(coverage, row, lo, hi, runs):
    """MA coverage hull on one run, searching only its outer aligned bases.

    The indexed CIGAR blocks are positive and disjoint in both frames. A
    query union intersecting a fragment therefore needs just its first/last
    intersecting block; interior blocks cannot enlarge the target hull.
    _hull_in_run still applies the decoder's junction end rules.
    """
    starts, ends = coverage
    ref, seq, ln = runs.ref, runs.seq, runs.len

    def edge(right):
        fragments = range(hi, lo - 1, -1) if right else range(lo, hi + 1)
        for k in fragments:
            f = row.frags[k]
            x, y, a, b = runs.fragment_bounds(f)
            if x is None or y is None:
                continue
            i = bisect.bisect_left(starts, b) - 1 if right else bisect.bisect_right(ends, a)
            while 0 <= i < len(starts) and ends[i] > a and starts[i] < b:
                q0, q1 = max(a, starts[i]), min(b, ends[i])
                if right:
                    j = bisect.bisect_left(seq, q1) - 1
                else:
                    j = max(0, bisect.bisect_right(seq, q0) - 1)
                    if j < len(seq) and seq[j] + ln[j] <= q0:
                        j += 1
                if 0 <= j < len(seq) and min(q1, seq[j] + ln[j]) > max(q0, seq[j]):
                    r0 = ref[j] + max(starts[i] - seq[j], 0)
                    r1 = ref[j] + min(ends[i] - seq[j], ln[j])
                    hull = _hull_in_run(r0, r1, row, lo, hi, False)
                    if hull is not None:
                        return hull
                i += -1 if right else 1
        return None

    left = edge(False)
    if left is None:
        return None
    right = edge(True)
    return min(left[0], right[0]), max(left[1], right[1])


def _explicit_ma(read, row, lo, hi, ctx, supplementary):
    """Whether the decoder keeps run frags ``lo..hi``'s lifted record for its explicit MA layers when the
    footprint rules reject it (it then shows a neutral row): requested MA layer calls on that run (drawn,
    or left out as read-end calls), or a supplementary record (``supplementary()``) kept for its local
    evidence."""
    if ctx.requested_layer_set is not None:
        names = set((read.get("_fiberbrowser_legacy") or {}).get("ma_names") or ())
        base = int(read["_fiberbrowser_source_base"])
        s0, s1 = row.frags[lo].s, row.frags[hi].e
        for name, layer in (read.get("layers") or {}).items():
            if name in names and isinstance(layer, dict):
                for iv in layer.get("intervals") or ():
                    if iv[0] + base < s1 and iv[1] + base > s0:
                        return True
        for x0, x1 in (read.get("_fiberbrowser_call_bounds") or {}).get("ma_skipped") or ():
            if x0 < s1 and x1 > s0:
                return True
    return bool(ctx.min_footprints <= 0 and ctx.min_fp_quality <= 0 and supplementary())


def _record_runs(read, ctx, seq_runs=None):
    """liftbam's placements of the record: its whole source span through every primary piece of the map
    (outside the selection too), as chain runs; None without a map."""
    if ctx.handle is None:
        return None
    contig = (read.get("_fiberbrowser_lift_record") or {}).get("contig")
    rs, re_ = int(read["reference_start"]), int(read["reference_end"])
    haps = {p.hap for p in ctx.selection.pieces}
    frags = [_Frag(max(p.q_start, rs), min(p.q_end, re_), p) for p in ctx.projections(contig, rs, re_, haps)
             if p.primary and min(p.q_end, re_) > max(p.q_start, rs)]
    return _runs_from_frags(frags, ctx.settings.g_split, seq_runs)


def _supplementary_runs(read, rows, runs, ctx):
    """``{(id(row), run index)}`` of the runs whose lifted record is supplementary: liftbam keeps the source
    record's flag and marks every placement but the one with the most aligned bases (the first of equals)
    0x800, over the record's whole projection (``_record_runs``; else the rows' runs). A liftbam record is a
    run of a primary row (alternative rows have none)."""
    every = {(id(row), r) for row in rows for r in range(len(row.runs))}
    if (read.get("_fiberbrowser_primary") or {}).get("is_supplementary"):
        return every
    placed = [(row, r, run) for row in rows if not row.alt for r, run in enumerate(row.runs)]
    full = _record_runs(read, ctx, runs)
    candidates = full if full else [run for _row, _r, run in placed]
    if not candidates:
        return every
    aligned = [sum(runs.coverage(f.s, f.e, f.s, f.s)[0] for f in run) for run in candidates]
    best = candidates[max(range(len(candidates)), key=lambda i: (aligned[i], -i))]
    keys = {(f.p.chain, f.p.strand) for f in best}

    def is_best(run):
        return any((f.p.chain, f.p.strand) in keys and any(f.s < g.e and g.s < f.e for g in best) for f in run)
    return every - {(id(row), r) for row, r, run in placed if is_best(run)}


def _footprints_on(bounds, a, b):
    """How many of the record's ns/nl footprints (kept and dropped read-end ones) overlap source ``[a, b)``."""
    n = 0
    for spans in (bounds.get("fp") or (), bounds.get("dropped") or ()):
        got = _first_last(spans, a, b) if spans else None
        if got is not None:
            n += got[1] - got[0] + 1
    return n


def _run_filter(read, rows, runs, ctx):
    """The decoder's per-record rules for footprints, applied to each lifted record (a run: liftbam writes
    one record per run), with the record's calls placed as on that record: a run with no footprint, or
    whose first or last call lies more than ``terminal_gap_threshold`` from its ends (with terminal gaps
    hidden), is left out, or blanked to a neutral row when explicit MA layers keep it; a run with only
    dropped read-end footprints is a neutral row over its calls (``row.blank_runs``: run -> neutral
    bounds, None for the run's). Sets each kept row's ``extents`` (its hidden terminal gaps' bounds). The
    source decode skipped these rules (``live_lift._FIXED_LOADER_OPTIONS``). Returns the rows, rebuilt
    without the runs left out."""
    bounds = read.get("_fiberbrowser_call_bounds")
    if bounds is None:
        return rows
    hide = ctx.hide_terminal_gaps
    thr = ctx.terminal_gap_threshold if hide else 0
    fp_span, span = bounds.get("fp_extent"), bounds.get("extent")
    rec_lo = min(([fp_span[0]] if fp_span else []) + ([span[0]] if span else []), default=None)
    rec_hi = max(([fp_span[1]] if fp_span else []) + ([span[1]] if span else []), default=None)
    dropped = bounds.get("dropped") or ()
    supp = []   # computed on first need (a rejected run)

    def supplementary(row, r):
        if not supp:
            supp.append(_supplementary_runs(read, rows, runs, ctx))
        return (id(row), r) in supp[0]

    out = []
    for row in rows:
        decisions, extents, lo = [], {}, 0
        for r, run in enumerate(row.runs):
            hi = lo + len(run) - 1
            if ctx.min_footprints > 0 and _footprints_on(bounds, run[0].s, run[-1].e) < ctx.min_footprints:
                # The decoder's membership gate, on each lifted record's own footprints (read-end ones too).
                decisions.append(("drop", None))
                extents[r] = None
                lo = hi + 1
                continue
            whole = rec_lo is not None and run[0].s <= rec_lo and run[-1].e >= rec_hi
            has_fp, fp_ext, ext = _run_calls(read, bounds, row, lo, hi, runs, whole, hide)
            t0, t1 = row.segments[r][0], row.segments[r][1]
            stubs = (_extreme_hull(dropped, row.frags[lo].s, row.frags[hi].e, row, lo, hi, True)
                     if not has_fp and dropped else None)
            first = last = None
            for e in ((fp_ext if has_fp else stubs), ext):
                if e is not None:
                    first = e[0] if first is None else min(first, e[0])
                    last = e[1] if last is None else max(last, e[1])
            far = thr > 0 and first is not None and (first - t0 > thr or t1 - last > thr)
            neutral = None
            if stubs is not None and hide and first is not None:
                # Only read-end footprints (dropped): the decoder's neutral row over the record's calls.
                neutral = (max(first, t0), min(last, t1))
            explicit = lambda: _explicit_ma(read, row, lo, hi, ctx, lambda: supplementary(row, r))
            if has_fp and not far:
                decisions.append(("keep", None))
            elif stubs is not None and not far:
                decisions.append(("blank", neutral))
            elif explicit():
                decisions.append(("blank", neutral))
            else:
                decisions.append(("drop", None))
            extents[r] = ext
            lo = hi + 1
        if all(d != "drop" for d, _n in decisions):
            row.blank_runs = {r: n for r, (d, n) in enumerate(decisions) if d == "blank"}
            row.extents = {r: e for r, e in extents.items() if e is not None}
            out.append(row)
            continue
        ctx.count("runs_terminal_gap_filtered", sum(d == "drop" for d, _n in decisions))
        kept = [(run, d, extents[r]) for r, (run, d) in enumerate(zip(row.runs, decisions)) if d[0] != "drop"]
        if not kept:
            continue
        new = _Row(row.strand, row.alt)
        for run, _d, _e in kept:
            new.add_run(run, ctx.settings.rejoin_bp)
        new.index()
        _row_geometry(new, (read.get("_fiberbrowser_lift_record") or {}).get("contig"), runs, ctx)
        new.blank_runs = {r: d[1] for r, (_run, d, _e) in enumerate(kept) if d[0] == "blank"}
        new.extents = {r: e for r, (_run, _d, e) in enumerate(kept) if e is not None}
        out.append(new)
    return out


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
    """Segments (one per lifted record), connectors, inner badges and the junction table."""
    row.segments = []
    for run in row.runs:
        p = run[0].p
        # Runs end at their first and last aligned bases (_trim_run), as liftbam's records do.
        row.segments.append([min(f.t0 for f in run), max(f.t1 for f in run), p.chain, p.strand, p.primary])
    n = max(len(row.frags) - 1, 0)
    row.merge, row.cut = [False] * n, [False] * n
    row.pi, row.ri = _BlockEdges(row, runs, False), _BlockEdges(row, runs, True)
    mols = {}
    for k, gap in enumerate(row.inner):
        prev, f = row.frags[k], row.frags[k + 1]
        if gap is not None:
            row.merge[k] = True
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
            mol = runs.mol_between(prev.e, f.s)
            mols[k] = mol
            row.badges.append([pos, ctx.gap_reason(contig, prev.e), mol, dq, "I"])
            row.badge_sources.append((prev.e, f.s, prev.p))
    if n:
        _junction_cuts(row, mols, ctx.sv_min_len)


class _BlockEdges:
    """``row.pi`` (``right`` False) or ``row.ri``, computed on first use per junction: the target-left
    fragment's last aligned block end, or the target-right fragment's first aligned block start (a read
    deletion at a fragment's edge moves its block edge; liftbam writes those deleted bases into the
    junction's D, after the I)."""
    __slots__ = ("frags", "runs", "right", "cache")

    def __init__(self, row, runs, right):
        # Keep the fragments, rather than the row: row.pi/ri own these lookups,
        # so retaining the row would make every composed row a reference cycle.
        self.frags, self.runs, self.right, self.cache = row.frags, runs, right, {}

    def __len__(self):
        return max(len(self.frags) - 1, 0)

    def __getitem__(self, k):
        v = self.cache.get(k)
        if v is None:
            prev, f = self.frags[k], self.frags[k + 1]
            runs = self.runs
            if not self.right:  # pi: after the target-left fragment's last aligned base
                if f.minus:  # the target-left fragment is the later one in source order
                    x = runs.fragment_bounds(f)[0] if runs._ma_indexable else runs.first_aligned_at(f.s, f.e)
                    v = f.T(x) + 1 if x is not None else f.t1
                else:
                    x = runs.fragment_bounds(prev)[1] if runs._ma_indexable else runs.last_aligned_before(prev.e, prev.s)
                    v = prev.T(x) + 1 if x is not None else prev.t1
            elif f.minus:  # ri: the target-right fragment's first aligned base
                x = runs.fragment_bounds(prev)[1] if runs._ma_indexable else runs.last_aligned_before(prev.e, prev.s)
                v = prev.T(x) if x is not None else prev.t0
            else:
                x = runs.fragment_bounds(f)[0] if runs._ma_indexable else runs.first_aligned_at(f.s, f.e)
                v = f.T(x) if x is not None else f.t0
            self.cache[k] = v
        return v


def _junction_cuts(row, mols, sv_min_len):
    """``row.cut``: junctions whose map gap is part of an indel event of at least ``sv_min_len`` on the
    lifted record, grouped as the decoder groups CIGAR pieces (``sv_alleles.cigar_replacements``: pieces of
    at least ``SV_PIECE_MIN`` joined across at most ``SV_MERGE_GAP`` aligned bp; only deleted bases cut).
    The lifted record (liftbam) writes each junction as ``I`` (the read's bases between the fragments,
    ``mols``) then ``D`` (the connector) between the fragments' aligned blocks. Map pieces only: a read
    indel next to a map gap is not grouped with it (the decoder does that on the lifted CIGAR, an artifact
    of composing two alignments into one CIGAR)."""
    from services.sv_events import SV_MERGE_GAP, SV_PIECE_MIN

    inner, frags = row.inner, row.frags
    big = False
    for k, gap in enumerate(inner):
        if gap is not None and (gap[1] >= SV_PIECE_MIN or mols.get(k, 0) >= SV_PIECE_MIN):
            big = True
            break
    if not big:
        return
    from services.sv_alleles import cigar_replacements
    first = 0
    for run in row.runs:
        last = first + len(run) - 1
        # An event reaches sv_min_len only with that many inserted or deleted bases among its pieces.
        if (any(inner[k][1] >= SV_PIECE_MIN or mols.get(k, 0) >= SV_PIECE_MIN for k in range(first, last))
                and (sum(inner[k][1] for k in range(first, last)) >= sv_min_len
                     or sum(mols.get(k, 0) for k in range(first, last)) >= sv_min_len)):
            pieces = []
            for k in range(first, last + 1):
                f = frags[k]
                pieces.append((0, 0, f.t1 - f.t0, 0))
                if k < last:
                    if mols.get(k, 0) > 0:
                        pieces.append((1, k, mols[k], 0))
                    if inner[k][1] > 0:
                        pieces.append((2, k, inner[k][1], 0))
            for ev in cigar_replacements(pieces, piece_min=SV_PIECE_MIN, merge_gap=SV_MERGE_GAP):
                if ev["len"] < sv_min_len:
                    continue
                for p in ev.get("raw_pieces") or (dict(t=ev["t"], ref=ev["ref"]),):
                    if p["t"] == "D":
                        row.cut[p["ref"]] = True
                        row.merge[p["ref"]] = False
        first = last + 1


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

def _legacy_group(calls):
    """Whether a group's calls are legacy tag calls (ns/nl footprints, as/al MSPs): the decoder places them
    with ``footprint_to_ref`` (an end inside an insertion takes the base after it), not the aligned-base rule
    of MA calls. A group is one or the other (``ns:``/``as:`` vs ``MA<n>:`` ids)."""
    for call in calls or ():
        if call:
            cid = call[0]
            return isinstance(cid, str) and cid[:3] in _LEGACY_PREFIXES
    return False


def _map_group(ivs, calls, row, base, runs, ctx):
    """``[(t0, t1, i, k)]``: target parts (region-relative, clipped) of a
    group's intervals ``ivs`` (region-relative source), with the interval index
    ``i`` and the first fragment ``k`` of each part. A part is an interval's
    stretch across the junctions a call runs across (``_Row.stretches``: the
    decoder runs a call across the lifted record's CIGAR ``I``/``D`` unless the
    map gap is a cut); a legacy call's ends follow the decoder's insertion rule
    (``_legacy_ends``). Gaps (negative size) are left out.

    Intervals inside one fragment whose ends need no insertion rule (nearly
    all) are mapped in one pass, vectorised for large groups; the rest one by
    one."""
    if not ivs:
        return []
    width, rs0 = ctx.width, ctx.region_start
    out, rest = [], []
    legacy = calls is not None and _legacy_group(calls)
    # A legacy call on a '-' row may end inside a read insertion (the decoder's base after it lies on the
    # other side there), and one starting at a fragment that follows a junction may start inside the
    # lifted record's insertion: both go one by one.
    minus_legacy = legacy and row.strand == "-"
    after = row.after_junction if legacy else None
    if row.disjoint and len(ivs) <= _SMALL_GROUP and not minus_legacy:
        starts, ends, frags = row.starts, row.ends, row.frags
        for i, iv in enumerate(ivs):
            if len(iv) > 2 and iv[2] < 0:
                continue
            a, b = base + iv[0], base + iv[1]
            k = bisect.bisect_right(starts, a) - 1
            if k < 0 or b > ends[k] or (legacy and a == starts[k] and after[k]):
                rest.append(i)
                continue
            t0, t1 = frags[k].span_of(a, b)
            c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
            if c1 > c0:
                out.append((c0, c1, i, k))
    elif row.disjoint and not minus_legacy:
        n = len(ivs)
        a = np.fromiter((iv[0] for iv in ivs), dtype=np.int64, count=n) + base
        b = np.fromiter((iv[1] for iv in ivs), dtype=np.int64, count=n) + base
        size = np.fromiter((iv[2] if len(iv) > 2 else 0 for iv in ivs), dtype=np.int64, count=n)
        todo = size >= 0
        starts_a = np.asarray(row.starts, dtype=np.int64)
        ends_a = np.asarray(row.ends, dtype=np.int64)
        k = np.searchsorted(starts_a, a, side="right") - 1
        kk = np.maximum(k, 0)
        fast = todo & (k >= 0) & (b <= ends_a[kk])
        if legacy:
            fast &= ~((a == starts_a[kk]) & np.asarray(after, dtype=bool)[kk])
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
        # has no parts unless a legacy call lies inside a source-only stretch.
        nxt = np.minimum(k + 1, len(starts_a) - 1)
        overlaps = ((k >= 0) & (ends_a[kk] > a)) | ((k + 1 < len(starts_a)) & (starts_a[nxt] < b))
        if legacy:
            overlaps |= (k >= 0) & (k + 1 < len(starts_a))  # inside a badge: the decoder's 1-bp stub
        rest = np.flatnonzero(todo & ~fast & overlaps).tolist()
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
    st = row.stretches(ai, bi)
    if call and isinstance(call[0], str) and call[0][:3] in _LEGACY_PREFIXES:
        size = ivs[i][2] if len(ivs[i]) > 2 else 0
        st = _legacy_ends(st, ai, bi, call, row, runs, int(size))
    elif st:
        st = _aligned_ends(st, ai, bi, row)
    out = []
    for t0, t1, k, _k1 in st:
        c0, c1 = max(t0 - rs0, 0), min(t1 - rs0, width)
        if c1 > c0:
            out.append((c0, c1, i, k))
    return out


def _insertion_end(x, m, row, runs):
    """Where the decoder places a legacy call's end at source position ``x``
    (molecular base ``m``) on the lifted record, when that end lies inside the
    lifted record's insertion: ``(P, junction or None)``, ``P`` the insertion's
    target position (the decoder maps a position inside an insertion there,
    and an end there to ``P + 1``). None when the end is an aligned base there,
    or a read insertion inside a fragment of a '+' row (the source decode's
    rule then already gives the decoder's base).

    Inside the lifted record's insertion: a source-only base (a badge), or a
    read insertion right before a fragment that follows a junction (liftbam
    writes the read's inserted bases there into the junction's ``I``)."""
    j = row.badge_at(x)
    if j is not None:
        return row.pi[j], j
    if not runs.inserted(m):
        return None
    k = row.frag_at(x)
    if k is None:
        return None
    f = row.frags[k]
    if x == f.s and k > 0 and row.inner[k - 1] is not None:
        return row.pi[k - 1], k - 1
    if f.minus:  # the insertion lies between T(x) and T(x) + 1: the base after it is T(x) + 1
        return f.T(x) + 1, None
    return None


def _aligned_ends(st, ai, bi, row, start_side=True):
    """Stretches with the decoder's aligned-base rule at ends inside the lifted record's insertion at a
    junction (a badge): a start there goes to the right block's first aligned base, an end to the left
    block's last one (``aligned_query_interval_to_ref``; they differ from the fragment edges when the read
    deletes a base there). MA calls are placed so; a legacy call whose target start lies in the record's
    soft clip too. ``start_side`` False: only the target end."""
    minus = row.strand == "-"
    xs, xe = (bi - 1, ai) if minus else (ai, bi - 1)
    js = row.badge_at(xs) if start_side else None
    je = row.badge_at(xe)
    if (js is None and je is None) or not st:
        return st
    st = [list(s) for s in st]
    first, last = (st[-1], st[0]) if minus else (st[0], st[-1])
    if js is not None:
        first[0] = max(first[0], row.ri[js])
    if je is not None:
        last[1] = min(last[1], row.pi[je])
    return [s for s in st if s[1] > s[0]]


def _legacy_ends(st, ai, bi, call, row, runs, size=0):
    """A legacy call's stretches with the decoder's insertion rule at its ends
    (``CigarCoordMapper.footprint_to_ref`` on the lifted record of the run
    holding its target start): a start inside an insertion maps to the
    insertion's position ``P``, an end inside one to ``P + 1``; a call inside
    one becomes the 1-bp interval ``[P, P + 1)``. Then cut at a junction that
    cuts (its deleted bases go). A call whose target start lies in that
    record's soft clip (another placement, or the read's own clip) is placed
    by aligned bases only; its target end follows the rule only inside the
    same record. On a '-' row the call's source start is its target end."""
    if not st:
        # A call inside one junction's source-only stretch lies inside the lifted record's insertion: the
        # decoder's 1-bp interval at the insertion, unless the junction's D is cut (it is a footprint until
        # then: its gaps and MSPs are built around it, row.precut).
        j = row.badge_at(ai)
        if j is not None and j == row.badge_at(bi - 1):
            p = row.pi[j]
            if not row.cut[j]:
                return [[p, p + 1, j, j]]
            _precut(row, call, p, p + 1, row.frags[j].run, size)
        return st
    minus = row.strand == "-"
    m0, m1 = int(call[1]), int(call[2])
    rev = runs.reverse
    ml, mr = (m1 - 1, m0) if rev else (m0, m1 - 1)     # molecular bases of the source start and end
    # (source position, molecular base) of the call's target start and target end
    (xs, ms), (xe, me) = (((bi - 1, mr), (ai, ml)) if minus else ((ai, ml), (bi - 1, mr)))
    if runs.clipped(ms):
        return _aligned_ends(st, ai, bi, row)
    run = row.run_at(xs)
    if run is None:
        return _aligned_ends(st, ai, bi, row)
    start = _insertion_end(xs, ms, row, runs)
    same = not runs.clipped(me) and row.run_at(xe) == run
    end = _insertion_end(xe, me, row, runs) if same else None
    if start is None and end is None:
        return st if same else _aligned_ends(st, ai, bi, row, start_side=False)
    st = [list(s) for s in st]
    # The target start is the first stretch's on '+' (source order), the last one's on '-'.
    first, last = (st[-1], st[0]) if minus else (st[0], st[-1])
    whole = [first[0], last[1]]
    cut_end = False
    if start is not None:
        p, j = start
        whole[0] = p
        if j is not None and row.cut[j]:  # the deleted bases after P go: it starts after the junction's D
            first[0] = max(first[0], row.ri[j])
            cut_end = True
        else:
            first[0] = p
    if end is not None:
        p, j = end
        whole[1] = p + 1
        if j is not None and row.cut[j]:
            last[1] = min(last[1], p)
            cut_end = True
        else:
            last[1] = p + 1
    elif not same:  # its target end lies on another record (where its start is soft-clipped): aligned bases
        je = row.badge_at(xe)
        if je is not None:
            last[1] = min(last[1], row.pi[je])
    if cut_end:  # the decoder built the record's gaps and MSPs around the call before the cut
        _precut(row, call, whole[0], whole[1], row.frags[first[2]].run, size)
    return [s for s in st if s[1] > s[0]]


def _precut(row, call, t0, t1, run, size):
    """Record a legacy call's extent before a junction that cuts trimmed it (``row.precut``: the decoder
    builds a record's gaps and inferred MSPs from its footprints before cutting them at deletions)."""
    cid = call[0]
    h = row.precut.get(cid)
    row.precut[cid] = (t0, t1, run, size) if h is None else (min(h[0], t0), max(h[1], t1), run, size)


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
    parts, mapped, ids, keys = _cut_group(parts, mapped, ids, keys, row.payload_cuts)
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
    """A call's unclipped bounds, mapped (joined across the junctions a call
    runs across) and reduced to the part of them its visible part lies in."""
    t0, t1 = part
    rs0 = ctx.region_start
    pieces = [(a - rs0, b - rs0) for a, b, _k, _k1 in row.stretches(base + int(src[0]), base + int(src[1]))]
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
            parts = row.stretches(x, x + int(ev.get("len", 0)))  # one deletion across a map hole inside it
            if not parts:
                dropped += 1
            for t0, t1, _k, _k1 in parts:
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
            parts = row.stretches(int(ev["ref"]), int(ev["ref"]) + int(ev.get("ref_len", ev["len"])))
            if not parts:
                dropped += 1
            for t0, t1, _k, _k1 in parts:
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


def _cut_group(parts, mapped, ids, keys, cuts):
    """Reapply target deletion cuts after end rules can extend a call into deleted bases.
    Keep source indices and call identities parallel to every surviving part."""
    if not cuts:
        return parts, mapped, ids, keys
    if type(mapped) is IntColumn:
        # End rules usually already left every part outside the deletion
        # cuts. Keep those columns intact instead of expanding them to lists.
        a = mapped.array
        ends = np.maximum.accumulate([c[1] for c in cuts])
        starts = np.asarray([c[0] for c in cuts])
        i = np.searchsorted(ends, a[:, 0], side="right")
        hit = (i < len(cuts)) & (starts[np.minimum(i, len(cuts) - 1)] < a[:, 1])
        if not hit.any() and np.all(a[:, 1] > a[:, 0]):
            return parts, mapped, ids, keys
    out_parts, out_mapped, out_ids, out_keys = [], [], [], []
    for j, (_a, _b, i, k) in enumerate(parts):
        for iv in _subtract(mapped[j], cuts):
            out_parts.append((iv[0], iv[1], i, k))
            out_mapped.append(iv)
            out_ids.append(ids[j])
            out_keys.append(keys[j])
    return out_parts, out_mapped, out_ids, out_keys


def _logical(parts, mapped, ids, frags, precut=None, rs0=0, width=0, skip_runs=()):
    """Per run (one lifted placement), the footprint calls whole again: parts
    of one call (same id) joined to their hull, as the decoder saw them
    before cutting them at deletions. ``{run: [[t0, t1, size], ...]}`` sorted.
    ``precut``: legacy ns/nl calls' extents before a junction cut them
    (``row.precut``; absolute, converted to region-relative coordinates here)."""
    by_run = {}
    for cid, (t0, t1, run, size) in (precut or {}).items():
        a, b = t0 - rs0, t1 - rs0
        if isinstance(cid, str) and cid[:3] == "ns:" and b > a and size > 0 and run not in skip_runs:
            by_run.setdefault(run, {})[cid] = [a, b, size]
    for j, (_t0, _t1, _i, k) in enumerate(parts):
        iv = mapped[j]
        if iv[2] <= 0:
            continue
        key = ids[j] if ids[j] is not None else ("part", j)
        hulls = by_run.setdefault(frags[k].run, {})
        h = hulls.get(key)
        hulls[key] = [iv[0], iv[1], iv[2]] if h is None else [min(h[0], iv[0]), max(h[1], iv[1]), h[2]]
    return {run: sorted(h.values()) for run, h in by_run.items()}


def _row_logical(read, row, runs, ctx, call_lo, parts, mapped, ids):
    """Whole footprint hulls per lifted record, before viewport clipping."""
    if all(ctx.region_start <= s[0] and s[1] <= ctx.region_end for s in row.segments):
        return _logical(parts, mapped, ids, row.frags, row.precut, ctx.region_start, ctx.width, row.blank_runs)
    full = copy.copy(ctx)
    full.region_start = min(ctx.region_start, min(s[0] for s in row.segments))
    full.region_end = max(ctx.region_end, max(s[1] for s in row.segments))
    full.width = full.region_end - full.region_start
    ivs = read.get("intervals") or []
    # This fallback traverses the whole record repeatedly, including random
    # access in _call_identity and the hull assembly below. Materialize once:
    # IntColumn indexing otherwise allocates the same small lists each time.
    if type(ivs) is IntColumn:
        ivs = ivs.tolist()
    calls = (read.get("_fiberbrowser_calls") or {}).get("intervals")
    base = int(read["_fiberbrowser_source_base"])
    whole_parts = _map_group(ivs, calls, row, base, runs, full)
    whole_ids, _ = _call_identity(calls, ivs, whole_parts, row, base, runs, call_lo.get("intervals", {}))
    delta = full.region_start - ctx.region_start
    whole_mapped = [[a + delta, b + delta, *ivs[i][2:]] for a, b, i, k in whole_parts]
    keep = [j for j, p in enumerate(whole_parts) if row.frags[p[3]].run not in row.blank_runs]
    return _logical([whole_parts[j] for j in keep], [whole_mapped[j] for j in keep],
                    [whole_ids[j] for j in keep], row.frags, row.precut,
                    ctx.region_start, ctx.width, row.blank_runs)


def _run_bounds(row, ctx):
    """``{run: (t0, t1)}``: each run's target extent (its lifted record's
    alignment span), region-relative."""
    rs0 = ctx.region_start
    return {r: (s[0] - rs0, s[1] - rs0) for r, s in enumerate(row.segments)}


def _map_cuts(row, ctx):
    """Region-relative deleted bases of the junctions that cut (``row.cut``): the lifted record's ``D``
    there, from the target-left fragment's last aligned block to the target-right one's first."""
    rs0 = ctx.region_start
    return [(row.pi[k] - rs0, row.ri[k] - rs0) for k, cut in enumerate(row.cut) if cut]


def _gaps(logical, bounds, cuts, hide_terminal_gaps, width, extents=None):
    """Gaps between consecutive whole calls of each run (one lifted record),
    as the decoder builds them across the record's CIGAR, then cut at
    ``cuts`` (the read's deletions and the junctions that cut) and clipped.
    With terminal gaps hidden a run's other footprint calls (``extents``:
    region-relative ``(lo, hi)`` of its MA nuc/tf/fp_v2 and dropped read-end
    calls, the decoder's call extent) bound it; shown terminal gaps reach the
    run's ends (sized by their visible part, as the decoder sizes them)."""
    out = []
    for run, (b0, b1) in bounds.items():
        calls = logical.get(run)
        if not calls:
            continue
        ext = extents.get(run) if extents and hide_terminal_gaps else None
        if hide_terminal_gaps:
            prev = ext[0] if ext is not None and ext[0] < calls[0][0] else None
        else:
            prev = b0
        first = True
        for iv in calls:
            if prev is not None and iv[0] > prev:
                size = (-(min(iv[0], width) - max(prev, 0)) if first and not hide_terminal_gaps
                        else -(iv[0] - prev))
                out.append([prev, iv[0], size])
            prev = iv[1] if prev is None else max(prev, iv[1])
            first = False
        if not hide_terminal_gaps:
            if b1 > prev:
                out.append([prev, b1, -(min(b1, width) - max(prev, 0))])
        elif ext is not None and ext[1] > prev:
            out.append([prev, ext[1], -(ext[1] - prev)])
    gaps = []
    for iv in out:
        for part in _subtract(iv, cuts):
            part[0], part[1] = max(part[0], 0), min(part[1], width)
            if part[1] > part[0]:
                gaps.append(part)
    return gaps


def _extents(row, ctx):
    """``row.extents`` region-relative."""
    rs0 = ctx.region_start
    return {r: (lo - rs0, hi - rs0) for r, (lo, hi) in row.extents.items()}


def _blank(parts, mapped, ids, keys, row, cuts, ctx):
    """Top-level intervals with the footprints of each blanked run (``row.blank_runs``) replaced by one
    neutral interval over the run, cut at ``cuts``: the decoder's row for a record whose terminal gaps the
    filter rejects while explicit MA layers keep it."""
    frags, width = row.frags, ctx.width
    keep = [j for j, part in enumerate(parts) if frags[part[3]].run not in row.blank_runs]
    parts2 = [parts[j] for j in keep]
    mapped2 = [mapped[j] for j in keep]
    ids2 = [ids[j] for j in keep]
    keys2 = [keys[j] for j in keep]
    first = {}
    for k, f in enumerate(frags):
        first.setdefault(f.run, k)
    for run, (b0, b1) in _run_bounds(row, ctx).items():
        if run not in row.blank_runs:
            continue
        neutral = row.blank_runs[run]
        if neutral is not None:  # the record's calls' extent (only read-end footprints), not the whole run
            b0, b1 = neutral[0] - ctx.region_start, neutral[1] - ctx.region_start
        for part in _subtract([b0, b1, 0], cuts):
            c0, c1 = max(part[0], 0), min(part[1], width)
            if c1 > c0:
                parts2.append((c0, c1, -1, first[run]))
                mapped2.append([c0, c1, 0])
                ids2.append(None)
                keys2.append(None)
    return parts2, mapped2, ids2, keys2


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
                      for t0, t1, _k, _k1 in row.stretches(a, b))  # a map hole inside a deletion is deleted too
        if not payload["sv"]:
            del payload["sv"]
    if any(row.cut):  # the map gaps the decoder cuts calls at on the lifted record
        cuts = sorted(cuts + _map_cuts(row, ctx))

    row.payload_cuts = cuts
    # Top-level footprints: positive (and neutral size-0) intervals; gaps rebuilt per run.
    ivs = read.get("intervals") or []
    iv_calls = calls.get("intervals")
    logical = None
    top = row._pre.intervals if row._pre is not None and not cuts and not row.blank_runs else None
    if top is not None:  # laid out by the window's columnar pass (compose_columns._top_level)
        parts, mapped, ids, keys = _group("intervals", ivs, iv_calls, row, base, runs, ctx, call_lo)
        payload["intervals"], call_ids["intervals"], call_parts["intervals"], quals_out = top
        if quals_out is not None:
            payload["qualities"] = quals_out
    else:
        if row.blank_runs:  # per-row parts: some are replaced (_blank)
            parts = _map_group(ivs, iv_calls, row, base, runs, ctx)
            mapped = [[t0, t1, *ivs[i][2:]] for t0, t1, i, _k in parts]
            ids, keys = _call_identity(iv_calls, ivs, parts, row, base, runs, call_lo.get("intervals", {}))
            parts, mapped, ids, keys = _blank(parts, mapped, ids, keys, row, cuts, ctx)
        else:
            parts, mapped, ids, keys = _group("intervals", ivs, iv_calls, row, base, runs, ctx, call_lo)
        if type(mapped) is IntColumn:  # a columnar group on a row laid out here (deletion cuts)
            mapped = mapped.tolist()
        quals = read.get("qualities") or []
        rank, n = {}, 0
        for i, iv in enumerate(ivs):
            if len(iv) > 2 and iv[2] > 0:
                rank[i] = n
                n += 1
        logical = _row_logical(read, row, runs, ctx, call_lo, parts, mapped, ids)
        gaps = _gaps(logical, _run_bounds(row, ctx), cuts, ctx.hide_terminal_gaps, width, _extents(row, ctx))
        parts, mapped, ids, keys = _cut_group(parts, mapped, ids, keys, cuts)
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
        _fparts, fivs, fids, fkeys = _group("fire", read["fire"], calls.get("fire"), row, base, runs, ctx, call_lo)
        _fparts, payload["fire"], call_ids["fire"], call_parts["fire"] = _cut_group(_fparts, fivs, fids, fkeys, cuts)

    layers = {}
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            layers[name] = _map_layer(name, layer, row, base, runs, ctx, call_lo, call_ids, call_parts)
    legacy = read.get("_fiberbrowser_legacy")
    if ctx.infer_legacy and ctx.include_layers and legacy is not None:
        _infer_legacy(read, runs, layers, payload, parts, mapped, ids, keys,
                      logical if logical is not None else
                      (lambda: _row_logical(read, row, runs, ctx, call_lo, parts, mapped, ids)),
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
            gaps_t += [[t0, t1] for t0, t1, _k, _k1 in row.stretches(int(a), int(b))]
        payload["_fiberbrowser_terminal_gaps"] = sorted(gaps_t)

    clipped_spans = row._pre.molecular_spans if row._pre is not None else None
    hull0 = min(s[0] for s in row.segments)
    hull1 = max(s[1] for s in row.segments)
    payload["reference_start"], payload["reference_end"] = hull0, hull1
    record_reverse = read.get("alignment_orientation") == "reverse"
    payload["alignment_orientation"] = "reverse" if record_reverse != (row.strand == "-") else "forward"
    # The lifted records' alignments: each run's segment, broken only where calls are cut (the deleted
    # bases of map gaps that cut); a connector elsewhere lies inside the alignment, as a short deletion does.
    from services.lift.reads import _body_spans, _merge
    payload["alignment_spans"] = [list(s) for s in _merge(_body_spans(
        {"segments": row.segments, "holes": [(a + rs0, b + rs0) for a, b in _map_cuts(row, ctx)]}))]

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
    if mol_meta is not None and mol_meta.get("hap") is not None:
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
        # Where the body breaks inside a segment: the deleted bases of the junctions that cut. A connector
        # elsewhere is a drawn map gap the row's calls and linkers run across, as across a short deletion.
        "holes": [[a, b] for a, b in sorted(_map_cuts(row, ctx))],
        "badges": [[b[0] - rs0, *b[1:]] for b in sorted(row.badges, key=lambda b: b[0])],
        "badge_ids": [],
        "insertions": {},
        "calls": call_ids,
        "call_parts": call_parts,
        "dropped": dropped,
    }
    if prim.get("is_supplementary") and mol_meta is not None and mol_meta.get("primary_lifted") is False:
        payload["live_lift"]["orphan"] = True
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


def _ma_on_run(read, row, runs, name, run):
    """Whether one of the record's MA ``name`` calls (whole record) has aligned bases on the run's fragments;
    True when the record's MA calls are not known (no call bounds)."""
    bounds = read.get("_fiberbrowser_call_bounds") or {}
    if bounds.get("ma") is None:
        return True
    presence = bounds.get("_ma_query_presence")
    if presence is not None:
        starts, ends = presence.get(name, ([], []))
        if not starts:
            return False
        for f in row.runs[run]:
            x, y, a, b = runs.fragment_bounds(f)
            if x is None or y is None:
                continue
            i = bisect.bisect_right(ends, a)
            while i < len(starts) and starts[i] < b:
                lo, hi = max(a, starts[i]), min(b, ends[i])
                j = bisect.bisect_right(runs.seq, hi - 1) - 1
                if j >= 0 and runs.seq[j] + runs.len[j] > lo:
                    return True
                i += 1
        return False
    # Presence needs only the first intersecting block, rather than projecting
    # every call of every name into Python spans (usually hundreds per read).
    lead = bounds["ma"][4]
    frags, ref, seq, ln = row.runs[run], runs.ref, runs.seq, runs.len
    lo = sum(len(r) for r in row.runs[:run]) if row.disjoint and run else 0
    hi = lo + len(frags)
    for n, q0, q1 in _ma_queries(bounds):
        if n != name:
            continue
        a, b = q0 + lead, q1 + lead
        i = max(0, bisect.bisect_right(seq, a) - 1)
        while i < len(seq) and seq[i] < b:
            x, y = max(a, seq[i]), min(b, seq[i] + ln[i])
            if y > x:
                r0, r1 = ref[i] + x - seq[i], ref[i] + y - seq[i]
                if row.disjoint:
                    k = bisect.bisect_right(row.ends, r0, lo, hi)
                    if k < hi and row.starts[k] < r1:
                        return True
                elif any(f.s < r1 and r0 < f.e for f in frags):
                    return True
            i += 1
    return False


def _infer_legacy(read, runs, layers, payload, parts, mapped, ids, keys, logical, cuts, legacy, row, ctx,
                  call_ids, call_parts):
    """Legacy nuc/tf/msp inference from ns/nl footprints after lifting (the
    loader ran with it off). Nuc/tf follow the lifted parts; MSPs come from the
    gaps between whole nucleosome calls inside one span, cut at deletions, so
    no MSP bridges a badge, connector, split or deletion."""
    from services.bam_tags import generate_msp_from_nuc_gaps

    ma_names = set(legacy.get("ma_names") or ())
    wants = ctx.wants

    def canonical(name, run):
        """An MA nuc/tf group keeps legacy inference off only when one of its calls lands on this run (the
        decoder reads the MA names present on the lifted record itself; a call inside an insertion has no
        place there)."""
        if name not in ma_names:
            return name in layers
        return _ma_on_run(read, row, runs, name, run)
    infer_nuc = {r for r in range(len(row.runs)) if wants["nuc"] and not canonical("nuc", r)}
    infer_tf = {r for r in range(len(row.runs)) if wants["tf"] and not canonical("tf", r)}
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
            # Most rows infer on every run. Keep their LazyParts columnar;
            # indexing even one part would materialise the entire group.
            if len(wanted) != len(row.runs):
                sel = [j for j in sel if row.frags[parts[j][3]].run in wanted]
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
            old = layers.get(name) or {}
            if not old:
                # Already in display order, with no MA layer to merge into.
                # Preserve the array through inference just as _group does.
                layers[name] = {"intervals": (IntColumn(column[sel]) if column is not None
                                              else [mapped[j] for j in sel]),
                                "qualities": tracks or None, "quality_names": names}
                call_ids[f"layer:{name}"] = [ids[j] for j in sel]
                call_parts[f"layer:{name}"] = [keys[j] for j in sel]
                continue
            old_ivs = list(old.get("intervals") or [])
            added = [mapped[j] for j in sel]
            merged = old_ivs + added
            merged_order = sorted(range(len(merged)), key=lambda j: (merged[j][0], merged[j][1], j))
            all_names = list(old.get("quality_names") or [])
            all_names += [n for n in names if n not in all_names]
            old_tracks = dict(zip(old.get("quality_names") or [], old.get("qualities") or []))
            new_tracks = dict(zip(names, tracks))
            combined_tracks = [list(old_tracks.get(n, [0] * len(old_ivs))) +
                               list(new_tracks.get(n, [0] * len(added))) for n in all_names]
            layers[name] = {**old, "intervals": [merged[j] for j in merged_order],
                            "qualities": [[t[j] for j in merged_order] for t in combined_tracks] or None,
                            "quality_names": all_names}
            group = f"layer:{name}"
            all_ids = list(call_ids.get(group) or [None] * len(old_ivs)) + [ids[j] for j in sel]
            all_parts = list(call_parts.get(group) or [None] * len(old_ivs)) + [keys[j] for j in sel]
            call_ids[group] = [all_ids[j] for j in merged_order]
            call_parts[group] = [all_parts[j] for j in merged_order]
    if infer_msp:
        if callable(logical):
            logical = logical()
        msp = []
        # Per run (one lifted record) from whole nucleosome calls, as the decoder infers them before it cuts
        # the record's calls at its deletions; then cut at the read's deletions and the junctions that cut.
        for run in sorted(logical):
            for iv in generate_msp_from_nuc_gaps(logical[run], min_nuc_size=ctx.nuc_min_size):
                for part in _subtract(iv, cuts):
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
