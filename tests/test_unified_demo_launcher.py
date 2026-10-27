"""scripts/unified_demo.py: where the graph helper comes from when --graph-helper isn't given."""
import importlib.util
import os
import stat
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def launcher():
    spec = importlib.util.spec_from_file_location("unified_demo_under_test", ROOT / "scripts" / "unified_demo.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _exe(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_explicit_flag_wins(launcher, tmp_path):
    flag = _exe(tmp_path / "flag-helper")
    env = {"FIBERBROWSER_GRAPH_HELPER": str(_exe(tmp_path / "env-helper")), "PATH": str(tmp_path)}
    assert launcher.find_graph_helper(str(flag), env) == (str(flag), "--graph-helper")


def test_environment_variable_used_without_flag(launcher, tmp_path):
    helper = _exe(tmp_path / "env-helper")
    assert launcher.find_graph_helper(None, {"FIBERBROWSER_GRAPH_HELPER": str(helper), "PATH": ""}) == (
        str(helper), "FIBERBROWSER_GRAPH_HELPER")


def test_helper_on_path_used_without_flag_or_variable(launcher, tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    helper = _exe(bindir / "fiberbrowser-graph")
    assert launcher.find_graph_helper(None, {"PATH": str(bindir)}) == (str(helper), "PATH")


def test_nothing_found_leaves_the_server_to_search(launcher, tmp_path):
    assert launcher.find_graph_helper(None, {"PATH": str(tmp_path)}) == (None, None)


def test_found_helper_reaches_the_server_environment(launcher, tmp_path, monkeypatch):
    """The server's environment drops inherited FIBERBROWSER_* variables, so the helper found in the launcher's own
    environment must be passed on explicitly (before this, a set FIBERBROWSER_GRAPH_HELPER was thrown away)."""
    helper = _exe(tmp_path / "env-helper")
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    mapfile = tmp_path / "map.chain"
    mapfile.write_text("")
    bam = tmp_path / "a.bam"
    bam.write_text("")
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", str(helper))
    a = launcher.parse_args(["--sample", "S", str(bam), "--map", str(mapfile), "--graph-package", str(pkg),
                             "--fasta", str(tmp_path / "none.fa"), "--home", str(tmp_path / "home")])
    launcher.check_inputs(a)
    a.home = str(tmp_path / "home")
    env = launcher.server_env(a)
    assert env["FIBERBROWSER_GRAPH_HELPER"] == str(helper)
    assert a.graph_helper_source == "FIBERBROWSER_GRAPH_HELPER"
