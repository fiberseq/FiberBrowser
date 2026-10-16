"""The pip package (pyproject.toml + fiberbrowser/) ships a working browser.

The backend imports its folders (services, routers, ...) as top-level names, so
the wheel mirrors the repository root under fiberbrowser/; these tests keep the
wheel's file list, dependencies and version in step with the tree.
"""
import os
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))  # after browser/: its `plugins` package must win


def _toml():
    try:
        import tomllib
    except ImportError:  # Python 3.10
        try:
            import tomli as tomllib
        except ImportError:
            tomllib = pytest.importorskip("pip._vendor.tomli")
    return tomllib.loads((ROOT / "pyproject.toml").read_text())


def _requirement_lines():
    lines = (ROOT / "requirements.txt").read_text().splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def test_dependencies_match_requirements_txt():
    project = _toml()["project"]
    # Python-version markers (tomli on 3.10) are core dependencies; platform
    # markers are the Copilot runtime.
    def norm(r):
        return r.replace(" ", "").replace("'", '"')
    core = [r for r in _requirement_lines() if ";" not in r or "python_version" in r]
    gated = [r for r in _requirement_lines() if ";" in r and "python_version" not in r]
    assert [norm(r) for r in project["dependencies"]] == [norm(r) for r in core]
    assert "fiberhmm[consensus]>=3.0,<4" in project["dependencies"]
    # requirements.txt installs the Apple-silicon Copilot runtime by marker; the
    # pip package offers it as the [copilot] extra with the same markers.
    assert [r.replace(" ", "") for r in project["optional-dependencies"]["copilot"]] == \
        [r.replace(" ", "") for r in gated]
    assert project["requires-python"] == ">=3.10"


def test_version_comes_from_browser_version_py():
    config = _toml()
    assert "version" in config["project"]["dynamic"]
    assert config["tool"]["hatch"]["version"]["path"] == "browser/version.py"
    import fiberbrowser
    from version import __version__
    assert fiberbrowser.__version__ == __version__


def test_entry_points():
    project = _toml()["project"]
    assert project["scripts"] == {"fiberbrowser": "fiberbrowser.cli:main"}
    assert project["gui-scripts"] == {"fiberbrowser-app": "fiberbrowser.cli:app_main"}
    assert project["optional-dependencies"]["app"] == ["pywebview>=5.0"]


def test_wheel_includes_every_backend_folder_under_fiberbrowser():
    wheel = _toml()["tool"]["hatch"]["build"]["targets"]["wheel"]
    included = wheel["force-include"]
    # Nothing but fiberbrowser/ (and the browser_client alias) at the top level.
    assert wheel["only-include"] == ["fiberbrowser"]
    assert {dst.split("/", 1)[0] for dst in included.values()} == {"fiberbrowser", "browser_client.py"}
    for src, dst in included.items():
        assert (ROOT / src).exists(), src
        if dst != "browser_client.py":
            assert dst == f"fiberbrowser/{src}" or src.startswith("packaging/"), (src, dst)
    # Every backend module and folder is shipped (a new one must be added here).
    for entry in sorted((ROOT / "browser").iterdir()):
        if entry.name in ("frontend", "__pycache__", "uploads") or entry.name.startswith("."):
            continue
        if entry.is_dir() or entry.suffix == ".py":
            assert f"browser/{entry.name}" in included, f"browser/{entry.name} is not in the wheel"
    for needed in ("browser.py", "browser_client.py", "browser/frontend/dist", "browser/data",
                   "browser/frontend/src/data", "data/copilot_dataset/models.json", "plugins"):
        assert needed in included, needed


def test_app_root_is_the_checkout():
    from fiberbrowser._paths import app_root, browser_script
    assert app_root() == ROOT
    assert browser_script() == ROOT / "browser.py"


def test_version_flag(capsys):
    from fiberbrowser.cli import main
    assert main(["--version"]) == 0
    from version import __version__
    assert capsys.readouterr().out.strip() == f"FiberBrowser {__version__}"


def test_launcher_flags_are_dispatched(monkeypatch):
    import fiberbrowser.cli as cli
    import fiberbrowser.desktop as desktop
    import fiberbrowser.shortcut as shortcut
    calls = []
    monkeypatch.setattr(desktop, "main", lambda argv: calls.append(("app", list(argv))) or 0)
    monkeypatch.setattr(shortcut, "main", lambda argv: calls.append(("shortcut", list(argv))) or 0)
    monkeypatch.setattr(cli, "run_server", lambda argv: calls.append(("server", list(argv))) or 0)
    cli.main(["--app", "-b", "x.bam"])
    cli.main(["--install-shortcut"])
    cli.main(["-p", "9000"])
    assert calls == [("app", ["-b", "x.bam"]), ("shortcut", ["--install-shortcut"]), ("server", ["-p", "9000"])]


def test_server_parser_accepts_the_launcher_flags(monkeypatch):
    from services.cli_args import build_arg_parser
    args = build_arg_parser().parse_args(["--app", "--install-shortcut"])
    assert args.app and args.install_shortcut
    monkeypatch.setenv("FIBERBROWSER_PROG", "fiberbrowser")
    assert build_arg_parser().prog == "fiberbrowser"


def test_helper_programs_are_put_on_path(monkeypatch, tmp_path):
    """fiberhmm-* console scripts sit beside this Python, often not on PATH."""
    import fiberbrowser.cli as cli
    scripts = tmp_path / "bin"
    scripts.mkdir()
    monkeypatch.setattr(cli, "helper_program_dirs", lambda: [str(scripts)])
    env = {"PATH": "/usr/bin:/bin"}
    cli.prepare_process_environment(env)
    assert env["PATH"].split(os.pathsep)[0] == str(scripts)
    assert env["OPENBLAS_NUM_THREADS"] == "1"
    cli.prepare_process_environment(env)  # idempotent
    assert env["PATH"].split(os.pathsep).count(str(scripts)) == 1


def test_server_output_is_line_buffered_when_redirected(monkeypatch):
    """`fiberbrowser ... > log &` logs the access link before the server is stopped."""
    import io
    import runpy
    import fiberbrowser.cli as cli
    out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")  # a file: block-buffered
    err = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
    assert not out.line_buffering
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)
    monkeypatch.setattr(sys, "argv", list(sys.argv))
    # run_server also installs crash hooks (log_crashes): restore them afterwards.
    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    monkeypatch.setattr(threading, "excepthook", threading.excepthook)
    monkeypatch.setattr(cli, "prepare_process_environment", lambda: {})
    monkeypatch.setattr(cli, "watch_parent_process", lambda: None)
    monkeypatch.setattr(runpy, "run_path", lambda *a, **k: None)
    assert cli.run_server(["--no-open-browser"]) == 0
    assert out.line_buffering and err.line_buffering


def test_browser_client_alias_module():
    shim = (ROOT / "packaging" / "python" / "browser_client_shim.py").read_text()
    assert 'import_module("fiberbrowser.browser_client")' in shim


def test_the_frontend_pages_are_not_executable():
    """dist/index.html was committed 100755 (3.0.0 audit LOW-5): the build rewrites it in place and keeps the mode
    of the source index.html it came from, so neither may be executable."""
    import stat
    root = Path(__file__).resolve().parents[1] / "browser" / "frontend"
    for page in (root / "index.html", root / "dist" / "index.html"):
        if page.exists():
            assert not page.stat().st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH), page
