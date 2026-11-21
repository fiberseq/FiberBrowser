#!/usr/bin/env python
"""Payload-level equivalence of live lift against native target alignments
(DESIGN_LIVE_LIFT.md §7): unlike ``live_lift_liveproj.py``, which checks the
aligned-base projection primitive, this compares what ``load_lifted_rows``
returns (``lift_compact_reads`` payloads) with a native decode of the same
molecules.

The target is tiled into views. Per view, only calls whose target hull lies
strictly inside the view are compared (the native decoder clips at the
view); both sides are restricted to the source BAM's molecules on
``--src-contig``. Scores are symmetric: matched / (lifted ∪ native), so
missing molecules, missing calls and extra calls all count.

- calls: per layer (``nuc``, ``msp``), one hull per call (lifted parts joined
  by call id; native pieces cut at deletions joined again), exact start and end;
- m6A: per base (``methyl_m6a`` positions).

usage: live_lift_payload_equiv.py SIDECAR SRC_BAM CMP_BAM --src-contig C --tgt-contig C
       --start N --end N [--view BP] [--json OUT]"""
import argparse
import collections
import json
import os
import sys
import time

import pysam

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "browser"))

from services.compact_read_loader import build_compact_reads_from_bam  # noqa: E402
from services.lift import live_lift as ll  # noqa: E402

OPTIONS = dict(include_methylation=True, hide_terminal_gaps=True)
LAYERS = ("nuc", "msp")


def lifted_calls(rows, base, layer, lo, hi):
    out = collections.defaultdict(set)
    for r in rows:
        lay = (r.get("layers") or {}).get(layer)
        if not lay:
            continue
        ids = r["live_lift"]["calls"].get(f"layer:{layer}") or [None] * len(lay["intervals"])
        hulls = {}
        for k, (iv, cid) in enumerate(zip(lay["intervals"], ids)):
            key = (r["live_lift"]["record"], cid) if cid else ("part", k)
            h = hulls.get(key)
            hulls[key] = (iv[0], iv[1]) if h is None else (min(h[0], iv[0]), max(h[1], iv[1]))
        for a, b in hulls.values():
            if lo < a + base and b + base < hi:
                out[r["id"]].add((a + base, b + base))
    return out


def native_calls(reads, base, layer, lo, hi):
    out = collections.defaultdict(set)
    for r in reads:
        lay = (r.get("layers") or {}).get(layer)
        dels = {(int(e["ref"]) - base, int(e["ref"]) + int(e["len"]) - base) for e in r.get("sv", ())
                if e.get("t") == "D"}
        merged = []
        for iv in sorted((lay or {}).get("intervals", ())):
            if merged and (merged[-1][1], iv[0]) in dels and merged[-1][2] == iv[2]:
                merged[-1][1] = iv[1]
            else:
                merged.append(list(iv))
        for iv in merged:
            if lo < iv[0] + base and iv[1] + base < hi:
                out[r["id"]].add((iv[0] + base, iv[1] + base))
    return out


def marks(rows, base, lo, hi):
    out = collections.defaultdict(set)
    for r in rows:
        out[r["id"]] |= {x + base for x in r.get("methyl_m6a", ()) if lo <= x + base < hi}
    return out


def score(ours, theirs, molecules, acc):
    for m in molecules:
        a, b = ours.get(m, set()), theirs.get(m, set())
        acc["matched"] += len(a & b)
        acc["lifted_only"] += len(a - b)
        acc["native_only"] += len(b - a)
        if b and not a:
            acc["molecules_missing_in_lifted"] += 1
        if a and not b:
            acc["molecules_missing_in_native"] += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sidecar")
    ap.add_argument("src_bam")
    ap.add_argument("cmp_bam")
    ap.add_argument("--src-contig", required=True)
    ap.add_argument("--tgt-contig", required=True)
    ap.add_argument("--start", type=int, required=True)
    ap.add_argument("--end", type=int, required=True)
    ap.add_argument("--view", type=int, default=500_000)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    handle = ll.open_lift_map(a.sidecar)
    hap = handle.source_haplotype[a.src_contig]
    with pysam.AlignmentFile(a.src_bam) as bam:
        molecules = {r.query_name for r in bam.fetch(a.src_contig) if not r.is_secondary}
    acc = {name: collections.Counter() for name in (*LAYERS, "m6a")}
    t0 = time.time()
    for s in range(a.start, a.end, a.view):
        e = min(a.end, s + a.view)
        load = ll.load_lifted_rows(handle, [a.src_bam], a.tgt_contig, s, e, haplotypes=[hap],
                                   settings=ll.LiftSettings(), dataset_id="equiv", loader_options=dict(OPTIONS))
        native = [r for r in build_compact_reads_from_bam(a.cmp_bam, a.tgt_contig, s, e, spanning_only=False,
                                                          **OPTIONS) if r["id"] in molecules]
        in_view = {m for m in molecules}
        for layer in LAYERS:
            score(lifted_calls(load.rows, load.region_start, layer, s, e), native_calls(native, s, layer, s, e),
                  in_view, acc[layer])
        score(marks(load.rows, load.region_start, s, e), marks(native, s, s, e), in_view, acc["m6a"])
        print(f"view {s}-{e}: lifted rows {len(load.rows)}, native records {len(native)}", flush=True)
    result = {"seconds": round(time.time() - t0, 1), "haplotype": hap}
    for name, c in acc.items():
        union = c["matched"] + c["lifted_only"] + c["native_only"]
        result[name] = dict(c, symmetric_agreement=round(c["matched"] / max(union, 1), 6),
                            native_recall=round(c["matched"] / max(c["matched"] + c["native_only"], 1), 6),
                            lifted_precision=round(c["matched"] / max(c["matched"] + c["lifted_only"], 1), 6))
    print(json.dumps(result, indent=1))
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(result, fh, indent=1)


if __name__ == "__main__":
    main()
