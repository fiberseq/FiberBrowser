from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import asyncio
import threading

import pytest

from services.consensus_curation import (
    CurationConflict, CurationUnavailable, annotate_record, curated_display_families,
    get_curation, manual_records_for_unit, subclass_candidates, update_curation,
)


def fixture():
    families = [dict(family=f'd:{name}', consensus_start=100, consensus_end=140)
                for name in ('A', 'B', 'C')]
    records = [dict(unit_id='u1', strand='CT', proposals=[
        dict(source_call_id='d:u1:0', source_ordinal=0, family='d:A', interval=[100, 110], model_membership=.8),
        dict(source_call_id='d:u1:1', source_ordinal=1, family='d:B', interval=[130, 180], model_membership=.9)]),
        dict(unit_id='u2', strand='GA', proposals=[
        dict(source_call_id='d:u2:0', source_ordinal=0, family='d:A', interval=[105, 130], model_membership=.7),
        dict(source_call_id='d:u2:1', source_ordinal=1, family='d:C', interval=[190, 205], model_membership=.6)])]
    ds = dict(cr=dict(status='complete', catalog=families, records=records), units=[],
              sr=dict(status='complete', records=[]), comparability=dict(status='complete', records=[]))
    result = dict(manifest=dict(region=dict(chrom='chr1', start=90, end=220)),
                  datasets={'d': ds, 'h': dict(cr=dict(catalog=[dict(family='h:A')], records=[]))},
                  cross=dict(status='complete', edges=[]))
    job = dict(job_id='j', status='complete', result=result, filters={})
    state = SimpleNamespace(consensus_workflow_jobs={'j': job},
                            consensus_workflow_lock=threading.RLock(), consensus_workflow_active='j')
    return state, job


def edit(state, operation, **kwargs):
    return update_curation(state, 'j', dict(expected_revision=get_curation(state, 'j')['revision'],
                                           operation=operation, **kwargs))


def test_merge_is_separate_manual_catalog_and_source_result_is_immutable():
    state, job = fixture()
    before = deepcopy(job['result'])
    initial = get_curation(state, 'j')
    out = edit(state, 'merge', dataset_id='d', family_ids=['d:A', 'd:B'], label='Left + right')
    group = out['manual_groups'][0]
    assert group['source_family_ids'] == ['d:A', 'd:B']
    assert set(group['call_ids']) == {'d:u1:0', 'd:u1:1', 'd:u2:0'}
    assert 'interval' not in group and 'consensus_start' not in group
    assert group['family'] == group['group_id']
    assert [group['display_start'], group['display_end']] == [100, 140]
    assert group['display_summary_only']
    assert out['catalog_digest'] == initial['catalog_digest']
    assert out['revision'] == 1 and out['can_undo'] and not out['can_redo']
    display = curated_display_families(job, 'd')
    assert display[0]['superseded_by_manual'] and display[1]['superseded_by_manual']
    assert display[2]['effective_call_ids'] == ['d:u2:1']
    assert display[3]['manual'] and display[3]['label'] == 'Left + right'
    assert job['result'] == before


def test_merge_excludes_other_primary_classes_and_uses_selected_class_bounds():
    state,job=fixture()
    ds=job['result']['datasets']['d']
    ds['cr']['records'][1]['proposals'][1]['compatible_alternatives']=['d:A','d:B']
    out=edit(state,'merge',dataset_id='d',family_ids=['d:A','d:B'])
    group=out['manual_groups'][0]
    assert 'd:u2:1' not in group['call_ids']
    assert group['source_family_ids']==['d:A','d:B']
    assert (group['display_start'],group['display_end'])==(100,140)
    display={f['family']:f for f in curated_display_families(job,'d')}
    assert display['d:A']['superseded_by_manual']
    assert display['d:B']['superseded_by_manual']
    assert not display['d:C']['superseded_by_manual']


def test_split_original_call_length_not_normalized_display_geometry():
    state, job = fixture()
    proposal = job['result']['datasets']['d']['cr']['records'][0]['proposals'][0]
    proposal.update(source_intervals=[[100, 110]], interval=[95, 195])
    out = edit(state, 'split', dataset_id='d', family_ids=['d:A'], split=dict(by='length', threshold=20))
    assert [g['call_ids'] for g in out['manual_groups']] == [['d:u1:0'], ['d:u2:0']]
    assert manual_records_for_unit(job, 'd', 'u1')[0]['interval'] == [100, 110]
    assert proposal['interval'] == [95, 195]


def test_staged_subclass_recovery_uses_frozen_parent_models_not_coordinate_splits():
    state, job = fixture()
    result=job['result'];result['cr_mode']='staged_native_families';result['manifest']['mode']='CR'
    final=result['datasets']['d']['cr'];final['catalog'][0]['hypothesis']={
        'kind':'bounded_parent','children':['native:left','native:right'],'replaces_parents':['parent:right']}
    # A residual call belongs to the consolidated state but to neither frozen
    # parent-stage subclass. Recovering subclasses must not recreate the parent.
    final['records'].append(dict(unit_id='u3',strand='CT',proposals=[
        dict(source_call_id='d:u3:0',source_ordinal=0,family='d:A',interval=[112,122],model_membership=.6)]))
    parent_catalog=[
        dict(family='parent:left',consensus_start=96.5,consensus_end=116.5,hypothesis={'kind':'bounded_parent','children':['native:left']},
             classification_counts={'CT':{'primary_calls':1,'compatible_calls':1}}),
        dict(family='parent:right',consensus_start=103.5,consensus_end=136.5,hypothesis={'kind':'bounded_parent','children':['native:right']},
             classification_counts={'GA':{'primary_calls':1,'compatible_calls':1}}),
    ]
    parent_records=[
        dict(unit_id='u1',proposals=[dict(source_call_id='d:u1:0',source_interval=[100,110],family='parent:left',compatible_alternatives=[])]),
        dict(unit_id='u2',proposals=[dict(source_call_id='d:u2:0',source_interval=[105,130],family='parent:right',compatible_alternatives=[])]),
    ]
    result['stage_results']={'parents':{'datasets':{'d':{'cr':{'catalog':parent_catalog,'records':parent_records}}}}}
    candidates=subclass_candidates(job,'d','d:A')
    assert [(c['family'],c['member_calls']) for c in candidates]==[('parent:left',1),('parent:right',1)]
    out=edit(state,'restore_subclasses',dataset_id='d',family_ids=['d:A'],subclass_ids=['parent:left','parent:right'])
    assert [g['model_family_id'] for g in out['manual_groups']]==['parent:left','parent:right']
    assert [(g['display_start'],g['display_end']) for g in out['manual_groups']]==[(96.5,116.5),(103.5,136.5)]
    display=curated_display_families(job,'d')
    assert next(f for f in display if f['family']=='d:A')['superseded_by_manual']
    assert [(f['display_start'],f['display_end']) for f in display if f.get('manual')]==[(96.5,116.5),(103.5,136.5)]
    residual=annotate_record(job,'d','u3',final['records'][-1]['proposals'][0])
    assert residual['manual_curation']['ignored']


@pytest.mark.parametrize('criterion,first', [
    ({'by': 'start', 'threshold': 102}, ['d:u1:0']),
    ({'by': 'end', 'threshold': 110}, ['d:u1:0']),
    ({'by': 'call_ids', 'call_ids': ['d:u2:0']}, ['d:u2:0']),
])
def test_split_criteria_partition_call_ids(criterion, first):
    state, _ = fixture()
    out = edit(state, 'split', dataset_id='d', family_ids=['d:A'], split=criterion)
    assert out['manual_groups'][0]['call_ids'] == first
    parts = [set(g['call_ids']) for g in out['manual_groups']]
    assert not parts[0] & parts[1]
    assert parts[0] | parts[1] == {'d:u1:0', 'd:u2:0'}


def test_merge_manual_split_then_reset_and_undo_redo_are_full_state_transitions():
    state, job = fixture()
    merged = edit(state, 'merge', dataset_id='d', family_ids=['d:A', 'd:B'])
    merged_id = merged['manual_groups'][0]['group_id']
    split = edit(state, 'split', dataset_id='d', family_ids=[merged_id], split=dict(by='length', threshold=25))
    assert len(split['manual_groups']) == 2
    ignored_id = split['manual_groups'][0]['group_id']
    ignored = edit(state, 'ignore', dataset_id='d', family_ids=[ignored_id])
    assert ignored['ignored_families'] == {'d': [ignored_id]}
    reset = edit(state, 'reset')
    assert reset['manual_groups'] == [] and reset['ignored_families'] == {}
    undo = edit(state, 'undo')
    assert undo['manual_groups'] == ignored['manual_groups']
    assert undo['ignored_families'] == ignored['ignored_families']
    assert undo['can_redo'] and undo['revision'] == 5
    assert edit(state, 'redo')['manual_groups'] == []
    edit(state, 'undo')
    edit(state, 'undo')
    assert get_curation(state, 'j')['manual_groups'] == split['manual_groups']
    edit(state, 'undo')
    assert get_curation(state, 'j')['manual_groups'] == merged['manual_groups']
    edit(state, 'undo')
    assert get_curation(state, 'j')['manual_groups'] == []
    with pytest.raises(ValueError, match='Nothing to undo'):
        edit(state, 'undo')


def test_new_edit_after_undo_discards_only_redo_branch():
    state, _ = fixture()
    edit(state, 'ignore', dataset_id='d', family_ids=['d:A'])
    edit(state, 'ignore', dataset_id='d', family_ids=['d:B'])
    edit(state, 'undo')
    out = edit(state, 'ignore', dataset_id='d', family_ids=['d:C'])
    assert out['ignored_families'] == {'d': ['d:A', 'd:C']}
    assert not out['can_redo']
    assert len(out['operations']) == 2


def test_ignore_unignore_and_manual_annotations_do_not_modify_native_calls():
    state, job = fixture()
    native = job['result']['datasets']['d']['cr']['records'][0]['proposals'][0]
    before = deepcopy(native)
    merged = edit(state, 'merge', dataset_id='d', family_ids=['d:A', 'd:B'])
    tagged = annotate_record(job, 'd', 'u1', native)
    assert tagged['manual_group_id'] == merged['manual_groups'][0]['group_id']
    assert tagged['automatic_family'] == 'd:A' and tagged['family'] == 'd:A'
    assert tagged['model_membership'] == native['model_membership']
    assert len(manual_records_for_unit(job, 'd', 'u1')) == 2
    edit(state, 'ignore', dataset_id='d', family_ids=['d:A'])
    assert annotate_record(job, 'd', 'u1', native)['manual_curation']['ignored']
    assert [r['source_call_id'] for r in manual_records_for_unit(job, 'd', 'u1')] == ['d:u1:1']
    edit(state, 'unignore', dataset_id='d', family_ids=['d:A'])
    assert len(manual_records_for_unit(job, 'd', 'u1')) == 2
    assert native == before


def test_legacy_source_ordinals_and_distinct_ct_ga_units_stay_distinct():
    state, job = fixture()
    rows = job['result']['datasets']['d']['cr']['records']
    for row in rows:
        for proposal in row['proposals']:
            proposal.pop('source_call_id')
            proposal['source_ordinals'] = [proposal.pop('source_ordinal')]
            proposal['source_intervals'] = [proposal['interval']]
    out = edit(state, 'split', dataset_id='d', family_ids=['d:A'], split=dict(by='length', threshold=20))
    assert [g['call_ids'] for g in out['manual_groups']] == [['d:u1:0'], ['d:u2:0']]
    assert annotate_record(job, 'd', 'u2', rows[1]['proposals'][0])['curation_call_ids'] == ['d:u2:0']


def test_unidentified_legacy_calls_fail_closed_not_guessed_by_geometry():
    state, job = fixture()
    rows = job['result']['datasets']['d']['cr']['records']
    for row in rows:
        for proposal in row['proposals']:
            proposal.pop('source_call_id')
            proposal.pop('source_ordinal')
    out = get_curation(state, 'j')
    assert len(out['unavailable_memberships']['d']) == 4
    with pytest.raises(ValueError, match='without unambiguous'):
        edit(state, 'merge', dataset_id='d', family_ids=['d:A', 'd:B'])
    assert annotate_record(job, 'd', 'u1', rows[0]['proposals'][0])['manual_curation']['status'] == 'identity_unavailable'


def test_one_source_call_cannot_have_conflicting_intervals():
    state, job = fixture()
    rows = job['result']['datasets']['d']['cr']['records']
    rows[1]['proposals'][0]['source_call_id'] = 'd:u1:0'
    with pytest.raises(ValueError, match='Conflicting original'):
        get_curation(state, 'j')


def test_stale_revision_digest_and_concurrent_clients_cannot_overwrite():
    state, _ = fixture()
    request = dict(expected_revision=0, operation='ignore', dataset_id='d', family_ids=['d:A'])
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(update_curation, state, 'j', request) for _ in range(2)]
    assert sum(f.exception() is None for f in futures) == 1
    assert sum(isinstance(f.exception(), CurationConflict) for f in futures) == 1
    with pytest.raises(CurationConflict, match='digest'):
        update_curation(state, 'j', dict(request, expected_revision=1, catalog_digest='wrong'))
    assert get_curation(state, 'j')['revision'] == 1


@pytest.mark.parametrize('changes', [
    {'dataset_id': 'h', 'family_ids': ['d:A', 'h:A']},
    {'family_ids': ['d:A', 'h:A']},
    {'family_ids': ['d:A']},
    {'family_ids': ['d:A', 'd:A']},
    {'label': ''}, {'label': 'x' * 201},
    {'extra_unrecognized_parameter': True}, {'expected_revision': True},
])
def test_invalid_merge_is_atomic(changes):
    state, _ = fixture()
    before = get_curation(state, 'j')
    request = dict(expected_revision=0, operation='merge', dataset_id='d', family_ids=['d:A', 'd:B'])
    request.update(changes)
    with pytest.raises(ValueError):
        update_curation(state, 'j', request)
    assert get_curation(state, 'j') == before


@pytest.mark.parametrize('split', [
    {'by': 'length', 'threshold': 999}, {'by': 'start', 'threshold': float('nan')},
    {'by': 'length', 'threshold': True}, {'by': 'call_ids', 'call_ids': ['not-real']},
    {'by': 'call_ids', 'call_ids': []}, {'by': 'call_ids', 'call_ids': ['d:u1:0', 'd:u1:0']},
    {'by': 'cut_interval', 'threshold': 120}, {'by': 'end', 'threshold': 120, 'cut': True},
])
def test_invalid_split_is_atomic(split):
    state, _ = fixture()
    before = get_curation(state, 'j')
    with pytest.raises(ValueError):
        edit(state, 'split', dataset_id='d', family_ids=['d:A'], split=split)
    assert get_curation(state, 'j') == before


def test_incomplete_job_is_not_curatable():
    state, job = fixture()
    job['status'] = 'running'
    with pytest.raises(CurationUnavailable):
        get_curation(state, 'j')


def test_routes_revision_errors_and_catalog_keep_automatic_catalog(monkeypatch):
    from fastapi import HTTPException
    from routers.footprint import consensus_curation, update_consensus_curation, consensus_catalog
    monkeypatch.setattr('services.consensus_workflow.rescue_rate_summary', lambda *args: {})
    state, job = fixture()
    before = deepcopy(job['result']['datasets']['d']['cr']['catalog'])
    initial = asyncio.run(consensus_curation('j', state=state))
    assert initial['revision'] == 0
    request = dict(expected_revision=0, operation='merge', dataset_id='d', family_ids=['d:A', 'd:B'])
    assert asyncio.run(update_consensus_curation('j', request, state=state))['revision'] == 1
    with pytest.raises(HTTPException) as stale:
        asyncio.run(update_consensus_curation('j', request, state=state))
    assert stale.value.status_code == 409
    with pytest.raises(HTTPException) as absent:
        asyncio.run(consensus_curation('missing', state=state))
    assert absent.value.status_code == 404
    with pytest.raises(HTTPException) as invalid:
        asyncio.run(update_consensus_curation('j', dict(request, expected_revision=1, family_ids=['d:A', 'h:A']), state=state))
    assert invalid.value.status_code == 422
    catalog = asyncio.run(consensus_catalog('j', state=state))
    assert catalog['datasets']['d']['catalog'] == before
    assert any(f['manual'] for f in catalog['datasets']['d']['curated_display_families'])
    assert catalog['curation']['revision'] == 1
