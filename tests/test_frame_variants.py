"""Frames of historical and current FiberHMM files, with and without their @PG history (3.0.0 release).

The conservative rule (after Codex's review of 7bb69ed8):
- MA: each annotation group by its own strand: "." is molecular; "+"/"-" follow the header (coord=molecular).
- Legacy ns/nl/as/al: the @PG chain rule first (unchanged); only with no @PG evidence, "." footprint groups
  (nuc/msp/tf, not m5C) on the same read mean molecular, else SEQ (the file check warns). FIBERHMM-CHEMISTRY
  never decides (merge and pair add it while passing historical reads through), as in FiberHMM.
With their @PG chain every variant reads exactly as before 7bb69ed8 (checked once against the pre-7bb69ed8
loaders: 0 differences over compact, dense and DAF-C for all the variants below); the table here pins that.

Each variant's reverse reads are compared, loader by loader, with the same reads read entirely in molecular or
entirely in SEQ frame.
"""
import pysam
import pytest

import frame_variants as fv
from frame_dump import dump
from services.bam_tags import bam_legacy_frame, bam_ma_aq_tags_are_molecular, read_legacy_tags_are_molecular
from services.compact_read_loader import ma_footprint_query_spans

pytestmark = pytest.mark.skipif(not fv.DEMO.exists(), reason="demo BAM not present")

M, S = "molecular", "seq"


def _dot(read):
    return ";nuc." in read.get_tag("MA") or ";msp." in read.get_tag("MA") or ";tf." in read.get_tag("MA")


# (variant, strip) -> function(read has '.' footprint groups) -> (legacy frame, MA frame)
EXPECTED = {
    ("v2_12", ""): lambda dot: (S, S),
    ("v2_12", "pg"): lambda dot: (S, S),
    ("v2_12", "all"): lambda dot: (S, S),
    ("v2_13_1", ""): lambda dot: (M, M),
    # "+" groups and no declaration left: SEQ (the one historical case @PG stripping still loses).
    ("v2_13_1", "pg"): lambda dot: (S, S),
    ("v2_13_1", "all"): lambda dot: (S, S),
    ("v3", ""): lambda dot: (M, M),
    ("v3", "pg"): lambda dot: (M, M),          # "." footprint groups on each read
    ("v3", "all"): lambda dot: (M, M),         # "." footprint groups on each read
    ("merge_recall", ""): lambda dot: (M, M),  # as before 7bb69ed8: the merge's coord=molecular decides
    # Historical reads passed through by merge --recall read SEQ although the header declares CHEMISTRY.
    ("merge_recall", "pg"): lambda dot: (M if dot else S, M if dot else S),
    ("merge_recall", "all"): lambda dot: (M if dot else S, M if dot else S),
    ("m5c_historical", ""): lambda dot: (S, S),
    ("m5c_historical", "pg"): lambda dot: (S, S),   # an m5C "." group does not make the footprints molecular
    ("m5c_historical", "all"): lambda dot: (S, S),
}


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("frames")
    paths = {key: fv.write_variant(tmp, key[0], key[1]) for key in EXPECTED}
    refs = {M: fv.write_reference(tmp, M), S: fv.write_reference(tmp, S)}
    result = dump([*paths.values(), *refs.values()])
    return paths, {k: result[p] for k, p in paths.items()}, {f: result[p] for f, p in refs.items()}


@pytest.mark.parametrize("key", list(EXPECTED), ids=lambda k: f"{k[0]}-{k[1] or 'full'}")
def test_each_variant_reads_in_its_frame(loaded, key):
    paths, outs, refs = loaded
    out = outs[key]
    reverse = set(fv.reverse_ids())
    bam = pysam.AlignmentFile(paths[key])
    reads = {r.query_name: r for r in bam.fetch(*fv.REGION)}
    legacy_frame = bam_legacy_frame(bam.header)
    header_ma = bam_ma_aq_tags_are_molecular(bam.header)
    checked = 0
    for name, read in reads.items():
        if name not in reverse:
            continue
        legacy, ma = EXPECTED[key](_dot(read))
        # The frame decisions themselves, on every reverse read.
        assert read_legacy_tags_are_molecular(read, legacy_frame) == (legacy == M), (key, name, "legacy frame")
        ma_tags = (read.get_tag("MA"), read.get_tag("AQ") if read.has_tag("AQ") else None, None, header_ma)
        spans = ma_footprint_query_spans(ma_tags, read_length=read.query_length, is_reverse=True)
        as_mol = ma_footprint_query_spans((fv.dot(ma_tags[0]), ma_tags[1], None, True),
                                          read_length=read.query_length, is_reverse=True)
        as_seq = ma_footprint_query_spans((fv.plus(ma_tags[0]), ma_tags[1], None, False),
                                          read_length=read.query_length, is_reverse=True)
        assert spans == (as_mol if ma == M else as_seq), (key, name, "MA frame")
        if legacy != ma:
            # Legacy tags and MA in different frames (merge --recall reads without @PG): the drawn rows mix
            # both, so no single-frame reference exists; the decisions above are what is checked.
            checked += 1
            continue
        intervals, tf = out["compact"][name]
        assert intervals == refs[legacy]["compact"][name][0], (key, name, "legacy (compact)")
        assert tf == refs[ma]["compact"][name][1], (key, name, "MA (compact)")
        assert out["dense"][name] == refs[ma]["dense"][name], (key, name, "MA (dense)")
        assert out["dafc"][name] == refs[legacy]["dafc"][name], (key, name, "legacy (DAF-C)")
        checked += 1
    assert checked >= 10
    # The frames differ on these reads: a wrong frame could not pass by accident.
    some = next(n for n in reads if n in reverse)
    assert refs[M]["compact"][some] != refs[S]["compact"][some]
