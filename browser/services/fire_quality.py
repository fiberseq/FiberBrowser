"""Whether a BAM's MSP scores are fibertools FIRE scores: decided per file, from the reads first.

Supported: files that went through the fibertools FIRE pipeline only, and FiberHMM -> ``ft fire``. Other
histories (FIRE then a FiberHMM re-call, merges of both, reheadered files) follow the same per-file rule and
are not proved further.

``ft fire`` writes a FIRE score ``aq = 255 x precision = 255 x (1 - FDR)``:

* fibertools <= 0.12 as ``aq`` parallel to ``as``/``al``, 0 for every MSP that is not a FIRE element;
* fibertools 0.13 as an MA group ``fire.Q`` (in ``Ma``/``Aq``, or copied into ``MA`` by a FiberHMM pass-through
  writer) holding the FIRE elements; every other MSP has none (FDR 1).

``fiberhmm-apply --scores`` writes ``aq`` too, with the same layout: the MSP's mean P(accessible) x 255.

The verdict (``file_fire_status``), from the first ``SAMPLE_READS`` records of the file, cached per file:

1. a ``fire`` group in any sampled read -> FIRE ("fire group in reads"): only ``ft fire`` writes one;
2. else the legacy ``aq`` values of the sampled MSPs, when at least ``MIN_SCORED_MSPS``: a share of exact zeros of
   at least ``FIRE_MIN_ZERO_SHARE`` -> FIRE ("score pattern"); at most ``FIBERHMM_MAX_ZERO_SHARE`` -> FiberHMM's
   scores ("score pattern"). (Real data: ft fire 0.6.2 90.5 % zeros; fiberhmm-apply --scores 0.0 % of 272,546.)
3. else the header: an ``ft fire`` @PG -> FIRE ("header"); otherwise not FIRE ("header").

FIRE files: every read's MSP layer carries the FIRE score as ``aq`` (an MSP that is not a FIRE element: 0), so the
FIRE quality filter (aq >= 230 by default) keeps the FIRE elements. Other files: an ``aq`` is renamed ``hq`` (no
FIRE filter applies) and the as/al overlay's scores become 128 ("no score").
"""
from __future__ import annotations

import os
import threading
from typing import Any, Dict, List, Optional

FIRE_QUALITY = "aq"
NON_FIRE_MSP_QUALITY = "hq"

#: Records read from the start of a file for its verdict (stops early once decided).
SAMPLE_READS = 2000
#: Legacy aq values needed before their pattern decides.
MIN_SCORED_MSPS = 50
#: Share of aq == 0 among sampled MSPs at or above which they are FIRE scores (linkers are 0).
FIRE_MIN_ZERO_SHARE = 0.20
#: Share of aq == 0 at or below which they are FiberHMM posteriors (a posterior mean of 0 is essentially absent).
FIBERHMM_MAX_ZERO_SHARE = 0.01
#: Boundary tolerance (bp) when a FIRE element or an as/al score is placed on an MSP.
MATCH_TOLERANCE_BP = 1

_FT_VALUE_OPTIONS = frozenset({"-t", "--threads", "-F", "--filter", "-x", "--ftx", "--ml"})
_CACHE: Dict[tuple, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def header_has_ft_fire(header) -> bool:
    """An ``ft fire`` @PG record (fibertools, any version; global options before the subcommand allowed)."""
    from services import bam_tags as bt
    hdr = bt._coerce_header_dict(header) or {}
    for pg in hdr.get("PG", []) or []:
        if not isinstance(pg, dict) or bt._pg_family(pg) != "fibertools":
            continue
        tokens = bt._cl_tokens(pg.get("CL", ""))
        start = next((i + 1 for i, t in enumerate(tokens) if bt._basename(t) in bt._FIBERTOOLS_PROGRAMS), 1)
        skip = False
        for token in tokens[start:]:
            if skip:
                skip = False
                continue
            if token.startswith("-"):
                skip = token in _FT_VALUE_OPTIONS
                continue
            if len(token) >= 3 and "fire".startswith(token):
                return True
            break
    return False


def record_has_fire_group(record) -> bool:
    for tag in ("MA", "Ma"):
        try:
            if record.has_tag(tag) and ";fire" in str(record.get_tag(tag)):
                return True
        except (AttributeError, KeyError, ValueError):
            pass
    return False


def classify(fire_group_seen: bool, aq_values: List[int], header) -> Dict[str, Any]:
    """The verdict from sampled data (see the module docstring)."""
    if fire_group_seen:
        return {"fire": True, "basis": "fire group in reads"}
    if len(aq_values) >= MIN_SCORED_MSPS:
        zeros = sum(1 for v in aq_values if v == 0) / len(aq_values)
        if zeros >= FIRE_MIN_ZERO_SHARE:
            return {"fire": True, "basis": "score pattern", "zero_share": round(zeros, 4)}
        if zeros <= FIBERHMM_MAX_ZERO_SHARE:
            return {"fire": False, "basis": "score pattern", "zero_share": round(zeros, 4)}
    if header_has_ft_fire(header):
        return {"fire": True, "basis": "header"}
    return {"fire": False, "basis": "header"}


def file_fire_status(bam_path, header=None) -> Dict[str, Any]:
    """The file's verdict, sampled once per file (path, size, mtime) on its own handle, and cached in ``_CACHE``."""
    key = _file_key(bam_path)
    with _LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return dict(hit)
    fire_group_seen, aq_values = False, []
    try:
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(str(bam_path), "rb") as handle:
            if header is None:
                header = handle.header
            for n, record in enumerate(handle.fetch(until_eof=True)):
                if n >= SAMPLE_READS or len(aq_values) >= 20 * MIN_SCORED_MSPS:
                    break
                if record_has_fire_group(record):
                    fire_group_seen = True
                    break
                if record.has_tag("aq") and record.has_tag("as"):
                    aq_values.extend(int(v) for v in record.get_tag("aq"))
    except Exception:
        pass   # unreadable here (or a test double): the header decides
    status = classify(fire_group_seen, aq_values, header)
    with _LOCK:
        _CACHE[key] = status
    return dict(status)


def _file_key(path) -> tuple:
    raw = str(path or "")
    try:
        st = os.stat(raw)
        return (os.path.realpath(raw), st.st_size, st.st_mtime_ns)
    except OSError:
        return (raw,)


def _match(scores: Dict[tuple, int], start: int, end: int) -> Optional[int]:
    """The score of the span matching ``[start, end)`` within ``MATCH_TOLERANCE_BP`` at both ends."""
    hit = scores.get((start, end))
    if hit is not None or not MATCH_TOLERANCE_BP:
        return hit
    t = MATCH_TOLERANCE_BP
    for ds in range(-t, t + 1):
        for de in range(-t, t + 1):
            hit = scores.get((start + ds, end + de))
            if hit is not None:
                return hit
    return None


def _scores_by_span(intervals, values) -> Dict[tuple, int]:
    return {(int(iv[0]), int(iv[1])): int(values[i])
            for i, iv in enumerate(intervals or ()) if i < len(values) and values[i] is not None}


def apply_msp_quality_source(read: dict, fire: Optional[bool], record=None) -> dict:
    """Give one freshly loaded read's MSP scores their meaning (``fire``: the file's verdict). In place."""
    if fire is None:
        return read
    layers = read.get("layers")
    overlay = read.get("fire")
    if not fire:
        if layers:
            layers.pop("fire", None)
            if not layers:
                del read["layers"]
                layers = None
            msp = layers.get("msp") if layers else None
            if msp is not None and FIRE_QUALITY in (msp.get("quality_names") or []):
                msp["quality_names"] = [NON_FIRE_MSP_QUALITY if q == FIRE_QUALITY else q for q in msp["quality_names"]]
        if overlay and any(len(iv) >= 3 and iv[2] not in (128, None) for iv in overlay):
            read["fire"] = [[iv[0], iv[1], 128, *iv[3:]] for iv in overlay]
        return read

    fire_group = layers.pop("fire", None) if layers else None
    msp = layers.get("msp") if layers else None
    if msp is not None:
        names = msp.get("quality_names") or []
        if FIRE_QUALITY not in names or not msp.get("qualities"):
            if fire_group is not None:
                # fibertools 0.13: its FIRE elements' scores (an element without a loaded score counts as 255).
                values = (fire_group.get("qualities") or [None])[0]
                source = (_scores_by_span(fire_group.get("intervals"), values) if values
                          else {(int(iv[0]), int(iv[1])): 255 for iv in fire_group.get("intervals") or ()})
            elif overlay and record is not None and record.has_tag("aq") and not record.has_tag("Ma"):
                # fibertools <= 0.12 on FiberHMM's MA: the FIRE score is the aq of the as/al MSPs.
                source = _scores_by_span(overlay, [iv[2] if len(iv) >= 3 else None for iv in overlay])
            else:
                source = {}   # no FIRE element on this read (ft 0.13 writes no fire group then)
            msp["qualities"] = [[_match(source, int(iv[0]), int(iv[1])) or 0 for iv in msp.get("intervals") or ()]]
            msp["quality_names"] = [FIRE_QUALITY]
        msp["quality_source"] = "fire"
        if overlay:
            scores = _scores_by_span(msp["intervals"], msp["qualities"][0])
            read["fire"] = [[iv[0], iv[1], _match(scores, int(iv[0]), int(iv[1])) or 0, *iv[3:]] for iv in overlay]
    elif fire_group is not None:
        fire_group["quality_names"] = [FIRE_QUALITY] * len(fire_group.get("quality_names") or [])
        fire_group["quality_source"] = "fire"
        layers["fire"] = fire_group
    read["fire_quality_source"] = "fire"
    return read
