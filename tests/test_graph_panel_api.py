"""The graph panel's API (routers/graph_panel.py, services/graph_panel/{helper,registration,service}.py).

Helper resolution (developer override, the app's bundled copy, the companion wheel,
"Graph helper unavailable" with its install hint), registration by verified package,
request validation before any worker sees it (stale revisions, the 50 kb and
four-path limits), cancellation by request ID, and the server's shutdown reaping
every helper it started. Uses the fake helper; tests/test_graph_panel_real.py runs
the real one when it is supplied.
"""
from __future__ import annotations

import json
import os
import sys
import time
import types
from pathlib import Path

import pytest

from services.graph_panel import helper as helper_mod
from services.graph_panel import service
from services.graph_panel.worker import LIVE_PIDS

FAKE = Path(__file__).with_name("fake_graph_helper.py")
REVS = {"package": "a" * 64, "graph": "b" * 64, "db": "c" * 64, "maps": "d" * 64}


@pytest.fixture
def fake_helper(tmp_path):
    script = tmp_path / "bin" / "fiberbrowser-graph"
    script.parent.mkdir()
    script.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    script.chmod(0o755)
    return str(script)


@pytest.fixture
def package(tmp_path):
    pkg = tmp_path / "toy-package"
    pkg.mkdir()
    (pkg / "manifest.json").write_text(json.dumps({
        "revisions": REVS, "producer": "fake", "build_target": "test",
        "bindings": [
            {"key": "target", "path": {"sample": "REF", "haplotype": "0", "contig": "chrT"}, "assembly": "REF",
             "reference": "REF", "size": 1000, "fragments": [{"origin": 0, "end": 1000, "indexed": True}]},
            {"key": "alt", "path": {"sample": "ALT", "haplotype": "1", "contig": "chrA"}, "assembly": "ALT",
             "reference": "ALT", "size": None, "size_inferred": True, "fragments": [{"origin": 0, "end": 990}]},
        ],
        "maps": [{"target": "target", "source": "alt"}],
    }))
    (pkg / "graph.db").write_bytes(b"db")
    return pkg


@pytest.fixture
def graph_env(monkeypatch, tmp_path, fake_helper):
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", fake_helper)
    monkeypatch.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path / "registry.json"))
    monkeypatch.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
    monkeypatch.setenv("FAKE_GRAPH_LOG", str(tmp_path / "helper.log"))
    service.reset_for_tests()
    yield tmp_path
    service.reset_for_tests()


@pytest.fixture
def app_client(standalone_app, graph_env):
    from starlette.testclient import TestClient
    from conftest import auth_headers
    with TestClient(standalone_app, headers=auth_headers()) as client:
        yield client
    # Leaving the context ran the server's lifespan shutdown: no helper survives it.
    assert not LIVE_PIDS, f"helpers left after shutdown: {LIVE_PIDS}"


def body(reg, **over):
    out = {"registration_id": reg["id"], "revisions": reg["revisions"], "request_id": "req-1", "panel_id": "panel-a",
           "generation": 1, "target": "target", "interval": {"start": 100, "end": 200}, "selected": ["target", "alt"],
           "context_bp": 100, "snarls": "none"}
    out.update(over)
    return out


# ----------------------------------------------------------------------------- resolution

def test_unavailable_helper_says_so_with_an_install_hint(monkeypatch, standalone_app, tmp_path):
    monkeypatch.delenv("FIBERBROWSER_GRAPH_HELPER", raising=False)
    monkeypatch.setattr(helper_mod, "_bundled_candidates", lambda: [])
    monkeypatch.setattr(helper_mod, "_companion_candidate", lambda: (None, None))
    monkeypatch.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path / "r.json"))
    service.reset_for_tests()
    from starlette.testclient import TestClient
    from conftest import auth_headers
    client = TestClient(standalone_app, headers=auth_headers())
    status = client.get("/api/graph/status").json()
    assert status["helper"]["available"] is False
    assert 'pip install "fiberbrowser[graph]"' in status["helper"]["hint"]
    r = client.post("/api/graph/subgraph", json={"registration_id": "x", "request_id": "r1"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "helper_unavailable"
    assert "fiberbrowser[graph]" in r.json()["error"]["hint"]
    service.reset_for_tests()


def test_resolution_order_and_a_broken_override(monkeypatch, fake_helper, tmp_path):
    monkeypatch.setattr(helper_mod, "_bundled_candidates", lambda: [str(tmp_path / "nowhere" / "fiberbrowser-graph")])
    module = types.ModuleType("fiberbrowser_graph_native")
    module.helper_path = lambda: fake_helper
    monkeypatch.setitem(sys.modules, "fiberbrowser_graph_native", module)
    monkeypatch.delenv("FIBERBROWSER_GRAPH_HELPER", raising=False)
    helper_mod.clear_cache()
    status = helper_mod.resolve()
    assert status.available and status.source == "companion" and status.path == fake_helper
    assert status.handshake["producer"].startswith("fake-graph-helper")
    # The app's bundled copy wins over the companion package when it exists.
    monkeypatch.setattr(helper_mod, "_bundled_candidates", lambda: [fake_helper])
    assert helper_mod.resolve().source == "bundled"
    # A configured developer helper must pass the handshake; it never silently falls back.
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", str(tmp_path / "missing-helper"))
    status = helper_mod.resolve()
    assert not status.available and "does not exist" in status.error
    bad = tmp_path / "bad-helper"
    bad.write_text("#!/bin/sh\necho nope\n")
    bad.chmod(0o755)
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", str(bad))
    status = helper_mod.resolve()
    assert not status.available and "handshake" in status.error and status.hint
    helper_mod.clear_cache()


def test_schema_mismatch_is_unavailable(monkeypatch, fake_helper, tmp_path):
    wrapper = tmp_path / "old-helper"
    wrapper.write_text("#!/bin/sh\nexec " + sys.executable + " -c \"import json,struct,sys;"
                       "d=json.dumps({'protocol':1,'type':'ready','job_id':'startup','generation':0,"
                       "'revisions':{'package':'','graph':'','db':'','maps':''},'handshake':{'db_schemas':['GBZ-base version 3'],"
                       "'package_schemas':[1],'map_schemas':[2]}}).encode();sys.stdout.buffer.write(struct.pack('>I',len(d))+d)\"\n")
    wrapper.chmod(0o755)
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", str(wrapper))
    helper_mod.clear_cache()
    status = helper_mod.resolve()
    assert not status.available and "GBZ-base version 4" in status.error
    helper_mod.clear_cache()


# ----------------------------------------------------------------------------- API

def test_register_query_and_cancel_through_the_api(app_client, package, graph_env):
    status = app_client.get("/api/graph/status").json()
    assert status["helper"]["available"] and status["helper"]["source"] == "env"
    assert status["registrations"] == []
    r = app_client.post("/api/graph/registrations", json={"package": str(package)})
    assert r.status_code == 200, r.text
    reg = r.json()["registration"]
    assert reg["id"] == "g" + "a" * 16 and reg["revisions"] == REVS
    assert [b["key"] for b in reg["bindings"]] == ["target", "alt"]
    assert reg["bindings"][1]["size_inferred"] is True
    # Remembered as a locator for the next start.
    saved = json.loads((graph_env / "registry.json").read_text())
    assert [e["dir"] for e in saved["packages"]] == [os.path.realpath(package)]
    assert saved["packages"][0]["package"] == REVS["package"] and reg["verification"] == "verified"

    r = app_client.post("/api/graph/subgraph", json=body(reg))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "ok" and out["request_id"] == "req-1" and out["generation"] == 1
    assert out["result"]["echo"] == {"target": "target", "interval": {"start": 100, "end": 200},
                                     "selected": ["target", "alt"], "context_bp": 100, "snarls": "none"}
    assert out["timings"]["startup_ms"] is not None and out["cached"] is False
    again = app_client.post("/api/graph/subgraph", json=body(reg, request_id="req-2", generation=2)).json()
    assert again["cached"] is True and again["generation"] == 2
    # A flank margin is passed on (and is part of the cache identity).
    flanked = app_client.post("/api/graph/subgraph", json=body(reg, request_id="req-3", generation=3, flank_bp=1)).json()
    assert flanked["result"]["echo"]["flank_bp"] == 1 and flanked["cached"] is False

    paths = app_client.get(f"/api/graph/registrations/{reg['id']}/paths").json()
    assert paths["total"] == 1 and [b["key"] for b in paths["bindings"]] == ["target", "alt"]

    # Cancelling an unknown request is harmless; a pending one is covered by the pool tests.
    assert app_client.delete("/api/graph/requests/nope").json()["cancelled"] is False
    pids = {w["pid"] for w in app_client.get("/api/graph/status").json()["pool"]["workers"]}
    assert pids and pids <= LIVE_PIDS


@pytest.mark.parametrize("over,status,code", [
    ({"revisions": {**REVS, "maps": "e" * 64}}, 409, "stale_revision"),
    ({"interval": {"start": 0, "end": 100_000}}, 413, "selection_limit"),
    ({"selected": ["target", "alt", "x", "y", "z"]}, 413, "selection_limit"),
    ({"selected": ["alt"]}, 422, "invalid_request"),
    ({"selected": ["target", "nope"]}, 422, "invalid_request"),
    ({"target": "nope"}, 422, "invalid_request"),
    ({"interval": {"start": 200, "end": 100}}, 422, "invalid_request"),
    ({"context_bp": 5000}, 422, "invalid_request"),
    ({"snarls": "all"}, 422, "invalid_request"),
    ({"flank_bp": 1001}, 422, "invalid_request"),
    ({"flank_bp": -1}, 422, "invalid_request"),
    ({"flank_bp": True}, 422, "invalid_request"),
    ({"limits": {"nodes": -1}}, 422, "invalid_request"),
    ({"limits": {"no_such_limit": 5}}, 422, "invalid_request"),
    ({"request_id": "bad id with spaces"}, 422, "invalid_request"),
    ({"registration_id": "gmissing"}, 404, "unknown_registration"),
    ({"revisions": ["bad"]}, 422, "invalid_request"),
    ({"interval": "bad"}, 422, "invalid_request"),
    ({"limits": [1]}, 422, "invalid_request"),
    ({"limits": {"nodes": True}}, 422, "invalid_request"),
    ({"limits": {"wire_bytes": 10}}, 422, "invalid_request"),
])
def test_requests_are_refused_before_any_helper_job(app_client, package, graph_env, over, status, code):
    reg = app_client.post("/api/graph/registrations", json={"package": str(package)}).json()["registration"]
    r = app_client.post("/api/graph/subgraph", json=body(reg, **over))
    assert r.status_code == status, r.text
    assert r.json()["error"]["code"] == code
    log = graph_env / "helper.log"
    assert not log.exists() or " query " not in log.read_text()


def test_a_package_that_fails_verification_or_changes_is_refused(app_client, package, graph_env):
    (package / "BAD").write_text("x")
    r = app_client.post("/api/graph/registrations", json={"package": str(package)})
    assert r.status_code == 422 and r.json()["error"]["code"] == "package_invalid"
    assert "digest mismatch" in r.json()["error"]["message"]
    (package / "BAD").unlink()
    reg = app_client.post("/api/graph/registrations", json={"package": str(package)}).json()["registration"]
    time.sleep(0.01)
    (package / "graph.db").write_bytes(b"changed after verification")
    r = app_client.post("/api/graph/subgraph", json=body(reg))
    assert r.status_code == 409 and r.json()["error"]["code"] == "package_changed"
    # No longer offered: listed as a registration error until registered again.
    status = app_client.get("/api/graph/status").json()
    assert status["registrations"] == [] and "changed" in status["registration_errors"][0]["error"]
    r = app_client.post("/api/graph/registrations", json={"package": str(package / 'nope')})
    assert r.status_code == 404


def test_env_packages_are_registered_at_first_use(standalone_app, graph_env, package, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_GRAPH_PACKAGES", str(package))
    service.reset_for_tests()
    from starlette.testclient import TestClient
    from conftest import auth_headers
    with TestClient(standalone_app, headers=auth_headers()) as client:
        regs = client.get("/api/graph/registrations").json()["registrations"]
        assert [r["id"] for r in regs] == ["g" + "a" * 16]
    assert not LIVE_PIDS


def test_lifespan_shutdown_reaps_a_busy_helper(standalone_app, graph_env, package):
    """A stalled query still running when the server stops: the shutdown kills and reaps it, and the waiting
    request is answered (retryable ``shutdown``) rather than left hanging."""
    import threading
    from starlette.testclient import TestClient
    from conftest import auth_headers
    pids, answers = set(), []
    with TestClient(standalone_app, headers=auth_headers()) as client:
        reg = client.post("/api/graph/registrations", json={"package": str(package)}).json()["registration"]
        client.post("/api/graph/subgraph", json=body(reg, request_id="warm"))

        def stalled():   # interval start 4242: the fake helper never answers
            r = client.post("/api/graph/subgraph", json=body(reg, request_id="slow", interval={"start": 4242, "end": 4300}))
            answers.append((r.status_code, r.json()["error"]["code"]))
        thread = threading.Thread(target=stalled, daemon=True)
        thread.start()
        time.sleep(0.3)
        workers = client.get("/api/graph/status").json()["pool"]["workers"]
        pids |= {w["pid"] for w in workers}
        assert "busy" in {w["state"] for w in workers}
    thread.join(5)
    assert answers == [(503, "shutdown")]
    assert pids and not LIVE_PIDS
    for pid in pids:
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


def test_a_remembered_package_skips_reverification_only_while_its_files_are_unchanged(graph_env, package, fake_helper):
    from services.graph_panel.registration import Registry
    first = Registry(str(graph_env / "registry.json"))
    first.ensure_loaded(fake_helper)
    reg = first.register(fake_helper, str(package))
    assert reg.verification == "verified"
    # A marker the fake helper's verify rejects: a remembered, unchanged package is not verified again.
    (package / "BAD").write_text("x")
    os.utime(package / "BAD", ns=(0, 0))
    second = Registry(str(graph_env / "registry.json"))
    second.ensure_loaded(fake_helper)
    assert second.errors() and "verification" in second.errors()[0]["error"]   # the new file changed the fingerprint
    (package / "BAD").unlink()
    third = Registry(str(graph_env / "registry.json"))
    third.ensure_loaded(fake_helper)
    assert [r["verification"] for r in third.list()] == ["remembered"]
    time.sleep(0.01)
    (package / "graph.db").write_bytes(b"db2")
    fourth = Registry(str(graph_env / "registry.json"))
    fourth.ensure_loaded(fake_helper)
    assert [r["verification"] for r in fourth.list()] == ["verified"]


def test_the_macos_app_copy_is_found_in_graph_helper(monkeypatch, fake_helper, tmp_path):
    """FiberBrowser.spec collects the helper into graph-helper/ under the frozen app's _MEIPASS."""
    frameworks = tmp_path / "Frameworks"
    (frameworks / "graph-helper").mkdir(parents=True)
    os.symlink(fake_helper, frameworks / "graph-helper" / "fiberbrowser-graph")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(frameworks), raising=False)
    monkeypatch.setattr(helper_mod, "_companion_candidate", lambda: (None, None))
    helper_mod.clear_cache()
    status = helper_mod.resolve(environ={})
    assert status.available and status.source == "bundled" and status.path.endswith("graph-helper/fiberbrowser-graph")
    helper_mod.clear_cache()


def test_flank_bp_only_reaches_a_helper_that_lists_it(monkeypatch, standalone_app, graph_env, package):
    """An older helper (no handshake features) would refuse the unknown field: the request goes without it."""
    from starlette.testclient import TestClient
    from conftest import auth_headers
    monkeypatch.setenv("FAKE_GRAPH_FEATURES", "none")
    service.reset_for_tests()
    with TestClient(standalone_app, headers=auth_headers()) as client:
        reg = client.post("/api/graph/registrations", json={"package": str(package)}).json()["registration"]
        out = client.post("/api/graph/subgraph", json=body(reg, flank_bp=1)).json()
        assert "flank_bp" not in out["result"]["echo"]
    assert not LIVE_PIDS
