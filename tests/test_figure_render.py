"""/api/render/figure: browser-identical figures from the live view or a session.

The unit tests build the worker envelope without Chromium. The end-to-end test
is gated like tests/test_playwright_render.py (FIBERBROWSER_RUN_PLAYWRIGHT_RENDER=1).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from models.requests import FigureRequest, LiveFigureState
from services.figure_render import (
    FigureError,
    build_figure_envelope,
    live_state_summary,
    parse_region,
    store_live_state,
)


def _dataset(ds_id):
    return SimpleNamespace(
        id=ds_id, label=ds_id.upper(), paths=[f"/data/{ds_id}.bam"], color="#123456",
        data_type="bam", layer_type=None, available_layers={}, derived_layers={},
    )


def _state(*ids):
    return SimpleNamespace(
        datasets={ds_id: _dataset(ds_id) for ds_id in ids},
        dataset_order=list(ids),
        modification_overlays={},
        gtf_data=None, fasta=None, fasta_path=None, current_genome="hg38",
        chroms=[SimpleNamespace(name="chr1", size=1000)], circular_chroms={},
        orthogonal_tracks=[],
    )


def _push_live(state, **viewport):
    store_live_state(state, LiveFigureState(
        viewport={"chrom": "chr1", "start": 100, "end": 900, **viewport},
        frontend_state={"readRowHeight": 3, "panels": [{"id": "p1"}]},
        layout={"width": 1234, "height": 777},
    ))


def test_current_view_carries_the_browser_state_and_track_size():
    state = _state("a", "b")
    _push_live(state)
    envelope = build_figure_envelope(FigureRequest(), state)

    assert envelope["viewport"] == {"width": 1234, "height": 777}
    result = envelope["figure"]["importResult"]
    assert result["viewport"] == {"chrom": "chr1", "start": 100, "end": 900}
    assert result["frontend"]["readRowHeight"] == 3
    assert [ds["id"] for ds in result["datasets"]] == ["a", "b"]
    assert envelope["figure"]["baseState"]["chroms"] == [{"name": "chr1", "size": 1000, "circular": False}]
    assert envelope["figure"]["export"]["format"] == "png"
    assert envelope["figure"]["export"]["includeTitle"] is False


def test_region_and_size_override_the_live_view():
    state = _state("a")
    _push_live(state)
    envelope = build_figure_envelope(
        FigureRequest(region="chr2:1,000-5,000", width=900, format="svg", scale=4), state)
    assert envelope["figure"]["importResult"]["viewport"] == {"chrom": "chr2", "start": 1000, "end": 5000}
    assert envelope["viewport"]["width"] == 900
    assert envelope["figure"]["export"] == {**envelope["figure"]["export"], "format": "svg", "scale": 4.0}


def test_no_view_or_bad_input_is_a_clear_error():
    state = _state("a")
    with pytest.raises(FigureError) as missing:
        build_figure_envelope(FigureRequest(), state)
    assert missing.value.status == 409

    _push_live(state)
    for bad in (FigureRequest(region="chr1:5-1"), FigureRequest(region="nonsense"),
                FigureRequest(width=50), FigureRequest(scale=20)):
        with pytest.raises(FigureError):
            build_figure_envelope(bad, state)
    with pytest.raises(FigureError):
        build_figure_envelope(FigureRequest(), _state())


def test_session_source_uses_its_view_and_names_missing_datasets(tmp_path):
    state = _state("a")
    session = {"datasets": [{"id": "a"}], "viewport": {"chrom": "chr1", "start": 10, "end": 20},
               "frontend": {"readRowHeight": 5}}
    path = tmp_path / "s.json"
    path.write_text(json.dumps(session))
    envelope = build_figure_envelope(FigureRequest(session_path=str(path)), state)
    assert envelope["figure"]["importResult"]["viewport"]["end"] == 20
    assert envelope["figure"]["importResult"]["frontend"] == {"readRowHeight": 5}

    with pytest.raises(FigureError) as missing:
        build_figure_envelope(FigureRequest(session={**session, "datasets": [{"id": "gone"}]}), state)
    assert missing.value.status == 409
    assert missing.value.extra["missing_datasets"] == ["gone"]


def test_session_path_must_be_a_json_session_file(tmp_path):
    with pytest.raises(FigureError):
        build_figure_envelope(FigureRequest(session_path=str(tmp_path / "id_rsa")), _state("a"))


def test_live_state_summary_hides_the_frontend_state_unless_asked():
    state = _state("a")
    assert live_state_summary(state) == {"available": False}
    _push_live(state)
    assert "frontend_state" not in live_state_summary(state)
    assert live_state_summary(state, full=True)["frontend_state"]["readRowHeight"] == 3


def test_parse_region_accepts_commas():
    assert parse_region(" chrX:47,193,000-47,196,000 ") == ("chrX", 47193000, 47196000)


# ── End to end (Chromium) ─────────────────────────────────────────────────

GATE_ENV = "FIBERBROWSER_RUN_PLAYWRIGHT_RENDER"


@pytest.fixture(scope="module")
def figure_server():
    from test_playwright_render import _gate_skip, _free_port, _spawn_server, _stop_server
    _gate_skip()
    port = _free_port()
    proc = _spawn_server(port)
    yield f"http://127.0.0.1:{port}"
    _stop_server(proc)


def test_live_view_renders_as_png_svg_and_pdf(figure_server, tmp_path):
    from test_playwright_render import REPO_ROOT, SERVER_TOKEN, TEST_REGION, _http

    # Open the real app so it reports its view, as a user's tab would.
    # ESM resolves `playwright` from the script's folder, so run it from frontend/.
    script = REPO_ROOT / "browser" / "frontend" / f".figure-test-{os.getpid()}.mjs"
    region = f"{TEST_REGION['chrom']}:{TEST_REGION['start']}-{TEST_REGION['end']}"
    script.write_text(
        "import { chromium } from 'playwright';\n"
        "const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1400,height:900}});\n"
        # No start-up genome auto-load: without a reference the page would download hg38 into ~/.fiberhmm/genomes
        # (from the test's HOME) for the seconds it is open.
        "await p.addInitScript(() => { window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true; });\n"
        # The access link, as the launchers open it (the token sets the page's cookie).
        f"await p.goto('{figure_server}/?token={SERVER_TOKEN}');\n"
        "await p.waitForFunction(() => document.querySelectorAll('canvas').length > 0, undefined, {timeout: 30000});\n"
        "await p.waitForTimeout(3000); await b.close();\n"
    )
    try:
        subprocess.run([shutil.which("node"), str(script)], cwd=REPO_ROOT / "browser" / "frontend",
                       check=True, timeout=90)
    finally:
        script.unlink(missing_ok=True)
    assert _http.get(f"{figure_server}/api/render/live_state", timeout=10).json()["available"]

    magic = {"png": b"\x89PNG", "svg": b"<svg", "pdf": b"%PDF"}
    for fmt, prefix in magic.items():
        r = _http.post(f"{figure_server}/api/render/figure",
                          json={"format": fmt, "region": region, "scale": 1, "timeout_ms": 60000}, timeout=180)
        assert r.status_code == 200, r.text[:300]
        assert prefix in r.content[:200]
        assert int(r.headers["X-Figure-Width"]) > 200


def test_orthogonal_track_dicts_are_read_by_key_not_attribute():
    # A dict has a .values method; it must not shadow the 'values' key.
    from services.playwright_render import _orthogonal_tracks_for_render
    state = SimpleNamespace(orthogonal_tracks=[{"label": "CTCF", "path": "motif://jaspar/MA0139.2", "format": "custom_motif"}])
    tracks = _orthogonal_tracks_for_render(state)
    assert tracks[0]["values"] == [] and tracks[0]["label"] == "CTCF"
    json.dumps(tracks)


def test_a_session_naming_other_files_under_a_loaded_id_is_not_rendered_silently():
    state = _state("a")
    same = {"datasets": [{"id": "a", "paths": ["/data/a.bam"]}], "viewport": {"chrom": "chr1", "start": 10, "end": 20}}
    assert build_figure_envelope(FigureRequest(session=same), state)["figure"]["importResult"]["viewport"]["end"] == 20
    other = {**same, "datasets": [{"id": "a", "paths": ["/experiment-B/a.bam"]}]}
    with pytest.raises(FigureError) as different:
        build_figure_envelope(FigureRequest(session=other), state)
    assert different.value.status == 409
    assert different.value.extra["missing_datasets"] == ["a"]
    assert "different files" in str(different.value)


def test_numpy_render_draws_signal_tracks():
    from models.requests import RenderRequest
    from services.render_endpoint import _render_sync
    calls = []
    state = SimpleNamespace(
        orthogonal_tracks=[{"label": "Sig", "path": "/x.bw"}], datasets={}, dataset_order=[],
        translate_chrom=lambda c: c, resolve_dataset_id=lambda d=None: None,
        get_track_data=lambda idx, chrom, start, end, bins=500: calls.append(idx) or [1.0] * bins,
    )
    response = _render_sync(RenderRequest(chrom="chr1", start=0, end=1000, tracks=["signal"], width=400), state)
    assert calls == [0]
    assert "Sig" in response.headers.get("X-Tracks", "") or "signal" in response.headers.get("X-Tracks", "")


def test_the_render_worker_page_carries_the_access_token(monkeypatch):
    """Figure export with the token on (the default): the worker must open the
    page with ?token=, like playwright_render does, or /api/render/figure 502s."""
    import base64 as _b64
    import services.playwright_render as pr
    from services import local_auth
    from services.figure_render import render_figure

    seen = {}

    class FakeWorker:
        def submit(self, envelope, timeout_s):
            seen["url"] = envelope["url"]
            return {"ok": True, "figure_b64": _b64.b64encode(b"png").decode(), "width": 1, "height": 1}

    monkeypatch.setattr(pr, "_WORKER", FakeWorker())
    monkeypatch.setattr(local_auth, "_enabled", True)
    monkeypatch.setattr(local_auth, "_token", "tok-123")
    state = _state("a")
    _push_live(state)
    response = render_figure(FigureRequest(show_nudges=True), state)
    assert response.status_code == 200
    assert "token=tok-123" in seen["url"] and "nudges=1" in seen["url"]
