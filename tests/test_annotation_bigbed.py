"""Regression tests for annotation BigBed helpers."""

from services import annotation_bigbed
from services.annotation_profiles import build_annotation_profiles


class FakeBigBed:
    def chroms(self):
        return {"chr2L": 1000}

    def entries(self, chrom, start, end):
        assert chrom == "chr2L"
        return [
            (10, 20, "readA\t0\t+\ttf\t0.9"),
            (22, 30, "readB\t0\t+\ttf\t0.2"),
            (30, 40, "readB\t0\t+\tnuc\tbad"),
            (45, 55, "readC\t0\t+\ttf\t0.95"),
            (60, 65, "malformed"),
        ]


def test_manifest_and_annotation_file_detection(tmp_path, monkeypatch):
    annotation_path = tmp_path / "sample.annotations.bb"
    annotation_path.write_text("")

    assert annotation_bigbed.is_annotation_bigbed(str(annotation_path))

    manifest_backed = tmp_path / "sample.bb"
    manifest_backed.write_text("")
    (tmp_path / "sample_manifest.json").write_text('{"types": {"tf": {}}}')

    assert annotation_bigbed.load_annotation_manifest(str(manifest_backed)) == {"types": {"tf": {}}}
    assert annotation_bigbed.is_annotation_bigbed(str(manifest_backed))

    monkeypatch.setattr(annotation_bigbed, "get_bigbed_handle", lambda path: None)
    assert not annotation_bigbed.is_annotation_bigbed(str(tmp_path / "other.bb"))


def test_find_annotation_bigbed_files_skips_primary(tmp_path):
    primary = tmp_path / "sample.footprint.bb"
    primary.write_text("")
    annotation = tmp_path / "sample.annotations.bb"
    annotation.write_text("")
    non_annotation = tmp_path / "sample.msp.bb"
    non_annotation.write_text("")

    assert annotation_bigbed.find_annotation_bigbed_files(str(primary)) == [str(annotation)]


def test_load_annotations_from_bigbed_filters_by_confidence_and_read_names(monkeypatch):
    monkeypatch.setattr(annotation_bigbed, "get_bigbed_handle", lambda path: FakeBigBed())

    annotations, types = annotation_bigbed.load_annotations_from_bigbed(
        "fake.bb",
        "2L",
        5,
        60,
        confidence_thresholds={"tf": 0.8},
        read_names={"readA", "readB"},
    )
    expected = {
        "readA": [(10, 20, "tf", 0.9)],
        "readB": [(30, 40, "nuc", 1.0)],
    }
    assert annotations == expected
    assert types == {"tf", "nuc"}


def test_annotation_bigbed_diagnostics_are_opt_in(monkeypatch, capsys):
    monkeypatch.delenv(annotation_bigbed.ANNOTATION_DIAGNOSTICS_ENV, raising=False)
    annotation_bigbed.log_annotation_diagnostic("hidden")
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(annotation_bigbed.ANNOTATION_DIAGNOSTICS_ENV, "1")
    annotation_bigbed.log_annotation_diagnostic("visible")
    assert capsys.readouterr().out == "visible\n"


def test_discover_annotation_types_and_join_reads(monkeypatch):
    monkeypatch.setattr(annotation_bigbed, "get_bigbed_handle", lambda path: FakeBigBed())

    assert annotation_bigbed.discover_annotation_types("fake.bb", sample_size=3) == {"tf": 2, "nuc": 1}

    reads = [{"id": "readA_1"}, {"id": "readB"}]
    annotation_dict = {
        "readA": [(100, 110, "tf", 0.7)],
        "readB": [(120, 135, "nuc", 1.0)],
    }
    expected = {
        "readA_1": [{"start": 0, "end": 10, "type": "tf", "confidence": 0.7}],
        "readB": [{"start": 20, "end": 35, "type": "nuc", "confidence": 1.0}],
    }

    assert annotation_bigbed.join_annotations_to_reads(reads, annotation_dict, 100) == expected


def test_build_annotation_profiles_bins_confidence_values_by_type():
    profiles = build_annotation_profiles(
        [
            {
                "readA": [(100, 149, "tf", 0.5), (150, 199, "tf", 1.0)],
                "readB": [(125, 175, "nuc", 0.25)],
            },
            {
                "readC": [(100, 199, "tf", 0.5)],
            },
        ],
        start=100,
        end=200,
        bins=4,
    )

    assert profiles["tf"] == [1.0, 1.0, 1.5, 1.5]
    # Half-open [125, 175): bins [125,150) and [150,175) only.
    assert profiles["nuc"] == [0.0, 0.25, 0.25, 0.0]


def test_build_annotation_profiles_filters_annotation_types():
    profiles = build_annotation_profiles(
        [{"readA": [(100, 150, "tf", 1.0), (100, 150, "nuc", 1.0)]}],
        start=100,
        end=200,
        bins=2,
        annotation_types=["tf"],
    )

    # Half-open [100, 150): only the first 50-bp bin.
    assert profiles == {"tf": [1.0, 0.0]}
