#!/usr/bin/env python
"""Per-base check of FiberBrowser live lift against native target alignments
(the "liveproj" harness of DESIGN_LIVE_LIFT.md §7), comparable to graphlift's
scripts/readproj.py.

Projections come from the live-lift library itself: the target chromosome is
tiled into views; for each view ``select_pieces`` (one haplotype, primary
pieces, the bin cache), ``plan_fetch`` and ``decode_source_records`` load the
source records exactly as a lifted load does, and ``compose.project_aligned_runs``
maps their aligned bases through the composed rows. Every source-aligned
molecular base (primary + supplementary records on ``--src-contig``, as in
readproj) then lands in one bucket against the comparison BAM (primary +
supplementary on ``--tgt-contig``):

  agree_primary   the lifted position is one the comparison gives that base
  near5 / near50  closest lifted vs comparison position within 5 / 50 bp
  disagree        further away
  cmp_unaligned   lifted; the comparison has the molecule but not this base on the contig
  cmp_missing     lifted; the comparison has no mapped record of the molecule
  unprojected     no lifted position (no selected primary piece covers the base,
                  or the loader dropped the record)

usage: live_lift_liveproj.py SIDECAR SRC_BAM CMP_BAM --src-contig C --tgt-contig C
       [--start N --end N] [--view BP] [--json OUT]"""
import argparse
import collections
import json
import os
import sys
import time

import numpy as np
import pysam

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "browser"))

from services.lift import live_lift as ll  # noqa: E402
from services.lift.compose import project_aligned_runs  # noqa: E402

LOADER_OPTIONS = dict(include_methylation=False, include_layers=False, include_cigar=False,
                      hide_terminal_gaps=False, include_duplicates=True, sv_min_len=1_000_000)


def record_blocks(r):
    """(molecular index array, reference array) per aligned run, hard clips counted."""
    length = r.infer_read_length()
    lead = r.cigartuples[0][1] if r.cigartuples[0][0] == 5 else 0
    q, t = 0, r.reference_start
    for op, n in r.cigartuples:
        if op in (0, 7, 8):
            full = q + lead + np.arange(n)
            yield (length - 1 - full if r.is_reverse else full), np.arange(t, t + n)
            q += n
            t += n
        elif op in (1, 4):
            q += n
        elif op in (2, 3):
            t += n


def collect(path, contig, keep_other=False):
    """{qname: [(mol, ref, on_contig)]} of primary + supplementary records."""
    out = collections.defaultdict(list)
    lengths = {}
    with pysam.AlignmentFile(path) as bam:
        for r in bam.fetch(until_eof=True):
            if r.is_unmapped or r.is_secondary:
                continue
            on = r.reference_name == contig
            if not on and not keep_other:
                continue
            lengths[r.query_name] = r.infer_read_length()
            for mol, ref in record_blocks(r):
                out[r.query_name].append((mol, ref, on))
    return out, lengths


def lifted_projections(handle, src_bam, src_contig, tgt_contig, start, end, view, settings):
    """{qname: {(mol, target)}} encoded as int64 keys, from the library."""
    hap = handle.source_haplotype[src_contig]
    key = ll.lift_key(handle, [hap], settings)
    proj = collections.defaultdict(list)
    stats = collections.Counter()
    t0 = time.time()
    for s in range(start, end, view):
        e = min(end, s + view)
        sel = ll.select_pieces(handle, tgt_contig, s, e, haplotypes=[hap], settings=settings, key=key)
        if not sel.pieces:
            continue
        plan = ll.plan_fetch(sel, settings)
        plan.contigs = [c for c in plan.contigs if c.contig == src_contig]
        reads = ll.decode_source_records([src_bam], plan, loader_options=LOADER_OPTIONS, counts=stats)
        pieces = plan.pieces_by_contig().get(src_contig, [])
        for read in reads:
            rec = read["_fiberbrowser_lift_record"]
            for seq0, t_at, n, step, _row in project_aligned_runs(read, pieces, settings):
                seq = seq0 + np.arange(n)
                mol = rec["length"] - 1 - seq if rec["reverse"] else seq
                proj[read["id"]].append((mol << 32) | (t_at + step * np.arange(n)))
        stats["views"] += 1
        stats["records_decoded"] += len(reads)
    stats["seconds"] = round(time.time() - t0, 1)
    return proj, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sidecar")
    ap.add_argument("src_bam")
    ap.add_argument("cmp_bam")
    ap.add_argument("--src-contig", required=True)
    ap.add_argument("--tgt-contig", required=True)
    ap.add_argument("--start", type=int, default=None)
    ap.add_argument("--end", type=int, default=None)
    ap.add_argument("--view", type=int, default=1_000_000)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    handle = ll.open_lift_map(a.sidecar)
    settings = ll.LiftSettings()
    src, lengths = collect(a.src_bam, a.src_contig)
    cmp_map, _ = collect(a.cmp_bam, a.tgt_contig, keep_other=True)
    if a.start is None or a.end is None:
        with pysam.AlignmentFile(a.cmp_bam) as bam:
            ends = [(r.reference_start, r.reference_end) for r in bam.fetch(a.tgt_contig) if not r.is_unmapped]
        a.start = a.start if a.start is not None else min(x for x, _ in ends)
        a.end = a.end if a.end is not None else max(y for _, y in ends)
    proj, stats = lifted_projections(handle, a.src_bam, a.src_contig, a.tgt_contig, a.start, a.end, a.view,
                                     settings)

    base = collections.Counter()
    mols = collections.Counter()
    for qn, blocks in src.items():
        length = lengths[qn]
        mols["examined"] += 1
        has_src = np.zeros(length, bool)
        for mol, _ref, _on in blocks:
            has_src[mol] = True
        lifted = np.full(length, -1, np.int64)
        pairs = np.unique(np.concatenate(proj[qn])) if proj.get(qn) else np.zeros(0, np.int64)
        if len(pairs):
            lifted[pairs >> 32] = pairs & 0xFFFFFFFF
        cmp_blocks = cmp_map.get(qn, [])
        if not cmp_blocks:
            mols["cmp_missing"] += 1
        cmp_pos = np.full(length, -1, np.int64)
        cmp_pairs = []
        for mol, ref, on in cmp_blocks:
            ok = (mol >= 0) & (mol < length)
            if on:
                cmp_pos[mol[ok]] = ref[ok]
                cmp_pairs.append((mol[ok] << 32) | ref[ok])
        cmp_pairs = np.concatenate(cmp_pairs) if cmp_pairs else np.zeros(0, np.int64)
        lab = np.full(length, "", dtype="<U16")
        projd = has_src & (lifted >= 0)
        agree = projd & np.isin(np.where(lifted >= 0, (np.arange(length) << 32) | np.maximum(lifted, 0), -1), cmp_pairs)
        lab[agree] = "agree_primary"
        other = projd & ~agree & (cmp_pos >= 0)
        d = np.abs(lifted - cmp_pos)
        lab[other & (d <= 5)] = "near5"
        lab[other & (d > 5) & (d <= 50)] = "near50"
        lab[other & (d > 50)] = "disagree"
        lab[projd & ~agree & (cmp_pos < 0)] = "cmp_unaligned" if cmp_blocks else "cmp_missing"
        lab[has_src & ~projd] = "unprojected"
        base.update(collections.Counter(lab[has_src].tolist()))

    total = sum(base.values())
    print(f"views {stats['views']}, records decoded {stats['records_decoded']}, {stats['seconds']} s; "
          f"molecules: " + ", ".join(f"{k}={v}" for k, v in sorted(mols.items())))
    print(f"aligned source bases: total {total}")
    for k, v in sorted(base.items(), key=lambda x: -x[1]):
        print(f"  {k:24s} {v:12d}  {100 * v / max(total, 1):7.3f}%")
    if a.json:
        with open(a.json, "w") as fh:
            json.dump({"bases": base, "molecules": mols, "stats": stats, "start": a.start, "end": a.end}, fh,
                      indent=1)


if __name__ == "__main__":
    main()
