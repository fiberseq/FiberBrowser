"""Per-read states of selected NFRs and NFR variants (the lab pack's feature kinds) for the read panel's Cluster, Sort
and Filter: the engine's own states, per dataset and read name, with '.' for reads a feature did not evaluate."""
from types import SimpleNamespace

import pytest

from lab.services import accessibility_analysis as aa
from lab.services import accessibility_workflow as aw
from services.feature_states import MAX_FEATURES, feature_states

from test_accessibility_workflow import REQUEST, _wait, state  # noqa: F401  (the fixture)


@pytest.fixture
def run(state):  # noqa: F811
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'complete', job['message']
    return job


def _variant_ids(job, nfr):
    return [v['id'] for n in job['result']['nfrs'] if n['id'] == nfr for v in n['variants']]


def test_variant_states_are_the_element_states_the_combination_split_uses(state, run):
    ids = [e['id'] for e in run['result']['elements'] if e['kind'] == 'nfr'][:3]
    out = feature_states(state, [dict(kind='nfr-variant', source=run['job_id'], id=i) for i in ids])
    assert [f['label'] for f in out['features']] == [i.replace(':', ' ') for i in ids]
    states = out['by_dataset']['d']
    assert len(states) == 300 and all(len(s) == len(ids) for s in states.values())
    # Every evaluated read of the split has the pattern the split put it in.
    split = aa.split(state, run['job_id'], elements=ids)
    keys = {g['id']: g['key'] for g in split['groups']}
    for name, gid in split['by_dataset']['d'].items():
        if keys[gid] != 'na':
            assert states[name] == keys[gid]
    first = out['features'][0]
    assert first['members']['d'] == sum(s[0] == '1' for s in states.values())
    assert first['evaluated']['d'] == sum(s[0] != '.' for s in states.values())
    assert first['span'][0] < first['span'][1]


def test_variant_membership_matches_the_reads_endpoint(state, run):
    vid = _variant_ids(run, 'N1')[0]
    out = feature_states(state, [dict(kind='nfr-variant', source=run['job_id'], id=vid)])
    members = {n for n, s in out['by_dataset']['d'].items() if s == '1'}
    assert members == set(aw.element_reads(state, run['job_id'], vid)['by_dataset'].get('d', []))


def test_nfr_state_is_any_opening_on_callable_reads(state, run):
    out = feature_states(state, [dict(kind='nfr', source=run['job_id'], id='N1')])
    result = aw._complete(state, run['job_id'])['result']
    for m in result['molecules'].values():
        rec = (m.get('nfr') or {}).get('N1')
        expected = '.' if not rec or rec.get('status') != 'callable' else ('1' if rec.get('gaps') else '0')
        assert out['by_dataset']['d'][m['read_name']] == expected
    assert out['features'][0]['label'] == 'N1'


def test_bad_requests_are_refused_with_a_reason(state, run):
    with pytest.raises(ValueError, match='list of features'):
        feature_states(state, [])
    with pytest.raises(ValueError, match='No variant'):
        feature_states(state, [dict(kind='nfr-variant', source=run['job_id'], id='N1:V99')])
    with pytest.raises(ValueError, match='No NFR'):
        feature_states(state, [dict(kind='nfr', source=run['job_id'], id='N9')])
    with pytest.raises(ValueError, match='At most'):
        feature_states(state, [dict(kind='nfr', source=run['job_id'], id='N1')] * (MAX_FEATURES + 1))
    with pytest.raises(KeyError):
        feature_states(state, [dict(kind='nfr', source='missing', id='N1')])


def test_router(state, run, monkeypatch):  # noqa: F811
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.features import router
    from state.dependencies import get_state
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    ok = client.post('/api/features/states', json=dict(features=[dict(kind='nfr', source=run['job_id'], id='N1')]))
    assert ok.status_code == 200 and len(ok.json()['by_dataset']['d']) == 300
    assert client.post('/api/features/states', json=dict(features=[dict(kind='nfr', source='nope', id='N1')])).status_code == 404
    assert client.post('/api/features/states', json=dict(features=[dict(kind='bad', source='x', id='y')])).status_code == 422
