"""B3 round 9: a read name shared by two alignments (merged BAMs) whose class
memberships differ is ambiguous, never one molecule carrying both classes."""
import threading
from types import SimpleNamespace

from services import consensus_workflow as workflow
from services.consensus_occupancy import class_occupancy


def _fixture():
    workflow._runtime()

    def unit(uid, name, start):
        return dict(unit_id=uid, read_name=name, reference_start=start, reference_end=start + 100,
                    native_intervals=[[start + 10, start + 30]])

    def record(uid, family, start):
        return dict(unit_id=uid, strand='pooled', proposals=[dict(
            source_call_id=f'call-{uid}', source_interval=[start + 10, start + 30], interval=[start + 10, start + 30],
            family=family, compatible_alternatives=[], classification_status='compatible_catalog_label',
            cr_mode=workflow.STAGED_MODE)])

    # "shared": two molecules with one name, one only in A and one only in B.
    # "solo": a molecule only in A.
    snapshot = dict(datasets={'d': dict(
        units=[unit('u1', 'shared', 0), unit('u2', 'shared', 5), unit('u3', 'solo', 0)],
        sr=dict(status='disabled', records=[]),
        cr=dict(status='complete',
                catalog=[dict(family=f, consensus_start=10, consensus_end=30) for f in ('A', 'B')],
                records=[record('u1', 'A', 0), record('u2', 'B', 5), record('u3', 'A', 0)]),
        rescue=dict(status='disabled'), split=dict(status='disabled'), comparability=dict(status='disabled'))},
        cross=dict(status='disabled', edges=[]))
    result = dict(schema='fiberhmm.consensus.v1', cr_mode=workflow.STAGED_MODE,
                  manifest=dict(region=dict(chrom='chr1', start=0, end=200)), final_stage='only',
                  stage_results={'only': snapshot}, stages=[], **snapshot)
    job = dict(job_id='j', status='complete', result=result, filters=workflow.schema()['display_defaults'])
    job['index'], job['layers'] = workflow._index(result)
    state = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock(),
                            consensus_workflow_active='j')
    return state


def test_state_filter_leaves_out_names_whose_alignments_disagree():
    state = _fixture()
    a = workflow.state_read_ids(state, 'j', 'd', 'A')
    assert a['read_ids'] == ['solo']
    assert a['ambiguous_read_ids'] == ['shared']
    assert workflow.state_read_ids(state, 'j', 'd', 'B')['read_ids'] == []


def test_cooccupancy_does_not_merge_two_molecules_sharing_a_name(monkeypatch):
    state = _fixture()
    by_start = {('shared', 0): 'u1', ('shared', 5): 'u2', ('solo', 0): 'u3'}
    monkeypatch.setattr(workflow, '_match_projection_unit',
                        lambda index, read: (by_start[(read['id'], read['reference_start'])], 'matched', 1))
    reads = [dict(id='shared', reference_start=0), dict(id='shared', reference_start=5),
             dict(id='solo', reference_start=0)]
    groups = [dict(consensusStateId=f, consensusJobId='j', sourceDatasetId='d', consensusStage='only')
              for f in ('A', 'B')]
    members, eligible = class_occupancy(state, 'd', 'chr1', reads, groups)
    assert members == {0: {'solo'}, 1: set()}
    assert eligible == {0: {'solo'}, 1: {'solo'}}
