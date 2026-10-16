from types import SimpleNamespace

from services.read_coverage import compute_binned_read_coverage


class FakeRead:
    def __init__(self, start: int, end: int):
        self.reference_start = start
        self.reference_end = end
        self.is_unmapped = False
        self.is_secondary = False
        self.is_supplementary = False


class FakeBam:
    references = ("chr1",)

    def __init__(self, reads):
        self._reads = reads
        self.queries = []

    def fetch(self, chrom, start, end):
        assert chrom == "chr1"
        self.queries.append((start, end))
        return list(self._reads)


class FakeBigBed:
    def __init__(self, entries):
        self._entries = entries
        self.queries = []

    def chroms(self):
        return {"chr1": 1000}

    def entries(self, chrom, start, end):
        assert chrom == "chr1"
        self.queries.append((start, end))
        return list(self._entries)


def test_binned_coverage_uses_diff_array_with_half_open_bin_edges():
    bam = FakeBam([
        FakeRead(5, 25),
        FakeRead(20, 40),
        FakeRead(10, 20),
    ])
    dataset = SimpleNamespace(id="bam", data_type="bam", paths=["sample.bam"])

    result = compute_binned_read_coverage(
        [dataset],
        "chr1",
        0,
        100,
        10,
        bam_handle_getter=lambda _path: bam,
        bigbed_handle_getter=lambda _path: None,
    )

    # Half-open: [5,25) is bins 0-2, [20,40) bins 2-3, [10,20) bin 1.
    assert result["coverage"] == [1, 2, 2, 1, 0, 0, 0, 0, 0, 0]
    assert result["max"] == 2
    # The reads in the window (the zoomed-out read panel says how many it would load).
    assert result["reads"] == 3


def test_binned_coverage_accumulates_bigbed_entries():
    bigbed = FakeBigBed([
        (0, 10, "read-a"),
        (15, 35, "read-b"),
        (90, 120, "read-c"),
    ])
    dataset = SimpleNamespace(id="bb", data_type="bigbed", paths=["sample.bb"])

    result = compute_binned_read_coverage(
        [dataset],
        "chr1",
        0,
        100,
        10,
        bam_handle_getter=lambda _path: None,
        bigbed_handle_getter=lambda _path: bigbed,
    )

    assert result["coverage"] == [1, 1, 1, 1, 0, 0, 0, 0, 0, 1]
    assert result["max"] == 1
    assert result["reads"] == 3


def test_binned_coverage_maps_circular_bam_segments_to_logical_viewport():
    bam = FakeBam([
        FakeRead(970, 990),
        FakeRead(10, 30),
    ])
    dataset = SimpleNamespace(id="bam", data_type="bam", paths=["sample.bam"])

    result = compute_binned_read_coverage(
        [dataset],
        "chr1",
        950,
        1050,
        10,
        bam_handle_getter=lambda _path: bam,
        bigbed_handle_getter=lambda _path: None,
        query_segments=[(950, 1000, 0), (0, 50, 1000)],
    )

    assert bam.queries == [(950, 1000), (0, 50)]
    assert result["coverage"] == [0, 0, 1, 1, 0, 0, 1, 1, 0, 0]
    assert result["max"] == 1


def test_binned_coverage_maps_circular_bigbed_segments_to_logical_viewport():
    bigbed = FakeBigBed([
        (960, 980, "read-a"),
        (20, 40, "read-b"),
    ])
    dataset = SimpleNamespace(id="bb", data_type="bigbed", paths=["sample.bb"])

    result = compute_binned_read_coverage(
        [dataset],
        "chr1",
        950,
        1050,
        10,
        bam_handle_getter=lambda _path: None,
        bigbed_handle_getter=lambda _path: bigbed,
        query_segments=[(950, 1000, 0), (0, 50, 1000)],
    )

    assert bigbed.queries == [(950, 1000), (0, 50)]
    assert result["coverage"] == [0, 1, 1, 0, 0, 0, 0, 1, 1, 0]
    assert result["max"] == 1


def test_binned_coverage_is_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_COVERAGE_DIAGNOSTICS", raising=False)
    bam = FakeBam([FakeRead(5, 25)])
    dataset = SimpleNamespace(id="bam", data_type="bam", paths=["sample.bam"])

    compute_binned_read_coverage(
        [dataset],
        "chr1",
        0,
        100,
        10,
        bam_handle_getter=lambda _path: bam,
        bigbed_handle_getter=lambda _path: None,
    )

    assert capsys.readouterr().out == ""


def test_abutting_reads_are_depth_one_at_the_join():
    bam = FakeBam([FakeRead(0, 10), FakeRead(10, 20)])
    dataset = SimpleNamespace(id="bam", data_type="bam", paths=["sample.bam"])
    result = compute_binned_read_coverage([dataset], "chr1", 0, 20, 20,
                                          bam_handle_getter=lambda _path: bam,
                                          bigbed_handle_getter=lambda _path: None)
    assert result["coverage"] == [1] * 20
