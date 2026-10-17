"""Live lift against FiberHMM's lift and native alignments on the graphlift
v0.4 toy sidecars (DESIGN_LIVE_LIFT.md §7, equivalence). Skipped when the
pg-lift work data is not on this machine.

- alu MAT (``+`` chain, the AluY source insertion): calls vs fiberhmm-lift and
  vs native GRCh38 alignments of the same molecules; AluY badges carry exact
  molecular bp;
- flip scDAF and Hia5 (``-`` chain): calls and marks vs the lifted BAMs; the
  molecule strand stays the source ``st``, deamination flavours are the
  repaired BAM's complemented (presentation flips, data does not).
"""
import collections
import os
import shutil

import pysam
import pytest

from services.compact_read_loader import build_compact_reads_from_bam
from services.lift import live_lift as ll

WORK = os.path.expanduser("~/pglift_work/pglift_20261017")
SPIKE = os.path.expanduser("~/pglift_work/pglift_spike_20261016")
V4 = os.path.join(WORK, "native", "graphlift", "scratch", "v4")
ALU_SRC = os.path.join(WORK, "validation_chr1", "work_v2", "alu.MAT", "in.win.bam")
ALU_OFFSET = 128_560_000          # the toy target is GRCh38 chr3 from this offset
REQUIRED = [ALU_SRC, os.path.join(V4, "alu.MAT.chain.graphlift.json"), os.path.join(V4, "flip.MAT.chain.graphlift.json"),
            os.path.join(WORK, "demo", "alu.MAT.fiberhmm_lift.bam"), os.path.join(WORK, "demo", "alu.native_GRCh38.bam"),
            os.path.join(WORK, "demo", "scdaf.fiberhmm_lift.bam"), os.path.join(SPIKE, "flip", "scdaf.in.bam"),
            os.path.join(SPIKE, "flip", "hia5.in.bam"), os.path.join(SPIKE, "flip", "hia5.lifted.sorted.bam")]
pytestmark = pytest.mark.skipif(not all(os.path.exists(p) for p in REQUIRED), reason="pg-lift work data not present")

OPTS = dict(include_methylation=True, hide_terminal_gaps=True)


def _indexed(path, tmp_path):
    if os.path.exists(path + ".bai"):
        return path
    dest = str(tmp_path / os.path.basename(path))
    shutil.copy(path, dest)
    pysam.index(dest)
    return dest


def _lift(sidecar, src, chrom, size):
    ll.clear_selection_cache()
    handle = ll.open_lift_map(os.path.join(V4, sidecar))
    return ll.load_lifted_rows(handle, [src], chrom, 0, size, haplotypes=handle.haplotypes,
                               settings=ll.LiftSettings(), dataset_id="ds", loader_options=dict(OPTS))


def _call_hulls(rows, base, layer):
    """Per molecule, the target hull of each call (its parts by call id; the
    native side's deletion pieces are joined the same way in ``_native``)."""
    out = collections.defaultdict(set)
    for r in rows:
        lay = (r.get("layers") or {}).get(layer)
        if not lay:
            continue
        ids = r["live_lift"]["calls"][f"layer:{layer}"]
        hulls = {}
        for k, (iv, cid) in enumerate(zip(lay["intervals"], ids)):
            key = cid if cid else k
            h = hulls.get(key)
            hulls[key] = (iv[0], iv[1]) if h is None else (min(h[0], iv[0]), max(h[1], iv[1]))
        out[r["id"]] |= {(a + base, b + base) for a, b in hulls.values()}
    return out


def _native(path, chrom, start, end, layer):
    """Native calls per molecule, with the pieces the decoder cut at a deletion joined again."""
    out = collections.defaultdict(set)
    for r in build_compact_reads_from_bam(path, chrom, start, end, spanning_only=False, **OPTS):
        lay = (r.get("layers") or {}).get(layer)
        dels = {(int(e["ref"]) - start, int(e["ref"]) + int(e["len"]) - start) for e in r.get("sv", ())
                if e.get("t") == "D"}
        merged = []
        for iv in sorted((lay or {}).get("intervals", ())):
            if merged and (merged[-1][1], iv[0]) in dels and merged[-1][2] == iv[2]:
                merged[-1][1] = iv[1]
            else:
                merged.append(list(iv))
        for iv in merged:
            out[r["id"]].add((iv[0] + start, iv[1] + start))
    return out


def _agreement(ours, theirs, molecules=None):
    """Symmetric agreement over ``molecules`` (default: both sides'): matched
    calls over the union of both sides' calls, so a missing molecule, a missing
    call and an extra call all count against it. Returns (molecules, score)."""
    molecules = set(ours) | set(theirs) if molecules is None else set(molecules)
    matched = sum(len(ours.get(i, set()) & theirs.get(i, set())) for i in molecules)
    union = sum(len(ours.get(i, set()) | theirs.get(i, set())) for i in molecules)
    return len(molecules & set(ours) & set(theirs)), matched / max(union, 1)


def _source_molecules(path, contig):
    with pysam.AlignmentFile(path) as bam:
        return {r.query_name for r in bam.fetch(contig) if not r.is_secondary}


def test_agreement_is_symmetric():
    ours = {"kept": {(0, 10), (200, 210)}}
    theirs = {"kept": {(0, 10)}, "lost": {(40, 50)}}
    assert _agreement(ours, theirs)[1] == pytest.approx(1 / 3)


@pytest.fixture(scope="module")
def alu(tmp_path_factory):
    src = _indexed(ALU_SRC, tmp_path_factory.mktemp("alu"))
    return src, _lift("alu.MAT.chain.graphlift.json", src, "chr3", 240_000)


def test_alu_calls_match_fiberhmm_lift_and_native(alu):
    src, load = alu
    source_molecules = _source_molecules(src, "chr3_MATERNAL")
    base = load.region_start + ALU_OFFSET
    for layer, vs_lift, vs_native in (("nuc", 0.995, 0.96), ("msp", 0.995, 0.96)):
        ours = _call_hulls(load.rows, base, layer)
        n, a = _agreement(ours, _native(os.path.join(WORK, "demo", "alu.MAT.fiberhmm_lift.bam"), "chr3",
                                        ALU_OFFSET, ALU_OFFSET + 240_000, layer))
        assert n >= 200 and a >= vs_lift, (layer, n, a)
        n, a = _agreement(ours, _native(os.path.join(WORK, "demo", "alu.native_GRCh38.bam"), "chr3",
                                        ALU_OFFSET, ALU_OFFSET + 240_000, layer), source_molecules)
        assert n >= 200 and a >= vs_native, (layer, n, a)


def test_alu_badges_carry_exact_molecular_bp(alu):
    src, load = alu
    handle = ll.open_lift_map(os.path.join(V4, "alu.MAT.chain.graphlift.json"))
    reason, lo, hi = handle.map.gap_span("chr3_MATERNAL", 95_000)   # the AluY: source-only sequence
    assert reason == "source_insertion" and hi - lo > 2000
    records = {}
    with pysam.AlignmentFile(src) as bam:
        for r in bam.fetch("chr3_MATERNAL", lo, hi):
            records[(r.query_name, r.reference_start)] = r
    checked = 0
    for row in load.rows:
        rec = records.get((row["id"], row["live_lift"]["source"]["start"]))
        if rec is None:
            continue
        badges = [b for b in row["live_lift"]["badges"] if b[1] == "source_insertion" and b[3] == hi - lo]
        if not badges:
            continue
        # The read's bases between the AluY flanks, counted independently (insertions included).
        pairs = [(q, ref) for q, ref in rec.get_aligned_pairs() if q is not None and ref is not None]
        q_lo = next(q for q, ref in pairs if ref >= lo)
        q_hi = next(q for q, ref in pairs if ref >= hi)
        assert badges[0][2] == q_hi - q_lo
        checked += 1
    assert checked >= 30   # rows reaching both AluY flanks


def _deam(path, chrom, size):
    out = {}
    for r in build_compact_reads_from_bam(path, chrom, 0, size, spanning_only=False, **OPTS):
        out[r["id"]] = (r.get("strand"), {tuple(e) for e in r.get("deam", ())})
    return out


def test_flip_scdaf_minus_chain_strand_and_marks():
    load = _lift("flip.MAT.chain.graphlift.json", os.path.join(SPIKE, "flip", "scdaf.in.bam"), "chr1", 330_000)
    assert all(r["live_lift"]["segments"][0][3] == "-" for r in load.rows)
    ours = _call_hulls(load.rows, load.region_start, "nuc")
    n, a = _agreement(ours, _native(os.path.join(WORK, "demo", "scdaf.fiberhmm_lift.bam"), "chr1", 0, 330_000,
                                    "nuc"))
    assert n >= 500 and a >= 0.995
    source = {r["id"]: r.get("strand") for r in build_compact_reads_from_bam(
        os.path.join(SPIKE, "flip", "scdaf.in.bam"), "chr1_MATERNAL", 0, 300_000, spanning_only=False, **OPTS)}
    lifted = _deam(os.path.join(WORK, "demo", "scdaf.fiberhmm_lift.bam"), "chr1", 330_000)
    same_pos = flipped = total = 0
    for r in load.rows:
        if r["live_lift"]["source"]["supplementary"]:
            continue
        assert r.get("strand") == source[r["id"]]            # the molecule's st, unchanged
        their_strand, theirs = lifted[r["id"]]
        # fiberhmm-lift swaps st with the reverse-complemented SEQ; here only the presentation flips.
        if r.get("strand") in ("CT", "GA"):
            assert their_strand == {"CT": "GA", "GA": "CT"}[r.get("strand")]
        mine = {tuple(e) for e in r.get("deam", ())}
        their_pos = {p: f for p, f in theirs}
        for p, f in mine:
            total += 1
            if p in their_pos:
                same_pos += 1
                flipped += their_pos[p] == 1 - f              # presented complemented on '-'
    assert total > 10_000 and same_pos / total >= 0.995 and flipped == same_pos


def test_flip_hia5_minus_chain_marks_and_calls():
    load = _lift("flip.MAT.chain.graphlift.json", os.path.join(SPIKE, "flip", "hia5.in.bam"), "chr1", 330_000)
    lifted_bam = os.path.join(SPIKE, "flip", "hia5.lifted.sorted.bam")  # raw ft pg-lift output (unrepaired)
    ours = _call_hulls(load.rows, load.region_start, "nuc")
    n, a = _agreement(ours, _native(lifted_bam, "chr1", 0, 330_000, "nuc"))
    assert n >= 180 and a >= 0.995
    m6a_ours = collections.defaultdict(set)
    for r in load.rows:
        m6a_ours[r["id"]] |= {x + load.region_start for x in r.get("methyl_m6a", ())}
    m6a_theirs = collections.defaultdict(set)
    for r in build_compact_reads_from_bam(lifted_bam, "chr1", 0, 330_000, spanning_only=False, **OPTS):
        m6a_theirs[r["id"]] |= set(r.get("methyl_m6a", ()))
    n, a = _agreement(m6a_ours, m6a_theirs)
    assert n >= 180 and a >= 0.999
