from argparse import Namespace
from threading import Event

from services import server_startup


def test_optional_dependency_hint_uses_pip_package_name(monkeypatch, capsys):
    def fake_find_spec(module_name):
        if module_name == "primer3":
            return None
        return object()

    monkeypatch.setattr(server_startup, "find_spec", fake_find_spec)
    monkeypatch.setattr(server_startup.shutil, "which", lambda tool: "/usr/bin/tool")

    server_startup._check_optional_deps()

    out = capsys.readouterr().out
    assert "primer3-py" in out
    assert "pip install primer3-py" in out
    assert "pip install primer3 " not in out


def test_should_open_browser_defaults_to_local_non_public_launch():
    args = Namespace(open_browser=None, public=False)

    assert server_startup.should_open_browser(args, {}) is True


def test_should_open_browser_honors_cli_and_env_overrides():
    assert server_startup.should_open_browser(Namespace(open_browser=False, public=False), {}) is False
    assert server_startup.should_open_browser(Namespace(open_browser=True, public=True), {}) is True

    args = Namespace(open_browser=None, public=False)
    assert server_startup.should_open_browser(args, {"FIBERBROWSER_NO_OPEN": "1"}) is False
    assert server_startup.should_open_browser(args, {"FIBERBROWSER_HEADLESS": "true"}) is False
    assert server_startup.should_open_browser(args, {"CI": "true"}) is False
    assert server_startup.should_open_browser(args, {"FIBERBROWSER_OPEN_BROWSER": "0"}) is False
    assert server_startup.should_open_browser(args, {"FIBERBROWSER_OPEN_BROWSER": "1", "CI": "true"}) is True


def test_should_open_browser_skips_public_by_default():
    args = Namespace(open_browser=None, public=True)

    assert server_startup.should_open_browser(args, {}) is False


def test_schedule_browser_open_uses_delayed_opener():
    opened = Event()
    calls = []

    def fake_open(url, new):
        calls.append((url, new))
        opened.set()

    timer = server_startup.schedule_browser_open("http://localhost:8765", delay_s=0, opener=fake_open)

    try:
        assert opened.wait(1)
        assert calls == [("http://localhost:8765", 2)]
    finally:
        timer.cancel()


def test_busy_port_never_signals_another_process(monkeypatch):
    import pytest
    monkeypatch.delenv("FIBERBROWSER_PORT_MIN", raising=False)
    monkeypatch.delenv("FIBERBROWSER_PORT_MAX", raising=False)
    monkeypatch.setattr(server_startup.os, "kill", lambda *args: pytest.fail("signalled a foreign process"))
    monkeypatch.setattr("builtins.input", lambda *args: pytest.fail("prompted to take over a foreign process"))
    probes = []
    def probe(port, host):
        probes.append((port, host))
        return {8881: 5735, 8882: -1}.get(port)
    monkeypatch.setattr(server_startup, "_check_port_in_use", probe)
    for force in (False, True):
        assert server_startup._resolve_port(8881, force_port=force) == 8883
    assert probes == [(p, "127.0.0.1") for p in (8881, 8882, 8883)] * 2


def test_port_fallback_stays_within_the_allowed_range(monkeypatch):
    import pytest
    monkeypatch.setenv("FIBERBROWSER_PORT_MIN", "8880")
    monkeypatch.setenv("FIBERBROWSER_PORT_MAX", "8889")
    monkeypatch.setattr(server_startup, "_check_port_in_use", lambda port, host: None if port == 8880 else 5735)
    assert server_startup._resolve_port(8889) == 8880
    monkeypatch.setattr(server_startup, "_check_port_in_use", lambda port, host: 5735)
    with pytest.raises(SystemExit, match="1"):
        server_startup._resolve_port(8889)
