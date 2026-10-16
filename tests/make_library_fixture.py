"""Write a small folder of FiberHMM-like files for the Library e2e spec and docs.

    python tests/make_library_fixture.py OUTDIR           # the e2e spec's two BAMs
    python tests/make_library_fixture.py OUTDIR --demo    # a small lab folder for screenshots

Default: OUTDIR/exp1/sampleA.fiberhmm.bam (+ qc/sampleA.fiberhmm.qc.json, WARN)
and OUTDIR/exp1/sampleB.fiberhmm.bam, on a 50-kb contig no catalog genome has.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from library_fixtures import (  # noqa: E402
    make_fiberhmm_bam, make_fibertools_bam, make_pipeline_run, seq, write_qc_json,
)

DM6 = (("chr2L", 23_513_712), ("chr2R", 25_286_936), ("chr3L", 28_110_227), ("chrX", 23_542_271))


def e2e(outdir: str) -> None:
    contigs = (("chrTest", 50_000),)
    make_fiberhmm_bam(os.path.join(outdir, "exp1", "sampleA.fiberhmm.bam"), contigs=contigs, sample="sampleA", n_reads=40)
    write_qc_json(os.path.join(outdir, "exp1", "qc", "sampleA.fiberhmm.qc.json"), overall="WARN")
    make_fiberhmm_bam(os.path.join(outdir, "exp1", "sampleB.fiberhmm.bam"), contigs=contigs, sample="sampleB", n_reads=40)


def demo(outdir: str) -> None:
    course = os.path.join(outdir, "embryo_time_course")
    for name, date, verdict, reads in (("embryo_2-4h", "2026-08-04", "PASS", 60), ("embryo_4-6h", "2026-08-04", "WARN", 45),
                                       ("embryo_6-8h", "2026-08-05", "PASS", 80)):
        make_fiberhmm_bam(os.path.join(course, f"{name}.fiberhmm.dddb.bam"), contigs=DM6, sample=name, date=date,
                          n_reads=reads)
        write_qc_json(os.path.join(course, "qc", f"{name}.fiberhmm.dddb.qc.json"), overall=verdict,
                      periodicity=verdict)
    make_pipeline_run(os.path.join(outdir, "reporter_plasmid", "pGAF_reporter"), sample="pGAF_reporter",
                      plasmid_seq=seq(42, 5200))
    make_fibertools_bam(os.path.join(outdir, "fiberseq", "S2_hia5.bam"), contigs=DM6, sample="S2_hia5", n_reads=30)


if __name__ == "__main__":
    (demo if "--demo" in sys.argv[2:] else e2e)(sys.argv[1])
