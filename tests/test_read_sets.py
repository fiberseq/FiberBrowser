"""Read-name sets for read requests too large for a query string (a split panel's subset)."""
from types import SimpleNamespace

import pytest

from services import read_sets


def test_register_is_content_addressed_bounded_and_combines_with_filter_ids():
    state = SimpleNamespace()
    a = read_sets.register(state, ['r2', 'r1', 'r1'])
    assert a == dict(set_id=read_sets.register(state, ['r1', 'r2'])['set_id'], size=2)
    assert read_sets.combine_filter(state, None, a['set_id']) == ['r1', 'r2']
    assert read_sets.combine_filter(state, 'r2,r9', a['set_id']) == ['r2']
    assert read_sets.combine_filter(state, 'r9', a['set_id']) == [read_sets.NO_READS]   # matches nothing: shows nothing
    comma = read_sets.register(state, ['a,b'])['set_id']
    assert read_sets.combine_filter(state, None, comma) == ['a,b']                      # exact names, never re-split
    assert read_sets.combine_filter(state, 'x,y', None) == 'x,y'
    with pytest.raises(KeyError):
        read_sets.combine_filter(state, None, 'unknown')
    for i in range(read_sets.MAX_SETS + 1):
        read_sets.register(state, [f'n{i}'])
    assert read_sets.resolve(state, a['set_id']) is None                              # the oldest went
    with pytest.raises(ValueError):
        read_sets.register(state, 'r1')


def test_routes(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.reads import router
    from state.dependencies import get_state
    state = SimpleNamespace()
    seen = {}
    monkeypatch.setattr('routers.reads.compact_reads_payload_for_request', lambda **kw: seen.update(kw) or {'reads': []})
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    set_id = client.post('/api/read_sets', json={'ids': ['a', 'b']}).json()['set_id']
    ok = client.get('/api/reads/compact', params=dict(chrom='c', start=0, end=10, filter_set=set_id, filter_ids='b,z'))
    assert ok.status_code == 200 and seen['filter_ids'] == ['b']
    assert client.get('/api/reads/compact', params=dict(chrom='c', start=0, end=10, filter_set='gone')).status_code == 410
    assert client.post('/api/read_sets', json={'ids': 'nope'}).status_code == 422
