import numpy as np
import pytest
from services.clustering_features import extract_features_from_compact
from services.cluster_assignment import cluster_compact_reads
from services.dynamic_clustering import assign_reads_to_cluster_patterns


def fixture():
    rules = [dict(id='cart', enabled=True, terms=[dict(source='footprint_class', group=dict(
        consensusStateId=f, consensusJobId='j', sourceDatasetId='d')) for f in ['A', 'B']])]
    reads = [dict(id=f'd::{f}', intervals=[[0, 30, 30]]) for f in ['A', 'B', 'both', 'neither']]
    def resolve(read, group, start):
        present = read['id'].split('::')[1] in (group['consensusStateId'], 'both')
        return [(5, 8, 1)] if present else []  # Smaller than the 10bp feature grid.
    return rules, reads, dict(resolve_footprint_class=resolve)


def test_overlapping_classes_are_separate_binary_features_and_patterns():
    rules, reads, context = fixture()
    features, ids, widths, modes = extract_features_from_compact(reads, [[0, 30]], 0,
        peak_modes=['cluster_rule:cart'], cluster_feature_rules=rules, cluster_rule_context=context)
    assert widths == [2]
    np.testing.assert_array_equal(features, [[1, 0], [0, 1], [1, 1], [0, 0]])
    assignments, _, _, info = cluster_compact_reads(reads, [[0, 30]], 0, n_clusters=4, method='combinatorial',
        peak_modes=['cluster_rule:cart'], cluster_feature_rules=rules, cluster_rule_context=context)
    assert len(set(assignments.values())) == 4
    updated = assign_reads_to_cluster_patterns(reads, [[0, 30]], info['cluster_patterns'], region_start=0,
        subnucleosomal_threshold=90, accessibility_threshold=.5,
        peak_modes=['cluster_rule:cart'], cluster_feature_rules=rules, cluster_rule_context=context)
    assert updated['assignments'] == assignments
    # One element per pattern bit (the peak's two classes), each with its reads.
    assert info['n_elements'] == 2
    assert info['elements'] == [{'index': 0, 'peak': 0, 'class': True}, {'index': 1, 'peak': 0, 'class': True}]
    assert sorted(info['element_read_ids'][0]) == ['d::A', 'd::both']
    assert sorted(info['element_read_ids'][1]) == ['d::B', 'd::both']


def test_class_cannot_silently_fall_back_to_layer_geometry():
    rules, reads, _ = fixture()
    with pytest.raises(ValueError, match='saved footprint class'):
        extract_features_from_compact(reads, [[0, 30]], 0,
            peak_modes=['cluster_rule:cart'], cluster_feature_rules=rules)


def test_mixed_layer_and_class_terms_preserve_column_offsets():
    rules, reads, context = fixture()
    rules[0]['terms'].append(dict(source='layer', layer=None, sizeMin=0))
    features, _, widths, _ = extract_features_from_compact(reads, [[0, 30], [0, 20]], 0,
        peak_modes=['cluster_rule:cart', 'off'], cluster_feature_rules=rules, cluster_rule_context=context)
    assert widths == [5, 0]
    np.testing.assert_array_equal(features[0], [1, 1, 1, 1, 0])


def test_real_resolver_uses_primary_identity_and_detects_changed_revision(monkeypatch):
    from types import SimpleNamespace
    from services import consensus_workflow as workflow
    from services.consensus_occupancy import clustering_class_resolver
    state = SimpleNamespace()
    jobs, _ = workflow._session(state)
    jobs['j'] = dict(status='complete', filters={}, result={'manifest': {'region': {'chrom': 'chr1'}}},
        index={'d': dict(by_name={'r':['u']}, projection_members={'r':[dict(unit_id='u',identity={})]},
                        per_unit={'u':{'tf_cr':[dict(family='A',kind='native',compatible_alternatives=['B'])]}})})
    resolver = clustering_class_resolver(state, '1')
    group = dict(consensusStateId='A',consensusJobId='j',sourceDatasetId='d',referenceAbsStart=10,referenceAbsEnd=20)
    read = dict(id='d::r',_original_id='r')
    assert resolver(read,group,0) == [(10,20,1)]
    assert resolver(read,{**group,'consensusStateId':'B'},0) == []
    jobs['j']['_curation'] = {'revision':1}
    with pytest.raises(ValueError,match='changed during clustering'):
        resolver(read,group,0)


def test_resolver_cache_keeps_stages_of_one_family_apart(monkeypatch):
    from types import SimpleNamespace
    from services import consensus_workflow as workflow
    from services import consensus_occupancy
    state = SimpleNamespace()
    jobs, _ = workflow._session(state)
    jobs['j'] = dict(status='complete')
    # Family A holds read r in stage 1 only.
    def occupancy(state, dataset_id, chrom, reads, groups, **_outputs):   # (not_evaluated_out: none here)
        inside = groups[0].get('consensusStage') == 'stage1'
        return {0: {'r'} if inside else set()}, {0: {'r'}}
    monkeypatch.setattr(consensus_occupancy, 'class_occupancy', occupancy)
    resolver = consensus_occupancy.clustering_class_resolver(state, '1')
    group = dict(consensusStateId='A', consensusJobId='j', sourceDatasetId='d', referenceAbsStart=10, referenceAbsEnd=20)
    read = dict(id='d::r', _original_id='r')
    assert resolver(read, {**group, 'consensusStage': 'stage1'}, 0) == [(10, 20, 1)]
    assert resolver(read, {**group, 'consensusStage': 'stage2'}, 0) == []
