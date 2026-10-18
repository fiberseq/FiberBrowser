"""Direct-load regressions from the P2a2 review, across real endpoint calls."""
import pytest
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import TARGET


def setup_dataset(lift_env, sample):
    _, ds, _ = sample
    client, state, _, _ = lift_env
    result = _add(client, ds.live_lift.manifest, ds.paths[0])
    assert result['success'], result
    return client, state, result['dataset']['id']


def test_direct_cache_changes_when_target_fasta_is_loaded(lift_env, two_hap_evidence):
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    params = dict(dataset_id=did, chrom=TARGET, start=1050, end=1200, include_cigar=True)
    cold = client.get('/api/reads/compact', params=params).json()
    assert not any(e['type'] == 'X' for r in cold['reads'] for e in r.get('cigar', []))
    state.fasta = two_hap_evidence[0].fasta
    warm = client.get('/api/reads/compact', params=params).json()
    assert any(e['type'] == 'X' for r in warm['reads'] for e in r.get('cigar', []))
    state._methylation_cache.clear()
    fresh = client.get('/api/reads/compact', params=params).json()
    assert fresh['reads'] == warm['reads']


@pytest.mark.parametrize('route', ['compact', 'compact_all'])
def test_direct_working_cap_follows_haplotype_filter(lift_env, two_hap_evidence, route):
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    state.max_working_reads = 1
    params = dict(dataset_id=did, chrom=TARGET, start=1050, end=1200, hide_terminal_gaps=False,
                  full_working_set=True, max_reads=1000)
    if route == 'compact':
        params['lift_hap'] = 'MAT'
    for _ in range(2):
        result = client.get(f'/api/reads/{route}', params=params).json()
        payload = result if route == 'compact' else result['datasets'][did]
        assert payload['working_count'] == 1
        if route == 'compact':
            assert payload['reads'][0]['live_lift']['hap_label'] == 'MAT'
            assert payload['total_overlapping'] == 2


def test_direct_sampling_counts_filtered_loaded_and_spanning(lift_env, two_hap_evidence, monkeypatch):
    from services import read_sampling
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    monkeypatch.setattr(read_sampling, 'sample_level', lambda *a, **k: 2)
    monkeypatch.setattr(read_sampling, 'name_hash', lambda name: 0 if name in ('mat-alt', 'pat-0') else 2**64-1)
    params = dict(dataset_id=did, chrom=TARGET, start=1050, end=1200, hide_terminal_gaps=False, lift_hap='MAT')
    for _ in range(2):
        payload = client.get('/api/reads/compact', params=params).json()
        info = payload['working_sampling']
        assert info['loaded'] == info['loaded_spanning'] == 1
        assert len(payload['reads']) == 1


def test_mismatch_layer_is_explicit_and_limited_to_visible_window(lift_env, two_hap_evidence):
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    state.fasta = two_hap_evidence[0].fasta
    params = dict(dataset_id=did, chrom=TARGET, start=1050, end=1200, include_cigar=True,
                  viewport_start=1095, viewport_end=1105, include_mismatches=False)
    off = client.get('/api/reads/compact', params=params).json()
    assert not any(e['type'] == 'X' for r in off['reads'] for e in r.get('cigar', []))
    on = client.get('/api/reads/compact', params={**params, 'include_mismatches': True}).json()
    events = [e for r in on['reads'] for e in r.get('cigar', []) if e['type'] == 'X']
    assert events and all(45 <= e['pos'] < 55 for e in events)
