"""--public mode: route allowlist, in-route checks, sessions, origin guard."""
from __future__ import annotations

import pytest

# Routes a public server refuses on purpose: host files, host processes, the
# host's credentials, state shared by every visitor, or host-only features.
# A new route must be added here or to PUBLIC_ALLOWED
# (browser/services/public_mode_guard.py); test_every_route_is_classified
# fails until it is.
PUBLIC_DENIED = {
    # Live lift: opening a dataset from the host's files, reading a map from them, and its settings (the flag
    # itself is harmless but is a host feature too).
    ("GET", "/api/lift/enabled"), ("GET", "/api/lift/inspect"), ("POST", "/api/lift/datasets"),
    ("POST", "/api/lift/datasets/{dataset_id}/settings"),
    ("GET", "/api/lift/differences"), ("GET", "/api/lift/difference_reads"),
    ("GET", "/api/lift/difference_sequence"), ("POST", "/api/lift/provenance/{dataset_id}"),
    ("POST", "/api/lift/analysis/summary"), ("POST", "/api/lift/analysis/split"),
    # Cross-region correspondence analyses are local workspace operations.
    ("POST", "/api/cluster-regions"), ("POST", "/api/scan-correspondence"),
    ("GET", "/api/app/performance"), ("POST", "/api/app/performance"),
    # the app's own settings, its FiberHMM choice and its update check (the host's files, keychain, downloads)
    ("GET", "/api/app/info"), ("POST", "/api/app/fiberhmm"), ("GET", "/api/app/update"),
    ("POST", "/api/app/update/settings"), ("POST", "/api/app/update/token"), ("DELETE", "/api/app/update/token"),
    ("POST", "/api/app/update/download"), ("GET", "/api/app/update/download"),
    ("POST", "/api/app/update/download/cancel"), ("POST", "/api/app/update/open"),
    # identifying an insertion: host processes (BLAST/minimap2), library downloads, Dfam
    ("GET", "/api/insertions/te_library"), ("POST", "/api/insertions/te_library/download"),
    ("POST", "/api/insertions/identify"), ("GET", "/api/insertions/identify/jobs/{job_id}"),
    ("DELETE", "/api/insertions/identify/jobs/{job_id}"), ("POST", "/api/insertions/identify/dfam"),
    # an insertion's carriers on its alternate allele (writes a BAM and FASTA on the host)
    ("POST", "/api/alt_allele/open"),
    # how the last run on this port ended (a visitor's page never offers to reopen),
    # and a BAM of chosen reads (host files written to a temp file)
    ("GET", "/api/session/launch"), ("POST", "/api/reads/export_bam"),
    # host files and folders
    ("GET", "/api/demo"), ("POST", "/api/demo/load"),
    # a dataset's own reference (loads a genome or a host FASTA)
    ("POST", "/api/panel_genomes/attach"), ("POST", "/api/panel_genomes/detach"),
    ("POST", "/api/annotations/add"), ("GET", "/api/annotations/browse"), ("GET", "/api/diagnose_bam"),
    ("GET", "/api/files/list"), ("POST", "/api/files/upload"), ("POST", "/api/load_folder"),
    ("POST", "/api/overlays/add"), ("POST", "/api/tracks/add_motif_file"),
    ("POST", "/api/footprint/consensus/import"), ("POST", "/api/footprint/consensus/jobs/{job_id}/bam-export"),
    # the user's analysis preferences file on the host (~/.fiberhmm/analysis_preferences.json)
    ("GET", "/api/preferences/analysis"), ("PUT", "/api/preferences/analysis"),
    ("POST", "/api/footprint/derived_layers/export"), ("POST", "/api/footprint/derived_layers/load"),
    ("POST", "/api/footprint/rules/load"), ("POST", "/api/footprint/rules/save"),
    ("POST", "/api/datasets/add"), ("POST", "/api/datasets/add_grouped"), ("POST", "/api/datasets/add_url"),
    ("POST", "/api/datasets/drop_window"), ("POST", "/api/session/check_files"), ("POST", "/api/session/import"),
    ("POST", "/api/session/read"), ("GET", "/api/tracks/recent"), ("POST", "/api/tracks/recent"),
    ("DELETE", "/api/tracks/recent"), ("GET", "/api/bigbed/names"), ("GET", "/api/reads/image"),
    ("GET", "/api/pick_file"), ("GET", "/api/pick_file_primer"), ("GET", "/api/pick_folder"),
    # the user's region catalog (a host file) and region finding (scans a dataset's reads)
    ("GET", "/api/regions/catalog"), ("PUT", "/api/regions/catalog"), ("DELETE", "/api/regions/catalog"),
    ("GET", "/api/regions/label"), ("GET", "/api/reads/regions"),
    # the shared reference (GTF, FASTA, genome, plasmids)
    ("POST", "/api/load_fasta"), ("POST", "/api/load_gtf"), ("DELETE", "/api/gtf"),
    ("POST", "/api/load_plasmid"), ("POST", "/api/load_plasmids"), ("POST", "/api/circular_chrom"),
    ("POST", "/api/plasmid/open"), ("POST", "/api/plasmid/confirm"), ("GET", "/api/plasmid/links"),
    ("POST", "/api/reference_pairs"), ("GET", "/api/cache/status"), ("POST", "/api/reference/declare_genome"),
    ("GET", "/api/reference/genome_declarations"), ("POST", "/api/reference/genome_declarations"),
    # host processes and shutdown
    ("POST", "/api/new-window"), ("GET", "/api/shutdown"), ("POST", "/api/shutdown"), ("POST", "/api/quit"),
    ("GET", "/api/cancel_shutdown"), ("POST", "/api/cancel_shutdown"), ("POST", "/api/tabs/heartbeat"),
    ("POST", "/api/render/figure"), ("POST", "/api/render/live_state"),
    # primer design (BLAST on the host)
    ("POST", "/api/design_primers"), ("POST", "/api/design_dafc_primers"), ("POST", "/api/design_4c_primers"),
    ("POST", "/api/primer_abort"), ("POST", "/api/primer_blast_db/build"), ("GET", "/api/primer_config"),
    ("POST", "/api/primer_config"), ("GET", "/api/primer_progress"), ("GET", "/api/primers"),
    ("DELETE", "/api/primers"),
    # the host's AWS credentials
    ("POST", "/api/s3/configure"), ("GET", "/api/s3/list"), ("GET", "/api/s3/presign"),
    ("GET", "/api/s3/status"), ("GET", "/api/s3/test"),
    # global DAF-C / Micro-C state and linked split-view sessions
    ("POST", "/api/dafc/load"), ("POST", "/api/microc/apa"), ("POST", "/api/microc/precompute_expected"),
    ("GET", "/api/linked/reads/compact"), ("GET", "/api/linked/reads/data"), ("GET", "/api/linked/reads/image"),
    ("POST", "/api/linked/session/create"), ("DELETE", "/api/linked/session/{session_id}"),
    ("GET", "/api/linked/session/{session_id}"), ("POST", "/api/linked/session/{session_id}/send"),
    ("GET", "/api/linked/sessions"),
    # Copilot (the host's LLM, logs and uploads)
    ("POST", "/api/nl/agent_step"), ("GET", "/api/nl/agent_tools"), ("GET", "/api/nl/capabilities"),
    ("POST", "/api/nl/download"), ("GET", "/api/nl/download_status"), ("GET", "/api/nl/doctor"), ("POST", "/api/nl/feedback"),
    ("POST", "/api/nl/log_session"), ("POST", "/api/nl/plan"), ("GET", "/api/nl/probe_backends"),
    ("POST", "/api/nl/set_backend"), ("POST", "/api/nl/setup"), ("POST", "/api/nl/share_clear"),
    ("POST", "/api/nl/share_reveal"), ("POST", "/api/nl/share_send"), ("GET", "/api/nl/share_status"),
    ("GET", "/api/nl/share_upload_status"), ("POST", "/api/nl/stream"),
    # tour-tab sandboxes (local servers only; a tab inside one may see and end
    # itself, see state/sandbox.py SANDBOX_EXTRA_ALLOWED)
    ("POST", "/api/sandbox"), ("GET", "/api/sandbox/{sandbox_id}"), ("DELETE", "/api/sandbox/{sandbox_id}"),
    # independent workspaces (local servers only; state/workspace.py)
    ("POST", "/api/workspaces"), ("GET", "/api/workspaces"), ("GET", "/api/workspaces/{workspace_id}"),
    ("DELETE", "/api/workspaces/{workspace_id}"),
    # lab servers (profile "lab", routers/lab.py): sign-in, admin, the shared
    # session shelf. 404 off the lab profile; anonymous catalog visitors of a
    # lab server reach /auth/* outside the public-mode rules (services/lab/auth.py).
    ("GET", "/auth/login"), ("POST", "/auth/login"), ("POST", "/auth/logout"), ("GET", "/auth/invite"),
    ("POST", "/auth/invite"), ("GET", "/api/auth/me"), ("GET", "/admin"), ("GET", "/api/lab/info"),
    ("GET", "/api/admin/users"), ("POST", "/api/admin/users"), ("DELETE", "/api/admin/users/{name}"),
    ("POST", "/api/admin/users/{name}/reset"), ("POST", "/api/admin/users/{name}/role"),
    ("GET", "/api/admin/audit"), ("GET", "/api/admin/members"),
    ("GET", "/api/lab/sessions"), ("POST", "/api/lab/sessions"), ("GET", "/api/lab/sessions/{session_id}"),
    ("DELETE", "/api/lab/sessions/{session_id}"),
    # New DAF-seq run: host processes on host files (routers/pipeline.py)
    ("GET", "/api/pipeline/status"), ("POST", "/api/pipeline/scan"), ("POST", "/api/pipeline/validate"),
    ("POST", "/api/pipeline/jobs"), ("GET", "/api/pipeline/jobs"), ("GET", "/api/pipeline/jobs/{job_id}"),
    ("GET", "/api/pipeline/jobs/{job_id}/log"), ("POST", "/api/pipeline/jobs/{job_id}/cancel"),
    ("POST", "/api/pipeline/jobs/{job_id}/retry"), ("DELETE", "/api/pipeline/jobs/{job_id}"),
    ("GET", "/api/pipeline/jobs/{job_id}/qc"), ("GET", "/api/pipeline/jobs/{job_id}/files/{name}"),
    ("POST", "/api/qc/dataset"), ("GET", "/api/qc/files/{cache_key}/{name}"),
    # the user's Library: host files, watched folders, the file manager (routers/library.py)
    ("GET", "/api/library"), ("POST", "/api/library/entries"), ("GET", "/api/library/entries/{entry_id}"),
    ("PATCH", "/api/library/entries/{entry_id}"),
    ("POST", "/api/library/entries/remove"), ("POST", "/api/library/entries/{entry_id}/rescan"),
    ("POST", "/api/library/entries/{entry_id}/locate"), ("POST", "/api/library/entries/{entry_id}/reveal"),
    ("GET", "/api/library/entries/{entry_id}/qc"), ("GET", "/api/library/entries/{entry_id}/qc/files/{name}"),
    ("POST", "/api/library/entries/{entry_id}/qc/run"),
    ("POST", "/api/library/entries/{entry_id}/recall"), ("POST", "/api/library/groups"),
    ("PATCH", "/api/library/groups/{group_id}"), ("DELETE", "/api/library/groups/{group_id}"),
    ("POST", "/api/library/catalog"), ("POST", "/api/library/watched"), ("DELETE", "/api/library/watched/{folder_id}"),
    ("POST", "/api/library/scan"), ("GET", "/api/library/scan"),
    ("POST", "/api/library/folder/preview"), ("POST", "/api/library/folder/add"),
    # Connect to cluster: the host's SSH connections and cluster files (routers/remote.py)
    ("GET", "/api/remote/sources"), ("POST", "/api/remote/connect"), ("POST", "/api/remote/disconnect"),
    ("GET", "/api/remote/list"), ("POST", "/api/remote/refs_status"),
    # visitor-chosen URLs: the server would fetch them (tour tabs of a local
    # server keep these, see EXTERNAL_TRACK_ROUTES)
    ("POST", "/api/add_track"),
    ("GET", "/api/ucsc/browse"), ("GET", "/api/ucsc/curated"), ("GET", "/api/ucsc/search"),
    ("GET", "/api/encode/facets"), ("GET", "/api/encode/search"),
    ("GET", "/api/chipatlas/facets"), ("GET", "/api/chipatlas/search"), ("GET", "/api/chipatlas/status"),
    # API docs
    ("GET", "/docs"), ("GET", "/docs/oauth2-redirect"), ("GET", "/openapi.json"), ("GET", "/redoc"),
}

# Jupyter state is one global notebook link, shared by every visitor.
JUPYTER_PREFIX = "/api/jupyter/"


@pytest.fixture
def public(monkeypatch):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    yield


def _routes(app):
    # Flattened through the guard's own walker: on FastAPI >= 0.142
    # ``app.routes`` holds _IncludedRouter branches without a ``path``, which
    # made the classification tests below pass vacuously.
    from services.public_mode_guard import iter_route_entries
    out = set()
    for entry in iter_route_entries(app):
        for method in entry.methods - {"HEAD"}:
            out.add((method, entry.path))
    return out


def test_route_walk_sees_every_included_router(standalone_app):
    routes = _routes(standalone_app)
    assert len(routes) > 100
    assert ("GET", "/api/status") in routes and ("GET", "/api/tracks/{track_idx}") in routes


@pytest.mark.parametrize("method,path,template", [
    ("GET", "/api/status", "/api/status"),
    ("GET", "/api/tracks/3", "/api/tracks/{track_idx}"),
    ("DELETE", "/api/tracks/3", "/api/tracks/{track_idx}"),
    ("HEAD", "/api/status", "/api/status"),  # partial match; the guard reads HEAD as GET
    ("GET", "/assets/index.js", None),
    ("GET", "/api/no_such_route", None),
])
def test_route_template_resolves_router_routes(standalone_app, method, path, template):
    from services.public_mode_guard import route_template
    scope = {"type": "http", "method": method, "path": path, "headers": [], "query_string": b""}
    assert route_template(standalone_app, scope) == template


def test_every_route_is_classified(standalone_app):
    from plugins.packs import pack_router_routes
    from services.public_mode_guard import PUBLIC_ALLOWED
    # A plugin pack's routes are classified by the pack's own tests.
    unclassified = sorted(
        r for r in _routes(standalone_app)
        if r not in PUBLIC_ALLOWED and r not in PUBLIC_DENIED and r not in pack_router_routes()
        and not r[1].startswith(JUPYTER_PREFIX) and not r[1].startswith("/api/plugins/")
        and r[1] not in ("/", "/dafc", "/favicon.ico")
    )
    assert not unclassified, (
        "Routes not classified for --public mode; add each to PUBLIC_ALLOWED "
        f"(services/public_mode_guard.py) or PUBLIC_DENIED (this file): {unclassified}")
    overlap = PUBLIC_ALLOWED & PUBLIC_DENIED
    assert not overlap


def test_allowlist_has_no_stale_entries(standalone_app):
    from services.public_mode_guard import PUBLIC_ALLOWED
    routes = _routes(standalone_app)
    stale = sorted(r for r in PUBLIC_ALLOWED if r not in routes and r[1] not in ("/", "/dafc", "/favicon.ico"))
    assert not stale


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/pick_file"),
    ("POST", "/api/datasets/add"),
    ("POST", "/api/load_folder?path=/etc"),
    ("GET", "/api/diagnose_bam?bam_path=/etc/hosts"),
    ("POST", "/api/load_gtf?path=/etc/hosts"),
    ("DELETE", "/api/gtf"),
    ("GET", "/api/s3/list"),
    ("POST", "/api/nl/setup"),
    ("POST", "/api/new-window"),
    ("GET", "/api/jupyter/state"),
    ("POST", "/api/jupyter/goto"),
    ("GET", "/openapi.json"),
    ("GET", "/docs"),
    ("GET", "/api/no_such_route"),
    ("GET", "/api/lift/difference_sequence?dataset_id=missing&chrom=chrT&item_id=test&pos=0"),
    ("POST", "/api/lift/provenance/missing"),
    ("POST", "/api/lift/analysis/summary"), ("POST", "/api/lift/analysis/split"),
    ("POST", "/api/plugins/anything/run"),
])
def test_public_mode_denies(client, public, method, path):
    resp = client.request(method, path)
    assert resp.status_code == 403
    assert resp.json()["message"] == "This action is disabled on a public FiberBrowser server."


def test_public_mode_allows_browsing_and_catalog(client, public):
    from routers.catalog import set_catalog
    set_catalog(None)
    assert client.get("/api/status").status_code == 200
    assert client.get("/api/datasets").status_code == 200
    resp = client.post("/api/catalog/load?group_index=0")
    assert resp.status_code == 200
    assert resp.json() == {"success": False, "message": "No catalog configured"}


def test_local_mode_is_unaffected(client):
    assert client.get("/openapi.json").status_code == 200


@pytest.mark.parametrize("url", [
    "https://www.encodeproject.org/files/ENCFF1/@@download/ENCFF1.bigWig",  # formerly an allowed host
    "https://hgdownload.soe.ucsc.edu/gbdb/hg38/x.bb",
    "ucsc://hg38/knownGene",
    "https://169.254.169.254/latest/meta-data",
    "/etc/hosts",
])
def test_public_visitors_cannot_add_tracks_by_url(client, public, url):
    """A public server shows its catalog only: no visitor-chosen URL is fetched
    (this replaced an https host allowlist for /api/add_track)."""
    resp = client.post("/api/add_track", params={"path": url})
    assert resp.status_code == 403


@pytest.mark.parametrize("path", [
    "/api/ucsc/search?genome=hg38&q=ctcf", "/api/ucsc/curated?genome=hg38", "/api/ucsc/browse?genome=hg38",
    "/api/encode/search?genome=hg38", "/api/encode/facets?genome=hg38",
    "/api/chipatlas/search?genome=hg38", "/api/chipatlas/facets?genome=hg38", "/api/chipatlas/status",
])
def test_public_visitors_cannot_search_external_track_hosts(client, public, path):
    assert client.get(path).status_code == 403


def test_add_track_route_refuses_on_a_public_host_even_past_the_guard(client, monkeypatch):
    """Defence in depth: the route itself refuses to a public visitor."""
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    import services.public_mode_guard as guard
    monkeypatch.setattr(guard, "public_request_allowed", lambda app, scope: True)
    resp = client.post("/api/add_track", params={"path": "https://www.encodeproject.org/x.bigWig"})
    assert resp.status_code == 403
    assert "public server" in resp.json()["message"]


def test_tour_tabs_keep_the_external_track_host_check():
    from services.public_mode_guard import public_track_url_allowed
    assert public_track_url_allowed("https://www.encodeproject.org/files/ENCFF1/@@download/ENCFF1.bigWig")
    for bad in ("/etc/hosts", "file:///etc/hosts", "http://www.encodeproject.org/x.bw",
                "https://169.254.169.254/latest/meta-data", "https://encodeproject.org.evil.com/x.bw",
                "https://127.0.0.1/x.bw", "https://evil.example/x.bw"):
        assert not public_track_url_allowed(bad), bad


def test_render_is_headless_only_without_session_files(client, public):
    resp = client.post("/api/render", json={"chrom": "chr1", "start": 0, "end": 1000, "engine": "numpy"})
    assert resp.status_code == 403
    resp = client.post("/api/render", json={"session": {"datasets": []}, "load_session": True})
    assert resp.status_code == 403
    resp = client.post("/api/render", json={"session_path": "/etc/hosts"})
    assert resp.status_code == 403


def test_load_genome_only_the_catalog_genome(client, public):
    from routers.catalog import set_catalog
    set_catalog({"genome": "hg38", "groups": []})
    try:
        resp = client.post("/api/load_genome?genome_id=mm10")
        assert resp.status_code == 403
    finally:
        set_catalog(None)


def test_chemistry_is_never_saved_to_the_bam(client, public, monkeypatch):
    import server as srv
    from types import SimpleNamespace
    ds = SimpleNamespace(data_type="bam", paths=["/data/x.bam"], path="/data/x.bam")
    monkeypatch.setattr(srv.state, "datasets", {"ds": ds})
    import services.chemistry_metadata as chem
    monkeypatch.setattr(chem, "save_bam_chemistry", lambda *a, **k: pytest.fail("wrote the BAM"))
    resp = client.post("/api/datasets/ds/chemistry", json={"chemistry": "ddda", "persist": True})
    assert resp.status_code == 200
    assert resp.json()["success"] is False


def test_consensus_ignores_client_cache_dir(client, public, monkeypatch):
    # A public server replaces the whole compute group with its own caps
    # (tests/test_public_limits.py), so no client value, the cache dir
    # included, reaches the run. (Before: only fit_cache_dir was dropped.)
    import services.consensus_workflow as cw
    from services.public_limits import public_consensus_compute
    seen = {}
    monkeypatch.setattr(cw, "submit", lambda state, request: seen.setdefault("request", request) and {"ok": True})
    client.post("/api/footprint/consensus/jobs",
                json={"parameters": {"compute": {"fit_cache_dir": "/etc", "threads": 2}}})
    assert seen["request"]["parameters"]["compute"] == public_consensus_compute()
    assert "fit_cache_dir" not in seen["request"]["parameters"]["compute"]


# --- sessions ---------------------------------------------------------------

def _manager():
    from types import SimpleNamespace
    from state.session_manager import SessionManager
    import state.browser_state as bs

    class FakeState:
        @classmethod
        def fork_for_session(cls, template):
            return SimpleNamespace()
    return SessionManager(template=SimpleNamespace(), enabled=True, max_sessions=3), bs, FakeState


def test_client_cannot_choose_its_session_id(monkeypatch):
    sm, bs, fake = _manager()
    monkeypatch.setattr(bs, "BrowserState", fake)
    _, sid, created = sm.get_or_create("attackerchosen")
    assert created and sid != "attackerchosen"
    again, sid2, created2 = sm.get_or_create(sid)
    assert not created2 and sid2 == sid


def test_full_server_drops_only_idle_sessions_and_never_active_ones(monkeypatch):
    from state.session_manager import SessionsFull
    sm, bs, fake = _manager()
    monkeypatch.setattr(bs, "BrowserState", fake)
    sids = [sm.get_or_create(None)[1] for _ in range(3)]
    # All three active: a cookie-less flood can't push anyone out.
    with pytest.raises(SessionsFull):
        sm.get_or_create(None)
    assert set(sm.sessions) == set(sids)
    sm.last_access[sids[0]] = 0  # idle past the TTL
    sm.get_or_create(None)
    assert len(sm.sessions) == 3 and sids[0] not in sm.sessions and sids[1] in sm.sessions


def test_session_cookie_is_set_and_renewed_even_for_response_objects(client, monkeypatch):
    import server as srv
    from state.session_manager import SessionManager
    from state.runtime_state import set_session_manager, get_session_manager
    previous = get_session_manager()
    sm = SessionManager(template=srv.state, enabled=True, max_sessions=5)
    set_session_manager(sm)
    try:
        first = client.get("/api/chroms")  # returns a Response of its own
        cookie = first.cookies.get("fiberhmm_sid")
        assert cookie and cookie in sm.sessions
        again = client.get("/api/chroms", cookies={"fiberhmm_sid": cookie})
        assert again.cookies.get("fiberhmm_sid") == cookie  # renewed, same session
        assert "Max-Age=1800" in again.headers["set-cookie"]
    finally:
        set_session_manager(previous)


def test_session_tracks_are_copies():
    from state.browser_state import BrowserState
    template = BrowserState(None, None, None, None)
    template.orthogonal_tracks = [{"label": "CTCF", "filter_names": None}]
    session = BrowserState.fork_for_session(template)
    session.orthogonal_tracks[0]["filter_names"] = ["x"]
    assert template.orthogonal_tracks[0]["filter_names"] is None


def test_public_sessions_cannot_replace_the_shared_reference(public):
    from state.browser_state import BrowserState
    from services.runtime import allow_shared_writes
    template = BrowserState(None, None, None, None)
    template.gtf_path = "/genomes/hg38.gtf"
    template.chroms = []
    session = BrowserState.fork_for_session(template)
    with pytest.raises(PermissionError):
        session.gtf_path = "/etc/hosts"
    session.chroms = ["chr1"]  # filling an empty field is fine (first catalog dataset)
    assert template.chroms == ["chr1"]
    with allow_shared_writes():
        session.gtf_path = "/genomes/other.gtf"
    assert template.gtf_path == "/genomes/other.gtf"


# --- other websites (all modes) ------------------------------------------------

def test_cross_site_requests_are_refused(client):
    resp = client.post("/api/load_folder?path=/nonexistent", headers={"Sec-Fetch-Site": "cross-site"})
    assert resp.status_code == 403
    resp = client.get("/api/status", headers={"Origin": "https://evil.example"})
    assert resp.status_code == 403
    assert "access-control-allow-origin" not in resp.headers
    # Same-origin browser requests, Vite's dev proxy and scripts without headers work.
    assert client.get("/api/status", headers={"Sec-Fetch-Site": "same-origin", "Origin": "http://localhost:3000"}).status_code == 200
    assert client.get("/api/status", headers={"Origin": "http://localhost"}).status_code == 200
    assert client.get("/api/status").status_code == 200


def test_other_ports_of_the_same_host_are_other_origins():
    from services.request_origin_guard import request_allowed
    base = {"host": "browser.example.org", "x-forwarded-proto": "https"}
    assert request_allowed({**base, "origin": "https://browser.example.org"}, "/api/catalog/unload") is None
    assert request_allowed({**base, "origin": "https://browser.example.org:8443"}, "/api/catalog/unload")
    assert request_allowed({**base, "origin": "https://browser.example.org:8443", "sec-fetch-site": "same-site"},
                           "/api/catalog/unload")
    assert request_allowed({"host": "localhost:8000", "origin": "http://localhost:3000"}, "/api/status")
    assert request_allowed({"host": "localhost:8000", "origin": "http://localhost:8000"}, "/api/status") is None


def test_public_mode_lets_configured_cors_preflights_through(client, public, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_CORS_ORIGINS", "https://notebook.example.org")
    resp = client.options("/api/status", headers={"Origin": "https://notebook.example.org",
                                                   "Access-Control-Request-Method": "GET"})
    assert resp.status_code != 403
    resp = client.options("/api/status", headers={"Origin": "https://evil.example",
                                                   "Access-Control-Request-Method": "GET"})
    assert resp.status_code == 403


def test_loopback_servers_refuse_rebound_host_names(client):
    from services.request_origin_guard import allowed_hosts_for_bind, set_allowed_hosts
    set_allowed_hosts(allowed_hosts_for_bind("127.0.0.1"))
    try:
        assert client.get("/api/status", headers={"Host": "attacker.example"}).status_code == 403
        assert client.get("/api/status", headers={"Host": "localhost:8000"}).status_code == 200
        assert client.get("/api/status", headers={"Host": "127.0.0.1:8000"}).status_code == 200
        assert client.get("/api/status", headers={"Host": "[::1]:8000"}).status_code == 200
    finally:
        set_allowed_hosts(None)
    assert allowed_hosts_for_bind("0.0.0.0") is None
