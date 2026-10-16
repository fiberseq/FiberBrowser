import sys
from types import SimpleNamespace

from services.bam_boundaries import get_read_boundaries_from_bam


class FakeRead:
    def __init__(self, start, end, *, unmapped=False, secondary=False, supplementary=False):
        self.reference_start = start
        self.reference_end = end
        self.is_unmapped = unmapped
        self.is_secondary = secondary
        self.is_supplementary = supplementary


class FakeBam:
    references = ("chr2R",)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def fetch(self, chrom, start, end):
        assert chrom == "chr2R"
        assert start == 100
        assert end == 500
        return iter([
            FakeRead(110, 220),
            FakeRead(120, 230, secondary=True),
            FakeRead(130, 240),
            FakeRead(140, 250),
        ])


def test_get_read_boundaries_maps_chrom_and_skips_non_primary(monkeypatch):
    fake_pysam = SimpleNamespace(AlignmentFile=lambda *_args, **_kwargs: FakeBam())
    monkeypatch.setitem(sys.modules, "pysam", fake_pysam)
    # The URL is a placeholder (the fake pysam serves it); a remote BAM's index
    # is now looked up over the network before htslib opens it.
    import services.remote_sources.opening as opening
    monkeypatch.setattr(opening, "url_index_for", lambda path: None)

    boundaries = get_read_boundaries_from_bam(
        "https://example.org/sample.bam",
        "2R",
        100,
        500,
        max_reads=2,
        chrom_map={"2R": "chr2R"},
    )

    assert boundaries == [(110, 220), (130, 240)]


def test_get_read_boundaries_missing_local_file_returns_empty():
    assert get_read_boundaries_from_bam("/definitely/missing/sample.bam", "2R", 100, 500) == []
