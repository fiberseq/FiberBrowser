"""Synthetic Fiber-seq BAM with a ~2 kb insertion carried by some reads.

The insert (a made-up transposable element) is nucleosome-packed with an open,
m6A-dense patch carrying two TF footprints. Carriers are on both strands and
their inserts vary in length (±3%, nanopore-like indels). One nucleosome
straddles the left breakpoint and one the right. Reference reads span the
site without the insert; one carries a short insertion of another length, and
one carrier's insert is split into two CIGAR pieces with three matched bases
between them. Clipped carriers (the way minimap2 often writes a large insert):
one read's alignment ends at the site with the insert's start soft-clipped,
one (reverse strand) starts there with the insert's end soft-clipped, and one
is hard-clipped there with an SA tag (no inserted bases in the record). One
read is clipped 500 bp before the site (not a carrier).

Calls are written the way FiberHMM writes them (``MA``/``AQ`` with
``coord=molecular``, plus legacy ``ns``/``nl``), m6A as ``MM``/``ML``
``A+a`` on the original molecule. ``make_insertion_bam`` returns the truth
in SEQ-frame query coordinates so the tests can check every placement.

Run as a script to write the fixture (BAM + FASTA) into a directory:
``python tests/insertion_fixtures.py OUT_DIR``.
"""
from __future__ import annotations

import array
import random
import sys
from pathlib import Path

import pysam

CHROM = "chrT"
REF_LEN = 30_000
SITE = 15_000
TE_LEN = 2_000
RC = str.maketrans("ACGT", "TGCA")
PG_MOLECULAR = {
    "ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0",
    "DS": "FiberHMM fused apply+recall; coord=molecular (ns/nl/as/al/MA in molecular original-fiber coordinates); mode=m6a",
    "CL": "fiberhmm-call -i in.bam -o out.bam",
}
NUC = 147
# Genomic nucleosome straddling the site on reference reads, [SITE-60, SITE+87).
SITE_NUC_LEFT = 60
SITE_NUC_RIGHT = 87


def revcomp(seq: str) -> str:
    return seq.translate(RC)[::-1]


def _mutate_to_length(rng: random.Random, seq: str, target: int) -> str:
    """Nanopore-like copy of ``seq``: a few substitutions, then 1–4 bp indels until ``target`` long."""
    chars = list(seq)
    for _ in range(len(chars) // 100):
        i = rng.randrange(len(chars))
        chars[i] = rng.choice("ACGT")
    while len(chars) != target:
        i = rng.randrange(50, len(chars) - 50)
        n = min(rng.randint(1, 4), abs(len(chars) - target))
        if len(chars) < target:
            chars[i:i] = [rng.choice("ACGT") for _ in range(n)]
        else:
            del chars[i:i + n]
    return "".join(chars)


def _array(rng, start: int, end: int, *, first: int | None = None) -> list[tuple[int, int]]:
    """Nucleosomes (start, length) packed from ``first`` (or start) up to ``end``."""
    out = []
    p = start if first is None else first
    while p + NUC <= end:
        out.append((p, NUC))
        p += NUC + rng.randint(25, 45)
    return out


def _gaps(nucs: list[tuple[int, int]], lo: int, hi: int) -> list[tuple[int, int]]:
    """MSPs: the stretches between nucleosomes inside [lo, hi)."""
    out = []
    p = lo
    for s, length in sorted(nucs):
        if s > p:
            out.append((p, s - p))
        p = max(p, s + length)
    if hi > p:
        out.append((p, hi - p))
    return out


def _mol(start: int, length: int, read_len: int, reverse: bool) -> int:
    return read_len - (start + length) if reverse else start


def _tags(rng, seq: str, reverse: bool, nucs, msps, tfs, open_spans) -> list:
    read_len = len(seq)

    def section(name, spec, ivs):
        mol = sorted((_mol(s, n, read_len, reverse), n) for s, n in ivs)
        return f"{name}{spec}:" + ",".join(f"{s + 1}-{n}" for s, n in mol), mol

    nuc_sec, nuc_mol = section("nuc", "+Q", nucs)
    msp_sec, _ = section("msp", ".", msps)
    tf_sec, tf_mol = section("tf", "+QQQ", tfs)
    aq = [200] * len(nuc_mol) + [220, 200, 200] * len(tf_mol)
    # m6A on the original molecule's A bases: dense in open patches, common in
    # linkers, rare inside nucleosomes and footprints.
    covered = [0] * read_len
    for s, n in nucs:
        for i in range(max(0, s), min(read_len, s + n)):
            covered[i] = 1
    for s, n in tfs:
        for i in range(max(0, s), min(read_len, s + n)):
            covered[i] = 1
    is_open = [0] * read_len
    for s, n in open_spans:
        for i in range(max(0, s), min(read_len, s + n)):
            is_open[i] = 1
    orig = revcomp(seq) if reverse else seq
    marked_seq_positions = []
    skips = []
    gap = 0
    for k, base in enumerate(orig):
        if base != "A":
            continue
        seq_pos = read_len - 1 - k if reverse else k
        p = 0.02 if covered[seq_pos] else (0.85 if is_open[seq_pos] else 0.55)
        if rng.random() < p:
            skips.append(gap)
            gap = 0
            marked_seq_positions.append(seq_pos)
        else:
            gap += 1
    tags = [
        ("MA", f"{read_len};{nuc_sec};{msp_sec};{tf_sec}"),
        ("AQ", array.array("B", aq)),
        ("ns", array.array("I", [s for s, _ in nuc_mol])),
        ("nl", array.array("I", [n for _, n in nuc_mol])),
        ("MM", "A+a," + ",".join(map(str, skips)) + ";"),
        ("ML", array.array("B", [230] * len(skips))),
    ]
    return tags, sorted(marked_seq_positions)


def _array_tags(rng, seq: str, reverse: bool):
    """Tags for a read with a plain nucleosome array (the loader needs calls)."""
    nucs = [(s, NUC) for s in range(60, len(seq) - NUC - 20, 190)]
    return _tags(rng, seq, reverse, nucs, _gaps(nucs, 0, len(seq)), [], [])


def make_insertion_bam(directory, *, n_carriers: int = 24, n_reference: int = 16, seed: int = 7,
                       name: str = "insertion", te_len: int = TE_LEN, clip_variants: bool = True) -> dict:
    """Write ``<name>.bam`` (+ .bai) and ``<name>.fa`` into ``directory``; return the truth."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    ref = "".join(rng.choice("ACGT") for _ in range(REF_LEN))
    te = "".join(rng.choice("ACGT") for _ in range(te_len))
    fasta = directory / f"{name}.fa"
    with open(fasta, "w") as fh:
        fh.write(f">{CHROM}\n")
        for i in range(0, REF_LEN, 80):
            fh.write(ref[i:i + 80] + "\n")
    pysam.faidx(str(fasta))

    # Genomic nucleosomes, shared by every read (well positioned).
    left_genomic = []
    p = SITE - SITE_NUC_LEFT - 190
    while p > 0:
        left_genomic.append((p, NUC))
        p -= 190
    right_genomic = []
    p = SITE + SITE_NUC_RIGHT + 43
    while p + NUC < REF_LEN:
        right_genomic.append((p, NUC))
        p += 190

    specs = []
    truth = {"chrom": CHROM, "site": SITE, "te": te, "ref": ref, "reads": {}}

    for idx in range(n_carriers):
        reverse = idx % 2 == 1
        jitter = (0, 0, 0, 3, -4, 0)[idx % 6]
        bp = SITE + jitter
        jitter_bp = max(1, int(0.03 * te_len))
        target = te_len + rng.randint(-jitter_bp, jitter_bp)
        insert = _mutate_to_length(rng, te, target)
        ls = bp - 4000 - rng.randint(0, 400)
        re_ = bp + 4000 + rng.randint(0, 400)
        split_piece = idx == 4  # one carrier's insert is split by 3 matched bases
        if split_piece:
            k = int(0.45 * te_len)
            seq = ref[ls:bp] + insert[:k] + ref[bp:bp + 3] + insert[k:] + ref[bp + 3:re_]
            cigar = [(0, bp - ls), (1, k), (0, 3), (1, len(insert) - k), (0, re_ - bp - 3)]
            ins_len = len(insert) + 3
            ref_end = bp + 3
        else:
            seq = ref[ls:bp] + insert + ref[bp:re_]
            cigar = [(0, bp - ls), (1, len(insert)), (0, re_ - bp)]
            ins_len = len(insert)
            ref_end = bp
        q0 = bp - ls  # first inserted base (SEQ frame)
        L = ins_len
        # Query-coordinate chromatin.
        nucs = [(s - ls, n) for s, n in left_genomic if s >= ls]
        nucs.append((q0 - SITE_NUC_LEFT, NUC))                        # straddles the left breakpoint
        open_lo, open_hi = int(0.62 * L), int(0.82 * L)
        right_straddle = (q0 + L - 70, NUC)                            # straddles the right breakpoint
        inner = _array(rng, 0, open_lo, first=SITE_NUC_RIGHT + 25)
        inner += _array(rng, open_hi, L - 70 - 25, first=open_hi + 20)
        nucs += [(q0 + s, n) for s, n in inner]
        nucs.append(right_straddle)
        shift = q0 + L - ref_end                                       # ref -> query on the right
        nucs += [(s + shift, n) for s, n in right_genomic if s >= ref_end + 77 and s + n + shift <= len(seq)]
        nucs = sorted(n for n in nucs if n[0] >= 0 and n[0] + n[1] <= len(seq))
        tfs = [(q0 + open_lo + 80, 22), (q0 + open_lo + 230, 30)]
        msps = _gaps(nucs + tfs, 0, len(seq))
        open_spans = [(q0 + open_lo, open_hi - open_lo)]
        tags, m6a = _tags(rng, seq, reverse, nucs, msps, tfs, open_spans)
        rid = f"carrier_{idx:02d}{'_rev' if reverse else '_fwd'}"
        specs.append({"name": rid, "reverse": reverse, "start": ls, "cigar": cigar, "seq": seq, "tags": tags})
        truth["reads"][rid] = {
            "kind": "carrier", "reverse": reverse, "bp": bp, "ref_end": ref_end, "q": q0, "len": ins_len,
            "insert_seq": seq[q0:q0 + ins_len], "nucs": nucs, "tfs": tfs, "msps": msps, "m6a": m6a,
            "pieces": 2 if split_piece else 1, "read_start": ls,
        }

    for idx in range(n_reference):
        reverse = idx % 2 == 0
        ls = SITE - 4000 - rng.randint(0, 400)
        re_ = SITE + 4000 + rng.randint(0, 400)
        seq = ref[ls:re_]
        nucs = [(s - ls, n) for s, n in left_genomic if s >= ls]
        nucs.append((SITE - SITE_NUC_LEFT - ls, NUC))
        nucs += [(s - ls, n) for s, n in right_genomic if s + n <= re_]
        nucs = sorted(nucs)
        msps = _gaps(nucs, 0, len(seq))
        tags, m6a = _tags(rng, seq, reverse, nucs, msps, [], [])
        rid = f"reference_{idx:02d}{'_rev' if reverse else '_fwd'}"
        specs.append({"name": rid, "reverse": reverse, "start": ls, "cigar": [(0, len(seq))], "seq": seq, "tags": tags})
        truth["reads"][rid] = {"kind": "reference", "reverse": reverse, "nucs": nucs, "m6a": m6a, "read_start": ls}

    # A read soft-clipped at the site (its insert continues in the clip): a
    # carrier whose clip holds the insert's first 600 bp.
    ls = SITE - 3000
    seq = ref[ls:SITE] + te[:600]
    tags, m6a = _array_tags(rng, seq, False)
    specs.append({"name": "clipped_00", "reverse": False, "start": ls,
                  "cigar": [(0, SITE - ls), (4, 600)], "seq": seq, "tags": tags})
    truth["reads"]["clipped_00"] = {"kind": "clip", "partial": "start", "soft": 600, "q": SITE - ls,
                                    "insert_seq": te[:600], "m6a": m6a, "reverse": False}
    # A read with a short insertion of another length at the site.
    ls = SITE - 3000
    short = te[:300]
    seq = ref[ls:SITE] + short + ref[SITE:SITE + 3000]
    tags, _ = _array_tags(rng, seq, False)
    specs.append({"name": "other_insert_00", "reverse": False, "start": ls,
                  "cigar": [(0, SITE - ls), (1, 300), (0, 3000)], "seq": seq, "tags": tags})
    truth["reads"]["other_insert_00"] = {"kind": "other"}
    if clip_variants:
        # Its alignment starts at the site: the soft clip is the insert's last 700 bp (reverse strand).
        seq = te[-700:] + ref[SITE:SITE + 3000]
        tags, m6a = _array_tags(rng, seq, True)
        specs.append({"name": "clipped_left_00", "reverse": True, "start": SITE,
                      "cigar": [(4, 700), (0, 3000)], "seq": seq, "tags": tags})
        truth["reads"]["clipped_left_00"] = {"kind": "clip", "partial": "end", "soft": 700, "q": 0,
                                             "insert_seq": te[-700:], "m6a": m6a, "reverse": True}
        # Hard-clipped at the site, the rest in a supplementary alignment: a
        # carrier with no inserted bases in this record.
        ls = SITE - 2500
        seq = ref[ls:SITE]
        tags, _ = _array_tags(rng, seq, False)
        tags.append(("SA", f"{CHROM},{REF_LEN - 3000},+,2500H900M,60,0;"))
        specs.append({"name": "hard_right_00", "reverse": False, "start": ls,
                      "cigar": [(0, SITE - ls), (5, 900)], "seq": seq, "tags": tags})
        truth["reads"]["hard_right_00"] = {"kind": "clip", "partial": "start", "soft": 0, "hard": True}
        # Clipped 500 bp before the site: neither a carrier nor spanning it.
        ls = SITE - 3500
        seq = ref[ls:SITE - 500] + te[:400]
        tags, _ = _array_tags(rng, seq, False)
        specs.append({"name": "clip_elsewhere_00", "reverse": False, "start": ls,
                      "cigar": [(0, SITE - 500 - ls), (4, 400)], "seq": seq, "tags": tags})
        truth["reads"]["clip_elsewhere_00"] = {"kind": "not_informative"}

    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": REF_LEN}],
              "PG": [PG_MOLECULAR],
              "CO": ["FIBERHMM-CHEMISTRY:v1:assay=fiberseq;enzyme=hia5;platform=ont;mode=m6a"]}
    bam = directory / f"{name}.bam"
    unsorted = directory / f"{name}.unsorted.bam"
    with pysam.AlignmentFile(str(unsorted), "wb", header=header) as out:
        for spec in specs:
            a = pysam.AlignedSegment(out.header)
            a.query_name = spec["name"]
            a.query_sequence = spec["seq"]
            a.query_qualities = pysam.qualitystring_to_array("5" * len(spec["seq"]))
            a.flag = 16 if spec["reverse"] else 0
            a.reference_id = 0
            a.reference_start = spec["start"]
            a.mapping_quality = 60
            a.cigartuples = spec["cigar"]
            for tag, value in spec["tags"]:
                a.set_tag(tag, value)
            out.write(a)
    pysam.sort("-o", str(bam), str(unsorted))
    unsorted.unlink()
    pysam.index(str(bam))
    truth["bam"] = str(bam)
    truth["fasta"] = str(fasta)
    return truth


if __name__ == "__main__":  # pragma: no cover - fixture writer
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    te_len = int(sys.argv[3]) if len(sys.argv) > 3 else TE_LEN
    info = make_insertion_bam(out_dir, n_carriers=n, te_len=te_len)
    print(info["bam"], info["fasta"])


# ---------------------------------------------------------------------------
# A DAF (DddB-like) insertion: heavily deaminated open Cs inside the insert
# ---------------------------------------------------------------------------

DAF_CHROM = "chrD"
DAF_SITE = 3_000
DAF_TE_LEN = 300
_DAF_FLANK = 1_200


def _md(read_bases: str, ref_bases: str) -> str:
    """The MD tag of an ungapped alignment of ``read_bases`` to ``ref_bases``."""
    out, run = [], 0
    for got, want in zip(read_bases, ref_bases):
        if got == want:
            run += 1
        else:
            out.append(f"{run}{want}")
            run = 0
    return "".join(out) + str(run)


def make_daf_insertion_bam(directory, *, n_ct: int = 24, n_ga: int = 4, deamination: float = 0.8,
                           seed: int = 11, name: str = "daf_insertion") -> dict:
    """A DAF BAM whose carriers share a 300 bp insert at chrD:3,000.

    The insert's first half is open: on C->T reads each of its Cs reads T with
    probability ``deamination`` (G->A reads likewise for Gs); its second half
    is packed (no deamination). Flanks carry 30% conversions so each read's
    strand is clear from its MD tag, as minimap2 --MD writes it. With most
    carriers C->T and ``deamination`` above 50%, a majority vote calls the open
    Cs T; the DAF-aware consensus calls them C. Returns the truth."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    ref = "".join(rng.choice("ACGT") for _ in range(6_000))
    te = "".join(rng.choice("ACGT") for _ in range(DAF_TE_LEN))
    left, right = ref[DAF_SITE - _DAF_FLANK:DAF_SITE], ref[DAF_SITE:DAF_SITE + _DAF_FLANK]
    fasta = directory / f"{name}.fa"
    fasta.write_text(f">{DAF_CHROM}\n{ref}\n")
    header = pysam.AlignmentHeader.from_dict({
        "HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": DAF_CHROM, "LN": len(ref)}],
        "PG": [{"ID": "minimap2", "PN": "minimap2", "VN": "2.28", "CL": "minimap2 -ax map-ont --MD -Y"}]})

    def convert(seq: str, base: str, product: str, rate: float) -> str:
        return "".join(product if b == base and rng.random() < rate else b for b in seq)

    unsorted = directory / f"{name}.unsorted.bam"
    with pysam.AlignmentFile(str(unsorted), "wb", header=header) as out:
        for i in range(n_ct + n_ga):
            ct = i < n_ct
            base, product = ("C", "T") if ct else ("G", "A")
            flank_l, flank_r = convert(left, base, product, 0.3), convert(right, base, product, 0.3)
            half = DAF_TE_LEN // 2
            insert = convert(te[:half], base, product, deamination) + te[half:]
            record = pysam.AlignedSegment(header)
            record.query_name = f"{'ct' if ct else 'ga'}{i:02d}"
            record.query_sequence = flank_l + insert + flank_r
            record.flag = 0
            record.reference_id = 0
            record.reference_start = DAF_SITE - _DAF_FLANK
            record.mapping_quality = 60
            record.cigartuples = [(0, _DAF_FLANK), (1, DAF_TE_LEN), (0, _DAF_FLANK)]
            record.query_qualities = array.array("B", [30] * len(record.query_sequence))
            record.set_tag("MD", _md(flank_l + flank_r, left + right))
            out.write(record)
    bam = directory / f"{name}.bam"
    pysam.sort("-o", str(bam), str(unsorted))
    pysam.index(str(bam))
    unsorted.unlink()
    return {"bam": str(bam), "fasta": str(fasta), "te": te, "open_half": DAF_TE_LEN // 2,
            "chrom": DAF_CHROM, "site": DAF_SITE}
