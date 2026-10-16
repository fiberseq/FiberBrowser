"""Request handling and layout guards for the headless renderer."""
import json
from types import SimpleNamespace

import pytest

from models.requests import RenderRequest
from services.figure import api
from services.figure.compose import _column_widths
from services.figure.spec import build_panels
from services.figure.tracks.axis import _circular_region_label
from services.figure.tracks.genes import _assign_rows


def test_legacy_only_options_keep_the_old_engine_unless_one_is_chosen():
    assert api.wants_legacy_engine(RenderRequest(chrom="c", start=0, end=10, sort_by="accessibility"))
    assert not api.wants_legacy_engine(RenderRequest(chrom="c", start=0, end=10, sort_by="x", engine="headless"))
    assert not api.wants_legacy_engine(RenderRequest(chrom="c", start=0, end=10, show_mods=True))


def _body(response):
    return response.status_code, json.loads(response.body)


def test_partial_region_and_public_session_path_are_refused(monkeypatch):
    status, body = _body(api.render_request(RenderRequest(chrom="chr1"), SimpleNamespace()))
    assert status == 400 and "together" in body["error"]
    monkeypatch.setattr(api, "_public_mode", lambda: True)
    status, body = _body(api.render_request(RenderRequest(session_path="/etc/passwd.json"), SimpleNamespace()))
    assert status == 403


def test_bad_scale_is_a_client_error():
    status, _ = _body(api.render_request(RenderRequest(chrom="c", start=0, end=10, scale=100), SimpleNamespace()))
    assert status == 400


def _state(*ids):
    return SimpleNamespace(datasets={i: {"id": i, "label": i, "available_layers": {"nuc": True}} for i in ids},
                           dataset_order=list(ids))


def test_requested_datasets_come_in_order_and_unloaded_ones_are_an_error():
    state = _state("a", "b")
    fe = {"panels": [{"id": "pa", "datasetId": "a", "subTracks": [{"type": "axis", "visible": True}]}]}
    panels = build_panels(state, dict(fe), dataset_ids=["b", "a"])
    assert [p.dataset_id for p in panels] == ["b", "a"]
    assert panels[1].id == "pa"  # the view's own panel is kept
    with pytest.raises(ValueError, match="not loaded"):
        build_panels(state, dict(fe), dataset_ids=["a", "zzz"])


def test_zero_width_fractions_fall_back_to_equal_columns():
    col = lambda f: [SimpleNamespace(width_fraction=f)]
    assert _column_widths([col(0), col(0)], 201) == [100.0, 100.0]


def test_circular_labels_wrap_at_the_origin():
    assert _circular_region_label("pUC", 4900, 5100, 5000, 200) == "pUC:4,900..100 (wrap)"
    assert _circular_region_label("pUC", 100, 900, 5000, 800) == "pUC:100-900 circular"


def test_reversed_view_packs_genes_like_the_forward_view():
    genes = [{"id": f"g{i}", "start": i * 1000, "end": i * 1000 + 300} for i in range(5)]
    forward = lambda pos: pos / 10
    reverse = lambda pos: 500 - pos / 10
    assert _assign_rows(genes, forward)[1] == 1
    assert _assign_rows(genes, reverse)[1] == 1


def test_signal_and_coverage_tracks_use_the_legacy_engine_or_are_refused_by_name():
    asked = RenderRequest(chrom="c", start=0, end=10, tracks=["axis", "signal", "coverage"])
    assert api.wants_legacy_engine(asked)
    assert not api.wants_legacy_engine(RenderRequest(chrom="c", start=0, end=10, tracks=["axis", "reads"]))
    headless = RenderRequest(chrom="c", start=0, end=10, tracks=["axis", "signal"], engine="headless")
    assert not api.wants_legacy_engine(headless)
    status, body = _body(api.render_request(headless, SimpleNamespace()))
    assert status == 400 and "signal" in body["error"]
