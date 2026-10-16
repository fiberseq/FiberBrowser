"""B2 round 11 (dissolve/auto-cull feature settings, empty client selections,
projection schema, FIRE chromosome names, short-window smoothing) and B3 round 13
(live stringency keeps the native LLR floor)."""
from types import SimpleNamespace

import numpy as np
import pandas as pd

from models.requests import DissolveClusterRequest
from services import clustering_endpoint

from test_clustering_endpoint import FakeClusterState


# B2r11 #1: dissolve / auto-cull on the stored clustering use the rules and
# threshold it was built with, and tag reads for saved-class features.
def test_assigned_rows_use_the_stored_clustering_feature_settings(monkeypatch):
    state = FakeClusterState()
    ds = state.datasets["ds1"]
    ds.cluster_peak_regions = [{"start": 10, "end": 30, "mode": "cluster_rule:occupied"}]
    ds.cluster_feature_settings = {"subnucleosomal_threshold": 120,
                                   "cluster_feature_rules": [{"id": "occupied", "terms": []}]}
    seen = {}

    def fake_collect(state, dataset_ids, chrom, start, end, spanning, assignments, peaks, modes,
                     threshold, seed, rules, context, query):
        seen.update(threshold=threshold, rules=rules, modes=modes)
        return [], [], []

    monkeypatch.setattr(clustering_endpoint, "collect_assigned_feature_rows", fake_collect)
    req = DissolveClusterRequest(cluster_to_dissolve=1, current_assignments={"ds1": {"read-a": 0}},
                                 dataset_ids=["ds1"])
    clustering_endpoint.assigned_cluster_feature_rows(
        state=state, req=req, chrom="chr2R", start=0, end=60, spanning=False,
        sample_seed="s", assignments_by_dataset={"ds1": {"read-a": 0}},
    )
    assert seen == {"threshold": 120, "rules": [{"id": "occupied", "terms": []}],
                    "modes": ["cluster_rule:occupied"]}


def test_assigned_rows_tag_reads_for_class_features(monkeypatch):
    from services import clustering_inputs
    seen = {}

    def fake_extract(reads, peaks, start, **kw):
        seen["tags"] = [(r.get("_consensus_dataset_id"), r.get("_consensus_chrom")) for r in reads]
        return np.zeros((0, 0)), [], [], []

    monkeypatch.setattr(clustering_inputs, "extract_features_from_compact", fake_extract)
    state = FakeClusterState()
    clustering_inputs.collect_assigned_feature_rows(
        state, ["ds1"], "chr2R", 0, 60, False, {"ds1": {"read-a": 0}}, [[10, 30]], ["accessibility"],
        90, "s",
    )
    assert seen["tags"] == [("ds1", "2R")]


# B2r11 #3: datasets clustered with different rule definitions at the same
# peaks have different feature layouts, so their schemas differ.
def test_projection_schema_includes_the_feature_settings():
    sig = clustering_endpoint._settings_signature
    one = {"cluster_feature_rules": [{"id": "r", "terms": [1]}], "subnucleosomal_threshold": 90}
    two = {"cluster_feature_rules": [{"id": "r", "terms": [1, 2]}], "subnucleosomal_threshold": 90}
    assert sig(one) != sig(two)
    assert sig(one) == sig(dict(one))


# B2r11 #2: an explicitly empty read selection means no reads in the client.


def _client():
    from browser_client import BrowserClient

    class Dummy(BrowserClient):
        def __init__(self):
            self.url = "http://x"
            self.calls = []

        def _post(self, endpoint, body=None, **kw):
            self.calls.append((endpoint, body))
            return {}

        def get_compact_reads(self, **kw):
            return [{"id": "a", "methyl_m6a": [1], "layers": {"tf": {"qualities": [[1]]}}}]

    return Dummy()


def test_client_empty_read_selections_mean_no_reads():
    client = _client()
    client.analyze_footprints("chr1", 0, 100, dataset_id="ds", read_ids=[])
    _, body = client.calls[-1]
    assert body["read_ids_by_dataset"] == {"ds": []}
    assert client.get_modifications("m6a", chrom="chr1", start=0, end=100, read_ids=[]) == {}
    assert client.get_interval_qualities("tf", chrom="chr1", start=0, end=100, read_ids=[]) == {}


# B2r11 #4: numeric chromosome names in FIRE BEDs stay strings.
def test_fire_bed_numeric_chromosomes_stay_strings(tmp_path):
    from services.fire_tracks import load_fire_data
    (tmp_path / "fire.bed").write_text("1\t100\t500\n2\t50\t90\n")
    fire = load_fire_data(str(tmp_path))
    assert list(fire["chrom"]) == ["1", "2"]


# agy B2r11 #5: smoothing never makes the track longer than the region.
def test_accessibility_track_matches_a_short_region():
    from services.accessibility_tracks import compute_accessibility_track
    reads = pd.DataFrame([{"read_id": "r", **{i: -20 for i in range(100, 115)}}])
    accessibility, _, _ = compute_accessibility_track(reads, 100, 115, window=30)
    assert len(accessibility) == 15


# B3r13: live stringency rebuilds the presentation context with each dataset's
# frozen model record, so its native LLR floor is kept.
def test_live_stringency_keeps_the_native_llr_floor(tmp_path, monkeypatch):
    import pytest
    from services.fiberhmm_runtime import configure_fiberhmm_runtime
    configure_fiberhmm_runtime()
    pytest.importorskip("fiberhmm.inference.consensus.harmonized_families.presentation")
    from fiberhmm.inference.consensus.artifacts import write_json
    from fiberhmm.inference.consensus.harmonized_families import presentation
    from services import consensus_workflow

    (tmp_path / "sources" / "ds").mkdir(parents=True)
    (tmp_path / "scopes" / "w").mkdir(parents=True)
    write_json(tmp_path / "sources" / "ds" / "source.json.gz",
               dict(dataset_id="ds", chemistry="ddda", browser_units={"u": {"unit_id": "u"}}))
    write_json(tmp_path / "scopes" / "w" / "final.json.gz", dict(records=[dict(assignment_compatibility=1.0)]))
    seen = {}
    monkeypatch.setattr(presentation, "presentation_context", lambda sources: seen.setdefault("sources", sources) and {})
    monkeypatch.setattr(presentation, "browser_snapshot", lambda *a, **k: {})
    job = dict(artifact_dir=str(tmp_path), result=dict(
        final_stage="final", stage_results={"final": {}},
        manifest=dict(datasets=[dict(dataset_id="ds", model=dict(native_minimum_llr=10.0))],
                      parameters=dict(families=dict(minimum_display_primary_units=1, minimum_display_primary_fraction=0.0),
                                      cross=dict(enabled=False), sr=dict(enabled=False)))))
    consensus_workflow._staged_assignment_view(job, 95.0)
    assert seen["sources"][0]["model_manifest"]["native_minimum_llr"] == 10.0
