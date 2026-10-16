from copy import deepcopy
from types import SimpleNamespace
import pytest
from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime()
from services.consensus_workflow import _index,_register,_visible,active,apply_overlays,set_filters,state_read_ids
from models.domain import WorkingSet


def result():
    call=dict(family='d:F0001',family_index=0,interval=[110,145],consensus=[112,143],
        model_membership=.95,source_intervals=[[108,146]],opportunities=7,hits=0)
    cq=dict(family='d:F0001',comparative_Q_model=20.,status='two_strand_supported',
        population_quantification_mask={'CT':True,'GA':True},molecule_quantification_mask={'CT':True,'GA':False})
    return dict(manifest=dict(region=dict(chrom='chr1',start=100,end=200)),datasets={'d':dict(
        units=[dict(unit_id='u',read_name='r',source_members=[{'read_name':'copy'}],native_intervals=[[108,146]])],
        sr=dict(status='complete',records=[dict(unit_id='u',calls=[dict(interval=[110,145],raw=[108,146],action='projection_equivalent_normalization')])]),
        cr=dict(status='complete',catalog=[],records=[dict(unit_id='u',strand='CT',proposals=[call])]),
        comparability=dict(status='complete',records=[cq]))},cross=dict(status='complete',edges=[]))


def state():
    dataset=SimpleNamespace(available_layers={'tf':True},derived_layers={})
    s=SimpleNamespace(get_dataset=lambda name:dataset)
    import threading
    r=result();index,layers=_index(r)
    job=dict(job_id='job',status='complete',result=r,index=index,layers=layers,
        filters=dict(minimum_model_q=0.,minimum_comparability_q=0.,require_population_comparable=False,
            require_molecule_comparable=False,require_cross_comparable=False,show_quality_outlines=True))
    s.consensus_workflow_jobs={'job':job};s.consensus_workflow_lock=threading.RLock();s.consensus_workflow_active='job'
    return s,job,dataset


def test_layer_registration_independent_of_cart_and_empty_xcr():
    s,job,dataset=state();_register(s,job)
    assert dataset.available_layers['tf_xcr']
    assert dataset.derived_layers['tf_xcr']['label']=='Cross-dataset state relationships'


def test_live_assignment_reindexes_without_mutating_frozen_result(monkeypatch):
    from services import consensus_workflow as workflow
    s,job,_=state();job['result'].update(cr_mode='staged_native_families',final_stage='resolved')
    before=deepcopy(job['result'])
    projected=dict(datasets=deepcopy(before['datasets']),cross=deepcopy(before['cross']))
    projected['datasets']['d']['cr']['records'][0]['proposals']=[]
    calls=[]
    monkeypatch.setattr(workflow,'_staged_assignment_view',lambda j,ref,stage=None,inspect_only=False: calls.append(ref) or projected)
    workflow.set_filters(s,'job',{'classification_reference_percent':50})
    assert calls==[50]
    assert job['result']==before
    assert workflow.viewed_result(job)['datasets']['d']['cr']['records'][0]['proposals']==[]
    assert not job['index']['d']['per_unit']['u'].get('tf_cr')


def test_live_assignment_does_not_overwrite_manual_history():
    from services.consensus_workflow import _staged_assignment_view
    _,job,_=state();job['_curation']={'history':[{'operation':'merge'}]}
    with pytest.raises(ValueError,match='manual edits'):_staged_assignment_view(job,50)


def test_recalled_scaffold_is_a_separate_browser_layer():
    r=result();u=r['datasets']['d']['units'][0]
    u.update(recalled_nuc_intervals=[[150,190]],recalled_msp_intervals=[[100,150]])
    indices,layers=_index(r)
    assert {'nuc_native_replay','msp_native_replay'}<=set(layers)
    assert {'nuc_native_replay','msp_native_replay'}<=set(indices['d']['layers'])


def test_job_completion_does_not_hide_an_unconverged_native_fit():
    from services.consensus_workflow import _summary
    _,job,_=state()
    job['result']['datasets']['d']['cr']['fits']=[dict(objective=-1.,success=True),
        dict(objective=-2.,success=False,iterations=160,message='Iteration limit')]
    report=_summary(job)
    assert report['status']=='complete'
    assert report['summary']['d']['numerical_fit']['selected_converged'] is False
    assert report['summary']['d']['numerical_fit']['status']=='numerically_provisional'
    assert report['summary']['d']['classes']==0
    assert report['summary']['d']['assignments']==1


def test_native_unchanged_alias_projection_and_geometry_not_median():
    s,job,_=state()
    native=dict(id='copy',strand='CT',intervals=[],layers={'tf':dict(intervals=[[8,46,38]])})
    before=deepcopy(native);ws=WorkingSet([native],1,1,'chr1',100,200)
    got=apply_overlays(s,'d','chr1',100,200,ws)
    assert native==before
    assert got.reads[0]['layers']['tf']==native['layers']['tf']
    assert got.reads[0]['layers']['tf_cr']['intervals']==[[10,45,35]]
    assert got.reads[0]['layers']['tf_sr_lattice']['consensus_records'][0]['kind']=='projection_equivalent_normalization'
    assert 'tf_xcr' not in got.reads[0]['layers']


def test_quality_filter_changes_visibility_not_coordinates_or_catalog():
    s,job,_=state();index=deepcopy(job['index'])
    native=dict(id='r',strand='CT',intervals=[],layers={})
    ws=WorkingSet([native],1,1,'chr1',100,200)
    assert apply_overlays(s,'d','chr1',100,200,ws).reads[0]['layers']['tf_cr']['intervals']==[[10,45,35]]
    job['filters']['minimum_model_q']=20
    assert 'tf_cr' not in apply_overlays(s,'d','chr1',100,200,ws).reads[0]['layers']
    job['filters']['minimum_model_q']=0
    assert apply_overlays(s,'d','chr1',100,200,ws).reads[0]['layers']['tf_cr']['intervals']==[[10,45,35]]
    assert job['index']==index


def test_staged_display_uses_inference_baseline_and_preserves_saved_calls():
    s,job,_=state();job['result']['cr_mode']='staged_native_families'
    job['result']['manifest']['region'].update(start=120,end=180)
    uid=next(iter(job['index']['d']['per_unit']))
    job['index']['d']['per_unit'][uid]['tf_native_replay']=[dict(interval=[130,150],kind='native_msp_replay')]
    native=dict(id='copy',strand='CT',intervals=[],layers={'tf':dict(intervals=[[5,95,90]])})
    before=deepcopy(native)
    got=apply_overlays(s,'d','chr1',100,200,WorkingSet([native],1,1,'chr1',100,200)).reads[0]
    assert native==before
    assert got['layers']['tf']['intervals']==[[5,20,90],[30,50,20],[80,95,90]]
    assert got['layers']['tf_bam_original']==before['layers']['tf']
    job['index']['d']['per_unit'][uid]['tf_native_replay']=[]
    got=apply_overlays(s,'d','chr1',120,180,WorkingSet([dict(native,layers={'tf':dict(intervals=[[5,30,25]])})],1,1,'chr1',120,180)).reads[0]
    assert got['layers']['tf']['intervals']==[]


def test_population_rescue_keeps_weak_provenance_and_filters_without_mutating_cr():
    r=result();baseline=deepcopy(r['datasets']['d']['cr'])
    call=dict(family='d:F0002',family_index=1,interval=[155,165],consensus=[154,166],
        model_membership=.78,population_assisted_probability=.78,
        prior_only_family_inclusion=.25,native_equal_activity_log_bf=1.8,
        opportunities=1,hits=0,information_status='weak_population_assisted',
        provenance='population_assisted_new_call',numerical_provisional=True,
        geometry_validation=dict(updated_family_inclusion_mass=.78))
    combined=deepcopy(baseline['records']);combined[0]['proposals'].append(call)
    r['datasets']['d']['rescue']=dict(status='complete',model='population_assisted',retained_calls=1,
        records=[dict(unit_id='u',strand='CT',calls=[call])],cr_records=combined,
        source_recipes=[dict(numerical_provisional=True,integration=dict(effective_sample_size=12.,maximum_split_Rhat=1.4))])
    index,layers=_index(r)
    assert {'tf_recall','tf_cr_recalled'}<=set(layers)
    candidate=index['d']['per_unit']['u']['tf_recall'][0]
    assert candidate['opportunities']==1 and candidate['model_membership']==.78
    assert candidate['provenance']=='population_assisted_new_call'
    s,job,_=state();filters=job['filters'].copy()
    assert _visible(candidate,filters,'CT')
    filters['minimum_model_q']=10
    assert not _visible(candidate,filters,'CT')
    filters['minimum_model_q']=0;filters['minimum_rescue_model_q']=10
    assert not _visible(candidate,filters,'CT')
    assert _visible(index['d']['per_unit']['u']['tf_cr'][0],filters,'CT')
    filters['minimum_rescue_model_q']=0
    assert _visible(candidate,filters,'CT')
    assert r['datasets']['d']['cr']==baseline
    from services.consensus_workflow import _rescue_numerics
    assert _rescue_numerics(r['datasets']['d']['rescue'])['provisional_source_models']==1
    from services.consensus_workflow import rescue_rate_summary
    summary=rescue_rate_summary(r['datasets']['d'],filters)
    assert summary['by_family']['d:F0002']['CT']['added_units']==1
    filters['minimum_rescue_model_q']=10
    assert rescue_rate_summary(r['datasets']['d'],filters)['by_family'].get('d:F0002',{}).get('CT',{}).get('added_units',0)==0
    assert r['datasets']['d']['cr']==baseline


def test_na_is_not_zero_and_population_mask_checks_both_strands():
    _,job,_=state();f=job['filters'].copy();f['require_population_comparable']=True
    r=dict(kind='cr',model_membership=.9,comparability=dict(population_quantification_mask={'CT':True,'GA':False}))
    assert not _visible(r,f,'CT')
    f['require_population_comparable']=False;f['minimum_comparability_q']=3
    assert not _visible(r,f,'CT')
    r['kind']='unchanged'
    assert _visible(r,f,'CT')  # No comparability claim is made for baseline/SR calls.


def test_no_overlay_outside_frozen_region():
    s,_,_=state();ws=WorkingSet([],0,0,'chr2',100,200)
    assert apply_overlays(s,'d','chr2',100,200,ws) is ws


def test_fast_and_direct_display_paths_project_consensus_without_cart():
    from services.read_endpoint import apply_consensus_display_overlays
    s,_,_=state()
    reads=[dict(id='r',strand='CT',intervals=[[0,100,100]],layers={})]
    output=apply_consensus_display_overlays(s,'d','chr1',100,200,reads,
        total_overlapping=1,total_spanning=1)
    assert output[0]['layers']['tf_cr']['intervals']==[[10,45,35]]
    assert reads[0]['layers']=={}


def test_consensus_overlay_survives_browser_to_bam_chromosome_alias_translation():
    s,_,_=state()
    # The workflow freezes the browser spelling, but BAM read queries can
    # canonicalize it to the producer's chr-prefixed spelling.
    s.consensus_workflow_jobs['job']['result']['manifest']['region']['chrom']='1'
    assert active(s,'d','chr1',100,200)
    read=dict(id='r',strand='CT',intervals=[[0,100,100]],layers={})
    projected=apply_overlays(s,'d','chr1',100,200,WorkingSet([read],1,1,'chr1',100,200))
    assert projected.reads[0]['layers']['tf_cr']['intervals']==[[10,45,35]]
    assert not active(s,'d','chr2',100,200)


def test_state_read_filter_uses_primary_assignment_and_includes_read_aliases():
    s,_,_=state()
    response=state_read_ids(s,'job','d','d:F0001')
    assert response['read_ids']==['copy','r']
    assert response['matching_units']==1
    assert state_read_ids(s,'job','d','not-a-state')['read_ids']==[]


def test_virtual_layers_resolve_to_native_producers():
    from services.consensus_workflow import source_layers
    assert source_layers(())==()
    layers=source_layers(('tf_xcr','tf_recall','deam'))
    assert set(layers)=={'tf','nuc','msp','deam'}


def test_import_export_roundtrip_and_input_firewall(tmp_path):
    import gzip,json
    from services.consensus_workflow import _snapshot,import_result,activate,_session
    from fiberhmm.inference.consensus.parameters import parse_options,options_dict
    s,job,ds=state();path=tmp_path/'source.bam';path.write_bytes(b'test-source')
    ds.path=str(path);ds.paths=[str(path)];ds.family_scan_chemistry='ddda'
    r=deepcopy(job['result']);r['schema']='fiberhmm.consensus.v1'
    r['manifest'].update(status='complete',browser_sources=_snapshot(s,['d']),parameters=options_dict(parse_options()),
        datasets=[dict(dataset_id='d',chemistry='ddda')])
    packed=gzip.compress(json.dumps(r).encode())
    loaded=import_result(s,packed)
    assert loaded['status']=='complete'
    assert loaded['job_id']==s.consensus_workflow_active
    jobs,_=_session(s);assert jobs[loaded['job_id']]['result']==r
    # A trusted local caller can choose an exact inclusive expanded-byte cap;
    # the same completed-result and source-fingerprint validation still applies.
    local=import_result(s,packed,maximum_expanded_import_bytes=len(gzip.decompress(packed)))
    assert jobs[local['job_id']]['result']==r
    assert activate(s,loaded['job_id'])['status']=='complete'
    path.write_bytes(b'changed-input')
    with pytest.raises(ValueError,match='changed'):activate(s,loaded['job_id'])
    with pytest.raises(ValueError,match='same source'):import_result(s,packed)
    with pytest.raises(ValueError,match='same source'):
        import_result(s,packed,maximum_expanded_import_bytes=1024**3)


def test_import_rejects_incomplete_and_nonfinite_json():
    from services.consensus_workflow import import_result
    s,_,_=state()
    for raw in [b'{"schema":"fiberhmm.consensus.v1","manifest":{"status":"running"}}',b'{"q":NaN}']:
        with pytest.raises(ValueError):import_result(s,raw)


def test_declared_datatype_change_does_not_change_frozen_input_identity():
    from services.consensus_workflow import _same_sources
    left={'d':dict(paths=['a.bam'],files=[['a.bam',1,2]],chemistry='ddda')}
    right=deepcopy(left);right['d']['chemistry']='hia5-pacbio'
    assert _same_sources(left,right)
    right['d']['files'][0][1]=2
    assert not _same_sources(left,right)


def test_split_labels_require_the_robust_family_gate():
    r=result();r['datasets']['d']['split']=dict(status='complete',records=[dict(unit_id='u',
        matching_robust_families=['d:F0002'],tests=[dict(pieces=[[110,120],[130,145]],gaps=[],
            matching_CR_pieces=[dict(piece=[110,120],family='d:F0001'),dict(piece=[130,145],family='d:F0002')])])])
    index,_=_index(r);records=index['d']['per_unit']['u']['nuc_cr_split']
    assert records[0]['family'] is None
    assert records[1]['family']=='d:F0002'


def test_identical_bam_records_all_receive_native_replay(tmp_path):
    import array,pysam
    from services.consensus_workflow import load_payload
    from fiberhmm.inference.consensus.parameters import parse_options
    path=tmp_path/'duplicates.bam'
    with pysam.AlignmentFile(path,'wb',header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'chr1','LN':1000}]}) as bam:
        read=pysam.AlignedSegment(bam.header);read.query_name='same';read.query_sequence='ACGT'*50
        read.flag=0;read.reference_id=0;read.reference_start=100;read.mapping_quality=60;read.cigarstring='200M'
        read.set_tag('MM','A+a.,0,0,0,0,0;');read.set_tag('ML',array.array('B',[255]*5))
        read.set_tag('as',array.array('I',[0]));read.set_tag('al',array.array('I',[200]))
        bam.write(read);bam.write(read)
    pysam.index(str(path))
    ds=SimpleNamespace(path=str(path),paths=[str(path)],label='duplicates',data_type='bam',
        family_scan_chemistry='hia5-pacbio',available_layers={'m6a':True,'msp':True,'tf':True},derived_layers={})
    s=SimpleNamespace(get_dataset=lambda _:ds)
    with pytest.raises(ValueError,match='explicit annotation frame'):
        load_payload(s,dict(dataset_ids=['d'],chrom='chr1',start=100,end=300),parse_options({'cr':{'engine':'staged_native_families'}}),lambda *_:None)
    p=load_payload(s,dict(dataset_ids=['d'],chrom='chr1',start=100,end=300),
        parse_options({'cr':{'engine':'staged_native_families'},'families':{'recall_hia5_nucleosomes':False},'input':{'legacy_hia5_annotation_frame':'seq'}}),lambda *_:None)
    units=p['strata'][0]['units']
    assert len(units)==2
    assert len({u['unit_id'] for u in units})==2
    assert all('native_multi_interval_tf_intervals' in u for u in units)
    assert units[0]['native_multi_interval_tf_intervals']==units[1]['native_multi_interval_tf_intervals']
    assert units[0]['native_multi_interval_tf_intervals']  # No silent loss of legacy MSPs.
    assert all(len(u['source_members']) == 1 for u in units)
    assert sorted(u['source_members'][0]['alignment_occurrence'] for u in units) == [0, 1]
    for u in units:
        member = u['source_members'][0]
        assert member['record_sha256'] == u['provenance']['representative_record_sha256']
        assert member['library_id'] == str(path.resolve())


def test_count_endpoint_transport_is_separate_from_atomic_links():
    import asyncio
    from routers.footprint import consensus_catalog
    from services.consensus_workflow import _summary
    s,job,_=state()
    cross=job['result']['cross']
    cross['count_groups']=[dict(group_id='XG_a',kind='coarse_union',left_families=['d:A','d:B'],right_families=['h:A'])]
    cross['count_semantics']='Descriptive, not calibrated occupancy'
    cross['edges']=[dict(edge_id='e1',count_group_id='XG_a'),dict(edge_id='e2',count_group_id='XG_a')]
    summary=_summary(job)['cross_summary']
    assert summary['count_group_statuses']=={'coarse_union':1}
    assert 'edges' not in summary and 'count_groups' not in summary
    catalog=asyncio.run(consensus_catalog('job',state=s))
    assert catalog['edges']==cross['edges']
    assert catalog['count_groups']==cross['count_groups']
    assert catalog['count_semantics']==cross['count_semantics']



def test_import_takes_the_stringency_the_assignments_were_made_at(tmp_path):
    import gzip,json
    from services.consensus_workflow import _snapshot,import_result,_session,STAGED_MODE
    from fiberhmm.inference.consensus.parameters import parse_options,options_dict
    s,job,ds=state();path=tmp_path/'source.bam';path.write_bytes(b'test-source')
    ds.path=str(path);ds.paths=[str(path)];ds.family_scan_chemistry='ddda'
    r=deepcopy(job['result']);r.update(schema='fiberhmm.consensus.v1',cr_mode=STAGED_MODE)
    params=options_dict(parse_options({'cr':{'engine':STAGED_MODE}}));params['families']['assignment_reference_percent']=95
    r['manifest'].update(status='complete',browser_sources=_snapshot(s,['d']),parameters=params,
        datasets=[dict(dataset_id='d',chemistry='ddda')])
    loaded=import_result(s,gzip.compress(json.dumps(r).encode()))
    jobs,_=_session(s)
    assert jobs[loaded['job_id']]['filters']['classification_reference_percent']==95


def test_bam_export_groups_cover_each_run_bam_once():
    from services.consensus_workflow import _bam_export_groups
    job=dict(_snapshot={'a':dict(paths=['/x/a.bam']),'b':dict(paths=['/x/b.bam'])},result={})
    open_a=SimpleNamespace(data_type='bam',paths=['/x/a.bam'])
    unrelated=SimpleNamespace(data_type='bam',paths=['/x/a.bam','/x/other.bam'])
    s=SimpleNamespace(datasets={'a':open_a,'u':unrelated})  # b was closed since the run
    assert _bam_export_groups(s,job)==[dict(dataset_id='a',paths=['/x/a.bam']),dict(dataset_id='b',paths=['/x/b.bam'])]


def test_non_bam_route_names_units_by_dataset_position_not_label(monkeypatch):
    """Like FiberHMM's BAM loader, the Browser's own (non-BAM) evidence route passes each dataset's position in the
    request as dataset_ordinal, so evidence-unit IDs (which order and fold class discovery) never hash a label or
    path (fh-unit-id; this call was missed there)."""
    import numpy as np
    import services.consensus_evidence as ce
    import fiberhmm.inference.consensus.adapter as adapter
    from services.consensus_workflow import load_payload
    from fiberhmm.inference.consensus.parameters import parse_options
    seen=[]
    reads={'a':[SimpleNamespace(name='r1')],'b':[SimpleNamespace(name='r2')]}
    model=SimpleNamespace(emissionprob_=np.zeros((2,2)))
    monkeypatch.setattr(ce,'_runtime',lambda:{})
    monkeypatch.setattr(ce,'_load_dataset_evidence',lambda state,dsid,chemistry,**k:(reads[dsid],model,{},{}))
    monkeypatch.setattr(ce,'_prefix_library',lambda read,dsid:None)
    monkeypatch.setattr(ce,'_projection_members',lambda *a,**k:{})
    monkeypatch.setattr(ce,'_projection_member_key',lambda read:read.name)
    def unit(read,model,dsid,members,start,end,**k):
        seen.append((dsid,k.get('dataset_ordinal')))
        return dict(unit_id=f"u{k.get('dataset_ordinal')}_{read.name}",strand='pooled',provenance={})
    monkeypatch.setattr(adapter,'evidence_unit',unit)
    datasets={d:SimpleNamespace(label=d.upper(),data_type='bigbed',available_layers={},paths=[f'/x/{d}.bb'],path=f'/x/{d}.bb')
              for d in ('a','b')}
    s=SimpleNamespace(get_dataset=lambda d:datasets[d])
    options=parse_options({'cr':{'engine':'staged_native_families'},'input':{'correct_native':False}})
    payload=load_payload(s,dict(dataset_ids=['b','a'],chrom='chr1',start=0,end=100,
                                chemistry_overrides={'a':'hia5-pacbio','b':'hia5-pacbio'}),options,lambda *_:None)
    assert seen==[('b',0),('a',1)]
    assert [s['dataset_id'] for s in payload['strata']]==['b','a']
