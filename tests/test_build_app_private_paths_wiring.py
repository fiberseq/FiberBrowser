"""build_app.sh's private-path step (3.1.0 release check): FB_PRIVATE_PATHS_ALLOW reaches check_private_paths.py as
--allow, FB_REAL_HOME as --forbid, FB_ALLOW_PRIVATE_PATHS=1 skips the step, and a hit stops the build. The block is
cut from packaging/macos/build_app.sh and run by the system bash (/bin/bash, 3.2 on macOS) under ``set -euo pipefail``,
so an empty allow list must not trip ``set -u``. On GitHub Actions the scan is skipped (the runner's home is where
upstream wheels were built), unless FB_PRIVATE_PATHS_ON_CI=1."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MACHO = b"\xcf\xfa\xed\xfe" + b"\0" * 60
USERS = "/" + "Users"            # built at run time (repository hygiene keeps literal home paths out of tracked files)
HOME = f"{USERS}/builder"
BASH = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash")


def _block() -> str:
    text = (ROOT / "packaging" / "macos" / "build_app.sh").read_text()
    blocks = re.findall(r'^if \[ "\$\{(?:FB_ALLOW_PRIVATE_PATHS:-0\}" != 1|GITHUB_ACTIONS:-\}" = true)[^\n]*\]; then\n.*?^fi\n',
                        text, re.S | re.M)
    blocks = [b for b in blocks if "check_private_paths.py" in b]   # (the venv's linked-library gate shares the switch)
    assert len(blocks) == 1, "the private-path block moved: update this test"
    return blocks[0]


@pytest.fixture
def app(tmp_path):
    app = tmp_path / "FiberBrowser.app" / "Contents"
    (app / "Frameworks").mkdir(parents=True)
    (app / "Frameworks" / "dirty-helper").write_bytes(MACHO + HOME.encode() + b"/.cargo/registry/src/x.rs\0")
    (app / "Frameworks" / "clean-helper").write_bytes(MACHO + b"/opt/build/x.rs\0")
    venv = tmp_path / "venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").symlink_to(sys.executable)
    return tmp_path


def _run(tmp_path, **env):
    script = ('set -euo pipefail\n'
              'die() { echo "DIE: $*" >&2; exit 7; }\n'
              f'ROOT={str(ROOT)!r}\nVENV={str(tmp_path / "venv")!r}\nAPP={str(tmp_path / "FiberBrowser.app")!r}\n'
              + _block() + 'echo BLOCK-OK\n')
    full = {"PATH": os.environ.get("PATH", ""), "HOME": HOME, "USER": "builder", **env}
    return subprocess.run([BASH, "-c", script], capture_output=True, text=True, env=full, timeout=120)


@pytest.mark.skipif(BASH is None, reason="needs bash")
def test_a_home_path_stops_the_build(app):
    proc = _run(app)
    assert proc.returncode == 7, proc
    assert "dirty-helper" in proc.stdout and "DIE: bundled binaries carry the builder's paths" in proc.stderr
    assert "clean-helper" not in proc.stdout


@pytest.mark.skipif(BASH is None, reason="needs bash")
def test_allow_list_reaches_the_check_as_accepted_exceptions(app):
    proc = _run(app, FB_PRIVATE_PATHS_ALLOW="dirty-helper other-name")
    assert proc.returncode == 0, proc
    assert "accepted exception: dirty-helper" in proc.stdout and "accepted exception: other-name" in proc.stdout
    assert "check_private_paths: clean" in proc.stdout and "BLOCK-OK" in proc.stdout


@pytest.mark.skipif(BASH is None, reason="needs bash")
def test_real_home_is_forbidden_too(app):
    (app / "FiberBrowser.app" / "Contents" / "Frameworks" / "clean-helper").write_bytes(MACHO + b"/Volumes/realhome/x\0")
    proc = _run(app, FB_PRIVATE_PATHS_ALLOW="dirty-helper", FB_REAL_HOME="/Volumes/realhome")
    assert proc.returncode == 7 and "clean-helper" in proc.stdout, proc


@pytest.mark.skipif(BASH is None, reason="needs bash")
def test_development_builds_can_skip_the_check(app):
    proc = _run(app, FB_ALLOW_PRIVATE_PATHS="1")
    assert proc.returncode == 0 and "BLOCK-OK" in proc.stdout and "check_private_paths" not in proc.stdout, proc


@pytest.mark.skipif(BASH is None, reason="needs bash")
def test_ci_skips_the_scan_unless_asked(app):
    proc = _run(app, GITHUB_ACTIONS="true")
    assert proc.returncode == 0 and "BLOCK-OK" in proc.stdout and "Private-path scan skipped on CI" in proc.stdout, proc
    proc = _run(app, GITHUB_ACTIONS="true", FB_PRIVATE_PATHS_ON_CI="1")
    assert proc.returncode == 7 and "dirty-helper" in proc.stdout, proc


@pytest.mark.skipif(BASH is None, reason="needs bash")
def test_numba_caches_from_the_build_venv_are_left_out_of_the_app(tmp_path):
    """3.0.x-3.1.0 shipped pynndescent's numba caches (.nbi/.nbc), which record the build venv's path (the scan only
    read native binaries then). build_app.sh deletes them right after PyInstaller, before the private-path scan."""
    text = (ROOT / "packaging" / "macos" / "build_app.sh").read_text()
    lines = [l for l in text.splitlines() if "-name '*.nbi'" in l]
    assert len(lines) == 1, lines
    assert text.index("pyinstaller") < text.index(lines[0]) < text.index("check_private_paths.py"), "the cache cleanup moved"
    cache = tmp_path / "FiberBrowser.app" / "Contents" / "Resources" / "pynndescent" / "__pycache__"
    cache.mkdir(parents=True)
    for name in ("utils.norm-120.py312.nbi", "utils.norm-120.py312.1.nbc", "utils.cpython-312.pyc"):
        (cache / name).write_bytes(b"x")
    (cache.parent / "utils.py").write_text("x = 1\n")
    done = subprocess.run([BASH, "-c", f"set -euo pipefail\nAPP={str(tmp_path / 'FiberBrowser.app')!r}\n{lines[0]}\n"],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert sorted(p.name for p in cache.parent.rglob("*") if p.is_file()) == ["utils.cpython-312.pyc", "utils.py"]
