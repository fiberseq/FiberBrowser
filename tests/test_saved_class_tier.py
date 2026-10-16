"""A saved class counts exactly what it was saved to count (release audit F4).

A strict saved class (S1) and a wider copy (S2, + edge) of the same run class make the run's display tier the union
(core+edge). S1 must still count strict members only: saved-class boundaries treat a missing tier as 'core' and never
inherit the run's display tier. Only unsaved, current-run operations (the class table) inherit it.
"""
import threading
from types import SimpleNamespace

from services import consensus_workflow as cw
from services.consensus_occupancy import class_occupancy, clustering_class_resolver


def _state():
    index = dict(layers=['tf_rc'], by_name={'strict-read': ['u1'], 'edge-read': ['u2']}, per_unit={
        'u1': {'tf_rc': [dict(kind='recaller_class', family='class_001', tier='core')]},
        'u2': {'tf_rc': [dict(kind='recaller_class', family='class_001', tier='edge')]}})
    index['projection_members'] = {name: [dict(unit_id=uid, identity={}) for uid in units] for name, units in index['by_name'].items()}
    job = dict(status='complete', index={'d': index}, result={'manifest': {'region': {'chrom': 'chrT'}}},
               filters={'recaller_class_tiers': {'class_001': 'core+edge'}})
    return SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock())


READS = [{'id': 'strict-read'}, {'id': 'edge-read'}]


def test_unsaved_class_table_filter_inherits_the_run_tier():
    state = _state()
    assert cw.state_read_ids(state, 'j', 'd', 'class_001')['read_ids'] == ['edge-read', 'strict-read']
    assert cw.state_read_ids(state, 'j', 'd', 'class_001', tier='core')['read_ids'] == ['strict-read']


def test_strict_saved_class_without_a_tier_counts_strict_members_only():
    state = _state()
    strict = dict(consensusJobId='j', consensusStateId='class_001', sourceDatasetId='d')      # legacy: tier omitted
    explicit = dict(strict, consensusTier='core')
    wider = dict(strict, consensusTier='core+edge')
    members, eligible = class_occupancy(state, 'd', 'chrT', READS, [strict, explicit, wider])
    assert members[0] == members[1] == {'strict-read'}
    assert members[2] == {'strict-read', 'edge-read'}


def test_clustering_resolver_uses_the_saved_tier_not_the_run_tier():
    state = _state()
    resolve = clustering_class_resolver(state, 'chrT')
    group = dict(consensusJobId='j', consensusStateId='class_001', sourceDatasetId='d', referenceAbsStart=100, referenceAbsEnd=120)
    read = {'id': 'edge-read', '_consensus_dataset_id': 'd'}
    assert resolve(read, group, 0) == []
    assert resolve(read, dict(group, consensusTier='core+edge'), 0) == [(100, 120, 1.0)]
