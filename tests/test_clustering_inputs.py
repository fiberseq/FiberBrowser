"""Regression tests for clustering input working-set scoping."""

import numpy as np

from models.domain import WorkingSet
from services.clustering_inputs import collect_assigned_feature_rows


class FakeState:
    dataset_order = ["ds1"]

    def __init__(self):
        self.calls = []

    def translate_chrom(self, chrom):
        return {"chr2R": "2R"}.get(chrom, chrom)

    def get_dataset(self, dataset_id):
        return object() if dataset_id == "ds1" else None

    def build_working_set(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return WorkingSet(
            [{"id": "read-a", "intervals": [[0, 50, -50]], "layers": {"tf": {"intervals": [[10, 20, 10]]}}}],
            total_overlapping=1,
            total_spanning=1,
            chrom=args[1],
            start=args[2],
            end=args[3],
        )


def test_collect_assigned_feature_rows_uses_shared_query_scope(monkeypatch):
    state = FakeState()

    def fake_extract(reads, peaks, start, step=10, subnucleosomal_threshold=90, peak_modes=None):
        assert reads[0]["id"] == "ds1::read-a"
        assert peak_modes == ["tf_layer"]
        return np.array([[1.0]], dtype=np.float32), ["ds1::read-a"], None, None

    monkeypatch.setattr("services.clustering_inputs.extract_features_from_compact", fake_extract)

    features, read_ids, assignments = collect_assigned_feature_rows(
        state=state,
        dataset_ids=["primary", "ds1"],
        chrom="chr2R",
        start=100,
        end=200,
        spanning=True,
        assignments_by_dataset={"ds1": {"read-a": 4}},
        peaks=[[10, 20]],
        peak_modes=["tf_layer"],
        subnucleosomal_threshold=85,
        sample_seed="feature-seed",
    )

    args, kwargs = state.calls[0]
    assert args[:6] == ("ds1", "2R", 100, 200, True, 0)
    assert kwargs["sample_seed"] == "feature-seed"
    assert kwargs["include_methylation"] is False
    assert kwargs["include_layers"] is True
    assert len(features) == 1
    assert read_ids == [("ds1", "read-a")]
    assert assignments == [4]


def test_assigned_scope_preserves_base_name_segment_matching(monkeypatch):
    from services.analysis_query import AnalysisReadQuery
    state = FakeState()
    query = AnalysisReadQuery.from_request(state, chrom='chr2R', start=100, end=200,
                                          dataset_ids=['ds1'], read_ids_by_dataset={'ds1': ['fiber']})
    collect_assigned_feature_rows(state, ['ds1'], '2R', 100, 200, False,
        {'ds1': {'fiber_1': 0, 'fiber_2': 1, 'other': 0}}, [[10, 20]], ['accessibility'], 90,
        'seed', query=query)
    assert state.calls[0][1]['read_ids'] == ['fiber_1', 'fiber_2']
