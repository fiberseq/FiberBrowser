from copy import deepcopy
from types import SimpleNamespace
import threading

import pytest

from services import consensus_workflow as workflow
from services.consensus_curation import get_curation, update_curation, CurationUnavailable
from services.consensus_curation import curated_display_families,curated_records_for_unit,SHARED_SCOPE
from services.consensus_curation import export_history,restore_history


def fixture():
    workflow._runtime()
    def snapshot(families):
        return dict(datasets={'d':dict(units=[dict(unit_id='u',read_name='read',reference_start=0,reference_end=100,native_intervals=[[10,30]])],
            sr=dict(status='disabled',records=[]),cr=dict(status='complete',catalog=[dict(family=f,consensus_start=10,consensus_end=30) for f in families],
                records=[dict(unit_id='u',strand='pooled',proposals=[dict(source_call_id='call',source_interval=[10,30],interval=[10,30],family=families[0],
                    compatible_alternatives=families[1:],classification_status='compatible_catalog_label',cr_mode=workflow.STAGED_MODE)])]),
            rescue=dict(status='disabled'),split=dict(status='disabled'),comparability=dict(status='disabled'))},
            cross=dict(status='disabled',edges=[]))
    snapshots={'native':snapshot(['A','B']), 'resolved':snapshot(['M','N'])}
    result=dict(schema='fiberhmm.consensus.v1',cr_mode=workflow.STAGED_MODE,
                manifest=dict(region=dict(chrom='chr1',start=0,end=100)),final_stage='resolved',
                stage_results=snapshots,stages=[],**snapshots['resolved'])
    job=dict(job_id='j',status='complete',result=result,filters=workflow.schema()['display_defaults'])
    job['index'],job['layers']=workflow._index(result)
    state=SimpleNamespace(consensus_workflow_jobs={'j':job},consensus_workflow_lock=threading.RLock(),consensus_workflow_active='j')
    return state,job


def test_stage_selection_updates_tracks_but_not_result_or_curation(monkeypatch):
    state,job=fixture();frozen=deepcopy(job['result']);curation=get_curation(state,'j')
    monkeypatch.setattr(workflow,'_register',lambda *args:None)
    workflow.select_stage(state,'j','native')
    assert workflow.viewed_result(job)['datasets']['d']['cr']['catalog'][0]['family']=='A'
    assert job['index']['d']['per_unit']['u']['tf_cr'][0]['family']=='A'
    assert get_curation(state,'j')==curation
    with pytest.raises(CurationUnavailable,match='read-only'):
        update_curation(state,'j',dict(expected_revision=0,operation='merge',dataset_id='d',family_ids=['M','N']))
    workflow.select_stage(state,'j','resolved')
    assert job['index']['d']['per_unit']['u']['tf_cr'][0]['family']=='M'
    assert job['result']==frozen


def test_manual_alternative_membership_is_not_lost():
    state,job=fixture()
    get_curation(state,'j')
    assert job['_curation']['index']['d']['members']['N']=={'call'}
    result=update_curation(state,'j',dict(expected_revision=0,operation='merge',dataset_id='d',family_ids=['M','N']))
    assert result['manual_groups'][0]['call_ids']==['call']
    assert result['manual_groups'][0]['source_family_ids']==['M','N']


def test_full_stage_evidence_is_on_demand_not_in_every_read_projection():
    state,job=fixture()
    original=job['result']['datasets']['d']['cr']['records'][0]['proposals'][0]
    original['family_evidence']={'complete':'immutable MC ledger'}
    index,_=workflow._index(job['result'])
    projected=index['d']['per_unit']['u']['tf_cr'][0]
    assert 'family_evidence' not in projected and projected['full_candidate_evidence_on_demand']
    full=workflow.get_native_call(state,'j','d','call')
    assert full['call']['family_evidence']==original['family_evidence']


def test_on_demand_call_expands_shared_evidence_after_import():
    from fiberhmm.inference.consensus.harmonized_families.evidence import intern
    state,job=fixture();pool={};evidence={'scores':[dict(loss=i,family='A') for i in range(100)]}
    call=job['result']['datasets']['d']['cr']['records'][0]['proposals'][0]
    call['family_evidence']=intern(evidence,pool)
    job['result'].update(evidence_encoding='shared_json_v1',evidence_pool=pool)
    assert workflow.get_native_call(state,'j','d','call')['call']['family_evidence']==evidence


def test_shared_manual_merge_split_undo_across_datasets():
    state,job=fixture();job['result']['manifest']['mode']='XCR'
    h=deepcopy(job['result']['datasets']['d']);h['units'][0]['unit_id']='hu'
    h['cr']['records'][0]['unit_id']='hu';h['cr']['records'][0]['proposals'][0]['source_call_id']='hcall'
    job['result']['datasets']['h']=h
    frozen=deepcopy(job['result']);revision=0
    def edit(op,**kwargs):
        nonlocal revision
        out=update_curation(state,'j',dict(expected_revision=revision,operation=op,**kwargs))
        revision=out['revision'];return out
    result=edit('merge',dataset_id=SHARED_SCOPE,family_ids=['M','N'])
    group=result['manual_groups'][0];assert group['call_ids']==['call','hcall']
    for ds,call_id in [('d','call'),('h','hcall')]:
        display=curated_display_families(job,ds)
        manual=next(f for f in display if f['manual'])
        assert manual['group_id']==group['group_id'] and manual['effective_call_ids']==[call_id]
        assert all(f['superseded_by_manual'] for f in display if not f['manual'])
    result=edit('split',dataset_id=SHARED_SCOPE,family_ids=[group['group_id']],split=dict(by='call_ids',call_ids=['call']))
    assert {tuple(g['call_ids']) for g in result['manual_groups']}=={('call',),('hcall',)}
    assert edit('undo')['manual_groups']==[group]
    assert edit('undo')['manual_groups']==[]
    assert len(edit('redo')['manual_groups'])==1
    assert job['result']==frozen


def test_manual_merge_preserves_unselected_compatible_family():
    state,job=fixture()
    cr=job['result']['datasets']['d']['cr']
    cr['catalog'].append(dict(family='OTHER',consensus_start=10,consensus_end=30))
    cr['records'][0]['proposals'][0]['compatible_alternatives'].append('OTHER')
    update_curation(state,'j',dict(expected_revision=0,operation='merge',dataset_id='d',family_ids=['M','N']))
    output=curated_records_for_unit(job,'d','u',cr['records'][0]['proposals'])
    assert output[0]['compatible_alternatives']==['OTHER']
    assert next(f for f in curated_display_families(job,'d') if f['family']=='OTHER')['effective_call_ids']==['call']


def test_export_restore_retains_redo_and_rejects_tampering():
    state,job=fixture()
    update_curation(state,'j',dict(expected_revision=0,operation='merge',dataset_id='d',family_ids=['M','N']))
    update_curation(state,'j',dict(expected_revision=1,operation='undo'))
    receipt=export_history(job)
    other=dict(job);other.pop('_curation')
    restore_history(other,receipt)
    assert export_history(other)==receipt
    assert other['_curation']['cursor']==0 and len(other['_curation']['history'])==1
    corrupted=deepcopy(receipt);corrupted['history'][0]['family_ids']=['M','unknown']
    with pytest.raises(ValueError):restore_history(other,corrupted)
    assert export_history(other)==receipt


def test_ignore_one_family_retains_the_other_compatible_label():
    state,job=fixture();cr=job['result']['datasets']['d']['cr']
    update_curation(state,'j',dict(expected_revision=0,operation='ignore',dataset_id='d',family_ids=['M']))
    output=curated_records_for_unit(job,'d','u',cr['records'][0]['proposals'])
    assert output[0]['family']=='N' and not output[0]['unclassified']
    assert output[0]['compatible_families']==['N']
    update_curation(state,'j',dict(expected_revision=1,operation='ignore',dataset_id='d',family_ids=['N']))
    output=curated_records_for_unit(job,'d','u',cr['records'][0]['proposals'])
    assert output[0]['manual_ignored'] and output[0]['family'] is None


def test_merging_classes_that_are_no_calls_best_fit_is_refused_cleanly():
    # A merge takes calls whose best-fit class is merged; the call here is M's,
    # so merging O and P (it only also fits them) has nothing to take, and a
    # second group can't claim it from the first.
    state,job=fixture();cr=job['result']['datasets']['d']['cr']
    for f in ['O','P']:
        cr['catalog'].append(dict(family=f,consensus_start=10,consensus_end=30))
        cr['records'][0]['proposals'][0]['compatible_alternatives'].append(f)
    first=update_curation(state,'j',dict(expected_revision=0,operation='merge',dataset_id='d',family_ids=['M','N']))
    with pytest.raises(ValueError,match='nothing to merge'):
        update_curation(state,'j',dict(expected_revision=1,operation='merge',dataset_id='d',family_ids=['O','P']))
    output=curated_records_for_unit(job,'d','u',cr['records'][0]['proposals'])
    group_id=first['manual_groups'][0]['group_id']
    assert output[0]['manual_group_ids']==[group_id]
    assert [g['effective_call_ids'] for g in curated_display_families(job,'d') if g['manual']]==[['call']]


def test_xcr_curation_cannot_diverge_by_dataset():
    state,job=fixture();job['result']['manifest']['mode']='XCR'
    with pytest.raises(ValueError,match='shared-family'):
        update_curation(state,'j',dict(expected_revision=0,operation='merge',dataset_id='d',family_ids=['M','N']))


def _projecting(monkeypatch,job):
    snapshots=job['result']['stage_results'];calls=[]
    def project(j,reference,stage=None,inspect_only=False):
        stage=stage or j.get('view_stage',j['result']['final_stage'])
        calls.append((stage,reference,inspect_only))
        return deepcopy(snapshots[stage])
    monkeypatch.setattr(workflow,'_staged_assignment_view',project)
    monkeypatch.setattr(workflow,'_register',lambda *args:None)
    return calls


def test_export_declares_the_reference_the_final_assignments_were_made_at(monkeypatch):
    # 95 on the final stage, then 90 while looking at an earlier one: the final
    # assignments are still the 95 ones.
    state,job=fixture();job['result']['manifest']['parameters']={'families':{}}
    _projecting(monkeypatch,job)
    workflow.set_filters(state,'j',{'classification_reference_percent':95})
    workflow.select_stage(state,'j','native')
    workflow.set_filters(state,'j',{'classification_reference_percent':90})
    exported=workflow.assignment_export_result(job)
    assert exported['manifest']['parameters']['families']['assignment_reference_percent']==95


def test_earlier_stages_can_be_inspected_after_manual_edits(monkeypatch):
    state,job=fixture()
    calls=_projecting(monkeypatch,job)
    workflow.set_filters(state,'j',{'classification_reference_percent':95})
    job['_curation']={'history':[{'operation':'merge'}]}
    workflow.select_stage(state,'j','native')
    assert calls[-1]==('native',95,True)
    before=len(calls)
    workflow.select_stage(state,'j','resolved')
    assert len(calls)==before  # the edited final stage keeps its view


def test_projecting_another_stage_to_look_at_it_leaves_manual_edits_alone():
    _,job=fixture();job['_curation']={'history':[{'operation':'merge'}]}
    with pytest.raises(ValueError,match='manual edits'):
        workflow._staged_assignment_view(job,95,'resolved')
    # inspect_only gets past the guard (and on to the saved evidence it needs).
    with pytest.raises(Exception) as err:
        workflow._staged_assignment_view(job,95,'native',inspect_only=True)
    assert 'manual edits' not in str(err.value)


def test_registering_a_job_skips_datasets_closed_since_the_run():
    state,job=fixture()
    state.get_dataset=lambda dsid:None
    state.datasets={}
    workflow._register(state,job)  # no AttributeError



def test_a_saved_class_keeps_its_stage_while_another_is_inspected(monkeypatch):
    state,job=fixture()
    monkeypatch.setattr(workflow,'_register',lambda *args:None)
    assert workflow.state_read_ids(state,'j','d','M')['read_ids']==['read']
    workflow.select_stage(state,'j','native')
    assert workflow.state_read_ids(state,'j','d','M')['read_ids']==[]  # not in the viewed stage
    assert workflow.state_read_ids(state,'j','d','M',stage='resolved')['read_ids']==['read']


def test_a_manual_class_filters_by_its_primary_label(monkeypatch):
    import services.consensus_curation as curation
    state,job=fixture()
    def curated(job,dataset_id,unit_id,records):
        return [dict(records[0],family='manual:P',manual_group_ids=['manual:P','manual:Q'])]
    monkeypatch.setattr(curation,'curated_records_for_unit',curated)
    assert workflow.state_read_ids(state,'j','d','manual:P')['read_ids']==['read']
    assert workflow.state_read_ids(state,'j','d','manual:Q')['read_ids']==[]


def test_stringency_change_while_inspecting_an_earlier_stage_keeps_edits(monkeypatch):
    state,job=fixture()
    calls=_projecting(monkeypatch,job)
    job['_curation']={'history':[{'operation':'merge'}]}
    workflow.select_stage(state,'j','native')
    workflow.set_filters(state,'j',{'classification_reference_percent':90})
    assert calls[-1]==('native',90,True)
    assert job['_curation']['history']


def test_selecting_a_stage_of_another_job_leaves_the_active_layers(monkeypatch):
    state,job=fixture();registered=[]
    monkeypatch.setattr(workflow,'_register',lambda s,j:registered.append(j['job_id']))
    state.consensus_workflow_active='other'
    workflow.select_stage(state,'j','native')
    assert registered==[]


def test_returning_to_a_reprojected_final_stage_rebuilds_unedited_curation(monkeypatch):
    state,job=fixture()
    _projecting(monkeypatch,job)
    workflow.set_filters(state,'j',{'classification_reference_percent':95})
    workflow.select_stage(state,'j','native')
    workflow.set_filters(state,'j',{'classification_reference_percent':90})
    job['_curation']={'history':[],'marker':True}  # built on the 95% final view
    workflow.select_stage(state,'j','resolved')
    assert 'marker' not in job.get('_curation',{})


def test_ignored_records_match_no_state_filter(monkeypatch):
    import services.consensus_curation as curation
    state,job=fixture()
    def curated(job,dataset_id,unit_id,records):
        return [dict(records[0],family='manual:P',manual_group_id='manual:P',manual_ignored=True,
                     classification_status='manual_ignored')]
    monkeypatch.setattr(curation,'curated_records_for_unit',curated)
    assert workflow.state_read_ids(state,'j','d','manual:P')['read_ids']==[]


def test_a_curated_final_stage_reports_the_stringency_it_was_made_at(monkeypatch):
    state,job=fixture()
    _projecting(monkeypatch,job)
    workflow.set_filters(state,'j',{'classification_reference_percent':95})
    job['_curation']={'history':[{'op':'merge'}]}  # edited at 95%
    workflow.select_stage(state,'j','native')
    workflow.set_filters(state,'j',{'classification_reference_percent':90})
    out=workflow.select_stage(state,'j','resolved')
    assert job['filters']['classification_reference_percent']==95
    assert out['filters']['classification_reference_percent']==95


def test_a_curated_final_stage_never_reprojected_reports_the_runs_stringency(monkeypatch):
    state,job=fixture()
    _projecting(monkeypatch,job)
    job['result']['manifest']['parameters']={'families':{'assignment_reference_percent':99.9}}
    job['_curation']={'history':[{'op':'merge'}]}  # edited at the run's 99.9%
    workflow.select_stage(state,'j','native')
    workflow.set_filters(state,'j',{'classification_reference_percent':90})
    out=workflow.select_stage(state,'j','resolved')
    assert out['filters']['classification_reference_percent']==99.9
