"""Pooled rigid regions retain separate window channels and genomic overlays."""
from copy import deepcopy
from types import SimpleNamespace
import threading

import pytest

from test_import_cli_results import cli_run
from test_signal_filters import signal_bam
from lab.services import region_analysis as ra
from services import consensus_workflow as cw
from services.oriented_regions import genomic_interval, project_indexes, retain_provenance, display_regions


def request():
    return dict(dataset_ids=['d'], region_windows=[
        dict(name='a', dataset_id='d', genome=None, chrom='chr1', start=100, end=200, strand='+'),
        dict(name='b', dataset_id='d', genome=None, chrom='chr2', start=300, end=400, strand='-')])


def state():
    return SimpleNamespace(get_dataset=lambda _: SimpleNamespace(data_type='bam'), panel_genome_assignments={}, panel_genome_contexts={})


def test_validate_windows_and_refuse_gaps_or_unequal_widths():
    assert len(ra.windows(state(), request())) == 2
    for field, value, message in [('end', 401, 'equal widths'), ('blocks', [{}], 'Gapped'), ('strand', '?', 'orientation'), ('start', True, 'integer')]:
        req = request(); req['region_windows'][1][field] = value
        with pytest.raises(ValueError, match=message): ra.windows(state(), req)


def unit(name, start):
    return dict(unit_id=name, read_name=name, strand='CT', reference_start=start, reference_end=start+100,
                positions=[start+10,start+30], hits=[1,0], raw_tf_intervals=[[start+20,start+30]],
                native_multi_interval_tf_intervals=[[start+20,start+30]])


def test_pool_uses_orientation_and_aliases(monkeypatch):
    monkeypatch.setattr('services.panel_genomes.genome_view', lambda s, _: s)
    monkeypatch.setattr(cw, 'load_payload', lambda s,r,o,p: dict(region={k:r[k] for k in ('chrom','start','end')}, strata=[dict(dataset_id='d', chemistry='ddda', units=[unit(r['name'],r['start'])])]))
    payload=ra.load(state(),request(),{'compute':SimpleNamespace(maximum_region_bp=1000)},lambda *_:None)
    assert payload['region']==dict(chrom='oriented_BED',start=0,end=100)
    assert payload['region_datasets']=={'d@a':'d','d@b':'d'}
    plus,minus=payload['strata']
    assert plus['units'][0]['positions']==[10,30]
    assert minus['units'][0]['positions']==[69,89]
    assert minus['units'][0]['hits']==[0,1]
    assert minus['units'][0]['strand']=='GA'
    assert minus['units'][0]['raw_tf_intervals']==[[70,80]]


def test_signal_predicate_reaches_every_pooled_member(monkeypatch, signal_bam):
    import pysam
    from test_signal_filters import state_for
    from models.domain import Dataset
    from services.signal_evidence import signal_filters_for_request, record_signal
    from fiberhmm.inference.consensus import bam as native
    s = state_for(signal_bam)
    s.datasets['other'] = Dataset('other', str(signal_bam), 'other', data_type='bam')
    s.dataset_order.append('other')
    req = dict(dataset_ids=s.dataset_order, region_windows=[
        dict(name=ds, dataset_id=ds, genome=None, chrom='chr1', start=100, end=401, strand='+')
        for ds in s.dataset_order])
    calls = []
    def load(datasets, region, options, progress):
        ds = datasets[0]
        with pysam.AlignmentFile(ds['paths'][0]) as source:
            reads = [r for r in source.fetch('chr1', 100, 401)
                     if not (r.is_duplicate or r.is_supplementary) and r.mapping_quality >= 20]
        assert all(record_signal(r)['status'] != 'background' for r in reads)
        assert {r.query_name for r in reads} == {'read1', 'read2', 'read3', 'read4'}
        calls.append(ds['dataset_id'])
        return dict(region=region, strata=[dict(dataset_id=ds['dataset_id'], chemistry='dddb',
            units=[unit(r.query_name, 100) for r in reads])], input_files=[dict(path=ds['paths'][0])])
    monkeypatch.setattr(native, 'load_bam_payload', load)
    with signal_filters_for_request({'hideBackground': True}):
        pooled = ra.load(s, req, {'compute': SimpleNamespace(maximum_region_bp=1000)}, lambda *_: None)
    assert calls == ['signal', 'other']
    # The pool subsequently chooses one view of each physical molecule.
    assert {u['read_name'] for source in pooled['strata'] for u in source['units']} == {'read1', 'read2', 'read3', 'read4'}
    assert all(f['path'] == str(signal_bam) for f in pooled['input_files'])


def test_projection_uses_each_units_window_and_does_not_mutate_frozen_calls():
    result=dict(manifest=dict(pooling={'windows':request()['region_windows']},region_datasets={'d@a':'d','d@b':'d'}),datasets={})
    indexes={}
    for alias,w in zip(('d@a','d@b'),request()['region_windows']):
        u=dict(unit_id=alias+'::u',read_name='same',strand='CT',genomic_provenance=dict(window=w,reference_start=w['start'],reference_end=w['end']))
        result['datasets'][alias]=dict(units=[u])
        indexes[alias]=dict(layers=['tf_rc'],per_unit={u['unit_id']:{'tf_rc':[dict(interval=[10,20],consensus_interval=[12,18],strand='CT')]}},
            by_name={'same':[u['unit_id']]},projection_members={'same':[dict(unit_id=u['unit_id'],identity={'chemical_strand':'CT'})]})
    before=deepcopy(indexes)
    projected=project_indexes(result,indexes)
    assert indexes==before
    assert projected['d']['per_unit']['d@a::u']['tf_rc'][0]['interval']==[110,120]
    reverse=projected['d']['per_unit']['d@b::u']['tf_rc'][0]
    assert reverse['interval']==[380,390] and reverse['consensus_interval']==[382,388] and reverse['strand']=='GA'
    assert cw._match_projection_unit(projected['d'],{'id':'same','strand':'GA'},'chr2')[0]=='d@b::u'
    assert cw._match_projection_unit(projected['d'],{'id':'same','strand':'CT'},'chr1')[0]=='d@a::u'
    assert display_regions(result,'d','2')==[dict(chrom='chr2',start=300,end=400)]


def test_transfer_origin_is_subtracted():
    assert genomic_interval([1010,1020],dict(window=request()['region_windows'][1],coordinate_origin=1000))==[380,390]


def test_retain_provenance_accepts_prefixed_browser_unit_ids():
    w=request()['region_windows'][0]
    payload=dict(pooling={'windows':[w]},region_datasets={'d@a':'d'},strata=[dict(dataset_id='d@a',units=[dict(unit_id='u',genomic_provenance={'window':w})])])
    result=dict(manifest={},datasets={'d@a':dict(units=[dict(unit_id='d@a::u')])})
    retain_provenance(result,payload)
    assert result['datasets']['d@a']['units'][0]['genomic_provenance']['window']==w


def test_real_joint_discovery_and_frozen_transfer(tmp_path):
    from test_consensus_lattice_recaller import planted_payload
    from fiberhmm.inference.consensus.regions import pool_payloads
    from fiberhmm.inference.consensus.artifacts import write_json
    from fiberhmm.inference.consensus.lattice_recaller.frozen import freeze_run, apply_catalog
    payloads=[]; rows=[]
    for i,strand in enumerate(('+','-')):
        payload=planted_payload(n=40,seed=7+i)
        payload['strata'][0]['dataset_id']=f'd@{i}'
        for u in payload['strata'][0]['units']:
            u['read_name']=str(i)+'/'+u['read_name']
        payloads.append(payload)
        rows.append(dict(name=str(i),chrom='chrT',start=1050,end=1350,strand=strand,dataset_id='d'))
    payload=pool_payloads(payloads,rows);payload['region_datasets']={'d@0':'d','d@1':'d'}
    runtime,_=cw._runtime()
    out=tmp_path/'run';out.mkdir()
    write_json(out/'evidence.json.gz',payload)
    result=runtime.run_analysis(payload,{'cr':{'engine':'lattice_recaller'},'compute':{'cores':1},'recaller':{'learned_spots':False}},out)
    retain_provenance(result,payload)
    index,_=cw._index(result)
    assert set(result['datasets'])=={'d@0','d@1'}
    assert 'd' in index and len(index['d']['per_unit'])==80
    assert result['recaller']['classes']
    assert all(1050<=r['interval'][0]<r['interval'][1]<=1350 for layers in index['d']['per_unit'].values() for r in layers.get('tf_rc',[]))
    from models.domain import WorkingSet
    job=dict(job_id='pooled',status='complete',result=result,index=index,filters=cw.schema()['display_defaults'])
    overlay_state=SimpleNamespace(consensus_workflow_jobs={'pooled':job},consensus_workflow_lock=threading.RLock(),consensus_workflow_active='pooled')
    reads=[dict(id=u['read_name'],strand=u['genomic_provenance']['strand'],layers={}) for ds in result['datasets'].values() for u in ds['units']]
    projected=cw.apply_overlays(overlay_state,'d','chrT',1050,1350,WorkingSet(reads,len(reads),len(reads),'chrT',1050,1350))
    assert all(r['consensus_projection']['status']=='matched' for r in projected.reads)
    assert any(r['layers'].get('tf_rc',{}).get('intervals') for r in projected.reads)
    catalog=freeze_run(out,tmp_path/'catalog.json')
    transferred,analysed=apply_catalog(catalog,payload,tmp_path/'transfer',include_training=True,cores=1)
    retain_provenance(transferred,analysed)
    assert cw._index(transferred)[0]['d']['unit_windows']
    assert [c['id'] for c in transferred['recaller']['classes']]==[c['id'] for c in result['recaller']['classes']]


def test_import_pooled_cli_and_transfer_reinstalls_genomic_layers(cli_run):
    import gzip
    import json
    from test_import_cli_results import _state
    bam, raw=cli_run
    result=json.loads(gzip.decompress(raw))
    w=dict(name='reverse',chrom='chr1',start=120,end=300,strand='-')
    result['manifest']['pooling']={'windows':[w]}
    result['manifest']['region']=dict(chrom='oriented_BED',start=0,end=180)
    for unit in result['datasets']['dataset_1']['units']:
        unit['genomic_provenance']=dict(window=w,coordinate_origin=120)
    state=_state(bam)
    summary=cw.import_result(state,json.dumps(result).encode())
    job=cw._session(state)[0][summary['job_id']]
    assert job['request']['dataset_ids']==['napa']
    assert job['request']['region_windows'][0]['dataset_id']=='napa'
    assert job['request']['region_windows'][0]['strand']=='-'
    assert 'napa' in job['index'] and cw.active(state,'napa','chr1',120,300)
    assert cw.activate(state,summary['job_id'])['status']=='complete'
    assert state.get_dataset('napa').derived_layers


def test_window_reference_is_checked_per_dataset():
    s=state();s.dataset_genomes={'d':'alt'};s.genome_contexts={'alt':object()}
    with pytest.raises(ValueError,match='different references'):ra.windows(s,request())
    req=request()
    for w in req['region_windows']:w['genome']='alt'
    assert len(ra.windows(s,req))==2


def test_saved_class_membership_uses_real_dataset_genomic_chromosome_and_selected_window():
    from services.consensus_occupancy import class_occupancy
    from services.oriented_regions import catalog_sources
    from services.footprint_rules import normalize_footprint_group
    rows = request()['region_windows']
    result = dict(cr_mode='lattice_recaller', manifest=dict(region=dict(chrom='oriented_BED', start=0, end=100),
        pooling={'windows': rows}, region_datasets={'d@a': 'd', 'd@b': 'd'}), datasets={})
    indexes = {}
    for alias, w in zip(('d@a', 'd@b'), rows):
        uid = alias + '::u'
        result['datasets'][alias] = dict(units=[dict(unit_id=uid, read_name='same', strand='CT',
            genomic_provenance=dict(window=w, reference_start=w['start'], reference_end=w['end']))])
        indexes[alias] = dict(layers=['tf_rc'], per_unit={uid: {'tf_rc': [dict(kind='recaller_class', family='class_001', interval=[10, 20], tier='core')]}},
            by_name={'same': [uid]}, projection_members={'same': [dict(unit_id=uid, identity={'chemical_strand': 'CT'})]})
    job = dict(status='complete', result=result, index=project_indexes(result, indexes), filters={},
        _scored_units={'d@a': {'class_001': {'d@a::u'}}, 'd@b': {'class_001': {'d@b::u'}}})
    st = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock())
    group = dict(consensusStateId='class_001', consensusJobId='j', sourceDatasetId='d', consensusDatasetId='d@b', consensusStrand='CT', consensusTier='core')
    assert normalize_footprint_group(group)['consensusDatasetId'] == 'd@b'
    assert catalog_sources(result)['d@b']['dataset_id'] == 'd'
    assert catalog_sources(result)['d@b']['window']['chrom'] == 'chr2'
    member, eligible = class_occupancy(st, 'd', 'chr2', [dict(id='same', strand='GA')], [group])
    assert member == eligible == {0: {'same'}}
    member, eligible = class_occupancy(st, 'd', 'chr1', [dict(id='same', strand='CT')], [group])
    assert member == eligible == {0: set()}


def test_catalog_source_for_empty_window_still_names_real_dataset():
    from services.oriented_regions import catalog_sources
    result = dict(manifest=dict(region=dict(chrom='oriented_BED', start=0, end=100),
        pooling={'windows': request()['region_windows']}, region_datasets={'d@a': 'd'}), datasets={'d@a': dict(units=[])})
    assert catalog_sources(result)['d@a'] == dict(dataset_id='d', coordinate_origin=0, window=request()['region_windows'][0])


def test_sampled_pool_refines_class_evidence_with_aliases_and_orientation(monkeypatch):
    from fiberhmm.inference.consensus.loader_sampling import SampledPayload
    monkeypatch.setattr('services.panel_genomes.genome_view', lambda s, _: s)
    calls = []
    def load(s, r, o, p):
        source = dict(dataset_id='d', chemistry='ddda', units=[unit(r['name'], r['start'])])
        body = dict(region={k:r[k] for k in ('chrom','start','end')}, strata=[source], input_files=[dict(dataset_id='d', path=r['name'])])
        def refine(requirements):
            for span, predicate in requirements:
                extra = unit(r['name'] + '-extra', r['start'])
                calls.append((r['name'], span))
                if predicate(source, extra): source['units'] = [*source['units'], extra]
            return body
        return SampledPayload(body, refine)
    monkeypatch.setattr(cw, 'load_payload', load)
    payload = ra.load(state(), request(), {'compute': SimpleNamespace(maximum_region_bp=1000)}, lambda *_: None)
    assert not calls
    assert len(payload['strata'][1]['units']) == 1
    payload.refine([((20, 30), lambda s, u: s['dataset_id'] == 'd@b' and u['strand'] == 'GA')])
    assert calls == [('a', (120, 130)), ('b', (370, 380))]
    assert [len(s['units']) for s in payload['strata']] == [1, 2]
    assert payload['strata'][1]['units'][1]['positions'] == [69, 89]
    assert payload['region_datasets'] == {'d@a': 'd', 'd@b': 'd'}
    assert [f['dataset_id'] for f in payload['input_files']] == ['d@a', 'd@b']


@pytest.mark.parametrize('cap', [100, 0])
def test_frozen_transfer_passes_selected_budgets_even_when_normalized_away(monkeypatch, tmp_path, cap):
    from fiberhmm.inference.consensus.lattice_recaller import frozen
    s = state()
    monkeypatch.setattr(cw, '_session', lambda _: ({'source': dict(status='complete', result={'cr_mode':'lattice_recaller'}, _snapshot={}, request={'dataset_ids':['d']}, artifact_dir='source')}, threading.RLock()))
    monkeypatch.setattr(cw, '_snapshot', lambda *_: {})
    monkeypatch.setattr(cw, '_same_sources', lambda *_: True)
    monkeypatch.setattr(cw, 'submit', lambda s, r, **kw: kw['analysis_runner'])
    catalog = {'frame': {'region': dict(chrom='oriented_BED', start=0, end=100)}}
    monkeypatch.setattr(frozen, 'freeze_run', lambda *_: catalog)
    captured = {}
    def apply(c, p, out, **kw):
        captured.update(kw['parameters'])
        return {'manifest':{}, 'datasets':{}}, p
    monkeypatch.setattr(frozen, 'apply_catalog', apply)
    budgets = dict(max_discovery_molecules=cap, max_quantification_molecules=cap, sample_seed=17)
    runner = ra.submit(s, dict(request(), frozen_job_id='source', parameters={'recaller':dict(budgets, learned_spots=False)}))
    runner(dict(region=catalog['frame']['region'], strata=[], pooling={'windows':[]}), {'input':{}, 'compute':{}, 'recaller':{'learned_spots':False}}, tmp_path, lambda *_:None)
    assert captured == {'input':{}, 'compute':{}, 'recaller':budgets}
