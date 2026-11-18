"""The frame of a BAM's legacy ns/nl/as/al tags: the header first, then the reads' m6A when the header can't tell.

Legacy footprint tags are in one of two frames on a reverse (flag 16) read: molecular (counted from the molecule's
own 5' end, the genomic right end: fibertools <= 0.12, FiberHMM >= 2.x) or SEQ (reference-forward: FiberHMM v1.0).
The header decides when it can (``bam_tags.legacy_tag_frame_report``: the @PG chain, ``coord=molecular``). A file
whose header lost its @PG/@CO lines gives no evidence, and the old guess (SEQ, unless a read's MA has FiberHMM
>= 2.13.2 "." footprint groups) drew every reverse read of a header-stripped molecular file mirrored.

The reads settle it. Nucleosomes are footprints: the methyltransferase could not reach them, so they hold few m6A
calls. MSPs (as/al) are the accessible patches between them and hold many. Read in the wrong frame, a reverse read's
intervals land at ``L - x``, on unrelated sequence. So, for sampled reverse reads that carry legacy tags and MM/ML
m6A calls (ML >= ``ML_CUTOFF``), the calls inside the intervals are counted in both frames:

* nucleosomes (ns/nl, the primary signal): the true frame has far fewer calls inside them;
* MSPs (as/al): the true frame has more. They confirm, or alone decide a file without ns/nl.

A frame wins when the evidence is clear (``classify``: enough intervals and calls, a z-score of at least ``Z_MIN``
and a density ratio of at least ``MIN_RATIO`` in the wrong frame's disfavour), and the nucleosome and MSP evidence do
not disagree. Otherwise the reads are inconclusive (no m6A, as in DAF files; too few reverse reads; similar counts)
and the header rule stands. Forward reads are the same in both frames and are skipped.

When the reads are used (``file_legacy_frame``):

* header with explicit evidence (a footprint writer on the @PG chain, or ``coord=molecular``): the header wins, the
  reads are not scanned;
* header without evidence (stripped): reads decisive molecular -> molecular for every read; otherwise (decisive SEQ
  or inconclusive) the old rule, so a read whose MA has "." footprint groups is still molecular;
* header ambiguous (merged branches whose last footprint writers disagree): reads decisive -> their frame;
  otherwise the header's resolution.

The verdict is sampled once per file (the first ``SAMPLE_READS`` records, stopping early once decisive) on its own
handle, and cached by path, size and modification time.
"""
from __future__ import annotations

import bisect
import os
import threading
from math import sqrt
from typing import Any, Dict, List, Optional, Tuple

#: Records read from the start of a file for its verdict.
SAMPLE_READS = 2000
#: An m6A call counts at ML >= this (the loader's m6A threshold).
ML_CUTOFF = 125
#: Footprint intervals (of the deciding kind) needed before the reads may decide.
MIN_INTERVALS = 10
#: Calls inside the intervals in the frame they favour less, needed before the reads may decide.
MIN_CALLS = 20
#: z-score of the count difference between the frames, ``|a - b| / sqrt(a + b)``.
Z_MIN = 5.0
#: Ratio of call counts (both + 1) between the frames: wrong / true for nucleosomes, true / wrong for MSPs.
MIN_RATIO = 1.5
#: The other kind of evidence vetoes a verdict when it points the other way at least this strongly.
Z_VETO = 3.0
#: Stop sampling early once this many reverse reads were scored and the verdict holds at ``Z_STOP``.
EARLY_STOP_READS = 5
Z_STOP = 10.0

BASIS_HEADER = "header"
BASIS_READS = "m6A in reads"
BASIS_DEFAULT = "default"

_CACHE: Dict[tuple, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def _inside(positions: List[int], intervals: List[Tuple[int, int]]) -> int:
    """How many of the sorted ``positions`` fall in the half-open ``intervals`` (any order, may overlap)."""
    total = 0
    for start, end in intervals:
        total += bisect.bisect_left(positions, end) - bisect.bisect_left(positions, start)
    return total


def _tag_pairs(record, start_tag: str, length_tag: str) -> Optional[List[Tuple[int, int]]]:
    try:
        if not (record.has_tag(start_tag) and record.has_tag(length_tag)):
            return None
        starts, lengths = list(record.get_tag(start_tag)), list(record.get_tag(length_tag))
    except (AttributeError, KeyError, TypeError, ValueError):
        return None
    if not starts or len(starts) != len(lengths):
        return None
    return [(int(s), int(l)) for s, l in zip(starts, lengths) if int(l) > 0]


def score_read(record) -> Optional[Dict[str, int]]:
    """One reverse read's counts of m6A calls inside its legacy intervals in each frame, or None when it can't
    vote (forward, secondary, supplementary, hard-clipped, no legacy intervals, no m6A calls)."""
    try:
        if (not record.is_reverse or record.is_unmapped or record.is_secondary or record.is_supplementary):
            return None
        if any(op == 5 for op, _ in (record.cigartuples or ())):
            return None
        length = int(record.query_length or 0)
    except (AttributeError, TypeError, ValueError):
        return None
    if length <= 0:
        return None
    nucs = _tag_pairs(record, "ns", "nl")
    msps = _tag_pairs(record, "as", "al")
    if not nucs and not msps:
        return None
    from services.bam_tags import _decode_mm_ml_calls
    try:
        calls = _decode_mm_ml_calls(record) or []
    except Exception:
        return None
    positions = sorted(int(q) for _base, mod, q, prob in calls
                       if mod == "a" and prob is not None and prob >= ML_CUTOFF and 0 <= int(q) < length)
    if not positions:
        return None
    out = {"nuc_n": 0, "nuc_seq": 0, "nuc_mol": 0, "msp_n": 0, "msp_seq": 0, "msp_mol": 0}
    for kind, pairs in (("nuc", nucs), ("msp", msps)):
        if not pairs:
            continue
        seq = [(s, s + l) for s, l in pairs]
        mol = [(length - (s + l), length - s) for s, l in pairs]
        out[f"{kind}_n"] = len(pairs)
        out[f"{kind}_seq"] = _inside(positions, seq)
        out[f"{kind}_mol"] = _inside(positions, mol)
    return out


def _evidence(n: int, mol: int, seq: int, fewer_wins: bool, z_min: float) -> Tuple[Optional[str], float]:
    """(winning frame or None, signed z: > 0 favours molecular) for one kind of interval.

    ``mol``/``seq`` are the call counts inside the intervals read in the molecular / SEQ frame. Nucleosomes: fewer
    calls wins; MSPs: more calls wins."""
    total = mol + seq
    if n <= 0 or total <= 0:
        return None, 0.0
    z = (seq - mol) / sqrt(total) if fewer_wins else (mol - seq) / sqrt(total)
    if n < MIN_INTERVALS:
        return None, z
    if fewer_wins:
        wrong, right = max(mol, seq), min(mol, seq)
        ratio = (wrong + 1) / (right + 1)
        enough = wrong >= MIN_CALLS
    else:
        right, wrong = max(mol, seq), min(mol, seq)
        ratio = (right + 1) / (wrong + 1)
        enough = right >= MIN_CALLS
    if enough and abs(z) >= z_min and ratio >= MIN_RATIO:
        return ("molecular" if z > 0 else "seq"), z
    return None, z


def classify(totals: Dict[str, int], z_min: Optional[float] = None) -> Dict[str, Any]:
    """The reads' verdict from summed ``score_read`` counts: ``{"frame": "molecular" | "seq" | None, ...}``."""
    z_min = Z_MIN if z_min is None else z_min
    nuc_frame, nuc_z = _evidence(totals.get("nuc_n", 0), totals.get("nuc_mol", 0), totals.get("nuc_seq", 0),
                                 True, z_min)
    msp_frame, msp_z = _evidence(totals.get("msp_n", 0), totals.get("msp_mol", 0), totals.get("msp_seq", 0),
                                 False, z_min)
    frame = nuc_frame or msp_frame
    decider_z = nuc_z if nuc_frame else msp_z
    other_z = msp_z if nuc_frame else nuc_z
    if frame is not None and other_z * decider_z < 0 and abs(other_z) >= Z_VETO:
        frame = None   # the two kinds of interval disagree
    return {"frame": frame, "nuc_z": round(nuc_z, 2), "msp_z": round(msp_z, 2)}


def scan_reads(records, limit: int = SAMPLE_READS) -> Dict[str, Any]:
    """Score up to ``limit`` records; the reads' verdict and its counts."""
    totals = {"nuc_n": 0, "nuc_seq": 0, "nuc_mol": 0, "msp_n": 0, "msp_seq": 0, "msp_mol": 0}
    reverse_reads = sampled = 0
    for sampled, record in enumerate(records, start=1):
        if sampled > limit:
            sampled = limit
            break
        counts = score_read(record)
        if counts is None:
            continue
        reverse_reads += 1
        for key, value in counts.items():
            totals[key] += value
        if reverse_reads >= EARLY_STOP_READS and classify(totals, Z_STOP)["frame"] is not None:
            break
    verdict = classify(totals)
    return {**verdict, "reverse_reads": reverse_reads, "records": sampled, **totals}


def _file_key(path) -> tuple:
    raw = str(path or "")
    try:
        st = os.stat(raw)
        return (os.path.realpath(raw), st.st_size, st.st_mtime_ns)
    except OSError:
        return (raw,)


def reads_legacy_frame(bam_path) -> Dict[str, Any]:
    """The reads' verdict for a file, sampled once per file (path, size, mtime) on its own handle, and cached.
    Never raises: an unreadable file is inconclusive."""
    key = _file_key(bam_path)
    with _LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return dict(hit)
    result: Dict[str, Any] = {"frame": None}
    try:
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(str(bam_path), "rb", check_sq=False) as handle:
            result = scan_reads(handle.fetch(until_eof=True))
    except Exception:
        result = {"frame": None, "error": "unreadable"}
    with _LOCK:
        if len(_CACHE) > 256:
            _CACHE.clear()
        _CACHE[key] = result
    return dict(result)


def file_legacy_frame(bam_path, header) -> Dict[str, Any]:
    """The file's legacy-tag frame: ``frame`` ("molecular" | "seq"), ``basis`` (``BASIS_HEADER``, ``BASIS_READS``
    or ``BASIS_DEFAULT``), ``tuple`` (``(molecular, unknown)`` for ``bam_tags.read_legacy_tags_are_molecular``) and,
    when the reads were sampled, ``reads`` (their verdict and counts). See the module docstring."""
    from services.bam_tags import legacy_tag_frame_report
    try:
        report = legacy_tag_frame_report(header)
    except Exception:
        report = {"frame": "seq", "source": "default", "ambiguous": False}
    header_molecular = report.get("frame") == "molecular"
    unknown = report.get("source") == "default"
    if not unknown and not report.get("ambiguous"):
        return {"frame": report["frame"], "basis": BASIS_HEADER, "tuple": (header_molecular, False)}
    reads = reads_legacy_frame(bam_path) if bam_path else {"frame": None}
    frame = reads.get("frame")
    if unknown:
        if frame == "molecular":
            return {"frame": "molecular", "basis": BASIS_READS, "tuple": (True, False), "reads": reads}
        # Decisive SEQ or inconclusive: the old rule (SEQ, or molecular for a read with "." MA footprint groups).
        return {"frame": "seq", "basis": BASIS_READS if frame == "seq" else BASIS_DEFAULT,
                "tuple": (False, True), "reads": reads}
    if frame is not None:
        return {"frame": frame, "basis": BASIS_READS, "tuple": (frame == "molecular", False), "reads": reads}
    return {"frame": report["frame"], "basis": BASIS_HEADER, "tuple": (header_molecular, False), "reads": reads}


def bam_legacy_frame_for(bam_path, header) -> Tuple[bool, bool]:
    """``(molecular, unknown)`` for the loaders: ``file_legacy_frame``'s tuple, the header's alone on any error."""
    try:
        return file_legacy_frame(bam_path, header)["tuple"]
    except Exception:
        from services.bam_tags import bam_legacy_frame
        try:
            return bam_legacy_frame(header)
        except Exception:
            return (False, False)
