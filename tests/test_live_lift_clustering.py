"""Live-lift clustering uses prepared cohorts at every analysis entry."""
from dataclasses import replace
from types import SimpleNamespace
import itertools
import pytest
from test_live_lift_endpoints import lift_env, _add
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_p2a2_direct import setup_dataset
from live_lift_fixtures import TARGET
from test_live_lift_cohort import row


def test_cluster_endpoints_and_folded_subset_cold_warm(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam, settings={'fold_molecule': True})['dataset']['id']
    query = dict(chrom=TARGET, start=3500, end=3900)
    peaks = [dict(start=3600, end=3700, mode='accessibility')]
    body = dict(dataset_ids=[did], peak_regions=peaks, method='combinatorial', k=2)
    response = client.post('/api/cluster_all', params=query, json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assignments = data['results'][did]['assignments']
    assert assignments and all('|' in key for key in assignments)
    assert data['results'][did]['cohort']['folded']
    from services.analysis_query import AnalysisReadQuery
    analysis = AnalysisReadQuery.from_request(state, capability='clustering', dataset_id=did,
        read_ids=list(assignments), **query)
    for cold in (False, True, False):
        if cold:
            state._broad_cache.clear()
            state._working_set_cache.clear()
        selected = analysis.build_working_set(state, did)
        assert {r['analysis_id'] for r in selected.reads} == set(assignments)
    dynamic = client.post('/api/assign_to_clusters', params=query, json={
        'dataset_ids': [did], 'peak_regions': peaks, 'cluster_patterns': data['cluster_patterns']})
    assert dynamic.status_code == 200, dynamic.text
    assert set(dynamic.json()['results'][did]['assignments']) == set(assignments)
    projection = client.post('/api/cluster_projection', params=query, json={
        'dataset_ids': [did], 'peak_regions': peaks, 'cluster_assignments': {did: assignments}, 'method': 'pca'})
    assert projection.status_code == 200, projection.text
    assert projection.json()['n_reads'] == len(assignments)
    for route in ('auto_cull_clusters', 'dissolve_cluster'):
        result = client.post('/api/' + route, params=query, json={
            'dataset_ids': [did], 'peak_regions': peaks, 'current_assignments': {did: assignments}, 'cluster_to_dissolve': 0})
        assert result.status_code == 200, result.text


def test_split_haplotype_clusters_before_caps_without_stored_ids(lift_env, two_hap_evidence):
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    state.max_working_reads = 1
    query = dict(chrom=TARGET, start=1050, end=1200)
    peaks = [dict(start=1060, end=1100, mode='accessibility')]
    views = [dict(dataset_id=did, result_key=hap, lift_hap=hap, **query) for hap in ('MAT', 'PAT')]
    for _ in range(2):
        response = client.post('/api/cluster_all', params=query, json={
            'dataset_ids': [did], 'viewports': views, 'peak_regions': peaks})
        assert response.status_code == 200, response.text
        data = response.json()
        for hap in ('MAT', 'PAT'):
            assert len(data['results'][hap]['assignments']) == 1
            assert data['results'][hap]['cohort']['hap'] == hap


def test_joint_dedup_permutations_and_policy_conflicts():
    from services.lift.joint import prepare_joint_cohort
    from services.lift.live_lift import LiftSettings
    lifted = SimpleNamespace(data_type='bam_livelift', live_lift=SimpleNamespace(
        settings=LiftSettings(molecule_groups=[['lift.bam', 'shared']], joint_dedup='by_molecule')))
    native = SimpleNamespace(data_type='bam', molecule_groups=[['native.bam', 'shared']], joint_dedup='by_molecule')
    unrelated = SimpleNamespace(data_type='bam', molecule_groups=[['other.bam', 'unrelated']], joint_dedup='by_molecule')
    state = SimpleNamespace(get_dataset={'lift': lifted, 'native': native, 'other': unrelated}.get)
    a = {**row(molecule='shared|molecule'), '_consensus_dataset_id': 'lift', '_original_id': 'analysis', 'id': 'lift::analysis'}
    b = dict(id='native::molecule', _original_id='molecule', _consensus_dataset_id='native', source_path='native.bam')
    c = dict(id='other::molecule', _original_id='molecule', _consensus_dataset_id='other', source_path='other.bam')
    for ordering in itertools.permutations([a, b, c]):
        kept, report = prepare_joint_cohort(state, ordering)
        assert {r['id'] for r in kept} == {b['id'], c['id']}
        assert report['shared_molecules'] == report['removed_rows'] == 1
        assert report['policy'] == 'by_molecule'
    native.joint_dedup = 'off'
    kept, report = prepare_joint_cohort(state, [a, b, c])
    assert len(kept) == 3 and report['shared_molecules'] == 1 and report['policy'] == 'off'


def test_matched_views_carry_haplotype_rules(lift_env, two_hap_evidence):
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    state.max_working_reads = 1
    views = [dict(id=hap, chrom=TARGET, start=1050, end=1200,
                  panels=[dict(dataset_id=did, result_key=hap, lift_hap=hap)],
                  peak_regions=[dict(start=1060, end=1100, mode='accessibility')]) for hap in ('MAT', 'PAT')]
    response = client.post('/api/cluster_matched_views', json=dict(views=views, mode='joint', method='combinatorial'))
    assert response.status_code == 200, response.text
    result = response.json()
    for hap in ('MAT', 'PAT'):
        assert len(result['results'][hap]['assignments']) == 1
        assert result['results'][hap]['cohort']['hap'] == hap
