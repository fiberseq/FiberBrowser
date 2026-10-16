from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def clear_linked_sessions():
    import server as srv

    old_sessions = dict(srv.dafc_state.linked_sessions)
    srv.dafc_state.linked_sessions.clear()
    try:
        yield
    finally:
        srv.dafc_state.linked_sessions.clear()
        srv.dafc_state.linked_sessions.update(old_sessions)


def _region_payload(**overrides):
    payload = {
        "chrom": "chr2L",
        "x_start": 100,
        "x_end": 200,
        "y_start": 500,
        "y_end": 600,
    }
    payload.update(overrides)
    return payload


def test_linked_session_create_returns_mode_summary(client):
    resp = client.post("/api/linked/session/create")

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["success"] is True
    assert payload["session_id"]
    assert payload["session"]["id"] == payload["session_id"]
    assert payload["session"]["split_view_mode"] == "unassigned"
    assert payload["session"]["contact_mode"] is None
    assert payload["session"]["has_regions"] is False
    assert payload["session"]["has_reads"] is False


def test_region_independent_session_stores_regions_without_linked_reads(client):
    session_id = client.post("/api/linked/session/create").json()["session_id"]

    sent = client.post(f"/api/linked/session/{session_id}/send", json={
        "regions": _region_payload(),
        "contact_mode": "microc",
        "split_view_mode": "region_independent",
    })
    assert sent.status_code == 200
    assert sent.json()["split_view_mode"] == "region_independent"
    assert sent.json()["contact_mode"] == "microc"
    assert sent.json()["n_reads"] == 0

    session = client.get(f"/api/linked/session/{session_id}").json()
    assert session["split_view_mode"] == "region_independent"
    assert session["contact_mode"] == "microc"
    assert session["has_regions"] is True
    assert session["has_reads"] is False
    assert session["read_order"] == []

    sessions = client.get("/api/linked/sessions").json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["id"] == session_id
    assert sessions[0]["split_view_mode"] == "region_independent"

    data = client.get(f"/api/linked/reads/data?session_id={session_id}").json()
    assert data["split_view_mode"] == "region_independent"
    assert data["split_view_semantics"]["analysis_scope"] == "viewport"

    image = client.get(f"/api/linked/reads/image?session_id={session_id}&region=x")
    assert image.status_code == 400
    assert "molecule_linked" in image.json()["detail"]


def test_coordinate_synced_session_preserves_panel_chromosomes(client):
    session_id = client.post("/api/linked/session/create").json()["session_id"]

    resp = client.post(f"/api/linked/session/{session_id}/send", json={
        "regions": _region_payload(x_chrom="chr2L_hap1", y_chrom="chr2L_hap2"),
        "split_view_mode": "coordinate_synced",
    })
    assert resp.status_code == 200

    session = client.get(f"/api/linked/session/{session_id}").json()
    assert session["split_view_mode"] == "coordinate_synced"
    assert session["contact_mode"] == "microc"
    assert session["split_view_semantics"]["row_coupling"] == "syncable_independent"
    assert session["regions"]["x_chrom"] == "chr2L_hap1"
    assert session["regions"]["y_chrom"] == "chr2L_hap2"


def test_molecule_linked_session_filters_and_structures_linked_reads(client, monkeypatch):
    from routers import linked_sessions as linked_sessions_router

    def fake_find_ligated_reads(*args, **kwargs):
        return [
            {
                "read_id": "keep",
                "x_segments": [{"name": "keep_1"}],
                "y_segments": [{"name": "keep_2"}],
            },
            {
                "read_id": "drop",
                "x_segments": [{"name": "drop_1"}],
                "y_segments": [{"name": "drop_2"}],
            },
        ]

    monkeypatch.setattr(linked_sessions_router, "find_ligated_reads", fake_find_ligated_reads)
    session_id = client.post("/api/linked/session/create").json()["session_id"]

    resp = client.post(f"/api/linked/session/{session_id}/send", json={
        "regions": _region_payload(),
        "read_ids": ["keep"],
        "split_view_mode": "molecule_linked",
    })
    assert resp.status_code == 200
    assert resp.json()["contact_mode"] == "dafc"
    assert resp.json()["n_reads"] == 1

    session = client.get(f"/api/linked/session/{session_id}").json()
    assert session["split_view_mode"] == "molecule_linked"
    assert session["split_view_semantics"]["row_coupling"] == "molecule"
    assert session["read_order"] == ["keep"]
    assert session["linked_reads"] == [{
        "base_id": "keep",
        "x_segments": ["keep_1"],
        "y_segments": ["keep_2"],
    }]
