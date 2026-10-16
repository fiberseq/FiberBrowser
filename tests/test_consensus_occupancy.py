from types import SimpleNamespace
import pytest
from services.consensus_occupancy import class_occupancy
from services.footprint_analysis import build_interval_table, compute_cooccupancy_result
from services import consensus_workflow as workflow


def test_exact_membership_mixed_rules_and_dataset_scope(monkeypatch):
    state = SimpleNamespace()
    jobs, _ = workflow._session(state)
    jobs['j'] = {'status': 'complete', 'filters': {}, 'result': {'manifest': {'region': {'chrom': 'chr2L'}}},
                 'index': {'d': {'per_unit': {
                     'r1': {'tf_cr': [{'family': 'A', 'compatible_alternatives': ['B']}]},
                     'r2': {'tf_cr': [{'family': 'B', 'compatible_alternatives': ['A']}]},
                     'r3': {'tf_cr': [{'family': 'A', 'classification_status': 'provisional_unresolved'}]},
                 }}}}
    monkeypatch.setattr(workflow, '_visible', lambda *args: True)
    monkeypatch.setattr(workflow, '_match_projection_unit', lambda index, read:
                        (read['id'] if read['id'] in index['per_unit'] else None, '', 0))
    reads = [{'id': name, 'intervals': [[10, 20, 10]]} for name in ['r1', 'r2', 'r3', 'unmatched']]
    groups = [dict(consensusStateId='A', consensusJobId='j', sourceDatasetId='d',
                   referenceAbsStart=900, referenceAbsEnd=910, sizeMin=1000),
              dict(referenceAbsStart=10, referenceAbsEnd=20),
              dict(consensusStateId='A', consensusJobId='j', sourceDatasetId='other')]
    members, eligible = class_occupancy(state, 'd', '2L', reads, groups)
    assert members == {0: {'r1'}, 2: set()}
    assert eligible == {0: {'r1', 'r2', 'r3'}, 2: set()}
    table = build_interval_table(reads, lambda r: r['intervals'], region_start=0)
    result = compute_cooccupancy_result(table, groups, [], class_memberships=members, class_eligible=eligible)
    assert result['per_group'][0]['ids_with'] == ['r1']
    assert result['per_group'][0]['ids_without'] == ['r2', 'r3']
    assert result['pairs'][0]['table'] == [[1, 0], [2, 0]]
    assert len(result['pairs']) == 1
    with pytest.raises(ValueError, match='unavailable'):
        compute_cooccupancy_result(table, groups, [])
    groups[0]['consensusJobId'] = 'missing'
    with pytest.raises(ValueError, match='unavailable'):
        class_occupancy(state, 'd', '2L', reads, groups)


def test_manual_class_uses_curated_primary(monkeypatch):
    from services import consensus_curation
    state = SimpleNamespace()
    jobs, _ = workflow._session(state)
    jobs['j'] = dict(status='complete', filters={}, result={'manifest': {'region': {'chrom': '1'}}},
                     index={'d': {'per_unit': {'u': {'tf_cr': [{'family': 'A'}]}}}})
    monkeypatch.setattr(workflow, '_visible', lambda *args: True)
    monkeypatch.setattr(workflow, '_match_projection_unit', lambda *args: ('u', '', 1))
    monkeypatch.setattr(consensus_curation, 'curated_records_for_unit',
                        lambda *args: [{'family': 'A', 'manual_group_id': 'manual:G'}])
    groups = [dict(consensusStateId='manual:G', consensusJobId='j', sourceDatasetId='d')]
    members, eligible = class_occupancy(state, 'd', 'chr1', [{'id': 'r'}], groups)
    assert members == eligible == {0: {'r'}}
