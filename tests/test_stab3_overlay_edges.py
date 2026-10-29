"""Scan overlay edge paths: a quality-filtered tables-mode scan mark stays filtered on every display path.

The overlay must run before the per-layer quality filters; a row it changed carries a receipt naming the window, so
the display post-pass over the same window is a no-op. These paths applied the filters with no overlay first (or
lost the receipt), so the post-pass put the raw, unfiltered mark back:

- the sampled display working set (``build_sampled_display_working_set``, the default compact-reads path);
- the broad-cache hit of ``read_endpoint`` (read-ID filters, cluster focus, strand);
- a wrapped view of a circular contig: segments merged by ``merge_compact_reads_by_id`` (the receipt and the layers'
  overlay token were dropped, and each segment's receipt named its own window, not the wrapped view's);
- the direct loads (``_compact_reads_payload``'s and ``compact_all_dataset_result``'s);
- a request whose ``layer_names`` leave the scan layer out: its display quality filters skip that layer, so the
  post-pass's layer was unfiltered; the display rows now carry only the scan layers the request asked for.
"""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')

from scan_fixtures import row, tiny_bam, write_scan_dir, write_table

HIT = 'fp:class:chrT:150:aaaaaaaa'
QFILTER = [dict(layer='fpcls', quality_name='q1', min_value=250)]
LN = 100_000


def _fpcls_scan(tmp_path, bam, record, span):
    """A tables-mode scan with one fpcls member mark (``span``) of posterior 0.502 (byte 128) on m1/1/ccs."""
    a, b = span
    d = write_scan_dir(tmp_path / 'scan', bam, hits=[(a, b, HIT, 'class_000')],
                       states=[(HIT, a, b, 'm1/1/ccs', record, '1')])
    write_table(d / 'fp' / 'states.tsv.bgz', ['hit_id', 'dataset_id', 'qname', 'record', 'molecule', 'state', 'posterior'],
                [row('chrT', a, b, HIT, 'dataset_1', 'm1/1/ccs', record, 'mol:v1 0', '1', '0.502')], {'chrT': 0})
    return d


def _state(tmp_path, monkeypatch, *, read_start, span, filtered, circular=False):
    from models.domain import Dataset
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.scan import registry
    from state.browser_state import BrowserState
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    bam = tiny_bam(tmp_path / 'a.bam', length=LN, reads=(('m1/1/ccs', read_start, 0), ('m1/2/ccs', read_start + 100, 0)))
    st = BrowserState(None)
    st.drop_short_terminal_footprints = False
    ds = Dataset('ds_a', bam, label='A')
    ds.data_type = 'bam'
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds_a': ds}
    st.dataset_order = ['ds_a']
    st.chroms = [NS(name='chrT', size=LN)]
    if circular:
        st.circular_chroms = {'chrT': {'size': LN}}
    own = {r['id']: r for r in build_compact_reads_from_bam(bam, 'chrT', read_start, read_start + 500,
                                                            spanning_only=False)}['m1/1/ccs']
    registry.open_scan(st, _fpcls_scan(tmp_path, bam, f"{own['record_sha256']}:{own['alignment_occurrence']}", span))
    if filtered:
        st.set_quality_filters(QFILTER)
    return st


def _payload(st, start, end, **kwargs):
    from services.read_endpoint import compact_reads_payload_for_request
    payload = compact_reads_payload_for_request(state=st, chrom='chrT', start=start, end=end, max_reads=100,
                                                dataset_id='ds_a', include_layers=True, spanning=False,
                                                **{'layer_names': 'fpcls', **kwargs})
    return payload, {r['id']: r for r in payload['reads']}


def _fpcls(read):
    return ((read.get('layers') or {}).get('fpcls') or {}).get('intervals')


@pytest.mark.parametrize('filtered', [False, True])
def test_sampled_display_path_keeps_a_filtered_scan_mark_filtered(tmp_path, monkeypatch, filtered):
    st = _state(tmp_path, monkeypatch, read_start=1000, span=(1000, 1100), filtered=filtered)
    payload, reads = _payload(st, 1000, 2000)
    assert 'display_working_set_ms' in payload['server_timings']       # build_sampled_display_working_set
    assert _fpcls(reads['m1/1/ccs']) == ([] if filtered else [[0, 100, 100]])


@pytest.mark.parametrize('filtered', [False, True])
def test_broad_cache_hit_with_read_id_filter_keeps_a_filtered_scan_mark_filtered(tmp_path, monkeypatch, filtered):
    st = _state(tmp_path, monkeypatch, read_start=1000, span=(1000, 1100), filtered=filtered)
    _payload(st, 1000, 2000)                                           # fills the broad cache
    payload, reads = _payload(st, 1000, 2000, filter_ids='m1/1/ccs')
    assert payload['server_timings'].get('broad_cache_hit') == 1.0     # the "Filtered from broad cache" branch
    assert set(reads) == {'m1/1/ccs'}
    assert _fpcls(reads['m1/1/ccs']) == ([] if filtered else [[0, 100, 100]])


# A wrapped view of a circular contig (-200..300 shows reference 99_800..100_000 then 0..300): the read at
# reference 0..500 and its mark at 100..200 are drawn at logical 100..200, offset 300..400.

@pytest.mark.parametrize('filtered', [False, True])
def test_circular_working_set_merge_keeps_a_filtered_scan_mark_filtered(tmp_path, monkeypatch, filtered):
    st = _state(tmp_path, monkeypatch, read_start=0, span=(100, 200), filtered=filtered, circular=True)
    ws = st.build_working_set('ds_a', 'chrT', -200, 300, include_layers=True)
    got = {r['id']: r for r in ws.reads}['m1/1/ccs']
    assert _fpcls(got) == ([] if filtered else [[300, 400, 100]])


@pytest.mark.parametrize('filtered', [False, True])
def test_circular_sampled_display_merge_keeps_a_filtered_scan_mark_filtered(tmp_path, monkeypatch, filtered):
    st = _state(tmp_path, monkeypatch, read_start=0, span=(100, 200), filtered=filtered, circular=True)
    payload, reads = _payload(st, -200, 300)
    assert 'display_working_set_ms' in payload['server_timings']
    assert _fpcls(reads['m1/1/ccs']) == ([] if filtered else [[300, 400, 100]])


@pytest.mark.parametrize('start', [LN, LN + 50, 2 * LN + 50])
@pytest.mark.parametrize('path', ['working', 'sampled', 'direct'])
def test_scan_marks_after_a_whole_circular_turn(tmp_path, monkeypatch, start, path):
    st = _state(tmp_path, monkeypatch, read_start=0, span=(100, 200), filtered=False, circular=True)
    if path == 'working':
        reads = st.build_working_set('ds_a', 'chrT', start, start + 300, include_layers=True).reads
    else:
        payload, _ = _payload(st, start, start + 300, **({'hide_terminal_gaps': False} if path == 'direct' else {}))
        reads = payload['reads']
    marked = [r for r in reads if _fpcls(r)]
    assert len(marked) == 1
    offset = 100 - start % LN
    assert _fpcls(marked[0]) == [[offset, offset + 100, 100]]


def test_circular_shift_and_merge_keep_unclipped_layer_sources():
    from services.circular_genome import merge_compact_reads_by_id, shift_compact_read
    original = dict(id='synthetic', intervals=[[0, 5, 5]], layers={
        'mark': dict(intervals=[[0, 5, 5]], source_intervals=[[-10, 10, 20]])})
    shifted = shift_compact_read(original, 30)
    assert shifted['layers']['mark']['source_intervals'] == [[20, 40, 20]]
    (merged,) = merge_compact_reads_by_id([original, shifted])
    assert merged['layers']['mark']['source_intervals'] == [[-10, 10, 20], [20, 40, 20]]


def test_merge_keeps_overlay_meta_and_rewindow_names_the_wrapped_view():
    from services.circular_genome import merge_compact_reads_by_id, shift_compact_read
    from services.scan.overlay import RECEIPT_KEY, rewindow_receipts
    layer = dict(intervals=[[0, 10, 10]], qualities=[[1]], quality_names=['state'], scan_overlay='scan:t',
                 source_layer='tf', draw_style='fill')
    head = dict(id='r', reference_start=90, reference_end=100, intervals=[[0, 10, 0]], layers={'fpcls': layer},
                **{RECEIPT_KEY: ('scan:t', 'chrT', 90, 100, ('fpcls',))})
    tail = dict(id='r', reference_start=90, reference_end=100, intervals=[[0, 5, 0]], layers={},
                **{RECEIPT_KEY: ('scan:t', 'chrT', 0, 5, ('nucsz',))})
    shifted = shift_compact_read(head, 0, -100)
    assert shifted[RECEIPT_KEY] == head[RECEIPT_KEY] and shifted['layers']['fpcls']['scan_overlay'] == 'scan:t'
    (merged,) = merge_compact_reads_by_id([shifted, shift_compact_read(tail, 10, 10)])
    assert RECEIPT_KEY not in merged
    assert {k: merged['layers']['fpcls'][k] for k in ('scan_overlay', 'source_layer', 'draw_style')} == \
        dict(scan_overlay='scan:t', source_layer='tf', draw_style='fill')
    (out,) = rewindow_receipts([merged], 'chrT', -10, 5)
    assert out[RECEIPT_KEY] == ('scan:t', 'chrT', -10, 5, ('fpcls', 'nucsz'))
    assert not any(k.startswith(RECEIPT_KEY + '_') for k in out)
    # Parts overlaid by different scans: no receipt (the post-pass replaces the token-carrying layers).
    other = dict(tail, **{RECEIPT_KEY: ('scan:u', 'chrT', 0, 5, ())})
    (mixed,) = rewindow_receipts(merge_compact_reads_by_id([shifted, shift_compact_read(other, 10, 10)]), 'chrT', -10, 5)
    assert RECEIPT_KEY not in mixed


@pytest.mark.parametrize('filtered', [False, True])
def test_direct_load_keeps_a_filtered_scan_mark_filtered(tmp_path, monkeypatch, filtered):
    st = _state(tmp_path, monkeypatch, read_start=1000, span=(1000, 1100), filtered=filtered)
    payload, reads = _payload(st, 1000, 2000, hide_terminal_gaps=False)      # a direct load
    assert 'direct_load_ms' in payload['server_timings']
    assert _fpcls(reads['m1/1/ccs']) == ([] if filtered else [[0, 100, 100]])


@pytest.mark.parametrize('filtered', [False, True])
def test_compact_all_direct_load_keeps_a_filtered_scan_mark_filtered(tmp_path, monkeypatch, filtered):
    from services.read_endpoint import compact_all_dataset_result
    st = _state(tmp_path, monkeypatch, read_start=1000, span=(1000, 1100), filtered=filtered)
    _ds, payload = compact_all_dataset_result(
        state=st, query=NS(), dataset_id='ds_a', chrom='chrT', start=1000, end=2000, region_width=1000,
        spanning=False, max_reads=100, downsample=None, include_methylation=False, include_layers=True,
        requested_layers=('fpcls',), include_layer_qualities=True, ml_threshold=125, fill_gap_size=None,
        min_fp_quality=0, min_footprints=0, include_metaprofile=False, profile_max_reads=100, coverage_sample=False,
        hide_terminal_gaps=False, terminal_gap_threshold=500, infer_legacy_layers=True, legacy_nuc_min_size=90,
        sample_seed='test-seed')
    assert 'direct_load_ms' in payload['server_timings']
    got = {r['id']: r for r in payload['reads']}['m1/1/ccs']
    assert _fpcls(got) == ([] if filtered else [[0, 100, 100]])


@pytest.mark.parametrize('path', ['sampled', 'direct', 'broad-cache-hit'])
def test_a_scan_layer_the_request_left_out_is_not_displayed(tmp_path, monkeypatch, path):
    """``layer_names`` without fpcls: the fpcls filter is not a display filter of the request, so the post-pass's
    fpcls layer would be unfiltered; the display rows carry no fpcls layer at all."""
    st = _state(tmp_path, monkeypatch, read_start=1000, span=(1000, 1100), filtered=True)
    kwargs = dict(layer_names='tf')
    if path == 'direct':
        kwargs['hide_terminal_gaps'] = False
    elif path == 'broad-cache-hit':
        _payload(st, 1000, 2000, **kwargs)
        kwargs['filter_ids'] = 'm1/1/ccs'
    payload, reads = _payload(st, 1000, 2000, **kwargs)
    assert path != 'broad-cache-hit' or payload['server_timings'].get('broad_cache_hit') == 1.0
    assert 'fpcls' not in (reads['m1/1/ccs'].get('layers') or {})
    assert 'fpcls' in payload['available_layers']        # still offered: the request may ask for it


def test_a_circular_merge_keeps_the_molecules_scan_scalars(tmp_path, monkeypatch):
    """Codex review, stabilize 3 group B round 1: the merge dropped the row's molecule scalars, and the rewindowed
    receipt then kept the final overlay from putting them back: a molecule metric filter matched the read in a plain
    window but not in a wrapped one."""
    import json
    from models.domain import Dataset
    from services.nuc.scalars import metric_value
    from services.scan import registry
    from state.browser_state import BrowserState
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    bam = tiny_bam(tmp_path / 'toy.bam', length=LN, reads=(('toy-read', 0, 0),))
    d = write_scan_dir(tmp_path / 'scan', bam)
    write_table(d / 'nuc' / 'molecules.tsv.bgz', ['dataset_id', 'qname', 'record', 'molecule', 'nrl'],
                [row('chrT', 0, 500, 'dataset_1', 'toy-read', '', 'mol:v1 0', 190)], {'chrT': 0})
    manifest = json.loads((d / 'manifest.json').read_text())
    manifest['modules']['nuc'] = {'version': '1.0', 'settings_hash': 'n' * 16, 'feature_types': [],
                                  'ma_groups': [{'group': 'nucmol', 'kind': 'scalar'}]}
    manifest['outputs']['tables']['nuc/molecules.tsv.bgz'] = {'rows': 1, 'sha256': ''}
    (d / 'manifest.json').write_text(json.dumps(manifest))
    st = BrowserState(None)
    st.drop_short_terminal_footprints = False
    ds = Dataset('toy', bam, label='Toy')
    ds.data_type = 'bam'
    st.datasets = {'toy': ds}
    st.dataset_order = ['toy']
    st.chroms = [NS(name='chrT', size=LN)]
    st.circular_chroms = {'chrT': {'size': LN}}
    registry.open_scan(st, d)
    plain = st.build_working_set('toy', 'chrT', 0, 300, include_layers=True)
    assert metric_value(plain.reads[0], 'nuc.nrl') == 190
    wrapped = st.build_working_set('toy', 'chrT', -200, 300, include_layers=True)
    assert metric_value(wrapped.reads[0], 'nuc.nrl') == 190
    from models.requests import AnalysisFilterRequest
    from services.filtering_endpoint import filter_reads_by_analysis_rule_for_request
    req = AnalysisFilterRequest(dataset_ids=['toy'], metric='value', operator='between', threshold=185, threshold_max=195,
                                molecule_metric='nuc.nrl')
    counts = [filter_reads_by_analysis_rule_for_request(st, req, chrom='chrT', start=a, end=b)['results']['toy']['filtered']
              for a, b in ((0, 300), (-200, 300))]
    assert counts == [1, 1]
