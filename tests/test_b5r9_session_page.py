"""B5 round 9: the page load establishes the public session before API calls."""
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from services.frontend_mount import mount_frontend
from state.dependencies import get_state, install_session_cookie_middleware
from state.runtime_state import get_session_manager, set_session_manager
from state.session_manager import SessionManager


def test_page_load_establishes_the_session_before_api_requests(tmp_path, monkeypatch):
    """In session mode the HTML response carries the session cookie, so the
    app's first concurrent API calls share one session instead of each minting
    their own (the last Set-Cookie used to switch the visitor)."""
    import state.browser_state as bs

    script_dir = tmp_path / "browser"
    dist = script_dir / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body>app</body></html>")

    class Template:
        pass

    monkeypatch.setattr(bs.BrowserState, "fork_for_session", classmethod(lambda cls, template: Template()))
    sm = SessionManager(Template(), enabled=True)
    previous = get_session_manager()
    set_session_manager(sm)
    try:
        app = FastAPI()
        install_session_cookie_middleware(app)
        mount_frontend(app, str(script_dir), public_mode=True)

        @app.get("/api/whoami")
        def whoami(state=Depends(get_state)):
            return {"state": id(state)}

        client = TestClient(app)
        page = client.get("/")
        assert page.status_code == 200
        sid = page.cookies.get("fiberhmm_sid")
        assert sid and sid in sm.sessions
        # The first API calls reuse the page's session; no new one is minted.
        first = client.get("/api/whoami").json()["state"]
        second = client.get("/api/whoami").json()["state"]
        assert first == second == id(sm.sessions[sid])
        assert len(sm.sessions) == 1
    finally:
        set_session_manager(previous)


def test_page_load_without_sessions_sets_no_cookie(tmp_path):
    script_dir = tmp_path / "browser"
    dist = script_dir / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body>app</body></html>")
    previous = get_session_manager()
    set_session_manager(SessionManager(object(), enabled=False))
    try:
        app = FastAPI()
        install_session_cookie_middleware(app)
        mount_frontend(app, str(script_dir), public_mode=False)
        page = TestClient(app).get("/")
        assert page.status_code == 200
        assert "fiberhmm_sid" not in page.cookies
    finally:
        set_session_manager(previous)
