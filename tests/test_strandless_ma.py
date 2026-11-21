"""MA sections without a strand character (``nuc:201-350``) are not spec MA. FiberHMM 3.2.0 rejects the whole tag
(``parse_ma_tag``: "MA head missing strand"), so its scan, extract and peaks see no calls in it. FiberBrowser reads
it the same way everywhere: the uncalled-read rule, the drawn layers, the Min footprints count and the call extent.
"""
from array import array

import pysam

from models.domain import Dataset
from services.bam_tags import ma_tag_is_spec, parse_ma_aq_tags_into_layers
from services.compact_read_loader import ma_footprint_count, ma_footprint_query_spans
from services.read_endpoint import compact_reads_payload_for_request
from state.browser_state import BrowserState

CHROM = "chrS"
LENGTH = 600
TAGS = {
    "spec": f"{LENGTH};nuc+Q:11-147,301-147;msp+:158-143",
    "strandless": f"{LENGTH};nucQ:11-147,301-147;msp:158-143",
    "mixed": f"{LENGTH};nuc+Q:11-147,301-147;msp:158-143",
}


def _write(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 20_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i, (name, ma) in enumerate(TAGS.items()):
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = name, 0, 1000 + 10 * i
            read.mapping_quality = 60
            read.query_sequence = "ACGT" * (LENGTH // 4)
            read.cigarstring = f"{LENGTH}M"
            read.set_tag("MA", ma)
            read.set_tag("AQ", array("B", [200, 200]))
            out.write(read)
    pysam.index(str(path))
    return str(path)


def _payload(path, hide):
    state = BrowserState(None)
    state.drop_short_terminal_footprints = False
    dataset = Dataset("ds", [path], "ds", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "msp": True}
    state.datasets["ds"] = dataset
    state.dataset_order.append("ds")
    return compact_reads_payload_for_request(
        state=state, chrom=CHROM, start=900, end=1700, max_reads=100, dataset_id="ds",
        include_layers=True, layer_names="nuc,tf,msp", spanning=False, hide_uncalled=hide)


def test_parsers_reject_a_tag_with_a_strandless_section():
    assert ma_tag_is_spec(TAGS["spec"]) and ma_tag_is_spec(f"{LENGTH};nuc.:1-5;;")
    assert not ma_tag_is_spec(TAGS["strandless"]) and not ma_tag_is_spec(TAGS["mixed"])
    assert not ma_tag_is_spec(f"{LENGTH};nuc.:1-5;junk")
    assert ma_footprint_count(TAGS["spec"]) == 2
    assert ma_footprint_count(TAGS["mixed"]) == ma_footprint_count(TAGS["strandless"]) == 0
    assert ma_footprint_query_spans((TAGS["spec"], None, None, None), read_length=LENGTH, is_reverse=False)
    for name in ("strandless", "mixed"):
        assert ma_footprint_query_spans((TAGS[name], None, None, None), read_length=LENGTH, is_reverse=False) == []
        assert parse_ma_aq_tags_into_layers(TAGS[name], [200, 200], None, 0, 10_000) == {}


def test_read_track_hides_strandless_tags_and_draws_no_layers_from_them(tmp_path):
    path = _write(tmp_path / "strandless.bam")
    hidden = _payload(path, hide=True)
    assert {r["id"] for r in hidden["reads"]} == {"spec"}
    assert hidden["signal_counts"]["uncalled"] == 2
    shown = _payload(path, hide=False)
    reads = {r["id"]: r for r in shown["reads"]}
    assert set(reads) == {"spec", "strandless", "mixed"}
    assert sorted(reads["spec"].get("layers") or {}) == ["msp", "nuc"]
    # Shown by choice ("All reads, including uncalled"), but nothing is drawn from a rejected tag.
    assert not reads["strandless"].get("layers") and not reads["mixed"].get("layers")


def test_dafc_treats_a_rejected_tag_as_uncalled(tmp_path):
    """Audit (final 3.1.0, MED): DAF-C never reads a rejected tag as "called with no nucleosomes" (a fully
    accessible read)."""
    from services.dafc_reads import query_bam_for_dafc
    path = _write(tmp_path / "strandless.bam")
    assert {e["name"] for e in query_bam_for_dafc(path, CHROM, 900, 1700)} == {"spec"}
    entries = {e["name"]: e for e in query_bam_for_dafc(path, CHROM, 900, 1700, hide_uncalled=False)}
    assert set(entries) == {"spec", "strandless", "mixed"}
    assert entries["spec"].get("footprintsCalled")
    assert not entries["strandless"].get("footprintsCalled") and not entries["mixed"].get("footprintsCalled")


def test_a_rejected_ma_beside_a_valid_ma_tag_reads_the_ma_tag(tmp_path):
    """agy audit (final 3.1.0, MED): a read whose MA is rejected but whose fibertools Ma is valid is called by Ma, so
    it draws and counts Ma's calls (it was drawn empty, or hidden by Min footprints 1)."""
    from services.bam_tags import footprint_call_count, read_has_footprint_calls
    path = tmp_path / "both.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 20_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        read = pysam.AlignedSegment(out.header)
        read.query_name, read.reference_id, read.reference_start = "both", 0, 1000
        read.mapping_quality = 60
        read.query_sequence = "ACGT" * (LENGTH // 4)
        read.cigarstring = f"{LENGTH}M"
        read.set_tag("MA", TAGS["strandless"])
        read.set_tag("Ma", f"{LENGTH};nuc.:11-147,301-147;msp.:158-143")
        out.write(read)
    pysam.index(str(path))
    with pysam.AlignmentFile(str(path)) as bam:
        record = next(bam.fetch())
        assert read_has_footprint_calls(record) and footprint_call_count(record) == 2
    reads = {r["id"]: r for r in _payload(str(path), hide=True)["reads"]}
    assert sorted(reads["both"].get("layers") or {}) == ["msp", "nuc"]


def test_the_spec_check_follows_fiberhmms_parser():
    """agy audit (final 3.1.0, MED): an integer read length and start-length integer intervals, as parse_ma_tag
    requires; a nameless group keeps the next group's quality bytes in line."""
    from fiberhmm.io.legacy_tags import ma_has_footprint_groups
    for value in ("bad;nuc.:11-147", "600;nuc.:11-147;msp.:bad", "600;nuc.:11-x"):
        assert not ma_tag_is_spec(value) and ma_has_footprint_groups(value) is False, value
    for value in ("600;nuc.:11-147,,301-147,", "600;nuc.:", "600;+Q:5-10;nuc+Q:301-147", "600;nuc.:1_1-147"):
        assert ma_tag_is_spec(value), value
        assert ma_has_footprint_groups(value) is True, value   # FiberHMM parses it too
    from models.domain import CigarCoordMapper
    layers = parse_ma_aq_tags_into_layers("600;+Q:5-10;nuc+Q:301-147", [10, 200], CigarCoordMapper([(0, 600)], 0),
                                          0, 10_000, read_length=600)
    assert layers["nuc"]["qualities"] == [[200]]   # not the nameless group's 10
