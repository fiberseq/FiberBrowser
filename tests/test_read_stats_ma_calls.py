"""Read Stats counts footprint calls that are only in MA/Ma tags.

Current FiberHMM writes its calls only in MA (fibertools in Ma). The read loaders give such a
read a placeholder row and put the calls in layers, which Read Stats may not have loaded, so
3.0.5 and 3.0.6 reported these called reads as 0 footprints / 100% accessible. Read Stats now
reads the record's MA tag with the loaders' parsing; legacy ns/nl reads and uncalled reads are
unchanged. Expected values are worked out by hand below (terminal gaps hidden: a read's body
runs from its first call to its last).
"""
from array import array

import pysam
import pytest

from models.domain import Dataset
from models.requests import ReadStatsRequest
from services.read_stats import compute_read_stats
from state.browser_state import BrowserState

CHROM = "chrS"
LENGTH = 600


def _write(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 20_000}]}
    records = [
        # MA (SEQ frame, forward): nuc query [100,247) and [300,447), TF [250,280).
        ("ma_fwd", 1000, False, [("MA", f"{LENGTH};nuc+Q:101-147,301-147;tf+Q:251-30"),
                                 ("AQ", array("B", [200, 200, 180]))]),
        # fibertools Ma (always molecular frame), reverse read: nuc molecule [50,197) and TF
        # [250,290) flip to query [403,550) and [310,350).
        ("ma_rev", 2000, True, [("Ma", f"{LENGTH};nuc+Q:51-147;tf+Q:251-40")]),
        # Called, fully accessible: one MSP over the read, no footprint call.
        ("ma_msp_only", 3000, False, [("MA", f"{LENGTH};msp+:1-{LENGTH}")]),
        # Legacy ns/nl: 6 footprints of 60 bp, 30 bp apart.
        ("legacy", 4000, False, [("ns", array("I", [10, 100, 190, 280, 370, 460])),
                                 ("nl", array("I", [60, 60, 60, 60, 60, 60]))]),
        # Uncalled: no tags, and only empty MA groups.
        ("uncalled_none", 5000, False, []),
        ("uncalled_empty_ma", 6000, False, [("MA", f"{LENGTH};nuc+Q:;msp+:")]),
    ]
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, start, reverse, tags in records:
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = name, 0, start
            read.mapping_quality = 60
            read.is_reverse = reverse
            read.query_sequence = "ACGT" * (LENGTH // 4)
            read.cigarstring = f"{LENGTH}M"
            for tag, value in tags:
                read.set_tag(tag, value)
            out.write(read)
    pysam.index(str(path))
    return str(path)


def _state(path):
    state = BrowserState(None)
    state.drop_short_terminal_footprints = False
    dataset = Dataset("ds", [path], "ds", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "tf": True, "msp": True}
    state.datasets["ds"] = dataset
    state.dataset_order.append("ds")
    return state


# read: (footprints, nucleosomes (>= 90 bp), sub-nucleosomal, accessible %, mean size, median size)
EXPECTED = {
    # Body 1100-1447: footprints 147 + 30 + 147, gaps 3 + 20 -> 23 / 347.
    "ma_fwd": (3, 2, 1, round(23 / 347 * 100, 1), 108.0, 147.0),
    # Body 2310-2550: footprints 40 + 147, gap 53 -> 53 / 240.
    "ma_rev": (2, 1, 1, round(53 / 240 * 100, 1), 93.5, 93.5),
    "ma_msp_only": (0, 0, 0, 100.0, 0.0, 0.0),
    # Body 4010-4520: 6 x 60 bp footprints, 5 x 30 bp gaps -> 150 / 510.
    "legacy": (6, 0, 6, round(150 / 510 * 100, 1), 60.0, 60.0),
}
UNCALLED = {"uncalled_none", "uncalled_empty_ma"}


@pytest.fixture
def stats(tmp_path):
    state = _state(_write(tmp_path / "ma_calls.bam"))
    ids = {"ds": sorted(set(EXPECTED) | UNCALLED)}
    return compute_read_stats(state, CHROM, 900, 6700, False,
                              ReadStatsRequest(read_ids_by_dataset=ids, hide_uncalled=False))


def test_per_read_footprints_and_accessibility(stats):
    rows = {row["read_id"]: row for row in stats["per_read"]}
    assert set(rows) == set(EXPECTED) | UNCALLED
    for name, (fps, nucs, subnucs, acc, mean_size, median_size) in EXPECTED.items():
        row = rows[name]
        assert row["call_status"] == "called", name
        got = (row["footprint_count"], row["nucleosome_count"], row["subnuc_count"], row["accessibility_pct"],
               row["avg_footprint_size"], row["median_footprint_size"])
        assert got == (fps, nucs, subnucs, acc, mean_size, median_size), name
    for name in UNCALLED:
        row = rows[name]
        assert row["call_status"] == "not called"
        assert row["footprint_count"] is None and row["accessibility_pct"] is None


def test_aggregate_counts_ma_calls(stats):
    agg = stats["aggregate"]
    called = [EXPECTED[name] for name in EXPECTED]
    assert agg["mean_footprint_count"] == round(sum(c[0] for c in called) / len(called), 1)
    assert agg["mean_accessibility_pct"] == pytest.approx(sum(c[3] for c in called) / len(called), abs=0.06)


def test_single_read_view_draws_its_ma_footprints(tmp_path):
    state = _state(_write(tmp_path / "ma_calls.bam"))
    stats = compute_read_stats(state, CHROM, 900, 1700, False,
                               ReadStatsRequest(read_ids_by_dataset={"ds": ["ma_fwd"]}, hide_uncalled=False))
    row = stats["per_read"][0]
    # Read-relative, as for legacy reads: footprints at 100-247, 250-280, 300-447.
    assert [iv for iv in row["fp_intervals"] if iv[2] > 0] == [[100, 247, 147], [250, 280, 30], [300, 447, 147]]


def test_quality_filters_apply_to_ma_calls(tmp_path):
    # 3.1.0: Read Stats applies the read track's quality filters; a removed MA call is accessible span.
    from services.read_endpoint import compact_reads_payload_for_request
    from services.read_metrics import get_layer_intervals
    state = _state(_write(tmp_path / "ma_calls.bam"))
    state.quality_filters = [{"layer": "tf", "quality_name": "aq", "min_value": 190}]
    state.clear_cache()
    stats = compute_read_stats(state, CHROM, 900, 1700, False,
                               ReadStatsRequest(read_ids_by_dataset={"ds": ["ma_fwd"]}, hide_uncalled=False))
    row = stats["per_read"][0]
    payload = compact_reads_payload_for_request(
        state, chrom=CHROM, start=900, end=1700, dataset_id="ds", spanning=False, max_reads=0,
        include_layers=True, include_layer_qualities=True)
    track = {r["id"]: len(get_layer_intervals(r, "all_fp")) for r in payload["reads"]}
    assert row["footprint_count"] == track["ma_fwd"] == 2
    # The 30 bp TF is now accessible: gaps 3 + 30 + 20 over the 347 bp body.
    assert row["accessibility_pct"] == round(53 / 347 * 100, 1)
    (impact,) = stats["aggregate"]["quality_filters"]
    assert (impact["calls"], impact["removed"]) == (1, 1)
