#!/usr/bin/env python3
"""A raw Nanopore run for the POD5 Playwright spec (daf-run-pod5.spec.ts).

``make_pod5_fixture.py DIR`` writes into DIR:

  genome.fa              a 20 kb random contig (chrA)
  reads.json             40 Hia5-like m6A Nanopore reads (1.5-3 kb, MM/ML) for the fake dorado
  yw_2_4h/pod5/*.pod5    a MinKNOW-style raw folder (stand-in bytes: the fake dorado never reads them)
  bin/dorado             tests/fake_dorado.py with this interpreter's shebang

and prints the paths as JSON. The reads follow FiberHMM's own POD5 test
(tests/test_pipeline_provenance.py: _genome, _m6a_reads), at least 1000 bp so the
pipeline's default --min-read-length keeps them.
"""
from __future__ import annotations

import json
import os
import random
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COMP = str.maketrans("ACGT", "TGCA")


def _revcomp(seq):
    return seq.translate(COMP)[::-1]


def _genome(n=20000, seed=61):
    rng = random.Random(seed)
    return "".join(rng.choice("ACGT") for _ in range(n))


def _m6a_reads(genome, n, seed, prefix="read"):
    """Hia5-like Nanopore reads: A+a calls, high ML in linkers, low in nucleosome-sized stretches."""
    rng = random.Random(seed)
    reads = []
    for i in range(n):
        size = rng.randint(1500, 3000)
        start = rng.randrange(0, len(genome) - size)
        mol = genome[start:start + size]
        seq = mol if rng.random() < 0.5 else _revcomp(mol)
        ml = []
        for j, base in enumerate(seq):
            if base == "A":
                protected = ((start + j) // 180) % 2 == 0
                ml.append(rng.randint(0, 40) if protected or rng.random() > 0.5 else rng.randint(240, 255))
        mm = "A+a?," + ",".join("0" for _ in ml) + ";" if ml else "A+a?;"
        reads.append({"name": f"{prefix}{i}", "seq": seq, "mm": mm, "ml": ml})
    return reads


def main(argv) -> int:
    out = os.path.abspath(argv[1])
    os.makedirs(out, exist_ok=True)
    genome = _genome()
    fasta = os.path.join(out, "genome.fa")
    with open(fasta, "w") as handle:
        handle.write(">chrA\n" + genome + "\n")
    reads = os.path.join(out, "reads.json")
    with open(reads, "w") as handle:
        json.dump(_m6a_reads(genome, 40, 62), handle)
    pod5 = os.path.join(out, "yw_2_4h", "pod5")
    os.makedirs(pod5, exist_ok=True)
    with open(os.path.join(pod5, "batch0.pod5"), "wb") as handle:
        handle.write(b"POD5 stand-in")
    dorado = os.path.join(out, "bin", "dorado")
    os.makedirs(os.path.dirname(dorado), exist_ok=True)
    with open(os.path.join(HERE, "fake_dorado.py")) as source, open(dorado, "w") as handle:
        handle.write(f"#!{sys.executable}\n" + source.read())
    os.chmod(dorado, os.stat(dorado).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(json.dumps({"fasta": fasta, "reads": reads, "pod5": pod5, "dorado": dorado,
                      "models": os.path.join(out, "models"), "log": os.path.join(out, "dorado_calls.jsonl")}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
