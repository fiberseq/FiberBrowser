"""Hub completion: paged queries, D12 aliases, D10 portability and record states. No servers."""
import base64
import hashlib
import io
import json
import shutil
import zipfile
from types import SimpleNamespace as NS

import pytest

from scan_fixtures import tiny_bam, write_scan_dir
from test_scan_hub import _state, _dataset
from services.hub.paging import query_hits, regions_for_scope
from services.scan.registry import open_scan, new_generation
from services.scan.session import export_scans, restore_scans


@pytest.fixture
def scanned(tmp_path):
    bam = tiny_bam(tmp_path / 'sample.bam')
    path = write_scan_dir(tmp_path / 'scan', bam, hits=[(10, 20, 'fp:class:chrT:15:a', 'a'),
        (100, 100, 'fp:class:chrT:100:b', 'b'), (900, 920, 'fp:class:chrT:910:c', 'c')], values=[
        ('fp:class:chrT:15:a', 10, 20, 'dataset_1::pooled', 'channel', 'prevalence', .2, 20),
        ('fp:class:chrT:100:b', 100, 100, 'dataset_1::pooled', 'channel', 'prevalence', .8, 20),
        ('fp:class:chrT:910:c', 900, 920, 'all', 'all', 'q', .01, 20)])
    state = _state([_dataset('sample', bam)])
    scan = open_scan(state, path, source='cache')
    return state, scan


def test_page_filter_sort_and_stable_ties(scanned):
    state, scan = scanned
    q = dict(scope={'kind': 'genome'}, limit=1, sort={'key': 'prevalence', 'dir': 'desc'})
    first = query_hits(state, q)
    assert first['total'] == 3 and first['hasMore']
    assert first['rows'][0]['hit']['label'] == 'b'
    second = query_hits(state, dict(q, offset=1))
    assert second['rows'][0]['hit']['label'] == 'a'
    assert query_hits(state, dict(q, minPrevalence=.5))['total'] == 1
    assert query_hits(state, dict(q, maxQ=.05))['rows'][0]['hit']['label'] == 'c'
    assert query_hits(state, dict(q, hiddenSets=[scan.sets(state)[0]['setId']]))['total'] == 0
    assert query_hits(state, dict(q, typeFilter='other'))['total'] == 0
    with pytest.raises(ValueError):
        query_hits(state, dict(q, sort={'key': 'invalid'}))


def test_all_scopes_and_boundaries(scanned, tmp_path, monkeypatch):
    state, scan = scanned
    bed = tmp_path / 'regions.bed'
    bed.write_text('chrT\t99\t101\nchrT\t100\t102\n')
    scopes = [dict(kind='view', chrom='chrT', start=100, end=101), dict(kind='bed', bed=str(bed)),
              dict(kind='anchors', anchors=[['chrT', 100]], flank=0), dict(kind='scan', scanId=scan.scan_id)]
    for scope, expected in zip(scopes, [1, 1, 1, 3]):
        assert query_hits(state, dict(scope=scope))['total'] == expected
    assert query_hits(state, dict(scope=dict(kind='view', chrom='chrT', start=99, end=100)))['total'] == 0
    monkeypatch.setattr('services.files_endpoint.search_gene_payload', lambda _s, _g: dict(found=True, chrom='chrT', tss=100))
    assert query_hits(state, dict(scope=dict(kind='genes', genes=['GENE_A'], flank=0)))['total'] == 1
    assert query_hits(state, dict(scope=dict(kind='view', chrom='T', start=100, end=101)))['total'] == 1
    assert query_hits(state, dict(scope=dict(kind='regions', regions=[['chrT', 0, 21]])))['total'] == 1


def test_large_scan_is_paged_after_global_sort(tmp_path):
    bam = tiny_bam(tmp_path / 'large.bam', length=2_000_000)
    count = 100_005
    path = write_scan_dir(tmp_path / 'large-scan', bam, length=2_000_000,
        hits=[(i*10, i*10+2, f'fp:class:chrT:{i*10+1}:{i:08x}', f'{i:06d}') for i in range(count)])
    state = _state([_dataset('sample', bam)], chroms=[('chrT', 2_000_000)])
    open_scan(state, path)
    request = dict(scope={'kind': 'genome'}, sort={'key': 'label', 'dir': 'desc'}, limit=100)
    first = query_hits(state, request)
    assert first['total'] == count
    assert len(first['rows']) == 100
    assert first['rows'][0]['hit']['label'] == '100004'
    index = state._hub_index
    second = query_hits(state, dict(request, offset=100))
    assert state._hub_index is index
    assert second['rows'][0]['hit']['label'] == '099904'
    assert not {r['hit']['hitId'] for r in first['rows']} & {r['hit']['hitId'] for r in second['rows']}
    index.close()


def test_provider_filter_sort_identity_aliases():
    from services.hub.variation_identity import normalize_hit, variation_id
    state = _state()
    h = dict(hitId='old', setId='browser:variation', typeId='var.snp', chrom='chrT', start=10, end=11,
             scores={'custom': 5, 'strength': 0}, values={'ds:a': {'prevalence': {'v': .8}}, 'ds:b': {'prevalence': {'v': .3}}},
             detail={'kind': 'snv', 'alleleId': 'exact-allele'})
    normalized = normalize_hit(state, h)
    assert normalized['hitId'].startswith('var:') and normalized['idAliases'] == ['old']
    assert ':snv:allele-' in normalized['hitId']
    geometry = normalize_hit(state, dict(h, detail={'kind': 'snv'}))
    assert ':snv:geometry-' in geometry['hitId'] and geometry['hitId'] != normalized['hitId']
    assert variation_id('12345678', 'chrT', 10, 10, 'I', geometry={'length': 4}).startswith('var:12345678:chrT:10-10:insertion:')
    providers = [dict(setId='browser:variation', source=dict(hits=[h]))]
    req = dict(scope=dict(kind='view', chrom='chrT', start=0, end=20), providers=providers,
               scoreFilters=[dict(name='custom', op='>=', value=4)], compare=['ds:a', 'ds:b'], sort=dict(key='delta', dir='desc'))
    assert query_hits(state, req)['total'] == 1
    assert query_hits(state, dict(req, minStrength=0))['total'] == 1
    assert query_hits(state, dict(req, scope=dict(kind='genome')))['total'] == 0


def test_embedded_scan_survives_cache_deletion_with_same_set_identity(scanned):
    state, scan = scanned
    sid = scan.sets(state)[0]['setId']
    frontend = dict(featureHub=dict(scans=[dict(path=str(scan.path), scanId=scan.scan_id, source='cache')]))
    saved, bundles = export_scans(state, frontend)
    assert saved['featureHub']['scans'][0]['embedding'] == 'embedded'
    assert 'embedding' not in frontend['featureHub']['scans'][0]
    original = str(scan.path)
    scan.tables.close()
    shutil.rmtree(scan.path)
    new_generation(state)
    restored, problems = restore_scans(state, dict(frontend=saved, hub_scans=bundles))
    assert restored == [scan.scan_id] and not problems
    assert saved['featureHub']['scans'][0]['path'] != original
    from services.scan.registry import list_scans
    assert list_scans(state)[0].sets(state)[0]['setId'] == sid
    assert query_hits(state, dict(scope=dict(kind='genome')))['total'] == 3
    # A re-export and restore keeps identities stable again.
    saved2, bundles2 = export_scans(state, saved)
    new_generation(state)
    assert restore_scans(state, dict(frontend=saved2, hub_scans=bundles2))[1] == []
    assert list_scans(state)[0].sets(state)[0]['setId'] == sid


def test_large_or_external_scans_remain_references(scanned, monkeypatch):
    state, scan = scanned
    from services.scan import session
    monkeypatch.setattr(session, 'EMBED_LIMIT', 1)
    saved, bundles = export_scans(state, dict(featureHub=dict(scans=[dict(path=str(scan.path), scanId=scan.scan_id)])))
    assert not bundles
    assert saved['featureHub']['scans'][0]['embedding'] == 'reference'
    assert 're-scan' in saved['featureHub']['scans'][0]['rescanPrompt']
    scan.source = 'opened'
    saved, bundles = export_scans(state, dict(featureHub=dict(scans=[dict(path=str(scan.path), scanId=scan.scan_id)])))
    assert not bundles and 'embedding' not in saved['featureHub']['scans'][0]


@pytest.mark.parametrize('name', ['../escape', '/escape', 'nested/../../escape', 'bad\\escape'])
def test_session_rejects_unsafe_scan_archives(name):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as z:
        z.writestr('manifest.json', '{}')
        z.writestr(name, 'unsafe')
    raw = data.getvalue()
    state = _state()
    restored, problems = restore_scans(state, dict(hub_scans=[dict(archive=base64.b64encode(raw).decode(), sha256=hashlib.sha256(raw).hexdigest())]))
    assert not restored and 'Unsafe' in problems[0]['error']


def test_read_only_scan_no_states(scanned):
    from services.scan.states import hub_feature_states
    state, scan = scanned
    state.datasets.clear()
    scan.bind(state)
    assert scan.sets(state)[0]['datasets'] == []
    assert query_hits(state, dict(scope=dict(kind='genome')))['total'] == 3
    with pytest.raises(ValueError, match='No loaded dataset'):
        hub_feature_states(state, scan.sets(state)[0]['setId'], dict(id='fp:class:chrT:15:a'))


def test_provider_record_states_and_generic_dispatch():
    from services.hub.provider_states import browser_feature_states, record_states
    from services.feature_states import feature_states
    from services.lift.cohort import _encode_record
    key1 = _encode_record(['molecule', 'synthetic', 'first'])
    key2 = _encode_record(['molecule', 'synthetic', 'second'])
    # Same molecule/name, different records; split rows of one record share the state.
    reads = [dict(id='row-a', analysis_id='lift-cohort:v1 ["molecule","synthetic","first",0,"primary"]',
                  reference_start=0, reference_end=100, layers={'msp': {'intervals': [[0, 100]]}}),
             dict(id='row-b', analysis_id='lift-cohort:v1 ["molecule","synthetic","second",0,"primary"]',
                  reference_start=0, reference_end=100, layers={'msp': {'intervals': []}})]
    state = NS(datasets={'sample': NS()}, build_working_set=lambda *a, **k: NS(reads=reads))
    hit = dict(setId='browser:peaks:p', hitId='p', typeId='peaks.peak', chrom='chrT', start=10, end=20,
               anchor=15, datasets=['sample'], stateSpec={'kind': 'open'})
    got = feature_states(state, [dict(kind='peaks-peak', source=hit['setId'], id='p', hub_hit=hit)])
    assert got['by_dataset']['sample'] == {key1: '1', key2: '0'}


def test_sv_graph_and_difference_state_adapters(monkeypatch):
    from services.hub.provider_states import browser_feature_states
    base = dict(id='synthetic', reference_start=0, reference_end=1000)
    reads = [dict(base, id='carrier', sv=[dict(t='I', ref=200, len=40)], hp='H1'),
             dict(base, id='reference', sv=[], hp='H2')]
    state = NS(datasets={'sample': NS(id='sample', data_type='bam')}, build_working_set=lambda *a, **kw: NS(reads=reads))
    hit = dict(setId='browser:test', hitId='hit', chrom='chrT', start=200, end=200, anchor=200, datasets=['sample'])
    def run(spec):
        return browser_feature_states(state, hit['setId'], dict(id='hit', hub_hit=dict(hit, stateSpec=spec)))[0]
    assert run(dict(kind='sv', t='I', length=40)) == {('sample', 'carrier'): '1', ('sample', 'reference'): '0'}
    assert run(dict(kind='graph', paths={'a': dict(datasets=['sample'], hap='H1', state='1'),
                                       'b': dict(datasets=['sample'], hap='H2', state='0')})) == {
        ('sample', 'carrier'): '1', ('sample', 'reference'): '0'}
    monkeypatch.setattr('services.differences.workspace.inspect', lambda *a, **kw: dict(
        targets=[dict(calls_by_molecule={'a': dict(call=dict(assignment='target', level='confirmed')),
                                        'b': dict(call=dict(assignment='reference'))})],
        membership=dict(rows={'sample': {'carrier': 'a', 'reference': 'b'}})))
    assert run(dict(kind='difference', target={'target_id': 'frozen'})) == {('sample', 'carrier'): '1', ('sample', 'reference'): '0'}


def test_snp_state_adapter_reads_alleles_with_quality(tmp_path):
    import pysam
    from services.hub.provider_states import browser_feature_states
    bam_path = tmp_path / 'snps.bam'
    header = dict(HD=dict(VN='1.6', SO='coordinate'), SQ=[dict(SN='chrT', LN=1000)])
    with pysam.AlignmentFile(str(bam_path), 'wb', header=header) as bam:
        for i, base in enumerate('ACA'):
            r = pysam.AlignedSegment()
            r.query_name = f'synthetic-{i}'
            r.reference_id, r.reference_start, r.flag, r.mapping_quality = 0, 100, 0, 60
            r.query_sequence, r.cigarstring, r.query_qualities = base*100, '100M', pysam.qualitystring_to_array(('!' if i == 2 else 'I')*100)
            bam.write(r)
    pysam.index(str(bam_path))
    state = _state([_dataset('sample', str(bam_path))], chroms=[('chrT', 1000)])
    hit = dict(setId='browser:snp', hitId='hit', chrom='chrT', start=150, end=151, datasets=['sample'],
               stateSpec=dict(kind='snp', variantKind='snv', alleles=['A', 'C'], alt='C'))
    got = browser_feature_states(state, hit['setId'], dict(id='hit', hub_hit=hit))[0]
    assert got == {('sample', 'synthetic-0'): '0', ('sample', 'synthetic-1'): '1', ('sample', 'synthetic-2'): '.'}


def test_scan_archive_limit_is_cumulative(scanned, monkeypatch, tmp_path):
    state, scan = scanned
    other_path = tmp_path / 'other'
    shutil.copytree(scan.path, other_path)
    manifest = json.loads((other_path / 'manifest.json').read_text())
    manifest['scan_id'] = 'second'
    (other_path / 'manifest.json').write_text(json.dumps(manifest))
    other = open_scan(state, other_path, source='cache')
    refs = [dict(path=str(s.path), scanId=s.scan_id) for s in (scan, other)]
    single, bundles = export_scans(state, dict(featureHub=dict(scans=refs[:1])))
    from services.scan import session
    monkeypatch.setattr(session, 'EMBED_LIMIT', bundles[0]['size'] + 1)
    saved, bundles = export_scans(state, dict(featureHub=dict(scans=refs)))
    assert len(bundles) == 1
    assert [r['embedding'] for r in saved['featureHub']['scans']] == ['embedded', 'reference']


def test_variation_geometry_identity_ignores_layout_and_keeps_aliases():
    from services.hub.variation_identity import normalize_hit
    state = _state()
    base = dict(setId='browser:test', hitId='old-sv', typeId='var.sv', chrom='chrT', start=100, end=100, scores={})
    sv = normalize_hit(state, dict(base, detail=dict(kind='insertion', length=50)))
    graph = normalize_hit(state, dict(base, hitId='old-graph', typeId='graph.bubble', detail=dict(kind='insertion',
        locusKey='layout-specific', revisions={'graph': 'new'}, alleles=[dict(bp=50, carriers=['path'])])))
    assert sv['hitId'] == graph['hitId']
    assert sv['idAliases'] == ['old-sv'] and graph['idAliases'] == ['old-graph']


def test_lifted_legacy_class_states_are_per_record(monkeypatch):
    from services import consensus_workflow as cw
    from services.feature_states import feature_states
    from services.lift.cohort import _encode_record
    state = NS(datasets={'sample': NS(data_type='bam_livelift')})
    jobs, _ = cw._session(state)
    jobs['run'] = dict(status='complete', result=dict(manifest=dict(region=dict(chrom='chrT', start=0, end=1000))),
                       index={'sample': dict(by_name={'synthetic': ['first', 'second']}, per_unit={})})
    reads = [dict(id='synthetic', analysis_id='lift-cohort:v1 ["molecule","synthetic","first",0,"primary"]', member=True),
             dict(id='synthetic', analysis_id='lift-cohort:v1 ["molecule","synthetic","second",0,"primary"]', member=False)]
    state.build_working_set = lambda *a, **kw: NS(reads=reads)
    monkeypatch.setattr('services.consensus_occupancy.class_occupancy', lambda _s, _ds, _c, rows, _g:
        ({0: {'synthetic'} if rows[0]['member'] else set()}, {0: {'synthetic'}}))
    got = feature_states(state, [dict(kind='fp-class', source='run', id='class', dataset_id='sample')])
    assert got['by_dataset']['sample'] == {_encode_record(['molecule', 'synthetic', 'first']): '1',
                                          _encode_record(['molecule', 'synthetic', 'second']): '0'}


def test_lifted_nfr_states_keep_source_record_identities(monkeypatch):
    from lab.services.nfr_features import nfr_states
    from services.scan.states import _Keyer
    ds = NS(data_type='bam_livelift', paths=['/data/synthetic.bam'], live_lift=None)
    state = NS(datasets={'sample': ds})
    result = dict(nfrs=[dict(id='N1', start=10, end=20)], parameters={}, datasets=[dict(dataset_id='sample')], molecules={
        'a': dict(dataset='sample', read_name='synthetic', record_sha256='first', nfr={'N1': dict(status='callable', gaps=[[10, 20]])}),
        'b': dict(dataset='sample', read_name='synthetic', record_sha256='second', nfr={'N1': dict(status='callable', gaps=[])})})
    monkeypatch.setattr('lab.services.accessibility_workflow._complete', lambda *a: dict(result=result))
    got = nfr_states(state, 'run', dict(kind='nfr', id='N1'))[0]
    keyer = _Keyer(state, 'sample', {0: ds.paths[0]})
    assert got == {('sample', keyer.key(0, 'synthetic', 'first:0')): '1',
                   ('sample', keyer.key(0, 'synthetic', 'second:0')): '0'}


def test_native_graph_columns_bind_without_replacing_alternate_nodes(monkeypatch):
    import asyncio
    from services.scan.graph_hits import add_graph_aliases
    from services.graph_panel import service
    reg = NS(id='graph', maps=[dict(target='target', source='alt')], binding=lambda key: dict(path=dict(contig='chrT')))
    monkeypatch.setattr(service, 'registry', lambda: NS(list=lambda: [dict(id='graph')], get=lambda _key: reg))
    async def ready():
        return NS(available=True)
    monkeypatch.setattr(service, 'ensure_ready', ready)
    monkeypatch.setattr('services.scan.graph_hits.package_bindings', lambda *a: {
        'alt': dict(datasets=['sample'], hap='H1', contigs={'sample': 'source'}),
        'target': dict(datasets=[], contigs={})})
    hit = dict(graph=dict(registration='graph', paths={'alt': dict(status='carried')}, columns=[['alternate', 0, 5]]),
               stateSpec=dict(kind='graph', paths={'alt': dict(state='1')}))
    asyncio.run(add_graph_aliases(NS(), [hit], 'chrT'))
    assert hit['graph']['columns'] == [['alternate', 0, 5]]
    assert hit['graph']['paths']['alt']['datasets'] == ['sample']
    assert hit['values']['ds:sample:H1']['prevalence']['v'] == 1
    assert hit['stateSpec']['paths']['alt']['hap'] == 'H1'


def test_reopening_session_cache_retains_browser_scan_origin(scanned):
    import asyncio
    from routers.scan import open_scan as open_route
    state, scan = scanned
    old_set = scan.sets(state)[0]['setId']
    result = asyncio.run(open_route(dict(path=str(scan.path), source='cache'), state=state))
    assert result['source'] == 'cache'
    assert result['sets'][0]['setId'] == old_set
