from copy import deepcopy
from types import SimpleNamespace
import asyncio
import threading

import pytest

from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime()
from fiberhmm.inference.consensus.native_presentation import classify_proposal
from services.consensus_workflow import (
    NATIVE_CR_MODE, _index, _register, _summary, _visible, apply_overlays, schema, set_filters,get_native_call,
)
from services.consensus_curation import get_curation, update_curation
from models.domain import WorkingSet


@pytest.mark.parametrize('flag',['floor_zeroed_loss','tolerance_only_compatibility'])
def test_cross_floor_flag_does_not_claim_no_floor_ablation(flag):
    from services.consensus_workflow import _native_call_link
    edge=dict(link_id='X',families={'d':'d:A','h':'h:B'},comparable=True)
    record=_native_call_link(edge,'d',dict(status='scored',**{flag:True}),'d:u:0')
    assert record['recipient_evidence']['floor_zeroed_loss'] is True
    assert 'tolerance_only_compatibility' not in record['recipient_evidence']


@pytest.mark.parametrize('endpoint,service', [
    ('consensus_jobs','list_jobs'), ('consensus_job','get_job'),
    ('cancel_consensus_job','cancel'), ('consensus_catalog','_consensus_catalog_payload'),
])
def test_consensus_lock_wait_does_not_block_event_loop(monkeypatch,endpoint,service):
    from routers import footprint
    from services import consensus_workflow
    entered=threading.Event();release=threading.Event()
    def blocked(*args):
        entered.set()
        if not release.wait(2):raise AssertionError('The event loop could not release a blocked service')
        return {'ok':True}
    owner=footprint if service=='_consensus_catalog_payload' else consensus_workflow
    monkeypatch.setattr(owner,service,blocked)
    async def exercise():
        args=(None,) if endpoint=='consensus_jobs' else ('j',None)
        task=asyncio.create_task(getattr(footprint,endpoint)(*args))
        try:
            for _ in range(100):
                await asyncio.sleep(.005)
                if entered.is_set():break
            assert entered.is_set() and not task.done()
        finally:
            release.set()
        assert await task=={'ok':True}
    asyncio.run(exercise())


def score(family, upper, distance=1, status='scored'):
    return dict(family=family, status=status, predictive_tail=upper / 2,
                predictive_tail_interval=[0., upper], geometry_distance_sq=distance,
                floor_adjusted_loss=2., native_loss=3.)


def proposal(uid, ordinal, interval, candidates):
    return classify_proposal(dict(source_call_id=f'd:{uid}:{ordinal}', source_ordinal=ordinal,
        source_ordinals=[ordinal], source_intervals=[interval], interval=interval,
        unresolved_family=f'd:unresolved_{uid}_{ordinal}', candidate_evidence=candidates,
        cr_mode=NATIVE_CR_MODE), 99.9)


def fixture():
    rows = [dict(unit_id='u1', strand='CT', source_calls=[[100, 130], [140, 170]], proposals=[
        proposal('u1', 0, [100, 130], [score('d:A', 1., 0, 'core_contradicted'), score('d:B', .02, 400)]),
        proposal('u1', 1, [140, 170], [score('d:A', .6, 20), score('d:B', .0015, 1)])]),
        dict(unit_id='u2', strand='GA', source_calls=[[105, 120], [180, 190]], proposals=[
        proposal('u2', 0, [105, 120], [score('d:A', 1., 1)]),
        proposal('u2', 1, [180, 190], [score('d:B', 1., 1, 'no_observed_opportunities')])])]
    units = [dict(unit_id=row['unit_id'], read_name=row['unit_id'], strand=row['strand'],
                  source_members=[dict(read_name=row['unit_id'], chemical_strand=row['strand'])],
                  native_intervals=row['source_calls']) for row in rows]
    ds = dict(cr_mode=NATIVE_CR_MODE, units=units, sr=dict(status='disabled', records=[]),
        cr=dict(cr_mode=NATIVE_CR_MODE, status='complete', reference_percent=99.9,
            catalog=[dict(family='d:A', consensus_start=100, consensus_end=130),
                     dict(family='d:B', consensus_start=140, consensus_end=170)], records=rows))
    edge = dict(link_id='X1', datasets=['d', 'h'], families={'d': 'd:B', 'h': 'h:A'},
        native_intervals={'d': [140, 170], 'h': [142, 174]}, status='provisional_reciprocal_compatible',
        native_family_evidence={'d': dict(n_source_calls=2, n_compatible=1)}, comparable=True, calibrated=False,
        call_evidence={'d': [dict(unit_id='u1', source_ordinal=1, interval=[140, 170],
            strand='CT', status='scored', predictive_tail_interval=[.1, .2]),
            dict(unit_id='u1', source_ordinal=0, interval=[100, 130], strand='CT',
                 status='core_contradicted', predictive_tail_interval=[1., 1.])]})
    result = dict(cr_mode=NATIVE_CR_MODE, manifest=dict(cr_mode=NATIVE_CR_MODE,
        region=dict(chrom='chr1', start=90, end=210)), datasets={'d': ds},
        cross=dict(cr_mode=NATIVE_CR_MODE, status='complete', edges=[edge], count_groups=[]))
    index, layers = _index(result)
    job = dict(job_id='j', status='complete', result=result, index=index, layers=layers,
               filters=deepcopy(schema()['display_defaults']))
    dataset = SimpleNamespace(available_layers={'tf': True}, derived_layers={})
    state = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock(),
        consensus_workflow_active='j', datasets={'d': dataset}, get_dataset=lambda name: dataset)
    return state, job, dataset


def ws():
    return WorkingSet([dict(id='u1', strand='CT', layers={}), dict(id='u2', strand='GA', layers={})],
                       2, 2, 'chr1', 90, 210)


def test_native_index_retains_every_source_call_and_explicitly_gray_unclassified():
    _, job, _ = fixture()
    index = job['index']['d']
    records = [c for row in index['per_unit'].values() for c in row['tf_cr']]
    assert len(records) == 4
    assert len({c['source_call_id'] for c in records}) == 4
    unresolved = records[-1]
    assert unresolved['family'].startswith('d:unresolved_')
    assert unresolved['unclassified'] and unresolved['display_color'] == '#94a3b8'
    assert unresolved['primary_evidence'] is None
    assert all('model_membership' not in c and 'model_q' not in c for c in records)
    assert {'tf_cr', 'tf_cr_manual', 'tf_xcr'} <= set(index['layers'])


def test_reference_changes_only_display_classification_not_native_result_or_geometry():
    state, job, _ = fixture()
    before = deepcopy(job['result'])
    original_ids = {c['source_call_id']: c['interval'] for row in job['index']['d']['per_unit'].values()
                    for c in row['tf_cr']}
    set_filters(state, 'j', {'classification_reference_percent': 95.})
    calls = job['index']['d']['per_unit']['u1']['tf_cr']
    assert calls[0]['classification_status'] == 'provisional_unresolved'
    assert calls[1]['family'] == 'd:A'
    set_filters(state, 'j', {'classification_reference_percent': 99.9})
    calls = job['index']['d']['per_unit']['u1']['tf_cr']
    assert calls[0]['family'] == 'd:B'  # Saturated A is never rescued by a permissive reference.
    assert calls[1]['family'] == 'd:B' and calls[1]['compatible_alternatives'] == ['d:A']
    assert {c['source_call_id']: c['interval'] for row in job['index']['d']['per_unit'].values()
            for c in row['tf_cr']} == original_ids
    assert job['result'] == before


def test_legacy_q_cannot_erase_native_calls_or_reinterpret_native_evidence():
    state, job, _ = fixture()
    record = job['index']['d']['per_unit']['u2']['tf_cr'][-1]
    assert _visible(record, dict(job['filters'], minimum_model_q=120,
        minimum_comparability_q=120, require_molecule_comparable=True), 'GA')
    set_filters(state, 'j', dict(minimum_model_q=120, minimum_comparability_q=120,
                                require_molecule_comparable=True))
    view = apply_overlays(state, 'd', 'chr1', 90, 210, ws())
    assert sum(len(r['layers']['tf_cr']['consensus_records']) for r in view.reads) == 4
    assert _summary(job)['summary']['d']['unclassified_calls'] == 1
    assert _summary(job)['summary']['d']['numerical_fit'] is None


def test_native_xcr_uses_exact_original_call_identity_and_keeps_failure_ledger():
    state, job, _ = fixture()
    unit = job['index']['d']['per_unit']['u1']
    assert len(unit['tf_xcr']) == 1
    cross = unit['tf_xcr'][0]
    assert cross['source_call_id'] == 'd:u1:1'
    assert cross['interval'] == [140, 170]
    assert cross['links'][0]['receiving_family'] == 'd:B'
    assert cross['links'][0]['other_families'] == {'h': 'h:A'}
    assert 'call_evidence' not in cross['links'][0]
    assert cross['links'][0]['source_call_id'] == 'd:u1:1'
    assert unit['tf_cr'][0]['cross_test_summary']['statuses'] == {'core_contradicted': 1}
    assert 'candidate_evidence' not in unit['tf_cr'][0]
    full = get_native_call(state, 'j', 'd', 'd:u1:0')['call']
    assert len(full['candidate_evidence']) == 2
    assert full['native_cross_tests'][0]['recipient_evidence']['status'] == 'core_contradicted'
    assert full['native_cross_tests'][0]['native_intervals'] == {'d': [140, 170], 'h': [142, 174]}
    assert len(job['result']['cross']['edges'][0]['call_evidence']['d']) == 2


def test_bad_cross_interval_is_reported_not_matched_by_nearby_geometry():
    _, job, _ = fixture()
    job['result']['cross']['edges'][0]['call_evidence']['d'][0]['interval'] = [141, 170]
    index, _ = _index(job['result'])
    assert not index['d']['per_unit']['u1'].get('tf_xcr')
    assert len(index['d']['cross_projection_errors']) == 1


def test_manual_layer_registered_empty_then_projects_original_spans_without_touching_cr():
    state, job, dataset = fixture()
    _register(state, job)
    assert dataset.available_layers['tf_cr_manual']
    assert dataset.derived_layers['tf_cr_manual']['manual']
    assert not dataset.derived_layers['tf_cr_manual']['frozen']
    before = deepcopy(job['result'])
    update_curation(state, 'j', dict(expected_revision=0, operation='merge', dataset_id='d',
                                     family_ids=['d:A', 'd:B'], label='Manual inspection'))
    manual_before = deepcopy(get_curation(state, 'j')['manual_groups'])
    set_filters(state, 'j', {'classification_reference_percent': 95.})
    view = apply_overlays(state, 'd', 'chr1', 90, 210, ws())
    manual = [c for row in view.reads for c in row['layers']['tf_cr_manual']['consensus_records']]
    assert len(manual) == 4
    changed = [c for c in manual if c['manual']]
    assert len(changed) == 3
    assert all(c['manual_label'] == 'Manual inspection' for c in changed)
    assert all(c['primary_evidence'] is None and 'automatic_primary_evidence' in c for c in changed)
    assert {tuple(c['interval']) for c in changed} == {(100, 130), (140, 170), (105, 120)}
    assert get_curation(state, 'j')['manual_groups'] == manual_before
    assert job['result'] == before


def test_manual_ignore_filters_display_not_the_frozen_automatic_catalog():
    state, job, _ = fixture()
    before = deepcopy(job['result'])
    update_curation(state, 'j', dict(expected_revision=0, operation='ignore', dataset_id='d', family_ids=['d:B']))
    view = apply_overlays(state, 'd', 'chr1', 90, 210, ws())
    assert len(view.reads[0]['layers']['tf_cr']['consensus_records']) == 2
    manual = view.reads[0]['layers']['tf_cr_manual']['consensus_records']
    assert len(manual) == 2 and all(c['manual_ignored'] for c in manual)
    assert all(c['display_color'] == '#94a3b8' for c in manual)
    assert len(view.reads[0]['layers']['tf_native_replay']['intervals']) == 2
    assert job['result'] == before


def test_catalog_exposes_native_mode_all_atomic_edges_and_separate_display_counts():
    from routers.footprint import consensus_catalog
    state, job, _ = fixture()
    catalog = asyncio.run(consensus_catalog('j', state=state))
    assert catalog['cr_mode'] == NATIVE_CR_MODE
    assert catalog['datasets']['d']['cr_mode'] == NATIVE_CR_MODE
    assert catalog['datasets']['d']['catalog'] == job['result']['datasets']['d']['cr']['catalog']
    assert catalog['datasets']['d']['display_classification_counts']
    assert len(catalog['edges']) == len(job['result']['cross']['edges'])
    assert catalog['edges'][0]['call_evidence_counts'] == {'d': 2}
    assert 'call_evidence' not in catalog['edges'][0]


def test_native_catalog_update_provenance_is_transported_without_inventing_old_guarantees():
    from routers.footprint import _consensus_catalog_payload
    state, job, _ = fixture()
    assert _consensus_catalog_payload('j',state)['datasets']['d']['native_catalog_update'] is None
    assert _summary(job)['summary']['d']['native_catalog_update'] is None
    update=dict(policy='append_frozen',original_family_count=1,added_family_count=1,
                initial_snapshot_digest='old',augmented_snapshot_digest='new')
    model=dict(origin='initial_frozen',model_version_sha256='model',producer_snapshot_digest='old')
    job['result']['datasets']['d']['cr']['native_catalog_update']=update
    job['result']['datasets']['d']['cr']['catalog'][0]['model_provenance']=model
    before=deepcopy(job['result'])
    catalog=_consensus_catalog_payload('j',state)
    assert catalog['datasets']['d']['native_catalog_update']==update
    assert catalog['datasets']['d']['catalog'][0]['model_provenance']==model
    assert _summary(job)['summary']['d']['native_catalog_update']==update
    set_filters(state,'j',{'classification_reference_percent':95.})
    assert _consensus_catalog_payload('j',state)['datasets']['d']['native_catalog_update']==update
    assert job['result']==before


def test_lazy_call_endpoint_current_reference_and_frozen_candidate_ledger():
    from routers.footprint import consensus_native_call
    from fastapi import HTTPException
    state, job, _ = fixture()
    before=deepcopy(job['result'])
    set_filters(state,'j',{'classification_reference_percent':95.})
    out=asyncio.run(consensus_native_call('j',dataset_id='d',source_call_id='d:u1:1',state=state))
    assert out['call']['family']=='d:A' and out['frozen_family']=='d:B'
    assert len(out['call']['candidate_evidence'])==2
    assert out['call']['native_cross_tests']
    assert job['result']==before
    with pytest.raises(HTTPException) as missing:
        asyncio.run(consensus_native_call('j',dataset_id='d',source_call_id='d:missing:1',state=state))
    assert missing.value.status_code==404


def test_native_auxiliary_additions_stay_separate_and_do_not_manufacture_cr_posterior():
    state,job,_=fixture()
    ds=job['result']['datasets']['d']
    before=deepcopy(ds['cr'])
    call=dict(family='d:A',interval=[195,205],geometry_inclusion_mass=.98,
        native_family_validation=dict(accepted=True,native_shape_evidence=dict(predictive_tail_interval=[.1,.2])),
        provenance='strict_auxiliary_new_call_native_shape_validated')
    ds['rescue']=dict(status='complete',auxiliary_model='frozen_native_catalog_legacy_strict_detection_v1',
        records=[dict(unit_id='u1',strand='CT',calls=[call])],cr_records=[])
    job['index'],job['layers']=_index(job['result'])
    row=job['index']['d']['per_unit']['u1']
    assert len(row['tf_cr'])==2 and len(row['tf_cr_recalled'])==3
    addition=row['tf_recall'][0]
    assert 'model_membership' not in addition and addition['new_call']
    assert _visible(addition,job['filters'],'CT')
    assert not _visible(addition,dict(job['filters'],minimum_rescue_model_q=20),'CT')
    assert ds['cr']==before
    assert all(c['source_call_id']!='d:u1:2' for c in row['tf_xcr'])


def test_auxiliary_completion_without_native_validation_fails_closed_with_diagnostic():
    _,job,_=fixture()
    job['result']['datasets']['d']['rescue']=dict(status='complete',records=[dict(unit_id='u1',calls=[
        dict(family='d:A',interval=[195,205],geometry_inclusion_mass=1.)])])
    index,layers=_index(job['result'])
    assert 'tf_recall' in layers
    assert not index['d']['per_unit']['u1'].get('tf_recall')
    assert len(index['d']['auxiliary_projection_errors'])==1


def test_native_split_pieces_do_not_overwrite_outer_span_or_label_unvalidated_piece():
    _,job,_=fixture()
    original=[100,200]
    job['result']['datasets']['d']['split']=dict(status='complete',records=[dict(unit_id='u1',
        original_nuc=original,tests=[dict(model='native_TF',pieces=[[100,130],[145,200]],
                                      gaps=[dict(interval=[130,145])])],
        independent_native_piece_validations=[dict(accepted=True,family='d:A',piece=[100,130])])])
    before=deepcopy(job['result'])
    index,layers=_index(job['result'])
    pieces=index['d']['per_unit']['u1']['nuc_cr_split']
    assert pieces[0]['family']=='d:A' and pieces[1]['family'] is None
    assert pieces[1]['unclassified']
    assert all(p['original_nuc']==original for p in pieces)
    assert {'nuc_cr_split','cr_split_gap'}<=set(layers)
    assert job['result']==before


@pytest.mark.parametrize('value', [49., 100., True, float('nan'), '99.9'])
def test_native_reference_validation_is_atomic(value):
    state, job, _ = fixture()
    before = deepcopy(job['filters'])
    with pytest.raises(ValueError):
        set_filters(state, 'j', {'classification_reference_percent': value})
    assert job['filters'] == before
