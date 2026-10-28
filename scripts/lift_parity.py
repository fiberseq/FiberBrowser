#!/usr/bin/env python
"""Record-by-record parity of FiberBrowser's live lift against fiberhmm-lift.

Does live lift give the same records as ``fiberhmm-lift`` (graphlift's
``liftbam``) for the same molecules? This decides whether target-frame
pooled scans can use live-lift rows instead of a lifted BAM.

Both sides go through FiberBrowser's own compact-read loader
(``build_compact_reads_from_bam``) with the options live lift fixes for its
source decode (record scoped: one row per record, supplementaries
included, no legacy layer inference), so the comparison isolates the lift:

- live lift: ``load_lifted_rows`` on ``--source-bam`` over ``--region`` with
  default ``LiftSettings()``, then the analysis cohort
  (``prepare_lift_cohort(rows, 'analysis', settings)``), what a scan reads;
- fiberhmm-lift: the same loader on ``--lifted-bam`` over the live load's
  selection range (the view plus its margin), so both sides cover the same
  absolute window.

Join: one source record is ``(QNAME, source contig, source start)``; live
rows carry it in ``live_lift.source``, lifted records in ``Yp`` (1-based).
A key two distinct SAM records share is ambiguous (``Yp`` cannot tell their
lifted records apart): it is never compared, and it fails the verdict. A
source record whose rows touch the selection edge on either side is left
out and counted.

Per source record: placements (target contig, start, end, orientation),
the molecule strand (``st``, both sides in the molecule frame), every call
interval per call group (``intervals``, ``fire`` and each MA layer) with its
payload (size or score, quality/state bytes, annotation name), the group's
gap and neutral rows (the measured tiling a scan counts: ``intervals~gap``,
``intervals~neutral``, compared like calls by geometry), m6A/5mC
positions, and deamination positions with their channel (C->T or G->A, in
the molecule frame). Calls of a group are paired by target geometry, never
by tag-array id (a frame conversion can renumber those): greatest base
overlap, ties by target order (``pair_calls``). Calls are compared two ways:

- raw geometry, the parts as the rows deliver them;
- bases: per call, the merged target bases (zero-width insertion markers
  kept as positions). Buckets: identical, within 10 bp (hull ends within
  10 bp and at most 10 bp in the symmetric difference), different. A pair
  with the same bases but a different payload is different (cause
  ``payload``).

Deamination read from reference mismatches (MD) differs between assemblies
by design; only a record whose events all came from there, on both sides,
is left out of the verdict (``deam_exempt``). Events from MM tags or IUPAC
R/Y bases are always compared.

Each difference gets a cause (``CALL_CAUSES``); see ``classify_call``.

usage:
    python scripts/lift_parity.py --source-bam ~/pglift_work/demo_data/sample_a.alu_chr3.hg002v1.1.bam \\
        --lifted-bam ~/pglift_work/lifted/sample_a.alu_chr3.GRCh38.bam \\
        --map ~/pglift_work/maps/hprc.GRCh38.HG002.chain.graphlift.json \\
        --region chr3:128,590,000-128,770,000 --out-json parity.json --out-md parity.md
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOLERANCE_BP = 10
MAX_EXAMPLES = 8
POINT_FIELDS = ("methyl_m6a", "methyl_m5c", "possible_deam_ct", "possible_deam_ga")
CALL_CAUSES = {
    "insertion_split": "raw parts differ, bases identical: live lift cuts the call at a source-only base "
                       "(an insertion badge); on the lifted record the CIGAR I sits inside one interval",
    "connector_hole": "live lift leaves the call's target-only bases out (a connector: target bases with no "
                      "source base); the lifted record's call spans the CIGAR D (the decoder cuts calls only "
                      "at deletions of at least sv_min_len)",
    "insertion_end_base": "the call ends inside a target insertion (a live badge): the decoder ends a call "
                          "that ends inside a CIGAR I one base after the insertion; live lift ends it at the "
                          "insertion (possibly with connector holes too)",
    "insertion_stub": "the call lies inside a target insertion: the decoder gives the lifted record a 1-bp "
                      "interval at the base after the CIGAR I; live lift drops the call",
    "insertion_marker": "a call with no target base: live lift draws a zero-width marker",
    "native_hole": "the decoder cuts the lifted record's call at an SV event (a CIGAR indel group of at "
                   "least sv_min_len) that the source record does not have; live lift keeps those bases",
    "payload": "same geometry, different payload: the call's state/quality bytes, score, size or annotation "
               "name differ (e.g. nfrvar open vs closed)",
    "gap_dropped_at_connector": "a gap (accessible linker / inferred MSP) or neutral row the lifted record holds "
                                "across a target-only stretch; live lift emits no gap across a connector longer "
                                "than rejoin_bp (terminal gaps are hidden per span)",
    "gap_dropped_at_insertion": "a gap or neutral row the lifted record holds next to a target insertion; live "
                                "lift emits no gap across an insertion badge longer than rejoin_bp",
    "terminal_gap_extent": "a gap between the record's outermost call of any kind (an MSP, say) and its first or "
                           "last footprint: the decoder ends hidden terminal gaps at the extent of all calls, live "
                           "lift at the footprints",
    "decoder_cut_artifact": "known (cause 5): the decoder cuts the lifted record's call (or gap) at the deleted "
                            "bases of an indel event that groups a map gap with a read indel (or a read indel "
                            "liftbam merged into the map gap's I/D) on the lifted CIGAR; live lift groups map "
                            "gaps with map gaps only, as the source record's own indels are grouped in its frame",
    "native_only": "the call is only on the lifted record",
    "live_only": "the call is only on the live-lift row",
    "other": "unclassified (see the examples)",
}
# Differences in known categories (listed, never a FAIL): decoder artifacts of the lifted CIGAR (cause 5).
KNOWN_CAUSES = {"decoder_cut_artifact"}
# One-side-only causes that are owner decisions (cause 9: fiberhmm-lift drops an orphan supplementary).
KNOWN_ONE_SIDE = {"orphan_supplementary_dropped"}
# Point fields a parity verdict needs equal. deam on a record without m6A/5mC calls is read from mismatches
# against the record's own reference (MD), so it differs between assemblies by design; see deam_exempt.
VERDICT_POINTS = ("methyl_m6a", "methyl_m5c", "deam")


def scratch_env() -> str:
    """Point HOME and every FiberBrowser settings path at a new temporary
    folder (never ~/.fiberhmm), then make ``browser/`` importable."""
    scratch = tempfile.mkdtemp(prefix="lift-parity-")
    for key, value in {
        "FIBERBROWSER_NO_OPEN": "1", "FIBERBROWSER_NO_UPDATE_CHECK": "1",
        "FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN": "1",
        "FIBERBROWSER_SETTINGS": os.path.join(scratch, "browser_settings.json"),
        "FIBERBROWSER_APP_SETTINGS": os.path.join(scratch, "app_settings.json"),
        "FIBERBROWSER_RUNTIME_FILE": os.path.join(scratch, "runtime.json"),
        "FIBERBROWSER_LIBRARY": os.path.join(scratch, "library.json"),
        "FIBERBROWSER_JOBS_DIR": os.path.join(scratch, "jobs"),
        "FIBERBROWSER_PREFERENCES": os.path.join(scratch, "preferences.json"),
        "FIBERBROWSER_REGION_CATALOG_DIR": os.path.join(scratch, "regions"),
        "FIBERBROWSER_ALT_ALLELE_DIR": os.path.join(scratch, "alt"),
        "HOME": os.path.join(scratch, "home"),
    }.items():
        os.environ[key] = value
    os.makedirs(os.environ["HOME"], exist_ok=True)
    browser = os.path.join(ROOT, "browser")
    if browser not in sys.path:
        sys.path.insert(0, browser)
    return scratch


# ── Pure helpers (tests/test_lift_parity.py) ────────────────────────────────

def parse_region(text: str) -> tuple:
    """``'chr3:128,590,000-128,770,000'`` -> ``('chr3', 128590000, 128770000)``
    (start 1-based inclusive as written, returned 0-based half-open)."""
    chrom, _, span = text.replace(",", "").rpartition(":")
    a, _, b = span.partition("-")
    if not chrom or not a.isdigit() or not b.isdigit() or int(b) <= int(a) - 1:
        raise ValueError(f"region must be chrom:start-end, not {text!r}")
    return chrom, int(a) - 1 if int(a) > 0 else 0, int(b)


def parse_yp(value) -> tuple | None:
    """liftbam's ``Yp`` (``contig:pos1:strand``) -> ``(contig, pos0, strand)``."""
    if not value:
        return None
    contig, _, rest = str(value).rpartition(":")
    contig2, _, pos = contig.rpartition(":")
    if pos.isdigit() and rest in ("+", "-"):
        return contig2, int(pos) - 1, rest
    if rest.isdigit():  # no strand
        return contig, int(rest) - 1, None
    return None


def merge_spans(spans) -> list:
    """Sorted, merged ``[a, b)`` spans (touching ones join); zero-width spans dropped."""
    out = []
    for a, b in sorted((int(s[0]), int(s[1])) for s in spans if int(s[1]) > int(s[0])):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def subtract_spans(spans, cuts) -> list:
    """Merged ``spans`` minus merged ``cuts``."""
    cuts = merge_spans(cuts)
    out = []
    for a, b in merge_spans(spans):
        pos = a
        for c0, c1 in cuts:
            if c1 <= pos or c0 >= b:
                continue
            if c0 > pos:
                out.append([pos, c0])
            pos = max(pos, c1)
        if pos < b:
            out.append([pos, b])
    return out


def span_bp(spans) -> int:
    return sum(int(b) - int(a) for a, b in spans)


def markers(parts) -> list:
    """Positions of zero-width parts (insertion-only calls)."""
    return sorted(int(a) for a, b in parts if int(a) == int(b))


def classify_call(live, native, connectors=(), insertions=(), tolerance=TOLERANCE_BP, artifacts=()) -> dict:
    """One call on one placement. ``live``/``native``: its parts ``[t0, t1]``
    (absolute target, zero-width = insertion marker); ``connectors``: the live
    row's target gaps ``[a, b)``; ``insertions``: target positions of its
    insertion badges (source bases with no target base); ``artifacts``: the
    lifted record's cuts at events mixing map and read pieces (``artifact_spans``).
    Returns ``{raw,
    bucket, cause, bp}``: ``raw`` 'identical' | 'same_bases' | 'different';
    ``bucket`` 'identical' | 'within_10bp' | 'different'; ``cause`` a
    ``CALL_CAUSES`` key or None; ``bp`` the bases in the symmetric difference."""
    live = [[int(a), int(b)] for a, b in live]
    native = [[int(a), int(b)] for a, b in native]
    lm, nm = merge_spans(live), merge_spans(native)
    after_insertion = [[int(p), int(p) + 1] for p in insertions]
    if lm == nm and markers(live) == markers(native):
        if sorted(live) == sorted(native):
            return {"raw": "identical", "bucket": "identical", "cause": None, "bp": 0}
        return {"raw": "same_bases", "bucket": "identical", "cause": "insertion_split", "bp": 0}
    if not live or not native:
        parts = live or native
        bp = span_bp(merge_spans(parts))
        if live and not lm:
            cause = "insertion_marker"
        elif live and artifacts and not subtract_spans(lm, artifacts):
            cause = "decoder_cut_artifact"
        elif native and bp == 1 and not subtract_spans(nm, after_insertion):
            cause = "insertion_stub"
        else:
            cause = "live_only" if live else "native_only"
        return {"raw": "different", "bucket": "different", "cause": cause, "bp": bp}
    missing, extra = subtract_spans(nm, lm), subtract_spans(lm, nm)
    bp = span_bp(missing) + span_bp(extra)
    close = (bool(lm) and bool(nm) and abs(lm[0][0] - nm[0][0]) <= tolerance
             and abs(lm[-1][1] - nm[-1][1]) <= tolerance and bp <= tolerance)
    if not lm and markers(live):
        cause = "insertion_marker"
    elif not extra and missing and not subtract_spans(missing, connectors):
        return {"raw": "different", "bucket": "within_10bp" if close else "different", "cause": "connector_hole",
                "bp": bp, "holes": [b - a for a, b in missing]}
    elif not extra and missing and not subtract_spans(missing, list(connectors) + after_insertion):
        cause = "insertion_end_base"
    elif not missing and extra and artifacts and not subtract_spans(extra, artifacts):
        cause = "decoder_cut_artifact"
    elif not missing and extra:
        cause = "native_hole"
    else:
        cause = "other"
    return {"raw": "different", "bucket": "within_10bp" if close else "different", "cause": cause, "bp": bp}


def pair_placements(live, native) -> list:
    """Pair two lists of placements (dicts with contig/start/end): in target
    order when the counts match, else greedily by overlap. Returns
    ``[(live index | None, native index | None)]``."""
    lo = sorted(range(len(live)), key=lambda i: (live[i]["contig"], live[i]["start"], live[i]["end"]))
    no = sorted(range(len(native)), key=lambda i: (native[i]["contig"], native[i]["start"], native[i]["end"]))
    if len(lo) == len(no):
        return list(zip(lo, no))

    def overlap(a, b):
        if a["contig"] != b["contig"]:
            return 0
        return max(0, min(a["end"], b["end"]) - max(a["start"], b["start"]))

    pairs = sorted(((overlap(live[i], native[j]), i, j) for i in lo for j in no), reverse=True)
    used_l, used_n, out = set(), set(), []
    for ov, i, j in pairs:
        if ov > 0 and i not in used_l and j not in used_n:
            out.append((i, j))
            used_l.add(i)
            used_n.add(j)
    out += [(i, None) for i in lo if i not in used_l] + [(None, j) for j in no if j not in used_n]
    return sorted(out, key=lambda p: (p[0] is None, p[0] if p[0] is not None else p[1]))


def compare_points(live, native) -> dict:
    live, native = set(live), set(native)
    return {"identical": live == native, "shared": len(live & native),
            "live_only": sorted(live - native), "native_only": sorted(native - live)}


def compare_placement(lp: dict, np_: dict, tolerance=TOLERANCE_BP) -> dict:
    """Placement fields, calls per group and call id, and points."""
    out = {"geometry": {k: lp[k] == np_[k] for k in ("contig", "start", "end", "orientation")},
           "calls": compare_calls(lp, np_, tolerance), "points": {}}
    for field in sorted(set(lp["points"]) | set(np_["points"])):
        out["points"][field] = compare_points(lp["points"].get(field, ()), np_["points"].get(field, ()))
    return out


def _pairing_spans(parts) -> list:
    """The bases a call covers for pairing: its merged parts, a zero-width marker as the one base after it."""
    return merge_spans([[int(a), int(b)] if int(b) > int(a) else [int(a), int(a) + 1] for a, b in parts])


def overlap_bp(a, b) -> int:
    """Bases two merged span lists share."""
    i = j = n = 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo:
            n += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return n


def pair_calls(live: dict, native: dict, live_payloads=None, native_payloads=None) -> list:
    """Pair one call group's calls (``{call id: parts}`` per side) by target
    geometry, never by id: tag-array indices (``MA0:3``, ``ns:3``) are not
    stable across a lift, since a frame conversion re-sorts them on reverse
    records. Greatest base overlap first; among equal overlaps (calls stacked
    on the same bases, such as 1-bp stubs at one insertion) the same payload,
    then the same id, then target order; a call that overlaps nothing on the
    other side stays unpaired. Returns ``[(live id | None, native id | None)]``."""
    live_payloads, native_payloads = live_payloads or {}, native_payloads or {}
    def order(calls):
        keys = [k for k in calls if calls[k]]
        spans = {k: _pairing_spans(calls[k]) for k in keys}
        keys.sort(key=lambda k: (spans[k][0][0], spans[k][-1][1], str(k)))
        return keys, [spans[k] for k in keys]

    lk, ls = order(live)
    nk, ns = order(native)
    import bisect
    starts = [sp[0][0] for sp in ns]
    reach, top = [], None
    for sp in ns:  # running maximum of hull ends: earlier calls past it end before a live call starts
        top = sp[-1][1] if top is None else max(top, sp[-1][1])
        reach.append(top)
    candidates = []
    for i, sp in enumerate(ls):
        a, b = sp[0][0], sp[-1][1]
        j = bisect.bisect_left(starts, b) - 1
        while j >= 0 and reach[j] > a:
            n = overlap_bp(sp, ns[j])
            if n:
                same_payload = live_payloads.get(lk[i], set()) == native_payloads.get(nk[j], set())
                candidates.append((-n, not same_payload, lk[i] != nk[j], i, j))
            j -= 1
    used_l, used_n, pairs = set(), set(), []
    for *_rank, i, j in sorted(candidates):
        if i not in used_l and j not in used_n:
            used_l.add(i)
            used_n.add(j)
            pairs.append((i, j))
    out = [(lk[i], nk[j]) for i, j in sorted(pairs)]
    out += [(lk[i], None) for i in range(len(lk)) if i not in used_l]
    out += [(None, nk[j]) for j in range(len(nk)) if j not in used_n]
    return out


def compare_calls(lp: dict, np_: dict, tolerance=TOLERANCE_BP) -> list:
    """Every call of every group, paired by geometry (``pair_calls``) and classified."""
    out = []
    artifacts = artifact_spans(lp, np_)
    for group in sorted(set(lp["calls"]) | set(np_["calls"])):
        lc, nc = lp["calls"].get(group, {}), np_["calls"].get(group, {})
        if TILING_MARK in group:
            out += compare_tiling(group, lc.get("<tile>", []), nc.get("<tile>", []), lp, tolerance, artifacts)
            continue
        lpay, npay = lp.get("payloads", {}).get(group, {}), np_.get("payloads", {}).get(group, {})
        if lc == nc and lpay == npay:
            # The same calls with the same parts and payloads: geometry pairs each with itself (calls stacked
            # on the same bases pair among equals), so every call is identical.
            out += [{"raw": "identical", "bucket": "identical", "cause": None, "bp": 0, "group": group, "call": c,
                     "live_call": c, "native_call": c, "payload_differs": False} for c in lc if lc[c]]
            continue
        for li, ni in pair_calls(lc, nc, lpay, npay):
            res = classify_call(lc.get(li, []) if li is not None else [], nc.get(ni, []) if ni is not None else [],
                                lp.get("connectors", ()), lp.get("insertions", ()), tolerance, artifacts)
            res.update(group=group, call=li if li is not None else ni, live_call=li, native_call=ni,
                       payload_differs=False)
            if li is not None and ni is not None and lpay.get(li, set()) != npay.get(ni, set()):
                # Same call, different state, score, quality or annotation: a difference whatever the geometry.
                res["payload_differs"] = True
                if res["bucket"] == "identical":
                    res.update(bucket="different", cause="payload")
            out.append(res)
    return out


def compare_tiling(group, live_parts, native_parts, lp: dict, tolerance=TOLERANCE_BP, artifacts=()) -> list:
    """A group's gap or neutral rows, unit by unit (``tiling_units``), classified
    like calls. A unit only the lifted record holds is refined by where live
    lift lost it: across a connector, or next to an insertion badge."""
    connectors, insertions = lp.get("connectors", ()), lp.get("insertions", ())
    # The extent of the live row's own calls in this group: hidden terminal gaps end there on live lift.
    own = merge_spans(x for parts in lp["calls"].get(group.split(TILING_MARK)[0], {}).values() for x in parts)
    out = []
    for lparts, nparts in tiling_units(live_parts, native_parts, connectors):
        res = classify_call(lparts, nparts, connectors, insertions, tolerance, artifacts)
        hull = merge_spans(lparts + nparts)
        key = f"<tile>:{hull[0][0]}-{hull[-1][1]}" if hull else "<tile>"
        if res["cause"] == "native_only":
            merged = merge_spans(nparts)
            if overlap_bp(merged, merge_spans(connectors)):
                res["cause"] = "gap_dropped_at_connector"
            elif any(a - 1 <= int(x) <= b for x in insertions for a, b in merged):
                res["cause"] = "gap_dropped_at_insertion"
            elif own and (merged[-1][1] <= own[0][0] or merged[0][0] >= own[-1][1]):
                res["cause"] = "terminal_gap_extent"
        res.update(group=group, call=key, live_call=key if lparts else None, native_call=key if nparts else None,
                   payload_differs=False, live_parts=lparts, native_parts=nparts)
        out.append(res)
    return out


def artifact_spans(lp: dict, np_: dict) -> list:
    """The lifted record's cuts (``np_['sv_events']``: its indel events of at least ``sv_min_len`` with
    deleted bases, as ``[(t, ref, len), ...]`` pieces) at events that mix map pieces and read pieces: a
    ``D`` equal to one of the live row's connectors, or an ``I`` of a badge's molecular length at the badge
    (or at the left end of the connector after it: liftbam writes I then D), is a map piece; any other
    piece is the read's (or a read indel liftbam merged into a map gap). Live lift groups map pieces only
    (the read's own indels are grouped in the source frame), so these cuts are a decoder artifact."""
    events = np_.get("sv_events") or ()
    if not events:
        return []
    conns = {(int(a), int(b)) for a, b in lp.get("connectors", ())}
    left_of = collections.defaultdict(set)
    for a, b in conns:
        left_of[b].add(a)
    anchors = collections.defaultdict(set)
    for pos, mol in lp.get("badges", ()):
        anchors[int(mol)].add(int(pos))
        anchors[int(mol)].update(left_of.get(int(pos), ()))
    anchor_any = set().union(*anchors.values()) if anchors else set()
    badge_at = collections.defaultdict(set)
    for pos, mol in lp.get("badges", ()):
        badge_at[int(mol)].add(int(pos))
    min_len = int(np_.get("sv_min_len") or 50)
    out = []
    for ev in events:
        kinds, idx = [], [n for n, p in enumerate(ev) if p[0] in "ID"]
        for n, (t, ref, ln) in enumerate(ev):
            ref, ln = int(ref), int(ln)
            kind, over = None, 0
            if t == "M":
                kinds.append((t, ref, ln, "bridge", 0))
                continue
            nxt = next((ev[m] for m in idx if m > n), None)
            if t == "I" and nxt is not None and nxt[0] == "D" and int(nxt[1]) == ref:
                # I then D (liftbam's junction): the badge sits anywhere from the left block's end (a read
                # deletion there moves it into the D) to the D's end.
                if any(ref <= p <= ref + int(nxt[2]) for p in badge_at.get(ln, ())):
                    kind = "map"
            if kind is None and t == "D":
                over = sum(max(0, min(b, ref + ln) - max(a, ref)) for a, b in conns)
                kind = "map" if (ref, ref + ln) in conns else "merged" if over else "read"
            elif kind is None:
                kind = "map" if ref in anchors.get(ln, ()) else "merged" if ref in anchor_any else "read"
            kinds.append((t, ref, ln, kind, over if kind == "merged" else ln))
        found = {k for *_x, k, _o in kinds if k != "bridge"}
        if not ("merged" in found or found >= {"map", "read"}):
            continue
        # What live lift cuts there itself: the event's map pieces grouped alone, as live lift groups them
        # (a read deletion's target bases count as aligned, a read insertion is left out, a merged I counts
        # whole). A merged D is the read's deleted bases with the connectors inside them: aligned bridges (as
        # live lift sees the fragments there) between connectors; its read bases before the first connector
        # come before the junction's I too (liftbam writes I then D). A connector that cuts loses, on live
        # lift, its junction's D up to the aligned blocks on either side: to the D's ends at its first and
        # last connectors, never across a fragment between two connectors (it has no aligned base).
        alone, spans_of = [], {}
        for n, (t, ref, ln, kind, mapped) in enumerate(kinds):
            if t == "M" or (t == "D" and kind == "read"):
                alone.append((0, 0, ln, 0))
            elif t == "D":
                inside = sorted((max(a, ref), min(b, ref + ln)) for a, b in conns if a < ref + ln and b > ref)
                sub, pos = [], ref
                for c, (a, b) in enumerate(inside):
                    if a > pos:
                        sub.append((0, 0, a - pos, 0))
                    tag = len(spans_of) + 1
                    spans_of[tag] = [ref if c == 0 else a, ref + ln if c == len(inside) - 1 else b]
                    sub.append((2, tag, b - a, 0))
                    pos = b
                if pos < ref + ln:
                    sub.append((0, 0, ref + ln - pos, 0))
                if sub and sub[0][0] == 0 and alone and alone[-1][0] == 1 and n and kinds[n - 1][1] == ref:
                    alone.insert(len(alone) - 1, sub.pop(0))
                alone += sub
            elif kind != "read":
                alone.append((1, 0, ln, 0))
        from services.sv_alleles import cigar_replacements
        live_cut = []
        for sub in cigar_replacements(alone, piece_min=10, merge_gap=10):
            if sub["len"] >= min_len:
                live_cut += [spans_of[p["ref"]] for p in sub.get("raw_pieces") or (dict(t=sub["t"], ref=sub["ref"]),)
                             if p["t"] == "D" and p["ref"] in spans_of]
        out += subtract_spans([[ref, ref + ln] for t, ref, ln, _k, _m in kinds if t == "D"], live_cut)
    # Cuts the source decode makes at the read's own deletions (of at least sv_min_len) are live lift's too.
    out = subtract_spans(out, np_.get("required_cuts") or ())
    return merge_spans(out)


def record_sv_events(rec, min_len: int) -> list:
    """A lifted pysam record's indel events of at least ``min_len`` that delete bases (the decoder cuts
    calls there: ``sv_events.read_deletion_cuts``), as ``[(t, ref, len), ...]`` indel pieces."""
    from services.sv_events import _cigar_pieces, _indel_events

    out = []
    for ev in _indel_events(_cigar_pieces(rec.cigartuples or (), int(rec.reference_start))):
        if ev["len"] < min_len:
            continue
        # The event's pieces with its aligned bridges (M, = and X as M): live lift's map-only grouping needs them.
        pieces = [("M" if p["t"] in "M=X" else p["t"], int(p["ref"]), int(p["len"])) for p in ev.get("raw_pieces") or (ev,)]
        if any(t == "D" for t, _r, _n in pieces):
            out.append(pieces)
    return out


def union_placements(placements: list) -> dict:
    """One record's placements as one: every call's parts and the connectors
    and insertions of all of them (a call a split cuts compares whole)."""
    calls = collections.defaultdict(lambda: collections.defaultdict(list))
    payloads = collections.defaultdict(lambda: collections.defaultdict(set))
    for p in placements:
        for group, by_call in p["calls"].items():
            for call, parts in by_call.items():
                calls[group][call] += parts
        for group, by_call in p.get("payloads", {}).items():
            for call, pay in by_call.items():
                payloads[group][call] |= set(pay)
    return {"calls": {g: dict(c) for g, c in calls.items()},
            "payloads": {g: dict(c) for g, c in payloads.items()},
            "connectors": [c for p in placements for c in p.get("connectors", ())],
            "insertions": [x for p in placements for x in p.get("insertions", ())],
            "badges": [b for p in placements for b in p.get("badges", ())],
            "sv_events": [e for p in placements for e in p.get("sv_events", ())],
            "required_cuts": [c for p in placements for c in p.get("required_cuts", ())]}


def strand_status(lp: dict, np_: dict) -> str:
    """The molecule strand (``st``) of a placement pair: 'absent', 'inferred'
    (either side guessed it from marks), 'same' or 'differs'. Both sides are
    in the molecule frame: live lift keeps the source ``st``, and the loader
    turns a lifted record's ``st`` back to the molecule frame where the lift
    reversed it (``read_strand.record_strand_fields``). A correct swap on a
    ``-`` chain therefore compares equal; a missing one differs."""
    ls_, ns_ = lp.get("strand"), np_.get("strand")
    if ls_ is None and ns_ is None:
        return "absent"
    if lp.get("strand_inferred") or np_.get("strand_inferred"):
        return "inferred"
    return "same" if ls_ == ns_ else "differs"


def find_ambiguous(live_records: dict, source_counts: dict) -> set:
    """Source keys ``(QNAME, contig, start)`` that two distinct SAM records
    share: live rows of the key from more than one record (record hash and
    occurrence), or more than one mapped, non-secondary source record there.
    Their placements cannot be told apart on the lifted side (``Yp`` names
    only the key), so they are never compared."""
    return ({k for k, recs in live_records.items() if len(set(recs)) > 1}
            | {k for k, n in source_counts.items() if n > 1})


def join_records(live_by: dict, native_by: dict, edge=(), ambiguous=()) -> tuple:
    """``(records, one_side, n_edge, n_ambiguous)``: one record per source key
    on both sides; ``one_side`` lists ``(key, 'live_only' | 'native_only')``.
    Keys touching the window edge, and ambiguous keys, are left out and counted."""
    edge, ambiguous = set(edge), set(ambiguous)
    keys = sorted(set(live_by) | set(native_by))
    records, one_side = [], []
    n_edge = n_ambiguous = 0
    for key in keys:
        if key in ambiguous:
            n_ambiguous += 1
            continue
        if key in edge:
            n_edge += 1
            continue
        if key not in native_by or key not in live_by:
            one_side.append((key, "live_only" if key in live_by else "native_only"))
            continue
        records.append({"key": key, "live": live_by[key], "native": native_by[key]})
    return records, one_side, n_edge, n_ambiguous


def source_record_counts(source_bam, keys) -> dict:
    """Mapped, non-secondary source records at each key ``(QNAME, contig, start)``."""
    import pysam

    out = {}
    with pysam.AlignmentFile(source_bam) as bam:
        for qname, contig, start in keys:
            if contig not in bam.references:
                continue
            out[(qname, contig, start)] = sum(
                1 for r in bam.fetch(contig, start, start + 1)
                if r.query_name == qname and r.reference_start == start and not r.is_secondary and not r.is_unmapped)
    return out


def summarize(records: list, verdict_points=VERDICT_POINTS, rejoin_bp: int = 5) -> dict:
    """Counts over ``[{key, live: [placement], native: [placement]}]`` records.
    Deamination compares ``(position, channel)`` in the molecule frame; a
    record whose events all came from reference mismatches on both sides
    (``deam_exempt``, per placement ``deam_source``) counts as
    ``deam_from_md``, outside the verdict."""
    s = collections.Counter()
    calls = collections.defaultdict(collections.Counter)
    record_calls = collections.defaultdict(collections.Counter)
    causes = collections.Counter()
    cause_bp = collections.Counter()
    record_causes = collections.Counter()
    holes = collections.Counter()
    points = collections.defaultdict(collections.Counter)
    examples = collections.defaultdict(list)
    strand = collections.Counter()
    known = collections.Counter()
    for idx, rec in enumerate(records):
        s["records_compared"] += 1
        live, native = rec["live"], rec["native"]
        s["placements_live"] += len(live)
        s["placements_native"] += len(native)
        s["records_split_live"] += len(live) > 1
        s["records_split_native"] += len(native) > 1
        placements_same = len(live) == len(native)
        if not placements_same:
            s["records_placement_count_differs"] += 1
            _example(examples, "placement_count", idx, rec, live=len(live), native=len(native),
                     live_spans=[[p["start"], p["end"]] for p in live],
                     native_spans=[[p["start"], p["end"]] for p in native])
        calls_same = points_same = True
        for i, j in pair_placements(live, native):
            if i is None or j is None:
                s["placements_unpaired"] += 1
                placements_same = False
                continue
            res = compare_placement(live[i], native[j])
            if all(res["geometry"].values()):
                s["placements_identical_geometry"] += 1
            else:
                placements_same = False
                for k, same in res["geometry"].items():
                    if not same:
                        s[f"placements_differ_{k}"] += 1
                _example(examples, "placement_geometry", idx, rec,
                         live=[live[i][k] for k in ("contig", "start", "end", "orientation")],
                         native=[native[j][k] for k in ("contig", "start", "end", "orientation")])
            status = strand_status(live[i], native[j])
            strand[status] += 1
            if status == "differs":
                strand["differs_on_minus_chain" if live[i].get("minus_chain") else "differs_on_plus_chain"] += 1
            strand["minus_chain_placements"] += bool(live[i].get("minus_chain"))
            for c in res["calls"]:
                calls[c["group"]][c["bucket"]] += 1
                calls[c["group"]]["raw_" + c["raw"]] += 1
                if c["live_call"] is not None and c["native_call"] is not None and c["live_call"] != c["native_call"]:
                    calls[c["group"]]["paired_ids_differ"] += 1
                if c["payload_differs"]:
                    calls[c["group"]]["payload_differs"] += 1
                if c["cause"]:
                    causes[(c["group"], c["cause"], c["bucket"])] += 1
                    cause_bp[(c["group"], c["cause"])] += c["bp"]
                    detail = {}
                    if c["payload_differs"]:
                        detail = {"live_payload": sorted(map(str, live[i]["payloads"][c["group"]][c["live_call"]])),
                                  "native_payload": sorted(map(str, native[j]["payloads"][c["group"]][c["native_call"]]))}
                    _example(examples, f"{c['group']}:{c['cause']}", idx, rec, live_call=c["live_call"],
                             native_call=c["native_call"],
                             live=c.get("live_parts", live[i]["calls"].get(c["group"], {}).get(c["live_call"], [])),
                             native=c.get("native_parts",
                                          native[j]["calls"].get(c["group"], {}).get(c["native_call"], [])),
                             bp=c["bp"], **detail)
                if c.get("holes"):
                    holes[(c["group"], "calls_max_hole_le_rejoin_bp" if max(c["holes"]) <= rejoin_bp
                           else "calls_max_hole_gt_rejoin_bp")] += 1
                    for h in c["holes"]:
                        holes[(c["group"], "holes_1bp" if h == 1 else "holes_2_5bp" if h <= 5
                               else "holes_6_49bp" if h < 50 else "holes_50bp_plus")] += 1
            for field, p in res["points"].items():
                points[field]["placements"] += 1
                points[field]["placements_identical" if p["identical"] else "placements_differ"] += 1
        # Per record: points over all placements (verdict), deam read from MD set apart.
        exempt = deam_exempt(live, native)
        for field in sorted({f for p in live + native for f in p["points"]}):
            res = compare_points([x for p in live for x in p["points"].get(field, ())],
                                 [x for p in native for x in p["points"].get(field, ())])
            status = "identical" if res["identical"] else "differs"
            if status == "differs" and field == "deam" and exempt:
                status = "deam_from_md"
            points[field]["records_" + status] += 1
            points[field]["shared"] += res["shared"]
            points[field]["live_only"] += len(res["live_only"])
            points[field]["native_only"] += len(res["native_only"])
            if status == "differs":
                if field in verdict_points:
                    points_same = False
                _example(examples, f"points:{field}", idx, rec, live_only=res["live_only"][:10],
                         native_only=res["native_only"][:10])
        # Per record: every call's parts over all placements (a call a split cuts compares whole).
        calls_known = True
        for c in compare_calls(union_placements(live), union_placements(native)):
            record_calls[c["group"]][c["bucket"]] += 1
            if c["payload_differs"]:
                record_calls[c["group"]]["payload_differs"] += 1
            if c["cause"]:
                record_causes[(c["group"], c["cause"], c["bucket"])] += 1
            if c["bucket"] != "identical":
                calls_same = False
                if c["cause"] in KNOWN_CAUSES and not c["payload_differs"]:
                    record_calls[c["group"]]["known"] += 1
                    known[c["cause"]] += 1
                else:
                    calls_known = False
        s["records_identical_placements"] += placements_same
        s["records_identical_calls"] += calls_same
        s["records_identical_calls_or_known"] += calls_same or calls_known
        s["records_with_known_differences"] += (not calls_same) and calls_known
        s["records_identical_points"] += points_same
        s["records_identical"] += placements_same and calls_same and points_same
        s["records_identical_or_known"] += placements_same and (calls_same or calls_known) and points_same
    return {"counts": dict(s), "calls": {g: dict(c) for g, c in sorted(calls.items())},
            "record_calls": {g: dict(c) for g, c in sorted(record_calls.items())},
            "causes": [{"group": g, "cause": c, "bucket": b, "n": n, "bp": cause_bp[(g, c)]}
                       for (g, c, b), n in sorted(causes.items())],
            "record_causes": [{"group": g, "cause": c, "bucket": b, "n": n}
                              for (g, c, b), n in sorted(record_causes.items())],
            "points": {f: dict(c) for f, c in sorted(points.items())},
            "connector_holes": {g: {k: n for (g2, k), n in sorted(holes.items()) if g2 == g}
                                for g in sorted({g for g, _k in holes})},
            "strand": dict(strand), "known_differences": dict(known), "examples": dict(examples)}


def _example(examples, kind, idx, rec, **detail):
    if len(examples[kind]) < MAX_EXAMPLES:
        contig, start = rec["key"][1], rec["key"][2]
        examples[kind].append({"record_index": idx, "source": f"{contig}:{start}", **detail})


# ── Row normalisation ───────────────────────────────────────────────────────

def _as_list(value) -> list:
    if value is None:
        return []
    return value.tolist() if hasattr(value, "tolist") else [list(v) if isinstance(v, (list, tuple)) else v
                                                            for v in value]


def _payloads(ivs, layer=None, top_qualities=None) -> list:
    """Per interval, what an analysis reads beside its geometry: the interval's
    own fields after the endpoints (size, FIRE score, ...), its quality/state
    bytes per named track (MA AQ: e.g. nfrvar 1 = open, 2 = closed) and its
    annotation name. Top-level qualities run parallel to the positive intervals."""
    out = []
    tracks, names, annotations = [], [], []
    if layer is not None:
        tracks = [_as_list(t) for t in (_as_list(layer.get("qualities")) or [])]
        names = list(layer.get("quality_names") or [])
        annotations = _as_list(layer.get("annotation_names"))
    positive = [k for k, iv in enumerate(ivs) if len(iv) > 2 and iv[2] > 0]
    top = _as_list(top_qualities)
    top_rank = {k: r for r, k in enumerate(positive)} if top and len(top) == len(positive) else {}
    for k, iv in enumerate(ivs):
        quals = tuple((names[t] if t < len(names) else str(t), int(track[k]))
                      for t, track in enumerate(tracks) if k < len(track))
        if k in top_rank:
            quals += (("q", int(top[top_rank[k]])),)
        # A missing name array and an empty name mean the same (no name): the parser omits an all-blank
        # array, while a split keeps blank entries of a layer whose other calls are named.
        name = (annotations[k] if k < len(annotations) else None) or None
        out.append((tuple(int(x) for x in iv[2:]), quals, name))
    return out


def _call_groups(row, live: bool) -> list:
    """``[(group, intervals, call ids, payloads)]`` of a row: top-level
    intervals, fire and each layer. Live rows keep ids in ``live_lift.calls``;
    native decodes in ``_fiberbrowser_calls`` (``[id, mol_start, mol_end]``)."""
    out = []
    top = _as_list(row.get("intervals"))
    fire = _as_list(row.get("fire"))
    layers = sorted((n, l) for n, l in (row.get("layers") or {}).items() if isinstance(l, dict))
    if live:
        ids = row["live_lift"].get("calls") or {}
        out.append(("intervals", top, ids.get("intervals") or [], _payloads(top, top_qualities=row.get("qualities"))))
        out.append(("fire", fire, ids.get("fire") or [], _payloads(fire)))
        for name, layer in layers:
            ivs = _as_list(layer.get("intervals"))
            out.append((f"layer:{name}", ivs, ids.get(f"layer:{name}") or [], _payloads(ivs, layer)))
    else:
        calls = row.get("_fiberbrowser_calls") or {}
        def ids_of(raw):
            return [c[0] if c else None for c in raw or []]
        top_ids = ids_of(calls.get("intervals"))
        out.append(("intervals", top, top_ids, _payloads(top, top_qualities=row.get("qualities"))))
        out.append(("fire", fire, ids_of(calls.get("fire")), _payloads(fire)))
        # Layers the decoder inferred from ns/nl (no MA layer) carry no call ids: they are the top-level
        # footprints split by size, so each takes its footprint's id (live lift's inference keeps them).
        by_extent = {(iv[0], iv[1]): cid for iv, cid in zip(top, top_ids) if cid is not None}
        for name, layer in layers:
            ivs = _as_list(layer.get("intervals"))
            ids = ids_of(layer.get("_fiberbrowser_calls"))
            if not any(ids) and name in ("nuc", "tf"):
                ids = [by_extent.get((iv[0], iv[1])) for iv in ivs]
            out.append((f"layer:{name}", ivs, ids, _payloads(ivs, layer)))
    return out


def lift_flipped(row) -> bool:
    """A lifted record whose strand the lift reversed: its ``Yp`` source strand
    differs from its own orientation (``read_strand.lift_flipped``)."""
    yp = parse_yp((row.get("lift") or {}).get("from"))
    if not yp or yp[2] not in ("+", "-"):
        return False
    return (yp[2] == "-") != (row.get("alignment_orientation") == "reverse")


def deam_events(events, base: int, flipped: bool) -> list:
    """Deamination events as ``(position, channel)`` (1 = C->T / Y, 0 = G->A / R)
    in the molecule frame: a lifted record whose strand the lift reversed
    decodes them in the target frame, so its channels swap back."""
    out = []
    for e in events:
        pos, channel = (int(e[0]), int(e[1])) if isinstance(e, (list, tuple)) and len(e) > 1 else (int(e), -1)
        if flipped and channel in (0, 1):
            channel = 1 - channel
        out.append((pos + base, channel))
    return out


TILING_MARK = "~"  # "intervals~gap", "intervals~neutral": a group's tiling rows, compared like calls


def tiling_units(live_parts, native_parts, connectors=()) -> list:
    """A group's gap (or neutral) rows from both sides cut into comparable
    units: connected stretches of either side's rows, joined across live
    connectors (live lift cuts a gap there; the lifted record holds one
    interval). Returns ``[(live parts, native parts)]`` per unit, in target order."""
    spans = sorted([(int(a), int(b), 0) for a, b in live_parts] + [(int(a), int(b), 1) for a, b in native_parts])
    units, end = [], None
    for a, b, side in spans:
        if end is not None and (a <= end or not subtract_spans([[end, a]], connectors)):
            end = max(end, b)
        else:
            units.append(([], []))
            end = b
        units[-1][side].append([a, b])
    return units


def placement(row, base: int, live: bool, contig: str) -> dict:
    """A row as a placement: absolute target geometry, calls ``{group:
    {call id: [[t0, t1], ...]}}`` (positive calls; zero-width markers kept),
    their payloads ``{group: {call id: set of payload tuples}}``, points
    (deamination with its channel, molecule frame), and for live rows the
    connectors and whether it is on a ``-`` chain."""
    calls, payloads, tiling = {}, {}, {}
    connectors = ([[a + base, b + base] for a, b in row["live_lift"].get("connectors") or ()] if live else [])
    for group, ivs, ids, pays in _call_groups(row, live):
        by_call, pay = {}, {}
        for k, iv in enumerate(ivs):
            if len(iv) > 2 and iv[2] <= 0:
                # Gap (inferred MSP / linker) and neutral rows: the measured tiling a scan counts too.
                kind = "gap" if iv[2] < 0 else "neutral"
                tiling.setdefault(f"{group}{TILING_MARK}{kind}", []).append([iv[0] + base, iv[1] + base])
                continue
            call = ids[k] if k < len(ids) and ids[k] is not None else f"<no id>:{iv[0] + base}-{iv[1] + base}"
            by_call.setdefault(str(call), []).append([iv[0] + base, iv[1] + base])
            pay.setdefault(str(call), set()).add(pays[k])
        if by_call:
            calls[group] = by_call
            payloads[group] = pay
    for group, parts in tiling.items():
        calls[group] = {"<tile>": parts}  # cut into units against the other side (tiling_units)
    points = {f: [int(x) + base for x in _as_list(row.get(f))] for f in POINT_FIELDS if row.get(f) is not None}
    flipped = False if live else lift_flipped(row)
    if row.get("deam") is not None:
        points["deam"] = deam_events(_as_list(row.get("deam")), base, flipped)
    out = {"contig": contig, "start": int(row["reference_start"]), "end": int(row["reference_end"]),
           "orientation": row.get("alignment_orientation"), "strand": row.get("strand"),
           "strand_inferred": bool(row.get("_fiberbrowser_inferred_strand")),
           "calls": calls, "payloads": payloads, "points": points, "lift_flipped": flipped}
    if live:
        ll = row["live_lift"]
        out["connectors"] = connectors
        out["insertions"] = sorted({int(bd[0]) + base for bd in ll.get("badges") or ()})
        out["badges"] = [[int(bd[0]) + base, int(bd[2])] for bd in ll.get("badges") or ()]
        out["supplementary"] = bool((ll.get("source") or {}).get("supplementary"))
        out["chains"] = sorted({int(seg[2]) for seg in ll.get("segments") or ()})
        out["minus_chain"] = any(seg[3] == "-" for seg in ll.get("segments") or ())
        out["segments"] = [[s[0] + base, s[1] + base, int(s[2])] for s in ll.get("segments") or ()]
        out["molecular"] = [[int(m[0]) + base, int(m[1]) + base, int(m[2]), int(m[3])]
                            for m in ll.get("molecular_spans") or ()]
    return out


def deam_source(read) -> str | None:
    """Where the loader takes a record's deamination events from, in its order
    (``compact_read_loader``): MM/ML 'mm', else IUPAC R/Y bases 'iupac', else,
    on a record without m6A/5mC calls, reference mismatches (MD) 'mismatch'."""
    from services.bam_tags import parse_daf_mismatches, parse_iupac_ry_positions, parse_mm_ml_tags_by_type

    whole = 1 << 40
    mm = parse_mm_ml_tags_by_type(read, 0, whole)
    if mm.get("deam"):
        return "mm"
    if parse_iupac_ry_positions(read, 0, whole):
        return "iupac"
    if not mm.get("m6a") and not mm.get("m5c") and parse_daf_mismatches(read, 0, whole):
        return "mismatch"
    return None


def attach_deam_sources(records, source_bam, lifted_bam, chrom) -> None:
    """``deam_source`` on every placement of a record that has deamination
    events on either side: the source record's for live placements, each
    lifted record's for native ones."""
    import pysam

    with pysam.AlignmentFile(source_bam) as src, pysam.AlignmentFile(lifted_bam) as lifted:
        for rec in records:
            if not any(p["points"].get("deam") for p in rec["live"] + rec["native"]):
                continue
            qname, contig, start = rec["key"]
            hit = next((r for r in src.fetch(contig, start, start + 1) if r.query_name == qname
                        and r.reference_start == start and not r.is_secondary), None)
            for p in rec["live"]:
                p["deam_source"] = deam_source(hit) if hit is not None else None
            for p in rec["native"]:
                hit = next((r for r in lifted.fetch(chrom, p["start"], p["start"] + 1)
                            if r.query_name == qname and r.reference_start == p["start"]
                            and parse_yp(r.get_tag("Yp") if r.has_tag("Yp") else None)[:2] == (contig, start)), None)
                p["deam_source"] = deam_source(hit) if hit is not None else None


def deam_exempt(live: list, native: list) -> bool:
    """Whether a record's deamination difference stays outside the verdict:
    every placement with events, on either side, read them from reference
    mismatches (they differ between assemblies by design). Events from MM
    tags or IUPAC R/Y bases, or of unknown origin, are always compared."""
    sources = [p.get("deam_source") for p in live + native if p["points"].get("deam")]
    return bool(sources) and all(src == "mismatch" for src in sources)


# ── Loading ─────────────────────────────────────────────────────────────────

def load_live(source_bam, map_path, chrom, start, end, settings, loader_options, budget=None):
    from services.lift import live_lift as ll
    from services.lift.cohort import prepare_lift_cohort

    handle = ll.open_lift_map(map_path)
    load = ll.load_lifted_rows(handle, [source_bam], chrom, start, end, haplotypes=handle.haplotypes,
                               settings=settings, dataset_id="parity", loader_options=dict(loader_options),
                               budget=budget)
    analysis = prepare_lift_cohort(load.rows, "analysis", settings)
    display = prepare_lift_cohort(load.rows, "display", settings)
    return handle, load, analysis, display


def load_native(lifted_bam, chrom, start, end, loader_options):
    from services.compact_read_loader import build_compact_reads_from_bam

    options = native_options(loader_options)
    # Live lift decodes its source without legacy layer inference and infers the layers after lifting
    # (compose reads infer_legacy_layers from the caller's options, default on): the lifted BAM infers them here.
    options["infer_legacy_layers"] = bool(loader_options.get("infer_legacy_layers", True))
    return build_compact_reads_from_bam(lifted_bam, chrom, start, end, include_supplementary=True, **options)


def native_options(loader_options) -> dict:
    """The loader options of a native decode (record scoped like live lift's source decode). Live lift's
    source decode skips the terminal-gap filter (``terminal_gap_threshold=0``) because compose applies it
    to each lifted record; a native decode of a lifted BAM applies it itself, with the caller's threshold."""
    from services.lift.live_lift import _FIXED_LOADER_OPTIONS

    options = dict(loader_options, **_FIXED_LOADER_OPTIONS)
    options["terminal_gap_threshold"] = loader_options.get("terminal_gap_threshold", 500)
    return options


def decoded(bam_path, contig, start, qname, loader_options) -> bool:
    """Whether the loader keeps the record ``(qname, contig, start)`` with these options."""
    from services.compact_read_loader import build_compact_reads_from_bam

    options = native_options(loader_options)
    reads = build_compact_reads_from_bam(bam_path, contig, start, start + 1, include_supplementary=True, **options)
    return any(r["id"] == qname and int(r["reference_start"]) == start for r in reads)


def split_blocks(p: dict, g_split: int) -> list:
    """A live row cut into lifted records. Annotated segments are the composer's record runs, including
    collinear chain joins and read-gap splits. Preserve these boundaries; older, unannotated segments
    fall back to target-gap grouping. Each placement keeps its calls, points and map edits."""
    segs = sorted(p.get("segments") or [[p["start"], p["end"]]])

    blocks = []
    for seg in segs:
        a, b = seg[0], seg[1]
        if blocks:
            last = blocks[-1]
            joins = len(seg) == 2 and last[2] is None and a - last[1] < g_split
            if joins:
                last[1], last[2] = max(last[1], b), (seg[2] if len(seg) > 2 else None)
                continue
        blocks.append([a, b, seg[2] if len(seg) > 2 else None])
    if len(blocks) < 2:
        return [p]
    out = []
    for a, b, _chain in blocks:
        def inside(x0, x1):
            return (x0 < b and x1 > a) or (x0 == x1 and a <= x0 <= b)
        q = dict(p, start=a, end=b, segments=[s for s in segs if s[0] < b and s[1] > a],
                 molecular=[m for m in p.get("molecular") or () if m[0] < b and m[1] > a])
        q["calls"] = {}
        for group, by_call in p["calls"].items():
            kept = {c: [pt for pt in parts if inside(*pt)] for c, parts in by_call.items()}
            kept = {c: parts for c, parts in kept.items() if parts}
            if kept:
                q["calls"][group] = kept
        q["points"] = {f: [x for x in xs if a <= (x[0] if isinstance(x, tuple) else x) < b]
                       for f, xs in p["points"].items()}
        q["connectors"] = [c for c in p.get("connectors", ()) if c[0] < b and c[1] > a]
        q["insertions"] = [x for x in p.get("insertions", ()) if a <= x <= b]
        q["badges"] = [x for x in p.get("badges", ()) if a <= x[0] <= b]
        out.append(q)
    return out


def source_cuts_in_target(handle, contig, cuts, chains) -> list:
    """The source record's deletion cuts (source ``[d0, d1)``) in the target frame through the map's pieces of
    ``chains``: from after the target base of ``d0 - 1`` to the target base of ``d1`` (either order)."""
    out = []
    for d0, d1 in cuts:
        ends = []
        for x in (d0 - 1, d1):
            with handle.lock:
                pieces = handle.map.source_to_target(contig, x, x + 1)
            hit = next(((p.t_end - 1 - (x - p.q_start)) if p.strand == "-" else (p.t_start + (x - p.q_start))
                        for p in pieces if p.chain in chains and p.q_start <= x < p.q_end), None)
            ends.append(hit)
        if None not in ends:
            a, b = ends
            lo, hi = (a + 1, b) if b > a else (b + 1, a)
        else:  # a flank in a source-only stretch: the deleted bases the map places
            with handle.lock:
                pieces = handle.map.source_to_target(contig, d0, d1)
            spans = []
            for p in pieces:
                s, e = max(d0, p.q_start), min(d1, p.q_end)
                if p.chain in chains and e > s:
                    spans.append((p.t_end - (e - p.q_start), p.t_end - (s - p.q_start)) if p.strand == "-"
                                 else (p.t_start + (s - p.q_start), p.t_start + (e - p.q_start)))
            if not spans:
                continue
            lo, hi = min(x for x, _y in spans), max(y for _x, y in spans)
        if hi > lo:
            out.append([lo, hi])
    return out


def attach_required_cuts(records, source_bam, handle, min_len: int) -> None:
    """``required_cuts`` on the native placements of every record with indel events: the source record's
    own deletion cuts (``sv_events.read_deletion_cuts``) in the target frame (live lift makes them too)."""
    import pysam
    from services.sv_events import read_deletion_cuts

    with pysam.AlignmentFile(source_bam) as src:
        for rec in records:
            if not any(p.get("sv_events") for p in rec["native"]):
                continue
            qname, contig, start = rec["key"]
            hit = next((r for r in src.fetch(contig, start, start + 1) if r.query_name == qname
                        and r.reference_start == start and not r.is_secondary), None)
            if hit is None:
                continue
            chains = {c for p in rec["live"] for c in p.get("chains", ())}
            cuts = source_cuts_in_target(handle, contig, read_deletion_cuts(hit, min_len), chains)
            for p in rec["native"]:
                p["required_cuts"] = cuts


def lifted_sv_events(lifted_bam, chrom, start, end, loader_options) -> dict:
    """``{(qname, source contig, source start, target start): record_sv_events}`` of the lifted records."""
    import pysam
    from services.sv_events import SV_MIN_LEN_DEFAULT

    min_len = int(loader_options.get("sv_min_len") or SV_MIN_LEN_DEFAULT)
    out = {}
    with pysam.AlignmentFile(lifted_bam) as bam:
        for rec in bam.fetch(chrom, start, end):
            yp = parse_yp(rec.get_tag("Yp") if rec.has_tag("Yp") else None)
            if yp is not None and not rec.is_secondary:
                out[(rec.query_name, yp[0], yp[1], int(rec.reference_start))] = record_sv_events(rec, min_len)
    return out


def lifted_bam_census(lifted_bam, chrom, start, end) -> dict:
    """What the loader never shows: secondary (0x100) and unmapped records."""
    import pysam

    out = collections.Counter()
    with pysam.AlignmentFile(lifted_bam) as bam:
        for rec in bam.fetch(chrom, start, end):
            out["records"] += 1
            out["supplementary"] += rec.is_supplementary
            out["secondary"] += rec.is_secondary
            out["reverse"] += rec.is_reverse
            out["with_md"] += rec.has_tag("MD")
    return dict(out)


def unlifted_reasons(path) -> dict:
    """``{(qname, contig, start0): reason}`` of fiberhmm-lift's ``--unlifted`` BAM."""
    return {key: reason for key, (reason, _primary) in unlifted_records(path).items()}


def unlifted_records(path) -> dict:
    """``{(qname, contig, start0): (reason, is primary)}`` of fiberhmm-lift's ``--unlifted`` BAM."""
    import pysam

    out = {}
    if not path:
        return out
    with pysam.AlignmentFile(path, check_sq=False) as bam:
        for rec in bam.fetch(until_eof=True):
            out[(rec.query_name, rec.reference_name, rec.reference_start)] = (
                rec.get_tag("Yu") if rec.has_tag("Yu") else "unlifted",
                not (rec.is_supplementary or rec.is_secondary))
    return out


def lifted_qnames(path) -> set:
    """Every QNAME of the lifted BAM, whatever its contig (an orphan's molecule has none)."""
    import pysam

    with pysam.AlignmentFile(path) as bam:
        return {rec.query_name for rec in bam.fetch(until_eof=True)}


def is_orphan_supplementary(key, live_placements, unlifted: dict, lifted_names: set) -> bool:
    """Whether a live-only source record is an orphan supplementary fiberhmm-lift drops (cause 9): every
    live placement of it is a source supplementary, its molecule's primary record is in the unlifted BAM,
    and the lifted BAM has no record of that molecule at all."""
    return (bool(live_placements) and all(p.get("supplementary") for p in live_placements)
            and any(q == key[0] and primary for (q, *_rest), (_reason, primary) in unlifted.items())
            and key[0] not in lifted_names)


# ── Run ─────────────────────────────────────────────────────────────────────

def run(args) -> dict:
    t0 = time.time()
    scratch_env()
    from services.lift import live_lift as ll

    chrom, start, end = parse_region(args.region)
    settings = ll.LiftSettings()
    loader_options = dict(include_methylation=True)
    if args.show_terminal_gaps:
        loader_options["hide_terminal_gaps"] = False
    budget = None
    if args.no_budget:  # the view budgets refuse or truncate large windows; they do not change what a row holds
        ll.MAX_WINDOWS, ll.MIN_SOURCE_BP_BUDGET = 10**6, 10**12
        budget = ll.LoadBudget(max_records=10**9, max_bytes=10**13)
    handle, load, analysis, display = load_live(args.source_bam, args.map, chrom, start, end, settings,
                                                loader_options, budget)
    sel0, sel1 = load.region_start, load.region_end
    width = sel1 - sel0
    native_reads = load_native(args.lifted_bam, chrom, sel0, sel1, loader_options)

    live_by, native_by = collections.defaultdict(list), collections.defaultdict(list)
    live_records = collections.defaultdict(set)
    edge = set()
    for row in analysis.rows:
        src = row["live_lift"]["source"]
        key = (row["id"], src["contig"], int(src["start"]))
        live_records[key].add(str(row["live_lift"]["record"]))
        segs = row["live_lift"].get("segments") or ()
        if any(s[0] <= 0 or s[1] >= width for s in segs):
            edge.add(key)
        live_by[key] += split_blocks(placement(row, sel0, True, chrom), settings.g_split)
    no_yp = 0
    events = lifted_sv_events(args.lifted_bam, chrom, sel0, sel1, loader_options)
    for read in native_reads:
        yp = parse_yp((read.get("lift") or {}).get("from"))
        if yp is None:
            no_yp += 1
            continue
        key = (read["id"], yp[0], yp[1])
        if int(read["reference_start"]) < sel0 or int(read["reference_end"]) > sel1:
            edge.add(key)
        p = placement(read, sel0, False, chrom)
        p["sv_events"] = events.get((read["id"], yp[0], yp[1], int(read["reference_start"])), [])
        p["sv_min_len"] = int(loader_options.get("sv_min_len") or 50)
        native_by[key].append(p)

    unlifted_full = unlifted_records(args.unlifted_bam)
    unlifted = {key: reason for key, (reason, _primary) in unlifted_full.items()}
    lifted_names = None
    keys = sorted(set(live_by) | set(native_by))
    ambiguous = find_ambiguous(live_records, source_record_counts(args.source_bam, keys))
    records, one_side_keys, n_edge, n_ambiguous = join_records(live_by, native_by, edge, ambiguous)
    one_side = collections.Counter()
    one_side_examples = []
    for key, side in one_side_keys:
        cause = "unknown"
        if side == "live_only":
            if key in unlifted:
                cause = f"unlifted:{unlifted[key]}"
            else:
                lifted_names = lifted_names if lifted_names is not None else lifted_qnames(args.lifted_bam)
                if is_orphan_supplementary(key, live_by.get(key, ()), unlifted_full, lifted_names):
                    cause = "orphan_supplementary_dropped"
        elif load.truncated:
            cause = "live_load_truncated"
        elif (loader_options.get("hide_terminal_gaps", True)
              and not decoded(args.source_bam, key[1], key[2], key[0], loader_options)
              and decoded(args.source_bam, key[1], key[2], key[0], dict(loader_options, hide_terminal_gaps=False))):
            # The source record decodes only with terminal gaps shown: the loader's whole-record
            # terminal-gap filter dropped it in the source frame, where its ends differ from the lifted
            # record's (a liftbam split, or ends soft-clipped on the lifted record).
            cause = "terminal_gap_filter"
        one_side[(side, cause)] += 1
        if len(one_side_examples) < MAX_EXAMPLES:
            one_side_examples.append({"side": side, "cause": cause, "source": f"{key[1]}:{key[2]}"})

    census = lifted_bam_census(args.lifted_bam, chrom, sel0, sel1)
    attach_deam_sources(records, args.source_bam, args.lifted_bam, chrom)
    attach_required_cuts(records, args.source_bam, handle, int(loader_options.get("sv_min_len") or 50))
    summary = summarize(records, rejoin_bp=settings.rejoin_bp)
    display_ids = {r["analysis_id"] for r in display.rows}
    analysis_ids = {r["analysis_id"] for r in analysis.rows}
    result = {
        "inputs": {"region": [chrom, start, end], "selection": [chrom, sel0, sel1],
                   "source_bam": os.path.basename(args.source_bam), "lifted_bam": os.path.basename(args.lifted_bam),
                   "map": os.path.basename(args.map), "settings": settings.as_dict(),
                   "loader_options": loader_options, "tolerance_bp": TOLERANCE_BP},
        "live": {"rows_loaded": len(load.rows), "analysis_rows": len(analysis.rows),
                 "display_rows": len(display.rows), "display_equals_analysis": display_ids == analysis_ids,
                 "analysis_description": analysis.description,
                 "load_counts": {k: v for k, v in load.counts.items() if isinstance(v, (int, float, bool))},
                 "minus_chain_rows": sum(any(s[3] == "-" for s in r["live_lift"]["segments"]) for r in analysis.rows),
                 "supplementary_rows": sum(bool(r["live_lift"]["source"].get("supplementary")) for r in analysis.rows),
                 "source_records": len(live_by)},
        "native": {"rows_loaded": len(native_reads), "rows_without_yp": no_yp, "source_records": len(native_by),
                   "census": census},
        "join": {"source_records_either_side": len(keys), "edge_excluded": n_edge,
                 "ambiguous_source_keys": n_ambiguous,
                 "one_side_only": [{"side": s, "cause": c, "n": n} for (s, c), n in sorted(one_side.items())],
                 "one_side_examples": one_side_examples},
        **summary,
        "cause_notes": CALL_CAUSES,
        "seconds": round(time.time() - t0, 1),
    }
    result["verdict"] = verdict(result)
    return result


def verdict(result) -> str:
    """PASS only when no record is on one side only and every compared record
    has identical placements, identical call bases (per record, every call
    over all its placements) and identical points and ``st`` (both in the
    molecule frame). Ambiguous source keys and a truncated live load fail it."""
    c = result["counts"]
    n = c.get("records_compared", 0)
    problems = []
    for key, what, note in (("records_identical_placements", "placements", ""),
                            ("records_identical_calls_or_known", "call bases", " (outside the known categories)"),
                            ("records_identical_points", "points", "")):
        if c.get(key, 0) != n:
            problems.append(f"{what} differ on {n - c.get(key, 0)} of {n} records{note}")
    unknown_side = [x for x in result["join"]["one_side_only"] if x["cause"] not in KNOWN_ONE_SIDE]
    if unknown_side:
        problems.append(f"{sum(x['n'] for x in unknown_side)} records on one side only")
    if result.get("live", {}).get("load_counts", {}).get("truncated"):
        problems.append("the live load was truncated by its budget (rerun on a smaller window or with --no-budget)")
    if result["join"].get("ambiguous_source_keys"):
        problems.append(f"{result['join']['ambiguous_source_keys']} ambiguous source keys (two records share QNAME, "
                        "source contig and start) were not compared")
    if result.get("strand", {}).get("differs"):
        problems.append(f"st differs on {result['strand']['differs']} placements (molecule frame)")
    if problems:
        return "FAIL: " + "; ".join(problems)
    known = [f"{n} {cause}" for cause, n in sorted(result.get("known_differences", {}).items())]
    known += [f"{x['n']} {x['side']} {x['cause']}" for x in result["join"]["one_side_only"]]
    return "PASS" + (f" (known: {', '.join(known)})" if known else "")


def markdown(result) -> str:
    c = result["counts"]
    lines = [f"# Live lift vs fiberhmm-lift: {result['inputs']['region'][0]}:{result['inputs']['region'][1]}-"
             f"{result['inputs']['region'][2]}", "",
             f"Verdict: **{result['verdict']}**", "",
             f"Selection (view plus margin, both sides): {result['inputs']['selection']}", "",
             "| records | n |", "|---|---|"]
    for k in ("records_compared", "records_identical", "records_identical_or_known", "records_identical_placements",
              "records_identical_calls", "records_identical_calls_or_known", "records_with_known_differences",
              "records_identical_points", "records_split_live", "records_split_native",
              "records_placement_count_differs", "placements_live", "placements_native",
              "placements_identical_geometry"):
        lines.append(f"| {k} | {c.get(k, 0)} |")
    lines.append(f"| edge_excluded | {result['join']['edge_excluded']} |")
    lines.append(f"| ambiguous_source_keys (not compared) | {result['join'].get('ambiguous_source_keys', 0)} |")
    for x in result["join"]["one_side_only"]:
        lines.append(f"| {x['side']} ({x['cause']}) | {x['n']} |")
    for title, table in (("calls per placement", result["calls"]), ("calls per record", result["record_calls"])):
        lines += ["", f"| {title} | identical | within 10 bp | different | raw identical | raw same bases | "
                  "paired, ids differ | payload differs |", "|---|---|---|---|---|---|---|---|"]
        for g, b in table.items():
            lines.append(f"| {g} | {b.get('identical', 0)} | {b.get('within_10bp', 0)} | {b.get('different', 0)} | "
                         f"{b.get('raw_identical', '')} | {b.get('raw_same_bases', '')} | "
                         f"{b.get('paired_ids_differ', '')} | {b.get('payload_differs', '')} |")
    lines += ["", "| points per record | identical | differ | deam_from_md | positions shared | live only | "
              "native only |", "|---|---|---|---|---|---|---|"]
    for f, p in result["points"].items():
        lines.append(f"| {f} | {p.get('records_identical', 0)} | {p.get('records_differs', 0)} | "
                     f"{p.get('records_deam_from_md', 0)} | {p.get('shared', 0)} | {p.get('live_only', 0)} | "
                     f"{p.get('native_only', 0)} |")
    lines += ["", "| group | cause (per placement) | bucket | calls | bp |", "|---|---|---|---|---|"]
    for x in result["causes"]:
        lines.append(f"| {x['group']} | {x['cause']} | {x['bucket']} | {x['n']} | {x['bp']} |")
    lines += ["", "| group | connector holes |", "|---|---|"]
    for g, h in result.get("connector_holes", {}).items():
        lines.append(f"| {g} | {', '.join(f'{k}={v}' for k, v in h.items())} |")
    lines += ["", f"Known differences (calls and gaps per record): {result.get('known_differences', {})}", ""]
    lines += ["", f"Strand (st) per placement: {result['strand']}", ""]
    return "\n".join(lines)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--source-bam", required=True, help="BAM aligned to the source assembly (live lift's input)")
    p.add_argument("--lifted-bam", required=True, help="fiberhmm-lift output for the same BAM (indexed)")
    p.add_argument("--map", required=True, help="graphlift sidecar manifest (X.chain.graphlift.json)")
    p.add_argument("--region", required=True, help="target window chrom:start-end")
    p.add_argument("--unlifted-bam", help="fiberhmm-lift --unlifted output: names the cause of records "
                                          "only live lift has")
    p.add_argument("--out-json", required=True)
    p.add_argument("--out-md")
    p.add_argument("--show-terminal-gaps", action="store_true",
                   help="decode with hide_terminal_gaps off on both sides (the loader then keeps records whose "
                        "first or last call is far from the alignment end)")
    p.add_argument("--no-budget", action="store_true",
                   help="lift windows larger than a browser view (raises the view's source-window budgets)")
    args = p.parse_args(argv)
    result = run(args)
    with open(args.out_json, "w") as fh:
        json.dump(result, fh, indent=1, default=str)
    if args.out_md:
        with open(args.out_md, "w") as fh:
            fh.write(markdown(result))
    print(markdown(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
