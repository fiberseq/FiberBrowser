"""B2 round 10 (projection/similarity/metaprofile/rare-pattern weighting) and
B3 round 12 (consensus overlay source bounds)."""
import itertools
from types import SimpleNamespace

import numpy as np

from models.domain import WorkingSet
from models.requests import ProjectionRequest
from services import clustering_endpoint, read_auxiliary_endpoint
from services.cluster_assignment import cluster_compact_reads
from services.consensus_workflow import apply_overlays

from test_clustering_endpoint import FakeClusterState
from test_consensus_overlay_identity import fixture, unit


# B2r10 #1: projecting the stored clustering uses its own feature rules and threshold.
def test_projection_restores_the_stored_clustering_feature_settings(monkeypatch):
    state = FakeClusterState()
    ds = state.datasets["ds1"]
    ds.cluster_assignments = {"read-a": 0}
    ds.cluster_peak_regions = [{"start": 10, "end": 30, "mode": "cluster_rule:short"}]
    ds.cluster_feature_settings = {"subnucleosomal_threshold": 120,
                                   "cluster_feature_rules": [{"id": "short", "terms": []}]}
    seen = {}

    def fake_extract(reads, peaks, start, step=10, subnucleosomal_threshold=90, peak_modes=None,
                     cluster_feature_rules=None, cluster_rule_context=None):
        seen.update(threshold=subnucleosomal_threshold, rules=cluster_feature_rules,
                    tagged=[(r.get("_consensus_dataset_id"), r.get("_consensus_chrom")) for r in reads])
        return np.zeros((0, 0)), [], [], peak_modes

    monkeypatch.setattr(clustering_endpoint, "extract_features_from_compact", fake_extract)
    clustering_endpoint.run_cluster_projection_endpoint(
        state=state, req=ProjectionRequest(dataset_ids=["ds1"], method="pca"),
        chrom="chr2R", start=0, end=60, spanning=False,
    )
    assert seen["threshold"] == 120
    assert seen["rules"] == [{"id": "short", "terms": []}]
    assert seen["tagged"] and all(t == ("ds1", state.translate_chrom("chr2R")) for t in seen["tagged"])


# B2r10 #2: similarity sorting tags reads with their dataset and chromosome, so
# saved footprint-class features resolve.
def test_similarity_sort_tags_reads_for_class_features(monkeypatch):
    import services.read_sorting as read_sorting
    seen = {}

    def fake_extract(reads, peaks, start, step=10, subnucleosomal_threshold=90, peak_modes=None, **kw):
        seen["tags"] = [(r.get("_consensus_dataset_id"), r.get("_consensus_chrom")) for r in reads]
        return np.array([[1.0], [0.0]]), ["a", "b"], [1], peak_modes

    monkeypatch.setattr(read_sorting, "extract_features_from_compact", fake_extract)
    dataset = SimpleNamespace(cluster_assignments={"a": 0, "b": 1}, cluster_element_info=None,
                              cluster_peak_regions=[{"start": 110, "end": 150, "mode": "accessibility"}],
                              cluster_feature_settings=None)
    state = SimpleNamespace(get_dataset=lambda ds: dataset, translate_chrom=lambda c: "chr1",
                            build_working_set=lambda *a, **k: SimpleNamespace(reads=[{"id": "a"}, {"id": "b"}]))
    read_sorting.sort_similarity_for_dataset(state, "ds", "1", 100, 200, False)
    assert seen["tags"] == [("ds", "chr1"), ("ds", "chr1")]


# B2r10 #3: an explicitly empty read subset gives an empty profile, never the dataset's.
def test_empty_metaprofile_subset_returns_no_profile(monkeypatch):
    calls = []
    state = SimpleNamespace(translate_chrom=lambda c: c, _meta_profile_cache={},
                            get_reads=lambda *a, **k: calls.append(a))
    monkeypatch.setattr(read_auxiliary_endpoint, "resolve_dataset_id", lambda state, ds: ds)
    out = read_auxiliary_endpoint.get_meta_payload(state, chrom="chr1", start=0, end=10,
                                                   dataset_id="ds", read_ids=[])
    assert out["nucleosome_profile"] == [] and out["subnuc_profile"] == []
    assert calls == [] and state._meta_profile_cache == {}


def test_meta_client_sends_an_empty_subset_and_omits_none():
    from browser_client import BrowserClient
    client = BrowserClient.__new__(BrowserClient)
    sent = []
    client._get = lambda endpoint, params: sent.append(dict(params)) or {}
    client.get_meta("chr1", 0, 10, read_ids=[])
    client.get_meta("chr1", 0, 10)
    assert sent[0]["read_ids"] == ""
    assert "read_ids" not in sent[1]


def test_meta_route_reads_an_empty_value_as_an_empty_subset(monkeypatch):
    import asyncio
    import routers.read_auxiliary as route
    seen = {}
    monkeypatch.setattr(route, "get_meta_payload", lambda state, **kw: seen.update(kw) or {})
    asyncio.run(route.get_meta(chrom="chr1", start=0, end=10, dataset_id=None, read_ids="", state=None))
    assert seen["read_ids"] == []
    asyncio.run(route.get_meta(chrom="chr1", start=0, end=10, dataset_id=None, read_ids=None, state=None))
    assert seen["read_ids"] is None


# agy B2r10: a read with a rare combinatorial pattern joins the nearest kept
# pattern weighted by the peaks it covers, also when reads carry a window tag
# (cluster_all tags every read), matching dynamic reassignment.
def _read(read_id, bits):
    intervals = []
    for i, bit in enumerate(bits):
        lo, hi = i * 100, (i + 1) * 100
        intervals.append([lo, hi, -100] if bit else [lo, hi, 100])
    return {"id": read_id, "intervals": intervals, "_cluster_group": "ds"}


def test_rare_patterns_are_overlap_weighted_for_window_tagged_reads():
    peaks = [(i * 100 + 40, i * 100 + 60) for i in range(6)]
    excluded = {(1, 1, 1, 0, 0, 0), (1, 1, 1, 0, 0, 1), (1, 1, 1, 0, 1, 0), (1, 1, 1, 1, 0, 0)}
    allowed = [p for p in itertools.product((0, 1), repeat=6) if p not in excluded]
    # Kept (top 50, two reads each): every allowed 111xxx pattern first.
    allowed.sort(key=lambda p: (p[:3] != (1, 1, 1), p))
    reads = []
    for n, pattern in enumerate(allowed):
        copies = 2 if n < 50 else 1
        reads += [_read(f"r{n}_{c}", pattern) for c in range(copies)]
    # Covers only the first three peaks, all open: pattern 111000, which no read shares.
    reads.append({"id": "partial", "intervals": [[0, 300, -300]], "_cluster_group": "ds"})
    assignments, _counts, _order, info = cluster_compact_reads(reads, peaks, 0, 50, method="combinatorial")
    pattern = tuple(info["clusters"][assignments["partial"]]["pattern"])
    # Unweighted it would join a one-bit-off pattern such as 110000; weighted,
    # only the peaks it covers count, so it joins a 111xxx cluster.
    assert pattern[:3] == (1, 1, 1)


# B3r12 #1: consensus overlays keep unclipped source bounds next to clipped intervals.
def test_consensus_overlay_layers_keep_unclipped_source_intervals():
    state, _ = fixture([unit('u', 'CT', [145, 160])])
    read = dict(id='same', strand='CT', layers={})
    row = apply_overlays(state, 'd', 'chr1', 150, 200, WorkingSet([read], 1, 1, 'chr1', 150, 200)).reads[0]
    layer = row['layers']['tf_sr_lattice']
    assert layer['intervals'] == [[0, 10, 14]]
    assert layer['source_intervals'] == [[-4, 10, 14]]
