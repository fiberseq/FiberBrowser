from services.startup_datasets import (
    add_cli_datasets,
    default_dataset_label,
    parse_dataset_spec,
    resolve_primary_data_source,
)


class DummyState:
    def __init__(self):
        self.added = []

    def add_dataset(self, dataset_id, path, label):
        self.added.append((dataset_id, path, label))


def test_resolve_primary_data_source_splits_comma_separated_bam():
    assert resolve_primary_data_source("a.bam, b.bam", None) == ["a.bam", "b.bam"]
    assert resolve_primary_data_source(None, "/bigbeds") == "/bigbeds"


def test_parse_dataset_spec_splits_labels_on_absolute_paths(tmp_path):
    assert parse_dataset_spec("relative.bam:Rel") == ("relative.bam", "Rel")
    # Absolute paths take a label too (they used to load nothing, silently).
    assert parse_dataset_spec("/abs/path.bam:Abs") == ("/abs/path.bam", "Abs")
    # A file whose name really contains ':' is still taken whole.
    odd = tmp_path / "odd.bam:name"
    odd.write_text("")
    assert parse_dataset_spec(str(odd)) == (str(odd), None)


def test_default_dataset_label_strips_known_extensions():
    assert default_dataset_label("/tmp/example.bam") == "example"
    assert default_dataset_label("/tmp/example.bigBed") == "example"
    assert default_dataset_label("/tmp/folder") == "folder"


def test_add_cli_datasets_assigns_stable_labels():
    state = DummyState()

    add_cli_datasets(state, ["relative.bam:Rel", "plain.bigbed"])

    assert state.added[0][1:] == ("relative.bam", "Rel")
    assert state.added[1][1:] == ("plain.bigbed", "plain")
