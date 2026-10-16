"""A read's footprints are never drawn outside its drawn body.

Regression tests for the "footprints at a read's edge with no read background"
report (a dm6 DddB amplicon at chr2L:9,463,958-9,464,434 and the NAPA demo
chr19:47,514,000-47,518,000). Two causes, each reproduced on a small real BAM:

A. FiberHMM >= 2.14 writes only nucleosomes to the legacy ``ns``/``nl`` tags;
   TF calls live only in ``MA``. With terminal gaps hidden the compact loader
   trimmed the read body (``intervals``) to the first/last ``ns`` footprint, so
   a TF called between the alignment start and the first nucleosome was drawn
   with no read body behind it. The body now spans the read's footprint calls
   of every kind (legacy ns/nl and MA nuc/tf/fp_v2), on the whole read so the
   terminal-gap filter does not change with the viewport.
B. A legacy ``as``/``al`` MSP whose last base is in a soft clip was placed at
   ``start + length`` on the reference, past the alignment end; one starting in
   a soft clip was dropped. Both ends now go through the CIGAR as footprints do.
"""
from __future__ import annotations

import array

import pysam
import pytest

from services import compact_read_loader

CHROM = "chr1"
PG_MOLECULAR = {
    "ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "2.16.8",
    "DS": "FiberHMM fused apply+recall; coord=molecular (ns/nl/as/al/MA in molecular original-fiber coordinates); mode=daf",
    "CL": "fiberhmm-call -i in.bam -o out.bam",
}
READ_LEN = 600
REF_START = 1000


def _seq_to_mol(seq_start: int, length: int, read_len: int = READ_LEN) -> int:
    return read_len - (seq_start + length)


def _edge_read(name: str, is_reverse: bool) -> dict:
    """600 bp all-match read at 1000..1600: one nucleosome at SEQ 300..450,
    TFs at SEQ 20..60 (before it) and 500..530 (after it), molecular frame."""
    seq_ivs = {"nuc": [(300, 150)], "tf": [(20, 40), (500, 30)], "msp": [(0, 300), (450, 150)]}

    def mol(start, length):
        return _seq_to_mol(start, length) if is_reverse else start

    def ma_section(name, spec, ivs):
        ivs = sorted((mol(s, l), l) for s, l in ivs)
        return f"{name}{spec}:" + ",".join(f"{s + 1}-{l}" for s, l in ivs), ivs

    nuc_sec, nuc_mol = ma_section("nuc", "+Q", seq_ivs["nuc"])
    msp_sec, _ = ma_section("msp", ".", seq_ivs["msp"])
    tf_sec, tf_mol = ma_section("tf", "+QQQ", seq_ivs["tf"])
    aq = [200] * len(nuc_mol) + [220, 200, 200] * len(tf_mol)
    return {
        "name": name, "is_reverse": is_reverse, "start": REF_START, "cigar": [(0, READ_LEN)],
        "tags": [
            ("ns", [s for s, _ in nuc_mol]), ("nl", [l for _, l in nuc_mol]),
            ("MA", f"{READ_LEN};{nuc_sec};{msp_sec};{tf_sec}"),
            ("AQ", aq),
        ],
    }


def _write_bam(path, reads, pg=PG_MOLECULAR):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 10_000}], "PG": [pg],
              "CO": ["FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf"]}
    unsorted = str(path) + ".unsorted.bam"
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for spec in reads:
            a = pysam.AlignedSegment(out.header)
            qlen = sum(n for op, n in spec["cigar"] if op in (0, 1, 4, 7, 8))
            a.query_name = spec["name"]
            a.query_sequence = "A" * qlen
            a.query_qualities = pysam.qualitystring_to_array("I" * qlen)
            a.flag = 16 if spec["is_reverse"] else 0
            a.reference_id = 0
            a.reference_start = spec["start"]
            a.mapping_quality = 60
            a.cigartuples = spec["cigar"]
            for tag, value in spec["tags"]:
                if isinstance(value, list):
                    # B:C for quality bytes, B:I for offsets and lengths.
                    value = array.array("B" if tag in ("AQ", "nq", "aq") else "I", value)
                a.set_tag(tag, value)
            out.write(a)
    pysam.sort("-o", str(path), unsorted)
    pysam.index(str(path))
    return str(path)


def _load(path, start, end, **kwargs):
    kwargs.setdefault("spanning_only", False)
    kwargs.setdefault("include_layers", True)
    return {r["id"]: r for r in compact_read_loader.build_compact_reads_from_bam(path, CHROM, start, end, **kwargs)}


def _body(read):
    return min(iv[0] for iv in read["intervals"]), max(iv[1] for iv in read["intervals"])


def _drawn_features(read):
    for name, layer in (read.get("layers") or {}).items():
        for iv in layer["intervals"]:
            yield name, iv
    for iv in read.get("fire") or []:
        yield "fire", iv


@pytest.fixture
def edge_bam(tmp_path):
    return _write_bam(tmp_path / "edge.bam", [_edge_read("fwd", False), _edge_read("rev", True)])


@pytest.mark.parametrize("read_id", ["fwd", "rev"])
def test_body_covers_tf_calls_outside_the_nucleosomes(edge_bam, read_id):
    reads = _load(edge_bam, 900, 1700, requested_layers=["nuc", "tf"])
    read = reads[read_id]
    # TFs at ref 1020..1060 and 1500..1530, the nucleosome at 1300..1450.
    assert read["layers"]["tf"]["intervals"] == [[120, 160, 40], [600, 630, 30]]
    assert read["layers"]["nuc"]["intervals"] == [[400, 550, 150]]
    assert _body(read) == (120, 630)
    # The TF-to-nucleosome stretches are gaps of the body, not footprints:
    # the primary (legacy) footprint stream is unchanged.
    assert [iv for iv in read["intervals"] if iv[2] > 0] == [[400, 550, 150]]
    assert read["intervals"] == [[120, 400, -280], [400, 550, 150], [550, 630, -80]]


@pytest.mark.parametrize("read_id", ["fwd", "rev"])
def test_footprint_calls_never_fall_outside_the_body(edge_bam, read_id):
    read = _load(edge_bam, 900, 1700, requested_layers=["nuc", "tf"])[read_id]
    lo, hi = _body(read)
    for name, iv in _drawn_features(read):
        assert lo <= iv[0] and iv[1] <= hi, (name, iv, (lo, hi))


def test_terminal_gap_filter_measures_to_the_nearest_call_whatever_the_view(edge_bam):
    # The nucleosome is 300 bp from the alignment start but the first TF only
    # 20 bp: with a 100 bp threshold the read is kept, in a window that holds
    # the TF and in one that does not (the decision is a whole-read property).
    # requested_layers=None is the generic analysis request, where a filtered
    # read is dropped rather than kept as a neutral alignment row.
    for start, end in ((900, 1700), (1350, 1700)):
        reads = _load(edge_bam, start, end, requested_layers=None, terminal_gap_threshold=100)
        assert set(reads) == {"fwd", "rev"}, (start, end)
    # A read whose calls really are far from its alignment end is still dropped.
    assert _load(edge_bam, 900, 1700, requested_layers=None, terminal_gap_threshold=10) == {}
    narrow = _load(edge_bam, 1350, 1700, requested_layers=["nuc", "tf"])["fwd"]
    assert narrow["intervals"] == [[0, 100, 150], [100, 180, -80]]


def test_terminal_gaps_shown_keep_the_alignment_span(edge_bam):
    read = _load(edge_bam, 900, 1700, requested_layers=["nuc", "tf"], hide_terminal_gaps=False)["fwd"]
    assert _body(read) == (100, 700)


def test_ns_only_reads_keep_their_trimmed_body(tmp_path):
    spec = _edge_read("plain", False)
    spec["tags"] = [t for t in spec["tags"] if t[0] in ("ns", "nl")]
    path = _write_bam(tmp_path / "plain.bam", [spec])
    read = _load(path, 900, 1700)["plain"]
    assert read["intervals"] == [[400, 550, 150]]


def test_legacy_msp_overlay_stays_inside_a_soft_clipped_alignment(tmp_path):
    # 10S190M5S at 2000..2190 (205 bp query). MSP (as/al) SEQ 160..205 ends in
    # the trailing soft clip, SEQ 0..15 starts in the leading one.
    spec = {
        "name": "clip", "is_reverse": False, "start": 2000, "cigar": [(4, 10), (0, 190), (4, 5)],
        "tags": [("ns", [20]), ("nl", [140]), ("as", [0, 160]), ("al", [15, 45])],
    }
    path = _write_bam(tmp_path / "clip.bam", [spec])
    read = _load(path, 1900, 2300, requested_layers=["fire", "msp", "nuc"], hide_terminal_gaps=False)["clip"]
    assert read["intervals"][0][0] == 100 and read["intervals"][-1][1] == 290
    assert [iv[:2] for iv in read["fire"]] == [[100, 105], [250, 290]]
    lo, hi = _body(read)
    for name, iv in _drawn_features(read):
        assert lo <= iv[0] and iv[1] <= hi, (name, iv, (lo, hi))


def test_figure_export_draws_nothing_beyond_the_read_body():
    # The server-side figure renderer mirrors ReadTrackCanvas: a read's calls
    # are clipped to its body, so the MSP layer's reach back to the alignment
    # start (100) and on to its end (700) is not drawn off the read.
    from test_figure_reads import _hex, _px, _render

    read = {
        "id": "r1",
        "intervals": [[120, 400, -280], [400, 550, 150], [550, 630, -80]],
        "layers": {
            "nuc": {"intervals": [[400, 550, 150]]},
            "tf": {"intervals": [[120, 160, 40], [600, 630, 30]]},
            "msp": {"intervals": [[100, 400, 300], [550, 700, 150]]},
        },
    }
    fe = {"enabledModTypes": {"nuc": True, "tf": True, "msp": True, "fire": True, "footprint": True}}
    img, _, _ = _render([read], fe=fe)
    white = _hex("#ffffff")
    for x in (101, 110, 119, 631, 650, 699):
        assert _px(img, 0, x) == white, x
    for x in (121, 140, 450, 610, 628):
        assert _px(img, 0, x) != white, x


def _merged_bigbed(start, end, threshold=500):
    # The same molecule as a FiberHMM BigBed pair: nucleosomes in the footprint
    # file (fiberhmm-extract writes the MA nuc calls there), TFs in the _tf one.
    from test_compact_read_loader import FakeBigBed, bed12_rest

    handles = {
        "/a/s.bb": FakeBigBed({CHROM: [(REF_START, REF_START + READ_LEN, bed12_rest("r", [150], [300]))]}),
        "/a/s_tf.bb": FakeBigBed({CHROM: [(REF_START, REF_START + READ_LEN, bed12_rest("r", [40, 30], [20, 500]))]}),
    }
    types = {"/a/s.bb": "footprint", "/a/s_tf.bb": "tf"}
    return compact_read_loader.build_compact_reads_from_bigbed(
        list(handles), CHROM, start, end, spanning_only=False,
        include_layers=True, requested_layers=["tf", "nuc"],
        hide_terminal_gaps=True, terminal_gap_threshold=threshold,
        bigbed_handle_getter=lambda p: handles[p], overlay_type_detector=lambda p: types[p],
        format_cache={},
    )


def test_bigbed_body_covers_companion_tf_calls():
    (read,) = _merged_bigbed(900, 1700)
    assert read["layers"]["tf"]["intervals"] == [[120, 160, 40], [600, 630, 30]]
    assert read["intervals"] == [[120, 400, -280], [400, 550, 150], [550, 630, -80]]
    lo, hi = _body(read)
    for name, iv in _drawn_features(read):
        assert lo <= iv[0] and iv[1] <= hi, (name, iv, (lo, hi))


def test_bigbed_terminal_gap_filter_counts_companion_tf_calls():
    # Nucleosome 300 bp from the read start, first TF 20 bp: kept at 100 bp,
    # in a window with the TF and one without; dropped at 10 bp.
    assert len(_merged_bigbed(900, 1700, threshold=100)) == 1
    assert len(_merged_bigbed(1350, 1700, threshold=100)) == 1
    assert _merged_bigbed(900, 1700, threshold=10) == []


def test_call_extent_places_calls_as_the_layer_parser_does(tmp_path):
    # The extent skips the layer build; it must agree with the parsed layers,
    # including a TF wholly in a soft clip (not drawn, so not an edge) and a
    # call starting in an insertion.
    from models.domain import CigarCoordMapper
    from services.bam_tags import parse_ma_aq_tags_into_layers

    clipped = {
        "name": "clip", "is_reverse": True, "start": 3000,
        "cigar": [(4, 30), (0, 100), (1, 10), (0, 300), (4, 20)],
        # Molecular frame on a reverse read (460 bp): SEQ 0..20 (in the leading
        # clip), SEQ 128..140 (starts in the insertion), SEQ 200..350 (nuc).
        "tags": [("ns", [110]), ("nl", [150]),
                 ("MA", "460;nuc+Q:111-150;tf+QQQ:321-12,441-20"), ("AQ", [200, 1, 2, 3, 4, 5, 6])],
    }
    path = _write_bam(tmp_path / "ext.bam", [_edge_read("fwd", False), _edge_read("rev", True), clipped])
    with pysam.AlignmentFile(path) as bam:
        for read in bam.fetch(CHROM):
            ma = compact_read_loader._read_ma_tags(read, True)
            mapper = CigarCoordMapper(read.cigartuples, read.reference_start)
            layers = parse_ma_aq_tags_into_layers(
                ma[0], None, mapper, read.reference_start, read.reference_end,
                include_names=("nuc", "tf", "fp_v2"), include_qualities=False,
                read_length=read.query_length, is_reverse=read.is_reverse, tags_are_molecular=True,
            )
            ivs = [iv for layer in layers.values() for iv in layer["intervals"]]
            expected = (read.reference_start + min(iv[0] for iv in ivs), read.reference_start + max(iv[1] for iv in ivs))
            assert compact_read_loader.ma_footprint_call_extent(
                ma, mapper, read.reference_start, read.reference_end,
                read_length=read.query_length, is_reverse=read.is_reverse,
            ) == expected, read.query_name
