"""Tests for extracted models and utils modules."""

import pytest


# ── Utils: Chrom ────────────────────────────────────────────────────────────

class TestChromUtils:
    def test_normalize_chr_prefix(self):
        from utils.chrom import normalize_chrom_name
        assert normalize_chrom_name("chr1") == "1"
        assert normalize_chrom_name("Chr1") == "1"
        assert normalize_chrom_name("CHR1") == "1"

    def test_normalize_roman(self):
        from utils.chrom import normalize_chrom_name
        assert normalize_chrom_name("chrIII") == "3"
        assert normalize_chrom_name("XVI") == "16"

    def test_normalize_mitochondria(self):
        from utils.chrom import normalize_chrom_name
        assert normalize_chrom_name("chrM") == "mt"
        assert normalize_chrom_name("MT") == "mt"
        assert normalize_chrom_name("chrMT") == "mt"

    def test_build_and_translate(self):
        from utils.chrom import build_chrom_map, translate_chrom

        class FakeChrom:
            def __init__(self, name): self.name = name

        chroms = [FakeChrom("chr1"), FakeChrom("chr2"), FakeChrom("chrM")]
        cmap = build_chrom_map(chroms)
        assert translate_chrom("1", cmap) == "chr1"
        assert translate_chrom("chr1", cmap) == "chr1"
        assert translate_chrom("MT", cmap) == "chrM"

    def test_get_variants(self):
        from utils.chrom import get_chrom_variants
        variants = get_chrom_variants("chr1")
        assert "chr1" in variants
        assert "1" in variants


# ── Utils: Colors ───────────────────────────────────────────────────────────

class TestColors:
    def test_colormap_shape(self):
        from utils.colors import COLORMAP
        assert COLORMAP.shape == (256, 3)
        assert COLORMAP[0].tolist() == [255, 255, 255]  # No coverage = white

    def test_cluster_colors(self):
        # The app's 24-colour cluster palette (it was a separate, older 10-colour list here).
        from utils.colors import CLUSTER_COLORS, CLUSTER_COLORS_HEX
        assert len(CLUSTER_COLORS) == len(CLUSTER_COLORS_HEX) == 24
        assert all(len(c) == 3 for c in CLUSTER_COLORS)

    def test_value_to_index(self):
        from utils.colors import value_to_colormap_index
        assert value_to_colormap_index(0) == 0
        assert value_to_colormap_index(2) == 1
        assert 2 <= value_to_colormap_index(-50) <= 50
        assert 51 <= value_to_colormap_index(50) <= 139
        assert 140 <= value_to_colormap_index(100) <= 255


# ── Utils: Validation ───────────────────────────────────────────────────────

class TestValidation:
    def test_is_url(self):
        from utils.validation import is_url
        assert is_url("https://example.com/file.bam")
        assert is_url("http://example.com/file.bb")
        assert is_url("s3://bucket/file.bam")
        assert not is_url("/local/path/file.bam")
        assert not is_url("")
        assert not is_url(None)

    def test_is_s3(self):
        from utils.validation import is_s3_url
        assert is_s3_url("s3://bucket/key")
        assert not is_s3_url("https://example.com")
        assert not is_s3_url("")

    def test_detect_format(self):
        from utils.validation import detect_data_format
        assert detect_data_format("file.bam") == "bam"
        assert detect_data_format("file.bb") == "bigbed"
        assert detect_data_format("file.bigbed") == "bigbed"
        assert detect_data_format("file.txt") == "unknown"


# ── Models: Requests ────────────────────────────────────────────────────────

class TestRequestModels:
    def test_peak_region(self):
        from models.requests import PeakRegion
        p = PeakRegion(start=100, end=200)
        assert p.mode == "accessibility"

    def test_cluster_all_request(self):
        from models.requests import ClusterAllRequest, PeakRegion
        req = ClusterAllRequest(
            peak_regions=[PeakRegion(start=0, end=100)],
            k=3,
            method="combinatorial",
            sample_seed="seed-1",
        )
        assert len(req.peak_regions) == 1
        assert req.k == 3
        assert req.sample_seed == "seed-1"

    def test_filter_request(self):
        from models.requests import FilterRequest
        req = FilterRequest(filter_mode="open")
        assert req.filter_mode == "open"

    def test_jupyter_filter_request(self):
        from models.requests import JupyterFilterRequest
        req = JupyterFilterRequest(read_ids=["r1", "r2"])
        assert len(req.read_ids) == 2

    def test_footprint_analysis_request(self):
        from models.requests import FootprintAnalysisRequest
        req = FootprintAnalysisRequest(
            footprints=[{"absStart": 0, "absEnd": 100, "size": 100}],
            dataset_ids=["primary"],
            max_reads=5000,
            sample_seed="seed-2",
            include_read_analysis=False,
            include_sequences=False,
            include_profiles=False,
        )
        assert req.vplot_size_bin == 10
        assert req.vplot_log is True
        assert req.max_reads == 5000
        assert req.sample_seed == "seed-2"
        assert req.include_read_analysis is False
        assert req.include_sequences is False
        assert req.include_profiles is False
        assert req.include_overlap is True

    def test_primer_design_request_options(self):
        from models.requests import (
            DafcPrimerDesignRequest,
            FourCPrimerDesignRequest,
            PrimerDesignRequest,
        )

        req = PrimerDesignRequest(chrom="chr2L", start=100, end=500, exclude_regions=[[120, 140]])
        assert req.max_results == 5
        assert req.min_spacing == 50
        assert req.exclude_regions == [[120, 140]]
        assert req.tm_method == "primer3"
        assert req.check_tandem_repeats is True

        dafc_req = DafcPrimerDesignRequest(
            chrom="chr2L",
            x_start=100,
            x_end=200,
            y_start=1000,
            y_end=1200,
            y_chrom="chr3R",
            exclude_regions={"chr3R": [[1050, 1060]]},
            sample_seed="paper-v1",
        )
        assert dafc_req.y_chrom == "chr3R"
        assert dafc_req.exclude_regions["chr3R"] == [[1050, 1060]]
        assert dafc_req.sample_seed == "paper-v1"
        assert dafc_req.tm_method == "primer3"
        assert dafc_req.check_tandem_repeats is True

        fourc_req = FourCPrimerDesignRequest(chrom="chr2L", start=1000, end=1300)
        assert fourc_req.max_spacing == 500
        assert fourc_req.tm_method == "primer3"
        assert fourc_req.check_tandem_repeats is True
        assert fourc_req.check_three_prime_specificity is True


# ── Models: Domain ──────────────────────────────────────────────────────────

class TestDomainModels:
    def test_chrom_info(self):
        from models.domain import ChromInfo
        c = ChromInfo(name="chr1", size=248956422)
        assert c.name == "chr1"

    def test_cigar_mapper(self):
        from models.domain import CigarCoordMapper
        # 10M starting at ref=100
        mapper = CigarCoordMapper([(0, 10)], 100)
        assert mapper.query_to_ref(0) == 100
        assert mapper.query_to_ref(9) == 109

    def test_cigar_mapper_insertion(self):
        from models.domain import CigarCoordMapper
        # 5M, 3I, 5M starting at ref=100
        mapper = CigarCoordMapper([(0, 5), (1, 3), (0, 5)], 100)
        assert mapper.query_to_ref(4) == 104
        assert mapper.query_to_ref(5) == 105  # insertion maps to ref=105
        assert mapper.query_to_ref(7) == 105  # still insertion
        assert mapper.query_to_ref(8) == 105  # first M after insertion

    def test_cigar_mapper_batch_matches_single_position_mapping(self):
        from models.domain import CigarCoordMapper

        mapper = CigarCoordMapper([(4, 2), (0, 5), (1, 3), (0, 4), (2, 2), (0, 3)], 100)
        query_positions = [8, 0, 4, 5, 7, 11, 12, 20, 2]

        assert mapper.query_to_ref_many(query_positions) == [
            mapper.query_to_ref(query_pos)
            for query_pos in query_positions
        ]

    def test_cigar_mapper_interval_handles_unmapped_query_end_without_scan(self):
        from models.domain import CigarCoordMapper

        mapper = CigarCoordMapper([(0, 5), (4, 10)], 100)

        assert mapper.query_interval_to_ref(1, 12) == (101, 105)
        assert mapper.query_interval_to_ref(6, 12) == (None, None)

    def test_cigar_mapper_empty(self):
        from models.domain import CigarCoordMapper
        mapper = CigarCoordMapper(None, 0)
        assert mapper.query_to_ref(0) is None
        assert mapper.query_to_ref_many([0, 1]) == [None, None]
        assert mapper.query_interval_to_ref(0, 1) == (None, None)

    def test_working_set(self):
        from models.domain import WorkingSet
        ws = WorkingSet(
            reads=[{"id": "r1"}, {"id": "r2"}],
            total_overlapping=5,
            total_spanning=2,
            chrom="chr1", start=0, end=1000,
        )
        assert len(ws.reads) == 2
        assert ws.read_by_id["r1"]["id"] == "r1"
        assert ws.get_read_ids() == ["r1", "r2"]
        assert ws.region_width == 1000

    def test_jupyter_state(self):
        from models.domain import JupyterState
        js = JupyterState()
        js.highlights["h1"] = {"color": "red"}
        js.pending_peak_import = {"peaks": [{"chrom": "2R", "start": 1, "end": 2}]}
        js.pending_peak_rules_update = {"rules": [{"id": "rule-a"}]}
        js.pending_settings_update = {"analysis_sample_seed": "paper-v1"}
        js.version = 5
        js.clear_all()
        assert len(js.highlights) == 0
        assert js.pending_peak_import is None
        assert js.pending_peak_rules_update is None
        assert js.pending_settings_update is None
        assert js.version == 6

    def test_dafc_state(self):
        from models.domain import DAFCState
        ds = DAFCState()
        assert ds.cool_file is None
        assert ds.resolutions == []
        assert ds.linked_sessions == {}

    def test_contact_mode(self):
        from models.domain import ContactMode
        assert ContactMode.DAFC.value == "dafc"
        assert ContactMode.MICROC.value == "microc"
def test_aligned_interval_projection_matches_individual_aligned_bases():
    """Indels, skips and clips agree with pysam's base-level alignment oracle."""
    import random
    import pysam
    from models.domain import CigarCoordMapper
    rng = random.Random(7739)
    for _ in range(100):
        cigar = [(4, rng.randrange(1, 8))]
        for _ in range(rng.randrange(1, 12)):
            cigar.extend([(0, rng.randrange(1, 12)), (rng.choice([1, 2, 3]), rng.randrange(1, 8))])
        cigar += [(0, rng.randrange(1, 12)), (4, rng.randrange(1, 8))]
        read = pysam.AlignedSegment()
        read.reference_start = 100
        read.cigartuples = cigar
        read.query_sequence = 'A' * sum(n for op, n in cigar if op in (0, 1, 4))
        pairs = [(q, r) for q, r in read.get_aligned_pairs() if q is not None and r is not None]
        mapper = CigarCoordMapper(cigar, 100)
        for _ in range(40):
            start, end = sorted(rng.sample(range(-5, len(read.query_sequence) + 5), 2))
            expected = [r for q, r in pairs if start <= q <= end]
            assert mapper.aligned_query_interval_to_ref(start, end) == (
                (min(expected), max(expected) + 1) if expected else (None, None))
