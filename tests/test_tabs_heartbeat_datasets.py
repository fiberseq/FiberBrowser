"""The tab heartbeat's loaded-datasets key (routers/utility.py): it changes when a dataset is added, removed or
replaced on the server, so an open page notices datasets loaded after it opened (a script, another tab)."""
from __future__ import annotations

import types

from routers.utility import datasets_key


def _state(**datasets):
    return types.SimpleNamespace(datasets={k: types.SimpleNamespace(paths=v) for k, v in datasets.items()})


def test_key_follows_the_loaded_datasets():
    empty = datasets_key(_state())
    one = datasets_key(_state(a=["/x.bam"]))
    assert empty != one
    assert datasets_key(_state(a=["/x.bam"])) == one                       # stable
    assert datasets_key(_state(a=["/y.bam"])) != one                       # replaced under the same ID
    assert datasets_key(_state(a=["/x.bam"], b=["/z.bam"])) not in (empty, one)
    assert datasets_key(types.SimpleNamespace()) == empty                  # no dataset table at all
    # Re-configured (another lift map or settings: its revision) under the same ID and files.
    lifted = lambda k: types.SimpleNamespace(datasets={"a": types.SimpleNamespace(  # noqa: E731
        paths=["/x.bam"], live_lift=types.SimpleNamespace(key=lambda: k))})
    assert datasets_key(lifted("k1")) != datasets_key(lifted("k2"))


def test_heartbeat_reports_the_key():
    import server as srv
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient

    client = TestClient(srv.app, headers=auth_headers(), base_url="http://127.0.0.1", client=("127.0.0.1", 5000))
    out = client.post("/api/tabs/heartbeat", params={"tab": "t-key"}).json()
    assert out["ok"] is True and out["datasets"] == datasets_key(srv.state)
