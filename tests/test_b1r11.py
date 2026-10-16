"""B1 round 11: merged-sample BigBeds, annotation file identity, linked-read
internal gaps, MA/AQ frame detection without FiberHMM."""
import sys
from types import SimpleNamespace

from services import compact_read_loader
from services.dataset_registration import register_dataset_annotation_bigbed
from services.linked_read_compact import _segment_intervals
from test_compact_read_loader import FakeBigBed, bed12_rest


def _merged(paths, handles, types):
    return compact_read_loader.build_compact_reads_from_bigbed(
        paths, "2L", 100, 900, spanning_only=False,
        include_layers=True, requested_layers=["tf", "nuc"],
        bigbed_handle_getter=lambda p: handles[p],
        overlay_type_detector=lambda p: types[p],
        format_cache={},
    )


def test_two_samples_sharing_a_read_name_stay_two_molecules():
    handles = {
        "/a/sampleA.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [100], [0]))]}),
        "/b/sampleB.bb": FakeBigBed({"chr2L": [(500, 800, bed12_rest("r", [100], [100]))]}),
        "/a/sampleA_tf.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [20], [150]))]}),
    }
    types = {"/a/sampleA.bb": "footprint", "/b/sampleB.bb": "footprint", "/a/sampleA_tf.bb": "tf"}
    reads = _merged(["/a/sampleA_tf.bb", "/a/sampleA.bb", "/b/sampleB.bb"], handles, types)
    assert len(reads) == 2
    fps = sorted(tuple(iv[:2]) for read in reads for iv in read["intervals"] if iv[2] > 0)
    assert fps == [(0, 100), (500, 600)]
    # The TF companion joins sample A's molecule only.
    with_tf = [read for read in reads if "tf" in (read.get("layers") or {})]
    assert len(with_tf) == 1
    assert [iv[:2] for iv in with_tf[0]["intervals"] if iv[2] > 0] == [[0, 100]]
    assert with_tf[0]["layers"]["tf"]["intervals"] == [[150, 170, 20]]


def test_one_sample_with_companions_still_merges_by_read_name():
    handles = {
        "/a/s.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [100], [0]))]}),
        "/a/other_name_tf.bb": FakeBigBed({"chr2L": [(100, 300, bed12_rest("r", [20], [150]))]}),
    }
    types = {"/a/s.bb": "footprint", "/a/other_name_tf.bb": "tf"}
    reads = _merged(["/a/s.bb", "/a/other_name_tf.bb"], handles, types)
    assert len(reads) == 1 and "tf" in reads[0]["layers"]


def test_sample_keys_strip_layer_suffixes():
    key = compact_read_loader.bigbed_sample_key
    assert key("/x/s_footprint.bb") == key("/x/s_tf.bb") == key("/x/s.m6a.bb") == key("/x/s.bb")
    assert key("/x/s.bb") != key("/y/s.bb")


def test_annotation_files_with_the_same_name_in_two_folders_are_two_files(tmp_path):
    a = tmp_path / "sampleA" / "calls.annotations.bb"
    b = tmp_path / "sampleB" / "calls.annotations.bb"
    for path in (a, b):
        path.parent.mkdir()
        path.write_bytes(b"")
    state = SimpleNamespace(annotation_state=SimpleNamespace(files={}))
    fa = register_dataset_annotation_bigbed(state, "A", str(a))
    fb = register_dataset_annotation_bigbed(state, "B", str(b))
    assert fa is not fb
    assert fa.path == str(a) and fa.dataset_ids == ["A"]
    assert fb.path == str(b) and fb.dataset_ids == ["B"]
    assert len(state.annotation_state.files) == 2
    # The same file found again is only associated.
    again = register_dataset_annotation_bigbed(state, "C", str(a))
    assert again is fa and fa.dataset_ids == ["A", "C"]
    assert len(state.annotation_state.files) == 2


def test_linked_segment_window_inside_an_internal_gap_keeps_the_gap():
    seg = {"start": 0, "end": 1000, "blockSizes": "100,100", "blockStarts": "100,800"}
    intervals = _segment_intervals([seg], 300, 400, hide_terminal_gaps=True)
    assert intervals == [[0, 400, -600]]


def test_ma_aq_frame_detection_without_fiberhmm(monkeypatch):
    from services import bam_tags
    monkeypatch.setitem(sys.modules, "fiberhmm", None)
    monkeypatch.setitem(sys.modules, "fiberhmm.io", None)
    monkeypatch.setitem(sys.modules, "fiberhmm.io.annotation_frame", None)
    molecular = {"PG": [{"ID": "fiberhmm", "CL": "fiberhmm call coord=molecular"}]}
    assert bam_tags.bam_ma_aq_tags_are_molecular(molecular) is True
    assert bam_tags.bam_ma_aq_tags_are_molecular({"CO": ["coord=MOLECULAR"]}) is True
    assert bam_tags.bam_ma_aq_tags_are_molecular({"PG": [{"ID": "x"}]}) is False
