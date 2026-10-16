"""Headless read track (services/figure/tracks/reads.py) against the browser's canvas rules.

Synthetic reads are drawn at 1 px per bp (1000 px, 1000 bp, scale 1) with
4 px rows and no separators, so every read is a 4 px band and pixel colours
can be checked against ReadTrackCanvas.ts arithmetic.
"""
from __future__ import annotations

import copy
from types import SimpleNamespace

import numpy as np

from services.figure.spec import FigureSpec, PanelSpec, TrackSpec, _merge_defaults
from services.figure.surface import make_surface
from services.figure.tracks import TrackContext
from services.figure.tracks import reads as rt
from services.figure.tracks._read_raster import RowRaster

START = 1_000_000
ROW = 4


class _Data:
    def __init__(self, payload, genes=(), peaks=()):
        self.payload, self.genes, self.peaks = payload, list(genes), list(peaks)
        self.requests = []

    def get(self, key, load):
        if key[0] == 'reads-compact':
            self.requests.append(dict(key[1:]))
            return self.payload
        if key[0] == 'genes':
            return self.genes
        if key[0] == 'all_peaks':
            return self.peaks
        return load()


def _render(reads, fe=None, genes=(), peaks=(), dataset=None):
    fe = _merge_defaults({'readDisplayMode': 'all', 'readSeparatorMode': 'off', **(fe or {})})
    ds = dataset or {'id': 'ds', 'data_type': 'bam', 'layer_type': 'bam',
                     'available_layers': {'footprint': True, 'nuc': True, 'tf': True}}
    panel = PanelSpec('ds', 'ds', 'ds', 'DS', '#3b82f6', ds, [TrackSpec('reads', None)])
    spec = FigureSpec('chr1', START, START + 1000, 1000, [panel], fe, 'defaults', read_row_height=ROW)
    payload = {'reads': copy.deepcopy(reads), 'count': len(reads), 'working_count': len(reads)}
    data = _Data(payload, genes, peaks)
    ctx = TrackContext(SimpleNamespace(datasets={'ds': ds}), spec, panel, data, 1000)
    height = rt.measure(ctx, panel.tracks[0])
    surface = make_surface('png', 1000, height, scale=1)
    rt.draw(surface, ctx, panel.tracks[0], height)
    return np.asarray(surface.to_image()).astype(int), ctx, data


def _px(img, row, x):
    return tuple(img[row * ROW + ROW // 2, x])


def _hex(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def _over(src, alpha, dst):
    return tuple(int(np.floor(s * alpha + d * (1 - alpha) + 0.5)) for s, d in zip(_hex(src), _hex(dst)))


def _close(a, b, tol=1):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def _fp(color):
    """Primary footprints without a nuc layer draw at layerOpacity('footprint', 0.85)."""
    return _over(color, 0.85, '#f1f5f9')


def _read(rid, intervals, **extra):
    return {'id': rid, 'intervals': intervals, **extra}


def test_default_rules_colour_primary_footprints():
    genes = [{'id': 'g1', 'name': 'G', 'start': START + 300, 'end': START + 400}]
    reads = [_read('r1', [[0, 200, 200], [200, 240, -40], [240, 280, 40], [310, 360, 50], [400, 500, -100]])]
    img, _, _ = _render(reads, genes=genes)
    assert _px(img, 0, 100) == _fp('#33a040')         # >= 90 bp: Nucleosome rule
    assert _px(img, 0, 260) == _fp('#cccccc')         # 40 bp, no gene/peak: unmatched grey
    assert _px(img, 0, 330) == _fp('#ff69b4')         # 35-65 bp inside a gene: Pol II
    assert _px(img, 0, 220) == _hex('#f1f5f9')        # linker: read background
    assert _px(img, 0, 700) == _hex('#ffffff')        # past the read: no-read background


def test_peak_condition_colours_tf_sized_footprints():
    peaks = [{'start': START + 200, 'end': START + 300, 'layer': 0}]
    reads = [_read('r1', [[0, 100, 100], [240, 280, 40], [600, 640, 40]])]
    img, _, _ = _render(reads, peaks=peaks)
    assert _px(img, 0, 260) == _fp('#87ceeb')         # TF rule: in a peak, not in a gene
    assert _px(img, 0, 620) == _fp('#cccccc')


def test_tf_overlay_opacity_and_quality_ramp():
    tf = {'intervals': [[100, 130, 30], [300, 330, 30]], 'quality_names': ['tq'], 'qualities': [[255, 0]]}
    reads = [_read('r1', [[0, 1000, -1000]], layers={'tf': tf})]
    fe = {'activeColormap': {**_merge_defaults({})['activeColormap'], 'rules': []}}
    img, _, _ = _render(reads, fe=fe)
    # TF body alpha = min + (max - min) * q/255, max = layerOpacities.tf (0.9), min = tfOverlay.minOpacity (0.2).
    hi = round(255 * (0.2 + 0.7 * 1.0)) / 255
    lo = round(255 * 0.2) / 255
    assert _px(img, 0, 115) == _over('#e040fb', hi, '#f1f5f9')
    assert _px(img, 0, 315) == _over('#e040fb', lo, '#f1f5f9')
    # The overlay's 1 px bottom border (alpha 0x90) sits on the last line of the row.
    border = _over('#e040fb', 0x90 / 255, '#' + ''.join('%02x' % c for c in _over('#e040fb', hi, '#f1f5f9')))
    assert tuple(img[ROW - 1, 115]) == border


def test_default_rules_recolour_tf_layer_with_subnuc_rule():
    tf = {'intervals': [[100, 130, 30]]}
    reads = [_read('r1', [[0, 1000, -1000]], layers={'tf': tf})]
    img, _, _ = _render(reads)
    # 'subnuc' targets the TF layer; TF has no qualities -> q=255 -> alpha 0.9.
    assert _close(_px(img, 0, 115), _over('#9ca3af', round(255 * 0.9) / 255, '#f1f5f9'))


def test_layer_opacity_and_disabled_layers():
    reads = [_read('r1', [[0, 200, 200], [200, 1000, -800]])]
    cmap = copy.deepcopy(_merge_defaults({})['activeColormap'])
    cmap['layerOpacities']['footprint'] = 0.5
    img, _, _ = _render(reads, fe={'activeColormap': cmap})
    assert _px(img, 0, 100) == _over('#33a040', 0.5, '#f1f5f9')  # layerOpacities.footprint
    img, _, _ = _render(reads, fe={'enabledModTypes': {'footprint': False, 'nuc': True, 'tf': True}})
    assert _px(img, 0, 100) == _hex('#f1f5f9')


def test_nuc_layer_edge_ambiguity_modes():
    nuc = {'intervals': [[400, 500, 100]], 'quality_names': ['nq', 'lq', 'rq'], 'qualities': [[255], [0], [255]]}
    reads = [_read('r1', [[0, 1000, -1000]], layers={'nuc': nuc})]
    cmap = copy.deepcopy(_merge_defaults({})['activeColormap'])
    cmap['edgeAmbiguity'] = {'mode': 'strict', 'applyNuc': True, 'applyTf': True, 'maxGapBp': 30}
    strict, _, data = _render(reads, fe={'activeColormap': cmap})
    assert _px(strict, 0, 390) == _hex('#f1f5f9') and _px(strict, 0, 405) == _hex('#33a040')
    assert data.requests[0]['include_layer_qualities'] is False
    cmap['edgeAmbiguity']['mode'] = 'loose'
    loose, _, data = _render(reads, fe={'activeColormap': cmap})
    assert data.requests[0]['include_layer_qualities'] is True     # edges need the lq/rq dims
    assert _px(loose, 0, 375) == _hex('#33a040')      # left edge q=0 -> extended by the full 30 bp
    assert _px(loose, 0, 365) == _hex('#f1f5f9')
    assert _px(loose, 0, 505) == _hex('#f1f5f9')      # right edge q=255 -> crisp
    cmap['edgeAmbiguity']['mode'] = 'soft'
    soft, _, _ = _render(reads, fe={'activeColormap': cmap})
    feather = _px(soft, 0, 395)                        # outer band is a partial blend
    assert feather != _hex('#33a040') and feather != _hex('#f1f5f9')
    assert _px(soft, 0, 450) == _hex('#33a040')


def test_cart_entry_colour_wins_over_rules():
    group = {'id': 'g', 'name': 'G', 'color': '#123456', 'enabled': True, 'sourceIndex': 0, 'sizeMin': 0,
             'sizeMax': None, 'overlapFraction': 0.5, 'referenceAbsStart': START + 100, 'referenceAbsEnd': START + 200}
    reads = [_read('r1', [[100, 200, 100], [500, 600, 100]])]
    img, _, _ = _render(reads, fe={'footprintGroups': [group]})
    assert _px(img, 0, 150) == _fp('#123456')
    assert _px(img, 0, 550) == _fp('#33a040')


def test_methylation_marks_when_enabled():
    reads = [_read('r1', [[0, 1000, -1000]], methyl_m6a=[500])]
    img, _, data = _render(reads, fe={'enabledModTypes': {'m6a': True, 'nuc': True, 'tf': True, 'footprint': True}},
                           dataset={'id': 'ds', 'data_type': 'bam', 'available_layers': {'m6a': True, 'nuc': True}})
    assert data.requests[0]['include_methylation'] is True
    # 1 px wide mark centred on x=500 (max(1, 0.8 px/bp)): half of pixels 499 and 500, like canvas AA.
    assert _close(_px(img, 0, 500), _over('#6b21a8', 0.5, '#f1f5f9'))
    assert _close(_px(img, 0, 499), _over('#6b21a8', 0.5, '#f1f5f9'))


def test_cluster_order_sidebar_and_separator():
    reads = [_read(f'r{i}', [[0, 1000, 1000]]) for i in range(6)]
    fe = {'clusterAssignments': {'ds': {'r0': 0, 'r1': 1, 'r2': 2, 'r3': 0, 'r4': 1, 'r5': 2}},
          'clusterOrder': {'ds': [2, 0, 1]}, 'clusterFocus': {'ds': [0]}}
    img, ctx, data = _render(reads, fe=fe)
    view = rt._display(ctx)
    # Focus keeps cluster 0 only.
    assert [r['id'] for r in view['reads']] == ['r0', 'r3']
    fe.pop('clusterFocus')
    img, ctx, data = _render(reads, fe=fe)
    assert [r['id'] for r in rt._display(ctx)['reads']] == ['r2', 'r5', 'r0', 'r3', 'r1', 'r4']
    # Clustered reads are fetched by id, like the browser's filter_ids.
    assert data.requests[0]['filter_ids'] == ','.join(sorted(f'r{i}' for i in range(6)))
    # 16 px gutter: unfocused clusters at 0x66 alpha, genomic drawing starts at x=16.
    # (the app's cluster palette, constants.ts CLUSTER_COLORS: cluster 2 '#c3b503', cluster 0 '#ef3a7d')
    assert _px(img, 0, 5) == _over('#c3b503', 0x66 / 255, '#ffffff')     # cluster 2
    assert _px(img, 2, 5) == _over('#ef3a7d', 0x66 / 255, '#ffffff')     # cluster 0
    assert _px(img, 0, 15) == _hex('#ffffff')                             # 2 px gap before the reads
    assert _px(img, 0, 16 + 100) == _fp('#33a040')
    # Separator (rgba(0,0,0,0.4)) at the end of each cluster but the last, from the gutter on.
    line = tuple(img[2 * ROW, 500])
    assert line[0] < 0x33 + 10 and line != _hex('#33a040')
    assert tuple(img[2 * ROW, 5]) != line


def test_read_sort_order_within_clusters():
    reads = [_read(f'r{i}', [[0, 1000, 1000]]) for i in range(4)]
    fe = {'clusterAssignments': {'ds': {'r0': 1, 'r1': 0, 'r2': 1, 'r3': 0}}, 'clusterOrder': {'ds': [0, 1]},
          'readSortOrder': {'ds': ['r3', 'r2', 'r1', 'r0']}}
    _, ctx, _ = _render(reads, fe=fe)
    assert [r['id'] for r in rt._display(ctx)['reads']] == ['r3', 'r1', 'r2', 'r0']


def test_filtered_read_ids_and_duplicates():
    reads = [_read('a', [[0, 10, 10]]), _read('b', [[0, 10, 10]], duplicate=True), _read('c_1', [[0, 10, 10]])]
    _, ctx, _ = _render(reads, fe={'filteredReadIds': {'ds': ['a', 'b', 'c']}})
    assert [r['id'] for r in rt._display(ctx)['reads']] == ['a', 'c_1']


def test_fit_mode_sampling_matches_browser_hash():
    reads = [{'id': f'read{i}'} for i in range(10)]
    picked = rt.sample_reads_for_fit(reads, 3, 'fiberbrowser-analysis')
    assert len(picked) == 3
    assert [r['id'] for r in picked] == sorted((r['id'] for r in picked), key=lambda s: int(s[4:]))
    assert rt._fnv('a') == 0xe40c292c           # FNV-1a 32-bit, as stableDisplayHash


def test_layout_helpers_match_layout_ts():
    assert rt.row_gap(1) == 0 and rt.row_gap(4) == 0.5 and rt.row_gap(10) == 1.5 and rt.row_gap(20) == 3
    assert rt.row_gap(4, 'off') == 0 and rt.row_gap(5, 'fixed', 3, 2) == 2
    assert rt.display_capacity(590, 1, 'auto', 3, 1) == 590
    assert rt.format_read_status(590, 590, 3172, 3172, None, 0) == '590/3,172 visible'
    assert rt.request_filter_param({'a_1', 'b'}, {'a', 'c'}) == 'a'


def test_raster_partial_coverage_and_z_order():
    r = RowRaster(1, 10, 1, 1, [255, 255, 255])
    r.phase()
    r.add((0, 1), [0], 2.5, 5, np.array([0, 0, 0], np.float32), 1.0)
    r.phase()
    r.add((0, 1), [0], 4, 6, np.array([255, 0, 0], np.float32), 0.5)
    img = r.render()[0]
    assert tuple(img[2]) == (128, 128, 128)          # half-covered edge pixel
    assert tuple(img[3]) == (0, 0, 0)
    assert tuple(img[4]) == (128, 0, 0)              # later phase composited on top
    assert tuple(img[5]) == (255, 128, 128)
