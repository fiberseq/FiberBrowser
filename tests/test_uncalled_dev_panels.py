"""Reads without footprint calls in the dev-only panels: Min footprints never shows them unless the read filters ask
for all reads (``hide_uncalled=false``). The hub drops them before FiberHMM decodes molecules; nucleosome
observations never take them (withoutCalls); calibration identities ignore the rule."""
from array import array
from types import SimpleNamespace as NS

import pysam
import pytest

from test_circular_origin_spanning import CONTIG, L, _record, _sequence, _state


@pytest.fixture
def uncalled_state(tmp_path):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"},
                                              "SQ": [{"SN": CONTIG, "LN": L}]})
    tags = {"ns": array("i", [20]), "nl": array("i", [100])}
    records = [_record(header, "called", 100, 300, _sequence(), tags=tags),
               _record(header, "uncalled", 100, 300, _sequence(), tags={}),
               _record(header, "empty_groups", 100, 300, _sequence(), tags={"MA": "200;nuc.Q:;msp.:"})]
    path = tmp_path / "uncalled.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in records:
            out.write(read)
    pysam.index(str(path))
    return _state({"bam": str(path)})


def test_nucleosome_observations_never_take_uncalled_reads(uncalled_state):
    """The nucleosome panel already keeps reads without footprint calls out of every observation (counted as
    withoutCalls, tests/test_nuc_without_calls.py), under either choice; the policy carries the rule for its caches."""
    from services.nuc.inputs import browser_read_policy
    assert browser_read_policy(uncalled_state, hide_uncalled=True)["filters"]["uncalled"] == "exclude"
    assert browser_read_policy(uncalled_state, hide_uncalled=False)["filters"]["uncalled"] == "include"


def test_the_request_decides_by_default(uncalled_state):
    from services.nuc.inputs import browser_read_policy
    from services.signal_evidence import hide_uncalled_for_request
    assert browser_read_policy(uncalled_state)["filters"]["uncalled"] == "exclude"       # default: hidden
    with hide_uncalled_for_request("false"):
        assert browser_read_policy(uncalled_state)["filters"]["uncalled"] == "include"   # "All reads"


def test_hub_decoded_molecules_drop_uncalled_reads(uncalled_state):
    import inspect
    from services.hub import assoc_inputs
    assert "iter_policy_records" in inspect.getsource(assoc_inputs.decoded_molecules)
    from services.nuc.inputs import iter_policy_records, policy_passes
    with pysam.AlignmentFile(uncalled_state.datasets["wrap"].paths[0]) as bam:
        reads = list(bam.fetch(CONTIG, 0, 500))
        kept = [r.query_name for r, *_ in iter_policy_records(bam, CONTIG, 0, 500, {"uncalled": "exclude"})]
    assert kept == ["called"]
    assert [r.query_name for r in reads if policy_passes(r, {"uncalled": "exclude"})] == ["called"]
    assert len([r for r in reads if policy_passes(r, {"uncalled": "include"})]) == 3
    # FiberHMM's own default filters (no browser key) are unchanged.
    assert len([r for r in reads if policy_passes(r, {})]) == 3


def test_nucleosome_jobs_and_calibrations(monkeypatch):
    from services.nuc import jobs
    from services.nuc.calibration import cache_key, calibration_filters
    plan = dict(sources=[], views={}, source_regions={}, settings_hash="s", include_duplicates=False)
    assert jobs._plan_key({**plan, "hide_uncalled": True}) != jobs._plan_key({**plan, "hide_uncalled": False})
    assert calibration_filters({"duplicates": "exclude", "uncalled": "exclude"}) == {"duplicates": "exclude"}
    source = NS(content_ids=("c",), chemistry=None)
    assert cache_key(source, {"duplicates": "exclude", "uncalled": "include"}, "s", "1") == \
        cache_key(source, {"duplicates": "exclude"}, "s", "1")
