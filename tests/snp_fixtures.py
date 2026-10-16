"""An explicitly synthetic Fiber-seq BAM with two SNPs and three allele combinations (the Variants panel).

``write_snp_bam(path)`` writes a sorted, indexed BAM on ``chrSNP`` (20 kb), and ``write_snp_fasta(path)`` its
reference. Two SNPs, ``SNP1`` and ``SNP2`` (0-based), and three haplotypes:

- ``hapR``: reference at both (14 reads),
- ``hapA``: alternate at both (10 reads),
- ``hapM``: alternate at SNP1, reference at SNP2 (8 reads),

all spanning both SNPs, forward and reverse alternating; plus ``part*`` reads (3) that cover SNP1 only (reference
there) for partial coverage. Reads carry m6A ``MM``/``ML`` marks and FiberHMM-style calls (tests/sv_fixtures.py), so
the browser draws them. Pure pysam, so backend tests and the e2e spec share it.
"""
from __future__ import annotations

import array
import random
from pathlib import Path

import pysam

import sv_fixtures as svf

CHROM = "chrSNP"
CHROM_LEN = 20_000
SNP1 = 8_000
SNP2 = 9_000
READ_START = 6_000
READ_END = 12_000
VIEW = (7_000, 11_000)
HAPLOTYPES = {"hapR": (False, False, 14), "hapA": (True, True, 10), "hapM": (True, False, 8)}
_OTHER = {"A": "G", "C": "A", "G": "T", "T": "G"}  # transversions or A>G: never DAF-like


def reference_sequence(seed: int = 5) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice("ACGT") for _ in range(CHROM_LEN))


def alleles() -> dict:
    ref = reference_sequence()
    return {SNP1: (ref[SNP1], _OTHER[ref[SNP1]]), SNP2: (ref[SNP2], _OTHER[ref[SNP2]])}


def _haplotype(ref: str, alt1: bool, alt2: bool) -> str:
    seq = list(ref)
    table = alleles()
    if alt1:
        seq[SNP1] = table[SNP1][1]
    if alt2:
        seq[SNP2] = table[SNP2][1]
    return "".join(seq)


def snp_read_specs(seed: int = 3) -> list[dict]:
    ref = reference_sequence()
    rng = random.Random(seed)
    specs = []
    for hap, (a1, a2, n) in HAPLOTYPES.items():
        seq = _haplotype(ref, a1, a2)
        for i in range(n):
            start = READ_START + (i % 5) * 37
            cigar = [(0, READ_END - start - (i % 3) * 11)]
            specs.append(svf._read_spec(seq, f"snp/{hap}{i}/ccs", start, cigar, bool(i % 2), rng))
    for i in range(3):
        start = SNP1 - 1_500 + i * 10
        specs.append(svf._read_spec(ref, f"snp/part{i}/ccs", start, [(0, 2_000)], bool(i % 2), rng))
    return specs


def expected_groups() -> dict:
    return {hap: {f"snp/{hap}{i}/ccs" for i in range(n)} for hap, (_a, _b, n) in HAPLOTYPES.items()}


def write_snp_fasta(path) -> str:
    path = Path(path)
    seq = reference_sequence()
    with open(path, "w") as fh:
        fh.write(f">{CHROM}\n")
        for i in range(0, len(seq), 80):
            fh.write(seq[i:i + 80] + "\n")
    pysam.faidx(str(path))
    return str(path)


def write_reads(path, specs, chrom: str = CHROM, length: int = CHROM_LEN, header_extra: dict | None = None) -> str:
    path = Path(path)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": chrom, "LN": length}],
              "PG": [svf.PG_MOLECULAR], "CO": [svf.CHEMISTRY_CO]}
    header.update(header_extra or {})
    unsorted = str(path) + ".unsorted.bam"
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for spec in specs:
            a = pysam.AlignedSegment(out.header)
            a.query_name = spec["name"]
            a.query_sequence = spec["seq"]
            a.query_qualities = pysam.qualitystring_to_array(spec.get("qual") or "I" * len(spec["seq"]))
            a.flag = spec["flag"]
            a.reference_id = 0
            a.reference_start = spec["start"]
            a.mapping_quality = 60
            a.cigartuples = spec["cigar"]
            for tag, value in spec.get("tags", []):
                if isinstance(value, list):
                    value = array.array("B" if tag in ("AQ", "ML") else "I", value)
                a.set_tag(tag, value)
            out.write(a)
    pysam.sort("-o", str(path), unsorted)
    Path(unsorted).unlink()
    pysam.index(str(path))
    return str(path)


def write_snp_bam(path, seed: int = 3) -> str:
    return write_reads(path, snp_read_specs(seed))
