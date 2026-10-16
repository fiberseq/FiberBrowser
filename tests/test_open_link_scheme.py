"""fiberbrowser://open?... links (fiberbrowser.open_link, the app's handler, Info.plist).

The Apple-event delivery itself needs a built, installed app (check_app.sh);
these cover parsing, staging on a running server and the app's queueing.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from fiberbrowser import desktop, open_link  # noqa: E402


def test_parse_open_urls():
    assert open_link.parse_open_url("fiberbrowser://open?session=https%3A%2F%2Fh.example.org%2Fs.json") == \
        {"session": "https://h.example.org/s.json"}
    assert open_link.parse_open_url("FIBERBROWSER://open?hub=https://h.example.org/hub.txt&genome=hg38") == \
        {"hub": "https://h.example.org/hub.txt", "genome": "hg38"}
    assert open_link.parse_open_url("fiberbrowser:open?sessionURL=https://h.example.org/s.json") == \
        {"session": "https://h.example.org/s.json"}
    for bad in ("https://h.example.org/?session=x", "fiberbrowser://quit", "fiberbrowser://open?x=1",
                "fiberbrowser://open?session=" + "a" * (open_link.MAX_LINK_CHARS + 1)):
        with pytest.raises(open_link.OpenLinkError):
            open_link.parse_open_url(bad)


@pytest.fixture
def live_server(standalone_app, tmp_path, monkeypatch):
    """The test app on a real port, listed in a scratch runtime file."""
    import os
    import threading
    import time

    import uvicorn
    from services import local_auth, session_links

    session_links.clear_pending()
    from port_list import free_test_port
    config = uvicorn.Config(standalone_app, host="127.0.0.1", port=free_test_port(), log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    runtime = tmp_path / "browser_runtime.json"
    runtime.write_text(json.dumps({"servers": {str(port): {
        "url": f"http://127.0.0.1:{port}", "token": local_auth.get_token(), "pid": os.getpid(), "started": 1}}}))
    monkeypatch.setenv("FIBERBROWSER_RUNTIME_FILE", str(runtime))
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(5)
    session_links.clear_pending()


def test_forward_stages_on_the_running_server_and_opens_the_confirmation(live_server):
    from services import session_links
    opened = []
    page = open_link.forward("fiberbrowser://open?session=https%3A%2F%2Fh.example.org%2Fs.json",
                             open_page=opened.append, start=lambda: pytest.fail("a server is running"))
    assert opened == [page] and page.startswith(live_server + "/?open_link=") and "token=" in page
    link_id = re.search(r"open_link=([^&]+)", page).group(1)
    pending = session_links.get_pending(link_id)
    # Staged only: nothing fetched, nothing previewed, nothing opened.
    assert pending.raw == "https://h.example.org/s.json" and pending.session is None and pending.origin == "app"


def test_forward_reports_refusals(live_server, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LINKS_DISABLE", "1")
    with pytest.raises(open_link.OpenLinkError, match="turned off"):
        open_link.forward("fiberbrowser://open?session=https://h.example.org/s.json", open_page=lambda url: None)


def test_forward_starts_a_server_when_none_runs(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_RUNTIME_FILE", str(tmp_path / "none.json"))
    started, staged = [], []
    server = {"url": "http://127.0.0.1:9", "token": "T"}
    monkeypatch.setattr(open_link, "stage_on_server", lambda s, link: staged.append((s, link)) or "id123456789")
    page = open_link.forward("fiberbrowser://open?hub=https://h.example.org/hub.txt",
                             open_page=lambda url: None, start=lambda: started.append(1) or server)
    assert started == [1] and staged == [(server, {"hub": "https://h.example.org/hub.txt"})]
    assert page == "http://127.0.0.1:9/?open_link=id123456789&token=T"


def test_the_app_queues_links_until_its_server_is_ready(monkeypatch):
    app = desktop.DesktopApp(["fiberbrowser://open?session=https://h.example.org/s.json"], port=8756)
    assert app.link_args and "fiberbrowser://" not in " ".join(app.server_args)
    windows = []
    monkeypatch.setattr(app, "create_window", lambda url=None, title="", html=None: windows.append((url, title, html)))
    monkeypatch.setattr(open_link, "stage_on_server", lambda server, link: "pendingid12345")
    assert app.handle_open_url("fiberbrowser://open?session=https://h.example.org/s.json") is None
    assert windows == []  # queued: the server isn't ready
    app._ready = True
    app._flush_links()
    assert windows == [(f"http://127.0.0.1:8756/?open_link=pendingid12345&token={app.token}",
                        "FiberBrowser: open link", None)]
    windows.clear()
    app.handle_open_url("fiberbrowser://quit")
    assert windows and windows[0][0] is None and "Unknown fiberbrowser" in windows[0][2]


def test_the_mac_app_registers_the_scheme():
    spec = (ROOT / "packaging" / "macos" / "FiberBrowser.spec").read_text()
    assert '"CFBundleURLTypes"' in spec and '"CFBundleURLSchemes": ["fiberbrowser"]' in spec


def test_the_cli_routes_open_link(monkeypatch):
    from fiberbrowser import cli
    calls = []
    monkeypatch.setattr(open_link, "main", lambda argv: calls.append(argv) or 0)
    assert cli.main(["--open-link", "fiberbrowser://open?session=https://h.example.org/s.json"]) == 0
    assert calls == [["fiberbrowser://open?session=https://h.example.org/s.json"]]
