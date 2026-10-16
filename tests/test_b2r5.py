"""B2 round 5: explicit empty read scopes, primary quality indexing, named-gene
rules, combinatorial overflow patterns, track peak scans, Pol II bins."""

from __future__ import annotations

import itertools
from types import SimpleNamespace

import pytest

from models.requests import ScanPeaksRequest
from services import clustering_endpoint
from services.analysis_query import AnalysisReadQuery
from services.cluster_assignment import cluster_compact_reads
from services.clustering_features import _iter_layer_interval_entries, _conditions_pass
from services.dynamic_clustering import assign_reads_to_cluster_patterns
from services.pol2_endpoint import _mark_gene_bins

from test_clustering_endpoint import FakeClusterState


SCAN_KW = dict(chrom="chr2R", start=0, end=30, dataset_id="ds1", spanning=False)


# ── 1. read_ids=[] scopes to no reads ───────────────────────────────────────

def test_an_explicit_empty_read_scope_scans_no_reads():
    state = FakeClusterState()
    req = ScanPeaksRequest(min_width=5, min_reads=1, smooth_width=5, read_ids=[])
    result = clustering_endpoint.run_scan_peaks_endpoint(state=state, req=req, **SCAN_KW)
    assert result["n_reads"] == 0 and result["peaks"] == []
    # No read scope at all still scans every read.
    unscoped = clustering_endpoint.run_scan_peaks_endpoint(
        state=FakeClusterState(), req=ScanPeaksRequest(min_width=5, min_reads=1, smooth_width=5), **SCAN_KW)
    assert unscoped["n_reads"] == 2


def test_query_keeps_none_and_empty_read_scopes_apart():
    state = FakeClusterState()
    kwargs = dict(chrom="2R", start=0, end=30, dataset_id="ds1")
    assert AnalysisReadQuery.from_request(state, **kwargs).read_ids_for_dataset("ds1") is None
    assert AnalysisReadQuery.from_request(state, read_ids=[], **kwargs).read_ids_for_dataset("ds1") == []


# ── 2. primary qualities index footprints, not gaps ─────────────────────────

def test_primary_quality_gates_skip_gaps_when_indexing():
    read = {"intervals": [[0, 10, -10], [10, 50, 40]], "qualities": [255]}
    entries = _iter_layer_interval_entries(read, None)
    assert entries[0][4] == {}
    assert entries[1][4] == {"nq": 255}


# ── 3. a named gene that isn't in view matches nothing ─────────────────────

def test_named_gene_rule_does_not_fall_back_to_other_genes():
    context = {"gene_regions": [(100, 200)], "gene_regions_by_key": {"name:b": [(100, 200)], "id:B": [(100, 200)]}}
    named_a = {"conditions": [{"target": "gene", "geneName": "A"}]}
    named_b = {"conditions": [{"target": "gene", "geneName": "B"}]}
    any_gene = {"conditions": [{"target": "gene"}]}
    not_a = {"conditions": [{"target": "gene", "geneName": "A", "negate": True}]}
    kw = dict(region_start=0, peak_regions=[], rule_context=context)
    assert not _conditions_pass(named_a, 150, **kw)
    assert _conditions_pass(named_b, 150, **kw)
    assert _conditions_pass(any_gene, 150, **kw)
    assert _conditions_pass(not_a, 150, **kw)


# ── 4. reassigning unchanged reads keeps their combinatorial clusters ────────

def _pattern_read(read_id: str, bits: tuple[int, ...]) -> dict:
    intervals = []
    for i, bit in enumerate(bits):
        s = i * 40
        # Open: a gap; closed: a nucleosome-sized footprint.
        intervals.append([s, s + 40, -40] if bit else [s, s + 40, 147])
    return {"id": read_id, "intervals": intervals}


def test_overflow_patterns_join_the_cluster_reassignment_would_choose():
    peaks = [[i * 40 + 10, i * 40 + 30] for i in range(6)]
    reads = []
    for n, bits in enumerate(itertools.product((0, 1), repeat=6)):
        # Uneven counts so the kept top-50 is well defined.
        for copy in range(1 + (n % 3)):
            reads.append(_pattern_read(f"r{n}_{copy}", bits))
    assignments, _counts, _order, info = cluster_compact_reads(
        reads, peaks, 0, 5, method="combinatorial", subnucleosomal_threshold=90, accessibility_threshold=0.5,
    )
    assert len(info["cluster_patterns"]) == 50
    again = assign_reads_to_cluster_patterns(
        reads, peaks, info["cluster_patterns"], region_start=0,
        subnucleosomal_threshold=90, accessibility_threshold=0.5,
    )["assignments"]
    moved = {rid: (assignments[rid], again[rid]) for rid in assignments if assignments[rid] != again[rid]}
    assert moved == {}
    # Each cluster's read list matches its assignments.
    for label, cluster in info["clusters"].items():
        assert set(cluster["read_ids"]) == {rid for rid, c in assignments.items() if c == label}


# ── 5. track:N scans the track, and unknown sources are refused ─────────────

class _TrackState(FakeClusterState):
    def __init__(self, values):
        super().__init__()
        self.orthogonal_tracks = [{"label": "signal", "render_mode": "signal"}]
        self._values = values

    def get_track_data(self, track_idx, chrom, start, end, bins):
        return list(self._values)


def test_track_sources_scan_the_track_signal():
    flat = _TrackState([0.0] * 300)
    req = ScanPeaksRequest(min_width=20, min_reads=1, signal_source="track:0")
    kw = dict(chrom="chr2R", start=0, end=3000, dataset_id="ds1", spanning=False)
    assert clustering_endpoint.run_scan_peaks_endpoint(state=flat, req=req, **kw)["peaks"] == []
    assert flat.calls == []  # no reads were loaded
    bump = [0.0] * 300
    for i in range(140, 160):
        bump[i] = 5.0
    peaks = clustering_endpoint.run_scan_peaks_endpoint(state=_TrackState(bump), req=req, **kw)["peaks"]
    assert len(peaks) == 1 and 1300 <= peaks[0]["start"] < peaks[0]["end"] <= 1700


def test_unknown_or_missing_track_sources_are_refused():
    state = FakeClusterState()
    state.orthogonal_tracks = []
    with pytest.raises(ValueError):
        clustering_endpoint.run_scan_peaks_endpoint(
            state=state, req=ScanPeaksRequest(signal_source="profile:mod"), **SCAN_KW)
    with pytest.raises(ValueError):
        clustering_endpoint.run_scan_peaks_endpoint(
            state=state, req=ScanPeaksRequest(signal_source="track:3"), **SCAN_KW)


# ── 6. Pol II bins are half-open on both strands ────────────────────────────

@pytest.mark.parametrize("strand, expected", [("+", [2, 3, 4, 5]), ("-", [4, 5, 6, 7])])
def test_pol2_footprint_bins_are_half_open(strand, expected):
    row = [0] * 10
    _mark_gene_bins(row, ov_start=120, ov_end=160, gene_from=100, gene_bin_size=10.0,
                    gene_strand=strand, n_bins=10)
    assert [i for i, v in enumerate(row) if v] == expected
