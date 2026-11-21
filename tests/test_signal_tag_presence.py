"""The signal read filters are offered only for datasets carrying bg/me/db signal evidence.

The layer probe (diagnose_bam_tags, a record sample plus the header) reports ``has_signal_tags``; registration keeps
it on the dataset and the dataset payload sends it as ``signal_tags`` (the frontend's datasetsCarrySignal gate)."""
from array import array
import json
from pathlib import Path

import pysam
import pytest

from models.domain import Dataset
from services.bam_diagnostics import diagnose_bam_tags
from services.dataset_registration import configure_bam_dataset_layers

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "h1_chr1_insertion.bam"


def _bam(path, *, record_tags=None, comment=None, n=12):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 20000}]}
    if comment:
        header["CO"] = [comment]
    header = pysam.AlignmentHeader.from_dict(header)
    with pysam.AlignmentFile(path, "wb", header=header) as bam:
        for i in range(n):
            read = pysam.AlignedSegment(header)
            read.query_name = f"r{i}"
            read.reference_id = 0
            read.reference_start = 100 + 50 * i
            read.mapping_quality = 60
            read.cigarstring = "400M"
            read.query_sequence = "A" * 400
            read.set_tag("ns", array("i", [20, 200]))
            read.set_tag("nl", array("i", [140, 140]))
            for tag, value in (record_tags or {}).items():
                read.set_tag(tag, value, value_type="i" if isinstance(value, int) else "Z")
            bam.write(read)
    pysam.index(str(path))
    return str(path)


def _registered(path):
    dataset = Dataset("d", path, "d", data_type="bam")
    configure_bam_dataset_layers(dataset, path)
    return dataset.to_dict()


@pytest.mark.parametrize("tags", [
    {"bg": 0, "me": json.dumps({"schema": 5, "signal_status": "detectable"})},   # schema 5
    {"db": 1},                                                                  # legacy schema 4
    {"me": json.dumps({"schema": 3, "signal_class": "converted normally"})},    # schema 3 (me only)
])
def test_record_signal_tags_are_detected(tmp_path, tags):
    path = _bam(tmp_path / "tagged.bam", record_tags=tags)
    assert diagnose_bam_tags(path, limit=50)["has_signal_tags"] is True
    assert _registered(path)["signal_tags"] is True


def test_signal_tagger_header_comment_is_detected(tmp_path):
    path = _bam(tmp_path / "header.bam", comment="FIBERHMM-SIGNAL:v1:" + json.dumps({"tag_schema": 5}))
    assert diagnose_bam_tags(path, limit=50)["has_signal_tags"] is True
    assert _registered(path)["signal_tags"] is True


def test_untagged_bam_has_no_signal_tags(tmp_path):
    path = _bam(tmp_path / "plain.bam", comment="an unrelated comment")
    assert diagnose_bam_tags(path, limit=50)["has_signal_tags"] is False
    assert _registered(path)["signal_tags"] is False


def test_public_demo_bam_has_no_signal_tags():
    assert DEMO_BAM.exists()
    assert diagnose_bam_tags(str(DEMO_BAM), limit=50)["has_signal_tags"] is False
    assert _registered(str(DEMO_BAM))["signal_tags"] is False


def test_merged_datasets_carry_signal_tags_when_any_bam_does(tmp_path):
    plain = _bam(tmp_path / "plain.bam")
    tagged = _bam(tmp_path / "tagged.bam", record_tags={"bg": 1})
    dataset = Dataset("m", [plain, tagged], "m", data_type="bam")
    configure_bam_dataset_layers(dataset, plain)
    assert dataset.to_dict()["signal_tags"] is True


def test_a_dataset_never_probed_sends_false():
    assert Dataset("x", "/nonexistent.bam", "x", data_type="bam").to_dict()["signal_tags"] is False


@pytest.mark.parametrize("tagged", [False, True])
def test_headless_figures_apply_saved_signal_filters_only_with_tagged_datasets(tmp_path, monkeypatch, tagged):
    from types import SimpleNamespace
    import services.figure.compose as compose
    from services.signal_evidence import active_signal_filters
    path = _bam(tmp_path / "f.bam", record_tags={"bg": 1} if tagged else None)
    dataset = Dataset("f", path, "f", data_type="bam")
    configure_bam_dataset_layers(dataset, path)
    state = SimpleNamespace(datasets={"f": dataset})
    seen = {}
    monkeypatch.setattr(compose, "_render", lambda *a, **k: seen.setdefault("filters", active_signal_filters()) and b"")
    spec = SimpleNamespace(fe={"signalFilters": {"requireDetectable": True}, "activeColormap": {}})
    compose.render(spec, state)
    assert seen["filters"]["requireDetectable"] is tagged
