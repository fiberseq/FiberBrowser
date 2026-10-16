"""Shared set-up for the lab-server tests: a lab profile on the session app."""
from __future__ import annotations

import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient


def lab_config(tmp_path: Path, **overrides):
    from services.server_config import parse_config
    data = tmp_path / "data"
    runs = tmp_path / "runs"
    raw = {
        "profile": "lab",
        "server": {"host": "127.0.0.1", "port": 8911},
        "data": {"roots": [{"path": str(data), "label": "Lab data"},
                           {"path": str(runs), "label": "Runs", "writable": True}]},
        "state": {"dir": str(tmp_path / "state")},
        "auth": {"mode": "accounts", "max_failed_logins": 3, "lockout_minutes": 5},
    }
    for section, values in overrides.items():
        if isinstance(values, dict):
            raw.setdefault(section, {}).update(values)
        else:
            raw[section] = values
    return parse_config(raw, base_dir=str(tmp_path))


@pytest.fixture
def lab(tmp_path, standalone_app, monkeypatch):
    """Turn the session app into a lab server (accounts), restored afterwards."""
    yield from _lab(tmp_path, standalone_app, monkeypatch)


def _lab(tmp_path, standalone_app, monkeypatch, **overrides):
    import server as srv
    from services import lab as lab_profile, local_auth
    from services.lab.members import MemberStateManager, get_member_manager, set_member_manager
    from services.lab.users import UsersFile
    from services.server_config import prepare_state_dir, state_environment
    from state.runtime_state import get_session_manager, set_session_manager
    from state.session_manager import SessionManager

    (tmp_path / "data").mkdir(exist_ok=True)
    (tmp_path / "runs").mkdir(exist_ok=True)
    (tmp_path / "data" / "sample.bam").write_bytes(b"not really a bam")
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.bam").write_bytes(b"secret")
    link = tmp_path / "data" / "escape"
    if not link.exists():
        link.symlink_to(outside, target_is_directory=True)

    cfg = lab_config(tmp_path, **overrides)
    prepare_state_dir(cfg)
    for key, value in state_environment(cfg).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(local_auth, "_enabled", False)
    previous_members, previous_sessions = get_member_manager(), get_session_manager()
    lab_profile.configure(cfg)
    members = MemberStateManager(template=srv.state)
    set_member_manager(members)
    set_session_manager(SessionManager(template=srv.state, enabled=cfg.public_catalog.enabled))
    users = UsersFile(cfg.users_file)
    try:
        yield SimpleNamespace(cfg=cfg, app=standalone_app, users=users, members=members, tmp=tmp_path,
                              data=tmp_path / "data", runs=tmp_path / "runs", outside=outside)
    finally:
        for key in list(members.sessions):
            members.drop(key)
        lab_profile.configure(None)
        set_member_manager(previous_members)
        set_session_manager(previous_sessions)


def csrf_of(client: TestClient) -> str:
    return client.cookies.get("fiberbrowser_csrf") or ""


def sign_in(client: TestClient, name: str, password: str, *, next_path: str = "/", prefix: str = ""):
    page = client.get(prefix + "/auth/login")
    token = re.search(r"name='csrf' value='([^']+)'", page.text).group(1)
    return client.post(prefix + "/auth/login", data={"username": name, "password": password, "csrf": token,
                                            "next": next_path}, follow_redirects=False)


def member_client(lab, name: str = "alice", role: str = "member", password: str = "correct horse battery") -> TestClient:
    if lab.users.get(name) is None:
        lab.users.add(name, role=role, password=password)
    client = TestClient(lab.app)
    response = sign_in(client, name, password)
    assert response.status_code == 303, response.text
    client.headers["X-FiberBrowser-CSRF"] = csrf_of(client)
    return client


def audit_events(lab, event=None):
    from services.lab.audit import tail
    return tail(1000, path=lab.cfg.audit_log, event=event)

