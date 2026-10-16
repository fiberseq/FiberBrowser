"""Closing one browser tab must not stop the server while others are open."""
import routers.utility as utility


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


def test_quit_is_not_available_to_the_copilot():
    from services.natural_language_commands import is_copilot_api_call_allowed
    assert is_copilot_api_call_allowed("POST", "/api/quit")[0] is False
