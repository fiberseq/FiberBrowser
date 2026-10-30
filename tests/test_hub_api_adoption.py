"""Browser integration gates for public scan and association APIs."""
from dataclasses import replace
from types import SimpleNamespace as NS
import threading

import numpy as np
import pytest

from test_hub_assoc import world, _defn, _bam, _dataset, _state, _scan


def test_cancel_during_engine_bootstrap(world):
    from services.hub.assoc import Cancelled, run
    stop = threading.Event()
    events = []
    def progress(stage, message):
        events.append(stage)
        if stage == 'bootstrap':
            stop.set()
    definition = _defn('M1', dict(kind='scan', setId=world.sets['fp.class'], typeId='fp.class'),
                       dict(kind='scan', setId=world.sets['nfr.region'], typeId='nfr.region'))
    with pytest.raises(Cancelled):
        run(world.state, definition, progress=progress, cancel=stop)
    assert 'bootstrap' in events
    assert 'store' not in events
    assert run(world.state, definition)['status'] == 'ok'  # callbacks cannot leak into the next run


def test_phasing_pools_datasets_with_distinct_calibrations(monkeypatch):
    import services.hub.assoc as browser
    from fiberhmm.assoc.simulate import simulate_nuc
    from fiberhmm.assoc.nucleosome import condition_stats
    from fiberhmm.nuc.calibration import NucCalibration
    from fiberhmm.nuc.density import BetaPrior
    sim = simulate_nuc(12, n_anchors=8, coverage=12, n_datasets=2)
    cals = {'d0': NucCalibration(), 'd1': replace(NucCalibration(), nrl_pooled=210., prior=BetaPrior(2., 5.))}
    decoded = {ds: ([m for m in sim['molecules'] if m.meta['dataset'] == ds], cal) for ds, cal in cals.items()}
    monkeypatch.setattr(browser, 'decoded_molecules', lambda *a, **kw: decoded)
    state = NS(datasets={ds: NS(data_type='bam', label=ds) for ds in decoded}, chroms=[])
    definition = browser.normalize_request(dict(mode='M2', a=dict(kind='anchors', anchors=[dict(chrom=c, pos=p) for c, p in sim['anchors']]),
        response=dict(kind='phasing'), group=dict(kind='dataset'), datasets=list(decoded), scope=dict(kind='scan'),
        options=dict(frames=['anchor'], metric='R', nPerm=20, nBoot=30, seed=4)))
    got = browser.run(state, definition)
    assert got['inputs']['perDataset']['d0']['nrlPooled'] != got['inputs']['perDataset']['d1']['nrlPooled']
    assert got['result']['calibration_by_dataset']['d1']['P'] == 210.
    direct = condition_stats(sim['molecules'], sim['anchors'], cal_by_dataset=cals,
        dataset_of=lambda m: m.meta['dataset'], labels={'dataset': lambda m: m.meta['dataset']}, group='dataset',
        frames=['anchor'], metrics=['R'], n_perm=20, n_role=20, n_boot=30, seed=4)
    bins = got['result']['frames']['anchor']['metrics']['R']['bins']
    expected = browser.jsonable(direct['frames']['anchor']['metrics']['R']['bins'])
    assert bins == expected
    contrasts = [r for b in bins for r in b.get('interaction', {}).get('differences', [])]
    assert contrasts and any(r.get('p_wald') is not None for r in contrasts)
    assert all({r['group'], r['reference']} == {'d0', 'd1'} for r in contrasts)
    assert any(e.get('interaction') for e in got['effects'])


def test_cross_scan_m3_maps_dataset_labels(tmp_path):
    from services.scan.registry import open_scan
    from services.hub.assoc_inputs import rate_data
    from fiberhmm.assoc.scanio import rate_data_from_marks
    from fiberhmm.scan.reader import ScanDir
    from test_hub_assoc import CONTIG
    names = [f'molecule_{i}' for i in range(8)]
    bam = _bam(tmp_path / 'input.bam', [(name, 1000, 2000, 0) for name in names])
    marks = [('nucseg', name, 1000, 2000, '1') for name in names] + [('nucseg', name, 2000, 3000, '2') for name in names]
    a = _scan(tmp_path / 'a', bam, fp_hits=[], nfr_hits=[], states=[], openness=[], marks=marks)
    hit = ('fp:class:example', 1200, 1240)
    b = _scan(tmp_path / 'b', bam, fp_hits=[hit], nfr_hits=[], states=[(hit[0], hit[1], hit[2], name, '1', '') for name in names],
              openness=[], dataset_id='other_label', scan_id='b' * 16)
    state = _state(_dataset('sample', bam))
    open_scan(state, a)
    opened = open_scan(state, b)
    set_id = next(s['setId'] for s in opened.sets(state) if s['typeId'] == 'fp.class')
    data, _m, _order, _used = rate_data(state, 'nuc.seg.regular', 'fp.class', [(CONTIG, 0, 5000)], b_ref=dict(kind='scan', setId=set_id))
    assert data.n == 8
    assert all(points.tolist() == [220] for points in data.points)
    assert set(data.labels['dataset']) == {'sample'}


def test_graph_points_follow_nodes_not_reference_substitution():
    from services.graph_panel.columns import Occ
    from services.hub.graph_overlay import graph_points
    canonical = {'a': Occ('a', 'shared', 10, False, (100, 110), [(0, 10)]),
                 'b': Occ('b', 'allele_a', 10, False, (110, 120), [(0, 10)])}
    other = {'c': Occ('c', 'shared', 10, True, (500, 510), [(2, 8)]),
             'd': Occ('d', 'allele_b', 10, False, (510, 520), [(0, 10)])}
    geometry = dict(canonical='a', occurrences={'a': canonical, 'b': other},
                    bindings={'b': dict(datasets=['sample'], contigs={'sample': 'source'}, hap='H1')})
    mapped, contig = graph_points(geometry, dict(datasetId='sample', graph=dict(hap='H1')), np.array([100, 102, 107, 109, 111]))
    assert contig == 'source'
    assert mapped.tolist() == [-1, 507, 502, -1, -1]
    other['repeat'] = Occ('repeat', 'shared', 10, False, (600, 610), [(0, 10)])
    assert (graph_points(geometry, dict(datasetId='sample'), np.array([102]))[0] == -1).all()


def test_generic_overlay_counts_states_and_unknowns(world):
    from services.hub.overlay import overlay
    from test_hub_assoc import CONTIG
    request = dict(loci=[dict(key='locus', chrom=CONTIG, start=10490, end=10510, anchor=10500)],
                   observations=[dict(obsId='a', datasetId='ds_a', kind='linear')], layer='layer:fpcls', align='left', flank=0, binBp=10)
    result = overlay(world.state, request)
    series = result['series'][0]
    assert series['molecules'] > 0
    assert max(series['den']) > max(series['num']) > 0
    assert all(a <= b for a, b in zip(series['num'], series['den']))


def test_held_out_discovers_on_opposite_hash_halves(monkeypatch):
    import services.hub.assoc as browser
    import services.hub.discovery as discovery
    from services.hub.assoc_inputs import HitTable
    from fiberhmm.assoc.simulate import simulate_nuc
    from fiberhmm.nuc.calibration import NucCalibration
    from fiberhmm.assoc.nucleosome import molecule_key
    sim = simulate_nuc(6, n_anchors=4, coverage=3, chrom_len=120_000, n_datasets=2)
    decoded = {ds: ([m for m in sim['molecules'] if m.meta['dataset'] == ds], NucCalibration()) for ds in ('d0', 'd1')}
    A = HitTable('nfr.region', 'NFRs', scan=NS(), hits=[dict(hitId=str(i), chrom=c, start=p-50, end=p+50, anchor=p)
                                                         for i, (c, p) in enumerate(sim['anchors'])])
    monkeypatch.setattr(browser, '_gather', lambda *a, **kw: A)
    monkeypatch.setattr(browser, 'decoded_molecules', lambda *a, **kw: decoded)
    discoveries = []
    def discover(ms, *args, **kwargs):
        discoveries.append({molecule_key(m) for m in ms})
        return sim['anchors']
    monkeypatch.setattr(discovery, 'discover_anchors', discover)
    state = NS(datasets={ds: NS(data_type='bam', label=ds) for ds in decoded}, chroms=[])
    definition = browser.normalize_request(dict(mode='M2', a=dict(kind='scan', setId='test'),
        response=dict(kind='phasing'), datasets=list(decoded), scope=dict(kind='scan'),
        options=dict(heldOut=True, frames=['anchor'], metric='R', nPerm=20, nBoot=0)))
    definition['scope'] = dict(kind='view', chrom='chrS', start=0, end=120_000)
    result = browser.run(state, definition)
    assert len(discoveries) == 2 and all(discoveries)
    assert not discoveries[0] & discoveries[1]
    assert discoveries[0] | discoveries[1] == {molecule_key(m) for m in sim['molecules']}
    held = result['result']['held_out']
    assert held['directions'][0]['discovered_on'] != held['directions'][0]['tested_on']
    assert held['cross_fit']


def test_discovery_territory_uses_done_zones_not_hit_neighborhoods():
    from services.hub.discovery import discovery_regions
    scan = NS(tables=NS(table=lambda _rel: NS(rows=lambda: iter([
        dict(chrom='chrT', start='0', end='50000', zone_start='0', zone_end='25000', status='done'),
        dict(chrom='chrT', start='12500', end='62500', zone_start='25000', zone_end='50000', status='done'),
        dict(chrom='chrT', start='37500', end='87500', zone_start='50000', zone_end='75000', status='pending')]))))
    assert discovery_regions(scan) == [('chrT', 0, 50000)]


def test_graph_overlay_prepares_columns_on_the_api_loop(monkeypatch):
    import asyncio
    from services.hub.graph_overlay import prepare_graph_loci
    from services.graph_panel import service
    from services.scan import graph_hits
    reg = NS(id='registration')
    async def ready():
        return NS(available=True)
    async def fetch(*args):
        return {'tiles': 'fixture'}
    monkeypatch.setattr(service, 'ensure_ready', ready)
    monkeypatch.setattr(service, 'registry', lambda: NS(get=lambda key: reg))
    monkeypatch.setattr(graph_hits, '_fetch', fetch)
    monkeypatch.setattr(graph_hits, '_sources', lambda *args: ['path'])
    monkeypatch.setattr(graph_hits, 'merged_occurrences', lambda *args: {'path': {}})
    monkeypatch.setattr(graph_hits, 'package_bindings', lambda *args: {'path': dict(datasets=['sample'])})
    request = dict(observations=[dict(kind='graph', datasetId='sample')], loci=[dict(chrom='chrT', start=100, end=200,
                   graph=dict(registration='registration', target='target', binding='path', anchor=[100, 200]))])
    result = asyncio.run(prepare_graph_loci(NS(), request))
    assert result['loci'][0]['_graph_geometry']['canonical'] == 'path'
    assert '_graph_geometry' not in request['loci'][0]


def test_dataset_phasing_compares_all_native_datasets_by_default():
    from services.hub.assoc import _anchor_datasets
    from services.hub.assoc_inputs import HitTable
    state = NS(datasets={'a': NS(data_type='bam'), 'b': NS(data_type='bam'), 'lift': NS(data_type='bam_livelift')})
    anchors = HitTable('nfr.region', 'NFRs', scan=NS(bound_pairs=lambda: [('sample', 'a', 'input', {})]))
    assert _anchor_datasets(state, dict(group=dict(kind='dataset')), anchors) == ['a', 'b']
    assert _anchor_datasets(state, dict(group=dict(kind='dataset'), datasets=['b']), anchors) == ['b']


def test_each_dataset_keeps_its_active_calibration(tmp_path):
    from services.hub.assoc_inputs import calibration_for
    from services.nuc.jobs import active_config, ActiveConfig
    from services.nuc.engine import resolve_settings
    from services.nuc.inputs import browser_read_policy
    from fiberhmm.nuc.calibration import NucCalibration
    state = NS()
    active_config(state, 'a')
    settings, key = resolve_settings(None)
    policy = browser_read_policy(state)
    calibrations = {'a': NucCalibration(nrl_pooled=180.), 'b': NucCalibration(nrl_pooled=205.)}
    for dataset, cal in calibrations.items():
        path = str(tmp_path / f'{dataset}.bam')
        ref = NS(digest=cal.digest(), calibration=cal)
        state.nuc_active[dataset] = ActiveConfig(settings, key, {path: ref}, policy)
        assert calibration_for(state, NS(browser_id=dataset, paths=[path])) is cal
