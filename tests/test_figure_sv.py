"""Figures draw SVs as the read canvas does (fb-n9-sv)."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from services.figure.spec import FigureSpec, PanelSpec, TrackSpec, _merge_defaults
from services.figure.surface import make_surface
from services.figure.tracks import TrackContext
from services.figure.tracks import _read_sv as sv
from services.figure.tracks import reads as rt

VISIBILITY = json.loads((Path(__file__).parent / 'data/sv_visibility.json').read_text())


@pytest.mark.parametrize('case', VISIBILITY['cases'])
def test_figure_default_carrier_visibility_parity(case):
    payload = {'sv_summary': {'clusters': VISIBILITY['clusters'], 'clips': []}}
    result = sv.visible_summary(payload, {'svMinLen': case['min_len'], 'svMinSupport': case['min_support']})
    assert [c['id'] for c in (result or {}).get('clusters', [])] == case['ids']


def test_figure_sv_support_matches_browser_default_and_override():
    summary = {'clusters': [{'len': 100, 'support': 1}, {'len': 100, 'support': 3}],
               'clips': [{'n': 1}, {'n': 3}]}
    payload = {'sv_summary': summary}
    assert sv.visible_summary(payload, {}) == {'clusters': [summary['clusters'][1]], 'clips': [{'n': 3}]}
    assert sv.visible_summary(payload, {'svMinSupport': 1}) == summary
    assert sv.visible_summary(payload, {'svMinSupport': 4}) is None
    assert len(summary['clusters']) == 2


START = 1_000_000
ROW = 8


def test_figure_uses_raw_cigar_pieces_after_normalization_and_preserves_matched_bridges():
    read = {'sv': [dict(t='D', ref=1, len=40, q=0, raw_pieces=[
        dict(t='D', ref=100, len=20, q=0), dict(t='M', ref=120, len=10, q=0),
        dict(t='D', ref=130, len=20, q=10)])]}
    assert sv.read_draw(read, 90, 200, 40)['deletions'] == [(10, 30, 20), (40, 60, 20)]
    assert sv.read_draw(read, 90, 200, 41)['deletions'] == []


class _Data:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def get(self, key, load):
        if key[0] == 'reads-compact':
            self.requests.append(dict(key[1:]))
            return self.payload
        if key[0] in ('genes', 'all_peaks'):
            return []
        return load()


def _render(reads, summary=None, fe=None, sv_row=None, rows_off=()):
    # Drawing fixtures deliberately inspect a single carrier; default gates are tested above.
    fe = _merge_defaults({'readDisplayMode': 'all', 'readSeparatorMode': 'off', 'svMinSupport': 1, **(fe or {})})
    ds = {'id': 'ds', 'data_type': 'bam', 'layer_type': 'bam', 'available_layers': {'footprint': True}}
    tracks = ([sv_row] if sv_row else []) + [TrackSpec('reads', None)]
    panel = PanelSpec('ds', 'ds', 'ds', 'DS', '#3b82f6', ds, tracks, rows_off=set(rows_off))
    spec = FigureSpec('chr1', START, START + 1000, 1000, [panel], fe, 'defaults', read_row_height=ROW)
    payload = {'reads': copy.deepcopy(reads), 'count': len(reads), 'working_count': len(reads)}
    if summary:
        payload['sv_summary'] = summary
    data = _Data(payload)
    ctx = TrackContext(SimpleNamespace(datasets={'ds': ds}), spec, panel, data, 1000)
    height = rt.measure(ctx, panel.tracks[-1])
    surface = make_surface('png', 1000, height, scale=1)
    rt.draw(surface, ctx, panel.tracks[-1], height)
    return np.asarray(surface.to_image()).astype(int), height, data


SUMMARY = {'min_len': 50, 'margin': 100, 'scope': 'all', 'n_reads': 2,
           'clusters': [{'id': 'D', 't': 'D', 'ref': START + 300, 'len': 400, 'end': START + 700,
                         'support': 1, 'informative': 2, 'sa_support': 0}], 'clips': []}
DEL_READ = {'id': 'd', 'intervals': [[0, 300, -300], [700, 1000, -300]],
            'sv': [{'t': 'D', 'ref': START + 300, 'len': 400, 'q': 300}]}
REF_READ = {'id': 'r', 'intervals': [[0, 1000, -1000]]}


def test_request_carries_the_sv_settings():
    _img, _h, data = _render([REF_READ], fe={'svMinLen': 120})
    assert data.requests[0]['min_sv_len'] == 120 and data.requests[0]['include_sv_summary'] is True
    _img, _h, data = _render([REF_READ], fe={'svDisplayEnabled': False})
    assert data.requests[0]['include_sv_summary'] is False


def test_band_above_rows_and_body_broken_at_the_deletion():
    img, height, _ = _render([DEL_READ, REF_READ], SUMMARY)
    band = sv.SV_BAND_HEIGHT
    assert height == band + 2 * ROW
    read_bg = (0xf1, 0xf5, 0xf9)
    row0 = band + ROW // 2 - 1
    # Body on both sides of the deletion; empty (white) inside it, but for the connector line.
    assert tuple(img[row0 - 2, 100][:3]) == read_bg
    assert tuple(img[row0 - 2, 900][:3]) == read_bg
    assert tuple(img[row0 - 2, 450][:3]) == (255, 255, 255)
    # The reference read is unbroken.
    assert tuple(img[band + ROW + ROW // 2 - 2, 450][:3]) == read_bg
    # The band holds the deletion arc (red) somewhere over the deleted span.
    arc = img[2:band - 2, 300:700, :3]
    assert ((arc[..., 0] > 180) & (arc[..., 1] < 90)).any()


def test_no_band_without_summary_or_when_off():
    _img, height, _ = _render([REF_READ])
    _img2, height_off, _ = _render([DEL_READ], SUMMARY, fe={'svDisplayEnabled': False})
    assert height == height_off == ROW
    # The retired collapse: a saved one draws the SV row at its smallest height.
    collapsed = _render([DEL_READ], SUMMARY, fe={'svTrackCollapsed': True})[1]
    assert collapsed - ROW == sv.SV_BAND_MIN
    # The panel's SV row removed or minimized: no band.
    assert _render([DEL_READ], SUMMARY, rows_off={'sv'})[1] == ROW


def _render_sv_row(height):
    """The SV row of a panel that has one (its own track, where the browser puts it)."""
    fe = _merge_defaults({'readDisplayMode': 'all', 'readSeparatorMode': 'off', 'svMinSupport': 1})
    ds = {'id': 'ds', 'data_type': 'bam', 'layer_type': 'bam', 'available_layers': {'footprint': True}}
    row = TrackSpec('sv', height)
    panel = PanelSpec('ds', 'ds', 'ds', 'DS', '#3b82f6', ds, [row, TrackSpec('reads', None)])
    spec = FigureSpec('chr1', START, START + 1000, 1000, [panel], fe, 'defaults', read_row_height=ROW)
    data = _Data({'reads': copy.deepcopy([DEL_READ]), 'count': 1, 'working_count': 1, 'sv_summary': SUMMARY})
    ctx = TrackContext(SimpleNamespace(datasets={'ds': ds}), spec, panel, data, 1000)
    h = rt.measure_sv(ctx, row)
    # The reads below it no longer carry a band.
    assert rt.measure(ctx, panel.tracks[1]) == ROW
    surface = make_surface('png', 1000, max(1, h), scale=1)
    rt.draw_sv(surface, ctx, row, h)
    return np.asarray(surface.to_image()).astype(int), h


def test_band_follows_the_sv_rows_height_and_scales():
    """The SV row's height (heightOverride, clamped to its limits) is the band's; the arc rises with it."""
    tall_img, tall = _render_sv_row(120)
    assert tall == 120
    assert _render_sv_row(5000)[1] == sv.SV_BAND_MAX
    assert _render_sv_row(1)[1] == sv.SV_BAND_MIN
    assert _render_sv_row(None)[1] == sv.SV_BAND_HEIGHT
    red = (tall_img[..., 0] > 180) & (tall_img[..., 1] < 90)
    rows = np.flatnonzero(red[:, 300:700].any(axis=1))
    # The arc spans most of the row, not a fixed 36 px strip.
    assert rows.max() - rows.min() > 60


def test_size_labels():
    assert sv.size_text('D', 1800) == '−1.8 kb'
    assert sv.size_text('I', 312) == '+312'
    assert sv.size_text('D', 12_345) == '−12 kb'


def test_nothing_painted_in_the_deleted_span_even_by_overlays():
    """Anything reaching into a deletion (a soft edge, an unsplit call) is
    covered, as the canvas's broken body clips it."""
    read = {**DEL_READ, 'intervals': [[0, 300, -300], [700, 1000, -300]],
            'layers': {'nuc': {'intervals': [[200, 450, 147]]}}}
    img, _h, _ = _render([read], SUMMARY, fe={'enabledModTypes': {'nuc': True, 'footprint': True}})
    y = sv.SV_BAND_HEIGHT + 1
    assert tuple(img[y, 250][:3]) != (255, 255, 255)   # the call, on the body
    assert tuple(img[y, 400][:3]) == (255, 255, 255)   # nothing inside the deletion
