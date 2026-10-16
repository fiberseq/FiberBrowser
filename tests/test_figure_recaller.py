"""Headless figures for the lattice recaller (the default footprint-class engine) match the browser.

- The footprint-class track resolves its job through ``tf_rc`` as well as ``tf_cr`` (ConsensusFamilyTrack.tsx
  consensusJobId), starting from the layers a recaller run actually registers.
- Recaller calls (ReadTrackCanvas.ts, consensus_workflow branch): edge ranges are used only when TF edge ambiguity
  applies (applyTf); recaller-added calls get a thin dark outline, looser-tier (edge / overlap) calls a dashed one.
"""
from __future__ import annotations

import copy
import threading
from types import SimpleNamespace

import numpy as np

from services import consensus_workflow as cw
from services.figure.tracks.consensus import consensus_job_id, measure
from test_figure_reads import ROW, START, _hex, _render
from test_figure_tracks import CHROM, _ctx, _draw


# --- class track --------------------------------------------------------------------

def _registered_recaller_dataset():
    ds = SimpleNamespace(available_layers={}, derived_layers={})
    state = SimpleNamespace(datasets={'d': ds}, get_dataset=lambda _: ds)
    cw._register(state, dict(job_id='job-rc', result={'cr_mode': 'lattice_recaller', 'datasets': {'d': {}}},
                             index={'d': {'layers': ['tf_cr', 'tf_rc']}}, layers=['tf_cr', 'tf_rc']))
    return ds


def test_recaller_run_registers_only_tf_rc_and_class_track_follows_it():
    ds = _registered_recaller_dataset()
    assert list(ds.derived_layers) == ['tf_rc']          # recaller runs skip the native-labelled tf_cr layer
    dataset = {'derived_layers': ds.derived_layers}
    assert consensus_job_id(dataset) == 'job-rc'
    assert measure(SimpleNamespace(panel=SimpleNamespace(dataset=dataset)), SimpleNamespace(height=60)) == 60


def test_class_track_prefers_tf_cr_like_the_browser():
    both = {'derived_layers': {'tf_rc': {'consensus_job_id': 'b'}, 'tf_cr': {'consensus_job_id': 'a'}}}
    assert consensus_job_id(both) == 'a'
    assert consensus_job_id({'derived_layers': {'tf_rc': {'consensus_job_id': 'b'}}}) == 'b'
    assert consensus_job_id({}) is None


def test_recaller_class_track_draws_classes_under_chrom_alias():
    ds = _registered_recaller_dataset()
    dataset = {'id': 'ds', 'derived_layers': ds.derived_layers}
    ctx = _ctx({}, dataset=dataset)
    # The run was made on the producer spelling ('1'); the view uses 'chr1'.
    catalog = {'cr_mode': 'lattice_recaller', 'region': {'chrom': CHROM.replace('chr', ''), 'start': 0, 'end': 5000},
               'edges': [], 'datasets': {'ds': {'catalog': [
                   {'family': 'class_001', 'consensus_start': 1100, 'consensus_end': 1130,
                    'classification_counts': {'CT': {'compatible_calls': 4, 'primary_calls': 4}}, 'stage': 'resolved'}]}}}
    ctx.data.get(('consensus.catalog', 'job-rc'), lambda: (catalog, None))
    height, svg = _draw(ctx, 'consensus')
    assert height == 60
    assert '>Footprint classes (1)</text>' in svg


# --- recaller calls on reads ---------------------------------------------------------

RC_DS = dict(id='ds', data_type='bam', available_layers={'tf_rc': True})


def _rc_reads(**record):
    base = dict(family='A', kind='recaller_class', interval=[START + 100, START + 160], tier='core')
    base.update(record)
    layer = dict(intervals=[[100, 160, 60]], consensus_workflow=True, consensus_records=[base], draw_style='fill')
    return [dict(id='r', intervals=[[0, 1000, -1000]], layers={'tf_rc': layer})]


def _fe(apply_tf=True, mode='strict'):
    return {'enabledModTypes': {'tf_rc': True},
            'activeColormap': {'rules': [], 'edgeAmbiguity': {'applyTf': apply_tf, 'mode': mode, 'applyNuc': True}}}


def test_disabled_tf_edge_ambiguity_draws_the_supplied_span():
    edges = [[START + 100, START + 110], [START + 150, START + 160]]
    for mode in ('strict', 'loose', 'soft'):
        img, _, _ = _render(_rc_reads(edge_range=edges), fe=_fe(False, mode), dataset=RC_DS)
        expected, _, _ = _render(_rc_reads(edge_range=None), fe=_fe(False, mode), dataset=RC_DS)
        assert np.array_equal(img, expected), mode


def test_enabled_tf_edge_ambiguity_strict_draws_the_sure_span():
    edges = [[START + 100, START + 110], [START + 150, START + 160]]
    img, _, _ = _render(_rc_reads(edge_range=edges), fe=_fe(True, 'strict'), dataset=RC_DS)
    mid = ROW // 2
    background = tuple(img[mid, 105])
    assert tuple(img[mid, 130]) != background                  # inside the sure span: filled
    assert tuple(img[mid, 105]) == tuple(img[mid, 400])        # uncertain edge: not filled


def _outline_pixels(img, x0=100, x1=160):
    """Top edge pixels inside a record drawn at [x0, x1) on row 0 and a fill-only reference."""
    return [tuple(img[0, x]) for x in range(x0 + 2, x1 - 2)]


def test_recaller_added_and_looser_tier_calls_are_outlined():
    fill, _, _ = _render(_rc_reads(), fe=_fe(), dataset=RC_DS)
    added, _, _ = _render(_rc_reads(recaller_added=True), fe=_fe(), dataset=RC_DS)
    edge, _, _ = _render(_rc_reads(tier='edge'), fe=_fe(), dataset=RC_DS)
    loose, _, _ = _render(_rc_reads(tier='loose'), fe=_fe(), dataset=RC_DS)
    mid = ROW // 2
    dark = np.array(_hex('#1f2937'))

    def darker(img, x):   # the outline darkens the fill toward #1f2937
        return np.abs(img[0, x] - dark).sum() < np.abs(fill[0, x] - dark).sum()

    # Core native calls: fill only, no outline.
    assert not any(darker(fill, x) for x in range(102, 158))
    # Recaller-added: a solid outline along the whole top edge; the body keeps the class fill.
    assert all(darker(added, x) for x in range(102, 158))
    assert tuple(added[mid, 130]) == tuple(fill[mid, 130])
    # Looser tiers: dashed, so the top edge alternates between outlined and not.
    for img in (edge, loose):
        top = [darker(img, x) for x in range(102, 158)]
        assert any(top) and not all(top)
    # Left and right sides are stroked too.
    assert darker(added, 100) or darker(added, 101)
    assert darker(added, 159) or darker(added, 158)


def test_looser_tier_calls_ignore_edge_ranges():
    edges = [[START + 100, START + 110], [START + 150, START + 160]]
    with_range, _, _ = _render(_rc_reads(tier='edge', edge_range=edges), fe=_fe(True, 'strict'), dataset=RC_DS)
    without, _, _ = _render(_rc_reads(tier='edge', edge_range=None), fe=_fe(True, 'strict'), dataset=RC_DS)
    assert np.array_equal(with_range, without)


def test_outlined_recaller_added_call_uses_the_supplied_span_for_its_stroke():
    """ReadTrackCanvas strokes the record's drawn interval (x, w), not the sure inner span of its edge range."""
    edges = [[START + 100, START + 110], [START + 150, START + 160]]
    img, _, _ = _render(_rc_reads(recaller_added=True, edge_range=edges), fe=_fe(True, 'strict'), dataset=RC_DS)
    plain, _, _ = _render(_rc_reads(edge_range=edges), fe=_fe(True, 'strict'), dataset=RC_DS)
    # Top edge at x=104 (outside the sure span [110, 150)) is stroked.
    assert tuple(img[0, 104]) != tuple(plain[0, 104])
