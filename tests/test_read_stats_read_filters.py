"""Read Stats applies the read track's filters (owner decision, 3.1.0).

The quality filters (colour-rule quality gates), the footprint-quality gate (``min_fp_quality``) and the
duplicate and QC-fail toggles act on Read Stats as on the read track, so its counts are the visible
read set's, and the summary says which filter removed what. The read track's own payload is the
reference: a read's footprint count is the footprint calls the read track draws for it.
"""
from array import array

import pysam
import pytest

from models.domain import Dataset
from models.requests import ReadStatsRequest
from services.read_endpoint import compact_reads_payload_for_request
from services.read_metrics import get_layer_intervals
from services.read_stats import compute_read_stats
from state.browser_state import BrowserState

CHROM = "chrS"
LENGTH = 600
START, END = 900, 2000

# name, start, flags, ns, nl, nq
RECORDS = [
    # Two nucleosomes (147 bp) and a TF (40 bp); one nucleosome is low quality.
    ("mixed", 1000, 0, [10, 200, 400], [147, 147, 40], [200, 50, 180]),
    # Two low-quality nucleosomes with a gap between them.
    ("low", 1010, 0, [10, 200], [147, 147], [10, 20]),
    # One low-quality nucleosome and nothing else in its body (terminal gaps are hidden).
    ("solo", 1020, 0, [10], [147], [5]),
    ("dup", 1030, 0x400, [10, 200], [147, 147], [200, 200]),
    ("qcfail", 1040, 0x200, [10, 200], [147, 147], [200, 200]),
]
ALL_IDS = [r[0] for r in RECORDS]


@pytest.fixture
def state(tmp_path):
    path = str(tmp_path / "filters.bam")
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 20_000}]}
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        for name, start, flag, ns, nl, nq in RECORDS:
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = name, 0, start
            read.flag = flag
            read.mapping_quality = 60
            read.query_sequence = "ACGT" * (LENGTH // 4)
            read.cigarstring = f"{LENGTH}M"
            read.set_tag("ns", array("I", ns))
            read.set_tag("nl", array("I", nl))
            read.set_tag("nq", array("B", nq))
            out.write(read)
    pysam.index(path)
    st = BrowserState(None)
    st.drop_short_terminal_footprints = False
    dataset = Dataset("ds", [path], "ds", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "tf": True, "msp": True}
    st.datasets["ds"] = dataset
    st.dataset_order.append("ds")
    return st


def _set_filters(state, filters):
    state.quality_filters = filters
    state.clear_cache()


def _stats(state, **kw):
    request = ReadStatsRequest(read_ids_by_dataset={"ds": list(ALL_IDS)}, **kw)
    return compute_read_stats(state, CHROM, START, END, False, request)


def _track_calls(state, **kw):
    """Footprint calls per read as the read track draws them (its footprint layers)."""
    payload = compact_reads_payload_for_request(
        state, chrom=CHROM, start=START, end=END, dataset_id="ds", spanning=False, max_reads=0,
        include_layers=True, include_layer_qualities=True, **kw)
    return {r["id"]: len(get_layer_intervals(r, "all_fp")) for r in payload["reads"]}


def _per_read(result):
    return {r["read_id"]: r for r in result["per_read"]}


def test_duplicates_and_qcfail_hidden_by_default_and_counted(state):
    result = _stats(state)
    rows = _per_read(result)
    assert set(rows) == {"mixed", "low", "solo"}
    agg = result["aggregate"]
    assert (agg["n_hidden_duplicate"], agg["n_hidden_qcfail"]) == (1, 1)
    assert agg["quality_filters"] == [] and agg["n_hidden_quality"] == 0
    # Hidden reads are not reported as missing selections.
    assert result["missing_read_ids_by_dataset"].get("ds", []) == []
    assert set(rows) == set(_track_calls(state))


def test_toggles_show_duplicates_and_qcfail(state):
    result = _stats(state, include_duplicates=True, include_qcfail=True)
    rows = _per_read(result)
    assert set(rows) == set(ALL_IDS)
    assert rows["dup"]["footprint_count"] == 2 and rows["qcfail"]["footprint_count"] == 2
    agg = result["aggregate"]
    assert (agg["n_hidden_duplicate"], agg["n_hidden_qcfail"]) == (0, 0)
    assert set(rows) == set(_track_calls(state, include_duplicates=True, include_qcfail=True))


def test_quality_filter_counts_match_the_read_track(state):
    _set_filters(state, [{"layer": "nuc", "quality_name": "nq", "min_value": 100}])
    track = _track_calls(state)
    result = _stats(state)
    rows = _per_read(result)
    # "solo": its only call failed and nothing is left of the read; the read track drops it too.
    assert "solo" not in track and "solo" not in rows
    assert result["aggregate"]["n_hidden_quality"] == 1
    for rid, row in rows.items():
        assert row["footprint_count"] == track[rid], rid
    assert (rows["mixed"]["footprint_count"], rows["mixed"]["nucleosome_count"]) == (2, 1)
    assert rows["low"]["footprint_count"] == 0
    (impact,) = result["aggregate"]["quality_filters"]
    assert impact["label"] == "nq ≥ 100 (nuc)"
    # Calls in the selected reads' nuc layers: mixed 2, low 2, solo 1; removed: mixed 1, low 2, solo 1.
    assert (impact["calls"], impact["removed"]) == (5, 4)


def test_quality_filter_on_a_missing_dimension_removes_the_layer_calls(state):
    # A targeted filter on a quality the layer does not carry fails closed (read_quality_filters): the
    # read track draws no nucleosome, and Read Stats counts none.
    _set_filters(state, [{"layer": "nuc", "quality_name": "aq", "min_value": 100}])
    track = _track_calls(state)
    rows = _per_read(_stats(state))
    assert (rows["mixed"]["footprint_count"], rows["mixed"]["nucleosome_count"]) == (1, 0)
    for rid, row in rows.items():
        assert row["footprint_count"] == track[rid], rid
    # A removed call is accessible span, not a footprint.
    assert rows["mixed"]["accessibility_pct"] > 90


def test_min_fp_quality_drops_low_footprints_as_the_read_track(state):
    track = _track_calls(state, min_fp_quality=100)
    result = _stats(state, min_fp_quality=100)
    rows = _per_read(result)
    assert rows["mixed"]["footprint_count"] == 2 == track["mixed"]
    assert result["aggregate"]["min_fp_quality"] == 100


def test_route_passes_the_read_policy(state):
    import asyncio
    from routers.read_stats import get_read_stats
    request = ReadStatsRequest(read_ids_by_dataset={"ds": list(ALL_IDS)}, include_duplicates=True)
    result = asyncio.run(get_read_stats(chrom=CHROM, start=START, end=END, spanning=False,
                                        request=request, state=state))
    assert "dup" in _per_read(result) and "qcfail" not in _per_read(result)
    assert result["aggregate"]["n_hidden_qcfail"] == 1
