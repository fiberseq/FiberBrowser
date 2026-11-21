"""Closing one browser tab must not stop the server while others are open."""
import pytest

import routers.utility as utility


@pytest.fixture(autouse=True)
def _restore_tab_lifecycle():
    """Each test leaves the tab lifecycle globals (incl. the last close time) as it found them."""
    saved = (dict(utility._tab_last_seen), set(utility._closed_tabs), utility._last_tab_closed)
    yield
    task = utility._pending_shutdown_task
    if task is not None:
        task.cancel()
    utility._pending_shutdown_task = None
    utility._tab_last_seen.clear(); utility._tab_last_seen.update(saved[0])
    utility._closed_tabs.clear(); utility._closed_tabs.update(saved[1])
    utility._last_tab_closed = saved[2]


def test_closing_one_tab_keeps_the_server_up_while_another_checks_in(client):
    utility._tab_last_seen.clear()
    assert client.post("/api/tabs/heartbeat", params={"tab": "a"}).status_code == 200
    assert client.post("/api/tabs/heartbeat", params={"tab": "b"}).status_code == 200

    reply = client.post("/api/shutdown", params={"tab": "a"}).json()
    assert "other tab" in reply["message"]
    assert "a" not in utility._tab_last_seen
    # A report from the closed page arriving late does not bring it back.
    assert client.post("/api/tabs/heartbeat", params={"tab": "a"}).json()["ok"] is False
    assert "a" not in utility._tab_last_seen
    task = utility._pending_shutdown_task
    if task is not None:
        task.cancel()
    utility._pending_shutdown_task = None
    utility._tab_last_seen.clear()
    utility._closed_tabs.clear()


def test_a_reload_never_lands_between_the_close_and_the_next_page(client):
    """A check between a reloading page's close report and the new page's first report must not stop the server."""
    utility._tab_last_seen.clear()
    assert client.post("/api/tabs/heartbeat", params={"tab": "page-1"}).status_code == 200
    client.post("/api/shutdown", params={"tab": "page-1"})          # the reload's close report
    closed = utility._last_tab_closed
    assert utility._should_shut_down(closed + 1) is False           # the next page has not reported in yet
    assert utility._should_shut_down(closed + utility.SHUTDOWN_CHECK_S - 0.5) is False
    utility._tab_last_seen["page-2"] = closed + 2                    # the reloaded page reports in
    assert utility._should_shut_down(closed + utility.SHUTDOWN_CHECK_S + 5) is False
    utility._tab_last_seen.clear()                                   # the last tab really closed
    assert utility._should_shut_down(closed + utility.SHUTDOWN_CHECK_S) is True
    task = utility._pending_shutdown_task
    if task is not None:
        task.cancel()
    utility._pending_shutdown_task = None
    utility._closed_tabs.clear()


def test_quit_is_not_available_to_the_copilot():
    from services.natural_language_commands import is_copilot_api_call_allowed
    assert is_copilot_api_call_allowed("POST", "/api/quit")[0] is False


def test_keep_running_never_stops_the_server_when_the_last_tab_closes(client, monkeypatch):
    """A shared test server (FIBERBROWSER_KEEP_RUNNING): a script's tab closing never stops it."""
    monkeypatch.setenv("FIBERBROWSER_KEEP_RUNNING", "1")
    utility._tab_last_seen.clear()
    utility._pending_shutdown_task = None
    assert client.post("/api/tabs/heartbeat", params={"tab": "script"}).status_code == 200
    reply = client.post("/api/shutdown", params={"tab": "script"}).json()
    assert "staying up" in reply["message"]
    assert utility._pending_shutdown_task is None
    assert utility._should_shut_down(utility._last_tab_closed + utility.SHUTDOWN_CHECK_S + 1) is False
    monkeypatch.delenv("FIBERBROWSER_KEEP_RUNNING")
    assert utility._should_shut_down(utility._last_tab_closed + utility.SHUTDOWN_CHECK_S + 1) is True
    utility._tab_last_seen.clear()
    utility._closed_tabs.clear()
