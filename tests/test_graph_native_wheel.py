"""The fiberbrowser-graph-native companion wheel (packaging/graph-native/build_wheel.py) and FiberBrowser finding it.

A stub helper that answers the framed handshake stands in for the native binary: the wheel is built, its RECORD
and file modes checked, then installed into a fresh virtual environment, where ``helper_path()`` and the
``fiberbrowser-graph`` console script run it and FiberBrowser's resolver (services/graph_panel/helper.py) reports it
as the companion helper. Uninstalled, the resolver reports "unavailable" with the install hint. With
FIBERBROWSER_TEST_GRAPH_HELPER the same is done with the real helper and the macOS platform tag read from it.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
import subprocess
import sys
import venv
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "packaging" / "graph-native" / "build_wheel.py"
REAL_HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()

STUB = r'''#!{python}
import json, struct, sys
if sys.argv[1:] == ["handshake"]:
    d = json.dumps({{"protocol": 1, "type": "ready", "job_id": "startup", "generation": 0,
                    "revisions": {{"package": "", "graph": "", "db": "", "maps": ""}},
                    "handshake": {{"producer": "fiberbrowser-graph 9.8.7", "build_target": "stub-target",
                                  "toolchain": "stub", "db_schemas": ["GBZ-base version 4"], "package_schemas": [1],
                                  "map_schemas": [2]}}}}).encode()
    sys.stdout.buffer.write(struct.pack(">I", len(d)) + d)
else:
    sys.exit(2)
'''


@pytest.fixture
def stub_helper(tmp_path):
    path = tmp_path / "fiberbrowser-graph"
    path.write_text(STUB.format(python=sys.executable))
    path.chmod(0o755)
    return path


def build(helper: Path, out: Path, *extra: str) -> Path:
    proc = subprocess.run([sys.executable, str(BUILDER), "--helper", str(helper), "--out", str(out), *extra],
                          capture_output=True, text=True, check=True)
    return Path(proc.stdout.strip().splitlines()[-1])


def check_record(wheel: Path) -> zipfile.ZipFile:
    zf = zipfile.ZipFile(wheel)
    names = zf.namelist()
    record_name = next(n for n in names if n.endswith(".dist-info/RECORD"))
    rows = list(csv.reader(io.StringIO(zf.read(record_name).decode())))
    listed = {r[0] for r in rows}
    assert listed == set(names)
    for name, digest, size in rows:
        if name == record_name:
            assert digest == "" and size == ""
            continue
        data = zf.read(name)
        expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        assert digest == f"sha256={expected}" and int(size) == len(data)
    return zf


def test_wheel_layout_and_metadata(stub_helper, tmp_path):
    wheel = build(stub_helper, tmp_path / "dist", "--plat-tag", "macosx_11_0_arm64")
    assert wheel.name == "fiberbrowser_graph_native-9.8.7-py3-none-macosx_11_0_arm64.whl"
    zf = check_record(wheel)
    info = zf.getinfo("fiberbrowser_graph_native/bin/fiberbrowser-graph")
    assert (info.external_attr >> 16) & 0o777 == 0o755
    wheel_meta = zf.read("fiberbrowser_graph_native-9.8.7.dist-info/WHEEL").decode()
    assert "Root-Is-Purelib: false" in wheel_meta and "Tag: py3-none-macosx_11_0_arm64" in wheel_meta
    assert "fiberbrowser-graph = fiberbrowser_graph_native:main" in zf.read("fiberbrowser_graph_native-9.8.7.dist-info/entry_points.txt").decode()
    init = zf.read("fiberbrowser_graph_native/__init__.py").decode()
    assert '__version__ = "9.8.7"' in init
    assert json.loads(zf.read("fiberbrowser_graph_native/build_info.json"))["build_target"] == "stub-target"


def test_the_builder_refuses_a_helper_with_other_schemas(tmp_path):
    bad = tmp_path / "fiberbrowser-graph"
    bad.write_text(STUB.format(python=sys.executable).replace("GBZ-base version 4", "GBZ-base version 3"))
    bad.chmod(0o755)
    proc = subprocess.run([sys.executable, str(BUILDER), "--helper", str(bad), "--out", str(tmp_path), "--plat-tag", "x"],
                          capture_output=True, text=True)
    assert proc.returncode != 0 and "schemas" in proc.stderr
    proc = subprocess.run([sys.executable, str(BUILDER), "--helper", str(bad), "--out", str(tmp_path), "--plat-tag", "x",
                           "--require-notices"], capture_output=True, text=True)
    assert proc.returncode != 0


def _venv(tmp_path: Path) -> Path:
    env_dir = tmp_path / "venv"
    try:
        venv.EnvBuilder(with_pip=True, clear=True).create(env_dir)
    except Exception as exc:  # no ensurepip in this Python
        pytest.skip(f"cannot make a virtual environment: {exc}")
    return env_dir


def _resolve_from(env_dir: Path) -> dict:
    """FiberBrowser's helper resolution, seeing only the venv's installed packages for the companion."""
    site = next((env_dir / "lib").glob("python*/site-packages"))
    code = (
        "import json, sys; sys.path.insert(0, %r); sys.path.insert(0, %r)\n"
        "from services.graph_panel import helper\n"
        "helper._bundled_candidates = lambda: []\n"
        "s = helper.resolve(environ={})\n"
        "print(json.dumps({'available': s.available, 'source': s.source, 'path': s.path, 'hint': s.hint, "
        "'producer': (s.handshake or {}).get('producer')}))\n"
    ) % (str(ROOT / "browser"), str(site))
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True,
                         env={k: v for k, v in os.environ.items() if k != "FIBERBROWSER_GRAPH_HELPER"})
    return json.loads(out.stdout.strip().splitlines()[-1])


def _clean_install(wheel: Path, tmp_path: Path, expect_producer: str):
    env_dir = _venv(tmp_path)
    py = env_dir / "bin" / "python"
    subprocess.run([str(py), "-m", "pip", "install", "--no-index", "--no-deps", "--disable-pip-version-check", "-q", str(wheel)],
                   check=True, capture_output=True)
    path = subprocess.run([str(py), "-c", "import fiberbrowser_graph_native as m; print(m.helper_path())"],
                          capture_output=True, text=True, check=True).stdout.strip()
    assert Path(path).is_file() and os.access(path, os.X_OK) and str(env_dir) in path
    hs = subprocess.run([str(env_dir / "bin" / "fiberbrowser-graph"), "handshake"], capture_output=True, check=True).stdout
    assert expect_producer.encode() in hs
    found = _resolve_from(env_dir)
    assert found["available"] and found["source"] == "companion" and found["path"] == path
    assert found["producer"].startswith(expect_producer)
    subprocess.run([str(py), "-m", "pip", "uninstall", "-y", "-q", "fiberbrowser-graph-native"], check=True, capture_output=True)
    gone = _resolve_from(env_dir)
    assert not gone["available"] and 'pip install "fiberbrowser[graph]"' in gone["hint"]


def test_clean_install_into_a_fresh_venv_is_found_then_missing(stub_helper, tmp_path):
    # The stub runs anywhere, so its wheel may say so (a real helper's tag is its platform's).
    wheel = build(stub_helper, tmp_path / "dist", "--plat-tag", "any")
    _clean_install(wheel, tmp_path, "fiberbrowser-graph 9.8.7")


@pytest.mark.skipif(not (REAL_HELPER and os.path.isfile(REAL_HELPER) and sys.platform == "darwin"),
                    reason="set FIBERBROWSER_TEST_GRAPH_HELPER (macOS) for the real helper's wheel")
def test_real_helper_wheel_clean_install(tmp_path):
    wheel = build(Path(REAL_HELPER), tmp_path / "dist")
    assert wheel.name.startswith("fiberbrowser_graph_native-") and "-py3-none-macosx_" in wheel.name
    check_record(wheel)
    _clean_install(wheel, tmp_path, "fiberbrowser-graph ")
