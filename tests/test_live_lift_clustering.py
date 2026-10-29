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
    assert set(data['results'][did]['record_sources']) == set(assignments)
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
    assert set(dynamic.json()['results'][did]['record_sources']) == set(assignments)
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


@pytest.mark.parametrize('fold', ['fold_orientation_rows', 'fold_molecule'])
def test_every_endpoint_prepares_before_spanning_peak_coverage_and_caps(lift_env, monkeypatch, fold):
    from copy import deepcopy
    from services.lift import reads as lift_reads
    from services.read_sampling import Sampler
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam, settings={fold: True})['dataset']['id']
    state.max_working_reads = 1
    pieces = [row(start=1000), row(record='supp' if fold == 'fold_molecule' else 'r',
        orientation=1, supp=fold == 'fold_molecule', start=1020)]
    for r in pieces:
        ll = r['live_lift']; a = r['intervals'][0][0]
        ll['molecular_spans'] = [[a, a + 20, a - 1000, 1, True]]
        r['alignment_spans'] = [[a, a + 20]]
    def load(dataset, chrom, start, end, *args, **kwargs):
        result = deepcopy(pieces)
        for r in result:
            for iv in r['intervals']: iv[0] -= start; iv[1] -= start
            for iv in r['live_lift']['segments']: iv[0] -= start; iv[1] -= start
            for iv in r['live_lift']['molecular_spans']: iv[0] -= start; iv[1] -= start
        return result
    monkeypatch.setattr(lift_reads, 'lifted_reads_for_region', load)
    query = dict(chrom=TARGET, start=1000, end=1040, spanning=True)
    peaks = [dict(start=1005, end=1015, mode='accessibility'), dict(start=1025, end=1035, mode='accessibility')]
    body = dict(dataset_ids=[did], peak_regions=peaks, method='combinatorial')
    result = client.post('/api/cluster_all', params=query, json=body)
    assert result.status_code == 200, result.text
    result = result.json(); assignments = result['results'][did]['assignments']
    assert len(assignments) == 1
    assert result['results'][did]['cohort']['input_rows'] == 2
    dynamic = client.post('/api/assign_to_clusters', params=query, json={
        **body, 'cluster_patterns': result['cluster_patterns']})
    assert dynamic.status_code == 200, dynamic.text
    assert dynamic.json()['results'][did]['assignments'] == assignments
    for route in ('cluster_projection', 'auto_cull_clusters', 'dissolve_cluster'):
        response = client.post('/api/' + route, params=query, json={**body, 'method': 'pca',
            'cluster_assignments': {did: assignments}, 'current_assignments': {did: assignments}, 'cluster_to_dissolve': 0})
        assert response.status_code == 200, response.text
        if route == 'cluster_projection':
            assert response.json()['n_reads'] == 1
        else:
            assert response.json()['cohorts'][did]['folded']
    view = dict(chrom=TARGET, start=1000, end=1040, peak_regions=peaks)
    response = client.post('/api/cluster_matched_views', json=dict(method='combinatorial', mode='joint', views=[
        dict(id=str(i), panels=[dict(dataset_id=did, result_key=str(i))], **view) for i in (1, 2)]))
    assert response.status_code == 200, response.text
    assert all(len(v['assignments']) == 1 for v in response.json()['results'].values())


@pytest.mark.parametrize('setting,value', [
    ('haplotype_mode', 'pooled'), ('g_split', 1000), ('window_merge', 0), ('rejoin_bp', 0),
    ('alternatives', True), ('cohort_alternatives', 'include'), ('supplementary_display', 'hide'),
    ('cohort_supplementaries', 'primary_only'), ('fold_molecule', True), ('fold_orientation_rows', True),
    ('joint_dedup', 'by_molecule'), ('coverage_hatching', False), ('pooled_depth', 'correspondence_normalised'),
    ('primary_lookup', False), ('molecule_groups', None),
])
def test_each_setting_changes_cache_identity_and_warm_equals_cold(lift_env, setting, value):
    from services.analysis_query import AnalysisReadQuery
    from services.working_sets import read_load_token
    from services.background_work import dataset_identity
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)['dataset']['id']
    if setting == 'molecule_groups': value = [[bam, 'declared']]
    query = AnalysisReadQuery.from_request(state, capability='clustering', dataset_id=did,
        chrom=TARGET, start=3500, end=3900)
    query.build_working_set(state, did)
    old_key = state.datasets[did].live_lift.key()
    old_token = read_load_token(state, TARGET)
    old_identity = dataset_identity(state, [did])
    response = client.post(f'/api/lift/datasets/{did}/settings', json={'settings': {setting: value}}).json()
    assert response['success'], response
    assert state.datasets[did].live_lift.key() != old_key
    assert read_load_token(state, TARGET) != old_token
    assert dataset_identity(state, [did]) != old_identity
    warm = query.build_working_set(state, did).reads
    assert query.build_working_set(state, did).reads == warm
    state._broad_cache.clear(); state._working_set_cache.clear()
    cold = query.build_working_set(state, did).reads
    assert cold == warm


def test_cold_folded_endpoint_scope_sends_raw_qnames_to_sampler(lift_env, monkeypatch):
    from services.read_sampling import Sampler
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam, settings={'fold_molecule': True})['dataset']['id']
    query = dict(chrom=TARGET, start=3500, end=3900)
    body = dict(dataset_ids=[did], peak_regions=[dict(start=3600, end=3700)], method='combinatorial')
    first = client.post('/api/cluster_all', params=query, json=body).json()
    ids = list(first['results'][did]['assignments'])
    state._broad_cache.clear(); state._working_set_cache.clear()
    seen = []
    original = Sampler.keep
    def keep(self, name):
        if self.only_ids is not None:
            seen.append((name, set(self.only_ids)))
        return original(self, name)
    monkeypatch.setattr(Sampler, 'keep', keep)
    for _ in range(2):
        response = client.post('/api/cluster_all', params=query, json={**body, 'read_ids': {did: ids}})
        assert response.status_code == 200, response.text
        assert set(response.json()['results'][did]['assignments']) == set(ids)
    assert seen and all(scope == {'plus'} and '|' not in name for name, scope in seen)


def test_native_provenance_is_explicit_and_persisted(lift_env):
    from services.sessions_endpoint import _restore_chemistry_override
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)['dataset']['id']
    state.add_dataset('native', bam)
    native = state.datasets['native']
    before = native.to_dict()['source_identity']
    response = client.post('/api/lift/provenance/native', json={'molecule_groups': [[bam, 'shared']], 'joint_dedup': 'by_molecule'})
    assert response.status_code == 200, response.text
    saved = response.json()['dataset']
    assert saved['source_identity'] != before
    from services.sessions_endpoint import build_session_export_for_request
    from models.requests import SessionExportRequest
    exported = build_session_export_for_request(state, SessionExportRequest(chrom=TARGET, start=1000, end=2000))['session']
    native_entry = next(d for d in exported['datasets'] if d['id'] == 'native')
    assert native_entry['molecule_groups'] == [[bam, 'shared']]
    assert native_entry['joint_dedup'] == 'by_molecule'
    restored = SimpleNamespace()
    _restore_chemistry_override(restored, saved)
    assert restored.molecule_groups == [[bam, 'shared']] and restored.joint_dedup == 'by_molecule'
    response = client.post('/api/variants/alleles', json={'dataset_id': did, 'chrom': TARGET,
        'start': 1000, 'end': 2000, 'source': 'lift_hap'})
    assert response.status_code == 200, response.text
    assert response.json()['assignments'] == {}  # config only; no static membership
    assert [g['label'] for g in response.json()['groups']] == ['MAT', 'PAT']


def test_dynamic_split_windows_before_caps(lift_env, two_hap_evidence):
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    state.max_working_reads = 1
    query = dict(chrom=TARGET, start=1050, end=1200)
    views = [dict(dataset_id=did, result_key=hap, lift_hap=hap, **query) for hap in ('MAT', 'PAT')]
    response = client.post('/api/assign_to_clusters', params=query, json=dict(dataset_ids=[did], viewports=views,
        peak_regions=[dict(start=1060, end=1100)], cluster_patterns={0: [0], 1: [1]}))
    assert response.status_code == 200, response.text
    for hap in ('MAT', 'PAT'):
        assert len(response.json()['results'][hap]['assignments']) == 1
        assert response.json()['results'][hap]['cohort']['hap'] == hap


def test_hidden_supplementaries_do_not_change_default_analysis_cohort(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)['dataset']['id']
    query = dict(chrom=TARGET, start=3000, end=3100)
    body = dict(dataset_ids=[did], peak_regions=[dict(start=3030, end=3050)], method='combinatorial')
    before = client.post('/api/cluster_all', params=query, json=body).json()['results'][did]
    assert before['cohort']['supplementary_rows'] > 0
    changed = client.post(f'/api/lift/datasets/{did}/settings', json={'settings': {'supplementary_display': 'hide'}}).json()
    assert changed['success']
    after = client.post('/api/cluster_all', params=query, json=body).json()['results'][did]
    assert after['assignments'] == before['assignments'] and after['assignments']


def test_hidden_alternatives_can_be_clustered_and_counted(lift_env, tmp_path):
    from live_lift_fixtures import make_record, write_bam, MAT
    client, state, manifest, _ = lift_env
    bam = write_bam(tmp_path / 'alternatives.bam', lambda h: [make_record(h, 'primary', MAT, 500, '300M'),
        make_record(h, 'alternative', MAT, 9600, '300M')])
    did = _add(client, manifest, bam, settings={'cohort_alternatives': 'include', 'alternatives': False})['dataset']['id']
    query = dict(chrom=TARGET, start=1500, end=1800)
    display = client.get('/api/reads/compact', params={**query, 'dataset_id': did}).json()
    assert display['reads'] and not any(r['live_lift']['alt'] for r in display['reads'])
    response = client.post('/api/cluster_all', params=query, json=dict(dataset_ids=[did],
        peak_regions=[dict(start=1550, end=1600)], method='combinatorial'))
    assert response.status_code == 200, response.text
    cohort = response.json()['results'][did]
    assert len(cohort['assignments']) == 2 and cohort['cohort']['alternative_rows'] == 1


def test_joint_dedup_endpoint_is_order_independent(lift_env, tmp_path):
    from live_lift_fixtures import make_record, write_bam, TSIZE
    from services.lift.registration import update_settings
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam, settings={'molecule_groups': [[bam, 'shared']], 'joint_dedup': 'by_molecule'})['dataset']['id']
    native_bam = write_bam(tmp_path / 'native.bam', lambda h: [make_record(h, 'plus', TARGET, 3500, '400M')], contigs=((TARGET, TSIZE),))
    native = state.add_dataset('native', native_bam)
    native.molecule_groups, native.joint_dedup = [[native_bam, 'shared']], 'by_molecule'
    query = dict(chrom=TARGET, start=3500, end=3900)
    views = [dict(dataset_id=ds, result_key=ds, **query) for ds in (did, 'native')]
    previous = None
    for order in itertools.permutations(views):
        response = client.post('/api/cluster_all', params=query, json=dict(dataset_ids=[did, 'native'],
            viewports=list(order), peak_regions=[dict(start=3600, end=3700)], method='combinatorial'))
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['joint_cohort']['shared_molecules'] == result['joint_cohort']['removed_rows'] == 1
        output = {key: value['assignments'] for key, value in result['results'].items()}
        assert output['native'] and output[did] == {}
        if previous is not None: assert output == previous
        previous = output


@pytest.mark.parametrize('direct', [False, True])
def test_display_minimum_counts_molecular_calls_not_split_parts(lift_env, direct):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)['dataset']['id']
    query = dict(dataset_id=did, chrom=TARGET, start=3900, end=4110,
                 hide_terminal_gaps=not direct, full_working_set=True)
    for _ in range(2):
        one = client.get('/api/reads/compact', params={**query, 'min_footprints': 1})
        two = client.get('/api/reads/compact', params={**query, 'min_footprints': 2})
        assert one.status_code == two.status_code == 200
        assert len(one.json()['reads']) == 1
        assert two.json()['reads'] == []


def test_sampled_display_entry_prepares_before_sampling(lift_env):
    from services.working_sets import build_sampled_display_working_set
    from services.lift.reads import lift_display_hap
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)['dataset']['id']
    state.max_working_reads = 1
    def unused(*args, **kwargs):
        raise AssertionError('Lifted entry must use the lift loader')
    with lift_display_hap('PAT'):
        ws, count = build_sampled_display_working_set(state, did, TARGET, 15000, 18000, max_reads=1,
            build_bam_reads=unused, build_bigbed_reads=unused, load_bigbed_marks=unused)
    assert count == 1 and len(ws.reads) == 1
    assert ws.reads[0]['live_lift']['hap_label'] == 'PAT' and ws.reads[0]['analysis_id']


def test_joint_policy_includes_empty_participating_datasets():
    from services.lift.joint import prepare_joint_cohort
    datasets = {key: SimpleNamespace(data_type='bam', molecule_groups=[[key + '.bam', 'shared']], joint_dedup=policy)
                for key, policy in [('one', 'by_molecule'), ('two', 'by_molecule'), ('empty', 'off')]}
    state = SimpleNamespace(get_dataset=datasets.get)
    rows = [dict(id=key+'::molecule', _original_id='molecule', _consensus_dataset_id=key, source_path=key+'.bam') for key in ('one','two')]
    kept, report = prepare_joint_cohort(state, rows, datasets)
    assert report['policy'] == 'off' and report['shared_molecules'] == 1 and len(kept) == 2


def test_identical_names_in_two_libraries_have_distinct_assignments_and_strands(lift_env, tmp_path):
    from live_lift_fixtures import make_record, write_bam, MAT
    client, state, manifest, _ = lift_env
    paths = [write_bam(tmp_path / (base + '.bam'), lambda h, mark=mark: [
        make_record(h, 'molecule', MAT, 500, '300M', seq=mark*20 + 'A'*280)]) for base, mark in [('first', 'Y'), ('second', 'R')]]
    added = _add(client, manifest, paths[0], paths=paths)
    assert added['success'], added
    did = added['dataset']['id']
    response = client.post('/api/cluster_all', params=dict(chrom=TARGET, start=1500, end=1800),
        json=dict(dataset_ids=[did], method='combinatorial', peak_regions=[dict(start=1505, end=1515, mode='deam')]))
    assert response.status_code == 200, response.text
    assignments = response.json()['results'][did]['assignments']
    assert len(assignments) == 2
    assert len({name.split('|')[0] for name in assignments}) == 2
    calls = state._read_strand_calls[did]
    assert len(calls) == 2 and set(calls.values()) == {'CT', 'GA'}
