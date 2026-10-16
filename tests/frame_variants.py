"""Header/MA variants of the demo slice for the frame tests (tests/test_frame_variants.py) and the one-off
differential run against the pre-7bb69ed8 loaders."""
from __future__ import annotations

import re
from pathlib import Path

import pysam

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
REGION = ("chr19", 47514000, 47520000)
CHEM = "FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf"
_FOOTPRINT_GROUP = re.compile(r";(nuc|msp|tf)([.+])")


def plus(ma: str) -> str:
    """FiberHMM <= 2.13.1 spelling: '+' footprint groups."""
    return _FOOTPRINT_GROUP.sub(lambda m: f";{m.group(1)}+", ma)


def dot(ma: str) -> str:
    return _FOOTPRINT_GROUP.sub(lambda m: f";{m.group(1)}.", ma)


def with_m5c(ma: str) -> str:
    """tag-m5c appends a '.' ddda_mcg group (no quality bytes) to a read's MA."""
    return ma + ";ddda_mcg.:1-5"


def base_header() -> dict:
    header = pysam.AlignmentFile(str(DEMO)).header.to_dict()
    header.pop("PG", None)
    header["CO"] = []
    return header


def pg(ident, version, ds="", pp=None, cl=None):
    record = {"ID": ident, "PN": ident.split(".")[0], "VN": version, "CL": cl or f"{ident.split('.')[0]} -i in.bam -o out.bam"}
    if ds:
        record["DS"] = ds
    if pp:
        record["PP"] = pp
    return record


# name -> (header extras, MA rewrite per read (index -> function))
VARIANTS = {
    # FiberHMM <= 2.12: unmarked recall-tfs, '+' groups, SEQ frame.
    "v2_12": ({"PG": [pg("fiberhmm-recall-tfs", "2.6.7")]}, lambda i: plus),
    # FiberHMM 2.13.0-2.13.1: '+' groups, molecular, declared in @PG DS.
    "v2_13_1": ({"PG": [pg("fiberhmm-call", "2.13.1", "FiberHMM fused apply+recall; coord=molecular")]}, lambda i: plus),
    # FiberHMM >= 2.13.2 / 3.0: '.' groups, molecular, declared in @PG DS, CHEMISTRY in @CO.
    "v3": ({"PG": [pg("fiberhmm-call", "3.0.0", "FiberHMM fused apply+recall; coord=molecular")], "CO": [CHEM]},
           lambda i: dot),
    # merge --recall: recalled reads ('.') and historical reads passed through ('+', SEQ) from an unmarked
    # FiberHMM 2.x chain; the merge declares coord=molecular and CHEMISTRY.
    "merge_recall": ({"PG": [pg("fiberhmm-apply", "2.6.7"),
                             pg("fiberhmm-merge", "3.0.0", "merge with recall; coord=molecular")],
                      "CO": [CHEM]},
                     lambda i: dot if i % 2 == 0 else plus),
    # Historical SEQ-frame reads that tag-m5c later gave a '.' ddda_mcg group (pass-through: no coord).
    "m5c_historical": ({"PG": [pg("fiberhmm-recall-tfs", "2.6.7"),
                               pg("fiberhmm-tag-m5c", "3.0.0", "DddA molecule-specific mCG; ddda_mcg_frame=molecular",
                                  pp="fiberhmm-recall-tfs")]},
                       lambda i: (lambda ma: with_m5c(plus(ma)))),
}


def write_variant(tmp_path, name: str, strip: str = "", n: int = 20) -> str:
    """The demo slice with a variant's header and MA spelling. ``strip``: '' (as written), 'pg' (@PG removed)
    or 'all' (@PG and @CO removed)."""
    extras, rewrite = VARIANTS[name]
    header = {**base_header(), **{k: list(v) for k, v in extras.items()}}
    if strip in ("pg", "all"):
        header.pop("PG", None)
    if strip == "all":
        header.pop("CO", None)
    return _write(tmp_path, f"{name}_{strip or 'full'}", header, rewrite, n)


def write_reference(tmp_path, frame: str, n: int = 20) -> str:
    """Every tag read in one frame: 'molecular' (declared, '.' groups) or 'seq' (no header, '+' groups)."""
    header = base_header()
    if frame == "molecular":
        header["CO"] = ["fiberhmm:coord=molecular"]
        return _write(tmp_path, "ref_molecular", header, lambda i: dot, n)
    header.pop("CO", None)
    return _write(tmp_path, "ref_seq", header, lambda i: plus, n)


def _write(tmp_path, stem, header, rewrite, n) -> str:
    src = pysam.AlignmentFile(str(DEMO))
    path = Path(tmp_path) / f"{stem}.bam"
    kept = {True: 0, False: 0}
    index = 0
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in src.fetch(*REGION):
            if not read.has_tag("MA") or kept[read.is_reverse] >= n:
                continue
            kept[read.is_reverse] += 1
            record = pysam.AlignedSegment.from_dict(read.to_dict(), out.header)
            record.set_tag("MA", rewrite(index)(record.get_tag("MA")), "Z")
            index += 1
            out.write(record)
    pysam.index(str(path))
    return str(path)


def reverse_ids() -> list[str]:
    return [r.query_name for r in pysam.AlignmentFile(str(DEMO)).fetch(*REGION) if r.is_reverse]
