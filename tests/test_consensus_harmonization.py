"""Current kernel -> Browser index/catalog -> manual override integration."""
from copy import deepcopy
from types import SimpleNamespace
import gzip
import json
import threading

import pytest
from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime()
from fiberhmm.inference.consensus.workflow import run_workflow
from services.consensus_workflow import _index, _visible, get_native_call, _snapshot, import_result, _summary
from services.consensus_curation import get_curation, update_curation, curated_records_for_unit
from routers.footprint import _consensus_catalog_payload


@pytest.fixture
def completed(tmp_path):
    datasets={};strata=[]
    for ds in ('d','h','third'):
        path=tmp_path/f'{ds}.bam';path.write_bytes(b'source-identity-fixture')
        datasets[ds]=SimpleNamespace(path=str(path),paths=[str(path)],family_scan_chemistry='ddda',available_layers={},derived_layers={})
        units=[]
        for i in range(6):
            calls=[[20,30]]+([[70,80]] if i%2 else [])
            units.append(dict(unit_id=f'{ds}{i}',read_name=f'{ds}_read{i}',fold_group_id=f'{ds}{i}',
                strand='CT' if i%2 else 'GA',positions=[20,23,26,29,70,73,76,79],hits=[0]*8,
                p_accessible=[.8]*8,p_protected=[.05]*8,reference_start=0,reference_end=100,
                aligned_blocks=[[0,100]],raw_nuc_intervals=[],msp_intervals=[[0,100]],
                native_multi_interval_calls=[dict(interval=c,llr=6.,opportunities=4) for c in calls]))
        strata.append(dict(dataset_id=ds,chemistry='ddda',model_manifest=dict(native_minimum_llr=5.),units=units))
    state=SimpleNamespace(get_dataset=datasets.get,consensus_workflow_jobs={},consensus_workflow_lock=threading.RLock(),consensus_workflow_active=None)
    payload=dict(region=dict(chrom='chr1',start=0,end=100),strata=strata,browser_sources=_snapshot(state,list(datasets)))
    result=run_workflow(payload,{'cr':{'engine':'call_harmonization'},'cross':{'enabled':True,'lattice_minimum_covered_units':1}},tmp_path/'result')
    index,layers=_index(result)
    job=dict(job_id='j',status='complete',result=result,index=index,layers=layers,filters={})
    state.consensus_workflow_jobs['j']=job;state.consensus_workflow_active='j'
    return state,job


def test_new_mode_indexes_unchanged_calls_and_dataset_qualified_edges_once(completed):
    state,job=completed
    assert {'tf_cr','tf_sr_lattice','tf_xcr','tf_cr_manual'}<=set(job['layers'])
    for ds,index in job['index'].items():
        for uid,records in index['per_unit'].items():
            for call in records['tf_cr']:
                assert call['cr_mode']=='call_harmonization'
                assert call['interval']==call['source_interval']
                assert _visible(call,dict(minimum_model_q=120,minimum_comparability_q=120),'CT')
            for call in records['tf_xcr']:
                assert len(call['links'])==2  # One partner in each OTHER dataset.
                assert len({e['edge_id'] for e in call['links']})==2
                assert all(ds in (e['left_dataset'],e['right_dataset']) for e in call['links'])


def test_catalog_and_call_detail_do_not_invoke_legacy_fit_classification(completed,monkeypatch):
    state,job=completed
    import fiberhmm.inference.consensus.native_presentation as presentation
    def forbidden(*_):raise AssertionError('Legacy fitted classifier was invoked')
    monkeypatch.setattr(presentation,'classify_proposal',forbidden)
    detail=get_native_call(state,'j','d','d:d0:0')
    assert detail['call']['native_llr']==6.
    assert detail['call']['source_interval']==[20,30]
    catalog=_consensus_catalog_payload('j',state)
    assert catalog['cr_mode']=='call_harmonization'
    assert catalog['comparison']==job['result']['comparison']
    assert catalog['comparison']['rows']


def test_merge_split_undo_preserve_automatic_comparison_ledger(completed):
    state,job=completed;before=deepcopy(job['result'])
    families=[f['family'] for f in job['result']['datasets']['d']['cr']['catalog']]
    assert len(families)==2
    def edit(operation,**kwargs):
        return update_curation(state,'j',dict(expected_revision=get_curation(state,'j')['revision'],operation=operation,**kwargs))
    merged=edit('merge',dataset_id='d',family_ids=families)
    group=merged['manual_groups'][0]
    records=curated_records_for_unit(job,'d','d1',job['index']['d']['per_unit']['d1']['tf_cr'])
    assert len(records)==2 and [r['interval'] for r in records]==[[20,30],[70,80]]
    assert all(r['manual_group_id']==group['group_id'] for r in records)
    split=edit('split',dataset_id='d',family_ids=[group['family']],split=dict(by='start',threshold=50))
    assert len(split['manual_groups'])==2
    assert edit('undo')['manual_groups']==merged['manual_groups']
    assert edit('redo')['manual_groups']==split['manual_groups']
    assert job['result']==before


def test_current_frozen_export_import_roundtrip(completed):
    state,job=completed
    imported=import_result(state,gzip.compress(json.dumps(job['result']).encode()))
    new=state.consensus_workflow_jobs[imported['job_id']]
    assert new['result']==job['result']
    assert new['result']['cr_mode']=='call_harmonization'
    assert _consensus_catalog_payload(imported['job_id'],state)['comparison']['rows']


def test_rejected_import_leaves_no_artifact_directory(completed, monkeypatch, tmp_path):
    import services.consensus_workflow as cw
    state,job=completed
    made=[]
    real=cw.tempfile.mkdtemp
    def tracking_mkdtemp(*args, **kwargs):
        path=real(*args, dir=str(tmp_path), **{k:v for k,v in kwargs.items() if k!='dir'})
        made.append(path);return path
    monkeypatch.setattr(cw.tempfile,'mkdtemp',tracking_mkdtemp)
    bad=dict(job['result'],manual_curation={'schema':'not-a-curation-history'})
    before=set(state.consensus_workflow_jobs)
    with pytest.raises(Exception):
        import_result(state,gzip.compress(json.dumps(bad).encode()))
    import os
    assert made and not any(os.path.exists(path) for path in made)
    assert set(state.consensus_workflow_jobs)==before
    assert state.consensus_workflow_active=='j'


def test_summary_separates_retained_outside_context_from_in_region_assignments(completed):
    _,job=completed
    row=job['result']['datasets']['d']['cr']['records'][0]
    for interval in ([120,130],[90,110]):
        row['proposals'].append(dict(row['proposals'][0],interval=interval,family=None))
    summary=_summary(job)['summary']['d']
    assert summary['source_calls']==11
    assert summary['source_calls_in_region']==9
    assert summary['assignments']==9
    assert summary['boundary_crossing_calls']==1
    assert summary['outside_region_calls']==1
    assert summary['numerical_fit'] is None
