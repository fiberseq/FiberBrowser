"""Scripted-figure options of the headless engine: figure() pass-through, per-dataset caps, seeds, hidden rows."""
from __future__ import annotations

import base64
import copy
import json
import re
import zlib

import pytest

import headless_figure_data as hfd


@pytest.fixture(scope="module")
def paths(tmp_path_factory):
    return hfd.write_datasets(tmp_path_factory.mktemp("headless-options"))


@pytest.fixture
def state():
    import server as srv
    from realpath_helpers import state_client
    with state_client(srv.app, {}) as (_client, st):
        yield st


def render(state, session, fmt="pdf", **fields):
    """(figure bytes, manifest) for ``session`` rendered in-process like BrowserClient.figure()."""
    from models.requests import RenderRequest
    from services.figure import api
    req = RenderRequest(session=session, load_session=True, source="session", format=fmt, scale=2.0,
                        engine="headless", manifest=True, manifest_read_ids=True, **fields)
    resp = api.render_request(req, state, None)
    reply = json.loads(resp.body)
    assert resp.status_code == 200, reply
    return base64.b64decode(reply["figure_b64"]), reply["manifest"]


def render_error(state, session, **fields):
    from models.requests import RenderRequest
    from services.figure import api
    resp = api.render_request(RenderRequest(session=session, load_session=True, source="session", format="pdf",
                                            engine="headless", **fields), state, None)
    assert resp.status_code == 400
    return json.loads(resp.body)["error"]


def pdf_text(data: bytes) -> str:
    m = re.search(rb"/Filter /FlateDecode /Length (\d+) >>\nstream\n", data)
    chunks = []
    for m in re.finditer(rb"<< /Filter /FlateDecode /Length (\d+) >>\nstream\n", data):
        chunks.append(zlib.decompress(data[m.end():m.end() + int(m.group(1))]).decode("latin-1"))
    assert m is not None
    return "\n".join(chunks)


def by_dataset(manifest):
    return {p["dataset_id"]: p for p in manifest["panels"]}


# -- figure() pass-through ---------------------------------------------------------------------------------

class _Recorder:
    def __init__(self):
        self.bodies = []

    def post(self, url, json=None, timeout=None):
        self.bodies.append(json)

        class R:
            status_code = 200
            headers = {"content-type": "application/pdf"}
            content = b"%PDF-1.4"
        return R()


def _client():
    from browser_client import BrowserClient
    client = BrowserClient.__new__(BrowserClient)
    client.url = "http://127.0.0.1:1"
    recorder = _Recorder()
    client._http_session = lambda: recorder
    return client, recorder


def test_figure_sends_no_new_field_unless_asked():
    client, rec = _client()
    client.figure(session={"datasets": []}, load_session=True, format="pdf", scale=4)
    assert rec.bodies[-1] == {"format": "pdf", "scale": 4.0, "engine": "headless", "source": "session",
                              "load_session": True, "session": {"datasets": []}}


def test_figure_forwards_spanning_seed_caps_and_hidden_rows():
    client, rec = _client()
    client.figure(session={}, spanning_only=False, sample_seed="s1", max_reads={"ds-a": 10},
                  hide_tracks="sv, coverage", page_size="180x120mm", min_font_pt=6, raster_dpi=600,
                  pdf_fonts="truetype")
    body = rec.bodies[-1]
    assert body["spanning_only"] is False and body["sample_seed"] == "s1"
    assert body["max_reads_by_dataset"] == {"ds-a": 10} and "max_reads" not in body
    assert body["hide_tracks"] == ["sv", "coverage"]
    assert (body["page_size"], body["min_font_pt"], body["raster_dpi"], body["pdf_fonts"]) == ("180x120mm", 6, 600, "truetype")
    client.figure(session={}, max_reads=25)
    assert rec.bodies[-1]["max_reads"] == 25 and "max_reads_by_dataset" not in rec.bodies[-1]


def test_browser_engine_refuses_headless_only_options():
    client, _rec = _client()
    with pytest.raises(ValueError, match="sample_seed"):
        client.figure(engine="browser", sample_seed="x")


# -- seeds, caps, spanning ---------------------------------------------------------------------------------

def test_same_seed_draws_the_same_reads_and_another_seed_differs(state, paths):
    session = hfd.session(paths)
    _a, first = render(state, session, max_reads=20, sample_seed="seed-1")
    _b, again = render(state, copy.deepcopy(session), max_reads=20, sample_seed="seed-1")
    _c, other = render(state, copy.deepcopy(session), max_reads=20, sample_seed="seed-2")
    for ds_id in ("ds-a", "ds-b"):
        ids1, ids1b, ids2 = (by_dataset(m)[ds_id]["read_ids"] for m in (first, again, other))
        assert len(ids1) == 20 and ids1 == ids1b
        assert set(ids1) != set(ids2)
    assert first["sample_seed"] == "seed-1" and _a == _b


def test_the_session_block_sets_the_seed_and_the_request_wins(state, paths):
    session = hfd.session(paths)
    session["headless_figure"] = {"sample_seed": "seed-1", "max_reads": 20}
    _x, from_block = render(state, session)
    _y, from_request = render(state, hfd.session(paths), max_reads=20, sample_seed="seed-1")
    assert by_dataset(from_block)["ds-b"]["read_ids"] == by_dataset(from_request)["ds-b"]["read_ids"]
    _z, overridden = render(state, copy.deepcopy(session), sample_seed="seed-2")
    assert overridden["sample_seed"] == "seed-2"


def test_per_dataset_caps(state, paths):
    _pdf, manifest = render(state, hfd.session(paths), max_reads_by_dataset={"ds-a": 10, "Sample B": 15})
    counts = {k: v["reads_drawn"] for k, v in by_dataset(manifest).items()}
    assert counts == {"ds-a": 10, "ds-b": 15}
    assert "no panel for nope" in render_error(state, hfd.session(paths), max_reads_by_dataset={"nope": 3})


def test_spanning_only_drops_reads_that_do_not_span_the_view(state, paths):
    partial = sum(1 for k in range(60) if k % 7 == 6)
    _pdf, everything = render(state, hfd.session(paths))
    _pdf, spanning = render(state, hfd.session(paths), spanning_only=True)
    assert by_dataset(everything)["ds-b"]["reads_drawn"] == 60
    assert by_dataset(spanning)["ds-b"]["reads_drawn"] == 60 - partial


# -- hidden rows ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("sv_row", [False, True])
def test_hide_sv_removes_the_strip_from_old_and_new_sessions(state, paths, sv_row):
    shown, m_shown = render(state, hfd.session(paths, sv_row=sv_row))
    hidden, m_hidden = render(state, hfd.session(paths, sv_row=sv_row), hide_tracks=["sv"])
    assert "(6/60)" in pdf_text(shown) and "(SV" in pdf_text(shown)
    assert "(6/60)" not in pdf_text(hidden) and "(SV" not in pdf_text(hidden)
    assert m_shown["page"]["height_px"] - m_hidden["page"]["height_px"] == pytest.approx(2 * 44)
    # Reads keep their per-read SV marks (hide "sv_marks" for those).
    assert by_dataset(m_hidden)["ds-a"]["reads_drawn"] == 60


def test_hide_from_the_session_block_matches_the_request(state, paths):
    session = hfd.session(paths)
    session["headless_figure"] = {"hide_tracks": ["sv", "header"]}
    from_block, _m = render(state, session)
    from_request, _m2 = render(state, hfd.session(paths), hide_tracks=["sv", "header"])
    assert from_block == from_request
    assert "(Sample A)" not in pdf_text(from_block)


def test_hide_names_and_session_block_keys_are_checked(state, paths):
    assert "unknown track" in render_error(state, hfd.session(paths), hide_tracks=["svv"])
    session = hfd.session(paths)
    session["headless_figure"] = {"seed": 3}
    assert "unknown option" in render_error(state, session)
