from services.analysis_query import AnalysisReadQuery


class FakeState:
    dataset_order = ["ds-a", "ds-b"]

    def __init__(self):
        self.calls = []

    def translate_chrom(self, chrom):
        return {"chr2R": "2R"}.get(chrom, chrom)

    def resolve_dataset_id(self, dataset_id=None):
        if dataset_id in (None, "", "primary"):
            return "ds-a"
        return dataset_id

    def get_dataset(self, dataset_id):
        return object() if dataset_id in self.dataset_order else None

    def build_working_set(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return {"args": args, "kwargs": kwargs}


def test_analysis_read_query_normalizes_common_scope():
    state = FakeState()
    query = AnalysisReadQuery.from_request(
        state,
        chrom="chr2R",
        start=10,
        end=50,
        spanning=True,
        dataset_ids="primary,ds-b,ds-b",
        sample_seed=None,
        read_ids=["r1", "r2"],
        read_ids_by_dataset={"primary": ["a"], "ds-b": ["b"]},
        max_reads=500,
        min_footprints=3,
        include_methylation=False,
        requested_layers="tf,fire,tf",
    )

    assert query.chrom == "2R"
    assert query.dataset_ids == ["ds-a", "ds-b"]
    assert query.sample_seed == "fiberbrowser-analysis"
    assert query.read_ids_for_dataset("ds-a") == ["a"]
    assert query.read_ids_for_dataset("ds-b") == ["b"]
    assert query.max_reads == 500
    assert query.min_footprints == 3
    assert query.include_methylation is False
    assert query.requested_layers == ("fire", "tf")


def test_analysis_read_query_applies_singleton_read_ids_and_working_set_args():
    state = FakeState()
    query = AnalysisReadQuery.from_request(
        state,
        chrom="chrX",
        start=100,
        end=200,
        dataset_id="primary",
        read_ids=["r1", "r2"],
        sample_seed="paper",
    )

    assert query.dataset_ids == ["ds-a"]
    assert query.read_ids_for_dataset("ds-a") == ["r1", "r2"]

    result = query.build_working_set(state, "ds-a", include_layers=False)
    assert result["args"][:5] == ("ds-a", "chrX", 100, 200, False)
    assert result["args"][5] == 0
    assert result["kwargs"]["read_ids"] == ["r1", "r2"]
    assert result["kwargs"]["sample_seed"] == "paper"
    assert result["kwargs"]["include_layers"] is False


def test_analysis_read_query_threads_layer_quality_flag_to_working_set():
    state = FakeState()
    query = AnalysisReadQuery.from_request(
        state,
        chrom="chrX",
        start=100,
        end=200,
        dataset_id="primary",
        include_layers=True,
        requested_layers="nuc,tf",
        include_layer_qualities=False,
    )

    assert query.include_layer_qualities is False

    result = query.build_working_set(state, "ds-a")
    assert result["kwargs"]["include_layers"] is True
    assert result["kwargs"]["requested_layers"] == ("nuc", "tf")
    assert result["kwargs"]["include_layer_qualities"] is False


def test_analysis_read_query_preserves_explicit_empty_dataset_scope():
    state = FakeState()
    query = AnalysisReadQuery.from_request(
        state,
        chrom="chrX",
        start=100,
        end=200,
        dataset_ids="primary,ds-b",
        read_ids_by_dataset={"primary": [], "ds-b": ["missing"]},
    )

    assert query.read_ids_for_dataset("ds-a") == []
    assert query.filter_reads_for_dataset("ds-a", [{"id": "r1"}]) == []
    assert query.filter_reads_for_dataset("ds-b", [{"id": "r1"}]) == []

    result = query.build_working_set(state, "ds-a")
    assert result["kwargs"]["read_ids"] == []


def test_analysis_read_query_reproducibly_caps_reads():
    state = FakeState()
    query = AnalysisReadQuery.from_request(
        state,
        chrom="chrX",
        start=0,
        end=100,
        max_reads=5,
        sample_seed="stable",
    )
    reads = [{"id": f"read-{i}"} for i in range(20)]

    first = query.cap_reads(reads, namespace="test", label="ds-a")
    second = query.cap_reads(reads, namespace="test", label="ds-a")
    different = query.cap_reads(reads, namespace="test", label="ds-b")

    assert len(first) == 5
    assert [r["id"] for r in first] == [r["id"] for r in second]
    assert [r["id"] for r in first] != [r["id"] for r in different]
