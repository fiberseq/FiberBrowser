"""Round-2 Gemini audit (backend, part b): scan overlays, read pipelines, hub windows, helpers.

Each test failed on the code before its fix."""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest


# --- M16: a scan overlay's nucpatch flags are molecular; reverse-strand rows read them in reference order ---------

class _Tables:
    def __init__(self, rows):
        self.rows = rows

    def has(self, name):
        return name == 'nuc/marks.tsv.bgz'

    def fetch(self, name, chrom, start, end):
        return list(self.rows) if name == 'nuc/marks.tsv.bgz' else []


def _overlay_state(monkeypatch, rows):
    from services.scan import overlay
    scan = NS(scan_id='s1', manifest_digest='d', tables=_Tables(rows),
              manifest={'modules': {'nuc': {'ma_groups': [
                  {'group': 'nucpatch', 'kind': 'mark', 'quality_names': ['score', 'period', 'flags']}]}}},
              bound_pairs=lambda: [])
    monkeypatch.setattr(overlay, 'overlay_scans', lambda state, ds: [(scan, ['sd'], {'nuc#marks': 'nucpatch'})])
    ds = NS(derived_layers={'nucpatch': {'kind': 'scan-overlay'}})
    return NS(datasets={'one': ds})


def _patch_row(flags):
    return dict(group='nucpatch', dataset_id='sd', qname='r1', record='', start='1000', end='2000',
                mol_len=1000, q=f'200,100,{flags}', name='')


@pytest.mark.parametrize('orientation, expected', [('forward', 1), ('reverse', 2)])
def test_scan_overlay_reads_patch_flags_in_reference_orientation(monkeypatch, orientation, expected):
    from services.scan.overlay import apply_scan_overlays
    st = _overlay_state(monkeypatch, [_patch_row(1)])     # bit 0: open at the molecular start
    read = dict(id='r1', reference_start=500, reference_end=3000, alignment_orientation=orientation, layers={})
    out = apply_scan_overlays(st, 'one', 'chrS', 0, 5000, [read])[0]
    assert out['layers']['nucpatch']['qualities'][2] == [expected]


# --- M16: the insertion lens keeps a nucreg layer's window-grid reach (not a per-interval list) -------------------

def test_insertion_lens_split_keeps_the_regularity_reach():
    from services.insertion_lens import split_at_breakpoints, to_lens_local
    layer = dict(intervals=[[0, 400, 400], [500, 900, 400]], qualities=[[10, 20], [30, 40]], reach=[-100, 1000],
                 scale=dict(zero=1.0, top=3.0, reference=True), lk='t:x:0', nuc_live=True)
    read = to_lens_local(dict(id='r', intervals=[], layers={'nucreg': layer}), 100)
    out = split_at_breakpoints(read, 450)['layers']['nucreg']
    assert out['reach'] == [-200, 900]
    assert out['scale'] == layer['scale'] and out['lk'] == 't:x:0' and out['nuc_live'] is True
    assert len(out['intervals']) == len(out['qualities'][0])


# --- M16: a quality filter keeps a layer's own fields (scale, reach, label key, patch generation, receipts) --------

@pytest.mark.parametrize('threshold, kept', [(15, 1), (99, 0)])
def test_quality_filter_keeps_layer_metadata(threshold, kept):
    from services.read_quality_filters import apply_quality_filters
    layer = dict(intervals=[[0, 400, 400], [500, 900, 400]], qualities=[[10, 20], [5, 5]],
                 quality_names=['score', 'period'], reach=[0, 1000], scale=dict(zero=1.0, top=3.0, reference=True),
                 lk='t:x:0', pg='0123456789abcdef', nuc_live=True, params_digest='d8', draw_style='fill')
    read = dict(id='r', intervals=[[0, 100, 100]], layers={'nucreg': layer})
    out = apply_quality_filters(read, [{'layer': 'nucreg', 'quality_name': 'score', 'min_value': threshold}])
    got = out['layers']['nucreg']
    assert len(got['intervals']) == kept
    for key in ('reach', 'scale', 'lk', 'pg', 'nuc_live', 'params_digest', 'draw_style'):
        assert got.get(key) == layer[key], key


# --- H14: shared peak windows step aside for MSPs inferred from legacy nucleosome gaps (window dependent) ----------

@pytest.mark.parametrize('layers, shared', [
    ({'footprint': True, 'msp': False, 'fire': False}, False),     # ns/nl only: MSPs inferred between in-window nucs
    ({'footprint': True, 'msp': True, 'fire': False}, True),       # explicit MSP calls
    ({'footprint': True, 'msp': False, 'fire': True}, True)])      # as/al FIRE elements
def test_shared_peak_windows_skip_datasets_with_inferred_msps(layers, shared):
    from services.hub.provider_states import browser_feature_states, shared_windows
    windows = []

    def build(ds, chrom, lo, hi, **kw):
        windows.append((lo, hi))
        return NS(reads=[])
    state = NS(datasets={'sample': NS(data_type='bam', available_layers=layers)}, build_working_set=build,
               max_working_reads=0)
    hits = [dict(setId='browser:peaks:p', hitId=f'p{a}', chrom='chrT', start=a, end=a + 60, anchor=a + 30,
                 datasets=['sample'], stateSpec={'kind': 'open'}) for a in (1000, 5000)]
    with shared_windows(state, hits):
        for h in hits:
            browser_feature_states(state, h['setId'], dict(id=h['hitId'], hub_hit=h))
    assert (windows == [(900, 5160)]) is shared


# --- M19.2: a timed-out count helper is stopped and replaced; only repeated failures turn it off -------------------

def test_count_helper_timeout_kills_the_worker_and_respawns(monkeypatch):
    import concurrent.futures as cf
    from services.nuc import record_count as rc

    class Proc:
        killed = 0

        def kill(self):
            Proc.killed += 1

    class Pool:
        made = 0

        def __init__(self):
            Pool.made += 1
            self._processes = {1: Proc()}
            self.closed = False

        def submit(self, fn, *a):
            fut = cf.Future()
            fut.set_exception(cf.TimeoutError())
            return fut

        def shutdown(self, wait=True, cancel_futures=False):
            self.closed = True
    pools = []

    def make():
        with rc._LOCK:
            if rc._POOL is None and not rc._BROKEN:
                rc._POOL = Pool()
                pools.append(rc._POOL)
            return rc._POOL
    monkeypatch.setattr(rc, 'USE_HELPER', True)
    monkeypatch.setattr(rc, '_POOL', None)
    monkeypatch.setattr(rc, '_BROKEN', False)
    monkeypatch.setattr(rc, '_FAILURES', 0, raising=False)
    monkeypatch.setattr(rc, '_pool', make)
    monkeypatch.setattr(rc, 'count_records', lambda *a, **k: 7)
    assert rc.count('x.bam', 'c', 0, 10) == 7
    assert not rc._BROKEN and Proc.killed == 1 and pools[0].closed and rc._POOL is None
    for _ in range(rc.MAX_HELPER_FAILURES - 1):
        assert rc.count('x.bam', 'c', 0, 10) == 7
    assert rc._BROKEN and Pool.made == rc.MAX_HELPER_FAILURES and Proc.killed == rc.MAX_HELPER_FAILURES


# --- H13.2: the cluster map's accessibility share reads a row's top-level FIRE elements (as layer_state_at does) ---

def test_cluster_summary_counts_top_level_fire_elements():
    from services.cluster_molecules import layer_state_at, summarize_read
    row = dict(reference_start=0, reference_end=1000, fire=[[100, 300, 0], [500, 600, 128]])
    assert layer_state_at(row, 0, 150) == 'fire'
    assert summarize_read(row, 0, 1000)['frac']['fire'] == 0.3
    # an MSP / FIRE layer, when the row has one, stays the share (no double count)
    both = dict(row, layers={'msp': {'intervals': [[100, 200, 100]]}})
    assert summarize_read(both, 0, 1000)['frac']['fire'] == 0.1


# --- H13.3: cluster map summaries are keyed by the consensus overlay's state, not only whether one is active -------

def test_cluster_molecule_identity_follows_the_consensus_overlay(monkeypatch):
    import threading
    from services import cluster_molecules as CM
    monkeypatch.setattr('services.background_work.dataset_identity', lambda state, ids: ('d',))
    monkeypatch.setattr('services.working_sets.read_load_token', lambda state, chrom: ('t',))
    state = NS(datasets={}, quality_filters=[])
    result_a, result_b = {'r': 1}, {'r': 2}
    jobs = {'a': dict(job_id='a', status='complete', result=result_a, filters={'tier': 1}, _curation={'revision': 0}),
            'b': dict(job_id='b', status='complete', result=result_b, filters={'tier': 1}, _curation={'revision': 0})}
    state.consensus_workflow_jobs, state.consensus_workflow_lock = jobs, threading.RLock()
    seen = []
    for active, change in (('a', None), ('b', None), ('b', 'filters'), ('b', 'curation')):
        if change == 'filters':
            jobs['b']['filters'] = {'tier': 2}
        if change == 'curation':
            jobs['b']['_curation'] = {'revision': 1}
        state.consensus_workflow_active = active
        seen.append(CM.read_source_identity(state, 'x', 'chrT'))
    assert len(set(map(repr, seen))) == 4


# --- H13.4: a DAF duplex read's source molecules (cs tag) count as shared, as FiberHMM's prepare_sources keys them --

def _bam(path, reads):
    import pysam
    header = pysam.AlignmentHeader.from_dict({'HD': {'VN': '1.6', 'SO': 'coordinate'},
                                              'SQ': [{'SN': 'chrT', 'LN': 10_000}]})
    with pysam.AlignmentFile(str(path), 'wb', header=header) as out:
        for name, cs in reads:
            a = pysam.AlignedSegment(header)
            a.query_name, a.reference_id, a.reference_start = name, 0, 100
            a.query_sequence, a.cigarstring, a.mapping_quality = 'A' * 200, '200M', 60
            if cs:
                a.set_tag('cs', cs)
            out.write(a)
    pysam.index(str(path))
    return str(path)


def test_shared_molecules_follow_duplex_source_names(tmp_path):
    from services.consensus_molecules import shared_molecules
    a = _bam(tmp_path / 'a.bam', [('mv1/7/duplex', 'mv1/5/ccs;mv1/6/ccs')])
    b = _bam(tmp_path / 'b.bam', [('mv1/5/ccs', None)])
    region = dict(chrom='chrT', start=0, end=10_000)
    shared = shared_molecules([dict(dataset_id='A', paths=[a], chemistry='ddda'),
                               dict(dataset_id='B', paths=[b], chemistry='ddda')], region)
    assert set(shared) == {'pacbio/mv1/5'} and shared['pacbio/mv1/5'] == {'A': {'mv1/7/duplex'}, 'B': {'mv1/5/ccs'}}
