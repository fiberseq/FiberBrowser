"""Annotation analyses stay within the datasets they are asked about (B6 review)."""
from types import SimpleNamespace

from models.domain import WorkingSet


class State:
    dataset_order = ["a", "b"]
    max_working_reads = None

    def __init__(self):
        self.datasets = {"a": SimpleNamespace(id="a"), "b": SimpleNamespace(id="b")}
        shared = SimpleNamespace(id="f1", path="/shared.bb", active=True, dataset_ids=[])
        only_b = SimpleNamespace(id="f2", path="/only_b.bb", active=True, dataset_ids=["b"])
        self.annotation_state = SimpleNamespace(files={"f1": shared, "f2": only_b}, confidence_thresholds={})

    def translate_chrom(self, chrom):
        return chrom

    def resolve_dataset_id(self, dataset_id=None):
        return dataset_id or "a"

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        reads = [{"id": f"r_{dataset_id}", "intervals": [[0, 10, 50]]}]
        return WorkingSet(reads, 1, 1, chrom, start, end)


def _recording_loader(calls):
    def load(path, chrom, start, end, confidence_thresholds=None, read_names=None):
        calls.append((path, read_names))
        return {"r_a": [(1, 5, "x", 1.0)], "r_b": [(1, 5, "x", 1.0)]}, {}
    return load


def test_profile_of_one_dataset_uses_its_files_and_reads_only():
    from services.annotations_endpoint import get_annotation_profile_payload
    calls = []
    get_annotation_profile_payload(State(), chrom="chr1", start=0, end=100, dataset_id="a",
                                   annotation_types="x", bins=10, load_annotations=_recording_loader(calls))
    assert [path for path, _ in calls] == ["/shared.bb"]  # not dataset b's own file
    assert calls[0][1] == {"r_a"}


def test_clustering_requested_datasets_uses_their_files_and_reads_only():
    from services.annotations_endpoint import cluster_by_annotations_payload
    calls = []
    req = SimpleNamespace(chrom="chr1", start=0, end=100, dataset_ids=["a"], peak_regions=[{"start": 0, "end": 10}],
                          annotation_types=["x"], method="kmeans", k=2, sample_seed=None)
    try:
        cluster_by_annotations_payload(State(), req, load_annotations=_recording_loader(calls))
    except Exception:
        pass  # clustering one read may fail; what was loaded is the point
    assert [path for path, _ in calls] == ["/shared.bb"]
    assert calls[0][1] == {"r_a"}


class EmptyA(State):
    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        if dataset_id == "a":
            return WorkingSet([], 0, 0, chrom, start, end)
        return super().build_working_set(dataset_id, chrom, start, end, spanning, min_footprints, **kwargs)


def _region_ready(state):
    ann = state.annotation_state
    ann.get_cached = lambda _k: None
    ann.set_cached = lambda _k, _v: None
    ann.type_colors = {}
    for af in ann.files.values():
        af.annotation_types = {}
    return state


def test_region_display_skips_files_tied_to_other_datasets():
    from services.annotations_endpoint import get_annotations_for_region_payload
    calls = []
    get_annotations_for_region_payload(_region_ready(State()), chrom="chr1", start=0, end=100, dataset_id="a",
                                       load_annotations=_recording_loader(calls))
    assert [path for path, _ in calls] == ["/shared.bb"]


def test_an_empty_working_set_means_no_reads_not_all_reads():
    from services.annotations_endpoint import filter_by_annotations_payload, get_annotations_for_region_payload
    calls = []
    req = SimpleNamespace(chrom="chr1", start=0, end=100, dataset_ids=["a"], sample_seed=None,
                          annotation_types=["x"], filter_mode="has")
    assert filter_by_annotations_payload(EmptyA(), req, load_annotations=_recording_loader(calls)) == {
        "read_ids": [], "total": 0, "filtered": 0, "by_dataset": {"a": {"read_ids": [], "total": 0, "filtered": 0}}}
    assert get_annotations_for_region_payload(_region_ready(EmptyA()), chrom="chr1", start=0, end=100, dataset_id="a",
                                              load_annotations=_recording_loader(calls)) == {"annotations": {}, "types": []}
    assert calls == []



class SharedName(State):
    """Datasets a and b both have a read named r, each with its own annotation file."""

    def __init__(self):
        super().__init__()
        self.annotation_state.files = {
            "fa": SimpleNamespace(id="fa", path="/only_a.bb", active=True, dataset_ids=["a"]),
            "fb": SimpleNamespace(id="fb", path="/only_b.bb", active=True, dataset_ids=["b"]),
        }

    def build_working_set(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        return WorkingSet([{"id": "r", "intervals": [[0, 10, 50]]}], 1, 1, chrom, start, end)


def _per_file_loader(path, chrom, start, end, confidence_thresholds=None, read_names=None):
    kind = "X" if path == "/only_a.bb" else "Y"
    return {"r": [(1, 5, kind, 1.0)]}, {}


def test_has_all_never_combines_two_datasets_molecules():
    from services.annotations_endpoint import filter_by_annotations_payload
    req = SimpleNamespace(chrom="chr1", start=0, end=100, dataset_ids=["a", "b"], sample_seed=None,
                          annotation_types=["X", "Y"], filter_mode="has_all")
    res = filter_by_annotations_payload(SharedName(), req, load_annotations=_per_file_loader)
    assert res["read_ids"] == [] and res["filtered"] == 0 and res["total"] == 2
    any_req = SimpleNamespace(**{**vars(req), "annotation_types": ["X"], "filter_mode": "has_any"})
    res = filter_by_annotations_payload(SharedName(), any_req, load_annotations=_per_file_loader)
    assert res["by_dataset"]["a"]["read_ids"] == ["r"] and res["by_dataset"]["b"]["read_ids"] == []


def test_clustering_keeps_two_datasets_molecules_apart():
    from services.annotations_endpoint import cluster_by_annotations_payload
    req = SimpleNamespace(chrom="chr1", start=0, end=100, dataset_ids=["a", "b"], peak_regions=[{"start": 0, "end": 10}],
                          annotation_types=["X", "Y"], method="combinatorial", k=2, sample_seed=None)
    res = cluster_by_annotations_payload(SharedName(), req, load_annotations=_per_file_loader)
    by = res["assignments_by_dataset"]
    assert set(by) == {"a", "b"}
    assert by["a"]["r"] != by["b"]["r"]  # patterns [1,0] and [0,1], not one merged [1,1]
    assert res["patterns"][by["a"]["r"]] == [1, 0] and res["patterns"][by["b"]["r"]] == [0, 1]
