"""Scan overlay edge paths: a quality-filtered tables-mode scan mark stays filtered on every display path.

The overlay must run before the per-layer quality filters; a row it changed carries a receipt naming the window, so
the display post-pass over the same window is a no-op. These paths applied the filters with no overlay first (or
lost the receipt), so the post-pass put the raw, unfiltered mark back:

- the sampled display working set (``build_sampled_display_working_set``, the default compact-reads path);
- the broad-cache hit of ``read_endpoint`` (read-ID filters, cluster focus, strand);
- a wrapped view of a circular contig: segments merged by ``merge_compact_reads_by_id`` (the receipt and the layers'
  overlay token were dropped, and each segment's receipt named its own window, not the wrapped view's).
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
                                                dataset_id='ds_a', include_layers=True, layer_names='fpcls',
                                                spanning=False, **kwargs)
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
