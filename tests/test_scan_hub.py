"""Feature hub H1 / B1 backend: scan tables, registry and binding, hits, per-read states (no FiberHMM needed).

Gates covered here:
- zero-width hits are fetched at their position;
- a scan binds to loaded datasets by content id (bound / stale / unbound), refuses a reference mismatch when
  nothing binds, and records a source frame when it binds to a file in another assembly;
- per-read states from states.tsv.bgz: native datasets keyed by read name (disagreeing records give '.'),
  live-lift datasets keyed by record key, so a record's split rows get its own state;
- /api/features/states routes hub refs to the scan provider and keeps the legacy kinds as they were;
- the browser's MAGroupFrame treats scan contract groups as molecular.
"""
from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')

from scan_fixtures import tiny_bam, write_scan_dir


def _state(datasets=(), chroms=(('chrT', 100_000),)):
    st = NS(datasets={}, chroms=[NS(name=n, size=s) for n, s in chroms])
    for ds in datasets:
        st.datasets[ds.id] = ds
    return st


def _dataset(ds_id, path, data_type='bam', **extra):
    from models.domain import Dataset
    ds = Dataset(ds_id, path, label=ds_id.upper())
    ds.data_type = data_type
    for k, v in extra.items():
        setattr(ds, k, v)
    return ds


@pytest.fixture
def bam(tmp_path):
    return tiny_bam(tmp_path / 'a.bam', reads=(('m1/1/ccs', 1000, 0), ('m1/2/ccs', 1100, 0), ('m1/3/ccs', 1200, 2048)))


HITS = [(1200, 1220, 'fp:class:chrT:1210:aaaaaaaa', 'class_001'), (5000, 5000, 'fp:class:chrT:5000:bbbbbbbb', 'class_002')]
VALUES = [('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'dataset_1::pooled', 'channel', 'prevalence', 0.4, 20),
          ('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'dataset_1::pooled', 'channel', 'support_gain_nats', 3.5, 20)]


def test_tables_zero_width_rows_fetch_at_position(tmp_path, bam):
    from services.scan.tables import Table
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    t = Table(d / 'fp' / 'hits.tsv.bgz')
    got = t.fetch('chrT', 5000, 5001)
    assert [r['hit_id'] for r in got] == ['fp:class:chrT:5000:bbbbbbbb']
    assert got[0]['start'] == got[0]['end'] == 5000
    assert t.fetch('chrT', 4000, 4999) == []
    assert t.fetch('chrX', 0, 10) == []


def test_content_id_matches_fiberhmm_definition(tmp_path, bam):
    import hashlib
    from services.scan.identity import content_id
    data = Path(bam).read_bytes()
    h = hashlib.sha256(b'cid:v1\n' + str(len(data)).encode() + b'\n' + data[:1 << 20] + data[-(1 << 20):])
    assert content_id(bam) == 'cid:v1:' + h.hexdigest()
    try:
        from fiberhmm.scan.identity import content_id as fh
    except ImportError:
        return
    assert content_id(bam) == fh(bam)


def test_registry_binds_by_content_id_and_lists_sets(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS, values=VALUES)
    st = _state([_dataset('ds_a', bam)])
    scan = registry.open_scan(st, d)
    assert scan.bindings['dataset_1'] == dict(dataset='ds_a', status='bound', via='input', files={'0': bam}, also=[])
    (fp_set,) = scan.sets(st)
    assert fp_set['setId'].startswith('hub:') and fp_set['typeId'] == 'fp.class' and fp_set['count'] == 2
    assert fp_set['datasets'] == ['ds_a']
    assert [g['label'] for g in fp_set['groups']] == ['All', 'DS_A']
    assert registry.find_set(st, fp_set['setId'])[1:] == ('fp', 'fp.class')
    # The same scan reopened keeps its set id.
    again = registry.open_scan(st, d)
    assert again.sets(st)[0]['setId'] == fp_set['setId']


def test_registry_stale_and_unbound(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    other = tmp_path / 'b'
    other.mkdir()
    changed = tiny_bam(other / 'a.bam', reads=(('m9/1/ccs', 2000, 0),))   # same file name, other content
    st = _state([_dataset('ds_b', changed)])
    scan = registry.open_scan(st, d)
    assert scan.bindings['dataset_1']['status'] == 'stale'
    assert scan.sets(st)[0]['status'] == 'stale'
    st2 = _state([])
    scan2 = registry.open_scan(st2, d)
    assert scan2.bindings['dataset_1']['status'] == 'unbound'
    assert 'scan of other files' in scan2.sets(st2)[0]['note']


def test_registry_reference_mismatch(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    with pytest.raises(registry.ScanOpenError, match='Reference mismatch'):
        registry.open_scan(_state([], chroms=(('chrT', 99_999),)), d)
    with pytest.raises(registry.ScanOpenError, match='no contig'):
        registry.open_scan(_state([], chroms=(('chr1', 1000),)), d)
    # Bound to a loaded file (a live-lift dataset's source BAM in its own assembly): opened, frame 'source'.
    st = _state([_dataset('lifted', bam, data_type='bam_livelift')], chroms=(('chr1', 1000),))
    scan = registry.open_scan(st, d)
    assert scan.frame['kind'] == 'source' and scan.frame['liftedDatasets'] == ['lifted']
    assert 'source assembly' in scan.sets(st)[0]['note']


def test_registry_refuses_incomplete_and_foreign_dirs(tmp_path, bam):
    from services.scan import registry
    with pytest.raises(registry.ScanOpenError, match='No manifest'):
        registry.open_scan(_state(), tmp_path)
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    (d / 'fp' / 'hits.tsv.bgz.tbi').unlink()
    with pytest.raises(registry.ScanOpenError, match='missing index'):
        registry.open_scan(_state(), d)
    m = json.loads((d / 'manifest.json').read_text())
    m['schema'] = 'other'
    (d / 'manifest.json').write_text(json.dumps(m))
    with pytest.raises(registry.ScanOpenError, match='Schema'):
        registry.open_scan(_state(), d)


def test_hits_for_view_role_columns_and_padding(tmp_path, bam):
    from services.scan import registry, serve
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS, values=VALUES)
    st = _state([_dataset('ds_a', bam)])
    scan = registry.open_scan(st, d)
    got = serve.hits_for_view(scan, 'fp', 'chrT', 1210, 1215)
    (h,) = got['hits']
    assert h['hitId'] == 'fp:class:chrT:1210:aaaaaaaa' and h['label'] == 'class_001'
    assert h['columns']['all']['prevalence']['v'] == 0.4
    assert h['columns']['dataset_1']['prevalence']['v'] == 0.4
    assert h['columns']['dataset_1']['strength']['v'] == 3.5
    assert h['columns']['dataset_1']['prevalence']['n'] == 20
    zw = serve.hits_for_view(scan, 'fp', 'chrT', 5000, 5001)['hits']
    assert [x['zeroWidth'] for x in zw] == [True]
    assert serve.hits_for_view(scan, 'fp', 'chrT', 5001, 6000)['hits'] == []
    assert serve.find_hit(scan, 'fp', 'fp:class:chrT:5000:bbbbbbbb')['label'] == 'class_002'


def _states_scan(tmp_path, bam):
    states = [
        ('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/1/ccs', 'r1:0', '1'),
        ('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/2/ccs', 'r2:0', '0'),
        # one QNAME, two records (primary and supplementary) that disagree
        ('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/3/ccs', 'r3:0', '1'),
        ('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/3/ccs', 'r4:0', '0'),
        ('fp:class:chrT:5000:bbbbbbbb', 5000, 5000, 'm1/1/ccs', 'r1:0', '0'),
    ]
    return write_scan_dir(tmp_path / 'scan', bam, hits=HITS, values=VALUES, states=states)


def test_states_native_keyed_by_name(tmp_path, bam):
    from services.scan import registry
    from services.feature_states import feature_states
    d = _states_scan(tmp_path, bam)
    st = _state([_dataset('ds_a', bam)])
    set_id = registry.open_scan(st, d).sets(st)[0]['setId']
    out = feature_states(st, [{'kind': 'fp-class', 'source': set_id, 'id': 'fp:class:chrT:1210:aaaaaaaa'},
                              {'kind': 'fp-class', 'source': set_id, 'id': 'fp:class:chrT:5000:bbbbbbbb'}])
    assert out['by_dataset'] == {'ds_a': {'m1/1/ccs': '10', 'm1/2/ccs': '0.', 'm1/3/ccs': '..'}}
    info = out['features'][0]
    assert info['members'] == {'ds_a': 1} and info['evaluated'] == {'ds_a': 2} and info['span'] == [1200, 1220]


def test_states_live_lift_keyed_by_record(tmp_path, bam):
    """Lifted split rows of one record share its record key; two records of one QNAME stay apart (not '.')."""
    from services.scan import registry
    from services.scan.states import hub_feature_states
    from services.lift.cohort import record_key, analysis_id
    from services.lift.live_lift import LiftSettings
    d = _states_scan(tmp_path, bam)
    settings = LiftSettings()
    ds = _dataset('lifted', bam, data_type='bam_livelift', live_lift=NS(settings=settings))
    st = _state([ds])
    set_id = registry.open_scan(st, d).sets(st)[0]['setId']
    states, datasets, _label, _span = hub_feature_states(st, set_id, {'id': 'fp:class:chrT:1210:aaaaaaaa'})
    assert datasets == ['lifted']
    group = settings.molecule_group_map([bam], 'lifted')[bam]
    from services.lift.joint import molecule_key
    def rk(qname, record):
        return record_key(analysis_id({'id': qname, 'live_lift': {'molecule': molecule_key(group, qname), 'record': record,
                                                                     'row_index': 1, 'placement': 'primary'}}, settings))
    assert states[('lifted', rk('m1/3/ccs', 'r3:0'))] == '1'
    assert states[('lifted', rk('m1/3/ccs', 'r4:0'))] == '0'
    assert states[('lifted', rk('m1/1/ccs', 'r1:0'))] == '1'
    # fold_molecule: one key per molecule, its records combined (they disagree: '.')
    folded = LiftSettings(fold_molecule=True)
    ds.live_lift = NS(settings=folded)
    states, *_ = hub_feature_states(st, set_id, {'id': 'fp:class:chrT:1210:aaaaaaaa'})
    keys = {k[1] for k in states}
    assert len(keys) == 3 and states[('lifted', record_key(analysis_id(
        {'id': 'm1/3/ccs', 'live_lift': {'molecule': molecule_key(group, 'm1/3/ccs'), 'record': 'r3:0', 'row_index': 0,
                                         'placement': 'primary'}}, folded)))] == '.'


def test_feature_states_routing_and_legacy_kinds(tmp_path, bam):
    from services import feature_states as fs
    with pytest.raises(ValueError, match='dataset_id'):
        fs._clean([{'kind': 'fp-class', 'source': 'job1', 'id': 'f1'}])
    assert fs._clean([{'kind': 'fp-class', 'source': 'job1', 'id': 'f1', 'dataset_id': 'a'}])[0]['dataset_id'] == 'a'
    with pytest.raises(ValueError, match='needs kind'):
        fs._clean([{'kind': 'peaks-peak', 'source': 'job1', 'id': 'f1'}])
    # Any kind of a hub set goes to the scan provider (no kind string checks).
    assert fs._provider('peaks-peak', 'hub:0123')[0].__name__ == 'hub_feature_states'
    st = _state([])
    with pytest.raises(ValueError, match='not open'):
        fs.feature_states(st, [{'kind': 'fp-class', 'source': 'hub:0000000000000000', 'id': 'x'}])


def test_scan_contract_groups_are_molecular():
    from services.bam_tags import MAGroupFrame
    header = pysam.AlignmentHeader.from_dict({
        'HD': {'VN': '1.6'}, 'SQ': [{'SN': 'chrT', 'LN': 1000}],
        'PG': [{'ID': 'fiberhmm-apply', 'PN': 'fiberhmm-apply', 'VN': '2.10.0'}],
        'CO': ['FIBERHMM-SCAN-MA:v1:' + json.dumps({'group': 'fpcls', 'kind': 'state', 'coordinates': 'molecular'})]})
    frame = MAGroupFrame.of_header(header)
    assert frame.is_molecular('fpcls', '+')
    assert frame.is_molecular('fpcls', '.')


def test_scan_routes(tmp_path, bam):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.scan import router
    from state.dependencies import get_state
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS, values=VALUES)
    st = _state([_dataset('ds_a', bam)])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: st
    client = TestClient(app)
    r = client.post('/api/scan/open', json={'path': str(d)})
    assert r.status_code == 200, r.text
    info = r.json()
    assert info['datasets'][0]['dataset'] == 'ds_a' and info['sets'][0]['typeId'] == 'fp.class'
    r = client.get(f'/api/scan/{info["scanId"]}/hits', params=dict(module='fp', chrom='chrT', start=0, end=10_000))
    assert [h['label'] for h in r.json()['hits']] == ['class_001', 'class_002']
    assert client.get('/api/scan/nope/hits', params=dict(module='fp', chrom='chrT', start=0, end=10)).status_code == 404
    assert client.post('/api/scan/open', json={'path': str(tmp_path / 'missing')}).status_code == 422
    assert len(client.get('/api/scan/list').json()['scans']) == 1
    assert client.delete(f'/api/scan/{info["scanId"]}').json() == {'closed': True}


def test_overlay_puts_states_on_native_reads(tmp_path, bam):
    from services.scan import registry
    from services.scan.overlay import apply_scan_overlays
    d = _states_scan(tmp_path, bam)
    ds = _dataset('ds_a', bam)
    st = _state([ds])
    registry.open_scan(st, d)
    assert ds.available_layers.get('fpcls') and ds.derived_layers['fpcls']['kind'] == 'scan-overlay'
    reads = [dict(id='m1/1/ccs', start=1000, end=1500, layers={}), dict(id='m1/2/ccs', start=1100, end=1600, layers={}),
             dict(id='other', start=1000, end=1500, layers={'nuc': {'intervals': []}})]
    out = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, reads)
    assert out[0]['layers']['fpcls']['intervals'] == [[200, 220, 20]] and out[0]['layers']['fpcls']['qualities'][0] == [1]
    assert out[0]['layers']['fpcls']['quality_names'] == ['q0', 'q1', 'q2']      # state, posterior, tier as fpcls.QQQ
    assert out[1]['layers']['fpcls']['qualities'][0] == [2]
    assert out[2] is reads[2]
    again = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, out)
    assert all(a is b for a, b in zip(again, out))   # an exact second pass keeps the row objects
    registry.close_scan(st, registry.list_scans(st)[0].scan_id)
    assert 'fpcls' not in ds.available_layers and 'fpcls' not in ds.derived_layers


def test_role_columns_nuc_patches_and_haplotypes():
    from services.scan.serve import role_columns
    cell = lambda v, n=10: dict(v=v, lo=None, hi=None, n=n, nCallable=n)
    raw = {'all': {'fraction': cell(0.5)}, 'dataset_1': {'fraction': cell(0.6)}, 'dataset_1:HP1': {'fraction': cell(0.7)}}
    kinds = {'all': 'all', 'dataset_1': 'dataset', 'dataset_1:HP1': 'haplotype'}
    # Any type outside the contract's §7 roles (nuc's patches, whose scores will change) uses its declared roles.
    cols = role_columns('nuc.patch.regular', raw, kinds, ['dataset_1'], {'prevalence': 'fraction'})
    assert cols['all']['prevalence']['v'] == 0.5 and cols['dataset_1']['prevalence']['v'] == 0.6
    assert cols['dataset_1:HP1']['prevalence']['v'] == 0.7
    phased = role_columns('nuc.patch.phased', {'dataset_1': {'R_minus_null': cell(0.2)}}, {'dataset_1': 'dataset'}, ['dataset_1'],
                          {'strength': 'R_minus_null'})
    assert phased['dataset_1']['strength']['v'] == 0.2 and 'prevalence' not in phased['dataset_1']
    renamed = role_columns('nuc.patch.fuzzy', {'all': {'dephased': cell(0.4)}}, {'all': 'all'}, [], {'prevalence': 'dephased'})
    assert renamed['all']['prevalence']['v'] == 0.4


def test_score_roles_of_scan_types():
    from services.scan.registry import _camel_type
    def decl(type_id, *names):
        return dict(type_id=type_id, module=type_id.split('.')[0], provides=['hit'],
                    scores=[dict(name=n, label=n, kind='fraction', better='high', per_group=True) for n in names])
    assert _camel_type(decl('fp.class', 'prevalence', 'support_gain_nats'))['roles'] == {'prevalence': 'prevalence', 'strength': 'support_gain_nats'}
    def typed(type_id, *scores):
        return dict(type_id=type_id, module='nuc', provides=['hit'],
                    scores=[dict(name=n, label=n, kind=k, better='high', per_group=g) for n, k, g in scores])
    # Roles come from the declarations (names, kinds, per-group), not from module-specific score names.
    assert _camel_type(typed('nuc.patch.regular', ('fraction', 'fraction', True), ('q_hat', 'bp', False)))['roles'] == {'prevalence': 'fraction'}
    assert _camel_type(typed('nuc.patch.phased', ('R_minus_null', 'z', True), ('P', 'bp', False), ('p', 'q', False)))['roles'] == {'strength': 'R_minus_null'}
    assert _camel_type(typed('nuc.patch.future', ('share', 'fraction', True), ('dephasing', 'nats', True)))['roles'] == {'prevalence': 'share', 'strength': 'dephasing'}
    # the contract's own roles for its types (§7): peaks' score is their strength
    assert _camel_type(typed('peaks.peak', ('score', 'fraction', True), ('tier', 'code', False)))['roles'] == {'strength': 'score'}


def test_overlay_mark_groups_from_marks_table(tmp_path, bam):
    """A tables-mode nuc scan: its nucsz / nucseg marks become layers with their bytes as q0..qN."""
    from scan_fixtures import row, write_table
    from services.scan import registry
    from services.scan.overlay import apply_scan_overlays
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    write_table(d / 'nuc' / 'marks.tsv.bgz', ['group', 'dataset_id', 'qname', 'record', 'molecule', 'mol_start', 'mol_len', 'q', 'name'],
                [row('chrT', 1010, 1157, 'nucsz', 'dataset_1', 'm1/1/ccs', 'r1:0', 'mol:v1 0', 11, 147, '2,0,230,128', 'nucsz@ab_0'),
                 row('chrT', 1000, 1400, 'nucseg', 'dataset_1', 'm1/1/ccs', 'r1:0', 'mol:v1 0', 1, 400, '1,200,85', 'nucseg@ab_0')], {'chrT': 0})
    m = json.loads((d / 'manifest.json').read_text())
    m['modules']['nuc'] = {'version': '1.0', 'settings_hash': 'n' * 16, 'feature_types': [],
                           'ma_groups': [{'group': 'nucsz', 'kind': 'mark'}, {'group': 'nucseg', 'kind': 'mark'}, {'group': 'nucmol', 'kind': 'scalar'}]}
    m['outputs']['tables']['nuc/marks.tsv.bgz'] = dict(rows=2, sha256='')
    (d / 'manifest.json').write_text(json.dumps(m))
    ds = _dataset('ds_a', bam)
    st = _state([ds])
    registry.open_scan(st, d)
    assert ds.derived_layers['nucsz']['kind'] == 'scan-overlay' and ds.available_layers['nucseg']
    (read,) = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, [dict(id='m1/1/ccs', start=1000, end=1500, layers={})])
    assert read['layers']['nucsz']['intervals'] == [[10, 157, 147]]
    assert read['layers']['nucsz']['qualities'] == [[2], [0], [230], [128]] and read['layers']['nucsz']['quality_names'] == ['q0', 'q1', 'q2', 'q3']
    assert read['layers']['nucseg']['annotation_names'] == ['nucseg@ab_0']


def _two_file_scan(tmp_path, bam_a, bam_b, states=()):
    from services.scan.identity import content_id
    d = write_scan_dir(tmp_path / 'scan2', bam_a, hits=HITS, values=VALUES, states=states)
    m = json.loads((d / 'manifest.json').read_text())
    m['datasets'][0]['files'].append({'name': Path(bam_b).name, 'path': bam_b, 'input_index': 1, 'content_id': content_id(bam_b), 'size': 1})
    (d / 'manifest.json').write_text(json.dumps(m))
    return d


def test_registry_binds_a_multi_file_dataset_only_whole(tmp_path, bam):
    """A scan dataset of files A + B binds to a loaded dataset holding both, never to A alone (B's rows would be
    attributed to it)."""
    from services.scan import registry
    other = tmp_path / 'b'
    other.mkdir()
    bam_b = tiny_bam(other / 'b.bam', reads=(('m2/1/ccs', 1100, 0),))
    d = _two_file_scan(tmp_path, bam, bam_b)
    st = _state([_dataset('only_a', bam)])
    scan = registry.open_scan(st, d)
    assert scan.bindings['dataset_1']['status'] == 'partial'
    assert scan.dataset_of_browser('only_a') is None
    st2 = _state([_dataset('both', [bam, bam_b])])
    scan2 = registry.open_scan(st2, d)
    assert scan2.bindings['dataset_1']['status'] == 'bound' and scan2.bindings['dataset_1']['files'] == {'0': bam, '1': bam_b}


def test_registry_refuses_paths_outside_the_scan_directory(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    outside = tmp_path / 'elsewhere'
    outside.mkdir()
    (d / 'fp' / 'hits.tsv.bgz').rename(outside / 'hits.tsv.bgz')
    (d / 'fp' / 'hits.tsv.bgz.tbi').rename(outside / 'hits.tsv.bgz.tbi')
    (d / 'fp' / 'hits.tsv.bgz').symlink_to(outside / 'hits.tsv.bgz')
    (d / 'fp' / 'hits.tsv.bgz.tbi').symlink_to(outside / 'hits.tsv.bgz.tbi')
    with pytest.raises(registry.ScanOpenError, match='outside the scan directory'):
        registry.open_scan(_state(), d)
    m = json.loads((d / 'manifest.json').read_text())
    m['outputs']['tables'] = {'../escape.tsv.bgz': {'rows': 0}}
    (d / 'manifest.json').write_text(json.dumps(m))
    with pytest.raises(registry.ScanOpenError, match='outside the scan directory'):
        registry.open_scan(_state(), d)


def test_states_live_lift_multi_file_use_each_records_file(tmp_path):
    """Two files in one live-lift dataset: a record of the second file is keyed with the second file's group."""
    from services.scan import registry
    from services.scan.identity import content_id
    from services.scan.states import hub_feature_states
    from services.lift.live_lift import LiftSettings
    from services.lift.joint import molecule_key
    a_dir, b_dir = tmp_path / 'a', tmp_path / 'b'
    a_dir.mkdir(); b_dir.mkdir()
    bam_a = tiny_bam(a_dir / 'a.bam', reads=(('m1/1/ccs', 1000, 0),))
    bam_b = tiny_bam(b_dir / 'b.bam', reads=(('m2/2/ccs', 1050, 0),))
    rec_b = next(iter(__import__('services.scan.states', fromlist=['x'])._records_in(bam_b, 'chrT', 1000, 1600)))
    d = _two_file_scan(tmp_path, bam_a, bam_b, states=[('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm2/2/ccs', rec_b, '1')])
    settings = LiftSettings()
    ds = _dataset('lifted', [bam_a, bam_b], data_type='bam_livelift', live_lift=NS(settings=settings))
    st = _state([ds])
    set_id = registry.open_scan(st, d).sets(st)[0]['setId']
    states, *_ = hub_feature_states(st, set_id, {'id': 'fp:class:chrT:1210:aaaaaaaa'})
    groups = settings.molecule_group_map([bam_a, bam_b], 'lifted')
    from services.lift.cohort import _encode_record
    assert states == {('lifted', _encode_record([molecule_key(groups[bam_b], 'm2/2/ccs'), 'm2/2/ccs', rec_b])): '1'}


def test_overlay_marks_go_to_their_own_record(tmp_path, bam):
    """A read name with a primary and a supplementary: each row gets only its own record's mark."""
    from services.scan import registry
    from services.scan.overlay import apply_scan_overlays
    states = [('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/3/ccs', 'p:0', '1'),
              ('fp:class:chrT:5000:bbbbbbbb', 5000, 5000, 'm1/3/ccs', 's:0', '0')]
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS, values=VALUES, states=states)
    st = _state([_dataset('ds_a', bam)])
    registry.open_scan(st, d)
    rows = [dict(id='m1/3/ccs', reference_start=1000, reference_end=1500, layers={}),
            dict(id='m1/3/ccs', reference_start=4800, reference_end=5300, layers={}),
            dict(id='m1/3/ccs', record_sha256='s', alignment_occurrence=0, reference_start=0, reference_end=9000, layers={})]
    out = apply_scan_overlays(st, 'ds_a', 'chrT', 0, 9000, rows)
    assert out[0]['layers']['fpcls']['annotation_names'] == ['fp:class:chrT:1210:aaaaaaaa']
    assert out[1]['layers']['fpcls']['annotation_names'] == ['fp:class:chrT:5000:bbbbbbbb']
    assert out[2]['layers']['fpcls']['annotation_names'] == ['fp:class:chrT:5000:bbbbbbbb']


def test_registry_keeps_one_entry_per_directory(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    st = _state([_dataset('ds_a', bam)])
    first = registry.open_scan(st, d, source='cache')
    set_id = first.sets(st)[0]['setId']
    m = json.loads((d / 'manifest.json').read_text())
    m['scan_id'] = 'fedcba9876543210'          # the cache grew: another scan id, the same directory
    (d / 'manifest.json').write_text(json.dumps(m))
    second = registry.open_scan(st, d, source='cache')
    assert [s.scan_id for s in registry.list_scans(st)] == ['fedcba9876543210']
    assert second.sets(st)[0]['setId'] == set_id   # cache set ids follow the directory


def test_scan_routes_refused_on_lab_member_requests(tmp_path, bam, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import services.lab.paths as lab_paths
    from routers.scan import router
    from state.dependencies import get_state
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    st = _state([_dataset('ds_a', bam)])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: st
    monkeypatch.setattr(lab_paths, 'enforcing', lambda: True)
    client = TestClient(app)
    assert client.post('/api/scan/open', json={'path': str(d)}).status_code == 403
    assert client.get('/api/scan/list').status_code == 403
    assert client.post('/api/scan/jobs', json={}).status_code == 403


def test_manifest_link_out_of_the_directory_is_refused(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    private = tmp_path / 'private'
    private.mkdir()
    (d / 'manifest.json').rename(private / 'manifest.json')
    (d / 'manifest.json').symlink_to(private / 'manifest.json')
    with pytest.raises(registry.ScanOpenError, match='outside the scan directory'):
        registry.open_scan(_state(), d)


def test_low_memory_cap_is_a_ceiling_over_explicit_caps():
    from services.scan.planning import read_policy
    st = NS(performance={'effective': 'low', 'max_working_reads': 15000})
    assert read_policy(st, caps={'max_discovery_molecules': 10})['caps'] == {'max_discovery_molecules': 10, 'max_quantification_molecules': 15000}
    assert read_policy(NS(performance={'effective': 'standard'}), caps={})  == {}


def test_effective_peak_rules_follow_the_plan(tmp_path, bam):
    from services.scan.planning import _effective_peak_rules, _scan_peak_rules
    from services.scan import registry
    lone = [dict(mode='bed', left=None, right=None)]
    grid = [dict(mode='grid', left=None, right='x'), dict(mode='grid', left='y', right=None)]
    auto = {'tier_rule': 'auto', 'row_rule': 'auto'}
    assert _effective_peak_rules(auto, lone) == ('window', 'view')
    assert _effective_peak_rules(auto, grid) == ('local', 'records')
    assert _effective_peak_rules(auto, lone + grid) == ('local', 'records')
    assert _effective_peak_rules({'tier_rule': 'local', 'row_rule': 'records'}, lone) == ('local', 'records')
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    (d / 'peaks' / 'extra').mkdir(parents=True)
    (d / 'peaks' / 'extra' / 'calibration.json').write_text(json.dumps({'tier_rule': 'window', 'row_rule': 'view'}))
    scan = registry.open_scan(_state([_dataset('ds_a', bam)]), d)
    assert _scan_peak_rules(scan) == ('window', 'view')


def test_states_identical_record_in_two_files(tmp_path):
    """The tables name no input file: identical records in two files agree -> both keyed; disagree -> '.'."""
    from services.scan import registry
    from services.scan.states import hub_feature_states, _records_in
    from services.lift.live_lift import LiftSettings
    from services.lift.cohort import _encode_record
    from services.lift.joint import molecule_key
    a_dir, b_dir = tmp_path / 'a', tmp_path / 'b'
    a_dir.mkdir(); b_dir.mkdir()
    reads = (('m1/1/ccs', 1000, 0),)
    bam_a = tiny_bam(a_dir / 'a.bam', reads=reads)
    bam_b = tiny_bam(b_dir / 'b.bam', reads=reads + (('m9/9/ccs', 3000, 0),))   # same record, different file
    rec = next(iter(_records_in(bam_a, 'chrT', 900, 1600)))
    assert rec in _records_in(bam_b, 'chrT', 900, 1600)
    settings = LiftSettings()
    groups = settings.molecule_group_map([bam_a, bam_b], 'lifted')
    key = lambda path: _encode_record([molecule_key(groups[path], 'm1/1/ccs'), 'm1/1/ccs', rec])
    # one row for two files: one copy may never have been evaluated (a cap keeps one of them) -> '.'
    for states, want in ((['1', '1'], '1'), (['1', '0'], '.'), (['1'], '.')):
        d = _two_file_scan(tmp_path / f'case_{"".join(states)}', bam_a, bam_b,
                           states=[('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/1/ccs', rec, st) for st in states])
        ds = _dataset('lifted', [bam_a, bam_b], data_type='bam_livelift', live_lift=NS(settings=settings))
        st = _state([ds])
        set_id = registry.open_scan(st, d).sets(st)[0]['setId']
        got, *_ = hub_feature_states(st, set_id, {'id': 'fp:class:chrT:1210:aaaaaaaa'})
        assert got == {('lifted', key(bam_a)): want, ('lifted', key(bam_b)): want}


def test_overlay_every_scan_dataset_bound_to_one_dataset_and_molecular_size(tmp_path):
    from scan_fixtures import row, write_table
    from services.scan import registry
    from services.scan.identity import content_id
    from services.scan.overlay import apply_scan_overlays
    a_dir, b_dir = tmp_path / 'a', tmp_path / 'b'
    a_dir.mkdir(); b_dir.mkdir()
    bam_a = tiny_bam(a_dir / 'a.bam', reads=(('m1/1/ccs', 1000, 0),))
    bam_b = tiny_bam(b_dir / 'b.bam', reads=(('m2/2/ccs', 1000, 0),))
    d = write_scan_dir(tmp_path / 'scan', bam_a, hits=HITS, states=[
        ('fp:class:chrT:1210:aaaaaaaa', 1200, 1220, 'm1/1/ccs', 'r1:0', '1')])
    m = json.loads((d / 'manifest.json').read_text())
    m['datasets'].append({'dataset_id': 'dataset_2', 'ordinal': 1, 'chemistry': None,
                          'files': [{'name': 'b.bam', 'path': bam_b, 'input_index': 0, 'content_id': content_id(bam_b), 'size': 1}]})
    (d / 'manifest.json').write_text(json.dumps(m))
    write_table(d / 'fp' / 'states.tsv.bgz', ['hit_id', 'dataset_id', 'qname', 'record', 'molecule', 'state'],
                [row('chrT', 1200, 1220, 'fp:class:chrT:1210:aaaaaaaa', 'dataset_1', 'm1/1/ccs', 'r1:0', 'mol:v1 0', '1'),
                 row('chrT', 1200, 1220, 'fp:class:chrT:1210:aaaaaaaa', 'dataset_2', 'm2/2/ccs', 'r2:0', 'mol:v1 0', '0')], {'chrT': 0})
    write_table(d / 'nuc' / 'marks.tsv.bgz', ['group', 'dataset_id', 'qname', 'record', 'molecule', 'mol_start', 'mol_len', 'q', 'name'],
                [row('chrT', 1010, 2157, 'nucsz', 'dataset_1', 'm1/1/ccs', 'r1:0', 'mol:v1 0', 11, 147, '2,0,230,128', 'nucsz@ab_0')], {'chrT': 0})
    m = json.loads((d / 'manifest.json').read_text())
    m['modules']['nuc'] = {'version': '1.0', 'settings_hash': 'n' * 16, 'feature_types': [], 'ma_groups': [{'group': 'nucsz', 'kind': 'mark'}]}
    m['outputs']['tables']['nuc/marks.tsv.bgz'] = dict(rows=1, sha256='')
    (d / 'manifest.json').write_text(json.dumps(m))
    st = _state([_dataset('merged', [bam_a, bam_b])])
    scan = registry.open_scan(st, d)
    assert scan.datasets_of_browser('merged') == ['dataset_1', 'dataset_2']
    out = apply_scan_overlays(st, 'merged', 'chrT', 1000, 3000, [dict(id='m1/1/ccs', reference_start=1000, reference_end=2500, layers={}),
                                                                 dict(id='m2/2/ccs', reference_start=1000, reference_end=1500, layers={})])
    assert out[0]['layers']['fpcls']['qualities'][0] == [1] and out[1]['layers']['fpcls']['qualities'][0] == [2]
    assert out[0]['layers']['nucsz']['intervals'] == [[10, 1157, 147]]   # molecular length, not the 1147 bp span


def test_session_import_disposes_scans_and_live_scans(tmp_path, bam):
    import threading
    from services.scan import registry, jobs
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    st = _state([_dataset('ds_a', bam)])
    registry.open_scan(st, d)
    js, lock = jobs._session(st)
    js['j1'] = dict(job_id='j1', status='running', created_at=0, _cancel=threading.Event())
    jobs.dispose_session(st)
    assert registry.list_scans(st) == []
    assert js['j1']['_cancel'].is_set() and js['j1']['_disposed'] and js['j1']['status'] == 'cancelling'


def test_scan_generation_refuses_registrations_for_a_replaced_session(tmp_path, bam):
    from services.scan import registry, jobs
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    st = _state([_dataset('ds_a', bam)])
    born = registry.generation(st)
    jobs.dispose_session(st)                       # a session import while a scan was opening
    with pytest.raises(registry.ScanOpenError, match='Another session'):
        registry.open_scan(st, d, generation=born)
    assert registry.list_scans(st) == []
    registry.open_scan(st, d, generation=registry.generation(st))
    assert len(registry.list_scans(st)) == 1


def test_bindings_exact_files_and_every_holder(tmp_path):
    """A scan of [a] binds to every loaded dataset holding exactly [a] (also), never to a merged [a, b] (b's reads
    would be labelled by this scan); a scan of a and b as two datasets binds both to a merged [a, b]."""
    from services.scan import registry
    a_dir, b_dir = tmp_path / 'a', tmp_path / 'b'
    a_dir.mkdir(); b_dir.mkdir()
    bam_a = tiny_bam(a_dir / 'a.bam', reads=(('m1/1/ccs', 1000, 0),))
    bam_b = tiny_bam(b_dir / 'b.bam', reads=(('m2/2/ccs', 1000, 0),))
    d = write_scan_dir(tmp_path / 'scan', bam_a, hits=HITS)
    st = _state([_dataset('merged', [bam_a, bam_b]), _dataset('only_a', bam_a), _dataset('again_a', bam_a)])
    scan = registry.open_scan(st, d)
    b = scan.bindings['dataset_1']
    assert b['status'] == 'bound' and b['dataset'] == 'only_a' and [x['dataset'] for x in b['also']] == ['again_a']
    assert scan.datasets_of_browser('merged') == [] and scan.datasets_of_browser('again_a') == ['dataset_1']
    st2 = _state([_dataset('merged', [bam_a, bam_b])])
    assert registry.open_scan(st2, d).bindings['dataset_1']['status'] == 'partial'


def test_rebinding_follows_dataset_changes(tmp_path, bam):
    from services.scan import registry
    d = write_scan_dir(tmp_path / 'scan', bam, hits=HITS)
    st = _state([])
    scan = registry.open_scan(st, d)
    assert scan.bindings['dataset_1']['status'] == 'unbound'
    st.datasets['late'] = _dataset('late', bam)          # a dataset opened after the scan
    registry.ensure_bound(st)
    assert scan.bindings['dataset_1']['dataset'] == 'late'


def test_contig_alias_queries(tmp_path):
    """The BAM and the scan name a contig '3', the browser 'chr3': hits, units and overlays still find their rows,
    and hits carry the browser's name."""
    from services.scan import registry, serve
    from services.scan.overlay import apply_scan_overlays
    bam3 = tiny_bam(tmp_path / 'b3.bam', contig='3', reads=(('m1/1/ccs', 1000, 0),))
    hits = [(1200, 1220, 'fp:class:3:1210:aaaaaaaa', 'class_001')]
    d = write_scan_dir(tmp_path / 'scan', bam3, contig='3', hits=hits,
                       states=[('fp:class:3:1210:aaaaaaaa', 1200, 1220, 'm1/1/ccs', 'r1:0', '1')])
    st = _state([_dataset('ds3', bam3)], chroms=(('chr3', 100_000),))
    scan = registry.open_scan(st, d)
    assert scan.frame is None
    got = serve.hits_for_view(scan, 'fp', 'chr3', 1000, 2000)['hits']
    assert [(h['chrom'], h['label']) for h in got] == [('chr3', 'class_001')]
    assert serve.units_for_view(scan, 'chr3', 0, 100_000)
    (read,) = apply_scan_overlays(st, 'ds3', 'chr3', 1000, 2000, [dict(id='m1/1/ccs', reference_start=1000, reference_end=1500, layers={})])
    assert read['layers']['fpcls']['intervals'] == [[200, 220, 20]]
