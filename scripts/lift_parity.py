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
A source record whose rows touch the selection edge on either side is left
out and counted.

Per source record: placements (target contig, start, end, orientation),
the molecule strand (``st``), every call interval per call group
(``intervals``, ``fire`` and each MA layer) per call id, and m6A/5mC
positions. Calls are compared two ways:

- raw geometry, the parts as the rows deliver them;
- bases: per call id, the merged target bases (zero-width insertion
  markers kept as positions). Buckets: identical, within 10 bp (hull ends
  within 10 bp and at most 10 bp in the symmetric difference), different.

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
    "native_only": "the call is only on the lifted record",
    "live_only": "the call is only on the live-lift row",
    "other": "unclassified (see the examples)",
}
# Point fields a parity verdict needs equal. deam on a record without m6A/5mC calls is read from mismatches
# against the record's own reference (MD), so it differs between assemblies by design; see deam_from_md.
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


def classify_call(live, native, connectors=(), insertions=(), tolerance=TOLERANCE_BP) -> dict:
    """One call on one placement. ``live``/``native``: its parts ``[t0, t1]``
    (absolute target, zero-width = insertion marker); ``connectors``: the live
    row's target gaps ``[a, b)``; ``insertions``: target positions of its
    insertion badges (source bases with no target base). Returns ``{raw,
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


def compare_calls(lp: dict, np_: dict, tolerance=TOLERANCE_BP) -> list:
    out = []
    for group in sorted(set(lp["calls"]) | set(np_["calls"])):
        lc, nc = lp["calls"].get(group, {}), np_["calls"].get(group, {})
        for call in sorted(set(lc) | set(nc), key=str):
            res = classify_call(lc.get(call, []), nc.get(call, []), lp.get("connectors", ()),
                                lp.get("insertions", ()), tolerance)
            res.update(group=group, call=call)
            out.append(res)
    return out


def union_placements(placements: list) -> dict:
    """One record's placements as one: every call's parts and the connectors
    and insertions of all of them (a call a split cuts compares whole)."""
    calls = collections.defaultdict(lambda: collections.defaultdict(list))
    for p in placements:
        for group, by_call in p["calls"].items():
            for call, parts in by_call.items():
                calls[group][call] += parts
    return {"calls": {g: dict(c) for g, c in calls.items()},
            "connectors": [c for p in placements for c in p.get("connectors", ())],
            "insertions": [x for p in placements for x in p.get("insertions", ())]}


def strand_status(lp: dict, np_: dict) -> str:
    """The molecule strand (``st``) of a placement pair: 'absent', 'inferred'
    (either side guessed it from marks), 'same', 'frame_flip' (differs on a
    ``-`` chain: the accepted molecule-frame difference) or 'differs'."""
    ls_, ns_ = lp.get("strand"), np_.get("strand")
    if ls_ is None and ns_ is None:
        return "absent"
    if lp.get("strand_inferred") or np_.get("strand_inferred"):
        return "inferred"
    if ls_ == ns_:
        return "same"
    return "frame_flip" if lp.get("minus_chain") else "differs"


def summarize(records: list, deam_from_md: bool = False, verdict_points=VERDICT_POINTS, rejoin_bp: int = 5) -> dict:
    """Counts over ``[{key, live: [placement], native: [placement]}]`` records.
    ``deam_from_md``: the lifted BAM has no MD, so deam a record reads from
    mismatches (no m6A/5mC calls) cannot be compared; such differences count
    as ``deam_from_md``, outside the verdict."""
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
            strand[strand_status(live[i], native[j])] += 1
            strand["minus_chain_placements"] += bool(live[i].get("minus_chain"))
            for c in res["calls"]:
                calls[c["group"]][c["bucket"]] += 1
                calls[c["group"]]["raw_" + c["raw"]] += 1
                if c["cause"]:
                    causes[(c["group"], c["cause"], c["bucket"])] += 1
                    cause_bp[(c["group"], c["cause"])] += c["bp"]
                    _example(examples, f"{c['group']}:{c['cause']}", idx, rec, call=c["call"],
                             live=live[i]["calls"].get(c["group"], {}).get(c["call"], []),
                             native=native[j]["calls"].get(c["group"], {}).get(c["call"], []), bp=c["bp"])
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
        has_methyl = any(p["points"].get("methyl_m6a") or p["points"].get("methyl_m5c") for p in live)
        for field in sorted({f for p in live + native for f in p["points"]}):
            res = compare_points([x for p in live for x in p["points"].get(field, ())],
                                 [x for p in native for x in p["points"].get(field, ())])
            status = "identical" if res["identical"] else "differs"
            if status == "differs" and field == "deam" and deam_from_md and not has_methyl:
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
        for c in compare_calls(union_placements(live), union_placements(native)):
            record_calls[c["group"]][c["bucket"]] += 1
            if c["cause"]:
                record_causes[(c["group"], c["cause"], c["bucket"])] += 1
            if c["bucket"] != "identical":
                calls_same = False
        s["records_identical_placements"] += placements_same
        s["records_identical_calls"] += calls_same
        s["records_identical_points"] += points_same
        s["records_identical"] += placements_same and calls_same and points_same
    return {"counts": dict(s), "calls": {g: dict(c) for g, c in sorted(calls.items())},
            "record_calls": {g: dict(c) for g, c in sorted(record_calls.items())},
            "causes": [{"group": g, "cause": c, "bucket": b, "n": n, "bp": cause_bp[(g, c)]}
                       for (g, c, b), n in sorted(causes.items())],
            "record_causes": [{"group": g, "cause": c, "bucket": b, "n": n}
                              for (g, c, b), n in sorted(record_causes.items())],
            "points": {f: dict(c) for f, c in sorted(points.items())},
            "connector_holes": {g: {k: n for (g2, k), n in sorted(holes.items()) if g2 == g}
                                for g in sorted({g for g, _k in holes})},
            "strand": dict(strand), "examples": dict(examples)}


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


def _call_groups(row, live: bool) -> list:
    """``[(group, intervals, call ids)]`` of a row: top-level intervals, fire
    and each layer. Live rows keep ids in ``live_lift.calls``; native decodes
    in ``_fiberbrowser_calls`` (``[id, mol_start, mol_end]``)."""
    out = []
    if live:
        ids = row["live_lift"].get("calls") or {}
        out.append(("intervals", _as_list(row.get("intervals")), ids.get("intervals") or []))
        out.append(("fire", _as_list(row.get("fire")), ids.get("fire") or []))
        for name, layer in sorted((row.get("layers") or {}).items()):
            if isinstance(layer, dict):
                out.append((f"layer:{name}", _as_list(layer.get("intervals")), ids.get(f"layer:{name}") or []))
    else:
        calls = row.get("_fiberbrowser_calls") or {}
        def ids_of(raw):
            return [c[0] if c else None for c in raw or []]
        top = _as_list(row.get("intervals"))
        top_ids = ids_of(calls.get("intervals"))
        out.append(("intervals", top, top_ids))
        out.append(("fire", _as_list(row.get("fire")), ids_of(calls.get("fire"))))
        # Layers the decoder inferred from ns/nl (no MA layer) carry no call ids: they are the top-level
        # footprints split by size, so each takes its footprint's id (live lift's inference keeps them).
        by_extent = {(iv[0], iv[1]): cid for iv, cid in zip(top, top_ids) if cid is not None}
        for name, layer in sorted((row.get("layers") or {}).items()):
            if isinstance(layer, dict):
                ivs = _as_list(layer.get("intervals"))
                ids = ids_of(layer.get("_fiberbrowser_calls"))
                if not any(ids) and name in ("nuc", "tf"):
                    ids = [by_extent.get((iv[0], iv[1])) for iv in ivs]
                out.append((f"layer:{name}", ivs, ids))
    return out


def placement(row, base: int, live: bool, contig: str) -> dict:
    """A row as a placement: absolute target geometry, calls ``{group:
    {call id: [[t0, t1], ...]}}`` (positive calls; zero-width markers kept),
    points, and for live rows the connectors and whether it is on a ``-``
    chain."""
    calls = {}
    for group, ivs, ids in _call_groups(row, live):
        by_call = {}
        for k, iv in enumerate(ivs):
            if len(iv) > 2 and iv[2] <= 0:
                continue  # gaps and neutral rows: derived, not calls
            call = ids[k] if k < len(ids) and ids[k] is not None else "<no id>"
            by_call.setdefault(str(call), []).append([iv[0] + base, iv[1] + base])
        if by_call:
            calls[group] = by_call
    points = {f: [int(x) + base for x in _as_list(row.get(f))] for f in POINT_FIELDS if row.get(f) is not None}
    if row.get("deam") is not None:
        points["deam"] = [int(e[0]) + base for e in _as_list(row.get("deam"))]
    out = {"contig": contig, "start": int(row["reference_start"]), "end": int(row["reference_end"]),
           "orientation": row.get("alignment_orientation"), "strand": row.get("strand"),
           "strand_inferred": bool(row.get("_fiberbrowser_inferred_strand")),
           "calls": calls, "points": points}
    if live:
        ll = row["live_lift"]
        out["connectors"] = [[a + base, b + base] for a, b in ll.get("connectors") or ()]
        out["insertions"] = sorted({int(bd[0]) + base for bd in ll.get("badges") or ()})
        out["minus_chain"] = any(seg[3] == "-" for seg in ll.get("segments") or ())
        out["segments"] = [[s[0] + base, s[1] + base] for s in ll.get("segments") or ()]
    return out


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
    from services.lift.live_lift import _FIXED_LOADER_OPTIONS

    options = dict(loader_options, **_FIXED_LOADER_OPTIONS)
    # Live lift decodes its source without legacy layer inference and infers the layers after lifting
    # (compose reads infer_legacy_layers from the caller's options, default on): the lifted BAM infers them here.
    options["infer_legacy_layers"] = bool(loader_options.get("infer_legacy_layers", True))
    return build_compact_reads_from_bam(lifted_bam, chrom, start, end, include_supplementary=True, **options)


def decoded(bam_path, contig, start, qname, loader_options) -> bool:
    """Whether the loader keeps the record ``(qname, contig, start)`` with these options."""
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.lift.live_lift import _FIXED_LOADER_OPTIONS

    options = dict(loader_options, **_FIXED_LOADER_OPTIONS)
    reads = build_compact_reads_from_bam(bam_path, contig, start, start + 1, include_supplementary=True, **options)
    return any(r["id"] == qname and int(r["reference_start"]) == start for r in reads)


def split_blocks(p: dict, g_split: int) -> list:
    """A live placement cut where its segments leave a target gap of at least
    ``g_split`` (live lift keeps such runs on one row; liftbam writes them as
    separate records): one placement per block, with its calls, points,
    connectors and insertions."""
    segs = sorted(p.get("segments") or [[p["start"], p["end"]]])
    blocks = []
    for a, b in segs:
        if blocks and a - blocks[-1][1] < g_split:
            blocks[-1][1] = max(blocks[-1][1], b)
        else:
            blocks.append([a, b])
    if len(blocks) < 2:
        return [p]
    out = []
    for a, b in blocks:
        def inside(x0, x1):
            return (x0 < b and x1 > a) or (x0 == x1 and a <= x0 <= b)
        q = dict(p, start=a, end=b, segments=[s for s in segs if s[0] < b and s[1] > a])
        q["calls"] = {}
        for group, by_call in p["calls"].items():
            kept = {c: [pt for pt in parts if inside(*pt)] for c, parts in by_call.items()}
            kept = {c: parts for c, parts in kept.items() if parts}
            if kept:
                q["calls"][group] = kept
        q["points"] = {f: [x for x in xs if a <= x < b] for f, xs in p["points"].items()}
        q["connectors"] = [c for c in p.get("connectors", ()) if c[0] < b and c[1] > a]
        q["insertions"] = [x for x in p.get("insertions", ()) if a <= x <= b]
        out.append(q)
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
    import pysam

    out = {}
    if not path:
        return out
    with pysam.AlignmentFile(path, check_sq=False) as bam:
        for rec in bam.fetch(until_eof=True):
            out[(rec.query_name, rec.reference_name, rec.reference_start)] = (
                rec.get_tag("Yu") if rec.has_tag("Yu") else "unlifted")
    return out


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
    edge = set()
    for row in analysis.rows:
        src = row["live_lift"]["source"]
        key = (row["id"], src["contig"], int(src["start"]))
        segs = row["live_lift"].get("segments") or ()
        if any(s[0] <= 0 or s[1] >= width for s in segs):
            edge.add(key)
        live_by[key] += split_blocks(placement(row, sel0, True, chrom), settings.g_split)
    no_yp = 0
    for read in native_reads:
        yp = parse_yp((read.get("lift") or {}).get("from"))
        if yp is None:
            no_yp += 1
            continue
        key = (read["id"], yp[0], yp[1])
        if int(read["reference_start"]) < sel0 or int(read["reference_end"]) > sel1:
            edge.add(key)
        native_by[key].append(placement(read, sel0, False, chrom))

    unlifted = unlifted_reasons(args.unlifted_bam)
    keys = sorted(set(live_by) | set(native_by))
    one_side = collections.Counter()
    one_side_examples = []
    records = []
    native_qnames = {k[0] for k in native_by}
    for key in keys:
        if key in edge:
            continue
        if key not in native_by or key not in live_by:
            side = "live_only" if key in live_by else "native_only"
            cause = "unknown"
            if side == "live_only":
                if key in unlifted:
                    cause = f"unlifted:{unlifted[key]}"
                elif any(q == key[0] for q, *_ in unlifted) and key[0] not in native_qnames:
                    cause = "orphan_supplementary_dropped"
            elif load.truncated:
                cause = "live_load_truncated"
            elif (loader_options.get("hide_terminal_gaps", True)
                  and not decoded(args.source_bam, key[1], key[2], key[0], loader_options)
                  and decoded(args.source_bam, key[1], key[2], key[0],
                              dict(loader_options, hide_terminal_gaps=False))):
                # The source record decodes only with terminal gaps shown: the loader's whole-record
                # terminal-gap filter dropped it in the source frame, where its ends differ from the lifted
                # record's (a liftbam split, or ends soft-clipped on the lifted record).
                cause = "terminal_gap_filter"
            one_side[(side, cause)] += 1
            if len(one_side_examples) < MAX_EXAMPLES:
                one_side_examples.append({"side": side, "cause": cause, "source": f"{key[1]}:{key[2]}"})
            continue
        records.append({"key": key, "live": live_by[key], "native": native_by[key]})

    census = lifted_bam_census(args.lifted_bam, chrom, sel0, sel1)
    summary = summarize(records, deam_from_md=census.get("with_md", 0) == 0, rejoin_bp=settings.rejoin_bp)
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
        "join": {"source_records_either_side": len(keys), "edge_excluded": len(edge & set(keys)),
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
    over all its placements) and identical points; ``st`` may differ only on
    ``-`` chains (the accepted molecule-frame difference)."""
    c = result["counts"]
    n = c.get("records_compared", 0)
    problems = []
    for key, what in (("records_identical_placements", "placements"), ("records_identical_calls", "call bases"),
                      ("records_identical_points", "points")):
        if c.get(key, 0) != n:
            problems.append(f"{what} differ on {n - c.get(key, 0)} of {n} records")
    if result["join"]["one_side_only"]:
        problems.append(f"{sum(x['n'] for x in result['join']['one_side_only'])} records on one side only")
    if result.get("live", {}).get("load_counts", {}).get("truncated"):
        problems.append("the live load was truncated by its budget (rerun on a smaller window or with --no-budget)")
    if result.get("strand", {}).get("differs"):
        problems.append(f"st differs on {result['strand']['differs']} placements on + chains")
    return "PASS" if not problems else "FAIL: " + "; ".join(problems)


def markdown(result) -> str:
    c = result["counts"]
    lines = [f"# Live lift vs fiberhmm-lift: {result['inputs']['region'][0]}:{result['inputs']['region'][1]}-"
             f"{result['inputs']['region'][2]}", "",
             f"Verdict: **{result['verdict']}**", "",
             f"Selection (view plus margin, both sides): {result['inputs']['selection']}", "",
             "| records | n |", "|---|---|"]
    for k in ("records_compared", "records_identical", "records_identical_placements", "records_identical_calls",
              "records_identical_points", "records_split_live", "records_split_native",
              "records_placement_count_differs", "placements_live", "placements_native",
              "placements_identical_geometry"):
        lines.append(f"| {k} | {c.get(k, 0)} |")
    lines.append(f"| edge_excluded | {result['join']['edge_excluded']} |")
    for x in result["join"]["one_side_only"]:
        lines.append(f"| {x['side']} ({x['cause']}) | {x['n']} |")
    for title, table in (("calls per placement", result["calls"]), ("calls per record", result["record_calls"])):
        lines += ["", f"| {title} | identical | within 10 bp | different | raw identical | raw same bases |",
                  "|---|---|---|---|---|---|"]
        for g, b in table.items():
            lines.append(f"| {g} | {b.get('identical', 0)} | {b.get('within_10bp', 0)} | {b.get('different', 0)} | "
                         f"{b.get('raw_identical', '')} | {b.get('raw_same_bases', '')} |")
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
