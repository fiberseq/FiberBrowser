"""Re-expressing reads on an alternate-allele contig (pure functions, no state).

An insertion's alternate allele is a synthetic contig::

    left flank  [0, FL)            reference bases [ref - FL, ref)
    insert      [FL, FL + L)       the insertion's consensus (insert position 1..L)
    right flank [FL + L, FL+L+FR)  reference bases [ref, ref + FR)

``ref`` is the 0-based reference position of the first base after the
insertion (a CIGAR ``I`` before reference base ``ref``), so the VCF anchor
base, 1-based, is ``ref`` too: the contig of a 9,184 bp insertion after
chr2L:9,467,038 is ``chr2L_9467038_INS9184``. (Not ``chr2L:9467038+INS9184``: the
region parsers split ``chrom:start-end`` at a colon, and ``+`` is a space in a URL.)

A read is re-expressed on that contig without touching its sequence or tags:
only its CIGAR, position, MD and NM change, so calls and marks (query
coordinates) land where its bases align. Its alignment is cut into three
query parts:

* the left part: query bases aligned to the reference before ``ref`` (kept,
  shifted onto the left flank);
* the middle: the insert (a CIGAR insertion, or the part of a soft clip that
  holds it) plus any flank bases a jittered breakpoint put on the wrong side,
  aligned globally to the contig between the left and right parts;
* the right part: query bases aligned at or after ``ref`` (kept, shifted onto
  the right flank).

Bases outside the contig become soft clips. A reference read (no insert) gets
the whole consensus as a deletion, so a mixed panel draws its body broken
across the insert.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

M, I, D, N, S, H, P, EQ, X = range(9)
_QUERY = frozenset((M, I, S, EQ, X))
_REF = frozenset((M, D, N, EQ, X))
_ALIGNED = frozenset((M, EQ, X))

KIND_CIGAR = "cigar"
KIND_CLIP_START = "clip-start"   # alignment ends at the insertion; a right soft clip holds its start
KIND_CLIP_END = "clip-end"       # alignment starts at the insertion; a left soft clip holds its end
KIND_HARD = "hard"               # clipped at the insertion with no inserted bases in the record
KIND_REFERENCE = "reference"     # spans the site without the insert


def alt_contig_name(chrom: str, ref: int, length: int) -> str:
    """``chr2L_9467038_INS9184``: the anchor base (1-based, = the 0-based ``ref``) and the length."""
    return f"{chrom}_{int(ref)}_INS{int(length)}"


@dataclass(frozen=True)
class AltLayout:
    chrom: str
    ref: int
    insert_len: int
    flank_left: int
    flank_right: int
    replaced_len: int = 0

    @property
    def name(self) -> str:
        return alt_contig_name(self.chrom, self.ref, self.insert_len)

    @property
    def length(self) -> int:
        return self.flank_left + self.insert_len + self.flank_right

    @property
    def ref_start(self) -> int:
        """Reference position of alt position 0."""
        return self.ref - self.flank_left

    @property
    def insert_start(self) -> int:
        return self.flank_left

    @property
    def insert_end(self) -> int:
        return self.flank_left + self.insert_len

    def ref_to_alt(self, g: int) -> int:
        """Alt position of reference position ``g`` (the right flank is offset by the insert)."""
        g = int(g)
        if g < self.ref:
            return g - self.ref_start
        return self.insert_start if g < self.ref + self.replaced_len else g - self.ref - self.replaced_len + self.insert_end

    def alt_to_ref(self, a: int) -> int:
        """Reference position of alt position ``a``; inside the insert, the breakpoint ``ref``."""
        a = int(a)
        if a < self.insert_start:
            return a + self.ref_start
        if a < self.insert_end:
            return self.ref
        return a - self.insert_end + self.ref + self.replaced_len

    def describe(self, a: int) -> dict:
        """Both readouts of alt position ``a`` (0-based): its segment, its reference position
        (flanks) and its 1-based insert position (insert)."""
        a = int(a)
        if a < self.insert_start:
            return {"segment": "left", "ref": a + self.ref_start, "insert": None}
        if a < self.insert_end:
            return {"segment": "insert", "ref": None, "insert": a - self.insert_start + 1}
        return {"segment": "right", "ref": a - self.insert_end + self.ref + self.replaced_len, "insert": None}

    def to_dict(self) -> dict:
        return {"chrom": self.chrom, "ref": self.ref, "insert_len": self.insert_len,
                'replaced_len': self.replaced_len, 'ref_end': self.ref + self.replaced_len,
                "flank_left": self.flank_left, "flank_right": self.flank_right,
                "name": self.name, "length": self.length,
                "insert_start": self.insert_start, "insert_end": self.insert_end}


# ---------------------------------------------------------------------------
# CIGAR walking and cutting


def _walk(cigar, start: int) -> list[tuple[int, int, int, int]]:
    """``[(op, len, query_start, ref_start)]``."""
    out = []
    q = 0
    g = int(start)
    for op, n in cigar:
        n = int(n)
        out.append((int(op), n, q, g))
        if op in _QUERY:
            q += n
        if op in _REF:
            g += n
    return out


def _cut(blocks, q_lo: int, q_hi: int) -> list[tuple[int, int, int, int]]:
    """The blocks' part over query ``[q_lo, q_hi)``. Hard clips stay with the end they are at;
    a deletion goes with the part strictly inside which it lies (one at a cut is dropped)."""
    out = []
    last = len(blocks) - 1
    for i, (op, n, q, g) in enumerate(blocks):
        if op == H or op == P:
            if (i == 0 and q_lo == 0) or (i == last and q >= q_hi and q_hi >= _query_len(blocks)):
                out.append((op, n, q, g))
            continue
        if op in _QUERY:
            lo = max(q, q_lo)
            hi = min(q + n, q_hi)
            if hi > lo:
                out.append((op, hi - lo, lo, g + (lo - q if op in _REF else 0)))
        elif q_lo < q < q_hi:
            out.append((op, n, q, g))
    return out


def _query_len(blocks) -> int:
    q = 0
    for op, n, _q, _g in blocks:
        if op in _QUERY:
            q += n
    return q


def _aligned_bases(blocks):
    """(query, reference) of every aligned base, block by block: ``(q0, g0, n)``."""
    for op, n, q, g in blocks:
        if op in _ALIGNED:
            yield q, g, n


def _first_query_at_or_after(blocks, g_cut: int) -> Optional[int]:
    """Query position of the first aligned base at reference ``>= g_cut``."""
    for q, g, n in _aligned_bases(blocks):
        if g + n > g_cut:
            return q + max(0, g_cut - g)
    return None


def _last_query_before(blocks, g_cut: int) -> Optional[int]:
    """Query position after the last aligned base at reference ``< g_cut``."""
    found = None
    for q, g, n in _aligned_bases(blocks):
        if g < g_cut:
            found = q + min(n, g_cut - g)
    return found


def _ref_end(blocks) -> Optional[int]:
    end = None
    for op, n, _q, g in blocks:
        if op in _ALIGNED:
            end = g + n
    return end


def _ref_begin(blocks) -> Optional[int]:
    for op, _n, _q, g in blocks:
        if op in _ALIGNED:
            return g
    return None


def _strip_edge_gaps(blocks: list, *, trailing: bool) -> list:
    """Drop deletions at the end (or start) of a part: the gap to the middle is recomputed."""
    blocks = list(blocks)
    while blocks:
        edge = blocks[-1] if trailing else blocks[0]
        if edge[0] in (D, N):
            blocks.pop(-1 if trailing else 0)
            continue
        break
    return blocks


# ---------------------------------------------------------------------------
# The middle: a global alignment against the contig


def _ops_to_cigar(ops: np.ndarray) -> list[tuple[int, int]]:
    """insertion_consensus op array (a = query, b = contig) as CIGAR: MATCH -> M,
    INS (contig only) -> D, DEL (query only) -> I."""
    from services.insertion_consensus import OP_DEL, OP_INS, OP_MATCH

    mapping = {OP_MATCH: M, OP_INS: D, OP_DEL: I}
    out: list[tuple[int, int]] = []
    if ops.size == 0:
        return out
    change = np.flatnonzero(np.diff(ops.astype(np.int16))) + 1
    bounds = np.concatenate([[0], change, [ops.size]])
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        out.append((mapping[int(ops[lo])], int(hi - lo)))
    return out


def align_middle(query: str, target: str, offset: int = 0) -> list[tuple[int, int]]:
    """CIGAR of ``query`` aligned end to end to ``target`` (banded; insertion_consensus).

    ``offset``: how far the alignment may run off the scaled diagonal besides the usual
    indel drift (flank bases in the target, or bases a breakpoint placed off the cluster's
    moved into the query); the band is widened by it."""
    if not query and not target:
        return []
    if not query:
        return [(D, len(target))]
    if not target:
        return [(I, len(query))]
    from services.insertion_consensus import align, band_width
    return _ops_to_cigar(align(query, target, band_width(len(query), len(target)) + max(0, int(offset))))


def realign_batch(jobs, layout, alt_seq):
    """One killable, allocation-accounted request for all carrier middles."""
    from services.reconstruction_budget import isolated
    return isolated(__name__, '_realign_batch', (jobs, layout, alt_seq), {},
                    lengths=[len(job[3]) for job in jobs] + [len(alt_seq)], large=True)


def _realign_batch(jobs, layout, alt_seq):
    from services.reconstruction_budget import ResourceResult
    results = []
    for cigar, start, plan, sequence in jobs:
        try:
            results.append(realign(cigar, start, sequence, plan, layout, alt_seq))
        except ResourceResult:
            raise  # never cache a resource-refused carrier as a complete build
        except (ValueError, IndexError):
            results.append(None)
    return results


# ---------------------------------------------------------------------------
# One read


@dataclass
class Realigned:
    reference_start: int
    cigar: list[tuple[int, int]]
    kind: str
    insert_bases: int  # query bases aligned inside the insert


def _plan_middle(kind: str, blocks, qlen: int, plan: dict, layout: AltLayout):
    """(q_lo, q_hi) of the query part to align, or None for no middle."""
    if kind == KIND_CIGAR:
        return int(plan["q"]), int(plan["q"]) + int(plan["len"])
    if kind == KIND_CLIP_START:
        return int(plan["q"]), int(plan["q"]) + int(plan["len"])
    if kind == KIND_CLIP_END:
        return int(plan["q"]), int(plan["q"]) + int(plan["len"])
    return None


def realign(cigar, reference_start: int, query_sequence: str, plan: dict, layout: AltLayout,
            alt_seq: str, *, aligner=align_middle) -> Optional[Realigned]:
    """The read's alignment on the alt contig (None: nothing of it lands there).

    ``plan``: ``{'kind': KIND_*, 'q': insert start in SEQ, 'len': inserted bases}`` (``q``/``len``
    for the cigar and clip kinds)."""
    kind = plan["kind"]
    cigar = [(int(op), int(n)) for op, n in cigar]
    # Terminal hard clips are put back once, around the assembled alignment.
    lead_h = [(H, cigar[0][1])] if cigar and cigar[0][0] == H else []
    tail_h = [(H, cigar[-1][1])] if len(cigar) > 1 and cigar[-1][0] == H else []
    cigar = cigar[len(lead_h):len(cigar) - len(tail_h)]
    blocks = _walk(cigar, reference_start)
    qlen = _query_len(blocks)
    seq = query_sequence or ""
    ref = layout.ref
    middle = _plan_middle(kind, blocks, qlen, plan, layout)
    if middle is None:
        # No inserted bases: cut at the breakpoint itself.
        q_cut = _first_query_at_or_after(blocks, ref)
        if q_cut is None:
            q_cut = qlen
        mid_lo = mid_hi = q_cut
        if layout.replaced_len:
            after = _first_query_at_or_after(blocks, ref + layout.replaced_len)
            if after is not None:
                mid_hi = max(mid_hi, after)
        # Bases between the last one before ref and the first at/after it (an I at the site).
        before = _last_query_before(blocks, ref)
        if before is not None and before < q_cut:
            mid_lo = before
    else:
        mid_lo, mid_hi = middle
        planned = (mid_lo, mid_hi)
        # Bases on the wrong side of a jittered breakpoint join the middle.
        left_blocks = _cut(blocks, 0, mid_lo)
        q_wrong = _first_query_at_or_after(left_blocks, ref)
        if q_wrong is not None:
            mid_lo = min(mid_lo, q_wrong)
        right_blocks = _cut(blocks, mid_hi, qlen)
        q_wrong = _last_query_before(right_blocks, ref + layout.replaced_len)
        if q_wrong is not None:
            mid_hi = max(mid_hi, q_wrong)
    left = _strip_edge_gaps(_cut(blocks, 0, mid_lo), trailing=True)
    right = _strip_edge_gaps(_cut(blocks, mid_hi, qlen), trailing=False)
    if kind == KIND_CLIP_START:
        # The rest of the right clip stays clipped.
        right = [(S, qlen - mid_hi, mid_hi, 0)] if qlen > mid_hi else []
        right += [b for b in _cut(blocks, mid_hi, qlen) if b[0] == H]
    if kind == KIND_CLIP_END:
        left = [b for b in _cut(blocks, 0, mid_lo) if b[0] == H]
        left += [(S, mid_lo, 0, 0)] if mid_lo > 0 else []

    left_end = _ref_end(left)
    right_begin = _ref_begin(right)
    # left_end is exclusive (at most ref): map its last base.
    a_left_end = layout.ref_to_alt(left_end - 1) + 1 if left_end is not None else None
    a_right_begin = layout.ref_to_alt(right_begin) if right_begin is not None else None
    mid_len = mid_hi - mid_lo

    middle_ops: list[tuple[int, int]] = []
    a_mid_start = None
    insert_bases = 0
    align_reference_replacement = kind == KIND_REFERENCE and layout.replaced_len > 0 and mid_len > 0
    planned = (mid_lo, mid_hi) if middle is None else planned
    if ((kind == KIND_REFERENCE or middle is None) and not align_reference_replacement) or kind == KIND_HARD:
        if a_left_end is not None and a_right_begin is not None:
            gap = a_right_begin - a_left_end
            if mid_len:
                middle_ops.append((I, mid_len))
            if gap > 0:
                middle_ops.append((D, gap))
            a_mid_start = a_left_end
        elif mid_len:
            middle_ops.append((S, mid_len))
    else:
        if kind in (KIND_CIGAR, KIND_REFERENCE):
            t_lo = a_left_end if a_left_end is not None else layout.insert_start
            t_hi = a_right_begin if a_right_begin is not None else layout.insert_end
        elif kind == KIND_CLIP_START:
            # The distal end is free: the clip may hold more or fewer insert bases than its
            # length (indels), so the target runs on past it and the deletion that closes the
            # alignment there is dropped (normalize).
            t_lo = a_left_end if a_left_end is not None else layout.insert_start
            reach = t_lo + mid_len + _slack(mid_len)
            t_hi = min(layout.insert_end, reach) if t_lo < layout.insert_end else t_lo + mid_len
            t_hi = max(t_hi, min(layout.insert_end, t_lo + 1))
        else:  # KIND_CLIP_END
            t_hi = a_right_begin if a_right_begin is not None else layout.insert_end
            reach = t_hi - mid_len - _slack(mid_len)
            t_lo = max(layout.insert_start, reach) if t_hi > layout.insert_start else t_hi - mid_len
            t_lo = min(t_lo, max(layout.insert_start, t_hi - 1))
        t_lo = max(0, int(t_lo))
        t_hi = min(layout.length, max(t_lo, int(t_hi)))
        # A partial insert's distal end: where its last (clip-start) or first (clip-end) bases
        # match the contig best, near its length; then the alignment is end to end.
        if kind == KIND_CLIP_START:
            t_hi = t_lo + distal_end(seq[mid_lo:mid_hi], alt_seq[t_lo:t_hi], from_end=True)
        elif kind == KIND_CLIP_END:
            t_lo = t_hi - distal_end(seq[mid_lo:mid_hi], alt_seq[t_lo:t_hi], from_end=False)
        # Off the diagonal by the flank bases in the target, the bases moved into the query,
        # and (partial carriers) the free distal end.
        offset = (max(0, layout.insert_start - t_lo) + max(0, t_hi - layout.insert_end)
                  + (planned[0] - mid_lo) + (mid_hi - planned[1])
                  + (abs((t_hi - t_lo) - (mid_hi - mid_lo)) if kind in (KIND_CLIP_START, KIND_CLIP_END) else 0))
        middle_ops = aligner(seq[mid_lo:mid_hi], alt_seq[t_lo:t_hi], offset)
        a_mid_start = t_lo
        insert_bases = _bases_in(middle_ops, t_lo, layout.insert_start, layout.insert_end)

    ops: list[tuple[int, int]] = list(lead_h) + [(op, n) for op, n, _q, _g in left]
    ops += middle_ops
    ops += [(op, n) for op, n, _q, _g in right] + list(tail_h)
    if left_end is not None:
        start = layout.ref_to_alt(_ref_begin(left))
    elif a_mid_start is not None:
        start = a_mid_start
    elif right_begin is not None:
        start = a_right_begin
    else:
        return None
    start, ops = normalize(start, ops)
    start, ops = clip_to_contig(start, ops, layout.length)
    if not any(op in _ALIGNED for op, _n in ops):
        return None
    return Realigned(reference_start=start, cigar=ops, kind=kind, insert_bases=insert_bases)


def distal_end(query: str, target: str, *, from_end: bool, window: int = 64) -> int:
    """How much of ``target`` a partial insert spans (its distal end is unknown: indels).

    clip-start (``from_end``): the query's last ``window`` bases are matched (ungapped) against
    the target ending at each candidate position; the best match, nearest the query's length
    on ties, ends the span. clip-end: the query's first bases, against the target read from
    its end. Returns the span length (at most ``len(target)``)."""
    n, m = len(query), len(target)
    if n == 0 or m == 0:
        return min(n, m)
    w = min(window, n, m)
    q = np.frombuffer(query.upper().encode("ascii", "replace"), dtype=np.uint8)
    t = np.frombuffer(target.upper().encode("ascii", "replace"), dtype=np.uint8)
    if not from_end:
        q, t = q[::-1], t[::-1]
    tail = q[n - w:]
    ends = np.arange(w, m + 1)
    windows = np.lib.stride_tricks.sliding_window_view(t, w)  # windows[i] = t[i:i+w], ending at i+w
    scores = (windows == tail).sum(axis=1)
    best = scores.max()
    candidates = ends[scores == best]
    return int(candidates[np.argmin(np.abs(candidates - n))])


def _slack(n: int) -> int:
    """How far past a partial insert's length its distal end may lie (indels)."""
    return int(50 + 0.1 * n)


def _bases_in(ops, a0: int, lo: int, hi: int) -> int:
    """Aligned query bases of ``ops`` (starting at alt ``a0``) inside ``[lo, hi)``."""
    a = a0
    total = 0
    for op, n in ops:
        if op in _ALIGNED:
            total += max(0, min(a + n, hi) - max(a, lo))
        if op in _REF:
            a += n
    return total


def _merge(ops) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for op, n in ops:
        if n <= 0:
            continue
        if out and out[-1][0] == op:
            out[-1] = (op, out[-1][1] + n)
        else:
            out.append((op, n))
    return out


def normalize(start: int, ops) -> tuple[int, list[tuple[int, int]]]:
    """Valid CIGAR: clips outermost, no insertion or deletion next to a clip or at an end."""
    ops = _merge(ops)
    if not any(op in _ALIGNED for op, _n in ops):
        return start, ops
    first = next(i for i, (op, _n) in enumerate(ops) if op in _ALIGNED)
    last = max(i for i, (op, _n) in enumerate(ops) if op in _ALIGNED)
    head_h = sum(n for op, n in ops[:first] if op == H)
    head_s = sum(n for op, n in ops[:first] if op in (S, I))
    tail_h = sum(n for op, n in ops[last + 1:] if op == H)
    tail_s = sum(n for op, n in ops[last + 1:] if op in (S, I))
    # A deletion before the first aligned base moves the start.
    start += sum(n for op, n in ops[:first] if op in (D, N))
    body = [(op, n) for op, n in ops[first:last + 1] if op not in (S, H)]
    out = [(H, head_h), (S, head_s), *body, (S, tail_s), (H, tail_h)]
    return start, _merge(out)


def clip_to_contig(start: int, ops, length: int) -> tuple[int, list[tuple[int, int]]]:
    """Soft-clip whatever aligns before 0 or at/after ``length``."""
    out: list[tuple[int, int]] = []
    a = int(start)
    new_start = None
    for op, n in ops:
        if op in (S, H):
            out.append((op, n))
            continue
        if op in _REF:
            lo, hi = a, a + n
            inside_lo, inside_hi = max(lo, 0), min(hi, length)
            before = max(0, min(hi, 0) - lo)
            after = max(0, hi - max(lo, length))
            inside = max(0, inside_hi - inside_lo)
            if op in _QUERY:
                if before:
                    out.append((S, before))
                if inside:
                    out.append((op, inside))
                    if new_start is None:
                        new_start = inside_lo
                if after:
                    out.append((S, after))
            elif inside:
                out.append((op, inside))
                if new_start is None:
                    new_start = inside_lo
            a = hi
        else:  # I
            out.append((S if (a <= 0 or a >= length) else op, n))
    if new_start is None:
        return start, [(S, sum(n for op, n in ops if op in _QUERY))]
    return normalize(new_start, out)


# ---------------------------------------------------------------------------
# MD / NM against the contig


def md_nm(start: int, cigar, query_sequence: str, alt_seq: str) -> tuple[str, int]:
    """MD and NM of an alignment against ``alt_seq`` (N in the contig is a mismatch)."""
    parts: list[str] = []
    run = 0
    nm = 0
    q = 0
    a = int(start)
    seq = np.frombuffer((query_sequence or "").upper().encode("ascii", "replace"), dtype=np.uint8)
    ref = np.frombuffer(alt_seq.upper().encode("ascii", "replace"), dtype=np.uint8)
    n_char = ord("N")
    for op, n in cigar:
        if op in _ALIGNED:
            qb = seq[q:q + n]
            rb = ref[a:a + n]
            if rb.size < n:  # past the contig end (never, after clip_to_contig)
                rb = np.concatenate([rb, np.full(n - rb.size, n_char, dtype=np.uint8)])
            if qb.size < n:
                qb = np.concatenate([qb, np.full(n - qb.size, n_char, dtype=np.uint8)])
            bad = np.flatnonzero((qb != rb) | (rb == n_char))
            prev = 0
            for i in bad.tolist():
                parts.append(str(run + i - prev))
                parts.append(chr(rb[i]))
                run = 0
                prev = i + 1
            run += n - prev
            nm += int(bad.size)
            q += n
            a += n
        elif op == I:
            nm += n
            q += n
        elif op == S:
            q += n
        elif op == D:
            parts.append(str(run))
            parts.append("^" + alt_seq[a:a + n].upper())
            run = 0
            nm += n
            a += n
        elif op == N:
            a += n
    parts.append(str(run))
    return "".join(parts), nm
