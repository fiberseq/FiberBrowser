"""Release bundles must not expose the machine that installed their wheels."""
import json
from pathlib import Path
import runpy
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging/package_metadata.py"
check_metadata = runpy.run_path(str(SCRIPT))["check_metadata"]


@pytest.fixture
def installed(tmp_path):
    metadata = tmp_path / "site-packages" / "example-1.0.dist-info"
    metadata.mkdir(parents=True)
    (metadata / "METADATA").write_text("Name: example\nVersion: 1.0\n")
    (metadata / "RECORD").write_text('example/__init__.py,sha256=abc,10\n../../../bin/example,,\n')
    return metadata.parent, metadata


def test_relative_record_paths_are_allowed(installed):
    root, _ = installed
    assert check_metadata([root], "/custom/build/home") == []


@pytest.mark.parametrize("filename,text,home", [
    ("METADATA", "Built from /Users/alice/work/project", "/Users/alice"),
    ("METADATA", "Built from /home/alice/work/project", "/home/alice"),
    ("METADATA", "Built from /root/work/project", "/root"),
    ("METADATA", "Built from /custom/build/home/project", "/custom/build/home"),
    ("METADATA", "file:///%55sers/alice/project", "/Users/alice"),
    ("METADATA", json.dumps({"path": r"C:\Users\builder\project"}), r"C:\Users\builder"),
    ("RECORD", "/Users/alice/site-packages/example.py,,\n", "/alice"),
    ("RECORD", "/opt/build/site-packages/example.py,,\n", "/alice"),
    ("RECORD", "C:\\build\\example.py,,\n", "/alice"),
])
def test_private_or_absolute_metadata_paths_fail(installed, filename, text, home):
    root, metadata = installed
    (metadata / filename).write_text(text)
    assert check_metadata([root], home)


def test_direct_url_fails_even_without_a_home_path_and_cleanup_removes_every_copy(installed):
    root, metadata = installed
    for name in ("fiberbrowser", "fiberhmm", "orjson"):
        directory = root / f"{name}-1.0.dist-info"
        directory.mkdir()
        (directory / "direct_url.json").write_text('{"url": "file:///tmp/wheels/package.whl"}')
    assert len(check_metadata([root], "/custom/build/home")) == 3
    result = subprocess.run([sys.executable, str(SCRIPT), "--remove-direct-urls", str(root)],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not list(root.rglob("direct_url.json"))
    assert (metadata / "RECORD").is_file()
    assert check_metadata([root], "/custom/build/home") == []
    (metadata / "METADATA").write_text("Source: /Users/alice/source")
    result = subprocess.run([sys.executable, str(SCRIPT), "--build-home", "/Users/alice", str(root)],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 1 and "build home path" in result.stdout


def test_only_the_recorded_builders_home_is_rejected_on_another_machine(installed, tmp_path):
    import shutil
    root, metadata = installed
    script = tmp_path / "package_metadata.py"
    shutil.copyfile(SCRIPT, script)
    result = subprocess.run([sys.executable, str(script), "--record-build-home", "--build-home",
                             "/Users/alice/isolated/home", str(root)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    fingerprint = script.with_suffix(".home-sha256").read_text()
    assert "builder" not in fingerprint and len(fingerprint.splitlines()) == 2
    (metadata / "METADATA").write_text("Example: /home/someone/code\nCI: file:///Users/runner/work/package")
    command = [sys.executable, str(script), "--build-home", "/home/lab", str(root)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    (metadata / "METADATA").write_text("Source: file:///Users/alice/work/package")
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    assert result.returncode == 1 and "build home path" in result.stdout


def test_missing_or_empty_package_roots_fail(tmp_path):
    assert check_metadata([tmp_path / "missing"], "/alice")
    assert check_metadata([tmp_path], "/alice")


def test_release_builds_clean_metadata_and_smoke_tests_check_it():
    mac_build = (ROOT / "packaging/macos/build_app.sh").read_text()
    assert mac_build.index("--remove-direct-urls") < mac_build.index('KEYCHAIN_ARGS=()')
    assert 'cp "$ROOT/packaging/package_metadata.py"' in mac_build
    wsl_build = (ROOT / "packaging/windows/build_wsl_distro.sh").read_text()
    dockerfile = (ROOT / "packaging/windows/Dockerfile").read_text()
    assert 'cp "$ROOT/packaging/package_metadata.py" "$CTX/package_metadata.py"' in wsl_build
    assert 'COPY package_metadata.py /opt/fiberbrowser/share/fiberbrowser/package_metadata.py' in dockerfile
    assert '--remove-direct-urls --record-build-home /opt/fiberbrowser/lib /usr/local/lib' in dockerfile
    for platform, filename in (("macos", "check_app.sh"), ("windows", "check_distro.sh")):
        check = (ROOT / "packaging" / platform / filename).read_text()
        assert 'check "package metadata privacy"' in check and 'package_metadata.py' in check
        assert '--build-home "${FB_BUILD_HOME:-$HOME}"' in check
