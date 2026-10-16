"""Per-read structural-variant events, their clusters and allele split (fb-n9-sv).

The schema is shared with insertion expansion; see the module-level notes
below and ``scratch/fb-n9-sv/SCHEMA.md``.

Each read gets ``sv: [...]`` (absent when empty) holding, in absolute 0-based
reference coordinates and BAM SEQ-frame query positions:

- ``{'t': 'D', 'ref', 'len', 'q'}``: a deletion of reference ``[ref, ref+len)``;
- ``{'t': 'I', 'ref', 'len', 'q', 'seq'?}``: SEQ ``[q, q+len)`` inserted before
  reference base ``ref``;
- ``{'t': 'S', 'side': 'L'|'R', 'ref', 'len', 'q', 'h'?}``: a clip of at least
  the threshold at an alignment end;
- ``{'t': 'SA', 'chrom', 'pos', 'strand', 'mapq', 'nm', 'cigar_ref_len', 'supp', 'same_strand'?}``:
  the other segments of a split read (``pos`` 0-based).

Carriers of an SV (``carrier_evidence``): a matching D/I event; for a deletion
also a clip at one breakpoint with a same-strand SA segment reaching the other;
for an insertion also a clip of at least ``insertion_clip_min`` (50 bp) at the
breakpoint (the alignment ends there, the rest of the read is in the clip, a
supplementary alignment or a hard clip). The allele split, the SV summary's
support and plugin packs' insertion views all use this one rule.

Extraction is cheap because a read is only walked when its CIGAR string has an
indel op of at least the floor (a C-level regex scan).
"""
from __future__ import annotations

import bisect
import re
from functools import lru_cache
from typing import Iterable, Optional, Sequence

SV_MIN_LEN_DEFAULT = 50
SV_MIN_LEN_LOWEST = 10
SV_MIN_LEN_HIGHEST = 1_000_000
# Within one read, indel pieces of at least this size ...
SV_PIECE_MIN = 10
# ... separated by at most this many aligned reference bp are one event.
SV_MERGE_GAP = 10
SV_SEQ_PREVIEW = 1000
# Allele split / spanning count: a read is informative when its alignment
# reaches this far past both breakpoints.
SV_SPAN_MARGIN = 100
# Clustering tolerance: breakpoints within max(20 bp, 5% of len), lengths within 20%.
SV_BREAKPOINT_TOL_BP = 20
SV_BREAKPOINT_TOL_FRAC = 0.05
SV_LENGTH_TOL_FRAC = 0.20
SV_CLIP_TOL_BP = 20
# An insertion's clipped carriers: the clip's breakpoint lies within
# max(20 bp, min(5% of len, 50 bp)) of the insertion (target-site
# duplications put PacBio clips up to ~30 bp from the CIGAR insertion).
SV_INS_CLIP_TOL_MAX = 50

_CIGAR_REF_RE = re.compile(r"(\d+)([MIDNSHP=X])")


def normalize_min_sv_len(value, default: int = SV_MIN_LEN_DEFAULT) -> int:
    """The request's ``min_sv_len`` clamped to the accepted range."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(SV_MIN_LEN_LOWEST, min(SV_MIN_LEN_HIGHEST, number))


def _ge_number_pattern(n: int) -> str:
    """A regex alternation matching the decimal integers >= ``n`` (no leading zeros)."""
    digits = str(n)
    d = len(digits)
    alts = [r"[1-9]\d{%d,}" % d]  # more digits
    for i, c in enumerate(digits):
        k = int(c)
        if k < 9:
            lo = k + 1 if i else max(k + 1, 1)
            alts.append(digits[:i] + (f"[{lo}-9]" if lo < 9 else "9") + r"\d" * (d - i - 1))
    alts.append(digits)
    return "|".join(alts)


@lru_cache(maxsize=32)
def large_indel_regex(n: int):
    """Matches a CIGAR I or D op of at least ``n`` bases."""
    return re.compile(r"(?<!\d)(?:%s)[ID]" % _ge_number_pattern(int(n)))


def has_large_indel(cigarstring: Optional[str], min_len: int) -> bool:
    return bool(cigarstring) and large_indel_regex(int(min_len)).search(cigarstring) is not None


def cigar_ref_len(cigar: str) -> int:
    """Reference bases a CIGAR string covers (M, D, N, =, X)."""
    total = 0
    for length, op in _CIGAR_REF_RE.findall(cigar or ""):
        if op in "MDN=X":
            total += int(length)
    return total


def parse_sa_tag(sa: str, *, supplementary: bool = False, read_reverse: Optional[bool] = None) -> list[dict]:
    """The SA tag's segments as ``t: 'SA'`` events (``pos`` 0-based).
    ``same_strand``: the segment aligns on the read's own strand (a deletion's
    split read does; an inversion's does not)."""
    out = []
    for entry in (sa or "").split(";"):
        if not entry:
            continue
        parts = entry.split(",")
        if len(parts) < 6:
            continue
        chrom, pos, strand, cigar, mapq, nm = parts[:6]
        try:
            out.append({
                "t": "SA",
                "chrom": chrom,
                "pos": int(pos) - 1,
                "strand": "-" if strand == "-" else "+",
                "mapq": int(mapq),
                "nm": int(nm),
                "cigar_ref_len": cigar_ref_len(cigar),
                "supp": bool(supplementary),
                **({} if read_reverse is None else {"same_strand": (strand == "-") == bool(read_reverse)}),
            })
        except ValueError:
            continue
    return out


def _clip_events(read, min_len: int) -> list[dict]:
    """Clips of at least ``min_len`` at either alignment end. Soft clips come
    from pysam's C-level alignment bounds; the CIGAR list is only built when
    the read has hard clips (rare on primary alignments)."""
    seq_len = int(read.query_length or 0)
    soft_left = int(read.query_alignment_start or 0)
    soft_right = max(0, seq_len - int(read.query_alignment_end or 0))
    hard_left = hard_right = 0
    try:
        hard_total = int(read.infer_read_length() or seq_len) - seq_len
    except Exception:
        hard_total = 0
    if hard_total > 0:
        cig = read.cigartuples or []
        i = 0
        while i < len(cig) and cig[i][0] in (4, 5):
            if cig[i][0] == 5:
                hard_left += cig[i][1]
            i += 1
        j = len(cig) - 1
        while j > i and cig[j][0] in (4, 5):
            if cig[j][0] == 5:
                hard_right += cig[j][1]
            j -= 1
    events = []
    if soft_left + hard_left >= min_len:
        ev = {"t": "S", "side": "L", "ref": int(read.reference_start), "len": soft_left + hard_left, "q": 0}
        if hard_left:
            ev["h"] = 1
        events.append(ev)
    if soft_right + hard_right >= min_len:
        ev = {"t": "S", "side": "R", "ref": int(read.reference_end), "len": soft_right + hard_right,
              "q": max(0, seq_len - soft_right)}
        if hard_right:
            ev["h"] = 1
        events.append(ev)
    return events


def _cigar_pieces(cigartuples, ref_start: int):
    """(op, ref_pos, length, query_pos) of the I/D ops of >= SV_PIECE_MIN and
    every N, as CigarCoordMapper.large_indels gathers them."""
    pieces = []
    ref_pos = ref_start
    q_pos = 0
    for op, length in cigartuples:
        if op in (0, 7, 8):
            ref_pos += length
            q_pos += length
        elif op == 2:
            if length >= SV_PIECE_MIN:
                pieces.append((2, ref_pos, length, q_pos))
            ref_pos += length
        elif op == 1:
            if length >= SV_PIECE_MIN:
                pieces.append((1, ref_pos, length, q_pos))
            q_pos += length
        elif op == 4:
            q_pos += length
        elif op == 3:
            pieces.append((3, ref_pos, length, q_pos))
            ref_pos += length
    return pieces


def _indel_events(pieces) -> list[dict]:
    """Deletion/insertion pieces joined across short aligned stretches (see
    SV_MERGE_GAP); an N skip is never part of an event."""
    events: list[dict] = []
    last_d = None  # the open deletion event and the ref position where it ended
    last_i = None  # the open insertion event and the ref position after it
    for op, ref_pos, length, q_pos in pieces:
        if op == 2:
            if length < SV_PIECE_MIN:
                continue
            if last_d is not None and ref_pos - last_d[1] <= SV_MERGE_GAP:
                last_d[0]["len"] = ref_pos + length - last_d[0]["ref"]
                last_d[1] = ref_pos + length
            else:
                ev = {"t": "D", "ref": ref_pos, "len": length, "q": q_pos}
                events.append(ev)
                last_d = [ev, ref_pos + length]
        elif op == 1:
            if length < SV_PIECE_MIN:
                continue
            if last_i is not None and ref_pos - last_i[1] <= SV_MERGE_GAP:
                last_i[0]["len"] = q_pos + length - last_i[0]["q"]
                last_i[1] = ref_pos
            else:
                ev = {"t": "I", "ref": ref_pos, "len": length, "q": q_pos}
                events.append(ev)
                last_i = [ev, ref_pos]
        elif op == 3:
            last_d = None
            last_i = None
    return events


_PIECE_RE = re.compile(r"(?<!\d)(\d{2,})([ID])")


def _could_reach(cigarstring: Optional[str], min_len: int) -> bool:
    """Whether the read's I/D pieces of >= SV_PIECE_MIN could join into one of
    ``min_len`` (each type's total reaches it): a C-level scan of the CIGAR
    string, so most reads are never walked."""
    if not cigarstring:
        return False
    if has_large_indel(cigarstring, min_len):
        return True
    totals = {"I": 0, "D": 0}
    for length, op in _PIECE_RE.findall(cigarstring):
        n = int(length)
        if n >= SV_PIECE_MIN:
            totals[op] += n
    return totals["I"] >= min_len or totals["D"] >= min_len


def _large_pieces(read, min_len: int, mapper=None):
    """The read's indel pieces when they could make an event of ``min_len``
    (one op that long, or pieces that join into one), else None."""
    if mapper is not None and getattr(mapper, "large_indels", None) is not None:
        pieces = mapper.large_indels
        if not pieces:
            return None
        d = i = 0
        for op, _ref, length, _q in pieces:
            if op == 2:
                d += length
            elif op == 1:
                i += length
        return pieces if d >= min_len or i >= min_len else None
    if not _could_reach(getattr(read, "cigarstring", None), min_len):
        return None
    return _cigar_pieces(read.cigartuples or (), int(read.reference_start))


def extract_sv_events(read, min_len: int = SV_MIN_LEN_DEFAULT, *, include_seq: bool = False,
                      mapper=None) -> Optional[list[dict]]:
    """A pysam read's SV events (see the module docstring), or None.

    ``mapper``: the read's CigarCoordMapper when the caller built one (its
    CIGAR walk already gathered the long indel ops)."""
    if getattr(read, "is_unmapped", False) or not isinstance(getattr(read, "reference_start", None), int):
        return None
    min_len = int(min_len)
    events: list[dict] = _clip_events(read, min_len)
    pieces = _large_pieces(read, min_len, mapper)
    if pieces:
        indels = [ev for ev in _indel_events(pieces) if ev["len"] >= min_len]
        if indels and include_seq:
            seq = read.query_sequence or ""
            for ev in indels:
                if ev["t"] == "I" and seq:
                    ev["seq"] = seq[ev["q"]:ev["q"] + min(ev["len"], SV_SEQ_PREVIEW)]
        events.extend(indels)
    if len(events) > 1:
        events.sort(key=lambda ev: (ev["ref"], ev["t"]))
    if hasattr(read, "has_tag") and read.has_tag("SA"):
        try:
            events.extend(parse_sa_tag(str(read.get_tag("SA")), supplementary=bool(read.is_supplementary),
                                       read_reverse=bool(getattr(read, "is_reverse", False))))
        except Exception:
            pass
    return events or None


def deletion_spans(events: Optional[Iterable[dict]]) -> list[tuple[int, int]]:
    """Absolute ``[start, end)`` of a read's deletion events, sorted."""
    return sorted((int(ev["ref"]), int(ev["ref"]) + int(ev["len"])) for ev in events or () if ev.get("t") == "D")


def event_span(ev: dict) -> tuple[int, int]:
    """The reference span an event occupies (an insertion or clip is one point)."""
    ref = int(ev["ref"])
    if ev.get("t") == "D":
        return ref, ref + int(ev["len"])
    return ref, ref + 1


def sv_events_in_view(events: Optional[Sequence[dict]], start: int, end: int, min_len: int) -> Optional[list[dict]]:
    """A read's events of at least ``min_len`` overlapping ``[start, end)``; SA
    entries are kept whenever anything else is (they describe the read)."""
    if not events:
        return None
    kept = []
    sa = []
    for ev in events:
        t = ev.get("t")
        if t == "SA":
            sa.append(ev)
            continue
        if int(ev.get("len", 0)) < min_len:
            continue
        a, b = event_span(ev)
        if b > start and a < end:
            kept.append(ev)
    if not kept:
        return None
    return kept + sa


# ---------------------------------------------------------------------------
# Calls split at deletions


def read_deletion_cuts(read, min_len: int = SV_MIN_LEN_DEFAULT, mapper=None) -> list[tuple[int, int]]:
    """A pysam read's absolute deleted spans of at least ``min_len`` (cheap
    when it has none)."""
    try:
        pieces = _large_pieces(read, min_len, mapper)
        if not pieces:
            return []
        return [(e["ref"], e["ref"] + e["len"]) for e in _indel_events(pieces)
                if e["t"] == "D" and e["len"] >= min_len]
    except Exception:
        return []


def split_span(start: int, end: int, cuts: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
    """``[start, end)`` minus the cuts (itself when none crosses it)."""
    if not cuts:
        return [(start, end)]
    return _subtract_spans(int(start), int(end), sorted(cuts))


_LAYER_ALIGNED_LIST_KEYS = ("annotation_names", "circular_ids")


def _subtract_spans(a: int, b: int, cuts: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
    pieces = []
    cur = a
    for cs, ce in cuts:
        if ce <= cur:
            continue
        if cs >= b:
            break
        if cs > cur:
            pieces.append((cur, min(cs, b)))
        cur = max(cur, ce)
        if cur >= b:
            break
    if cur < b:
        pieces.append((cur, b))
    return pieces


def _split_intervals(intervals, cuts):
    """(new intervals, index map new->old) or None when nothing crosses a cut."""
    if not intervals:
        return None
    lo = cuts[0][0]
    hi = max(b for _a, b in cuts)
    changed = False
    out = []
    index = []
    for idx, iv in enumerate(intervals):
        a, b = iv[0], iv[1]
        if b <= lo or a >= hi:
            out.append(iv)
            index.append(idx)
            continue
        crosses = False
        for cs, ce in cuts:
            if cs < b and ce > a:
                crosses = True
                break
        if not crosses:
            out.append(iv)
            index.append(idx)
            continue
        changed = True
        rest = list(iv[2:])
        for pa, pb in _subtract_spans(a, b, cuts):
            out.append([pa, pb, *rest])
            index.append(idx)
    return (out, index) if changed else None


def split_compact_read_at_deletions(read_data: dict, cuts: Sequence[tuple[int, int]]) -> dict:
    """Split a compact read's calls at deletions, in its own (region-relative)
    coordinates. Each piece keeps its call's size and qualities; nothing is
    left inside a deleted span. Mutates and returns ``read_data``."""
    if not cuts:
        return read_data
    cuts = sorted((int(a), int(b)) for a, b in cuts if b > a)
    if not cuts:
        return read_data
    split = _split_intervals(read_data.get("intervals"), cuts)
    if split is not None:
        intervals, index = split
        quals = read_data.get("qualities")
        if quals:
            # Primary qualities follow the positive (footprint) intervals.
            old = read_data["intervals"]
            pos_rank = {}
            rank = 0
            for i, iv in enumerate(old):
                if len(iv) > 2 and iv[2] > 0:
                    pos_rank[i] = rank
                    rank += 1
            new_q = []
            for new_iv, old_idx in zip(intervals, index):
                if len(new_iv) > 2 and new_iv[2] > 0 and old_idx in pos_rank and pos_rank[old_idx] < len(quals):
                    new_q.append(quals[pos_rank[old_idx]])
            read_data["qualities"] = new_q
        read_data["intervals"] = intervals
    fire = read_data.get("fire")
    if fire:
        split = _split_intervals(fire, cuts)
        if split is not None:
            read_data["fire"] = split[0]
    for layer in (read_data.get("layers") or {}).values():
        if not isinstance(layer, dict):
            continue
        split = _split_intervals(layer.get("intervals"), cuts)
        if split is None:
            # The visible calls cross no deletion, but their unclipped source
            # bounds (beyond the region) still may.
            _split_source_intervals(layer, layer.get("intervals") or [], range(len(layer.get("intervals") or [])), cuts)
            continue
        intervals, index = split
        layer["intervals"] = intervals
        qualities = layer.get("qualities")
        if qualities:
            layer["qualities"] = [
                [track[i] if i < len(track) else 0 for i in index] for track in qualities
            ]
        for key in _LAYER_ALIGNED_LIST_KEYS:
            values = layer.get(key)
            if values:
                layer[key] = [values[i] if i < len(values) else "" for i in index]
        _split_source_intervals(layer, intervals, index, cuts)
    return read_data


def _split_source_intervals(layer: dict, intervals, index, cuts) -> None:
    """Each call's unclipped source bounds cut to the piece of it its visible
    interval lies in (a source crossing a deletion no longer bridges it)."""
    sources = layer.get("source_intervals")
    if not sources:
        return
    lo = cuts[0][0]
    hi = max(b for _a, b in cuts)
    new_sources = []
    for iv, i in zip(intervals, index):
        src = sources[i] if i < len(sources) else iv
        if src[1] <= lo or src[0] >= hi:
            new_sources.append(src)
            continue
        pieces = _subtract_spans(int(src[0]), int(src[1]), cuts)
        match = next((p for p in pieces if p[0] <= iv[0] and p[1] >= iv[1]), None)
        if match is None:
            match = next((p for p in pieces if p[0] < iv[1] and p[1] > iv[0]), (iv[0], iv[1]))
        new_sources.append([match[0], match[1], *list(src[2:])])
    layer["source_intervals"] = new_sources


# ---------------------------------------------------------------------------
# Clusters across reads


def breakpoint_tolerance(length: int) -> float:
    return max(SV_BREAKPOINT_TOL_BP, SV_BREAKPOINT_TOL_FRAC * max(0, int(length)))


def events_match(t: str, ref: int, length: int, c_ref: float, c_len: float) -> bool:
    """One event against a cluster's (median) breakpoint and length."""
    tol = breakpoint_tolerance(max(length, c_len))
    if abs(ref - c_ref) > tol:
        return False
    if t == "D" and abs((ref + length) - (c_ref + c_len)) > tol:
        return False
    big = max(length, c_len)
    return big <= 0 or abs(length - c_len) <= SV_LENGTH_TOL_FRAC * big


def _median(values):
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def _sorted_median(s):
    n = len(s)
    if n == 0:
        return 0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def cluster_sv_events(reads: Iterable[dict], start: int, end: int, min_len: int) -> tuple[list[dict], list[dict]]:
    """Cluster the reads' D/I events in ``[start, end)`` and pile up their clips.

    Returns (clusters, clip piles). A cluster is ``{t, ref, len, end, members:
    set(read ids)}``; a pile ``{side, ref, n}``."""
    items = []
    clips = []
    for read in reads:
        events = read.get("sv")
        if not events:
            continue
        rid = read.get("id")
        for ev in events:
            t = ev.get("t")
            if t not in ("D", "I", "S"):
                continue
            if int(ev.get("len", 0)) < min_len:
                continue
            a, b = event_span(ev)
            if not (b > start and a < end):
                continue
            if t == "S":
                clips.append((ev["side"], int(ev["ref"]), rid))
            else:
                items.append((t, int(ev["ref"]), int(ev["len"]), rid))
    clusters: list[dict] = []
    by_type: dict[str, list[dict]] = {"D": [], "I": []}
    tol_bp, tol_frac, len_frac = SV_BREAKPOINT_TOL_BP, SV_BREAKPOINT_TOL_FRAC, SV_LENGTH_TOL_FRAC
    for t, ref, length, rid in sorted(items, key=lambda x: (x[1], x[0])):
        best = None
        # events_match, inlined (this loop runs once per event in view).
        for c in by_type[t]:
            c_ref = c["ref"]
            c_len = c["len"]
            big = length if length > c_len else c_len
            tol = tol_frac * big
            if tol < tol_bp:
                tol = tol_bp
            if abs(ref - c_ref) > tol:
                continue
            if t == "D" and abs((ref + length) - (c_ref + c_len)) > tol:
                continue
            if big > 0 and abs(length - c_len) > len_frac * big:
                continue
            best = c
            break
        if best is None:
            best = {"t": t, "refs": [], "lens": [], "members": set(), "ref": ref, "len": length}
            clusters.append(best)
            by_type[t].append(best)
        # Kept sorted, so the running median is one insort, not a sort per join.
        bisect.insort(best["refs"], ref)
        bisect.insort(best["lens"], length)
        best["members"].add(rid)
        best["ref"] = _sorted_median(best["refs"])
        best["len"] = _sorted_median(best["lens"])
    out = []
    for c in clusters:
        ref = int(round(c["ref"]))
        length = int(round(c["len"]))
        out.append({
            "t": c["t"], "ref": ref, "len": length,
            "end": ref + length if c["t"] == "D" else ref,
            "members": c["members"],
        })
    piles: list[dict] = []
    for side, ref, rid in sorted(clips, key=lambda x: (x[0], x[1])):
        pile = piles[-1] if piles and piles[-1]["side"] == side and ref - piles[-1]["_last"] <= SV_CLIP_TOL_BP else None
        if pile is None:
            pile = {"side": side, "refs": [], "ids": set(), "_last": ref}
            piles.append(pile)
        pile["refs"].append(ref)
        pile["ids"].add(rid)
        pile["_last"] = ref
    clip_out = [{"side": p["side"], "ref": int(round(_median(p["refs"]))), "n": len(p["ids"])} for p in piles]
    return out, clip_out


def insertion_clip_tolerance(length: int) -> float:
    """How far an insertion carrier's clip may lie from the insertion."""
    return max(SV_BREAKPOINT_TOL_BP, min(breakpoint_tolerance(length), SV_INS_CLIP_TOL_MAX))


def insertion_clip_min(length: int) -> int:
    """The shortest clip that makes a read an insertion's carrier: the
    display cache's extraction floor (50 bp) for every insertion, so the SV
    summary (built from cached events) sees every clip the split and the lens
    count (Codex review)."""
    return SV_MIN_LEN_DEFAULT


def insertion_clip_at(events: Iterable[dict], ref: int, length: int) -> Optional[dict]:
    """The read's clip (``S`` event) at insertion ``ref``: either side (an
    ``R`` clip's ``ref`` is the alignment end, an ``L`` clip's the alignment
    start, so the clipped bases face the insertion), at least
    ``insertion_clip_min`` long, the nearest one."""
    tol = insertion_clip_tolerance(length)
    floor = insertion_clip_min(length)
    best = None
    for ev in events or ():
        if ev.get("t") != "S" or int(ev.get("len", 0)) < floor:
            continue
        d = abs(int(ev["ref"]) - ref)
        if d <= tol and (best is None or d < best[0]):
            best = (d, ev)
    return best[1] if best else None


def carrier_evidence(read: dict, t: str, ref: int, length: int, chrom: Optional[str] = None) -> Optional[dict]:
    """How a read carries the event, or None:

    - ``{'kind': 'cigar', 'event': ev}``: a matching D/I event (the nearest);
    - ``{'kind': 'sa'}`` (deletions): a clip at one breakpoint with a
      same-strand SA segment on the same chromosome reaching the other;
    - ``{'kind': 'clip', 'clip': ev}`` (insertions): a clip at the breakpoint
      (``insertion_clip_at``), with or without an SA segment.
    """
    events = read.get("sv") or ()
    best = None
    for ev in events:
        if ev.get("t") == t and events_match(t, int(ev["ref"]), int(ev["len"]), ref, length):
            d = abs(int(ev["ref"]) - ref)
            if best is None or d < best[0]:
                best = (d, ev)
    if best is not None:
        return {"kind": "cigar", "event": best[1]}
    if t == "I":
        clip = insertion_clip_at(events, ref, length)
        return {"kind": "clip", "clip": clip} if clip is not None else None
    if t != "D":
        return None
    end = ref + length
    tol = breakpoint_tolerance(length)
    clips = [ev for ev in events if ev.get("t") == "S"]
    if not clips:
        return None
    segments = [ev for ev in events if ev.get("t") == "SA"]
    for clip in clips:
        cref = int(clip["ref"])
        for seg in segments:
            if chrom is not None and seg.get("chrom") != chrom:
                continue
            if seg.get("same_strand") is False:
                continue  # an inversion's segment, not a deletion's
            seg_start = int(seg["pos"])
            seg_end = seg_start + int(seg.get("cigar_ref_len", 0))
            if clip["side"] == "R" and abs(cref - ref) <= tol and abs(seg_start - end) <= tol:
                return {"kind": "sa"}
            if clip["side"] == "L" and abs(cref - end) <= tol and abs(seg_end - ref) <= tol:
                return {"kind": "sa"}
    return None


def read_carries(read: dict, t: str, ref: int, length: int, chrom: Optional[str] = None) -> Optional[str]:
    """How the read carries the event: 'cigar', 'sa' (deletions), 'clip'
    (insertions) or None (see ``carrier_evidence``)."""
    evidence = carrier_evidence(read, t, ref, length, chrom)
    return evidence["kind"] if evidence else None


def other_insertion_at(read: dict, ref: int, length: int) -> bool:
    """The read has an insertion at ``ref`` that is not this one (another
    allele): it is not reference sequence there."""
    tol = breakpoint_tolerance(length)
    return any(ev.get("t") == "I" and abs(int(ev["ref"]) - ref) <= tol for ev in read.get("sv") or ())


def read_spans(read: dict, a: int, b: int) -> Optional[bool]:
    """Whether a read's alignment covers ``[a, b)`` (None: no alignment bounds)."""
    rs, re_ = read.get("reference_start"), read.get("reference_end")
    if not isinstance(rs, int) or not isinstance(re_, int):
        return None
    spans = read.get("alignment_spans")
    if spans:
        return any(int(s) <= a and int(e) >= b for s, e in spans)
    return rs <= a and re_ >= b


def classify_allele_evidence(read: dict, t: str, ref: int, length: int, margin: int = SV_SPAN_MARGIN,
                             chrom: Optional[str] = None) -> tuple[int, Optional[dict]]:
    """(allele, evidence): 0 carrier (with ``carrier_evidence``), 1 reference
    (spans both breakpoints +- margin without it), 2 not informative. A read
    with another insertion at an insertion's site is not informative
    (evidence ``{'kind': 'other'}``)."""
    evidence = carrier_evidence(read, t, ref, length, chrom)
    if evidence is not None:
        return 0, evidence
    if t == "I" and other_insertion_at(read, ref, length):
        return 2, {"kind": "other"}
    end = ref + length if t == "D" else ref
    if read_spans(read, ref - margin, end + margin):
        return 1, None
    return 2, None


def classify_allele(read: dict, t: str, ref: int, length: int, margin: int = SV_SPAN_MARGIN,
                    chrom: Optional[str] = None) -> int:
    """0 carrier, 1 reference (spans both breakpoints +- margin without it), 2 not informative."""
    return classify_allele_evidence(read, t, ref, length, margin, chrom)[0]


def _span_index(reads: Sequence[dict]):
    """Alignment bounds as arrays (reads with ``alignment_spans`` kept apart),
    and each read id's record indices."""
    import numpy as np

    plain_idx, starts, ends, special = [], [], [], []
    by_id: dict = {}
    for i, read in enumerate(reads):
        by_id.setdefault(read.get("id"), []).append(i)
        rs, re_ = read.get("reference_start"), read.get("reference_end")
        if not isinstance(rs, int) or not isinstance(re_, int):
            continue
        if read.get("alignment_spans"):
            special.append(i)
        else:
            plain_idx.append(i)
            starts.append(rs)
            ends.append(re_)
    return (np.asarray(starts, dtype=np.int64), np.asarray(ends, dtype=np.int64),
            set(plain_idx), special, by_id)


def sv_summary_for_reads(reads: Sequence[dict], start: int, end: int, min_len: int, *,
                         margin: int = SV_SPAN_MARGIN, scope: str = "all", chrom: Optional[str] = None) -> Optional[dict]:
    """The ``sv_summary`` payload (SCHEMA.md) for the reads in view, or None.

    Support counts every carrier of ``carrier_evidence``: CIGAR events, plus a
    deletion's clip + SA reads (``sa_support``) and an insertion's clipped
    reads (``clip_support``). Indexed, so a deep view (tens of thousands of
    reads, dozens of clusters) stays well under a second."""
    import bisect

    with_sv = [read for read in reads if read.get("sv")]
    if not with_sv:
        return None
    clusters, clips = cluster_sv_events(with_sv, start, end, min_len)
    if not clusters and not clips:
        return None
    # Clip index (insertions) and the reads that can be a deletion's split read.
    clip_refs: list[int] = []
    clip_items: list[tuple[int, int, object]] = []
    ins_items: list[tuple[int, object]] = []
    sa_candidates = []
    for read in with_sv:
        events = read["sv"]
        has_clip = False
        has_sa = False
        for ev in events:
            t = ev.get("t")
            if t == "S":
                has_clip = True
                clip_items.append((int(ev["ref"]), int(ev.get("len", 0)), read.get("id")))
            elif t == "SA":
                has_sa = True
            elif t == "I":
                ins_items.append((int(ev["ref"]), read.get("id")))
        if has_clip and has_sa:
            for ev in events:
                if ev.get("t") == "S":
                    sa_candidates.append((int(ev["ref"]), id(read), read))
    clip_items.sort(key=lambda item: item[0])
    clip_refs = [item[0] for item in clip_items]
    ins_items.sort(key=lambda item: item[0])
    ins_refs = [item[0] for item in ins_items]
    sa_candidates.sort(key=lambda item: (item[0], item[1]))
    sa_refs = [item[0] for item in sa_candidates]
    span_starts, span_ends, plain, special, by_id = _span_index(reads)

    def spanning(a: int, b: int, members: set) -> int:
        n = int(((span_starts <= a) & (span_ends >= b)).sum()) if span_starts.size else 0
        # Records of carriers are not counted twice.
        for rid in members:
            for i in by_id.get(rid, ()):
                if i in plain:
                    read = reads[i]
                    if read["reference_start"] <= a and read["reference_end"] >= b:
                        n -= 1
        for i in special:
            if reads[i].get("id") not in members and read_spans(reads[i], a, b):
                n += 1
        return n

    out_clusters = []
    for c in clusters:
        t, ref, length, cend = c["t"], c["ref"], c["len"], c["end"]
        members = set(c["members"])
        sa_support = 0
        clip_support = 0
        if t == "D":
            # Only reads clipped near one of the breakpoints can be its split reads.
            tol = breakpoint_tolerance(length)
            seen_reads: set[int] = set()
            for point in (ref, cend):
                lo = bisect.bisect_left(sa_refs, point - tol)
                hi = bisect.bisect_right(sa_refs, point + tol)
                for _cref, key, read in sa_candidates[lo:hi]:
                    if key in seen_reads:
                        continue
                    seen_reads.add(key)
                    rid = read.get("id")
                    if rid in members:
                        continue
                    if read_carries(read, t, ref, length, chrom) == "sa":
                        members.add(rid)
                        sa_support += 1
        elif t == "I":
            tol = insertion_clip_tolerance(length)
            floor = insertion_clip_min(length)
            lo = bisect.bisect_left(clip_refs, ref - tol)
            hi = bisect.bisect_right(clip_refs, ref + tol)
            for _cref, clen, rid in clip_items[lo:hi]:
                if clen >= floor and rid not in members:
                    members.add(rid)
                    clip_support += 1
        # Reads with another insertion at this one's site are not informative
        # (classify_allele_evidence): left out of the spanning count.
        not_reference = set(members)
        if t == "I":
            tol = breakpoint_tolerance(length)
            lo = bisect.bisect_left(ins_refs, ref - tol)
            hi = bisect.bisect_right(ins_refs, ref + tol)
            not_reference.update(rid for _r, rid in ins_items[lo:hi])
        informative = len(members) + spanning(ref - margin, cend + margin, not_reference)
        out_clusters.append({
            "id": f"{t}:{ref}:{length}", "t": t, "ref": ref, "len": length, "end": cend,
            "support": len(members), "informative": informative, "sa_support": sa_support,
            "clip_support": clip_support,
        })
    out_clusters.sort(key=lambda c: (c["ref"], c["t"]))
    return {
        "min_len": int(min_len), "margin": int(margin), "scope": scope,
        "n_reads": len(reads), "clusters": out_clusters, "clips": clips,
    }


def allele_label(t: str, ref: int, length: int, chrom: str) -> str:
    """'DEL 1.8 kb @ chr2L:1,234,567' for the split's group source."""
    kind = "DEL" if t == "D" else "INS"
    if length >= 1000:
        size = f"{length / 1000:.1f} kb"
    else:
        size = f"{length} bp"
    return f"{kind} {size} @ {chrom}:{ref + 1:,}"


def finalize_sv_payload(display_reads: Sequence[dict], start: int, end: int, min_len: int) -> list[dict]:
    """Display reads with ``sv`` cut to the view and the request's threshold.
    Cached reads are never mutated: a read whose events change is copied."""
    out = []
    for read in display_reads:
        events = read.get("sv") if isinstance(read, dict) else None
        if events is None:
            out.append(read)
            continue
        kept = sv_events_in_view(events, start, end, min_len)
        if kept is None:
            read = {key: value for key, value in read.items() if key != "sv"}
        elif len(kept) != len(events):
            read = {**read, "sv": kept}
        out.append(read)
    return out


def sv_extraction_floor(min_len: int) -> int:
    """The floor a load extracts at: the cache's default, or lower on request."""
    return min(SV_MIN_LEN_DEFAULT, int(min_len))
