"""Regenerate the FIRE fixtures for the two supported progressions (not run by the test suite: needs the tools).

Usage::

    python make_fire_simple_fixtures.py --ft ft --ft-legacy ft-0.6.2 --workdir /tmp/fire_simple
    # FiberHMM importable and its CLIs on PATH (fiberhmm-apply)

Input: ``../fibertools_frame/fiberhmm3.0.0_call.bam`` (synthetic reads; FiberHMM 3.0.0 ``fiberhmm-call``), given an
aligner @PG upstream of its fiberhmm-call record as in a real run. Every tag is written by the real tool:

* ``fiberhmm_apply_scores.bam``       FiberHMM only: ``fiberhmm-apply --scores`` (its MSP posterior as ``aq``)
* ``call_then_ft013_fire.bam``        FiberHMM call -> ``ft fire`` (fibertools-rs 0.13: Ma/Aq, fire.Q)
* ``call_then_ft062_fire.bam``        FiberHMM call -> ``ft fire`` (fibertools-rs 0.6.2: legacy aq on as/al)
* ``apply_then_ft013_fire.bam``       ``fiberhmm-apply --scores`` -> ``ft fire`` 0.13
* ``apply_then_ft062_fire.bam``       ``fiberhmm-apply --scores`` -> ``ft fire`` 0.6.2

@PG / @CO paths are reduced to file names.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess

import pysam

HERE = os.path.dirname(os.path.abspath(__file__))
CALL = os.path.join(os.path.dirname(HERE), "fibertools_frame", "fiberhmm3.0.0_call.bam")
_PATH = re.compile(r"(?<![^\s=:])(?:/[^\s/]+)+/([^\s/]+)")


def normalise(src: str, dst: str) -> None:
    with pysam.AlignmentFile(src) as bam:
        header = bam.header.to_dict()
        for pg in header.get("PG", []):
            for key in ("CL", "DS"):
                if key in pg:
                    pg[key] = _PATH.sub(r"\1", str(pg[key]))
        header["CO"] = [_PATH.sub(r"\1", c) for c in header.get("CO", [])]
        header["PG"] = [pg for pg in header.get("PG", []) if pg.get("PN") != "samtools"]
        with pysam.AlignmentFile(dst, "wb", header=header) as out:
            for read in bam:
                out.write(read)
    pysam.index(dst)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ft", default="ft")
    ap.add_argument("--ft-legacy", default="ft-0.6.2")
    ap.add_argument("--workdir", required=True)
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)
    w = lambda name: os.path.join(args.workdir, name)
    with pysam.AlignmentFile(CALL) as src:
        header = src.header.to_dict()
        header["PG"] = ([{"ID": "pbmm2", "PN": "pbmm2", "VN": "1.17.0", "CL": "pbmm2 align ref.fa in.bam out.bam"}]
                        + [dict(pg, PP="pbmm2") if pg.get("ID") == "fiberhmm-call" else pg
                           for pg in header.get("PG", []) if pg.get("PN") != "samtools"])
        with pysam.AlignmentFile(w("call.bam"), "wb", header=header) as out:
            for read in src:
                out.write(read)
    pysam.index(w("call.bam"))
    subprocess.run(["fiberhmm-apply", "-i", w("call.bam"), "-o", w("apply"), "--enzyme", "hia5", "--seq", "pacbio",
                    "--force-seq", "--scores"], check=True)
    apply_bam = w("apply/call_footprints.bam")
    normalise(apply_bam, os.path.join(HERE, "fiberhmm_apply_scores.bam"))
    for name, src in (("call", w("call.bam")), ("apply", apply_bam)):
        for tag, ft in (("ft013", args.ft), ("ft062", args.ft_legacy)):
            out = w(f"{name}_{tag}.bam")
            subprocess.run([ft, "fire", "-t", "1", src, out], check=True)
            normalise(out, os.path.join(HERE, f"{name}_then_{tag}_fire.bam"))
    shutil.rmtree(args.workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
