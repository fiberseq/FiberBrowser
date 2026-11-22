"""engine="playwright" in the Mac app (clean-Mac audit, 3.1.1): it answered "node not found on PATH"; it now says
to use the default headless engine or the Export button."""
import sys


def test_the_app_points_to_the_headless_engine_and_export(client, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    res = client.post("/api/render", json={"engine": "playwright", "chrom": "chr1", "start": 0, "end": 1000})
    assert res.status_code == 501
    msg = res.json()["error"]
    assert "headless engine" in msg and "Export button" in msg and "source install" in msg
    assert "node not found" not in msg


def test_outside_the_app_the_engine_is_tried_as_before(client, monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    called = []
    import services.playwright_render as pr
    from fastapi.responses import JSONResponse
    monkeypatch.setattr(pr, "render_with_playwright", lambda req, state: called.append(1) or JSONResponse({"ok": True}))
    res = client.post("/api/render", json={"engine": "playwright", "chrom": "chr1", "start": 0, "end": 1000})
    assert called and res.status_code == 200


def test_render_figure_in_the_app_says_the_same(client, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    res = client.post("/api/render/figure", json={})
    assert res.status_code == 501 and "headless engine" in res.json()["error"] and "Export button" in res.json()["error"]
