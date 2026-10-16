from types import SimpleNamespace

import services.random_window as rw


class FakeRead:
    def __init__(self, start: int, end: int):
        self.reference_start = start
        self.reference_end = end
        self.is_unmapped = False
        self.is_secondary = False
        self.is_supplementary = False


class FakeStat:
    def __init__(self, contig: str, mapped: int):
        self.contig = contig
        self.mapped = mapped
        self.unmapped = 0
        self.total = mapped


class FakeBam:
    references = ("chr1",)

    def __init__(self, reads, size=1000):
        self._reads = reads
        self._size = size

    def get_index_statistics(self):
        return [FakeStat("chr1", len(self._reads))]

    def get_reference_length(self, contig):
        return self._size

    def fetch(self, contig, start, end=None):
        end = self._size if end is None else end
        return [
            r for r in self._reads
            if (r.reference_end or r.reference_start + 1) > start and r.reference_start < end
        ]


def _make_state(datasets):
    return SimpleNamespace(
        dataset_order=[d.id for d in datasets],
        get_dataset=lambda did: next((d for d in datasets if d.id == did), None),
        chroms=[SimpleNamespace(name="chr1", size=1000)],
        translate_chrom=lambda chrom: chrom,
    )


def _bam_dataset():
    return SimpleNamespace(id="d1", data_type="bam", paths=["x.bam"])


def test_random_window_finds_covered_region(monkeypatch):
    reads = [FakeRead(100, 300), FakeRead(150, 350), FakeRead(120, 320)]
    monkeypatch.setattr(rw, "get_bam_handle", lambda path: FakeBam(reads))
    state = _make_state([_bam_dataset()])

    res = rw.random_covered_window(state, span=200, min_coverage=1, seed=1)

    assert res["success"] is True
    assert res["chrom"] == "chr1"
    assert res["end"] - res["start"] == 200  # span preserved
    assert 0 <= res["start"] and res["end"] <= 1000  # within chrom bounds
    assert res["max_coverage"] >= 1


def test_random_window_respects_min_coverage(monkeypatch):
    # Peak depth is only 3; a min of 100 can never be satisfied.
    reads = [FakeRead(100, 300), FakeRead(150, 350), FakeRead(120, 320)]
    monkeypatch.setattr(rw, "get_bam_handle", lambda path: FakeBam(reads))
    state = _make_state([_bam_dataset()])

    res = rw.random_covered_window(state, span=200, min_coverage=100, seed=1)

    assert res["success"] is False
    assert "coverage" in res["error"]


def test_random_window_clamps_span_to_small_chrom(monkeypatch):
    reads = [FakeRead(100, 300)]
    monkeypatch.setattr(rw, "get_bam_handle", lambda path: FakeBam(reads, size=1000))
    state = _make_state([_bam_dataset()])

    # Span larger than the chromosome collapses to the whole chromosome.
    res = rw.random_covered_window(state, span=5000, min_coverage=1, seed=2)

    assert res["success"] is True
    assert res["start"] == 0
    assert res["end"] == 1000


def test_random_window_no_datasets():
    state = SimpleNamespace(dataset_order=[], get_dataset=lambda d: None, chroms=[], translate_chrom=lambda c: c)
    res = rw.random_covered_window(state, span=200, min_coverage=1)
    assert res["success"] is False
