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
    assert scan.bindings['dataset_1'] == dict(dataset='ds_a', status='bound', via='input')
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
    assert out[0]['layers']['fpcls']['intervals'] == [[200, 220, 20]] and out[0]['layers']['fpcls']['qualities'] == [[1]]
    assert out[1]['layers']['fpcls']['qualities'] == [[2]]
    assert out[2] is reads[2]
    again = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, out)
    assert again[0]['layers'] == out[0]['layers']
    registry.close_scan(st, registry.list_scans(st)[0].scan_id)
    assert 'fpcls' not in ds.available_layers and 'fpcls' not in ds.derived_layers


def test_role_columns_nuc_patches_and_haplotypes():
    from services.scan.serve import role_columns
    cell = lambda v, n=10: dict(v=v, lo=None, hi=None, n=n, nCallable=n)
    raw = {'all': {'fraction': cell(0.5)}, 'dataset_1': {'fraction': cell(0.6)}, 'dataset_1:HP1': {'fraction': cell(0.7)}}
    kinds = {'all': 'all', 'dataset_1': 'dataset', 'dataset_1:HP1': 'haplotype'}
    cols = role_columns('nuc.patch.regular', raw, kinds, ['dataset_1'])
    assert cols['all']['prevalence']['v'] == 0.5 and cols['dataset_1']['prevalence']['v'] == 0.6
    assert cols['dataset_1:HP1']['prevalence']['v'] == 0.7
    phased = role_columns('nuc.patch.phased', {'dataset_1': {'R_minus_null': cell(0.2)}}, {'dataset_1': 'dataset'}, ['dataset_1'])
    assert phased['dataset_1']['strength']['v'] == 0.2 and 'prevalence' not in phased['dataset_1']


def test_score_roles_of_scan_types():
    from services.scan.registry import _camel_type
    def decl(type_id, *names):
        return dict(type_id=type_id, module=type_id.split('.')[0], provides=['hit'],
                    scores=[dict(name=n, label=n, kind='fraction', better='high', per_group=True) for n in names])
    assert _camel_type(decl('fp.class', 'prevalence', 'support_gain_nats'))['roles'] == {'prevalence': 'prevalence', 'strength': 'support_gain_nats'}
    assert _camel_type(decl('nuc.patch.regular', 'fraction', 'q_hat'))['roles'] == {'prevalence': 'fraction'}
    assert _camel_type(decl('nuc.patch.phased', 'R_minus_null', 'P'))['roles'] == {'strength': 'R_minus_null'}
    assert _camel_type(decl('peaks.peak', 'score', 'tier'))['roles'] == {'strength': 'score'}


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
