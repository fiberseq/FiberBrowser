"""A live-lift source view's BAM, opened as a native dataset, is marked with the live-lift dataset it belongs to
(lift_source_of): the page shows it only in its source view, so a reload without a session opens no empty panel for it.
The mark survives a saved session."""
from types import SimpleNamespace

from models.domain import Dataset
from models.requests import AddDatasetRequest
from services.dataset_endpoint import add_dataset_for_request


class _State:
    def __init__(self):
        self.datasets, self.dataset_order = {}, []

    def add_dataset(self, dataset_id, path_arg, label=None):
        ds = SimpleNamespace(id=dataset_id, paths=[path_arg], label=label, is_remote=False, data_type="bigbed")
        ds.to_dict = lambda: {"id": dataset_id, "lift_source_of": getattr(ds, "lift_source_of", None)}
        self.datasets[dataset_id] = ds
        self.dataset_order.append(dataset_id)
        return ds


def test_add_marks_a_source_view_dataset(tmp_path):
    f = tmp_path / "sample.bigBed"
    f.write_text("x")
    state = _State()
    out = add_dataset_for_request(state, AddDatasetRequest(path=str(f), label="A · MAT source", lift_source_of="lifted_a"))
    assert out["success"] and out["dataset"]["lift_source_of"] == "lifted_a"
    plain = add_dataset_for_request(state, AddDatasetRequest(path=str(f), label="A"))
    assert plain["dataset"]["lift_source_of"] is None


def test_dataset_dict_carries_the_mark_only_when_set():
    ds = Dataset("A", "A.bam", label="A")
    assert "lift_source_of" not in ds.to_dict()
    ds.lift_source_of = "lifted_a"
    assert ds.to_dict()["lift_source_of"] == "lifted_a"


def test_session_keeps_the_mark():
    from services import sessions_endpoint
    ds = Dataset("A", "A.bam", label="A")
    restored = Dataset("A", "A.bam", label="A")
    sessions_endpoint._restore_chemistry_override(restored, {"lift_source_of": "lifted_a"})
    assert restored.lift_source_of == "lifted_a"
    sessions_endpoint._restore_chemistry_override(ds, {})
    assert not getattr(ds, "lift_source_of", None)
