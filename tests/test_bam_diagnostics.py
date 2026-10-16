import sys
from types import SimpleNamespace

import pytest

from services.bam_diagnostics import diagnose_bam_tags


@pytest.fixture(autouse=True)
def _placeholder_urls_have_no_remote_index(monkeypatch):
    """These tests serve placeholder https:// URLs from a fake pysam; a remote
    BAM's index is now looked up over the network before htslib opens it."""
    import services.remote_sources.opening as opening
    monkeypatch.setattr(opening, "url_index_for", lambda path: None)


class FakeRead:
    is_unmapped = False
    is_secondary = False
    query_sequence = "ARYC"

    def get_tags(self):
        return [
            ("ns", [10]),
            ("nl", [120]),
            ("as", [150]),
            ("al", [30]),
            ("aq", [250]),
            ("MM", "A+a?,0;C+m?,0;"),
            ("MA", "v1;tf+:0;fp_v2.:0;"),
        ]

    def has_tag(self, tag):
        return tag == "MD"

    def get_aligned_pairs(self, with_seq=False):
        return [(0, 0, "A")]


class FakeBam:
    header = {"SQ": [{"SN": "2R"}]}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def fetch(self, chrom):
        assert chrom == "2R"
        return iter([FakeRead()])


class FakeHeaderDeclaredBam(FakeBam):
    header = {
        "SQ": [{"SN": "2R"}],
        "CO": [
            "unrelated comment",
            "MA-TYPES:v1:nuc,msp,tf,ddda_mcg,ddda_mcg_hemi",
        ],
    }


class FakeRandomRead:
    is_unmapped = False
    is_secondary = False
    query_sequence = "ACGT"
    reference_name = "2R"
    reference_end = 200

    def __init__(self, query_name, reference_start):
        self.query_name = query_name
        self.reference_start = reference_start

    def get_tags(self):
        return [
            ("ns", [10]),
            ("nl", [120]),
            ("as", [150]),
            ("al", [30]),
            ("aq", [250]),
            ("AQ", [80, 81, 82, 83]),
            ("MA", "v1;nuc+Q:1-120;tf+QQQ:140-20;"),
        ]

    def has_tag(self, tag):
        return False


class FakeRandomBam:
    header = {"SQ": [{"SN": "2R", "LN": 1_000_000}]}

    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def has_index(self):
        return True

    def fetch(self, chrom, start=None, end=None):
        assert chrom == "2R"
        self.calls.append((chrom, start, end))
        if start is None:
            return iter([FakeRead()])
        return iter([FakeRandomRead(f"tagged_{start}", start)])


class FakeAliasBam(FakeRandomBam):
    header = {"SQ": [{"SN": "chr2R", "LN": 1_000_000}]}

    def fetch(self, chrom, start=None, end=None):
        assert chrom == "chr2R"
        self.calls.append((chrom, start, end))
        if start is None:
            return iter([FakeRead()])
        return iter([FakeRandomRead(f"tagged_{start}", start)])


def test_diagnose_bam_tags_detects_layers(monkeypatch):
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: FakeBam())
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)

    result = diagnose_bam_tags("https://example.org/sample.bam", chrom="2R", limit=1)

    assert result["reads_checked"] == 1
    assert result["sampled_reads"] == 1
    assert result["has_nucleosomes"] is True
    assert result["has_msps"] is True
    assert result["has_fire"] is True
    assert result["has_m6a"] is True
    assert result["has_m5c"] is True
    assert result["has_deam"] is True
    assert result["has_iupac_ry"] is True
    assert result["ma_layers"] == ["fp_v2", "tf"]
    assert result["all_tags"]["MA"]["count"] == 1


def test_diagnose_bam_tags_uses_header_declarations_for_sparse_ma_layers(monkeypatch):
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: FakeHeaderDeclaredBam())
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)

    result = diagnose_bam_tags("https://example.org/sample.bam", chrom="2R", limit=1)

    # The sampled read lacks both mCG groups, but FiberHMM declared them in
    # @CO, so registration can still expose their toggles and request payloads.
    assert result["declared_ma_layers"] == [
        "ddda_mcg", "ddda_mcg_hemi", "msp", "nuc", "tf",
    ]
    assert result["ma_layers"] == [
        "ddda_mcg", "ddda_mcg_hemi", "fp_v2", "msp", "nuc", "tf",
    ]


def test_diagnose_bam_tags_uses_random_windows_when_indexed(monkeypatch):
    fake_bam = FakeRandomBam()
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: fake_bam)
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)

    result = diagnose_bam_tags("https://example.org/sample.bam", chrom="2R", limit=3)

    assert result["reads_checked"] == 3
    assert result["ma_layers"] == ["nuc", "tf"]
    assert any(start is not None and end is not None for _chrom, start, end in fake_bam.calls)


def test_diagnose_bam_tags_resolves_chromosome_alias_for_sampling(monkeypatch):
    fake_bam = FakeAliasBam()
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: fake_bam)
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)

    result = diagnose_bam_tags("https://example.org/sample.bam", chrom="2R", limit=1)

    assert result["reads_checked"] == 1
    assert result["has_fire"] is True
    assert any(chrom == "chr2R" and start is not None for chrom, start, _end in fake_bam.calls)


class FakeUntaggedRead:
    is_unmapped = False
    is_secondary = False
    query_sequence = "ACGT"
    reference_name = "2R"
    reference_end = 200

    def __init__(self, query_name, reference_start):
        self.query_name = query_name
        self.reference_start = reference_start

    def get_tags(self):
        return [("NM", 1), ("AS", 100)]

    def has_tag(self, tag):
        return False


class FakeSparseTaggedRead(FakeUntaggedRead):
    def get_tags(self):
        return [("ns", [10]), ("nl", [120]), ("as", [150]), ("al", [30]), ("MA", "v1;nuc+Q:1-120;")]


class FakeSparseBam:
    """Tags live only on reads the small analysis sample never reaches."""

    header = {"SQ": [{"SN": "2R", "LN": 1_000_000}]}

    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def has_index(self):
        return True

    def fetch(self, chrom, start=None, end=None):
        assert chrom == "2R"
        self.calls.append((chrom, start, end))
        if start is not None:
            # Random-window sampling only ever sees untagged reads.
            return iter([
                FakeUntaggedRead(f"u_{start}_0", start),
                FakeUntaggedRead(f"u_{start}_1", start + 1),
            ])
        # Linear scan: untagged prefix, then a single tagged read.
        return iter(
            [FakeUntaggedRead(f"s{i}", 1000 + i) for i in range(5)]
            + [FakeSparseTaggedRead("tagged", 2000)]
        )


def test_diagnose_bam_tags_rescues_sparse_fiberhmm_tags(monkeypatch):
    # Regression: DAF recall BAMs tag only the mapped full-length molecules, so
    # the small analysis sample can miss every tagged read. The cheap rescue
    # scan must still surface nucleosome/MSP/MA layers.
    fake_bam = FakeSparseBam()
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: fake_bam)
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)

    result = diagnose_bam_tags("https://example.org/sparse.bam", chrom="2R", limit=2)

    assert result["reads_checked"] == 2  # analysis budget untouched by the rescue
    assert result["has_nucleosomes"] is True
    assert result["has_msps"] is True
    assert result["ma_layers"] == ["nuc"]


def test_diagnose_bam_tags_sparse_scan_is_bounded(monkeypatch):
    # A file with no fiber-seq tags must not scan beyond the cap.
    class NoTagBam(FakeSparseBam):
        def fetch(self, chrom, start=None, end=None):
            self.calls.append((chrom, start, end))
            if start is not None:
                return iter([FakeUntaggedRead(f"u_{start}", start)])
            return iter(FakeUntaggedRead(f"s{i}", i) for i in range(100))

    fake_bam = NoTagBam()
    monkeypatch.setitem(sys.modules, "pysam", SimpleNamespace(AlignmentFile=lambda *_a, **_k: fake_bam))

    result = diagnose_bam_tags("https://example.org/plain.bam", chrom="2R", limit=2, tag_scan_limit=10)

    assert result["has_nucleosomes"] is False
    assert result["has_msps"] is False
    assert result["ma_layers"] == []


def test_diagnose_bam_tags_missing_local_file_returns_error():
    result = diagnose_bam_tags("/definitely/missing/sample.bam")

    assert "BAM file not found" in result["error"]


class FakeMergedDafBam(FakeBam):
    # fiberhmm-merge declares its deam coverage track.
    header = {"SQ": [{"SN": "2R"}], "CO": ["MA-TYPES:v1:deam"]}


def test_diagnose_bam_tags_offers_per_strand_deam_coverage_layers(monkeypatch):
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: FakeMergedDafBam())
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)
    result = diagnose_bam_tags("https://example.org/sample.bam", chrom="2R", limit=1)
    assert {"deam", "deam_ct", "deam_ga"} <= set(result["ma_layers"])
