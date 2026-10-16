"""An explicitly synthetic Fiber-seq BAM with structural variants (fb-n9-sv).

``write_sv_bam(path)`` writes a sorted, indexed BAM on ``chrSV`` (30 kb) with:

- a 1.5 kb deletion at ``DEL_START`` carried by ``del*`` reads (CIGAR ``D``;
  ``del3`` writes it split as ``900D 2M 598D``, as nanopore aligners do) and by
  ``clip*`` split reads (aligned up to the deletion, the rest soft-clipped,
  with an SA segment after it and a supplementary record);
- a 400 bp insertion at ``INS_POS`` in ``del0..del4`` and ``ref0..ref3``;
- ``ref*`` reads spanning both without the deletion, and ``ni*`` reads that
  stop short of a breakpoint (not informative for the deletion);
- forward and reverse reads, m6A ``MM``/``ML`` marks in the linkers, and
  FiberHMM-style calls in both ``ns``/``nl`` and ``MA``/``AQ`` (molecular
  frame, as FiberHMM >= 2.16 writes them). Every deletion carrier has a
  nucleosome call whose query interval contains the deletion breakpoint.

Pure pysam (no FiberHMM import), so backend tests and the e2e spec share it.
"""
from __future__ import annotations

import array
import random
from pathlib import Path

import pysam

CHROM = "chrSV"
CHROM_LEN = 30_000
DEL_START = 10_000
DEL_LEN = 1_500
INS_POS = 14_000
INS_LEN = 400
READ_START = 6_000
READ_END = 18_000
VIEW = (8_000, 16_000)

PG_MOLECULAR = {
    "ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "2.16.8",
    "DS": "FiberHMM fused apply+recall; coord=molecular (ns/nl/as/al/MA in molecular original-fiber coordinates); mode=pacbio-fiber",
    "CL": "fiberhmm-call -i in.bam -o out.bam",
}
CHEMISTRY_CO = "FIBERHMM-CHEMISTRY:v1:assay=fiber-seq;enzyme=hia5;platform=pacbio;mode=pacbio-fiber"

_COMP = str.maketrans("ACGT", "TGCA")


def _revcomp(seq: str) -> str:
    return seq.translate(_COMP)[::-1]


def reference_sequence(seed: int = 7) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice("ACGT") for _ in range(CHROM_LEN))


def _query_len(cigar) -> int:
    return sum(n for op, n in cigar if op in (0, 1, 4, 7, 8))


def _seq_for(ref: str, start: int, cigar, rng) -> str:
    out = []
    pos = start
    for op, n in cigar:
        if op == 0:
            out.append(ref[pos:pos + n])
            pos += n
        elif op == 2:
            pos += n
        elif op in (1, 4):
            out.append("".join(rng.choice("ACGT") for _ in range(n)))
    return "".join(out)


def _deletion_query_points(cigar) -> list[int]:
    q = 0
    points = []
    for op, n in cigar:
        if op in (0, 1, 4):
            q += n
        elif op == 2 and n >= 50:
            points.append(q)
    return points


def _calls(qlen: int, straddle: list[int]):
    """Nucleosomes (SEQ frame) every ~200 bp, one centred on each breakpoint,
    small TF calls in some linkers; MSPs are the linkers."""
    nucs = []
    s = 40
    while s + 147 < qlen - 20:
        nucs.append((s, 147))
        s += 200
    for q in straddle:
        nucs = [(a, n) for a, n in nucs if a + n < q - 90 - 15 or a > q + 90 + 15]
        nucs.append((q - 70, 147))
    nucs.sort()
    tfs = []
    msps = []
    prev_end = 0
    for i, (a, n) in enumerate(nucs):
        if a > prev_end:
            msps.append((prev_end, a - prev_end))
            if i % 3 == 1 and a - prev_end > 50:
                tfs.append((prev_end + 10, 30))
        prev_end = a + n
    if prev_end < qlen:
        msps.append((prev_end, qlen - prev_end))
    return nucs, tfs, msps


def _mm_ml(seq: str, is_reverse: bool, accessible, rng):
    """m6A on ~40% of A's inside accessible SEQ spans, in the MM frame."""
    orig = _revcomp(seq) if is_reverse else seq
    qlen = len(seq)

    def in_acc(seq_pos):
        return any(a <= seq_pos < a + n for a, n in accessible)

    marks = []
    a_index = 0
    for i, base in enumerate(orig):
        if base != "A":
            continue
        seq_pos = qlen - 1 - i if is_reverse else i
        if in_acc(seq_pos) and rng.random() < 0.4:
            marks.append(a_index)
        a_index += 1
    deltas = [marks[0]] + [b - a - 1 for a, b in zip(marks, marks[1:])] if marks else []
    mm = "A+a?," + ",".join(map(str, deltas)) + ";" if marks else "A+a?;"
    return mm, [250] * len(marks)


def _read_spec(ref: str, name: str, start: int, cigar, is_reverse: bool, rng, *, flag_extra: int = 0,
               sa: str | None = None) -> dict:
    seq = _seq_for(ref, start, cigar, rng)
    qlen = len(seq)
    assert qlen == _query_len(cigar)
    nucs, tfs, msps = _calls(qlen, _deletion_query_points(cigar))

    def mol(ivs):
        if not is_reverse:
            return sorted(ivs)
        return sorted((qlen - (a + n), n) for a, n in ivs)

    def section(label, spec, ivs):
        return f"{label}{spec}:" + ",".join(f"{a + 1}-{n}" for a, n in ivs)

    nuc_m, tf_m, msp_m = mol(nucs), mol(tfs), mol(msps)
    ma = f"{qlen};{section('nuc', '+Q', nuc_m)};{section('msp', '.', msp_m)};{section('tf', '+QQQ', tf_m)}"
    aq = [200] * len(nuc_m) + [220, 200, 200] * len(tf_m)
    mm, ml = _mm_ml(seq, is_reverse, msps, rng)
    tags = [
        ("ns", [a for a, _ in nuc_m]), ("nl", [n for _, n in nuc_m]),
        ("MA", ma), ("AQ", aq), ("MM", mm), ("ML", ml),
    ]
    if sa:
        tags.append(("SA", sa))
    return {"name": name, "start": start, "cigar": cigar, "seq": seq, "flag": (16 if is_reverse else 0) | flag_extra,
            "tags": tags}


def sv_read_specs(seed: int = 11) -> list[dict]:
    ref = reference_sequence()
    rng = random.Random(seed)
    specs = []
    left = DEL_START - READ_START
    for i in range(10):
        jitter = (i % 3 - 1) * 6
        dlen = DEL_LEN + (i % 4) * 3
        a = left + jitter
        ins_here = i < 5
        before_ins = INS_POS + (i % 2) * 4 - (DEL_START + jitter + dlen)
        if i == 3:
            del_ops = [(2, 900), (0, 2), (2, dlen - 902)]
        else:
            del_ops = [(2, dlen)]
        if ins_here:
            tail = [(0, before_ins), (1, INS_LEN + (i % 3) * 5), (0, READ_END - INS_POS - (i % 2) * 4)]
        else:
            tail = [(0, READ_END - DEL_START - jitter - dlen)]
        cigar = [(0, a), *del_ops, *tail]
        specs.append(_read_spec(ref, f"sv/del{i}/ccs", READ_START, cigar, bool(i % 2), rng))
    for i in range(8):
        if i < 4:
            p = INS_POS - READ_START - i * 3
            cigar = [(0, p), (1, INS_LEN - i * 4), (0, READ_END - READ_START - p)]
        else:
            cigar = [(0, READ_END - READ_START)]
        specs.append(_read_spec(ref, f"sv/ref{i}/ccs", READ_START, cigar, bool(i % 2), rng))
    # Not informative for the deletion: stop short of a breakpoint.
    specs.append(_read_spec(ref, "sv/ni0/ccs", READ_START, [(0, DEL_START - 200 - READ_START)], False, rng))
    specs.append(_read_spec(ref, "sv/ni1/ccs", DEL_START + DEL_LEN + 300, [(0, READ_END - DEL_START - DEL_LEN - 300)], True, rng))
    specs.append(_read_spec(ref, "sv/ni2/ccs", DEL_START - 40, [(0, 120)], False, rng))
    # Split reads: the primary ends at the deletion, the rest soft-clipped,
    # aligned (supplementary) after the deletion.
    for i in range(3):
        aligned = DEL_START - READ_START + (i - 1) * 4
        rest = 2_000
        sa_pos = DEL_START + DEL_LEN + (i - 1) * 4
        primary = [(0, aligned), (4, rest)]
        supp = [(4, aligned), (0, rest)]
        strand = "-" if i == 1 else "+"
        spec = _read_spec(ref, f"sv/clip{i}/ccs", READ_START, primary, i == 1, rng,
                          sa=f"{CHROM},{sa_pos + 1},{strand},{aligned}S{rest}M,60,0;")
        specs.append(spec)
        sup = _read_spec(ref, f"sv/clip{i}/ccs", sa_pos, supp, i == 1, rng, flag_extra=2048,
                         sa=f"{CHROM},{READ_START + 1},{strand},{aligned}M{rest}S,60,0;")
        specs.append(sup)
    return specs


EXPECTED = {
    # The 1.5 kb deletion in the default view: 10 CIGAR + 3 split-read carriers;
    # 8 reference reads span it; ni0..ni2 do not.
    "del_carriers": {f"sv/del{i}/ccs" for i in range(10)} | {f"sv/clip{i}/ccs" for i in range(3)},
    "del_reference": {f"sv/ref{i}/ccs" for i in range(8)},
    "del_not_informative": {"sv/ni0/ccs", "sv/ni1/ccs", "sv/ni2/ccs"},
    "ins_carriers": {f"sv/del{i}/ccs" for i in range(5)} | {f"sv/ref{i}/ccs" for i in range(4)},
}


def write_sv_bam(path, seed: int = 11) -> str:
    path = Path(path)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": CHROM_LEN}],
              "PG": [PG_MOLECULAR], "CO": [CHEMISTRY_CO]}
    unsorted = str(path) + ".unsorted.bam"
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for spec in sv_read_specs(seed):
            a = pysam.AlignedSegment(out.header)
            a.query_name = spec["name"]
            a.query_sequence = spec["seq"]
            a.query_qualities = pysam.qualitystring_to_array("I" * len(spec["seq"]))
            a.flag = spec["flag"]
            a.reference_id = 0
            a.reference_start = spec["start"]
            a.mapping_quality = 60
            a.cigartuples = spec["cigar"]
            for tag, value in spec["tags"]:
                if isinstance(value, list):
                    value = array.array("B" if tag in ("AQ", "ML") else "I", value)
                a.set_tag(tag, value)
            out.write(a)
    pysam.sort("-o", str(path), unsorted)
    Path(unsorted).unlink()
    pysam.index(str(path))
    return str(path)
