"""Tests for core service logic functions with synthetic data.

Tests pure functions used by browser services: sample_by_coverage, compute_metaprofile_from_compact_reads,
get_footprints_in_region, calc_nucleosome_coverage, evaluate_read_states.
"""

import pytest
import numpy as np

from helpers import make_compact_read, make_reads_spanning_region, make_reads_with_footprints

from services import orthogonal_tracks, read_metrics, transcription_state


# ============================================================================
# sample_by_coverage
# ============================================================================

class TestSampleByCoverage:
    def test_fewer_than_n_returns_all(self):
        reads = make_reads_spanning_region(3, 1000)
        result = read_metrics.sample_by_coverage(reads, 10, 0, 1000)
        assert len(result) == 3

    def test_exact_n_returns_all(self):
        reads = make_reads_spanning_region(5, 1000)
        result = read_metrics.sample_by_coverage(reads, 5, 0, 1000)
        assert len(result) == 5

    def test_more_than_n_returns_n(self):
        reads = make_reads_spanning_region(10, 1000)
        result = read_metrics.sample_by_coverage(reads, 5, 0, 1000)
        assert len(result) == 5

    def test_zero_width_region_returns_first_n(self):
        reads = make_reads_spanning_region(10, 1000)
        result = read_metrics.sample_by_coverage(reads, 3, 500, 500)
        assert len(result) == 3

    def test_sorts_by_coverage_descending(self):
        """Full-spanning reads should be preferred over partial ones."""
        region_start, region_end = 0, 1000
        # Read A: spans full region (coverage = 1.0)
        read_a = make_compact_read('full', [[0, 1000, -150]])
        # Read B: spans half the region (coverage ~ 0.5)
        read_b = make_compact_read('half', [[0, 500, -150]])
        # Read C: spans quarter (coverage ~ 0.25)
        read_c = make_compact_read('quarter', [[0, 250, -150]])

        result = read_metrics.sample_by_coverage([read_c, read_b, read_a], 2, region_start, region_end)
        assert len(result) == 2
        # Full-spanning read should be first
        assert result[0]['id'] == 'full'
        assert result[1]['id'] == 'half'

    def test_empty_intervals_coverage_zero(self):
        read_no_iv = {'id': 'empty', 'intervals': []}
        read_full = make_compact_read('full', [[0, 1000, -150]])
        result = read_metrics.sample_by_coverage([read_no_iv, read_full], 1, 0, 1000)
        assert result[0]['id'] == 'full'

    def test_missing_intervals_coverage_zero(self):
        read_no_iv = {'id': 'no_ivs'}
        read_full = make_compact_read('full', [[0, 1000, -150]])
        result = read_metrics.sample_by_coverage([read_no_iv, read_full], 1, 0, 1000)
        assert result[0]['id'] == 'full'

    def test_reads_outside_region_coverage_zero(self):
        """Reads whose intervals don't overlap the query region get coverage 0."""
        # Read intervals are region-relative, so [2000, 3000] + region_start=0 = abs [2000, 3000]
        # Query region is 0-1000, so no overlap
        read_outside = make_compact_read('outside', [[2000, 3000, -150]])
        read_inside = make_compact_read('inside', [[0, 1000, -150]])
        result = read_metrics.sample_by_coverage([read_outside, read_inside], 1, 0, 1000)
        assert result[0]['id'] == 'inside'


# ============================================================================
# compute_metaprofile_from_compact_reads
# ============================================================================

class TestComputeMetaprofile:
    def test_returns_correct_shape(self):
        reads = make_reads_with_footprints(5, 1000)
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 1000, 1, 200)
        assert profile.shape == (1000,)

    def test_footprints_contribute_to_profile(self):
        """A footprint at position 100-150 (size 50) should create a peak there."""
        reads = [make_compact_read('r1', [[100, 150, 50]])]
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 1000, 1, 200)
        # Positions 100-149 should be 1, others 0
        assert profile[100] == 1.0
        assert profile[149] == 1.0
        assert profile[99] == 0.0
        assert profile[150] == 0.0

    def test_size_filter_min(self):
        """Footprints below min_size should not contribute."""
        reads = [make_compact_read('r1', [[100, 150, 30]])]  # size=30
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 1000, 50, 200)
        assert profile.sum() == 0.0  # 30 < min_size=50

    def test_size_filter_max(self):
        """Footprints above max_size should not contribute."""
        reads = [make_compact_read('r1', [[100, 250, 200]])]  # size=200
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 1000, 1, 100)
        assert profile.sum() == 0.0  # 200 > max_size=100

    def test_size_filter_boundary(self):
        """Footprints at exactly min or max size should be included."""
        reads = [make_compact_read('r1', [[0, 50, 50]])]
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 1000, 50, 50)
        assert profile[0:50].sum() == 50.0

    def test_gaps_excluded(self):
        """Gaps (size <= 0) should not contribute."""
        reads = [make_compact_read('r1', [[0, 100, -150]])]  # gap
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 1000, 1, 200)
        assert profile.sum() == 0.0

    def test_empty_reads_zero_array(self):
        profile = read_metrics.compute_metaprofile_from_compact_reads([], 500, 1, 200)
        assert profile.shape == (500,)
        assert profile.sum() == 0.0

    def test_overlapping_footprints_accumulate(self):
        """Multiple reads with footprints at the same position should accumulate.

        The metaprofile normalizes per-position by coverage (number of reads
        spanning that position), so when both reads cover the same position,
        profile / coverage = 2/2 = 1.0 (not raw count 2.0).
        """
        reads = [
            make_compact_read('r1', [[100, 200, 50]]),
            make_compact_read('r2', [[150, 250, 50]]),
        ]
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 500, 1, 200)
        # Position 175 is covered by both reads: profile=2, coverage=2, normalized=1.0
        assert profile[175] == 1.0
        # Position 125 is covered by r1 only: profile=1, coverage=1, normalized=1.0
        assert profile[125] == 1.0

    def test_clipping_at_region_start(self):
        """Footprint extending before region start should be clipped."""
        reads = [make_compact_read('r1', [[-50, 50, 40]])]
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 100, 1, 200)
        # Only positions 0-49 should be covered (clipped at 0)
        assert profile[0] == 1.0
        assert profile[49] == 1.0
        assert profile.sum() == 50.0

    def test_clipping_at_region_end(self):
        """Footprint extending past region end should be clipped."""
        reads = [make_compact_read('r1', [[80, 150, 40]])]
        profile = read_metrics.compute_metaprofile_from_compact_reads(reads, 100, 1, 200)
        # Only positions 80-99 should be covered
        assert profile[80] == 1.0
        assert profile[99] == 1.0
        assert profile.sum() == 20.0


# ============================================================================
# get_footprints_in_region
# ============================================================================

class TestGetFootprintsInRegion:
    def test_plus_strand_basic(self):
        """Footprint overlapping TSS+10 to TSS+50 on + strand should be found."""
        region_start = 1000
        tss = 1100  # absolute position
        # Footprint at relative [90, 160] = absolute [1090, 1160]
        # TSS+10=1110, TSS+50=1150 -> overlap [1110, 1150]
        intervals = [[90, 160, 50]]
        result = transcription_state.get_footprints_in_region(intervals, tss, 10, 50, '+', region_start)
        assert result == [50]

    def test_minus_strand_flips_offsets(self):
        """On - strand, offsets are flipped relative to TSS."""
        region_start = 1000
        tss = 1200  # absolute position (at gene end for - strand)
        # For - strand: region_from = tss - 50 = 1150, region_to = tss - 10 = 1190
        # Footprint at relative [160, 185] = absolute [1160, 1185]
        intervals = [[160, 185, 45]]
        result = transcription_state.get_footprints_in_region(intervals, tss, 10, 50, '-', region_start)
        assert result == [45]

    def test_no_overlap_returns_empty(self):
        """Footprint far from TSS returns empty list."""
        region_start = 0
        tss = 5000
        # Footprint at absolute [100, 200], query region at [5010, 5050]
        intervals = [[100, 200, 50]]
        result = transcription_state.get_footprints_in_region(intervals, tss, 10, 50, '+', region_start)
        assert result == []

    def test_gaps_excluded(self):
        """Gaps (size <= 0) should be skipped."""
        region_start = 0
        tss = 100
        intervals = [[110, 150, -50]]  # gap overlapping TSS+10 to TSS+50
        result = transcription_state.get_footprints_in_region(intervals, tss, 10, 50, '+', region_start)
        assert result == []

    def test_multiple_footprints_in_region(self):
        """Multiple footprints overlapping the query region."""
        region_start = 0
        tss = 100
        intervals = [
            [105, 125, 30],  # overlaps TSS+10 to TSS+50
            [130, 145, 40],  # overlaps TSS+10 to TSS+50
            [200, 250, 60],  # outside
        ]
        result = transcription_state.get_footprints_in_region(intervals, tss, 10, 50, '+', region_start)
        assert sorted(result) == [30, 40]

    def test_negative_offsets(self):
        """Negative offsets (upstream of TSS) work correctly."""
        region_start = 0
        tss = 500
        # Region: TSS-100 to TSS-20 = [400, 480]
        intervals = [[410, 470, 55]]  # absolute [410, 470], inside [400, 480]
        result = transcription_state.get_footprints_in_region(intervals, tss, -100, -20, '+', region_start)
        assert result == [55]


# ============================================================================
# get_footprints_in_gene_body
# ============================================================================

class TestGetFootprintsInGeneBody:
    def test_basic_gene_body(self):
        region_start = 0
        tss, tes = 100, 500
        intervals = [
            [150, 200, 50],  # inside gene body
            [600, 700, 80],  # outside gene body
        ]
        result = transcription_state.get_footprints_in_gene_body(intervals, tss, tes, '+', region_start)
        assert result == [50]

    def test_minus_strand_gene_body(self):
        """For minus strand, TSS > TES numerically, but gene body is min(tss,tes) to max(tss,tes)."""
        region_start = 0
        tss, tes = 500, 100  # minus strand: TSS at high end
        intervals = [[150, 200, 50]]  # inside gene body [100, 500]
        result = transcription_state.get_footprints_in_gene_body(intervals, tss, tes, '-', region_start)
        assert result == [50]


# ============================================================================
# calc_nucleosome_coverage
# ============================================================================

class TestCalcNucleosomeCoverage:
    def test_full_nucleosome_coverage(self):
        """Gene body entirely covered by one large nucleosome -> 1.0."""
        region_start = 0
        gene_start, gene_end = 100, 300
        # Single nucleosome covering entire gene body (size >= 90)
        intervals = [[100, 300, 200]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, gene_start, gene_end, region_start)
        assert cov == pytest.approx(1.0)

    def test_no_nucleosomes_zero_coverage(self):
        """No nucleosome-sized footprints -> 0.0."""
        region_start = 0
        gene_start, gene_end = 100, 300
        # Only small footprints (size < 90)
        intervals = [[100, 150, 50], [150, 200, 40]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, gene_start, gene_end, region_start)
        assert cov == 0.0

    def test_partial_coverage(self):
        """One nucleosome covering half the gene body -> 0.5."""
        region_start = 0
        gene_start, gene_end = 0, 200
        # One nucleosome covering first 100bp
        intervals = [[0, 100, 150]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, gene_start, gene_end, region_start)
        assert cov == pytest.approx(0.5)

    def test_zero_length_gene(self):
        """Gene with zero length -> 0.0."""
        intervals = [[0, 100, 150]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, 50, 50, 0)
        assert cov == 0.0

    def test_nucleosome_partially_overlapping_gene(self):
        """Nucleosome extends beyond gene boundaries, only overlap counts."""
        region_start = 0
        gene_start, gene_end = 100, 200  # 100bp gene
        # Nucleosome from 50-150, only 100-150 overlaps (50bp overlap)
        intervals = [[50, 150, 150]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, gene_start, gene_end, region_start)
        assert cov == pytest.approx(0.5)

    def test_size_threshold_boundary(self):
        """Footprint of exactly 89bp should NOT count, 90bp should."""
        region_start = 0
        gene_start, gene_end = 0, 100
        intervals_89 = [[0, 100, 89]]
        intervals_90 = [[0, 100, 90]]
        cov_89 = transcription_state.calc_nucleosome_coverage(intervals_89, gene_start, gene_end, region_start)
        cov_90 = transcription_state.calc_nucleosome_coverage(intervals_90, gene_start, gene_end, region_start)
        assert cov_89 == 0.0
        assert cov_90 == pytest.approx(1.0)

    def test_reverse_gene_coords(self):
        """Gene start > gene end should still work (uses min/max)."""
        region_start = 0
        intervals = [[50, 150, 150]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, 200, 100, region_start)
        assert cov == pytest.approx(0.5)  # overlap: 100-150 = 50bp / 100bp gene

    def test_region_offset(self):
        """Intervals are region-relative, region_start offsets them to absolute."""
        region_start = 1000
        gene_start, gene_end = 1100, 1200  # absolute gene coords
        # Interval at relative [100, 200] = absolute [1100, 1200] -> full coverage
        intervals = [[100, 200, 150]]
        cov = transcription_state.calc_nucleosome_coverage(intervals, gene_start, gene_end, region_start)
        assert cov == pytest.approx(1.0)


# ============================================================================
# evaluate_read_states
# ============================================================================

class TestEvaluateReadStates:
    def test_paused_state_detected(self):
        """Read with median 50bp footprint at TSS+10 to TSS+50 -> pause=True."""
        region_start = 0
        gene = {'id': 'gene1', 'start': 100, 'end': 500, 'strand': '+'}
        # TSS=100. Footprint at [110, 160] = absolute [110, 160], size=50 (median 50, in [35,65])
        intervals = [
            [0, 100, -50],     # gap before TSS
            [110, 160, 50],    # pause footprint
            [160, 500, -100],  # gap after
        ]
        result = transcription_state.evaluate_read_states(intervals, gene, region_start)
        assert result['pause'] is True

    def test_no_pause_when_no_footprints(self):
        """No footprints in pause region -> pause=False."""
        region_start = 0
        gene = {'id': 'gene1', 'start': 100, 'end': 500, 'strand': '+'}
        # Only gaps
        intervals = [[0, 500, -100]]
        result = transcription_state.evaluate_read_states(intervals, gene, region_start)
        assert result['pause'] is False

    def test_pic_state_detected(self):
        """Read with footprint of median 30bp at TSS-50 to TSS+25 -> pic=True."""
        region_start = 0
        gene = {'id': 'gene1', 'start': 200, 'end': 600, 'strand': '+'}
        # TSS=200. PIC region: [150, 225]. Footprint at [155, 185] size=30, in [20,40]
        intervals = [
            [0, 155, -50],
            [155, 185, 30],
            [185, 600, -100],
        ]
        result = transcription_state.evaluate_read_states(intervals, gene, region_start)
        assert result['pic'] is True

    def test_elongating_count(self):
        """Count of 35-65bp footprints in gene body."""
        region_start = 0
        gene = {'id': 'gene1', 'start': 100, 'end': 500, 'strand': '+'}
        # Two 50bp footprints in gene body (35 <= 50 <= 65)
        intervals = [
            [0, 100, -50],
            [200, 250, 50],    # in gene body, size in [35,65]
            [300, 350, 50],    # in gene body, size in [35,65]
            [350, 500, -100],
        ]
        result = transcription_state.evaluate_read_states(intervals, gene, region_start)
        assert result['elongating_count'] == 2

    def test_result_has_only_pause_pic_elongating(self):
        """The removed hyperburst state is no longer reported."""
        gene = {'id': 'gene1', 'start': 0, 'end': 1000, 'strand': '+'}
        intervals = [[0, 50, 30], [50, 1000, -50]]
        result = transcription_state.evaluate_read_states(intervals, gene, 0)
        assert set(result) == {'pause', 'pic', 'elongating_count'}

    def test_minus_strand_gene(self):
        """Minus strand gene: TSS is at gene end."""
        region_start = 0
        gene = {'id': 'gene1', 'start': 100, 'end': 500, 'strand': '-'}
        # TSS=500 (gene end for minus strand)
        # Pause region for - strand: TSS-50=450 to TSS-10=490
        # Footprint at [460, 485] = absolute [460, 485], size=45
        intervals = [
            [0, 460, -50],
            [460, 485, 45],   # size 45, median 45, in [35,65]
            [485, 600, -100],
        ]
        result = transcription_state.evaluate_read_states(intervals, gene, region_start)
        assert result['pause'] is True


# ============================================================================
# _parse_bed_file
# ============================================================================

class TestParseBedFile:
    def test_basic_bed3(self, tmp_path):
        bed = tmp_path / "test.bed"
        bed.write_text("chr1\t100\t200\nchr1\t300\t400\nchr2\t50\t150\n")
        result = orthogonal_tracks.parse_bed_file(str(bed))
        assert len(result['chr1']) == 2
        assert len(result['chr2']) == 1
        assert result['chr1'][0] == {'start': 100, 'end': 200}

    def test_bed_with_name_score_strand(self, tmp_path):
        bed = tmp_path / "test.bed"
        bed.write_text("chr1\t100\t200\tpeak1\t500\t+\n")
        result = orthogonal_tracks.parse_bed_file(str(bed))
        iv = result['chr1'][0]
        assert iv['name'] == 'peak1'
        assert iv['score'] == 500
        assert iv['strand'] == '+'

    def test_skips_header_lines(self, tmp_path):
        bed = tmp_path / "test.bed"
        bed.write_text("# comment\ntrack name=test\nbrowser position chr1:1-100\nchr1\t100\t200\n")
        result = orthogonal_tracks.parse_bed_file(str(bed))
        assert len(result['chr1']) == 1

    def test_skips_malformed_lines(self, tmp_path):
        bed = tmp_path / "test.bed"
        bed.write_text("chr1\t100\t200\nchr1\tnotanumber\t200\nchr1\t300\t400\n")
        result = orthogonal_tracks.parse_bed_file(str(bed))
        assert len(result['chr1']) == 2  # skips the bad line

    def test_gzipped_bed(self, tmp_path):
        import gzip
        bed = tmp_path / "test.bed.gz"
        with gzip.open(str(bed), 'wt') as f:
            f.write("chr1\t100\t200\n")
        result = orthogonal_tracks.parse_bed_file(str(bed))
        assert len(result['chr1']) == 1
