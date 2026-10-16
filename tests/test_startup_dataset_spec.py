"""--dataset PATH[:LABEL] parsing (absolute paths, Windows drives, URLs)."""
import pytest


@pytest.mark.parametrize("spec,expected", [
    ("/Users/x/data dir/a.bam:napa", ("/Users/x/data dir/a.bam", "napa")),
    ("/Users/x/a.bam", ("/Users/x/a.bam", None)),
    ("C:\\data\\a.bam", ("C:\\data\\a.bam", None)),
    ("C:\\data\\a.bam:lab", ("C:\\data\\a.bam", "lab")),
    ("https://h.org:8080/a.bam", ("https://h.org:8080/a.bam", None)),
    ("https://h.org/a.bam:lab", ("https://h.org/a.bam", "lab")),
    ("rel/a.bam:lab", ("rel/a.bam", "lab")),
])
def test_parse_dataset_spec(spec, expected):
    from services.startup_datasets import parse_dataset_spec
    assert parse_dataset_spec(spec) == expected


def test_label_with_a_slash_on_an_existing_file(tmp_path):
    from services.startup_datasets import parse_dataset_spec
    bam = tmp_path / "a.bam"
    bam.write_text("")
    assert parse_dataset_spec(f"{bam}:condition/replicate1") == (str(bam), "condition/replicate1")
