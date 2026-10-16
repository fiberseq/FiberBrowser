"""Consensus-class co-occupancy counts a molecule only where the class was evaluated (release audit F5, class path),
and a saved class whose run is gone doesn't break co-occupancy for everything else (audit §3)."""
import copy
import shutil
import threading
from types import SimpleNamespace

import pytest

from services import consensus_workflow as cw
from services.consensus_occupancy import class_occupancy, recaller_scored_units
from services.footprint_analysis import build_interval_table, compute_cooccupancy_result


@pytest.fixture(scope='module')
def run(tmp_path_factory):
    """The planted recaller fixture plus one short read ending ~50 bp before the class: never scored for it."""
    from test_consensus_lattice_recaller import planted_payload
    payload = planted_payload()
    short = copy.deepcopy(payload['strata'][0]['units'][0])
    positions = list(range(1040, 1120, 4))
    short.update(unit_id='short', read_name='short', reference_start=1030, reference_end=1130, positions=positions,
                 hits=[1]*len(positions), p_accessible=[.8]*len(positions), p_protected=[.02]*len(positions),
                 contexts=[0]*len(positions), native_multi_interval_calls=[], native_multi_interval_tf_intervals=[],
                 raw_tf_intervals=[], representative_raw_tf_intervals=[], msp_intervals=[[1030, 1130]])
    payload['strata'][0]['units'].append(short)
    workflow, _ = cw._runtime()
    out = tmp_path_factory.mktemp('run')
    result = workflow.run_workflow(payload, {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'learned_spots': False}}, out)
    return result, out


def _state(result, artifact_dir):
    job = dict(job_id='j', status='complete', result=result, filters=cw.schema()['display_defaults'], artifact_dir=str(artifact_dir))
    job['index'], job['layers'] = cw._index(result)
    return SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock()), job


def _cooccupancy(state, result):
    family = result['datasets']['d']['cr']['catalog'][0]
    reads = [dict(id=u['read_name'], strand=u['strand'], intervals=[[0, 300, -300]]) for u in result['datasets']['d']['units']]
    groups = [dict(consensusJobId='j', consensusStateId=family['family'], sourceDatasetId='d', consensusTier='core')]
    unscored = {}
    members, eligible = class_occupancy(state, 'd', 'chrT', reads, groups, not_evaluated_out=unscored)
    table = build_interval_table(reads, lambda r: r['intervals'], region_start=1050)
    stats = compute_cooccupancy_result(table, groups, [], class_memberships=members, class_eligible=eligible,
                                       class_not_evaluated=unscored)
    return family, eligible, unscored, stats


def test_a_molecule_never_scored_for_the_class_is_not_counted_absent(run, tmp_path):
    result, out = run
    state, _ = _state(result, out)
    family, eligible, unscored, stats = _cooccupancy(state, result)
    scored = sum(v['molecules'] for v in family['recaller'].values())
    assert scored == 120 and len(eligible[0]) == scored              # the class's own scoring population
    assert unscored[0] == {'short'}
    assert 'short' not in stats['per_group'][0]['ids_without']
    assert stats['per_group'][0]['not_evaluated_reads'] == 1
    assert stats['per_group'][0]['eligible_reads'] == scored


def test_scoring_population_without_the_run_directory(run, tmp_path):
    """An imported result (no molecules.tsv.gz) rebuilds the population from the class rows and alignment bounds."""
    result, out = run
    bare = tmp_path / 'imported'; bare.mkdir()
    shutil.copy(out / 'result.json.gz', bare / 'result.json.gz')
    state, job = _state(result, bare)
    exact = recaller_scored_units(_state(result, out)[1], 'd')
    rebuilt = recaller_scored_units(job, 'd')
    assert rebuilt == exact
    _, eligible, unscored, _ = _cooccupancy(state, result)
    assert unscored[0] == {'short'} and len(eligible[0]) == 120


def test_a_stale_saved_class_is_marked_and_the_rest_still_computed():
    state = SimpleNamespace()
    cw._session(state)
    reads = [{'id': 'r1', 'intervals': [[10, 20, 10]]}, {'id': 'r2', 'intervals': [[0, 100, -100]]}]
    groups = [dict(consensusStateId='class_001', consensusJobId='gone', sourceDatasetId='d', savedClass={'id': 'S1'}),
              dict(referenceAbsStart=10, referenceAbsEnd=20)]
    unavailable = {}
    members, eligible = class_occupancy(state, 'd', 'chr1', reads, groups, unavailable_out=unavailable)
    assert 'unavailable' in unavailable[0]
    table = build_interval_table(reads, lambda r: r['intervals'], region_start=0)
    stats = compute_cooccupancy_result(table, groups, [], class_memberships=members, class_eligible=eligible,
                                       class_unavailable=unavailable)
    assert stats['per_group'][0]['eligible_reads'] == 0 and 'unavailable' in stats['per_group'][0]['unavailable']
    assert stats['per_group'][1]['ids_with'] == ['r1'] and stats['per_group'][1]['eligible_reads'] == 2
    assert stats['pairs'] == []
    with pytest.raises(ValueError, match='unavailable'):
        class_occupancy(state, 'd', 'chr1', reads, groups)          # direct callers still fail closed
