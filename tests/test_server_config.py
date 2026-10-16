"""Server configuration files (services/server_config.py) and `fiberbrowser serve/users/audit`."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import pytest

from services.server_config import (ConfigError, apply_to_args, load_config, normalize_root_path,
                                    parse_config, state_environment)

REPO = Path(__file__).resolve().parents[1]


def _args(**kw):
    base = dict(host=None, port=8000, root_path=None, open_browser=None, public=False, catalog=None, gtf=None,
                fasta=None, max_working_reads=0, copilot="auto", public_max_span_bp=None, public_max_reads=None)
    base.update(kw)
    return argparse.Namespace(**base)


def test_minimal_lab_file_parses_with_defaults(tmp_path):
    (tmp_path / "cfg.toml").write_text(
        'profile = "lab"\n[server]\nport = 8123\nroot_path = "/rnode/n1/8123/"\n'
        '[[data.roots]]\npath = "data"\n[[data.roots]]\npath = "runs"\nwritable = true\n'
        '[state]\ndir = "state"\n')
    cfg = load_config(str(tmp_path / "cfg.toml"))
    assert cfg.profile == "lab" and cfg.port == 8123 and cfg.root_path == "/rnode/n1/8123"
    assert [r.path for r in cfg.data_roots] == [str(tmp_path / "data"), str(tmp_path / "runs")]
    assert [r.writable for r in cfg.data_roots] == [False, True]
    assert cfg.state_dir == str(tmp_path / "state")
    # Safe defaults for a server: accounts, jobs off, copilot not on.
    assert cfg.auth.mode == "accounts" and cfg.jobs.enabled is False and cfg.copilot is None
    assert cfg.users_file == str(tmp_path / "state" / "users.json")
    env = state_environment(cfg)
    assert env["FIBERBROWSER_LIBRARY"] == str(tmp_path / "state" / "library.json")
    assert env["FIBERBROWSER_JOBS_DIR"] == str(tmp_path / "state" / "jobs")
    assert env["FIBERBROWSER_UPLOAD_DIR"] == str(tmp_path / "state" / "uploads")


@pytest.mark.parametrize("raw, message", [
    ({"profile": "team"}, "profile must be one of"),
    ({"bogus": 1}, "Unknown top-level key"),
    ({"server": {"prot": 1}}, "Unknown key(s) in [server]"),
    ({"server": {"port": "80"}}, "server.port must be a whole number"),
    ({"server": {"port": 70000}}, "0-65535"),
    ({"server": {"root_path": "https://x/y"}}, "root_path must be a URL path"),
    ({"server": {"root_path": "/a/../b"}}, ". or .."),
    ({"profile": "lab", "state": {"dir": "s"}}, "at least one data root"),
    ({"profile": "lab", "data": {"roots": ["d"]}}, "[state] dir"),
    ({"profile": "lab", "data": {"roots": ["/"]}, "state": {"dir": "s"}}, "too broad"),
    ({"profile": "lab", "data": {"roots": ["d"]}, "state": {"dir": "s"}, "auth": {"mode": "ldap"}}, "auth.mode"),
    ({"profile": "lab", "data": {"roots": ["d"]}, "state": {"dir": "s"},
      "auth": {"trusted_proxies": ["proxy.example.org"]}}, "not an IP address"),
    ({"profile": "lab", "data": {"roots": ["d"]}, "state": {"dir": "s"}, "jobs": {"enabled": True}},
     "writable data root"),
    ({"profile": "lab", "data": {"roots": ["d"]}, "state": {"dir": "s"}, "public_catalog": {"enabled": True}},
     "needs a catalog"),
    ({"profile": "personal", "state": {"dir": "s"}}, "only apply to profile"),
    ({"profile": "public", "data": {"roots": ["d"]}}, "catalog only"),
    ({"profile": "lab", "data": {"roots": [{"path": "d", "mode": "rw"}]}, "state": {"dir": "s"}}, "unknown key"),
])
def test_invalid_files_name_the_problem(tmp_path, raw, message):
    with pytest.raises(ConfigError) as exc:
        parse_config(raw, base_dir=str(tmp_path))
    assert message in str(exc.value)


def test_invalid_toml_and_missing_files(tmp_path):
    (tmp_path / "bad.toml").write_text("profile = ")
    with pytest.raises(ConfigError, match="not valid TOML"):
        load_config(str(tmp_path / "bad.toml"))
    with pytest.raises(ConfigError, match="not found"):
        load_config(str(tmp_path / "missing.toml"))


def test_root_path_normalisation():
    assert normalize_root_path("") == "" and normalize_root_path("/") == ""
    assert normalize_root_path("rnode/h/1//") == "/rnode/h/1"


def test_command_line_flags_win_over_the_file(tmp_path):
    cfg = parse_config({"profile": "lab", "server": {"host": "0.0.0.0", "port": 9000, "root_path": "/x"},
                        "data": {"roots": ["d"]}, "state": {"dir": "s"}}, base_dir=str(tmp_path))
    args = _args(port=8123)
    apply_to_args(cfg, args, ["--port", "8123"])
    assert args.port == 8123 and args.host == "0.0.0.0" and args.root_path == "/x"
    # Servers: no browser window and no Copilot unless the file asks.
    assert args.open_browser is False and args.copilot == "off"


def test_public_profile_routes_through_the_existing_public_mode(tmp_path):
    cfg = parse_config({"profile": "public", "data": {"catalog": "catalog.json"},
                        "limits": {"max_span_bp": 5000}}, base_dir=str(tmp_path))
    args = _args()
    apply_to_args(cfg, args, [])
    assert args.public is True and args.catalog == str(tmp_path / "catalog.json")
    assert args.public_max_span_bp == 5000 and args.copilot == "off"


def test_personal_profile_keeps_todays_defaults(tmp_path):
    cfg = parse_config({"server": {"port": 8001}}, base_dir=str(tmp_path))
    args = _args()
    apply_to_args(cfg, args, [])
    assert args.port == 8001 and args.public is False and args.copilot == "auto" and args.open_browser is None
    assert state_environment(cfg) == {}


def test_lab_profile_refuses_the_public_flag(tmp_path):
    cfg = parse_config({"profile": "lab", "data": {"roots": ["d"]}, "state": {"dir": "s"}}, base_dir=str(tmp_path))
    with pytest.raises(ConfigError, match="conflicts"):
        apply_to_args(cfg, _args(public=True), ["--public"])


@pytest.mark.parametrize("name", ["fiberbrowser-server.example.toml", "lab-docker.toml"])
def test_the_example_configs_are_valid(name):
    cfg = load_config(str(REPO / "deploy" / "lab" / name))
    assert cfg.profile == "lab" and cfg.jobs.enabled is False and cfg.data_roots
    assert cfg.auth.mode == "accounts" and cfg.copilot in (None, False)


def test_jobs_dir_can_be_one_per_machine(tmp_path):
    cfg = parse_config({"profile": "lab", "data": {"roots": ["d"]}, "state": {"dir": "s"},
                        "jobs": {"dir": "s/jobs/node7"}}, base_dir=str(tmp_path))
    assert state_environment(cfg)["FIBERBROWSER_JOBS_DIR"] == str(tmp_path / "s" / "jobs" / "node7")


def _cli(*argv, **kw):
    return subprocess.run([sys.executable, "-m", "fiberbrowser", *argv], cwd=str(REPO), capture_output=True,
                          text=True, timeout=120, **kw)


def test_users_cli_invites_lists_resets_and_audits(tmp_path):
    (tmp_path / "data").mkdir()
    cfg = tmp_path / "server.toml"
    cfg.write_text(f'profile = "lab"\n[[data.roots]]\npath = "{tmp_path / "data"}"\n[state]\ndir = "{tmp_path / "state"}"\n')
    added = _cli("users", "invite", "Alice", "--role", "admin", "--config", str(cfg))
    assert added.returncode == 0, added.stderr
    assert "One-time invite code for alice" in added.stdout
    with_password = _cli("users", "add", "bob", "--password-stdin", "--config", str(cfg), input="a long password\n")
    assert with_password.returncode == 0, with_password.stderr
    listing = _cli("users", "list", "--config", str(cfg))
    assert "alice" in listing.stdout and "invited" in listing.stdout and "bob" in listing.stdout
    assert "active" in listing.stdout
    weak = _cli("users", "add", "carol", "--password-stdin", "--config", str(cfg), input="short\n")
    assert weak.returncode == 1 and "at least 10" in weak.stderr
    users = json.loads((tmp_path / "state" / "users.json").read_text())
    assert "scrypt$" in users["users"]["bob"]["password"] and "a long password" not in json.dumps(users)
    assert (tmp_path / "state" / "users.json").stat().st_mode & 0o077 == 0
    assert _cli("users", "remove", "bob", "--config", str(cfg)).returncode == 0
    audit = _cli("audit", "--json", "--config", str(cfg))
    events = [json.loads(line)["event"] for line in audit.stdout.splitlines()]
    assert events.count("admin_user_add") == 2 and "admin_user_remove" in events
    assert "a long password" not in (tmp_path / "state" / "audit.log").read_text()


def test_check_config_and_serve_help(tmp_path):
    (tmp_path / "data").mkdir()
    cfg = tmp_path / "server.toml"
    cfg.write_text(f'profile = "lab"\n[[data.roots]]\npath = "{tmp_path / "data"}"\n[state]\ndir = "{tmp_path / "state"}"\n')
    checked = _cli("check-config", str(cfg))
    assert checked.returncode == 0 and "profile lab" in checked.stdout and "no accounts yet" in checked.stdout
    bad = tmp_path / "bad.toml"
    bad.write_text('profile = "lab"\n')
    refused = _cli("check-config", str(bad))
    assert refused.returncode != 0 and "data root" in (refused.stderr + refused.stdout)
