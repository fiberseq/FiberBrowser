"""Tiny synthetic inputs for real fiberhmm-pipeline runs (no real reads, names or loci).

A random genome, DAF-seq (DddB-like) FASTQ reads with C->T deaminations
outside nucleosome-sized protected stretches, and an aligned PacBio Hia5
Fiber-seq BAM with MM/ML m6A calls (A+a and T-a) in the linkers.
"""
from __future__ import annotations

import array
import random

COMPLEMENT = str.maketrans("ACGT", "TGCA")
NUC_PERIOD, NUC_SIZE = 200, 147  # a protected stretch, then a linker


def revcomp(seq: str) -> str:
    return seq.translate(COMPLEMENT)[::-1]


def random_genome(contigs=(("chrA", 20_000), ("chrB", 10_000)), seed: int = 21) -> dict[str, str]:
    rng = random.Random(seed)
    return {name: "".join(rng.choice("ACGT") for _ in range(length)) for name, length in contigs}


def write_fasta(path, genome: dict[str, str]) -> str:
    with open(path, "w") as handle:
        for name, seq in genome.items():
            handle.write(f">{name}\n")
            for i in range(0, len(seq), 80):
                handle.write(seq[i:i + 80] + "\n")
    return str(path)


def _protected(i: int, offset: int) -> bool:
    return (i + offset) % NUC_PERIOD < NUC_SIZE


def daf_reads(genome: dict[str, str], n: int = 60, seed: int = 22, length=(1500, 2600),
              contig: str = "chrA") -> list[tuple[str, str]]:
    """(name, sequence) DddB-like reads: C->T on the read's own strand, rare in protected stretches."""
    rng = random.Random(seed)
    ref = genome[contig]
    reads = []
    for i in range(n):
        size = rng.randint(*length)
        start = rng.randrange(0, len(ref) - size)
        mol = ref[start:start + size]
        strand = mol if rng.random() < 0.5 else revcomp(mol)
        offset = rng.randrange(NUC_PERIOD)
        out = list(strand)
        for j, base in enumerate(out):
            if base == "C" and rng.random() < (0.005 if _protected(j, offset) else 0.08):
                out[j] = "T"
        reads.append((f"m{i}", "".join(out)))
    return reads


def write_fastq(path, reads: list[tuple[str, str]]) -> str:
    with open(path, "w") as handle:
        for name, seq in reads:
            handle.write(f"@{name}\n{seq}\n+\n{'I' * len(seq)}\n")
    return str(path)


def write_hia5_pacbio_bam(path, genome: dict[str, str], n: int = 40, seed: int = 23, length=(3000, 6000),
                          contig: str = "chrA", aligned: bool = True) -> list[str]:
    """An aligned, sorted, indexed PacBio Hia5 BAM (forward-strand reads, full-length matches) with
    m6A in MM/ML: A+a on this strand, T-a for the other, dense in linkers. Returns the read names.

    ``aligned=False``: the same reads unaligned (as a PacBio instrument delivers them, no index)."""
    import pysam

    rng = random.Random(seed)
    ref = genome[contig]
    header = {"HD": {"VN": "1.6", "SO": "coordinate"},
              "SQ": [{"SN": name, "LN": len(seq)} for name, seq in genome.items()],
              "RG": [{"ID": "synthetic", "SM": "synthetic", "PL": "PACBIO"}]}
    records = []
    for i in range(n):
        size = rng.randint(*length)
        start = rng.randrange(0, len(ref) - size)
        seq = ref[start:start + size]
        offset = rng.randrange(NUC_PERIOD)
        mods: dict[str, list[tuple[int, int]]] = {"A": [], "T": []}
        for j, base in enumerate(seq):
            if base in mods:
                p = 0.02 if _protected(j, offset) else 0.6
                if rng.random() < p:
                    mods[base].append((j, rng.randint(220, 255)))
        mm, ml = [], []
        for base, code in (("A", "A+a."), ("T", "T-a.")):
            positions = [j for j, b in enumerate(seq) if b == base]
            rank = {p: k for k, p in enumerate(positions)}
            deltas, last = [], -1
            for j, q in mods[base]:
                deltas.append(rank[j] - last - 1)
                last = rank[j]
                ml.append(q)
            mm.append(",".join([code, *map(str, deltas)]) + ";")
        records.append((start, f"fiber{i}", seq, "".join(mm), ml))
    records.sort()
    if not aligned:
        header = {"HD": {"VN": "1.6", "SO": "unknown"}, "RG": header["RG"]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for start, name, seq, mm, ml in records:
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.query_sequence = name, seq
            if aligned:
                r.flag = 0
                r.reference_id, r.reference_start, r.mapping_quality = out.get_tid(contig), start, 60
                r.cigarstring = f"{len(seq)}M"
            else:
                r.flag = 4
            r.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
            r.set_tag("MM", mm, "Z")
            r.set_tag("ML", array.array("B", ml))
            r.set_tag("RG", "synthetic", "Z")
            out.write(r)
    if aligned:
        pysam.index(str(path))
    return [name for _, name, *_ in records]


def write_daf_aligned_bam(path, genome: dict[str, str], n: int = 40, seed: int = 24, length=(1500, 2600),
                          contig: str = "chrA") -> list[str]:
    """An aligned, sorted, indexed DddB-like Nanopore BAM with MD tags (as `minimap2 --MD` writes it):
    full-length forward alignments, half the molecules deaminated C->T and half G->A (the other strand),
    rare in protected stretches. Returns the read names."""
    import pysam

    rng = random.Random(seed)
    ref = genome[contig]
    header = {"HD": {"VN": "1.6", "SO": "coordinate"},
              "SQ": [{"SN": name, "LN": len(seq)} for name, seq in genome.items()],
              "RG": [{"ID": "synthetic", "SM": "synthetic", "PL": "ONT"}]}
    records = []
    for i in range(n):
        size = rng.randint(*length)
        start = rng.randrange(0, len(ref) - size)
        mol = ref[start:start + size]
        target, product = ("C", "T") if i % 2 == 0 else ("G", "A")
        offset = rng.randrange(NUC_PERIOD)
        seq = [product if b == target and rng.random() < (0.005 if _protected(j, offset) else 0.08) else b
               for j, b in enumerate(mol)]
        md, run = [], 0
        for b, q in zip(mol, seq):
            if b == q:
                run += 1
            else:
                md += [str(run), b]
                run = 0
        md.append(str(run))
        records.append((start, f"daf{i}", "".join(seq), "".join(md), sum(a != b for a, b in zip(mol, seq))))
    records.sort()
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for start, name, seq, md, nm in records:
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.query_sequence, r.flag = name, seq, 0
            r.reference_id, r.reference_start, r.mapping_quality = out.get_tid(contig), start, 60
            r.cigarstring = f"{len(seq)}M"
            r.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
            r.set_tag("MD", md, "Z")
            r.set_tag("NM", nm, "i")
            r.set_tag("RG", "synthetic", "Z")
            out.write(r)
    pysam.index(str(path))
    return [name for _, name, *_ in records]
