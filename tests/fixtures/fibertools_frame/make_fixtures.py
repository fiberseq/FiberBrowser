"""Regenerate the fibertools/FiberHMM reverse-strand frame fixtures.

Not run by the test suite (it needs external tools). Usage::

    python make_fixtures.py --ft ft --ft-legacy /path/to/ft-0.6.2 --workdir /tmp/ftframe

Inputs are synthetic but every annotation tag is written by the real tool:

* ``input``: one forward and one reverse read over the same 8 kb of a random
  contig ``chrT`` (3000M-style full match), m6A (MM ``A+a``/ML 255) on every A
  of the *original* strand except inside ~25 asymmetric m6A-free "nucleosome"
  gaps (``truth.gaps``, genomic half-open).
* ``ft0.13_addnuc_fire.bam``: ``ft add-nucleosomes`` then ``ft fire``
  (fibertools-rs 0.13.0). Writes only ``Ma``/``Aq`` (nuc, msp, fire.Q).
* ``ft0.13_predict_m6a.bam``: ``ft predict-m6a`` (0.13.0) on the same reads with
  random HiFi kinetics instead of MM/ML. Writes MM/ML plus ``Ma``.
* ``ft0.6.2_addnuc_fire.bam``: ``ft add-nucleosomes`` then ``ft fire`` from
  fibertools-rs 0.6.2 (legacy ``ns/nl/as/al/aq`` tags).
* ``fiberhmm3.0.0_call.bam``: ``fiberhmm-call --enzyme hia5 --seq pacbio``
  (FiberHMM 3.0.0). Writes ``MA/AQ/AN`` and legacy ``ns/nl/as/al/nq``.

``expected.json`` holds, per fixture and read, the reference-coordinate
nucleosome/MSP intervals reported by ``ft extract -r`` (fibertools' own
molecular->reference conversion) and the FIRE elements (interval, Aq/aq) from
``ft fire --extract``-equivalent parsing, so the tests never need ``ft``.
@PG command lines are normalised to drop local paths (PN/ID/VN are kept).
"""
from __future__ import annotations

import argparse
import array
import json
import os
import random
import subprocess
import sys

import pysam

HERE = os.path.dirname(os.path.abspath(__file__))
L = 8000
RC = str.maketrans("ACGT", "TGCA")


def make_input(path: str, kinetics: bool) -> dict:
    random.seed(11)
    ref = "".join(random.choice("ACGT") for _ in range(L))
    gaps, p = [], 300
    while p < L - 400:
        ln = random.choice([147, 150, 155, 160])
        gaps.append((p, p + ln))
        p += ln + random.choice([20, 35, 50, 80, 200, 400])

    def in_gap(g):
        return any(a <= g < b for a, b in gaps)

    hdr = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": L}]}
    if kinetics:
        hdr["RG"] = [{"ID": "rg1", "PL": "PACBIO", "PM": "REVIO", "DS": (
            "READTYPE=CCS;Ipd:Frames=ip;PulseWidth:Frames=pw;BINDINGKIT=102-739-100;"
            "SEQUENCINGKIT=102-118-800;BASECALLERVERSION=5.0.0;FRAMERATEHZ=100.000000")}]
    with pysam.AlignmentFile(path, "wb", header=hdr) as bam:
        for name, rev in (("read_fwd", False), ("read_rev", True)):
            orig = ref.translate(RC)[::-1] if rev else ref
            meth = [not in_gap((L - 1 - i) if rev else i) for i, b in enumerate(orig) if b == "A"]
            called = [k for k, m in enumerate(meth) if m]
            skips, prev = [], -1
            for k in called:
                skips.append(k - prev - 1)
                prev = k
            r = pysam.AlignedSegment()
            r.query_name, r.query_sequence, r.flag = name, ref, 16 if rev else 0
            r.reference_id, r.reference_start, r.mapping_quality = 0, 0, 60
            r.cigartuples = [(0, L)]
            r.query_qualities = pysam.qualitystring_to_array("I" * L)
            if kinetics:
                for t in ("fi", "fp", "ri", "rp"):
                    r.set_tag(t, array.array("B", [random.randint(5, 60) for _ in range(L)]))
                r.set_tag("fn", 10, "i")
                r.set_tag("rn", 10, "i")
                r.set_tag("RG", "rg1")
            else:
                r.set_tag("MM", "A+a," + ",".join(map(str, skips)) + ";", "Z")
                r.set_tag("ML", array.array("B", [255] * len(called)))
            bam.write(r)
    pysam.index(path)
    return {"L": L, "gaps": gaps}


def normalise(src: str, dst: str) -> None:
    """Copy ``src`` to ``dst`` with @PG CL paths reduced to the program basename."""
    with pysam.AlignmentFile(src) as bam:
        hdr = bam.header.to_dict()
        pgs = []
        for pg in hdr.get("PG", []):
            if pg.get("PN") == "samtools":
                continue
            cl = pg.get("CL")
            if cl:
                words = cl.split()
                words = [os.path.basename(w) if "/" in w else w for w in words]
                pg["CL"] = " ".join(words)
            pgs.append(pg)
        hdr["PG"] = pgs
        with pysam.AlignmentFile(dst, "wb", header=hdr) as out:
            for r in bam:
                out.write(r)
    pysam.index(dst)


def ft_extract_ref(ft: str, bam: str, kind: str) -> dict:
    out = subprocess.run([ft, "extract", "-r", f"--{kind}", "-", bam],
                         capture_output=True, text=True, check=True).stdout
    res = {}
    for line in out.splitlines():
        f = line.split("\t")
        cs = int(f[1])
        sizes = [int(x) for x in f[10].strip(",").split(",")]
        starts = [int(x) for x in f[11].strip(",").split(",")]
        # ft bed12 rows carry a zero/one-length anchor block at each fiber end.
        res[f[3]] = sorted([cs + s, cs + s + z] for s, z in list(zip(starts, sizes))[1:-1])
    return res


def ft_fire_elements(ft: str, bam: str) -> dict:
    """FIRE elements (reference start, end, Aq/aq byte) via ``ft fire --extract``."""
    out = subprocess.run([ft, "fire", "--extract", bam], capture_output=True, text=True, check=True).stdout
    res = {}
    for line in out.splitlines():
        f = line.split("\t")
        if f[8] == "147,112,219":  # MSPs that are not FIRE elements
            continue
        res.setdefault(f[3], []).append([int(f[1]), int(f[2]), round(255 - float(f[9]) * 255)])
    return {k: sorted(v) for k, v in res.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ft", default="ft", help="fibertools-rs 0.13 binary")
    ap.add_argument("--ft-legacy", required=True, help="fibertools-rs 0.6.2 binary (legacy ns/nl tags)")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--python", default=sys.executable, help="python with FiberHMM 3.0 importable")
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)
    w = lambda n: os.path.join(a.workdir, n)  # noqa: E731
    run = lambda *c: subprocess.run(list(c), check=True)  # noqa: E731

    truth = make_input(w("input.bam"), kinetics=False)
    make_input(w("kinetics.bam"), kinetics=True)

    run(a.ft, "add-nucleosomes", "-t", "1", w("input.bam"), w("n13.bam"))
    run(a.ft, "fire", "-t", "1", w("n13.bam"), w("f13.bam"))
    run(a.ft, "predict-m6a", "-t", "1", w("kinetics.bam"), w("p13.bam"))
    run(a.ft_legacy, "add-nucleosomes", "-t", "1", w("input.bam"), w("n062.bam"))
    run(a.ft_legacy, "fire", "-t", "1", w("n062.bam"), w("f062.bam"))
    run(a.python, "-m", "fiberhmm.cli.call", "-i", w("input.bam"), "-o", w("fhmm.bam"),
        "--enzyme", "hia5", "--seq", "pacbio", "-c", "1", "--no-qc")

    fixtures = {
        "ft0.13_addnuc_fire.bam": w("f13.bam"),
        "ft0.13_predict_m6a.bam": w("p13.bam"),
        "ft0.6.2_addnuc_fire.bam": w("f062.bam"),
        "fiberhmm3.0.0_call.bam": w("fhmm.bam"),
    }
    expected = {"truth": truth, "fixtures": {}}
    for name, src in fixtures.items():
        dst = os.path.join(HERE, name)
        normalise(src, dst)
        entry = {"nuc": ft_extract_ref(a.ft, dst, "nuc"), "msp": ft_extract_ref(a.ft, dst, "msp")}
        if "fire" in name:
            entry["fire"] = ft_fire_elements(a.ft, dst)
        if name.startswith("ft0.6.2"):
            # The legacy binary's own conversion must agree with 0.13's reading of legacy tags.
            assert entry["nuc"] == ft_extract_ref(a.ft_legacy, dst, "nuc")
            assert entry["msp"] == ft_extract_ref(a.ft_legacy, dst, "msp")
        expected["fixtures"][name] = entry
    with open(os.path.join(HERE, "expected.json"), "w") as fh:
        json.dump(expected, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main()
