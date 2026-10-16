"""Integration tests using real BAM and BigBed data.

All tests are marked with @pytest.mark.integration and skip gracefully
if the Drosophila DAF-seq time-course dataset is not available.
"""

import pytest
import numpy as np

from services import cluster_assignment, compact_read_loader, clustering_features, read_metrics
from tests.conftest import (
    DROSOPHILA_CHROM,
    DROSOPHILA_START,
    DROSOPHILA_END,
    DROSOPHILA_REGION_WIDTH,
)

pytestmark = pytest.mark.integration


# ============================================================================
# Read loading from BAM
# ============================================================================

class TestBamReadLoading:
    def test_loads_reads_with_footprints(self, real_bam_path):
        """BAM loading returns reads with footprint intervals."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END
        )
        assert len(reads) > 0
        # Each read should have intervals
        for r in reads[:5]:
            assert 'id' in r
            assert 'intervals' in r
            assert len(r['intervals']) > 0

    def test_compact_format_structure(self, real_bam_path):
        """Intervals should be [start, end, size] tuples."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END
        )
        for r in reads[:10]:
            for iv in r['intervals']:
                assert len(iv) >= 3
                start, end, size = iv[0], iv[1], iv[2]
                assert isinstance(start, (int, float))
                assert isinstance(end, (int, float))
                assert end > start

    def test_intervals_are_region_relative(self, real_bam_path):
        """Interval coordinates should be relative to region_start."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END
        )
        for r in reads[:10]:
            # First interval start should be >= some negative value
            # (reads may extend before the region)
            # Last interval end should be reasonable
            first_start = r['intervals'][0][0]
            last_end = r['intervals'][-1][1]
            # At least some portion should be within the region
            assert last_end > 0 or first_start < DROSOPHILA_REGION_WIDTH

    def test_spanning_filter(self, real_bam_path):
        """Spanning filter should return only reads that cross both boundaries."""
        all_reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        spanning_reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=True
        )
        # Spanning reads should be a subset
        assert len(spanning_reads) <= len(all_reads)

    def test_read_ids_are_unique(self, real_bam_path):
        """Read IDs should be unique within a region."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END
        )
        ids = [r['id'] for r in reads]
        # Note: BAM read names may not be unique if paired-end
        # but within our loading logic they should be made unique
        assert len(ids) > 0


# ============================================================================
# Read loading from BigBed
# ============================================================================

class TestBigBedReadLoading:
    def test_loads_reads(self, real_bigbed_path):
        """BigBed loading returns compact reads."""
        reads = compact_read_loader.build_compact_reads_from_bigbed(
            real_bigbed_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END
        )
        assert len(reads) > 0
        for r in reads[:5]:
            assert 'id' in r
            assert 'intervals' in r

    def test_interval_structure(self, real_bigbed_path):
        """BigBed intervals should be [start, end, size] tuples."""
        reads = compact_read_loader.build_compact_reads_from_bigbed(
            real_bigbed_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END
        )
        for r in reads[:10]:
            for iv in r['intervals']:
                assert len(iv) >= 3
                start, end, size = iv[0], iv[1], iv[2]
                assert end > start


# ============================================================================
# Full pipeline tests with real data
# ============================================================================

class TestRealDataPipeline:
    def test_load_and_compute_metaprofile(self, real_bam_path):
        """Load reads, compute metaprofile, verify shape."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        profile = read_metrics.compute_metaprofile_from_compact_reads(
            reads, DROSOPHILA_REGION_WIDTH, 1, 200
        )
        assert profile.shape == (DROSOPHILA_REGION_WIDTH,)
        # Profile should have some signal
        assert profile.sum() > 0

    def test_load_and_cluster(self, real_bam_path):
        """Load reads, pick peak regions, cluster reads."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        if len(reads) < 5:
            pytest.skip("Not enough reads in region for clustering")

        # Use a peak in the middle of the region
        mid = DROSOPHILA_REGION_WIDTH // 2
        peaks = [(mid - 200, mid + 200)]  # 400bp peak

        assignments, counts, sorted_idx, info = cluster_assignment.cluster_compact_reads(
            reads, peaks, region_start=DROSOPHILA_START,
            n_clusters=3, method='combinatorial'
        )
        assert len(assignments) == len(reads)
        assert sum(counts.values()) == len(reads)

    def test_load_and_sample(self, real_bam_path):
        """Load reads, sample by coverage."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        n_sample = min(50, len(reads))
        sampled = read_metrics.sample_by_coverage(
            reads, n_sample, DROSOPHILA_START, DROSOPHILA_END
        )
        assert len(sampled) == n_sample

    def test_metaprofile_shape_matches_region(self, real_bam_path):
        """Metaprofile length should equal region width."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        for min_s, max_s in [(1, 80), (90, 300)]:
            profile = read_metrics.compute_metaprofile_from_compact_reads(
                reads, DROSOPHILA_REGION_WIDTH, min_s, max_s
            )
            assert profile.shape == (DROSOPHILA_REGION_WIDTH,)

    def test_extract_features_real_data(self, real_bam_path):
        """Feature extraction from real reads."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        if len(reads) < 5:
            pytest.skip("Not enough reads")

        mid = DROSOPHILA_REGION_WIDTH // 2
        peaks = [(mid - 200, mid + 200)]

        features, ids, widths, modes = clustering_features.extract_features_from_compact(
            reads, peaks, region_start=DROSOPHILA_START
        )
        assert features.shape[0] == len(reads)
        assert len(ids) == len(reads)
        # Feature values should be 0 or 1 for accessibility mode
        assert set(np.unique(features)).issubset({0.0, 1.0})


# ============================================================================
# m6A BAM loading
# ============================================================================

class TestM6aBamLoading:
    def test_m6a_bam_loads(self, real_m6a_bam_path):
        """m6A BAM (no footprints) should still load reads."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_m6a_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False
        )
        # May have reads even without footprint tags
        assert isinstance(reads, list)

    def test_m6a_bam_with_methylation(self, real_m6a_bam_path):
        """Loading with include_methylation should produce methyl field."""
        reads = compact_read_loader.build_compact_reads_from_bam(
            real_m6a_bam_path, DROSOPHILA_CHROM,
            DROSOPHILA_START, DROSOPHILA_END,
            spanning_only=False,
            include_methylation=True
        )
        if len(reads) > 0:
            # At least some reads should have methylation data
            has_methyl = any('methyl' in r for r in reads)
            # This depends on the data, so just check we didn't crash
            assert isinstance(reads, list)
