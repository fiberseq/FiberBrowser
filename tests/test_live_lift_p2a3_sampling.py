"""Split panel estimates agree across direct/working-set paths and warm caches."""
import pytest
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env
from test_live_lift_p2a2_direct import setup_dataset
from live_lift_fixtures import TARGET


@pytest.mark.parametrize('hap,expected', [('MAT', 2), ('PAT', 35)])
def test_sampled_split_totals(lift_env, two_hap_evidence, monkeypatch, hap, expected):
    from services import read_sampling
    client, state, did = setup_dataset(lift_env, two_hap_evidence)
    monkeypatch.setattr(read_sampling, 'sample_level', lambda *a, **k: 2)
    # Keep half of each parent's rows; deterministic estimates are easy to check.
    monkeypatch.setattr(read_sampling, 'name_hash', lambda name: 0 if name in ('mat-alt', *[f'pat-{i}' for i in range(17)]) else 2**64-1)
    params = dict(dataset_id=did, chrom=TARGET, start=1050, end=1200, lift_hap=hap)
    totals = []
    for direct in (False, True):
        for _ in range(2):
            response = client.get('/api/reads/compact', params={**params, 'hide_terminal_gaps': not direct})
            assert response.status_code == 200, response.text
            payload = response.json()
            totals.append(payload['total_overlapping'])
            assert payload['total_overlapping'] == payload['working_sampling']['total']
            assert abs(payload['total_overlapping'] - expected) <= 1
    assert len(set(totals)) == 1
