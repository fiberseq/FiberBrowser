"""Tests for clustering and peak detection functions with synthetic data.

Tests cluster_compact_reads, extract_features_from_compact, and related helpers.
"""

import pytest
import numpy as np

from helpers import make_compact_read

from models.requests import PeakRegion
from routers.clustering import (
    _active_peak_regions,
    _pick_vplot_intervals,
    _prefix_compact_read,
    _split_prefixed_read_id,
)
from services import cluster_assignment, clustering_features


def test_router_cluster_helpers_keep_peak_and_read_ids_stable():
    peaks, modes = _active_peak_regions(
        [
            PeakRegion(start=110, end=150, mode="tf"),
            PeakRegion(start=200, end=240, mode="off"),
            PeakRegion(start=300, end=360, mode="accessibility"),
        ],
        region_start=100,
    )

    assert peaks == [[10, 50], [200, 260]]
    assert modes == ["tf", "accessibility"]

    read = {"id": "read-a", "intervals": [[0, 100, 40]]}
    prefixed = _prefix_compact_read(read, "dataset-1")
    assert prefixed["id"] == "dataset-1::read-a"
    assert prefixed["_original_id"] == "read-a"
    assert read["id"] == "read-a"

    assert _split_prefixed_read_id("dataset-1::read-a", "fallback") == ("dataset-1", "read-a")
    assert _split_prefixed_read_id("read-a", "fallback") == ("fallback", "read-a")


def test_vplot_interval_resolver_aliases_fire_to_internal_msp():
    read = {
        "id": "read-a",
        "intervals": [[0, 100, 100]],
        "fire": [[12, 30, 255]],
        "layers": {"msp": {"intervals": [[10, 40, 30]]}},
    }

    assert _pick_vplot_intervals(read, "fire") == [[10, 40, 30]]
    assert _pick_vplot_intervals({"id": "read-b", "intervals": [], "fire": [[5, 15, 200]]}, "fire") == [[5, 15, 200]]
    assert _pick_vplot_intervals(read, None) == [[0, 100, 100]]


# ============================================================================
# extract_features_from_compact
# ============================================================================

class TestExtractFeaturesFromCompact:
    def test_empty_reads_returns_empty(self):
        features, ids, widths, modes = clustering_features.extract_features_from_compact(
            [], [(0, 100)], region_start=0
        )
        assert features.size == 0
        assert ids == []

    def test_empty_peaks_returns_empty(self):
        reads = [make_compact_read('r1', [[0, 100, 50]])]
        features, ids, widths, modes = clustering_features.extract_features_from_compact(
            reads, [], region_start=0
        )
        assert features.size == 0

    def test_accessibility_mode_binary(self):
        """Accessibility mode: accessible (size < threshold) -> 1.0, nucleosomal -> 0.0."""
        reads = [
            # Read with small footprint (accessible) in peak region
            make_compact_read('r1', [[0, 100, 50]]),   # size=50 < 90 -> accessible
            # Read with large footprint (nucleosomal) in peak region
            make_compact_read('r2', [[0, 100, 150]]),  # size=150 >= 90 -> not accessible
        ]
        features, ids, widths, modes = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0, step=10
        )
        assert features.shape[0] == 2
        # r1 should have mostly 1.0 (accessible)
        assert features[0].mean() == pytest.approx(1.0, abs=0.01)
        # r2 should have mostly 0.0 (nucleosomal)
        assert features[1].mean() == pytest.approx(0.0, abs=0.01)

    def test_subnucleosomal_threshold_customizable(self):
        """Custom threshold: 60bp instead of default 90bp."""
        reads = [
            make_compact_read('r1', [[0, 100, 70]]),  # 70 < 90 but >= 60
        ]
        # With default threshold 90: 70 < 90 -> accessible (1.0)
        f_default, _, _, _ = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0, subnucleosomal_threshold=90
        )
        assert f_default[0].mean() == pytest.approx(1.0, abs=0.01)

        # With threshold 60: 70 >= 60 -> not accessible (0.0)
        f_custom, _, _, _ = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0, subnucleosomal_threshold=60
        )
        assert f_custom[0].mean() == pytest.approx(0.0, abs=0.01)

    def test_tf_mode_normalized(self):
        """TF mode: normalized footprint size (0-1 scale)."""
        reads = [
            make_compact_read('r1', [[0, 100, 45]]),  # size=45, normalized: 45/90 = 0.5
        ]
        features, _, _, _ = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0, step=10,
            peak_modes=['tf']
        )
        assert features[0].mean() == pytest.approx(0.5, abs=0.05)

    def test_off_mode_excluded(self):
        """Peak with mode='off' should produce no features."""
        reads = [make_compact_read('r1', [[0, 200, 50]])]
        features, _, widths, modes = clustering_features.extract_features_from_compact(
            reads, [(0, 100), (100, 200)], region_start=0,
            peak_modes=['accessibility', 'off']
        )
        # Only first peak should have features
        assert widths[0] == 10  # 100/10 = 10 positions
        assert widths[1] == 0   # off peak has no features
        assert features.shape[1] == 10  # only from peak 0

    def test_read_ids_preserved(self):
        reads = [
            make_compact_read('alpha', [[0, 100, 50]]),
            make_compact_read('beta', [[0, 100, 60]]),
        ]
        _, ids, _, _ = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0
        )
        assert ids == ['alpha', 'beta']

    def test_modification_mode_with_methylation(self):
        """Modification mode uses m6A positions for binary features."""
        reads = [
            make_compact_read('r1', [[0, 100, 50]], methyl=[5, 15, 25, 35]),
        ]
        features, _, _, _ = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0, step=10,
            peak_modes=['modification']
        )
        # Positions 0, 10, 20, 30 should find nearby methylation marks
        # (within ±step/2 = ±5)
        assert features[0, 0] == 1.0  # position 0, m6A at 5 (within ±5)
        assert features[0, 1] == 1.0  # position 10, m6A at 15

    def test_gap_positions_accessible(self):
        """Gap intervals (size <= 0) at sampled positions should be accessible."""
        reads = [
            make_compact_read('r1', [[0, 50, -100], [50, 100, 150]]),
        ]
        features, _, _, _ = clustering_features.extract_features_from_compact(
            reads, [(0, 100)], region_start=0, step=10
        )
        # Positions 0-40 are in gap (accessible=1), positions 50-90 are nucleosomal (=0)
        assert features[0, 0] == 1.0   # gap
        assert features[0, 4] == 1.0   # position 40, still gap
        assert features[0, 5] == 0.0   # position 50, nucleosomal

    def test_custom_cluster_rule_filters_layer_and_size(self):
        reads = [
            {
                "id": "short",
                "intervals": [],
                "layers": {"tf": {"intervals": [[10, 40, 25]], "qualities": None, "quality_names": []}},
            },
            {
                "id": "large",
                "intervals": [],
                "layers": {"tf": {"intervals": [[10, 40, 85]], "qualities": None, "quality_names": []}},
            },
        ]
        rules = [{
            "id": "short_tf",
            "name": "Short TF",
            "enabled": True,
            "terms": [{"id": "t1", "source": "layer", "layer": "tf", "sizeMin": 1, "sizeMax": 40}],
        }]

        features, ids, widths, modes = clustering_features.extract_features_from_compact(
            reads,
            [(0, 60)],
            region_start=0,
            step=10,
            peak_modes=["cluster_rule:short_tf"],
            cluster_feature_rules=rules,
        )

        assert ids == ["short", "large"]
        assert widths == [6]
        assert modes == ["cluster_rule:short_tf"]
        assert features[0].sum() > 0
        assert features[1].sum() == 0

    def test_custom_cluster_rule_quality_gate(self):
        reads = [
            {
                "id": "high",
                "intervals": [],
                "layers": {
                    "msp": {
                        "intervals": [[10, 40, 30]],
                        "qualities": [[240]],
                        "quality_names": ["aq"],
                    }
                },
            },
            {
                "id": "low",
                "intervals": [],
                "layers": {
                    "msp": {
                        "intervals": [[10, 40, 30]],
                        "qualities": [[120]],
                        "quality_names": ["aq"],
                    }
                },
            },
        ]
        rules = [{
            "id": "fire_hq",
            "name": "High quality FIRE",
            "enabled": True,
            "terms": [{
                "id": "t1",
                "source": "layer",
                "layer": "fire",
                "sizeMin": 1,
                "sizeMax": None,
                "qualityGates": [{"qualityName": "aq", "minValue": 230}],
            }],
        }]

        features, ids, _, _ = clustering_features.extract_features_from_compact(
            reads,
            [(0, 60)],
            region_start=0,
            step=10,
            peak_modes=["cluster_rule:fire_hq"],
            cluster_feature_rules=rules,
        )

        assert ids == ["high", "low"]
        assert features[0].sum() > 0
        assert features[1].sum() == 0

    def test_custom_cluster_rule_honors_gene_condition_context(self):
        reads = [{
            "id": "r1",
            "intervals": [[10, 40, 25], [70, 90, 25]],
            "layers": {},
        }]
        rules = [{
            "id": "not_gene",
            "name": "Not in gene",
            "enabled": True,
            "terms": [{
                "id": "t1",
                "source": "label_rule",
                "rule": {
                    "id": "label",
                    "name": "Small not gene",
                    "sizeMin": 1,
                    "sizeMax": 40,
                    "targetLayers": [],
                    "conditions": [{"target": "gene", "negate": True}],
                    "enabled": True,
                },
            }],
        }]

        features, _, _, _ = clustering_features.extract_features_from_compact(
            reads,
            [(0, 100)],
            region_start=0,
            step=10,
            peak_modes=["cluster_rule:not_gene"],
            cluster_feature_rules=rules,
            cluster_rule_context={"gene_regions": [(0, 50)], "gene_regions_by_key": {}},
        )

        assert features[0, 1] == 0.0
        assert features[0, 7] == 1.0


# ============================================================================
# cluster_compact_reads — combinatorial method
# ============================================================================

class TestClusterCompactReadsCombinatorial:
    def _make_binary_pattern_reads(self, patterns, peak_size=100, step=10):
        """Create reads with specific open/closed patterns at peaks.

        Args:
            patterns: List of tuples, e.g., [(1, 0, 1), (0, 1, 0)] means
                      first read: peak0=open, peak1=closed, peak2=open
        """
        n_peaks = len(patterns[0])
        reads = []
        for i, pattern in enumerate(patterns):
            intervals = []
            for p_idx in range(n_peaks):
                p_start = p_idx * (peak_size + 50)
                p_end = p_start + peak_size
                if pattern[p_idx] == 1:
                    # Open: small footprints
                    intervals.append([p_start, p_end, 30])
                else:
                    # Closed: nucleosomal
                    intervals.append([p_start, p_end, 150])
            reads.append(make_compact_read(f'read_{i}', intervals))

        peak_regions = [(p * (peak_size + 50), p * (peak_size + 50) + peak_size)
                        for p in range(n_peaks)]
        return reads, peak_regions

    def test_two_distinct_patterns(self):
        """Reads with pattern (1,0) and (0,1) should end up in different clusters."""
        reads, peaks = self._make_binary_pattern_reads([
            (1, 0), (1, 0), (1, 0),  # 3 reads: peak0 open, peak1 closed
            (0, 1), (0, 1), (0, 1),  # 3 reads: peak0 closed, peak1 open
        ])
        assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=0, n_clusters=4, method='combinatorial'
        )
        assert len(set(assignments.values())) == 2
        # reads 0,1,2 should be in one cluster, reads 3,4,5 in another
        assert assignments['read_0'] == assignments['read_1'] == assignments['read_2']
        assert assignments['read_3'] == assignments['read_4'] == assignments['read_5']
        assert assignments['read_0'] != assignments['read_3']

    def test_all_same_pattern_one_cluster(self):
        """All reads with same pattern -> single cluster."""
        reads, peaks = self._make_binary_pattern_reads([
            (1, 1), (1, 1), (1, 1),
        ])
        assignments, counts, _, _ = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=0, n_clusters=4, method='combinatorial'
        )
        assert len(set(assignments.values())) == 1

    def test_element_info_has_patterns(self):
        """Combinatorial clustering returns element_info with pattern data."""
        reads, peaks = self._make_binary_pattern_reads([
            (1, 0), (0, 1),
        ])
        _, _, _, info = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=0, n_clusters=4, method='combinatorial'
        )
        assert info is not None
        # The shared schema (cluster_all, dynamic reassignment, similarity sort)
        assert info['method'] == 'combinatorial' and info['n_elements'] == 2
        assert set(info['cluster_patterns']) == set(info['clusters'])
        # Each cluster's detail: pattern and peak_states
        for label, cluster_info in info['clusters'].items():
            assert 'pattern' in cluster_info
            assert 'peak_states' in cluster_info
            assert 'read_ids' in cluster_info
            assert info['cluster_patterns'][label] == list(cluster_info['pattern'])

    def test_accessibility_threshold_controls_open_call(self):
        """Changing accessibility_threshold affects whether peaks are called open."""
        # With threshold=0.5, a peak with 60% accessibility should be called open
        # With threshold=0.8, the same peak should be called closed
        reads = [
            # Read with mixed footprints: some accessible, some not
            make_compact_read('r1', [
                [0, 60, 30],   # first 60bp accessible (size < 90)
                [60, 100, 150],  # last 40bp nucleosomal (size >= 90)
            ]),
        ]
        peaks = [(0, 100)]

        # With threshold 0.3 (30%): 60% accessible > 0.3 -> open
        a1, _, _, info1 = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=0, n_clusters=2,
            method='combinatorial', accessibility_threshold=0.3
        )

        # With threshold 0.9 (90%): 60% accessible < 0.9 -> closed
        a2, _, _, info2 = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=0, n_clusters=2,
            method='combinatorial', accessibility_threshold=0.9
        )

        # Different thresholds should produce different patterns
        pattern1 = list(info1['cluster_patterns'].values())[0]
        pattern2 = list(info2['cluster_patterns'].values())[0]
        assert pattern1 != pattern2

    def test_empty_reads_returns_empty(self):
        assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
            [], [(0, 100)], region_start=0, n_clusters=4, method='combinatorial'
        )
        assert assignments == {}
        assert counts == {}

    def test_empty_peaks_returns_empty(self):
        reads = [make_compact_read('r1', [[0, 100, 50]])]
        assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
            reads, [], region_start=0, n_clusters=4, method='combinatorial'
        )
        assert assignments == {}


# ============================================================================
# cluster_compact_reads — kmeans method
# ============================================================================

class TestClusterCompactReadsKmeans:
    def test_cluster_assignment_is_quiet_by_default(self, capsys, monkeypatch):
        monkeypatch.delenv("FIBERBROWSER_CLUSTER_DIAGNOSTICS", raising=False)
        reads = [
            make_compact_read(f'r{i}', [[0, 100, 30 if i < 5 else 150]])
            for i in range(10)
        ]

        cluster_assignment.cluster_compact_reads(
            reads, [(0, 100)], region_start=0, n_clusters=2, method='kmeans'
        )

        assert capsys.readouterr().out == ""

    def test_kmeans_returns_assignments(self):
        """K-means clustering returns assignments for all reads."""
        reads = [
            make_compact_read(f'r{i}', [[0, 100, 30 if i < 5 else 150]])
            for i in range(10)
        ]
        assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
            reads, [(0, 100)], region_start=0, n_clusters=2, method='kmeans'
        )
        assert len(assignments) == 10
        assert sum(counts.values()) == 10
        assert info is None  # kmeans doesn't produce element_info

    def test_kmeans_k_capped_at_n_samples(self):
        """K is capped at number of samples."""
        reads = [make_compact_read(f'r{i}', [[0, 100, 50]]) for i in range(3)]
        assignments, counts, _, _ = cluster_assignment.cluster_compact_reads(
            reads, [(0, 100)], region_start=0, n_clusters=10, method='kmeans'
        )
        assert len(assignments) == 3
        # k should be min(10, 3) = 3, but max(2, 3) = 3
        assert len(counts) <= 3

    def test_sorted_idx_is_argsort_of_labels(self):
        """sorted_idx should be an argsort of cluster labels."""
        reads = [
            make_compact_read(f'r{i}', [[0, 100, 30 if i < 5 else 150]])
            for i in range(10)
        ]
        _, _, sorted_idx, _ = cluster_assignment.cluster_compact_reads(
            reads, [(0, 100)], region_start=0, n_clusters=2, method='kmeans'
        )
        assert sorted_idx is not None
        assert len(sorted_idx) == 10


# ============================================================================
# cluster_compact_reads — max patterns limit
# ============================================================================

class TestCombinatorialMaxPatterns:
    def test_max_50_patterns(self):
        """With more than 50 unique patterns, rarest get lumped into cluster 49."""
        # Create 60 reads each with a unique binary pattern across 6 peaks
        reads = []
        peaks = [(i * 150, i * 150 + 100) for i in range(6)]
        for i in range(60):
            bits = format(i, '06b')
            intervals = []
            for p_idx in range(6):
                p_start = p_idx * 150
                p_end = p_start + 100
                size = 30 if bits[p_idx] == '1' else 150
                intervals.append([p_start, p_end, size])
            reads.append(make_compact_read(f'r{i}', intervals))

        _, counts, _, info = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=0, n_clusters=4, method='combinatorial'
        )
        # Should have at most 50 clusters
        assert len(counts) <= 50
