"""A synthetic reference for the demo BAM (browser/data/demo/napa_ddda.bam): every contig of its header at
its own length, all N except chr19, whose bases are random (seeded) with a planted sequence on each strand
near the demo locus. Written bgzip-compressed with its .fai and .gzi (a few MB), so the demo BAM fits the
reference (no genome-mismatch banner) and no spec needs hg38 to run on the demo data.

Used by the Find sequence e2e spec (browser/frontend/tests/e2e/sequence-search.spec.ts), and as
FIBERBROWSER_TEST_FASTA for other demo-BAM specs on a scratch HOME.

    python tests/make_seqsearch_fasta.py OUT.fa.gz      # prints the planted sequence and its loci as JSON
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np
import pysam

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_BAM = os.path.join(ROOT, "browser", "data", "demo", "napa_ddda.bam")
PLANT = "GATTACAGGCTTCAAGTCCGTAGCA"      # 25 bp: under the exact-search cutoff, not its own reverse complement
PLUS_AT = 47_515_500                     # 0-based starts, inside the demo locus chr19:47,514,000-47,518,000
MINUS_AT = 47_516_800
LINE = 60
SEED = 20261119


def _rc(seq: str) -> str:
    return seq.translate(str.maketrans("ACGT", "TGCA"))[::-1]


def _write_contig(out, name: str, length: int, seq: np.ndarray | None) -> None:
    out.write(f">{name}\n".encode())
    if seq is None:
        block_lines = 100_000
        block = (b"N" * LINE + b"\n") * block_lines
        full, rest = divmod(length, LINE)
        for _ in range(full // block_lines):
            out.write(block)
        out.write((b"N" * LINE + b"\n") * (full % block_lines))
        if rest:
            out.write(b"N" * rest + b"\n")
        return
    raw = seq.tobytes()
    for i in range(0, length, LINE * 100_000):
        piece = raw[i:i + LINE * 100_000]
        out.write(b"".join(piece[j:j + LINE] + b"\n" for j in range(0, len(piece), LINE)))


def make(out_path: str) -> dict:
    header = pysam.AlignmentFile(DEMO_BAM)
    contigs = list(zip(header.references, header.lengths))
    header.close()
    rng = np.random.default_rng(SEED)
    letters = np.frombuffer(b"ACGT", dtype=np.uint8)
    proc = subprocess.Popen(["bgzip", "-c", "-@", "4", "-i", "-I", out_path + ".gzi"],
                            stdin=subprocess.PIPE, stdout=open(out_path, "wb"))
    try:
        for name, length in contigs:
            seq = None
            if name == "chr19":
                seq = letters[rng.integers(0, 4, size=length)]
                seq[PLUS_AT:PLUS_AT + len(PLANT)] = np.frombuffer(PLANT.encode(), dtype=np.uint8)
                seq[MINUS_AT:MINUS_AT + len(PLANT)] = np.frombuffer(_rc(PLANT).encode(), dtype=np.uint8)
            _write_contig(proc.stdin, name, int(length), seq)
    finally:
        proc.stdin.close()
        proc.wait()
    if proc.returncode != 0:
        raise SystemExit(f"bgzip failed ({proc.returncode})")
    pysam.faidx(out_path)
    return {"fasta": out_path, "plant": PLANT,
            "hits": [{"chrom": "chr19", "start": PLUS_AT, "end": PLUS_AT + len(PLANT), "strand": "+"},
                     {"chrom": "chr19", "start": MINUS_AT, "end": MINUS_AT + len(PLANT), "strand": "-"}]}


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].endswith(".gz"):
        raise SystemExit("usage: make_seqsearch_fasta.py OUT.fa.gz")
    print(json.dumps(make(sys.argv[1])))
