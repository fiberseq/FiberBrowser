"""B2 round 8 (clustering/analysis) and B5 round 8 (sessions, figure peaks)."""
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))


# B2r8 #1: the client clusters each synced peak with the browser's feature mode.
def test_cluster_synced_peaks_uses_the_browser_peak_modes(monkeypatch):
    from test_browser_client import DummyClient

    client = DummyClient()
    monkeypatch.setattr(client, "get_analysis_state", lambda: {
        "selected_peaks": [7, 8, 9],
        # JSON keys are strings; an unset peak is accessibility, "off" is sent as is.
        "peak_modes": {"7": "m6a", "9": "off"},
        "peaks_by_rule": {"r": [
            {"index": 7, "start": 100, "end": 140, "source": "accessibility"},
            {"index": 8, "start": 200, "end": 240, "source": "accessibility"},
            {"index": 9, "start": 300, "end": 340, "source": "accessibility"},
        ]},
    })
    client.cluster_synced_peaks(chrom="chr2L", start=0, end=1000, dataset_ids=["ds"])
    _, endpoint, body, _ = client.calls[-1]
    assert endpoint == "/api/cluster_all"
    assert [p["mode"] for p in body["peak_regions"]] == ["m6a", "accessibility", "off"]


# B2r8 #2: MSP/FIRE calls emptied by a quality filter stay empty in Pol II rows.
def test_pol2_accessibility_keeps_filtered_empty_msp_and_fire():
    from models.requests import Pol2COMRequest
    from services.pol2_endpoint import _pol2_row_for_read

    req = Pol2COMRequest(fp_size_min=35, fp_size_max=65, n_bins=10)
    intervals = [[0, 40, 40], [40, 190, -150], [190, 230, 40], [230, 1000, -770]]
    kw = dict(region_start=0, region_end=1000, n_bins=10, gene_from=0, gene_to=1000, gene_strand="+")
    # No MSP/FIRE source at all: gaps over 100 bp are accessible.
    assert sum(_pol2_row_for_read({"id": "a", "intervals": intervals}, req, **kw)[3]) > 0
    # Every MSP call failed the gate (an explicitly empty layer): nothing is accessible.
    emptied_layer = {"id": "b", "intervals": intervals, "layers": {"msp": {"intervals": []}}}
    assert sum(_pol2_row_for_read(emptied_layer, req, **kw)[3]) == 0
    emptied_fire = {"id": "c", "intervals": intervals, "fire": []}
    assert sum(_pol2_row_for_read(emptied_fire, req, **kw)[3]) == 0
    # Surviving calls are used.
    kept = {"id": "d", "intervals": intervals, "layers": {"msp": {"intervals": [[500, 600, 100]]}}}
    row = _pol2_row_for_read(kept, req, **kw)[3]
    assert row[5] > 0 and row[1] == 0


# B2r8 #3: similarity sorting rebuilds the clustering's own features (modes, rules).
def test_similarity_sort_uses_the_stored_peak_modes_and_feature_settings(monkeypatch):
    import services.read_sorting as read_sorting

    seen = {}

    def fake_extract(reads, peaks, start, step=10, subnucleosomal_threshold=90, peak_modes=None,
                     cluster_feature_rules=None, cluster_rule_context=None):
        seen.update(peak_modes=peak_modes, threshold=subnucleosomal_threshold, rules=cluster_feature_rules,
                    context=cluster_rule_context)
        import numpy as np
        return np.array([[1.0], [0.0]]), ["a", "b"], [1], peak_modes

    monkeypatch.setattr(read_sorting, "extract_features_from_compact", fake_extract)
    import services.clustering_endpoint as ce
    monkeypatch.setattr(ce, "build_cluster_rule_context", lambda state, chrom, start, end: {"ctx": chrom})
    dataset = SimpleNamespace(
        cluster_assignments={"a": 0, "b": 1}, cluster_element_info=None,
        cluster_peak_regions=[{"start": 110, "end": 150, "mode": "m6a"}],
        cluster_feature_settings={"subnucleosomal_threshold": 120, "cluster_feature_rules": [{"id": "r1"}]},
    )
    state = SimpleNamespace(
        get_dataset=lambda ds: dataset,
        translate_chrom=lambda c: c,
        build_working_set=lambda *a, **k: SimpleNamespace(reads=[{"id": "a"}, {"id": "b"}]),
    )
    read_sorting.sort_similarity_for_dataset(state, "ds", "chr1", 100, 200, False)
    assert seen == {"peak_modes": ["m6a"], "threshold": 120, "rules": [{"id": "r1"}], "context": {"ctx": "chr1"}}


def test_cluster_all_stores_the_feature_settings_it_used():
    from services.clustering_results import assemble_cluster_all_results

    dataset = SimpleNamespace(cluster_assignments={}, cluster_element_info=None, cluster_peak_regions=None)
    state = SimpleNamespace(get_dataset=lambda ds: dataset)
    assemble_cluster_all_results(
        assignments={"ds::a": 0}, dataset_read_ids={"ds": ["a"]}, dataset_read_stats={"ds": {}},
        dataset_ids=["ds"], state=state, peaks=[(10, 20)], peak_modes=["m6a"], start=100,
        feature_settings={"subnucleosomal_threshold": 70, "cluster_feature_rules": []},
    )
    assert dataset.cluster_peak_regions == [{"start": 110, "end": 120, "mode": "m6a"}]
    assert dataset.cluster_feature_settings == {"subnucleosomal_threshold": 70, "cluster_feature_rules": []}


# B5r8 #1: plasmid maps survive a session round trip.
def test_plasmid_maps_round_trip_through_a_session(tmp_path):
    from models.requests import SessionExportRequest
    from routers.genome import load_plasmid_endpoint
    from services.session_files import session_file_refs
    from services.sessions_endpoint import (
        _restore_plasmids, build_session_export_for_request,
    )
    from test_plasmid_routes import FakePlasmidState, write_genbank

    plasmid = tmp_path / "pRound.gbk"
    write_genbank(plasmid, name="pRound")
    state = FakePlasmidState()
    state.gtf_path = "/refs/genes.gtf"
    assert asyncio.run(load_plasmid_endpoint(str(plasmid), state=state))["success"] is True
    assert os.pathsep in state.gtf_path  # the plasmid's features were merged into the genes
    state.datasets, state.dataset_order, state.modification_overlays = {}, [], {}
    exported = build_session_export_for_request(
        state, SessionExportRequest(), now=datetime(2026, 9, 24, tzinfo=timezone.utc))["session"]
    assert exported["reference"]["plasmids"] == [str(plasmid)]
    # The GTF path no longer carries the plasmid, so the GTF restore finds one real file.
    assert exported["gtf"]["path"] == "/refs/genes.gtf"
    assert {"kind": "reference", "label": "Plasmid map", "path": str(plasmid)} in session_file_refs(exported)

    restored = FakePlasmidState()
    results = {}
    _restore_plasmids(restored, exported["reference"]["plasmids"] + [str(tmp_path / "gone.gbk")], results)
    assert "pRound" in restored.plasmid_sequences
    assert restored.plasmid_metadata["pRound"]["path"] == str(plasmid)
    assert results["plasmids_restored"] == [str(plasmid)]
    assert results["plasmids_failed"][0]["path"].endswith("gone.gbk")


# B5r8 #2: headless figures scan modification peak rules like the browser does.
def test_figure_peak_sources_include_modification_scans():
    from services.figure.tracks import peaks, reads
    from services.peak_scanning import READ_SIGNAL_SOURCES

    for sources in (peaks.BACKEND_SOURCES, reads.BACKEND_PEAK_SOURCES):
        assert {"m6a", "m5c", "deam"} <= set(sources)
        assert set(sources) == set(READ_SIGNAL_SOURCES)
