"""Regression tests for vectorized footprint analysis helpers."""

import json
from collections import OrderedDict

import numpy as np

from services.footprint_analysis import (
    add_cooccupancy_fdr,
    accumulate_profile_and_vplot,
    benjamini_hochberg,
    bootstrap_profile_ci,
    build_interval_table,
    cap_working_set_reads,
    compute_cooccupancy_result,
    compute_group_memberships,
    compute_overlap_stats,
    FootprintLayerResolver,
    footprint_analysis_needs_layers,
    get_cached_interval_table,
    make_read_bootstrap_weights,
    _sorted_read_ids as sort_footprint_read_ids,
)
from services.derived_layer_export import materialize_derived_layer_bundles
from services.footprint_endpoint import analyze_footprints_payload
from services import motifs as motif_service
from models.domain import ChromInfo, Dataset
from models.requests import FootprintAnalysisRequest
from routers import footprint as footprint_router


def _intervals(read):
    return read.get("intervals", [])


class DummyWorkingSet:
    def __init__(self, reads, total_overlapping, total_spanning, chrom, start, end):
        self.reads = reads
        self.total_overlapping = total_overlapping
        self.total_spanning = total_spanning
        self.chrom = chrom
        self.start = start
        self.end = end
        self._interval_table_cache = OrderedDict()


class DummyDataset:
    def __init__(self):
        self.id = "ds1"
        self.label = "Sample One"
        self.path = "/tmp/sample.bam"
        self.paths = [self.path]


class DummyQuery:
    chrom = "chr1"
    start = 100
    end = 200
    spanning = False
    dataset_ids = ["ds1"]
    sample_seed = "seed"
    max_reads = None

    def __init__(self, reads):
        self._reads = reads
        self.last_build_kwargs = None

    def build_working_set(self, _state, _dataset_id, **_kwargs):
        self.last_build_kwargs = dict(_kwargs)
        return DummyWorkingSet(self._reads, len(self._reads), len(self._reads), self.chrom, self.start, self.end)

    def cap_reads(self, reads, *, namespace, label):
        return reads


class DummyFasta:
    references = ["chr1"]

    def fetch(self, _chrom, _start, _end):
        return "TTTGAGATTTGAGATTT"


class DummyFootprintState:
    def __init__(self):
        counts = motif_service.consensus_to_pwm("GAGA")
        self.fasta = DummyFasta()
        self.current_genome = None
        self.dataset_order = ["ds1"]
        self.datasets = {"ds1": object()}
        self.orthogonal_tracks = [{
            "path": "motif://sequence/GAGA",
            "label": "GAGA",
            "format": "custom_motif",
            "render_mode": "annotation",
            "category": "motif",
            "motif_name": "GAGA",
            "motif_type": "sequence",
            "counts": counts,
            "pssm": motif_service.pwm_to_pssm(counts),
        }]

    def translate_chrom(self, chrom):
        return chrom

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)


def test_footprint_motif_scan_uses_selected_custom_tracks_and_request_pwms():
    state = DummyFootprintState()
    request = FootprintAnalysisRequest(
        footprints=[{"absStart": 4, "absEnd": 8, "size": 4}],
        dataset_ids=["ds1"],
        include_read_analysis=False,
        auto_motifs=False,
        motif_track_indices=[0],
        custom_pwms=[{
            "name": "TATA",
            "counts": motif_service.consensus_to_pwm("TATA"),
        }],
        motif_threshold=0.8,
    )

    result = analyze_footprints_payload(
        state,
        chrom="chr1",
        region_start=0,
        region_end=20,
        spanning=False,
        request=request,
    )

    assert result["success"] is True
    assert {source["source"] for source in result["motif_sources"]} == {"track", "request_pwm"}
    assert any(source.get("track_index") == 0 for source in result["motif_sources"])
    assert "motif_pwms" in result and len(result["motif_pwms"]) == 2
    assert result["footprints"][0]["motif_hits"]

    excluded = analyze_footprints_payload(
        state,
        chrom="chr1",
        region_start=0,
        region_end=20,
        spanning=False,
        request=FootprintAnalysisRequest(
            footprints=[{"absStart": 4, "absEnd": 8, "size": 4}],
            dataset_ids=["ds1"],
            include_read_analysis=False,
            auto_motifs=False,
            motif_track_indices=[],
        ),
    )
    assert excluded["motif_sources"] == []
    assert excluded["motif_pwms"] == {}


def test_auto_jaspar_scans_every_species_motif_and_keeps_the_best(monkeypatch):
    """The automatic scan covers all CORE motifs (not the first 20) and
    reports only the best-scoring ones, with logos only for those."""
    from types import SimpleNamespace
    import services.footprint_endpoint as endpoint

    def record(i, seq):
        counts = motif_service.consensus_to_pwm(seq)
        return (SimpleNamespace(matrix_id=f"MA{i:04d}.1", name=f"M{i}", counts=counts), motif_service.pwm_to_pssm(counts))

    # 30 decoys that never match, then the one that does (was past the old cutoff).
    library = [record(i, "CCCCCCCC") for i in range(30)] + [record(99, "GAGATTTGAGA")]
    monkeypatch.setattr(motif_service, "GENOME_TO_JASPAR_SPECIES", {"toy": 1})
    monkeypatch.setattr(motif_service, "check_pyjaspar", lambda: True)
    monkeypatch.setattr(motif_service, "get_jaspar_core_pssms", lambda _species: library)
    monkeypatch.setattr(endpoint, "AUTO_JASPAR_TOP_MOTIFS", 3)
    state = DummyFootprintState()
    state.current_genome = "toy"
    result = analyze_footprints_payload(
        state, chrom="chr1", region_start=0, region_end=20, spanning=False,
        request=FootprintAnalysisRequest(
            footprints=[{"absStart": 3, "absEnd": 14, "size": 11}],
            dataset_ids=["ds1"], include_read_analysis=False,
            auto_motifs=True, motif_track_indices=[], motif_threshold=0.9,
        ),
    )
    names = {hit["motif_name"] for hit in result["footprints"][0]["motif_hits"]}
    assert names == {"M99"}
    assert set(result["motif_pwms"]) == {"MA0099.1"}
    assert [source["id"] for source in result["motif_sources"]] == ["MA0099.1"]


def test_layer_resolver_uses_primary_or_structured_layers():
    read = {
        "id": "r1",
        "intervals": [[0, 100, 150]],
        "layers": {
            "nuc": {"intervals": [[10, 50, 40], [10, 50, 40]]},
            "tf": {"intervals": [[60, 80, 20]]},
            "msp": {"intervals": [[0, 100, 1]]},
            "deam": {"intervals": [[12, 12, 1]]},
        },
    }

    assert list(FootprintLayerResolver().intervals(read)) == [[0, 100, 150]]
    assert list(FootprintLayerResolver("tf").intervals(read)) == [[60, 80, 20]]

    all_fp = FootprintLayerResolver("all_fp")
    assert list(all_fp.intervals(read)) == [[10, 50, 40], [60, 80, 20]]
    assert all_fp.missing_warning() is None


def test_layer_resolver_reports_missing_requested_layer():
    resolver = FootprintLayerResolver("tf")

    assert list(resolver.intervals({"id": "r1", "layers": {}})) == []
    assert "Layer 'tf' is selected" in resolver.missing_warning()


def test_footprint_warning_once_keeps_console_quiet(capsys):
    footprint_router._footprint_warning_once_keys.clear()

    assert footprint_router._print_footprint_warning_once(("motif", "missing"), "warning one") is True
    assert footprint_router._print_footprint_warning_once(("motif", "missing"), "warning one") is False
    assert footprint_router._print_footprint_warning_once(("motif", "other"), "warning two") is True

    captured = capsys.readouterr()
    assert captured.out.splitlines() == ["warning one", "warning two"]


def test_footprint_read_id_lists_are_stably_sorted():
    assert sort_footprint_read_ids({"read_10", "read_2", "read_1"}) == [
        "read_1",
        "read_10",
        "read_2",
    ]


def test_family_cart_membership_filters_nested_tf_sr_by_fi_and_fq():
    reads = [
        {
            "id": "r1",
            "layers": {
                "tf_sr": {
                    "intervals": [[10, 30, 20], [12, 28, 16]],
                    "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                    "qualities": [[255, 255], [0, 0], [0, 0], [7, 8], [230, 250]],
                }
            },
        },
        {
            "id": "r2",
            "layers": {
                "tf_sr": {
                    "intervals": [[11, 29, 18]],
                    "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                    "qualities": [[255], [0], [0], [7], [100]],
                }
            },
        },
        {
            "id": "latent",
            "layers": {
                "tf_sr": {
                    "intervals": [[11, 29, 18]],
                    "annotation_names": ["fhlt_deadbeefdeadbeef_R0"],
                    "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                    "qualities": [[10], [255], [128], [7], [254]],
                }
            },
        },
    ]
    resolver = FootprintLayerResolver("tf_sr")
    table = build_interval_table(
        reads,
        resolver.intervals,
        region_start=100,
        family_metadata_getter=resolver.family_metadata,
    )
    groups = [
        {
            "referenceAbsStart": 105,
            "referenceAbsEnd": 135,
            "sizeMin": 0,
            "sizeMax": None,
            "familyId": 7,
            "minFamilyConfidence": 0.8,
        },
        {
            "sourceIndex": -1,
            "sizeMin": 0,
            "sizeMax": None,
            "familyId": 7,
            "minFamilyConfidence": 0,
        },
    ]
    memberships = compute_group_memberships(table, groups, [])
    assert memberships == {0: {"r1"}, 1: {"r1", "r2", "latent"}}


def test_layer_resolver_aliases_fire_and_internal_msp():
    fire_resolver = FootprintLayerResolver("fire")
    msp_resolver = FootprintLayerResolver("msp")

    assert list(fire_resolver.intervals({"id": "r2", "layers": {"msp": {"intervals": [[5, 12, 7]]}}})) == [[5, 12, 7]]
    assert fire_resolver.missing_warning() is None
    assert list(msp_resolver.intervals({"id": "r3", "layers": {"fire": {"intervals": [[40, 55, 15]]}}})) == [[40, 55, 15]]
    assert msp_resolver.missing_warning() is None


def test_all_fp_resolver_aligns_tf_sr_family_metadata_after_deduplication():
    read = {
        "layers": {
            "tf": {"intervals": [[10, 30, 20]]},
            "tf_sr": {
                "intervals": [[10, 30, 20], [40, 55, 15]],
                "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                "qualities": [[255, 255], [0, 0], [0, 0], [7, 8], [204, 230]],
            },
        },
    }
    resolver = FootprintLayerResolver("all_fp")
    assert list(resolver.intervals(read)) == [[10, 30, 20], [40, 55, 15]]
    assert resolver.family_metadata(read) == [(7, 204, 1), (8, 230, 1)]


def test_tf_sr_resolver_uses_unclipped_source_bounds_for_membership():
    read = {
        "id": "edge",
        "layers": {
            "tf_sr": {
                "intervals": [[0, 3, 5]],
                "source_intervals": [[-2, 3, 5]],
                "quality_names": ["q0", "q1", "q2", "fi", "fq"],
                "qualities": [[255], [0], [0], [7], [230]],
            },
        },
    }
    resolver = FootprintLayerResolver("tf_sr")
    table = build_interval_table(
        [read], resolver.intervals, region_start=1000,
        family_metadata_getter=resolver.family_metadata,
    )
    assert (table.starts[0], table.ends[0]) == (998, 1003)


def test_footprint_analysis_layer_payload_gate():
    assert footprint_analysis_needs_layers("tf", None, include_profiles=False)
    assert footprint_analysis_needs_layers(None, ["nuc"], include_profiles=True)
    assert not footprint_analysis_needs_layers(None, ["nuc"], include_profiles=False)


def test_working_set_cap_preserves_counts_and_is_stable():
    reads = [{"id": f"r{i}", "intervals": [[0, 10, 10]]} for i in range(10)]
    ws = DummyWorkingSet(reads, total_overlapping=20, total_spanning=15, chrom="chr1", start=100, end=200)

    capped_a = cap_working_set_reads(ws, 4, seed="cap-seed")
    capped_b = cap_working_set_reads(ws, 4, seed="cap-seed")

    assert len(capped_a.reads) == 4
    assert [r["id"] for r in capped_a.reads] == [r["id"] for r in capped_b.reads]
    assert capped_a.total_overlapping == 20
    assert capped_a.total_spanning == 15
    assert capped_a.chrom == "chr1"


def test_cached_interval_table_reuses_working_set_cache():
    ws = DummyWorkingSet(
        [{"id": "r1", "intervals": [[0, 10, 10]]}],
        total_overlapping=1,
        total_spanning=1,
        chrom="chr1",
        start=100,
        end=200,
    )

    first = get_cached_interval_table(ws, ("test", "primary"), _intervals)
    second = get_cached_interval_table(ws, ("test", "primary"), _intervals)

    assert first is second
    assert list(ws._interval_table_cache.keys()) == [("test", "primary")]


def test_overlap_stats_use_first_matching_interval_per_read():
    reads = [
        {"id": "r1", "intervals": [[0, 20, -1], [20, 40, 30], [45, 70, 55]]},
        {"id": "r2", "intervals": [[30, 60, 75]]},
        {"id": "r3", "intervals": [[80, 100, 45]]},
    ]
    table = build_interval_table(reads, _intervals, region_start=100)
    stats = compute_overlap_stats(table, [{"absStart": 125, "absEnd": 155}], total_reads=len(reads))

    entry = stats[0]
    assert entry["overlap_count"] == 2
    assert entry["overlap_fraction"] == 0.6667
    assert entry["overlap_sizes"] == [30, 75]
    assert entry["size_mean"] == 52.5


def test_overlap_stats_can_omit_raw_size_payload():
    reads = [
        {"id": "r1", "intervals": [[20, 40, 30]]},
        {"id": "r2", "intervals": [[30, 60, 75]]},
    ]
    table = build_interval_table(reads, _intervals, region_start=100)
    stats = compute_overlap_stats(
        table,
        [{"absStart": 125, "absEnd": 155}],
        total_reads=len(reads),
        include_sizes=False,
    )

    entry = stats[0]
    assert entry["overlap_count"] == 2
    assert entry["size_histogram"]["counts"]
    assert "overlap_sizes" not in entry


def test_profile_and_vplot_match_expected_bins():
    reads = [
        {"id": "r1", "intervals": [[90, 110, 50], [120, 140, 100]]},
        {"id": "r2", "intervals": [[100, 120, 60]]},
    ]
    table = build_interval_table(reads, _intervals, region_start=0)

    agg, vplot = accumulate_profile_and_vplot(
        table,
        [{"absStart": 100, "absEnd": 120}],
        profile_window=30,
        size_min=40,
        size_max=120,
        size_bin=20,
        pos_bin=10,
    )

    # Centers: 100, 130, 110 relative to selected center 110.
    assert agg[20] == 1
    assert agg[30] == 1
    assert agg[50] == 1
    assert int(agg.sum()) == 3
    assert vplot.shape == (4, 6)
    assert int(vplot.sum()) == 3


def test_group_memberships_apply_size_and_overlap_thresholds():
    reads = [
        {"id": "inside", "intervals": [[100, 140, 40]]},
        {"id": "too_small", "intervals": [[105, 135, 20]]},
        {"id": "partial", "intervals": [[130, 170, 40]]},
    ]
    table = build_interval_table(reads, _intervals, region_start=0)
    groups = [{
        "referenceAbsStart": 100,
        "referenceAbsEnd": 140,
        "sizeMin": 35,
        "sizeMax": 45,
        "minFpCoverage": 1.0,
        "minTargetCoverage": 1.0,
    }]

    memberships = compute_group_memberships(table, groups, [])
    assert memberships[0] == {"inside"}


def test_cooccupancy_result_keeps_counts_and_ids_consistent():
    reads = [
        {"id": "r1", "intervals": [[10, 30, 20], [60, 80, 20]]},
        {"id": "r2", "intervals": [[10, 30, 20]]},
        {"id": "r3", "intervals": []},
    ]
    table = build_interval_table(reads, _intervals, region_start=100)
    groups = [
        {
            "id": "a",
            "name": "A",
            "sizeMin": 1,
            "referenceAbsStart": 110,
            "referenceAbsEnd": 130,
        },
        {
            "id": "b",
            "name": "B",
            "sizeMin": 1,
            "referenceAbsStart": 160,
            "referenceAbsEnd": 180,
        },
    ]

    result = compute_cooccupancy_result(
        table,
        groups,
        [],
        fisher_exact_func=lambda _table: (1.0, 0.5),
    )

    assert result["total_reads"] == 3
    assert result["per_group"][0] == {
        "eligible_reads": 3,
        "n_with": 2,
        "n_without": 1,
        "ids_with": ["r1", "r2"],
        "ids_without": ["r3"],
    }
    # r2 ends at 130, before B (160-180): it was never observed at B, so it is not counted as lacking B (this test
    # used to expect it among B's "without" reads, the release-audit co-occupancy bias). r3 carries no extent at all
    # and stays eligible.
    assert result["per_group"][1] == {
        "eligible_reads": 2,
        "n_with": 1,
        "n_without": 1,
        "ids_with": ["r1"],
        "ids_without": ["r3"],
    }
    assert result["pairs"][0]["table"] == [[1, 0], [0, 1]]
    assert result["pairs"][0]["ids_both"] == ["r1"]
    assert result["pairs"][0]["ids_i_only"] == []
    assert result["pairs"][0]["ids_j_only"] == []
    assert result["pairs"][0]["ids_neither"] == ["r3"]


def test_cooccupancy_bh_correction_spans_datasets_and_pairs():
    payload = {
        "ds1": {"pairs": [{"p_value": 0.01}, {"p_value": 0.04}]},
        "ds2": {"pairs": [{"p_value": 0.03}]},
    }

    assert benjamini_hochberg([0.01, 0.04, 0.03]) == [0.03, 0.04, 0.04]
    returned = add_cooccupancy_fdr(payload)

    assert returned is payload
    assert payload["ds1"]["pairs"][0]["q_value"] == 0.03
    assert payload["ds1"]["pairs"][1]["q_value"] == 0.04
    assert payload["ds2"]["pairs"][0]["q_value"] == 0.04


def test_profile_bootstrap_resamples_whole_reads_deterministically():
    reads = [
        {"id": "hit", "intervals": [[45, 55, 10]]},
        {"id": "miss", "intervals": []},
    ]
    table = build_interval_table(reads, _intervals, region_start=0)
    footprints = [{"absStart": 45, "absEnd": 55}]

    first = bootstrap_profile_ci(table, footprints, 5, seed="profile", resamples=500)
    second = bootstrap_profile_ci(table, footprints, 5, seed="profile", resamples=500)

    assert first == second
    assert first["n_reads"] == 2
    assert first["resamples"] == 500
    assert first["method"] == "whole-read bootstrap percentile"
    # At the central profile bin a two-read bootstrap can draw the hit read
    # zero, one, or two times. This proves the resampling unit is a read row,
    # rather than the already-aggregated profile bin.
    assert first["low"][5] == 0.0
    assert first["high"][5] == 2.0
    assert sum(first["high"]) == 2.0


def test_profile_bootstrap_single_read_collapses_to_observed_profile():
    table = build_interval_table(
        [{"id": "only", "intervals": [[45, 55, 10]]}],
        _intervals,
        region_start=0,
    )
    ci = bootstrap_profile_ci(table, [{"absStart": 45, "absEnd": 55}], 2, seed="one")

    assert ci["low"] == ci["high"]
    assert ci["low"] == [0.0, 0.0, 1.0, 0.0, 0.0]


def test_profile_bootstrap_reuses_a_compact_deterministic_weight_plan():
    first = make_read_bootstrap_weights(300, seed="shared", resamples=40)
    second = make_read_bootstrap_weights(300, seed="shared", resamples=40)

    assert first.dtype == np.uint16
    assert np.array_equal(first, second)
    assert first.shape == (40, 300)
    assert np.all(first.sum(axis=1) == 300)

    table = build_interval_table(
        [{"id": "hit", "intervals": [[45, 55, 10]]}, {"id": "miss", "intervals": []}],
        _intervals,
        region_start=0,
    )
    weights = make_read_bootstrap_weights(2, seed="paired", resamples=100)
    ci = bootstrap_profile_ci(
        table,
        [{"absStart": 45, "absEnd": 55}],
        2,
        seed="ignored-when-plan-is-supplied",
        weights=weights,
    )
    assert ci["resamples"] == 100


def test_interval_table_keeps_all_read_ids_when_no_positive_intervals():
    reads = [
        {"id": "gap1", "intervals": [[0, 100, -100]]},
        {"id": "gap2", "intervals": []},
    ]
    table = build_interval_table(reads, _intervals, region_start=0)

    assert table.empty
    assert table.read_ids == ["gap1", "gap2"]
    assert np.array_equal(table.sizes, np.array([], dtype=np.int32))


def test_derived_layer_export_writes_manifest_and_bed_without_bigbed(tmp_path, monkeypatch):
    monkeypatch.setattr("services.derived_layer_export.shutil.which", lambda _name: None)
    dataset = DummyDataset()
    state = type("State", (), {
        "chroms": [ChromInfo(name="chr1", size=1000)],
        "get_dataset": lambda self, dataset_id: dataset if dataset_id == "ds1" else None,
    })()
    reads = [
        {
            "id": "r1",
            "intervals": [[0, 10, 10], [20, 50, 30]],
            "qualities": [100, 200],
            "layers": {
                "tf": {
                    "intervals": [[5, 15, 10], [30, 45, 15]],
                    "quality_names": ["tq"],
                    "qualities": [[230, 128]],
                }
            },
        }
    ]
    groups = [
        {
            "id": "g-primary",
            "name": "Primary class",
            "color": "#112233",
            "layer": None,
            "sizeMin": 20,
            "sizeMax": 35,
            "referenceAbsStart": 115,
            "referenceAbsEnd": 140,
            "enabled": True,
        },
        {
            "id": "g-tf",
            "name": "TF class",
            "color": "#445566",
            "layer": "tf",
            "sizeMin": 1,
            "sizeMax": 12,
            "referenceAbsStart": 100,
            "referenceAbsEnd": 120,
            "enabled": True,
        },
    ]

    results = materialize_derived_layer_bundles(
        state=state,
        query=DummyQuery(reads),
        groups=groups,
        output_dir=str(tmp_path),
        bundle_name="my classes",
        genome="dm6",
    )

    assert len(results) == 1
    result = results[0]
    assert result.bigbed_path is None
    assert result.n_rows == 2
    assert result.n_intervals == 2
    assert "bedToBigBed not found" in result.warnings[0]

    bed_lines = open(result.bed_path, encoding="utf-8").read().strip().splitlines()
    assert len(bed_lines) == 2
    primary_fields = bed_lines[0].split("\t")
    tf_fields = bed_lines[1].split("\t")
    assert primary_fields[:4] == ["chr1", "105", "115", "r1"]
    assert primary_fields[12].startswith("tf_class_")
    assert primary_fields[13] == "tf"
    assert primary_fields[15] == "230"
    assert tf_fields[:4] == ["chr1", "120", "150", "r1"]
    assert tf_fields[12].startswith("primary_class_")
    assert tf_fields[13] == "footprint"
    assert tf_fields[15] == "200"

    manifest = json.loads(open(result.manifest_path, encoding="utf-8").read())
    assert manifest["schema"] == "fiberlayers.v1"
    assert manifest["source_dataset"]["genome"] == "dm6"
    assert set(manifest["classes"]) == {primary_fields[12], tf_fields[12]}


def test_derived_layer_export_all_fp_loads_all_footprint_layers_without_signal_layers(tmp_path, monkeypatch):
    monkeypatch.setattr("services.derived_layer_export.shutil.which", lambda _name: None)
    dataset = DummyDataset()
    state = type("State", (), {
        "chroms": [ChromInfo(name="chr1", size=1000)],
        "get_dataset": lambda self, dataset_id: dataset if dataset_id == "ds1" else None,
    })()
    reads = [{
        "id": "r1",
        "intervals": [[70, 90, 20]],
        "layers": {
            "nuc": {"intervals": [[0, 20, 20]]},
            "tf": {"intervals": [[30, 45, 15]]},
            "msp": {"intervals": [[60, 80, 20]]},
            "fire": {"intervals": [[85, 95, 10]]},
            "deam": {"intervals": [[10, 10, 1]]},
        },
    }]
    groups = [{
        "id": "g-all",
        "name": "All FP",
        "color": "#123456",
        "layer": "all_fp",
        "sizeMin": 1,
        "sizeMax": 80,
        "enabled": True,
    }]
    query = DummyQuery(reads)

    results = materialize_derived_layer_bundles(
        state=state,
        query=query,
        groups=groups,
        output_dir=str(tmp_path),
        bundle_name="all fp",
    )

    assert query.last_build_kwargs["include_layers"] is True
    assert query.last_build_kwargs["requested_layers"] is None
    assert len(results) == 1
    assert results[0].n_rows == 1
    assert results[0].n_intervals == 2

    fields = open(results[0].bed_path, encoding="utf-8").read().strip().split("\t")
    assert fields[9] == "2"
    assert fields[10] == "20,15,"
    assert fields[11] == "0,30,"
    assert fields[12].startswith("all_fp_")
    assert fields[13] == "all_fp"


def test_derived_layer_export_normalizes_legacy_msp_rule_to_fire(tmp_path, monkeypatch):
    monkeypatch.setattr("services.derived_layer_export.shutil.which", lambda _name: None)
    dataset = DummyDataset()
    state = type("State", (), {
        "chroms": [ChromInfo(name="chr1", size=1000)],
        "get_dataset": lambda self, dataset_id: dataset if dataset_id == "ds1" else None,
    })()
    reads = [{
        "id": "r1",
        "intervals": [[0, 100, 100]],
        "layers": {
            "msp": {"intervals": [[10, 40, 30]]},
        },
    }]
    query = DummyQuery(reads)

    results = materialize_derived_layer_bundles(
        state=state,
        query=query,
        groups=[{
            "id": "legacy-msp",
            "name": "Legacy MSP",
            "layer": "msp",
            "sizeMin": 1,
            "sizeMax": 80,
            "enabled": True,
        }],
        output_dir=str(tmp_path),
        bundle_name="legacy msp",
    )

    assert query.last_build_kwargs["requested_layers"] == ("fire", "msp")
    fields = open(results[0].bed_path, encoding="utf-8").read().strip().split("\t")
    assert fields[13] == "fire"
    manifest = json.loads(open(results[0].manifest_path, encoding="utf-8").read())
    class_meta = next(iter(manifest["classes"].values()))
    assert class_meta["source_layer"] == "fire"
    assert class_meta["rules"]["source_layer"] == "fire"


def test_derived_layer_export_route_materializes_and_registers_bigbed(client, tmp_path, monkeypatch):
    import server as srv

    previous_state = srv.state
    state = srv.BrowserState(None, None, None, None)
    dataset = Dataset("ds1", "/tmp/source.bam", "Source", data_type="bam")
    state.datasets = {"ds1": dataset}
    state.dataset_order = ["ds1"]
    state.chroms = [ChromInfo(name="chr1", size=1000)]
    state.current_genome = "dm6"
    srv.state = state

    calls = {
        "materialize": None,
        "register": [],
        "invalidate": [],
    }

    class FakeBundle:
        dataset_id = "ds1"
        dataset_label = "Source"
        manifest_path = str(tmp_path / "cart.fiberlayers.json")
        bed_path = str(tmp_path / "cart.fiberlayers.bed")
        autosql_path = str(tmp_path / "cart.fiberlayers.as")
        chrom_sizes_path = str(tmp_path / "cart.chrom.sizes")
        bigbed_path = str(tmp_path / "cart.fiberlayers.bb")
        n_rows = 1
        n_intervals = 1
        classes = [{"id": "short_tf", "label": "Short TF"}]
        warnings = []

        def to_dict(self):
            return {
                "dataset_id": self.dataset_id,
                "dataset_label": self.dataset_label,
                "manifest_path": self.manifest_path,
                "bed_path": self.bed_path,
                "autosql_path": self.autosql_path,
                "chrom_sizes_path": self.chrom_sizes_path,
                "bigbed_path": self.bigbed_path,
                "n_rows": self.n_rows,
                "n_intervals": self.n_intervals,
                "classes": self.classes,
                "warnings": self.warnings,
            }

    def fake_materialize(**kwargs):
        calls["materialize"] = kwargs
        return [FakeBundle()]

    def fake_register(dataset_arg, path, *, primary_path=None):
        calls["register"].append((dataset_arg.id, path, primary_path))
        dataset_arg.derived_layers = {
            "short_tf": {
                "id": "short_tf",
                "label": "Short TF",
                "bundle_path": path,
            }
        }

    def fake_invalidate(_state, dataset_id):
        calls["invalidate"].append(dataset_id)

    monkeypatch.setattr("routers.derived_layers.materialize_derived_layer_bundles", fake_materialize)
    monkeypatch.setattr("routers.derived_layers.register_derived_layer_file", fake_register)
    monkeypatch.setattr("routers.derived_layers.invalidate_dataset_caches", fake_invalidate)

    try:
        response = client.post(
            "/api/footprint/derived_layers/export",
            params={
                "chrom": "chr1",
                "region_start": 100,
                "region_end": 200,
                "spanning": "false",
            },
            json={
                "dataset_ids": ["ds1"],
                "groups": [
                    {"id": "enabled", "name": "Enabled", "layer": "tf", "enabled": True},
                    {"id": "disabled", "name": "Disabled", "layer": "tf", "enabled": False},
                ],
                "output_dir": str(tmp_path),
                "bundle_name": "cart",
                "sample_seed": "paper-seed",
            },
        )
    finally:
        srv.state = previous_state

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["bundles"][0]["bigbed_path"] == str(tmp_path / "cart.fiberlayers.bb")
    assert payload["datasets"][0]["derived_layers"]["short_tf"]["bundle_path"] == str(tmp_path / "cart.fiberlayers.bb")
    assert calls["register"] == [("ds1", str(tmp_path / "cart.fiberlayers.bb"), "/tmp/source.bam")]
    assert calls["invalidate"] == ["ds1"]

    materialize_args = calls["materialize"]
    assert materialize_args["output_dir"] == str(tmp_path)
    assert materialize_args["bundle_name"] == "cart"
    assert materialize_args["genome"] == "dm6"
    assert materialize_args["groups"] == [{"id": "enabled", "name": "Enabled", "layer": "tf", "enabled": True}]
    assert materialize_args["query"].dataset_ids == ["ds1"]
    assert materialize_args["query"].sample_seed == "paper-seed"


def test_derived_layer_load_route_attaches_manifest_selected_bundle(client, tmp_path):
    import server as srv

    previous_state = srv.state
    state = srv.BrowserState(None, None, None, None)
    dataset = Dataset("ds1", "/tmp/source.bam", "Source", data_type="bam")
    state.datasets = {"ds1": dataset}
    state.dataset_order = ["ds1"]
    srv.state = state

    bundle_path = tmp_path / "cart.fiberlayers.bed"
    bundle_path.write_text("chr1\t100\t110\tread1\t0\t.\t100\t110\t249,115,22\t1\t10,\t0,\tshort_fire\tfire\trule-1\t.\n", encoding="utf-8")
    manifest_path = tmp_path / "cart.fiberlayers.json"
    manifest_path.write_text(json.dumps({
        "schema": "fiberlayers.v1",
        "files": {"bigbed": None, "bed": bundle_path.name},
        "source_dataset": {"path": "/tmp/source.bam"},
        "classes": {
            "short_fire": {
                "id": "short_fire",
                "label": "Short FIRE",
                "source_layer": "fire",
                "color": "#f97316",
            },
        },
    }), encoding="utf-8")

    try:
        response = client.post(
            "/api/footprint/derived_layers/load",
            json={"path": str(manifest_path), "dataset_ids": ["ds1"]},
        )
    finally:
        srv.state = previous_state

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["bundle_path"] == str(bundle_path)
    assert payload["attached"] == [{"dataset_id": "ds1", "layer_ids": ["short_fire"]}]
    assert payload["datasets"][0]["derived_layers"]["short_fire"]["label"] == "Short FIRE"
    assert payload["datasets"][0]["available_layers"]["short_fire"] is True


def test_all_fp_named_identity_tracks_selected_family_row_and_cross_quality():
    read={'id':'r','layers':{
        'tf':{'intervals':[[10,30,20]]},
        'tf_cross_consensus':{'intervals':[[10,30,20]],'annotation_names':['fhxcr_model'],
            'quality_names':['fi','xq'],'qualities':[[7],[230]]}}}
    resolver=FootprintLayerResolver('all_fp')
    assert resolver.annotation_names(read)==['fhxcr_model']
    assert resolver.annotation_layers(read)==['tf_cross_consensus']
    assert resolver.family_metadata(read)==[(7,230,1)]


def test_family_target_coverage_uses_model_not_observation_hull():
    from services.footprint_analysis import _group_reference
    assert _group_reference(dict(referenceAbsStart=0,referenceAbsEnd=100,
        familyModelAbsStart=30,familyModelAbsEnd=50),[])==(30,50)


def test_jaspar_species_follows_the_loaded_chromosomes_when_the_genome_name_is_stale():
    from types import SimpleNamespace
    from services.motifs import jaspar_genome
    fly = [SimpleNamespace(name=n) for n in ("chr2L", "chr2R", "chr3L", "chr3R", "chr4", "chrX")]
    assert jaspar_genome(SimpleNamespace(current_genome="hg38", chroms=fly)) == ("dm6", True)
    assert jaspar_genome(SimpleNamespace(current_genome="dm6", chroms=fly)) == ("dm6", False)
    assert jaspar_genome(SimpleNamespace(current_genome=None, chroms=fly)) == ("dm6", True)
    assert jaspar_genome(SimpleNamespace(current_genome="hg38", chroms=[])) == ("hg38", False)


def test_selected_layer_family_rows_line_up_with_aliased_intervals():
    # 'fire' resolves to the read's msp layer for intervals; its family rows
    # must too, or the tf_sr tags shift onto the msp intervals.
    read = {"id": "r", "layers": {
        "msp": {"intervals": [[0, 10, 10], [20, 30, 10]]},
        "tf_sr": {"intervals": [[40, 50, 10]], "quality_names": ["fi"], "qualities": [[7]]},
    }}
    resolver = FootprintLayerResolver(None, selected_layers=("fire", "tf_sr"))
    intervals = list(resolver.intervals(read))
    rows = resolver.family_metadata(read)
    assert len(rows) == len(intervals) == 3
    assert [row[0] for row in rows] == [0, 0, 7]


def test_first_footprint_keeps_its_position():
    from services.footprint_analysis import _group_reference
    footprints = [{"absStart": 100, "absEnd": 120}, {"absStart": 500, "absEnd": 520}]
    assert _group_reference({"sourceIndex": 0}, footprints) == (100, 120)
    assert _group_reference({"source_index": 1}, footprints) == (500, 520)
    assert _group_reference({}, footprints) is None


def test_vplot_with_an_empty_size_range_is_empty_not_an_error():
    # A size range with no bins (min == max) used to raise on .max(), and the
    # handler then replaced the profile with an error too.
    from services.footprint_endpoint import normalized_vplot_matrix
    assert normalized_vplot_matrix(np.zeros((0, 6))) == []
    assert normalized_vplot_matrix(np.zeros((0, 6)), smooth=1.5, log=True) == []
    assert normalized_vplot_matrix(np.array([[0, 2], [4, 0]])) == [[0.0, 0.5], [1.0, 0.0]]



def test_all_fp_layer_selections_and_groups():
    read = {"id": "r", "layers": {
        "nuc": {"intervals": [[0, 100, 100]], "annotation_names": ["n"]},
        "tf": {"intervals": [[120, 140, 20]], "annotation_names": ["t"]},
    }}
    resolver = FootprintLayerResolver(None, selected_layers=("all_fp",))
    assert len(resolver.annotation_names(read)) == len(list(resolver.intervals(read))) == 2
    table = build_interval_table([read], FootprintLayerResolver("all_fp").intervals, 0)
    members = compute_group_memberships(table, [{"layer": "all_fp", "sizeMin": 10, "sizeMax": 30}], [])
    assert members[0] == {"r"}


# ---------------------------------------------------------------- shared motif scorer (p-value mode)
def _toy_library(monkeypatch, endpoint, seqs):
    from types import SimpleNamespace
    library = []
    for i, seq in enumerate(seqs):
        counts = motif_service.consensus_to_pwm(seq)
        library.append((SimpleNamespace(matrix_id=f"MA{i:04d}.1", name=f"M{i}", counts=counts), motif_service.pwm_to_pssm(counts)))
    monkeypatch.setattr(motif_service, "GENOME_TO_JASPAR_SPECIES", {"toy": 1})
    monkeypatch.setattr(motif_service, "JASPAR_SPECIES_NAMES", {1: "fly"})
    monkeypatch.setattr(motif_service, "check_pyjaspar", lambda: True)
    monkeypatch.setattr(motif_service, "get_jaspar_core_pssms", lambda _species: library)
    return library


def test_footprint_motifs_default_to_p_values_ranked_by_p_with_families(monkeypatch):
    import services.footprint_endpoint as endpoint
    # M0 and M1 are one family (one base differs) on the same bases; M2 is short: it cannot reach p <= 1e-4
    _toy_library(monkeypatch, endpoint, ["GAGATTTGAGA", "GAGATTTGAGC", "GAG"])
    state = DummyFootprintState()
    state.current_genome = "toy"
    result = analyze_footprints_payload(
        state, chrom="chr1", region_start=0, region_end=20, spanning=False,
        request=FootprintAnalysisRequest(footprints=[{"absStart": 3, "absEnd": 14, "size": 11}], dataset_ids=["ds1"],
                                         include_read_analysis=False, auto_motifs=True, motif_track_indices=[],
                                         motif_background="uniform"),
    )
    hits = result["footprints"][0]["motif_hits"]
    assert result["motif_scoring"]["mode"] == "p" and result["motif_scoring"]["p"] == 1e-4
    assert [h["motif_name"] for h in hits] == ["M0"]                      # the family's best, its member named
    assert hits[0]["family"] == ["M1"] and hits[0]["p"] < 1e-4
    # relative mode (an older client that sends motif_threshold): the older behaviour, no p-values
    rel = analyze_footprints_payload(
        state, chrom="chr1", region_start=0, region_end=20, spanning=False,
        request=FootprintAnalysisRequest(footprints=[{"absStart": 3, "absEnd": 14, "size": 11}], dataset_ids=["ds1"],
                                         include_read_analysis=False, auto_motifs=True, motif_track_indices=[], motif_threshold=0.9),
    )
    assert rel["motif_scoring"]["mode"] == "relative"
    assert {h["motif_name"] for h in rel["footprints"][0]["motif_hits"]} >= {"M0", "M1"}
    assert all("p" not in h for h in rel["footprints"][0]["motif_hits"])


def test_footprint_pinned_defaults_use_the_species_matrices(monkeypatch):
    import services.footprint_endpoint as endpoint
    from services import motif_scoring
    _toy_library(monkeypatch, endpoint, ["GAGATTTGAGA", "CCCCCCCCCC"])
    monkeypatch.setattr(motif_scoring, "PINNED_DEFAULTS", {"fly": ["M1"]})
    state = DummyFootprintState()
    state.current_genome = "toy"
    result = analyze_footprints_payload(
        state, chrom="chr1", region_start=0, region_end=20, spanning=False,
        request=FootprintAnalysisRequest(footprints=[{"absStart": 3, "absEnd": 14, "size": 11}], dataset_ids=["ds1"],
                                         include_read_analysis=False, auto_motifs=True, motif_track_indices=[],
                                         motif_mode="p", motif_background="uniform", pinned_defaults=True),
    )
    assert result["motif_scoring"]["pinned"] == ["M1"]
    assert "MA0001.1" in result["motif_pwms"]                              # pinned: kept (and its logo) even without a hit


def test_footprint_pinned_names_fall_back_to_the_taxon_and_say_so(monkeypatch):
    import services.footprint_endpoint as endpoint
    _toy_library(monkeypatch, endpoint, ["GAGATTTGAGA"])
    monkeypatch.setattr(motif_service, "genome_taxon", lambda g: "insects")
    monkeypatch.setattr(motif_service, "jaspar_catalog", lambda release="JASPAR2024": [
        {"matrix_id": "MA9001.1", "name": "Foo", "tax_group": "vertebrates", "counts": motif_service.consensus_to_pwm("GATTTGA")},
        {"matrix_id": "MA9002.1", "name": "Foo", "tax_group": "insects", "counts": motif_service.consensus_to_pwm("GATTTGA")},
    ])
    state = DummyFootprintState()
    state.current_genome = "toy"
    result = analyze_footprints_payload(
        state, chrom="chr1", region_start=0, region_end=20, spanning=False,
        request=FootprintAnalysisRequest(footprints=[{"absStart": 3, "absEnd": 14, "size": 11}], dataset_ids=["ds1"],
                                         include_read_analysis=False, auto_motifs=True, motif_track_indices=[],
                                         motif_mode="p", motif_background="uniform", custom_motif_names=["Foo", "Nope"]),
    )
    assert "MA9002.1" in result["motif_pwms"] and "MA9001.1" not in result["motif_pwms"]     # the assembly's taxon, not another's
    assert any("taxon group" in w for w in result["warnings"]) and any("Nope" in w for w in result["warnings"])
