"""A synthetic targeted BAM for the Regions scan (fb-n13): two separated covered regions on one large
contig, with enough reads (> region_detect.PRECHECK_ABOVE) that its regions come from the BAM index.

usage: python make_two_region_bam.py out.bam [n_per_region]
Regions: chr21:30,000,000-30,100,000 and chr21:40,000,000-40,120,000 (3 kb reads); chr21 has hg38's
length, so the BAM fits an hg38 reference if one is loaded (the e2e tests may load it)."""
from __future__ import annotations

import sys

import pysam

CHROM, LENGTH = "chr21", 46_709_983
REGIONS = [(30_000_000, 30_100_000), (40_000_000, 40_120_000)]
READ_LEN = 3_000


def write(path: str, per_region: int = 11_000) -> str:
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": LENGTH}]}
    seq = "ACGT" * (READ_LEN // 4)
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        n = 0
        for lo, hi in REGIONS:
            step = max(1, (hi - lo - READ_LEN) / per_region)
            for i in range(per_region):
                a = pysam.AlignedSegment(out.header)
                a.query_name = f"r{n}"
                a.reference_id = 0
                a.reference_start = int(lo + i * step)
                a.cigartuples = [(0, READ_LEN)]
                a.query_sequence = seq
                a.mapping_quality = 60
                out.write(a)
                n += 1
    pysam.index(path)
    return path


if __name__ == "__main__":
    write(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 11_000)
