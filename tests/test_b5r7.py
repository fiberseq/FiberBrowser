"""Round-7 review fixes: headless figure reads track and Playwright render payloads (B5)."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))

from services.figure.spec import FigureSpec, PanelSpec, TrackSpec, _merge_defaults  # noqa: E402
from services.figure.tracks import TrackContext  # noqa: E402
from services.figure.tracks import _read_colors as rc  # noqa: E402
from services.figure.tracks import reads as rt  # noqa: E402

START = 1_000_000


class _Data:
    def __init__(self, payload):
        self.payload = payload

    def get(self, key, load):
        if key[0] == 'reads-compact':
            return self.payload
        return load()


def _ctx(reads, fe):
    fe = _merge_defaults({'readDisplayMode': 'all', 'readSeparatorMode': 'off', **fe})
    ds = {'id': 'ds', 'data_type': 'bam', 'layer_type': 'bam',
          'available_layers': {'footprint': True, 'nuc': True, 'tf': True}}
    panel = PanelSpec('ds', 'ds', 'ds', 'DS', '#3b82f6', ds, [TrackSpec('reads', None)])
    spec = FigureSpec('chr1', START, START + 1000, 1000, [panel], fe, 'defaults', read_row_height=4)
    payload = {'reads': copy.deepcopy(reads), 'count': len(reads), 'working_count': len(reads)}
    return TrackContext(SimpleNamespace(datasets={'ds': ds}), spec, panel, _Data(payload), 1000)


# ── B5r7 #1: a filter matching no reads shows none ──────────────────────────
def test_empty_read_filter_shows_no_reads():
    reads = [{'id': 'a', 'intervals': [[0, 10, 10]]}, {'id': 'b', 'intervals': [[0, 10, 10]]}]
    assert [r['id'] for r in rt._display(_ctx(reads, {}))['reads']] == ['a', 'b']
    ctx = _ctx(reads, {'filteredReadIds': {'ds': []}})
    assert rt._display(ctx)['reads'] == []
    assert rt.panel_cohort_ids(ctx) == []
    assert rt._display(ctx)['use_server_meta'] is False


def test_empty_filter_profiles_no_reads(monkeypatch):
    from services.figure.tracks import composite
    ctx = _ctx([{'id': 'a', 'intervals': [[0, 10, 10]]}], {'filteredReadIds': {'ds': []}})
    monkeypatch.setattr(composite, 'active_metaprofile_keys', lambda fe: ['nuc'])
    monkeypatch.setattr(composite, '_local_profile', lambda *a, **k: None)
    called = []

    class Data:
        def get(self, key, load):
            return load()

        def compact_reads(self, *a, **k):
            called.append(k)
            return {'metaprofile': {'layers': {'nuc': [1.0]}}}

    ctx = TrackContext(ctx.state, ctx.spec, ctx.panel, Data(), 1000)
    assert composite.dataset_profile(ctx, 'ds') == {"mod": [], "fire": [], "rules": {}, "layers": {}}
    assert called == []


# ── B5r7 #2: read colouring uses the Peaks track's peaks, rescanned after a region override ──
def test_read_colouring_peaks_follow_the_peaks_track(monkeypatch):
    from services.figure.tracks import peaks as peaks_track
    fe = {'peakRules': [{'id': 'r1', 'enabled': True, 'source': 'accessibility'}],
          'peaksByRule': {'r1': [{'start': START + 120, 'end': START + 150, 'chrom': 'chr9'}]},
          '_peaksFromAnotherView': True}
    ctx = _ctx([], fe)
    monkeypatch.setattr(peaks_track, '_scan_rule', lambda c, rule, region=None: [
        {'start': START + 300, 'end': START + 350}])
    found = rt._all_peaks(ctx)
    assert [(p['start'], p['end']) for p in found] == [(START + 300, START + 350)]


# ── B5r7 #3: track / motif labeling conditions match like the browser ───────
class _Tracks:
    def __init__(self, items, motifs=()):
        self.items, self._motifs = items, list(motifs)

    def track(self, index):
        return self.items.get(index)

    def motifs(self):
        return self._motifs


def test_track_and_motif_conditions():
    tracks = _Tracks({
        0: {'render_mode': 'annotation', 'intervals': [{'start': START + 100, 'end': START + 200}]},
        1: {'render_mode': 'signal', 'values': [0, 0, 1, 1, 5, 5, 9, 9, 0, 0]},
    }, motifs=[{'intervals': [{'start': START + 500, 'end': START + 520}]}])
    rctx = rc.RuleContext([], [], START, START + 1000, 'chr1', tracks=tracks)
    mid = np.array([150.0, 350.0, 510.0, 650.0, 950.0])
    assert rctx.condition({'target': 'track', 'trackId': '0'}, mid).tolist() == [True, False, False, False, False]
    assert rctx.condition({'target': 'track', 'trackId': '0', 'negate': True}, mid).tolist() == [
        False, True, True, True, True]
    # Positive values sorted [1,1,5,5,9,9]: 50th percentile -> 5; bins by midpoint.
    assert rctx.condition({'target': 'track', 'trackId': '1', 'trackThreshold': 50}, mid).tolist() == [
        False, False, True, True, False]
    assert rctx.condition({'target': 'motif'}, mid).tolist() == [False, False, True, False, False]
    # A removed or unknown track matches nothing.
    assert not rctx.condition({'target': 'track', 'trackId': 'removed'}, mid).any()
    assert not rctx.condition({'target': 'track', 'trackId': '7'}, mid).any()


def test_named_gene_not_in_view_matches_nothing():
    genes = [{'id': 'B', 'name': 'geneB', 'start': START, 'end': START + 1000}]
    rctx = rc.RuleContext(genes, [], START, START + 1000, 'chr1')
    mid = np.array([100.0])
    assert not rctx.condition({'target': 'gene', 'geneId': 'A'}, mid).any()
    assert rctx.condition({'target': 'gene'}, mid).all()


def test_rule_tracks_loader_uses_the_server_tracks(monkeypatch):
    from services.figure.tracks import composite
    ctx = _ctx([], {})
    ctx = TrackContext(SimpleNamespace(datasets={}, orthogonal_tracks=[
        {'path': 'a.bb', 'category': 'motif'}, {'path': 'b.bw'}]), ctx.spec, ctx.panel, ctx.data, 1000)
    monkeypatch.setattr(composite, 'track_batch', lambda c, i: {'index': i})
    loader = composite.RuleTracks(ctx)
    assert loader.track(1) == {'index': 1}
    assert loader.track(5) is None
    assert loader.motifs() == [{'index': 0}]


# ── B5r7 #4-6: Playwright payload ───────────────────────────────────────────
def _state():
    from models.domain import Dataset
    from state.browser_state import BrowserState
    state = BrowserState(None)
    ds = Dataset("A", "A.bam", label="A")
    ds.cluster_assignments = {"r1": 0, "r2": 1}
    state.datasets["A"] = ds
    state.dataset_order.append("A")
    return state


def test_playwright_sends_stored_clusters_when_asked():
    from models.requests import RenderRequest
    from services.playwright_render import _state_for_request
    state = _state()
    off = _state_for_request(RenderRequest(chrom="c", start=0, end=10, engine="playwright"), state)
    assert "clusterAssignments" not in off
    on = _state_for_request(RenderRequest(chrom="c", start=0, end=10, engine="playwright",
                                          use_clusters=True, cluster_order={"A": [1, 0]}), state)
    assert on["clusterAssignments"] == {"A": {"r1": 0, "r2": 1}}
    assert on["clusterOrder"] == {"A": [1, 0]}


def test_playwright_rejects_a_palette():
    from models.requests import RenderRequest
    from services.playwright_render import render_with_playwright
    req = RenderRequest(chrom="c", start=0, end=10, engine="playwright", colors={"nuc": "#ff0000"})
    response = render_with_playwright(req, _state())
    assert response.status_code == 400
    assert "colors" in json.loads(response.body)["error"]


def test_playwright_layer_toggles_are_sent_complete_both_ways():
    from models.requests import RenderRequest
    from services.playwright_render import DEFAULT_ENABLED_MOD_TYPES, _state_for_request
    state = _state()
    untouched = _state_for_request(RenderRequest(chrom="c", start=0, end=10, engine="playwright"), state)
    assert "enabledModTypes" not in untouched and "enabledMetaProfiles" not in untouched
    off = _state_for_request(RenderRequest(chrom="c", start=0, end=10, engine="playwright",
                                           show_layers=False, show_mods=False, show_fire=False), state)
    assert off["enabledModTypes"] == {**DEFAULT_ENABLED_MOD_TYPES, "tf": False, "nuc": False}
    assert off["enabledMetaProfiles"]["fire"] is False and off["enabledMetaProfiles"]["nuc"] is True
    mods = _state_for_request(RenderRequest(chrom="c", start=0, end=10, engine="playwright", show_mods=True), state)
    # Asking for mods keeps the default footprint/nuc/tf layers on.
    assert mods["enabledModTypes"]["m6a"] and mods["enabledModTypes"]["mod"]
    assert mods["enabledModTypes"]["tf"] and mods["enabledModTypes"]["nuc"] and mods["enabledModTypes"]["footprint"]
