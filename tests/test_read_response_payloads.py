from types import SimpleNamespace

from models.domain import WorkingSet
from services.read_endpoint import (
    compact_all_dataset_result,
    compact_reads_payload_for_request,
    quality_filters_for_display_layers,
    quality_filters_require_full_projection,
)
from services.read_response_payloads import (
    compact_read_count_fields,
    compact_reads_available_layers,
    compact_reads_have_methylation,
    compact_reads_response_payload,
    sample_compact_reads_for_display,
    sort_compact_reads_for_display,
)
from routers.reads import (
    READ_DIAGNOSTICS_ENV,
    READ_LOG_THRESHOLD_ENV,
    _log_read_diagnostic,
    _should_log_read_request,
)


def test_compact_read_count_fields_exposes_total_in_scope_alias():
    fields = compact_read_count_fields(
        display_count=100,
        working_count=250,
        total_in_scope=500,
        total_spanning=400,
        total_overlapping=900,
    )

    assert fields == {
        "count": 100,
        "display_count": 100,
        "total": 500,
        "total_in_scope": 500,
        "total_overlapping": 900,
        "total_spanning": 400,
        "working_count": 250,
    }


def test_compact_read_count_fields_defaults_total_overlapping_to_scope():
    fields = compact_read_count_fields(
        display_count=10,
        working_count=20,
        total_in_scope=30,
        total_spanning=25,
    )

    assert fields["total"] == 30
    assert fields["total_in_scope"] == 30
    assert fields["total_overlapping"] == 30


def test_compact_reads_response_payload_uses_shared_counts_and_optional_metadata():
    payload = compact_reads_response_payload(
        display_reads=[{"id": "r1"}],
        width=500,
        dataset_id="ds1",
        dataset_label="Sample 1",
        dataset_color="#336699",
        working_count=10,
        total_in_scope=20,
        total_spanning=15,
        total_overlapping=30,
        has_methylation=True,
        available_layers=["tf", "fire"],
        sample_seed="paper-v1",
        warning="index missing",
        metaprofile={"layers": {"tf": [0.1, 0.2]}},
        metaprofile_read_count=200,
        profile_max_reads=1000,
    )

    assert payload["count"] == 1
    assert payload["display_count"] == 1
    assert payload["working_count"] == 10
    assert payload["total"] == 20
    assert payload["total_in_scope"] == 20
    assert payload["total_spanning"] == 15
    assert payload["total_overlapping"] == 30
    assert payload["dataset_id"] == "ds1"
    assert payload["label"] == "Sample 1"
    assert payload["color"] == "#336699"
    assert payload["has_methylation"] is True
    assert payload["available_layers"] == ["tf", "fire"]
    assert payload["sample_seed"] == "paper-v1"
    assert payload["warning"] == "index missing"
    assert payload["metaprofile"] == {"layers": {"tf": [0.1, 0.2]}}
    assert payload["metaprofile_read_count"] == 200
    assert payload["profile_max_reads"] == 1000


def test_native_refined_family_tags_expose_separate_consensus_capability():
    reads = [{
        "id": "r1",
        "layers": {
            "tf_sr": {
                "intervals": [[10, 20, 10]],
                "quality_names": ["q0", "fi", "fq"],
                "qualities": [[255], [3], [220]],
            },
        },
    }]

    assert compact_reads_available_layers(reads) == ["tf_consensus", "tf_sr"]


class _CompactState:
    def __init__(self):
        self.dataset = SimpleNamespace(
            label="Sample 1",
            color="#336699",
            data_type="bigbed",
            paths=[],
            available_layers={"footprint": True, "tf": True},
            cluster_assignments={},
            family_scan_chemistry="hia5-pacbio",
        )
        self.datasets = {"ds1": self.dataset}
        self.dataset_order = ["ds1"]
        self.working_set_calls = []

    def translate_chrom(self, chrom):
        return {"2R": "chr2R"}.get(chrom, chrom)

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning, min_footprints, **kwargs):
        self.working_set_calls.append((dataset_id, chrom, start, end, spanning, min_footprints, kwargs))
        reads = [
            {"id": "late", "intervals": [[50, 90, 40]], "layers": {"tf": {"intervals": [[50, 90, 40]]}}},
            {"id": "early", "intervals": [[5, 25, 20]]},
        ]
        return WorkingSet(reads, total_overlapping=5, total_spanning=2, chrom=chrom, start=start, end=end)


def test_compact_reads_payload_for_request_uses_shared_query_and_response_contract():
    state = _CompactState()

    payload = compact_reads_payload_for_request(
        state,
        chrom="2R",
        start=100,
        end=200,
        dataset_id="primary",
        include_layers=True,
        layer_names="tf",
        include_layer_qualities=False,
        sample_seed="paper-seed",
    )

    assert payload["dataset_id"] == "ds1"
    assert payload["label"] == "Sample 1"
    assert payload["width"] == 100
    assert payload["sample_seed"] == "paper-seed"
    assert payload["count"] == 2
    assert payload["working_count"] == 2
    assert payload["total_in_scope"] == 5
    assert payload["total_spanning"] == 2
    assert payload["total_overlapping"] == 5
    assert payload["available_layers"] == ["footprint", "tf"]
    assert [read["id"] for read in payload["reads"]] == ["early", "late"]
    assert state._current_chrom == "chr2R"
    assert state.working_set_calls[0][:6] == ("ds1", "chr2R", 100, 200, False, 0)
    assert state.working_set_calls[0][6]["requested_layers"] == ("tf",)
    assert state.working_set_calls[0][6]["include_layer_qualities"] is False


def test_compact_reads_payload_duplicate_direct_load_can_apply_min_footprints(monkeypatch):
    state = _CompactState()
    direct_reads = [{"id": "kept", "intervals": [[5, 25, 20]]}]
    direct_calls = []

    def fake_direct_load(*args, **kwargs):
        direct_calls.append(kwargs)
        return direct_reads

    monkeypatch.setattr(
        "services.read_endpoint.load_direct_reads_for_dataset",
        fake_direct_load,
    )

    payload = compact_reads_payload_for_request(
        state,
        chrom="chr2R",
        start=100,
        end=200,
        dataset_id="ds1",
        include_duplicates=True,
        min_footprints=5,
    )

    assert payload["working_count"] == 1
    assert [read["id"] for read in payload["reads"]] == ["kept"]
    assert direct_calls[0]["min_footprints"] == 5


def test_compact_all_does_not_reapply_min_footprints_after_viewport_clipping(monkeypatch):
    state = _CompactState()
    direct_calls = []

    def fake_direct_load(*args, **kwargs):
        direct_calls.append(kwargs)
        # The loader has already established that this read has >=5
        # footprints across the whole fiber. Only one intersects this window.
        return [{"id": "kept", "intervals": [[5, 25, 20]]}]

    monkeypatch.setattr(
        "services.read_endpoint.load_direct_reads_for_dataset",
        fake_direct_load,
    )

    dataset_id, payload = compact_all_dataset_result(
        state=state,
        query=SimpleNamespace(),
        dataset_id="ds1",
        chrom="chr2R",
        start=100,
        end=200,
        region_width=100,
        spanning=False,
        max_reads=100,
        downsample=None,
        include_methylation=False,
        include_layers=True,
        requested_layers=("tf",),
        include_layer_qualities=False,
        ml_threshold=125,
        fill_gap_size=None,
        min_fp_quality=0,
        min_footprints=5,
        include_metaprofile=False,
        profile_max_reads=100,
        coverage_sample=False,
        hide_terminal_gaps=True,
        terminal_gap_threshold=500,
        infer_legacy_layers=True,
        legacy_nuc_min_size=90,
        sample_seed="test-seed",
        include_duplicates=True,
    )

    assert dataset_id == "ds1"
    assert payload["count"] == 1
    assert [read["id"] for read in payload["reads"]] == ["kept"]
    assert direct_calls[0]["min_footprints"] == 5


def test_compact_reads_payload_can_return_server_metaprofile_without_expanding_display():
    state = _CompactState()

    payload = compact_reads_payload_for_request(
        state,
        chrom="chr2R",
        start=100,
        end=200,
        dataset_id="ds1",
        max_reads=1,
        include_layers=True,
        layer_names="tf",
        include_metaprofile=True,
        profile_max_reads=2,
        metaprofile_layers="tf",
    )

    assert payload["count"] == 1
    assert len(payload["reads"]) == 1
    assert payload["metaprofile_read_count"] == 2
    assert payload["profile_max_reads"] == 2
    assert payload["metaprofile"]["layers"]["tf"][50:90] == [1.0] * 40


def test_compact_reads_payload_for_request_reports_missing_dataset_without_route_wrapper():
    state = _CompactState()

    payload = compact_reads_payload_for_request(
        state,
        chrom="chr2L",
        start=10,
        end=20,
        dataset_id="missing",
    )

    assert payload["success"] is False
    assert payload["error"] == "Dataset 'missing' not found"
    assert payload["reads"] == []
    assert payload["count"] == 0


def test_quality_filter_fast_path_guard_allows_fire_but_not_primary_nq():
    assert quality_filters_require_full_projection([
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
    ]) is False
    assert quality_filters_require_full_projection([
        {"layer": "nuc", "quality_name": "nq", "min_value": 128},
    ]) is True
    assert quality_filters_require_full_projection([
        {"layer": "*", "quality_name": "nq", "min_value": 128},
    ]) is True


def test_display_quality_filters_only_keep_requested_payload_layers():
    filters = [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
        {"layer": "tf", "quality_name": "tq", "min_value": 128},
        {"layer": "*", "quality_name": "aq", "min_value": 128},
        {"layer": "msp", "quality_name": "aq", "min_value": 200},
        {"layer": "nuc", "quality_name": "nq", "min_value": 0},
    ]

    assert quality_filters_for_display_layers(filters, ("tf",)) == [
        {"layer": "tf", "quality_name": "tq", "min_value": 128},
    ]
    assert quality_filters_for_display_layers(filters, ("fire",)) == [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
        {"layer": "msp", "quality_name": "aq", "min_value": 200},
    ]
    assert quality_filters_for_display_layers(filters, None) == [
        {"layer": "fire", "quality_name": "aq", "min_value": 230},
        {"layer": "tf", "quality_name": "tq", "min_value": 128},
        {"layer": "*", "quality_name": "aq", "min_value": 128},
        {"layer": "msp", "quality_name": "aq", "min_value": 200},
    ]


def test_sort_compact_reads_for_display_uses_first_interval_start():
    reads = [
        {"id": "empty", "intervals": []},
        {"id": "late", "intervals": [[50, 60, 10]]},
        {"id": "early", "intervals": [[10, 20, 10]]},
    ]

    assert [read["id"] for read in sort_compact_reads_for_display(reads)] == [
        "empty",
        "early",
        "late",
    ]


def test_sample_compact_reads_for_display_samples_then_sorts():
    reads = [
        {"id": "late", "intervals": [[50, 60, 10]]},
        {"id": "early", "intervals": [[10, 20, 10]]},
        {"id": "middle", "intervals": [[25, 35, 10]]},
    ]

    def sampler(scoped_reads, max_reads, region_start, region_end):
        assert max_reads == 2
        assert region_start == 0
        assert region_end == 100
        return [scoped_reads[0], scoped_reads[1]]

    sampled = sample_compact_reads_for_display(reads, 2, 100, sampler)

    assert [read["id"] for read in sampled] == ["early", "late"]


def test_compact_read_payload_introspection():
    reads = [
        {"id": "a", "intervals": [], "methyl": [], "layers": {"tf": [], "nuc": []}},
        {"id": "b", "intervals": [], "methyl": [[1, 2, "m6a", 200]], "layers": {"fire": []}},
        {"id": "c", "intervals": []},
    ]

    assert compact_reads_have_methylation(reads) is True
    assert compact_reads_available_layers(reads) == ["fire", "nuc", "tf"]


def test_read_request_logging_is_quiet_for_fast_cached_requests(monkeypatch):
    monkeypatch.delenv(READ_DIAGNOSTICS_ENV, raising=False)
    monkeypatch.delenv(READ_LOG_THRESHOLD_ENV, raising=False)

    assert _should_log_read_request(0.001) is False
    assert _should_log_read_request(0.5) is False
    assert _should_log_read_request(1.0) is True


def test_read_request_logging_can_be_forced_or_retuned(monkeypatch):
    monkeypatch.setenv(READ_LOG_THRESHOLD_ENV, "0.2")
    monkeypatch.delenv(READ_DIAGNOSTICS_ENV, raising=False)
    assert _should_log_read_request(0.1) is False
    assert _should_log_read_request(0.3) is True

    monkeypatch.setenv(READ_DIAGNOSTICS_ENV, "1")
    assert _should_log_read_request(0.001) is True


def test_read_diagnostics_are_opt_in(monkeypatch, capsys):
    monkeypatch.delenv(READ_DIAGNOSTICS_ENV, raising=False)
    _log_read_diagnostic("hidden")
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(READ_DIAGNOSTICS_ENV, "1")
    _log_read_diagnostic("visible")
    assert capsys.readouterr().out == "visible\n"
