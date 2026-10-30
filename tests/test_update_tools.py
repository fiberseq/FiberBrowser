"""The packaging side of updates: the build file the builds write, the update manifest maker, the release
publisher's dry run, and the smoke tests' check that a packaged app runs its bundled FiberHMM."""
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from services import app_build, app_update

ROOT = Path(__file__).resolve().parent.parent


def load(rel):
    spec = importlib.util.spec_from_file_location(Path(rel).stem, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def built_files(tmp_path):
    files = {"FiberBrowser-3.0.1-arm64.dmg": b"dmg" * 1000, "FiberBrowser-3.0.1-arm64.zip": b"zip" * 900,
             "FiberBrowser-3.0.1-Setup.exe": b"exe" * 800}
    out = []
    for name, data in files.items():
        (tmp_path / name).write_bytes(data)
        out.append(tmp_path / name)
    return out


def test_write_build_info_makes_a_packaged_app(tmp_path, monkeypatch):
    tool = load("packaging/write_build_info.py")
    out = tmp_path / "Resources" / "fiberbrowser-build.json"
    monkeypatch.setenv("FB_BUILD_NUMBER", "20261005.1432")
    monkeypatch.setenv("FB_UPDATE_URL", "file:///Volumes/builds/fiberbrowser-update-public.json")
    monkeypatch.delenv("FB_UPDATE_REPO", raising=False)
    assert tool.main(["--out", str(out), "--flavor", "public", "--version", "3.0.0", "--platform", "macos-arm64",
                      "--fiberhmm-version", "3.0.0", "--commit", "abc1234"]) == 0
    info = json.loads(out.read_text())
    assert info["schema"] == app_build.BUILD_INFO_SCHEMA and info["channel"] == "public"
    assert info["build"] == "20261005.1432" and info["update_manifest_url"].startswith("file://")
    monkeypatch.setattr(app_build, "build_info_candidates", lambda: [out])
    monkeypatch.setattr(app_build, "is_frozen", lambda: False)
    assert app_build.is_packaged() and app_build.platform_key() == "macos-arm64"


def test_build_info_records_an_exports_source_commit_and_a_shared_build(tmp_path, monkeypatch):
    """A public build is made from an exported tree (no git checkout of the lab source): its build information
    records the lab commit the export came from, and the Mac and WSL builds of one commit share a build number."""
    tool = load("packaging/write_build_info.py")
    monkeypatch.delenv("FB_BUILD_NUMBER", raising=False)
    source = {"commit": "c32e1208", "committed_at": 1791241920, "dirty": False}
    mac = tool.build_info("public", "3.0.0", "macos-arm64", "3.0.0", "", environ={}, source=source)
    wsl = tool.build_info("public", "3.0.0", "windows-x64", "3.0.0", "9f8e7d6", environ={}, source=source)
    assert mac["commit"] == "c32e1208" and mac["source_commit"] == "c32e1208"
    # The WSL build names the export's own commit; the lab source stays recorded.
    assert wsl["commit"] == "9f8e7d6" and wsl["source_commit"] == "c32e1208"
    assert mac["build"] == wsl["build"] == "20261005.2312"
    assert tool.build_info("public", "3.0.0", "macos-arm64", environ={"FB_BUILD_NUMBER": "7"}, source=source)["build"] == "7"
    # The file the export writes.
    (tmp_path / "source.json").write_text(json.dumps(source))
    assert tool.source_record(tmp_path / "source.json")["commit"] == "c32e1208"
    assert tool.source_record(tmp_path / "missing.json") == {}
    # The tree being packaged decides (a WSL build of another checkout): its source.json, not the builder's.
    tree = tmp_path / "tree"
    (tree / "packaging").mkdir(parents=True)
    (tree / "packaging" / "source.json").write_text(json.dumps({"commit": "1234abc", "committed_at": 1791241920}))
    other = tool.build_info("public", "3.0.0", "windows-x64", environ={}, source_root=tree)
    assert other["source_commit"] == "1234abc" and other["build"] == "20261005.2312"


def test_make_update_manifest_refuses_builds_that_disagree(tmp_path):
    tool = load("tools/make_update_manifest.py")
    files = built_files(tmp_path)
    mac, wsl = tmp_path / "mac.json", tmp_path / "wsl.json"
    mac.write_text(json.dumps({"channel": "public", "version": "3.0.1", "build": "20261005.1432"}))
    wsl.write_text(json.dumps({"channel": "public", "version": "3.0.1", "build": "20261005.1611"}))
    with pytest.raises(SystemExit, match="FB_BUILD_NUMBER"):
        tool.main(["--channel", "public", "--build-info", str(mac), "--build-info", str(wsl), *map(str, files)])
    wsl.write_text(json.dumps({"channel": "public", "version": "3.0.1", "build": "20261005.1432"}))
    out = tmp_path / "m.json"
    assert tool.main(["--channel", "public", "--build-info", str(mac), "--build-info", str(wsl), "--out", str(out), *map(str, files)]) == 0
    assert json.loads(out.read_text())["build"] == "20261005.1432"


def test_make_update_manifest_from_built_files(tmp_path):
    tool = load("tools/make_update_manifest.py")
    files = built_files(tmp_path)
    build = tmp_path / "fiberbrowser-build.json"
    build.write_text(json.dumps({"channel": "public", "version": "3.0.1", "build": "20261005.1432"}))
    out = tmp_path / "fiberbrowser-update-public.json"
    assert tool.main(["--channel", "public", "--build-info", str(build), "--notes", "Faster.",
                      "--notes-url", "https://example.org/notes", "--out", str(out), *map(str, files)]) == 0
    data = json.loads(out.read_text())
    parsed = app_update.parse_manifest(out.read_text())
    assert parsed["version"] == "3.0.1" and parsed["build"] == "20261005.1432" and parsed["minimum_macos"] == "14.0"
    dmg = app_update.pick_download(parsed, "macos-arm64")
    assert dmg["name"] == "FiberBrowser-3.0.1-arm64.dmg"
    assert dmg["sha256"] == hashlib.sha256(files[0].read_bytes()).hexdigest() and dmg["size"] == 3000
    assert app_update.pick_download(parsed, "windows-x64")["kind"] == "installer"
    assert "url" not in data["downloads"]["macos-arm64"][0]  # named: found among the release's assets
    with pytest.raises(SystemExit, match="version"):
        tool.main(["--channel", "public", "--build-info", str(build), "--version", "3.0.2", str(files[0])])
    with pytest.raises(SystemExit, match="platform"):
        (tmp_path / "mystery.bin").write_bytes(b"x")
        tool.main(["--channel", "public", "--version", "3.0.1", str(tmp_path / "mystery.bin")])
    assert tool.classify("linux-x86_64:tarball=" + str(files[0]))[:2] == ("linux-x86_64", "tarball")


def manifest_for(tmp_path, files, version="3.0.1"):
    tool = load("tools/make_update_manifest.py")
    out = tmp_path / "fiberbrowser-update-public.json"
    tool.main(["--channel", "public", "--version", version, "--out", str(out), *map(str, files)])
    return out


def test_publish_release_dry_run_prints_the_commands_and_runs_nothing(tmp_path, monkeypatch, capsys):
    tool = load("tools/publish_release.py")
    files = built_files(tmp_path)
    manifest = manifest_for(tmp_path, files)

    def refuse(*args, **kwargs):
        raise AssertionError("a dry run ran a command")
    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    assert tool.main(["--channel", "public", "--tag", "v3.0.1", "--manifest", str(manifest), "--dry-run",
                      *map(str, files)]) == 0
    out = capsys.readouterr().out
    assert "Nothing was run" in out and "fiberseq/FiberBrowser" in out
    create = [line.strip() for line in out.splitlines() if line.strip().startswith("gh release create")]
    assert len(create) == 1
    argv = __import__("shlex").split(create[0])
    assert argv[:4] == ["gh", "release", "create", "v3.0.1"] and "--verify-tag" in argv
    assert argv[argv.index("--repo") + 1] == "fiberseq/FiberBrowser"
    assert {Path(a).name for a in argv if a.endswith((".dmg", ".zip", ".exe", ".json"))} == \
        {f.name for f in files} | {manifest.name}


def test_publish_release_refuses_mismatches(tmp_path):
    tool = load("tools/publish_release.py")
    files = built_files(tmp_path)
    manifest = manifest_for(tmp_path, files)
    base = ["--channel", "public", "--manifest", str(manifest), "--dry-run"]
    with pytest.raises(SystemExit, match="tag"):
        tool.main([*base, "--tag", "v3.0.2", *map(str, files)])
    with pytest.raises(SystemExit, match="aren't the manifest's"):
        tool.main([*base, "--tag", "v3.0.1", *map(str, files[:2])])
    files[0].write_bytes(b"rebuilt")
    with pytest.raises(SystemExit, match="sha256"):
        tool.main([*base, "--tag", "v3.0.1", *map(str, files)])
    renamed = tmp_path / "update.json"
    renamed.write_text(manifest.read_text())
    with pytest.raises(SystemExit, match="must be named"):
        tool.main(["--channel", "public", "--manifest", str(renamed), "--dry-run", "--tag", "v3.0.1", *map(str, files)])


def test_publish_release_has_one_channel():
    tool = load("tools/publish_release.py")
    assert tool.DEFAULT_REPOS == {"public": "fiberseq/FiberBrowser"}
    assert not tool.PRIVATE_CHANNELS



@pytest.mark.parametrize("script", ["packaging/macos/check_app.sh", "packaging/windows/check_distro.sh"])
def test_smoke_tests_assert_the_bundled_fiberhmm_is_used_by_default(script, tmp_path):
    """Runs the smoke tests' Python check against this checkout made to look packaged (a build file), with a
    browser_settings.json that names another FiberHMM: the app must still run the bundled one."""
    if importlib.util.find_spec("fiberhmm") is None:
        pytest.skip("needs an installed FiberHMM (the 'bundled' one here)")
    text = (ROOT / script).read_text()
    check = re.search(r"BUNDLED_TEST='\n(.*?)\n'\n", text, re.S).group(1)
    assert 'check "bundled FiberHMM by default"' in text
    check = check.replace('fiberhmm.__file__.startswith("/opt/fiberbrowser/")', '"fake-fiberhmm" not in fiberhmm.__file__')
    build = tmp_path / "build.json"
    build.write_text(json.dumps({"schema": app_build.BUILD_INFO_SCHEMA, "channel": "public", "version": "3.0.0",
                                 "build": "1", "platform": "windows-x64"}))
    home = tmp_path / "home"
    (home / ".fiberhmm").mkdir(parents=True)
    fake = home / "fake-fiberhmm" / "fiberhmm" / "inference"
    fake.mkdir(parents=True)
    (fake.parent / "__init__.py").write_text('__version__ = "2.16.8"\n')
    (fake / "strand_rescue.py").write_text("")
    (home / ".fiberhmm" / "browser_settings.json").write_text(json.dumps({"fiberhmm_source_dir": str(home / "fake-fiberhmm")}))
    prelude = ("import sys\nfrom pathlib import Path\nsys.path.insert(0, %r)\nimport services.app_build as ab\n"
               "ab.build_info_candidates = lambda: [Path(%r)]\n") % (str(ROOT / "browser"), str(build))
    env = {k: v for k, v in os.environ.items() if k not in ("FIBERBROWSER_SETTINGS", "FIBERBROWSER_APP_SETTINGS",
                                                            "FIBERHMM_SOURCE_DIR")}
    env["HOME"] = str(home)
    done = subprocess.run([sys.executable, "-c", prelude + check], cwd=str(ROOT), env=env, capture_output=True,
                          text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]
    assert done.stdout.startswith("bundled FiberHMM")


def test_manifest_includes_built_sibling_zip_when_given_dmg(tmp_path):
    tool = load("tools/make_update_manifest.py")
    files = built_files(tmp_path)
    data = tool.make_manifest("public", "3.0.1", [str(files[0])])
    entries = data["downloads"]["macos-arm64"]
    assert [e["kind"] for e in entries] == ["dmg", "zip"]
    assert entries[1]["sha256"] == hashlib.sha256(files[1].read_bytes()).hexdigest()
    assert entries[1]["size"] == files[1].stat().st_size
