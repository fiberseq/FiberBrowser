from types import SimpleNamespace

from services import overlays_endpoint
from services.overlays_endpoint import (
    add_overlay_for_request,
    get_overlay_marks_payload,
    get_overlays_payload,
    remove_overlay_for_request,
)


def test_overlay_list_add_and_remove_helpers(tmp_path):
    state = SimpleNamespace(modification_overlays={})
    path = tmp_path / "sample_m6a.bb"
    path.write_text("bb")

    assert add_overlay_for_request(state, {}) == {"success": False, "error": "No path provided"}
    missing = add_overlay_for_request(state, {"path": str(tmp_path / "missing.bb")})
    assert missing["success"] is False
    assert "File not found or not readable" in missing["error"]
    assert str(tmp_path / "missing.bb") in missing["error"]

    added = add_overlay_for_request(state, {"path": str(path)})

    assert added["success"] is True
    assert added["overlay"]["id"] == "overlay_0"
    assert added["overlay"]["type"] == "m6a"
    assert added["overlay"]["label"] == "sample_m6a (m6A)"
    assert get_overlays_payload(state)["overlays"] == [added["overlay"]]
    assert remove_overlay_for_request(state, "overlay_0") == {"success": True}
    assert remove_overlay_for_request(state, "overlay_0") == {
        "success": False,
        "error": "Overlay not found",
    }


def test_adding_after_a_removal_never_overwrites_an_overlay(tmp_path):
    state = SimpleNamespace(modification_overlays={})
    paths = []
    for name in ("a_m6a.bb", "b_m6a.bb", "c_m6a.bb"):
        p = tmp_path / name
        p.write_text("bb")
        paths.append(str(p))
    a = add_overlay_for_request(state, {"path": paths[0]})["overlay"]["id"]
    b = add_overlay_for_request(state, {"path": paths[1]})["overlay"]["id"]
    remove_overlay_for_request(state, a)
    c = add_overlay_for_request(state, {"path": paths[2]})["overlay"]["id"]
    assert c != b
    assert state.modification_overlays[b]["path"] == paths[1]


class _FakeBigBed:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def chroms(self):
        return {"chr2L": 1000}

    def entries(self, chrom, start, end):
        assert chrom == "chr2L"
        assert (start, end) == (100, 120)
        return [
            (100, 105, "read1\t0\t.\t100\t105\t0\t2\t1,2,\t0,3,"),
            (110, 111, "malformed"),
        ]


def test_overlay_marks_payload_reads_single_bigbed(monkeypatch):
    state = SimpleNamespace(modification_overlays={
        "ov1": {"path": "/data/marks.bb", "label": "marks", "type": "m6a", "color": "#f00"}
    })
    monkeypatch.setattr(overlays_endpoint.pyBigWig, "open", lambda path: _FakeBigBed())

    assert get_overlay_marks_payload(state, "missing", "chr2L", 100, 120) == {"marks": {}}
    assert get_overlay_marks_payload(state, "ov1", "chr2L", 100, 120) == {
        "marks": {"read1": [0, 3, 4]}
    }


def test_overlay_marks_payload_reads_bigbed_directory(monkeypatch, tmp_path):
    (tmp_path / "a.bb").write_text("bb")
    (tmp_path / "ignore.txt").write_text("no")
    state = SimpleNamespace(modification_overlays={
        "ov1": {"path": str(tmp_path), "label": "marks", "type": "m6a", "color": "#f00"}
    })
    opened = []

    def fake_open(path):
        opened.append(path)
        return _FakeBigBed()

    monkeypatch.setattr(overlays_endpoint.pyBigWig, "open", fake_open)

    result = get_overlay_marks_payload(state, "ov1", "chr2L", 100, 120)

    assert result == {"marks": {"read1": [0, 3, 4]}}
    assert opened == [str(tmp_path / "a.bb")]
