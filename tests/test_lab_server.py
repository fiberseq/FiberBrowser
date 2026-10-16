"""The lab server profile (services/lab/): sign-in, CSRF, roles, confinement, shared stores, audit."""
from __future__ import annotations

import json
import os
import time

import pytest
from starlette.testclient import TestClient

from lab_fixtures import _lab, audit_events, csrf_of, lab, member_client, sign_in  # noqa: F401

PASSWORD = "correct horse battery"


# ---------------------------------------------------------------------------
# Sign-in flow and cookies
# ---------------------------------------------------------------------------

def test_signed_out_pages_redirect_to_login_and_api_says_401(lab):
    anon = TestClient(lab.app)
    page = anon.get("/", headers={"Accept": "text/html"}, follow_redirects=False)
    assert page.status_code == 303 and page.headers["location"] == "/auth/login?next=%2F"
    api = anon.get("/api/datasets")
    assert api.status_code == 401 and "Sign in" in api.json()["message"]
    assert anon.get("/api/files/list").status_code == 401
    login = anon.get("/auth/login")
    assert login.status_code == 200 and "Sign in" in login.text


def test_sign_in_sets_secure_httponly_cookies_scoped_to_the_root_path(lab, monkeypatch):
    from services import root_path
    lab.users.add("alice", password=PASSWORD)
    monkeypatch.setattr(root_path, "_root_path", "/rnode/n1/8911")
    client = TestClient(lab.app, base_url="https://lab.example.org")
    response = sign_in(client, "alice", PASSWORD, next_path="/?locus=chr1", prefix="/rnode/n1/8911")
    assert response.status_code == 303
    assert response.headers["location"] == "/rnode/n1/8911/?locus=chr1"
    cookies = response.headers.get_list("set-cookie")
    session = next(c for c in cookies if c.startswith("fiberbrowser_lab="))
    csrf = next(c for c in cookies if c.startswith("fiberbrowser_csrf="))
    for flag in ("HttpOnly", "Secure", "Path=/rnode/n1/8911/", "SameSite=lax"):
        assert flag.lower() in session.lower(), (flag, session)
    assert "httponly" not in csrf.lower() and "secure" in csrf.lower() and "samesite=strict" in csrf.lower()
    assert "Max-Age=43200" in session


def test_cookies_are_not_secure_over_plain_http_on_auto(lab):
    lab.users.add("alice", password=PASSWORD)
    client = TestClient(lab.app)
    response = sign_in(client, "alice", PASSWORD)
    session = next(c for c in response.headers.get_list("set-cookie") if c.startswith("fiberbrowser_lab="))
    assert "secure" not in session.lower() and "httponly" in session.lower()


def test_a_signed_in_member_uses_the_app_and_signs_out(lab):
    client = member_client(lab)
    me = client.get("/api/auth/me").json()
    assert me["user"] == {"name": "alice", "role": "member", "source": "accounts"}
    assert client.get("/api/datasets").status_code == 200
    out = client.post("/auth/logout", data={"csrf": csrf_of(client)}, follow_redirects=False)
    assert out.status_code == 303 and "signed_out" in out.headers["location"]
    assert client.get("/api/datasets").status_code == 401
    events = [e["event"] for e in audit_events(lab)]
    assert "login" in events and "logout" in events


def test_wrong_passwords_and_unknown_users_fail_the_same_way(lab):
    lab.users.add("alice", password=PASSWORD)
    anon = TestClient(lab.app)
    wrong = sign_in(anon, "alice", "not the password")
    unknown = sign_in(anon, "mallory", "not the password")
    assert wrong.status_code == unknown.status_code == 401
    assert "Wrong user name or password" in wrong.text and "Wrong user name or password" in unknown.text
    assert "fiberbrowser_lab" not in anon.cookies
    failed = audit_events(lab, "login_failed")
    assert [e["user"] for e in failed] == ["alice", "mallory"]
    assert all("password" not in json.dumps(e) for e in failed)


def test_repeated_failures_lock_the_account_even_with_the_right_password(lab):
    lab.users.add("alice", password=PASSWORD)
    anon = TestClient(lab.app)
    for _ in range(3):
        assert sign_in(anon, "alice", "wrong password!").status_code == 401
    locked = sign_in(anon, "alice", PASSWORD)
    assert locked.status_code == 429 and "Too many failed sign-ins" in locked.text
    assert audit_events(lab, "login_lockout") and audit_events(lab, "login_locked")


def test_lockout_expires(lab):
    from services.lab.auth import limiter
    lab.users.add("alice", password=PASSWORD)
    anon = TestClient(lab.app)
    for _ in range(3):
        sign_in(anon, "alice", "wrong password!")
    lim = limiter()
    for key in list(lim._locked_until):
        lim._locked_until[key] = time.time() - 1
    lim._fails.clear()
    assert sign_in(anon, "alice", PASSWORD).status_code == 303


def test_login_form_needs_its_csrf_token(lab):
    lab.users.add("alice", password=PASSWORD)
    anon = TestClient(lab.app)
    anon.get("/auth/login")
    forged = anon.post("/auth/login", data={"username": "alice", "password": PASSWORD, "csrf": "forged"},
                       follow_redirects=False)
    assert forged.status_code == 403
    cross = TestClient(lab.app).post("/auth/login", data={"username": "alice", "password": PASSWORD},
                                     headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
                                     follow_redirects=False)
    assert cross.status_code == 403


def test_next_never_leaves_the_site(lab):
    lab.users.add("alice", password=PASSWORD)
    for target in ("https://evil.example/", "//evil.example/", "/\\evil", "javascript:alert(1)"):
        response = sign_in(TestClient(lab.app), "alice", PASSWORD, next_path=target)
        assert response.headers["location"] == "/", target


def test_sessions_expire(lab, monkeypatch):
    from services.lab.logins import get_store
    client = member_client(lab)
    for login in get_store()._logins.values():
        login.expires = time.time() - 1
    assert client.get("/api/datasets").status_code == 401


def test_sign_ins_survive_a_restart_but_not_a_reset(lab):
    from services.lab import logins
    client = member_client(lab)
    logins.reset_store()  # a new process reads logins.json
    assert client.get("/api/datasets").status_code == 200
    lab.users.reset("alice")
    assert client.get("/api/datasets").status_code == 401


def test_logins_file_holds_only_token_hashes(lab):
    client = member_client(lab)
    token = client.cookies.get("fiberbrowser_lab")
    stored = (lab.tmp / "state" / "logins.json").read_text()
    assert token and token not in stored
    assert os.stat(lab.tmp / "state" / "logins.json").st_mode & 0o077 == 0


def test_invite_code_sets_the_password_once(lab):
    code = lab.users.add("bob")
    anon = TestClient(lab.app)
    page = anon.get(f"/auth/invite?user=bob&code={code}")
    import re
    token = re.search(r"name='csrf' value='([^']+)'", page.text).group(1)
    done = anon.post("/auth/invite", data={"username": "bob", "code": code, "password": "a new password",
                                           "password2": "a new password", "csrf": token}, follow_redirects=False)
    assert done.status_code == 303 and anon.cookies.get("fiberbrowser_lab")
    again = TestClient(lab.app)
    page = again.get("/auth/invite")
    token = re.search(r"name='csrf' value='([^']+)'", page.text).group(1)
    reused = again.post("/auth/invite", data={"username": "bob", "code": code, "password": "another password",
                                              "password2": "another password", "csrf": token})
    assert reused.status_code == 400 and "not valid" in reused.text
    assert lab.users.authenticate("bob", "a new password") is not None
    assert [e["event"] for e in audit_events(lab)].count("invite_accepted") == 1


# ---------------------------------------------------------------------------
# CSRF on the API
# ---------------------------------------------------------------------------

def test_state_changes_need_the_csrf_header_or_a_same_origin_browser(lab):
    client = member_client(lab)
    header = client.headers.pop("X-FiberBrowser-CSRF")
    refused = client.post("/api/clear_cache")
    assert refused.status_code == 403 and "cross-site" in refused.json()["message"]
    assert client.post("/api/clear_cache", headers={"X-FiberBrowser-CSRF": "wrong"}).status_code == 403
    assert client.post("/api/clear_cache", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/clear_cache", headers={"X-FiberBrowser-CSRF": header}).status_code == 200
    # A browser's own fetch: Fetch Metadata / Origin of this server.
    assert client.post("/api/clear_cache", headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200
    assert client.post("/api/clear_cache", headers={"Origin": "http://localhost"}).status_code == 200
    # Reads never need it.
    assert client.get("/api/datasets").status_code == 200


# ---------------------------------------------------------------------------
# Trusted proxy (SSO) and none modes
# ---------------------------------------------------------------------------

@pytest.fixture
def proxy_lab(tmp_path, standalone_app, monkeypatch):
    yield from _lab(tmp_path, standalone_app, monkeypatch,
                    auth={"mode": "proxy", "trusted_proxies": ["10.1.2.3"], "admins": ["carol"]})


def test_proxy_header_is_believed_only_from_the_trusted_proxy(proxy_lab):
    via_proxy = TestClient(proxy_lab.app, client=("10.1.2.3", 40000))
    me = via_proxy.get("/api/auth/me", headers={"X-Forwarded-User": "Dave"}).json()
    assert me["user"] == {"name": "dave", "role": "member", "source": "proxy"}
    admin = via_proxy.get("/api/auth/me", headers={"X-Forwarded-User": "carol"}).json()
    assert admin["user"]["role"] == "admin"
    direct = TestClient(proxy_lab.app, client=("10.9.9.9", 40000))
    refused = direct.get("/api/datasets", headers={"X-Forwarded-User": "carol"})
    assert refused.status_code == 401 and "sign-in proxy" in refused.json()["message"]
    # No header from the proxy: not signed in.
    assert via_proxy.get("/api/datasets").status_code == 401
    # X-Forwarded-For can't make a direct peer look like the proxy.
    spoofed = direct.get("/api/datasets", headers={"X-Forwarded-User": "carol", "X-Forwarded-For": "10.1.2.3"})
    assert spoofed.status_code == 401


def test_proxy_mode_uses_a_double_submit_csrf_cookie(proxy_lab):
    client = TestClient(proxy_lab.app, client=("10.1.2.3", 40000), headers={"X-Forwarded-User": "dave"})
    first = client.get("/api/datasets")
    assert first.status_code == 200 and client.cookies.get("fiberbrowser_csrf")
    assert client.post("/api/clear_cache").status_code == 403
    ok = client.post("/api/clear_cache", headers={"X-FiberBrowser-CSRF": client.cookies.get("fiberbrowser_csrf")})
    assert ok.status_code == 200


@pytest.fixture
def none_lab(tmp_path, standalone_app, monkeypatch):
    yield from _lab(tmp_path, standalone_app, monkeypatch, auth={"mode": "none", "user": "jd"})


def test_none_mode_attributes_everything_to_the_configured_user(none_lab):
    client = TestClient(none_lab.app)
    me = client.get("/api/auth/me").json()
    assert me["user"] == {"name": "jd", "role": "admin", "source": "none"}
    assert client.get("/auth/login").status_code == 200  # explains the proxy sign-in, no form
    assert client.post("/auth/login", data={"username": "x", "password": "y"}).status_code == 404


def test_none_mode_with_the_launch_token(none_lab, monkeypatch):
    """Behind OnDemand: the portal's Connect button POSTs the token once; the cookie follows."""
    from services import local_auth, root_path
    monkeypatch.setattr(local_auth, "_enabled", True)
    monkeypatch.setattr(local_auth, "_token", "ondemand-session-password")
    monkeypatch.setattr(local_auth, "_port", 8911)
    monkeypatch.setattr(root_path, "_root_path", "/rnode/node7/8911")
    client = TestClient(none_lab.app)
    assert client.get("/rnode/node7/8911/api/datasets").status_code == 401
    wrong = client.post("/rnode/node7/8911/auth/token", data={"token": "guess"}, follow_redirects=False)
    assert wrong.status_code == 401
    ok = client.post("/rnode/node7/8911/auth/token", data={"token": "ondemand-session-password"},
                     follow_redirects=False)
    assert ok.status_code == 303 and ok.headers["location"] == "/rnode/node7/8911/"
    cookie = ok.headers["set-cookie"]
    assert "Path=/rnode/node7/8911/" in cookie and "HttpOnly" in cookie
    assert client.get("/rnode/node7/8911/api/datasets").status_code == 200
    # Scripts send the token in a header; that needs no CSRF token.
    script = TestClient(none_lab.app, headers={"X-FiberBrowser-Token": "ondemand-session-password"})
    assert script.post("/api/clear_cache").status_code == 200


# ---------------------------------------------------------------------------
# Roles and the route policy
# ---------------------------------------------------------------------------

def test_members_cannot_reach_admin_routes_or_host_only_features(lab):
    member = member_client(lab)
    assert member.get("/api/admin/users").status_code == 403
    assert member.get("/api/admin/audit").status_code == 403
    assert member.post("/api/admin/users", json={"name": "eve"}).status_code == 403
    assert member.get("/admin").status_code == 403
    for method, path in (("GET", "/api/pick_file"), ("GET", "/api/pick_folder"), ("POST", "/api/quit"),
                         ("POST", "/api/shutdown"), ("POST", "/api/new-window"), ("GET", "/api/jupyter/state"),
                         ("GET", "/api/linked/sessions"), ("POST", "/api/nl/setup"), ("POST", "/api/nl/plan"),
                         ("POST", "/api/datasets/drop_window")):
        response = member.request(method, path)
        assert response.status_code == 403, (method, path, response.status_code)


def test_admins_manage_accounts_and_read_the_audit_log(lab):
    admin = member_client(lab, "root", role="admin")
    added = admin.post("/api/admin/users", json={"name": "Erin", "role": "member"}).json()
    assert added["success"] and added["name"] == "erin" and len(added["code"]) == 19
    names = [u["name"] for u in admin.get("/api/admin/users").json()["users"]]
    assert names == ["erin", "root"]
    assert "hash" not in json.dumps(admin.get("/api/admin/users").json())
    assert admin.post("/api/admin/users/erin/role", json={"role": "admin"}).json()["success"]
    reset = admin.post("/api/admin/users/erin/reset").json()
    assert reset["code"] and reset["code"] != added["code"]
    assert admin.delete("/api/admin/users/root").status_code == 400  # not yourself
    assert admin.delete("/api/admin/users/erin").json()["success"]
    events = [e["event"] for e in admin.get("/api/admin/audit").json()["events"]]
    for event in ("admin_user_add", "admin_user_role", "admin_user_reset", "admin_user_remove"):
        assert event in events
    assert added["code"] not in (lab.tmp / "state" / "audit.log").read_text()
    page = admin.get("/admin")
    assert page.status_code == 200 and "Lab admin" in page.text


def test_role_change_ends_the_members_sign_ins(lab):
    admin = member_client(lab, "root", role="admin")
    member = member_client(lab, "alice")
    admin.post("/api/admin/users/alice/role", json={"role": "admin"})
    assert member.get("/api/datasets").status_code == 401


# ---------------------------------------------------------------------------
# Data roots
# ---------------------------------------------------------------------------

def test_file_browser_starts_at_the_first_root_and_stays_inside(lab):
    member = member_client(lab)
    listing = member.get("/api/files/list").json()
    assert listing["success"] and listing["path"] == str(lab.data)
    assert listing["parent"] is None and listing["home"] == str(lab.data)
    assert [r["label"] for r in listing["roots"]] == ["Lab data", "Runs"]
    names = [e["name"] for e in listing["entries"]]
    assert "sample.bam" in names and "escape" not in names  # the symlink leaves the root
    for path in ("/etc", str(lab.tmp), str(lab.outside), str(lab.data / "escape"), str(lab.data / ".." / "outside"),
                 "~", str(lab.data / "escape" / "secret.bam")):
        response = member.get("/api/files/list", params={"path": path})
        assert response.status_code == 403 or response.json()["success"] is False, path


@pytest.mark.parametrize("method, path, kwargs", [
    ("GET", "/api/diagnose_bam", {"params": {"bam_path": "OUTSIDE/secret.bam"}}),
    ("POST", "/api/load_folder", {"params": {"path": "OUTSIDE"}}),
    ("GET", "/api/annotations/browse", {"params": {"dir": "OUTSIDE"}}),
    ("POST", "/api/datasets/add", {"json": {"path": "OUTSIDE/secret.bam"}}),
    ("POST", "/api/datasets/add", {"json": {"path": "DATA/escape/secret.bam"}}),
    ("POST", "/api/datasets/add", {"json": {"path": "DATA/../outside/secret.bam"}}),
    ("POST", "/api/load_fasta", {"json": {"path": "/etc/hosts"}}),
    ("POST", "/api/session/read", {"params": {"path": "OUTSIDE/secret.bam"}}),
    ("POST", "/api/session/import", {"json": {"session": {"datasets": [{"paths": ["OUTSIDE/secret.bam"]}]}}}),
    ("POST", "/api/footprint/rules/save", {"json": {"output_dir": "DATA", "rules": []}}),  # read-only root
    ("POST", "/api/footprint/rules/save", {"json": {"output_dir": "OUTSIDE", "rules": []}}),
    ("POST", "/api/pipeline/validate", {"json": {"output_root": "DATA/x"}}),
])
def test_paths_outside_the_roots_are_refused(lab, method, path, kwargs):
    member = member_client(lab)
    text = json.dumps(kwargs).replace("OUTSIDE", str(lab.outside)).replace("DATA", str(lab.data))
    response = member.request(method, path, **json.loads(text))
    assert response.status_code == 403, (path, response.status_code, response.text[:200])
    message = response.json()["message"]
    assert "outside the lab's data folders" in message or "read-only" in message or "turned off" in message


def test_paths_inside_the_roots_pass_the_check(lab):
    from services.lab import paths
    assert paths.allowed(str(lab.data / "sample.bam"))
    assert paths.allowed(str(lab.runs / "new" / "out.bam"), write=True)
    assert not paths.allowed(str(lab.data / "x"), write=True)
    assert not paths.allowed(str(lab.data / "escape" / "secret.bam"))
    assert paths.scan_json_body(json.dumps({"path": str(lab.data / "sample.bam")}).encode()) is None
    # An absolute-looking value that is not a file (an API path, a label) is not a path.
    assert paths.scan_json_body(json.dumps({"url": "/api/reads/compact", "label": "a/b"}).encode()) is None
    # ...but an existing file outside the roots under any key is refused.
    assert paths.scan_json_body(json.dumps({"anything": str(lab.outside / "secret.bam")}).encode())
    assert paths.scan_json_body(json.dumps({"url": "https://example.org/x.bam"}).encode()) is None
    assert paths.scan_query(f"file=file://{lab.outside}/secret.bam")


def test_uploads_go_to_the_shared_state_and_are_limited_and_audited(lab):
    from services.lab import get_config
    member = member_client(lab)
    get_config().limits.upload_max_mb = 1
    too_big = member.post("/api/files/upload", files={"file": ("big.bin", b"x" * (1024 * 1024 + 10))})
    assert too_big.status_code == 413
    ok = member.post("/api/files/upload", files={"file": ("small.bed", b"chr1\t1\t2\n")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["path"].startswith(str(lab.tmp / "state" / "uploads"))
    assert [e["user"] for e in audit_events(lab, "upload")] == ["alice"]


# ---------------------------------------------------------------------------
# Shared stores, per-member state
# ---------------------------------------------------------------------------

def test_each_member_has_their_own_working_state(lab):
    alice, bob = member_client(lab, "alice"), member_client(lab, "bob")
    state_a = lab.members.for_user("alice")
    state_b = lab.members.for_user("bob")
    assert state_a is not state_b
    import server as srv
    assert state_a is not srv.state and state_b is not srv.state
    # Copy-on-write reference: one member switching genome leaves the others alone.
    state_a.current_genome = "dm6-only-for-alice"
    assert lab.members.for_user("bob").current_genome != "dm6-only-for-alice"
    assert srv.state.current_genome != "dm6-only-for-alice"
    # Requests of each member see their own state.
    assert state_a.datasets is not state_b.datasets and state_a.quality_filters is not state_b.quality_filters
    state_a.quality_filters.append({"marker": "alice"})
    assert alice.get("/api/datasets").status_code == 200 and bob.get("/api/datasets").status_code == 200
    assert lab.members.for_user("bob").quality_filters == []


def test_lab_sessions_are_shared_and_attributed(lab):
    alice, bob = member_client(lab, "alice"), member_client(lab, "bob")
    saved = alice.post("/api/lab/sessions", json={"name": "CTCF locus", "session": {
        "datasets": [{"paths": [str(lab.data / "sample.bam")]}], "viewport": {"chrom": "chr1"}}}).json()
    assert saved["success"] and saved["user"] == "alice"
    listing = bob.get("/api/lab/sessions").json()["sessions"]
    assert [(s["name"], s["user"]) for s in listing] == [("CTCF locus", "alice")]
    assert bob.get(f"/api/lab/sessions/{saved['id']}").json()["session"]["viewport"] == {"chrom": "chr1"}
    assert bob.delete(f"/api/lab/sessions/{saved['id']}").status_code == 403
    assert bob.post("/api/lab/sessions", json={"name": "x", "session": {}, "replace": saved["id"]}).status_code == 403
    assert alice.delete(f"/api/lab/sessions/{saved['id']}").json()["success"]
    assert bob.get("/api/lab/sessions/../../users").status_code in (400, 404)
    events = [(e["event"], e["user"]) for e in audit_events(lab)]
    assert ("session_save", "alice") in events and ("session_delete", "alice") in events
    # A session naming files outside the roots can't be shelved.
    leak = alice.post("/api/lab/sessions", json={"name": "x", "session": {
        "datasets": [{"paths": [str(lab.outside / "secret.bam")]}]}})
    assert leak.status_code == 403


def test_shared_state_env_points_the_stores_at_the_state_dir(lab):
    from services.pipeline_jobs import jobs_dir
    from services.upload_store import upload_dir
    assert jobs_dir() == str(lab.tmp / "state" / "jobs")
    assert upload_dir() == str(lab.tmp / "state" / "uploads")
    assert os.environ["FIBERBROWSER_LIBRARY"] == str(lab.tmp / "state" / "library.json")


def test_lab_state_is_isolated_from_personal_mode(lab, standalone_app):
    """Turning the lab profile off leaves nothing of it behind."""
    from services import lab as lab_profile
    from services.runtime import get_lab_mode
    member_client(lab)
    lab_profile.configure(None)
    try:
        assert not get_lab_mode()
        from services.local_auth import auth_headers
        personal = TestClient(standalone_app, headers=auth_headers())
        assert personal.get("/api/lab/sessions").status_code == 404
        assert personal.get("/api/auth/me").status_code == 404
        assert personal.get("/auth/login").status_code == 404
        # Personal listing is not confined to the lab's roots.
        listing = personal.get("/api/files/list", params={"path": str(lab.outside)}).json()
        assert listing["success"] and "roots" not in listing
    finally:
        lab_profile.configure(lab.cfg)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def test_jobs_are_off_by_default(lab):
    member = member_client(lab)
    response = member.get("/api/pipeline/jobs")
    assert response.status_code == 403 and "turned off" in response.json()["detail"]


def test_enabled_jobs_are_capped_attributed_and_owner_managed(lab, monkeypatch):
    from services.lab import get_config, jobs
    from services.pipeline_jobs import JobManager
    cfg = get_config()
    cfg.jobs.enabled = True
    cfg.jobs.max_cores_per_user = 2
    cfg.jobs.max_concurrent_per_user = 1
    alice, bob = member_client(lab, "alice"), member_client(lab, "bob")
    assert alice.get("/api/pipeline/jobs").status_code == 200
    assert jobs.max_cores() == min(2, os.cpu_count() or 1)
    manager = JobManager(str(lab.tmp / "state" / "jobs"), launcher=lambda spec, d: None)
    monkeypatch.setattr(manager, "tick", lambda: None)  # nothing is started in this test
    monkeypatch.setattr(manager, "ensure_running", lambda: None)
    monkeypatch.setattr("routers.pipeline._manager", lambda: manager)
    monkeypatch.setattr("services.pipeline_jobs.get_job_manager", lambda: manager)
    import services.pipeline_jobs as pj
    job_dir = os.path.join(manager.root, "20260929-120000-abcdef")
    os.makedirs(job_dir)
    pj._write_json(os.path.join(job_dir, "spec.json"), {"id": "20260929-120000-abcdef", "argv": ["true"], "user": "alice"})
    pj._write_json(os.path.join(job_dir, "state.json"), {"status": "queued"})
    from services.runtime import lab_request_context
    from services.lab.users import LabUser
    with lab_request_context(user=LabUser("alice")):
        assert "1 run(s) queued or running" in (jobs.check_submit(1) or "")
    with lab_request_context(user=LabUser("bob")):
        assert jobs.check_submit(1) is None
    assert bob.post("/api/pipeline/jobs/20260929-120000-abcdef/cancel").status_code == 403
    assert bob.delete("/api/pipeline/jobs/20260929-120000-abcdef").status_code == 403
    listed = alice.get("/api/pipeline/jobs").json()["jobs"]
    assert listed[0]["user"] == "alice"


# ---------------------------------------------------------------------------
# Anonymous public catalog on the same server
# ---------------------------------------------------------------------------

@pytest.fixture
def catalog_lab(tmp_path, standalone_app, monkeypatch):
    (tmp_path / "catalog.json").write_text(json.dumps({"groups": []}))
    yield from _lab(tmp_path, standalone_app, monkeypatch,
                    public_catalog={"enabled": True, "catalog": str(tmp_path / "catalog.json")})


def test_anonymous_visitors_browse_read_only_and_members_keep_full_access(catalog_lab):
    anon = TestClient(catalog_lab.app)
    assert anon.get("/api/datasets").status_code == 200
    assert anon.get("/api/catalog").status_code == 200
    for method, path in (("GET", "/api/files/list"), ("POST", "/api/files/upload"), ("GET", "/api/lab/sessions"),
                         ("GET", "/api/pipeline/jobs"), ("GET", "/api/admin/users"), ("POST", "/api/workspaces")):
        assert anon.request(method, path).status_code in (401, 403), (method, path)
    member = member_client(catalog_lab)
    assert member.get("/api/files/list").json()["success"]
    assert member.get("/api/lab/sessions").status_code == 200


def test_lab_route_policy_names_only_existing_routes(standalone_app):
    """No stale entries: every denied / admin-only route of the lab policy exists."""
    from services.lab.auth import AUDITED_ROUTES, COPILOT_ALLOWED_WHEN_OFF, LAB_ADMIN_ONLY, LAB_DENIED
    from services.public_mode_guard import iter_route_entries
    routes = {(m, e.path) for e in iter_route_entries(standalone_app) for m in (e.methods or ())}
    routes |= {("GET", "/admin")}
    for entry in LAB_DENIED | LAB_ADMIN_ONLY | COPILOT_ALLOWED_WHEN_OFF | set(AUDITED_ROUTES):
        assert entry in routes, entry


def test_sessions_may_name_the_servers_genome_cache_and_catalog_files(lab, monkeypatch, tmp_path):
    """A session's reference (a downloaded genome) and catalog datasets are the server's own files."""
    from services.lab import get_config
    home = tmp_path / "server-home"
    genomes = home / ".fiberhmm" / "genomes"
    genomes.mkdir(parents=True)
    (genomes / "hg38.fa").write_text(">chr1\nACGT\n")
    monkeypatch.setenv("HOME", str(home))
    catalog_data = tmp_path / "catalog-data"
    catalog_data.mkdir()
    (catalog_data / "shared.bam").write_bytes(b"x")
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"groups": [{"name": "g", "datasets": [{"path": "catalog-data/shared.bam"}]}]}))
    get_config().catalog = str(catalog)
    member = member_client(lab)
    session = {"reference": {"fasta_path": str(genomes / "hg38.fa")},
               "datasets": [{"paths": [str(catalog_data / "shared.bam")]}]}
    saved = member.post("/api/lab/sessions", json={"name": "with reference", "session": session})
    assert saved.status_code == 200, saved.text
    # Still nothing else outside the roots.
    leak = member.post("/api/lab/sessions", json={"name": "x", "session": {"reference": {
        "fasta_path": str(lab.outside / "secret.bam")}}})
    assert leak.status_code == 403


def test_anonymous_visitors_cannot_replace_the_shared_reference(catalog_lab):
    """Like --public visitors: they may fill an empty shared field, never replace one."""
    import server as srv
    from services.runtime import lab_request_context
    from state.browser_state import BrowserState
    template = srv.state
    saved = template.__dict__.get("chroms")
    object.__setattr__(template, "chroms", [{"name": "chrKeep", "size": 10}])
    try:
        visitor = BrowserState.fork_for_session(template)
        with lab_request_context(anonymous=True):
            with pytest.raises(PermissionError):
                visitor.chroms = [{"name": "chrEvil", "size": 5}]
        assert template.chroms == [{"name": "chrKeep", "size": 10}]
    finally:
        object.__setattr__(template, "chroms", saved)


def test_the_login_page_sends_a_signed_in_member_on(lab):
    client = member_client(lab)
    csrf = client.cookies.get("fiberbrowser_csrf")
    again = client.get("/auth/login?next=/dafc", follow_redirects=False)
    assert again.status_code == 303 and again.headers["location"] == "/dafc"
    assert client.cookies.get("fiberbrowser_csrf") == csrf
