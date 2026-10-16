"""B6 round 5: contact-map snapshots, co-accessibility marginals, DAF-C primer orders,
multi-volume BLAST databases, UCSC filters, catalog reloads, queued notebook panel commands."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from models.requests import JupyterBrowserSettingsRequest
from services import catalog_endpoint
from services.coaccessibility_endpoint import _marginal_accessibility
from services.jupyter_endpoint import queue_browser_settings_update
from services.microc_matrix import cooler_at_resolution
from services.tracks_endpoint import add_track_for_request, remove_track_for_request


# ── 1. Contact-map requests read one map ─────────────────────────────

def test_request_view_keeps_its_map_when_another_loads():
    cache_a = {("chr1", 1000, False): np.array([1.0])}
    shared = SimpleNamespace(current_resolution=1000, resolutions=[1000], cool_file="a.cool",
                             clr="handle-a", chrom_expected_cache=cache_a)
    view, res = cooler_at_resolution(shared, None, object())
    # Map B loads while the request awaits its fetch.
    shared.clr, shared.cool_file, shared.chrom_expected_cache = "handle-b", "b.cool", {}
    assert res == 1000
    assert (view.clr, view.cool_file) == ("handle-a", "a.cool")
    assert view.chrom_expected_cache is cache_a


# ── 2. Co-accessibility marginals are first moments ──────────────────

def test_marginal_is_mean_accessibility_not_its_square():
    accessibility = np.full((20, 2), 0.5)
    raw = np.full((2, 2), 0.25)  # E[a_i a_j] of 0.5-accessible bins
    assert _marginal_accessibility(raw, accessibility) == [0.5, 0.5]


def test_marginal_keeps_coverage_masking_and_uncovered_reads():
    accessibility = np.array([[1.0, np.nan], [0.0, 1.0], [np.nan, 1.0]])
    raw = np.array([[0.5, 1.0], [1.0, np.nan]])  # bin 1 masked for low coverage
    assert _marginal_accessibility(raw, accessibility) == [0.5, None]


# ── 3. DAF-C quads in primer orders ──────────────────────────────────

def test_primer_order_expands_dafc_quads(monkeypatch):
    import browser_client
    client = object.__new__(browser_client.BrowserClient)
    monkeypatch.setattr(client, "get_primer_cart", lambda: {"saved_primers": []}, raising=False)
    monkeypatch.setattr(client, "get_primers", lambda: [{
        "x_pair": {"fwd_seq": "AAAA", "rev_seq": "CCCC"},
        "y_pair": {"fwd_seq": "GGGG", "rev_seq": "TTTT"},
        "max_tm_range": 1.0,
    }], raising=False)
    order = client.format_primer_order(format="fasta")
    assert order["content"].split("\n") == [
        ">Quad_1_X_F", "AAAA", ">Quad_1_X_R", "CCCC",
        ">Quad_1_Y_F", "GGGG", ">Quad_1_Y_R", "TTTT",
    ]


# ── 5. UCSC tracks keep their name filter ────────────────────────────

def test_ucsc_track_stores_its_filter_and_dedupes_by_it():
    state = SimpleNamespace(orthogonal_tracks=[])
    first = add_track_for_request(state, path="ucsc://hg38/refGene", filter_names="TP53")
    assert state.orthogonal_tracks[0]["filter_names"] == ["TP53"]
    again = add_track_for_request(state, path="ucsc://hg38/refGene", filter_names="TP53")
    assert again["track_index"] == first["track_index"] and len(state.orthogonal_tracks) == 1
    unfiltered = add_track_for_request(state, path="ucsc://hg38/refGene")
    assert unfiltered["track_index"] == 1 and "filter_names" not in state.orthogonal_tracks[1]


# ── 6. A catalog track removed from the track list can load again ────

def test_catalog_track_reloads_after_removal_from_the_track_list():
    catalog_endpoint.set_catalog({"tracks": [{"label": "sig", "path": "/data/sig.bw"}]})
    try:
        state = SimpleNamespace(orthogonal_tracks=[], _catalog_loaded_tracks=set(), _catalog_loaded=set())
        loaded = catalog_endpoint.catalog_track_load_payload(state, 0)
        remove_track_for_request(state, loaded["track_index"])
        assert state._catalog_loaded_tracks == set()
        again = catalog_endpoint.catalog_track_load_payload(state, 0)
        assert again["message"].startswith("Loaded track") and len(state.orthogonal_tracks) == 1
        # Stale bookkeeping (a track gone some other way) is reconciled too.
        state.orthogonal_tracks.clear()
        assert catalog_endpoint.catalog_track_load_payload(state, 0)["message"].startswith("Loaded track")
    finally:
        catalog_endpoint.set_catalog(None)


# ── 7. Notebook panel commands queue in order ────────────────────────

def test_open_panel_calls_between_polls_all_apply():
    jupyter_state = SimpleNamespace(pending_settings_update=None, version=0)
    first = queue_browser_settings_update(jupyter_state, JupyterBrowserSettingsRequest(open_panel="co-accessibility"))
    queue_browser_settings_update(jupyter_state, JupyterBrowserSettingsRequest(open_panel="contact-map"))
    queue_browser_settings_update(jupyter_state, JupyterBrowserSettingsRequest(close_panel="history"))
    assert first["updated"] == ["open_panel"]
    pending = jupyter_state.pending_settings_update
    assert pending["panel_ops"] == [["open", "co-accessibility"], ["open", "contact-map"], ["close", "history"]]
    assert "open_panel" not in pending and "close_panel" not in pending
