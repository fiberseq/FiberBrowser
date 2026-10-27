import asyncio
from collections import OrderedDict
from types import SimpleNamespace

import pytest
import pandas as pd
from pydantic import ValidationError

from models.domain import WorkingSet
from models.requests import AnalysisFilterRequest, FilterRequest, PeakRegion, SortReadsRequest
from routers.filtering import filter_by_analysis_rule, filter_reads, sort_reads
from state.browser_state import BrowserState


class FakeState:
    dataset_order = ["ds1"]

    def __init__(self):
        self.datasets = {"ds1": SimpleNamespace(cluster_assignments={})}
        self.reads = [{"id": "r1", "intervals": [[0, 100, 30]]}]
        self.fire_df = None
        self.peak_regions = []

    def translate_chrom(self, chrom):
        return chrom

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, *args, **kwargs):
        reads = self.reads
        read_ids = kwargs.get("read_ids")
        if read_ids is not None:
            wanted = set(read_ids)
            reads = [read for read in reads if read["id"] in wanted]
        return WorkingSet(
            reads,
            total_overlapping=len(reads),
            total_spanning=len(reads),
            chrom=args[1],
            start=args[2],
            end=args[3],
        )


class FakeTranscriptionState(FakeState):
    def __init__(self):
        super().__init__()
        self.gtf_data = {
            "transcripts": pd.DataFrame([
                {
                    "transcript_id": "tx1",
                    "gene_name": "GeneA",
                    "chrom": "chr1",
                    "start": 1_000,
                    "end": 1_500,
                    "strand": "+",
                },
            ])
        }

    def build_working_set(self, *args, **kwargs):
        return WorkingSet(
            [
                {"id": "pause_read", "intervals": [[10, 50, 50]]},
                {"id": "other_read", "intervals": [[80, 100, 50]]},
            ],
            total_overlapping=2,
            total_spanning=2,
            chrom=args[1],
            start=args[2],
            end=args[3],
        )


def test_filter_route_is_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_FILTER_DIAGNOSTICS", raising=False)

    result = asyncio.run(
        filter_reads(
            FilterRequest(
                filter_mode="either",
                peak_regions=[PeakRegion(start=10, end=50)],
            ),
            chrom="chr1",
            start=0,
            end=100,
            spanning=False,
            dataset_id="ds1",
            state=FakeState(),
        )
    )

    assert result["filtered"] == 1
    assert capsys.readouterr().out == ""


def test_filter_route_peak_index_fallback_does_not_depend_on_server_global():
    state = FakeState()

    result = asyncio.run(
        filter_reads(
            FilterRequest(
                filter_mode="either",
                peak_indices=[0],
            ),
            chrom="chr1",
            start=0,
            end=100,
            spanning=False,
            dataset_id="ds1",
            state=state,
        )
    )

    assert result["filtered"] == 1
    assert state.peak_regions == []


def test_analysis_filter_route_filters_by_rule_metric():
    result = asyncio.run(
        filter_by_analysis_rule(
            AnalysisFilterRequest(
                dataset_ids=["ds1"],
                metric="count",
                operator="gte",
                threshold=1,
                rule={"size_min": 20, "size_max": 40, "conditions": []},
                scope_windows=[[1_000, 1_100]],
            ),
            chrom="chr1",
            start=1_000,
            end=1_100,
            spanning=False,
            state=FakeState(),
        )
    )

    assert result["results"]["ds1"]["read_ids"] == ["r1"]
    assert result["results"]["ds1"]["filtered"] == 1


def test_analysis_filter_route_supports_transcription_state_source():
    result = asyncio.run(
        filter_by_analysis_rule(
            AnalysisFilterRequest(
                dataset_ids=["ds1"],
                metric="count",
                operator="gte",
                threshold=1,
                transcription_state="pause",
                gene_ids=["tx1"],
                scope_windows=[[1_000, 1_100]],
            ),
            chrom="chr1",
            start=1_000,
            end=1_100,
            spanning=False,
            state=FakeTranscriptionState(),
        )
    )

    assert result["results"]["ds1"]["read_ids"] == ["pause_read"]
    assert result["results"]["ds1"]["filtered"] == 1


def test_sort_route_supports_transcription_state_source():
    result = asyncio.run(
        sort_reads(
            SortReadsRequest(
                dataset_ids=["ds1"],
                sort_by="transcription_state",
                transcription_state="pause",
                gene_ids=["tx1"],
                descending=True,
            ),
            chrom="chr1",
            start=1_000,
            end=1_100,
            spanning=False,
            state=FakeTranscriptionState(),
        )
    )

    assert result["results"]["ds1"]["read_sort_order"] == ["pause_read", "other_read"]


def test_sort_route_uses_request_read_scope_and_cluster_assignments():
    state = FakeState()
    state.datasets["ds1"].cluster_assignments = {"r1": 0, "r2": 0, "r3": 0}
    state.reads = [
        {"id": "r1", "intervals": [[0, 20, 10], [30, 50, 10], [60, 80, 10]]},
        {"id": "r2", "intervals": [[0, 20, 10], [30, 50, 10]]},
        {"id": "r3", "intervals": [[0, 20, 10]]},
    ]

    result = asyncio.run(
        sort_reads(
            SortReadsRequest(
                dataset_ids=["ds1"],
                sort_by="fp_count",
                descending=True,
                read_ids={"ds1": ["r2", "r3"]},
                cluster_assignments={"ds1": {"r2": 7, "r3": 8}},
            ),
            chrom="chr1",
            start=0,
            end=100,
            spanning=False,
            state=state,
        )
    )

    assert result["results"]["ds1"]["read_sort_order"] == ["r2", "r3"]
    assert result["results"]["ds1"]["cluster_order"] == [7, 8]


def test_analysis_filter_request_rejects_unknown_metric_and_operator():
    with pytest.raises(ValidationError):
        AnalysisFilterRequest(metric="unknown")

    with pytest.raises(ValidationError):
        AnalysisFilterRequest(operator="within")
    # 'between' (with threshold_max) and the 'value' metric of molecule metrics are accepted (nucleosome panel H3).
    assert AnalysisFilterRequest(operator="between", threshold_max=3, metric="value", molecule_metric="nuc.nrl").operator == "between"


def test_quality_filter_update_logs_only_when_enabled(capsys, monkeypatch):
    state = object.__new__(BrowserState)
    state.quality_filters = []
    state._meta_profile_cache = OrderedDict()
    state._working_set_cache = OrderedDict()
    filters = [{"layer": "fire", "quality_name": "aq", "min_value": 230}]

    monkeypatch.delenv("FIBERBROWSER_FILTER_DIAGNOSTICS", raising=False)
    BrowserState.set_quality_filters(state, filters)
    assert capsys.readouterr().out == ""

    monkeypatch.setenv("FIBERBROWSER_FILTER_DIAGNOSTICS", "1")
    filters = [{"layer": "fire", "quality_name": "aq", "min_value": 231}]
    BrowserState.set_quality_filters(state, filters)
    output = capsys.readouterr().out
    assert "Quality filters updated: 1 active" in output
    assert "fire.aq >= 231" in output


def test_identical_quality_confirmation_preserves_completed_caches():
    state = object.__new__(BrowserState)
    filters = [{"layer": "fire", "quality_name": "aq", "min_value": 230}]
    state.quality_filters = filters
    state._meta_profile_cache = OrderedDict([("profile", object())])
    state._working_set_cache = OrderedDict([("view", object())])
    assert BrowserState.set_quality_filters(state, [dict(filters[0])]) is False
    assert len(state._meta_profile_cache) == len(state._working_set_cache) == 1
    assert BrowserState.set_quality_filters(state, []) is True
    assert not state._meta_profile_cache and not state._working_set_cache


def test_sort_empty_panel_assignments_override_the_last_server_clustering():
    state = FakeState()
    state.datasets['ds1'].cluster_assignments = {'a': 2}
    state.reads = [
        {'id': 'a', 'intervals': [[0, 10, 10]]},
        {'id': 'b', 'intervals': [[0, 80, 80]]},
    ]
    result = asyncio.run(sort_reads(
        SortReadsRequest(dataset_ids=['ds1'], sort_by='occupancy', cluster_assignments={'ds1': {}}),
        chrom='chr1', start=0, end=100, spanning=False, state=state,
    ))['results']['ds1']
    assert result['cluster_order'] == []
    assert result['read_sort_order'] == ['b', 'a']


def test_sort_tied_metrics_explain_why_there_is_no_order():
    state = FakeState()
    state.reads = [{'id': read, 'intervals': [[0, 30, 30]]} for read in ['a', 'b']]
    result = asyncio.run(sort_reads(
        SortReadsRequest(dataset_ids=['ds1'], sort_by='occupancy', cluster_assignments={'ds1': {}}),
        chrom='chr1', start=0, end=100, spanning=False, state=state,
    ))['results']['ds1']
    assert 'same value' in result['no_op_reason']
    assert set(result['read_sort_order']) == {'a', 'b'}


def test_sort_empty_read_scope_never_falls_back_to_all_reads():
    result = asyncio.run(sort_reads(
        SortReadsRequest(dataset_ids=['ds1'], sort_by='occupancy', read_ids={'ds1': []}),
        chrom='chr1', start=0, end=100, spanning=False, state=FakeState(),
    ))['results']['ds1']
    assert result['read_sort_order'] == []
