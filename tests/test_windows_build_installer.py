"""packaging/windows/build_installer.sh with a stand-in makensis.

The rootfs tarball may live anywhere (not only in FB_BUILD_DIR) and either path
may be relative: the installer, the portable zip and SHA256SUMS are still made.
"""
import hashlib
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging" / "windows" / "build_installer.sh"

pytestmark = pytest.mark.skipif(
    os.name == "nt" or not shutil.which("bash") or not shutil.which("zip")
    or not (shutil.which("shasum") or shutil.which("sha256sum")),
    reason="needs bash, zip and shasum/sha256sum",
)

FAKE_MAKENSIS = """#!/usr/bin/env bash
# Writes the -DOUTFILE it is given, like makensis would.
for a in "$@"; do
  case "$a" in -DOUTFILE=*) out="${a#-DOUTFILE=}";; esac
done
[ -n "${out:-}" ] || { echo "no -DOUTFILE" >&2; exit 2; }
printf 'fake exe %s\\n' "$(basename "$out")" > "$out"
"""


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@pytest.mark.parametrize("relative", [False, True])
def test_rootfs_outside_the_build_dir(tmp_path, relative):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "makensis"
    fake.write_text(FAKE_MAKENSIS)
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    rootfs = elsewhere / "FiberBrowser-9.8.7-wsl-amd64.tar.gz"
    rootfs.write_bytes(b"not really a tarball\n" * 64)
    build = tmp_path / "out" / "win"

    env = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    if relative:
        env["FB_BUILD_DIR"] = os.path.relpath(build, tmp_path)
        arg = os.path.relpath(rootfs, tmp_path)
    else:
        env["FB_BUILD_DIR"] = str(build)
        arg = str(rootfs)
    proc = subprocess.run(["bash", str(SCRIPT), arg], cwd=tmp_path, env=env,
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr

    setup = build / "FiberBrowser-9.8.7-Setup.exe"
    portable = build / "FiberBrowser-9.8.7-windows-portable.zip"
    assert setup.is_file() and portable.is_file()
    assert not (build / "portable").exists()

    lines = (build / "SHA256SUMS").read_text().splitlines()
    assert lines == [
        f"{_sha256(setup)}  {setup.name}",
        f"{_sha256(portable)}  {portable.name}",
        f"{_sha256(rootfs)}  {rootfs.name}",
    ]
    # The portable zip carries the tarball itself.
    listing = subprocess.run(["unzip", "-l", str(portable)], capture_output=True, text=True)
    if listing.returncode == 0:
        assert f"FiberBrowser-9.8.7-windows-portable/{rootfs.name}" in listing.stdout


@pytest.mark.parametrize('subject,thumbprint,valid', [
    ('CN=FiberBrowser Release', 'ab' * 20, True), ('', '', True),
    ('CN=FiberBrowser Release', '', False), ('', 'ab' * 20, False),
    ('CN=FiberBrowser Release', 'invalid', False),
])
def test_windows_build_embeds_publisher_constants(tmp_path, monkeypatch, subject, thumbprint, valid):
    import json
    import runpy
    writer = runpy.run_path(str(ROOT / 'packaging/windows/write_update_trust.py'))['write_trust']
    path = tmp_path / 'build.json'
    path.write_text(json.dumps({'platform': 'windows-x64'}))
    monkeypatch.setenv('FB_WINDOWS_PUBLISHER_SUBJECT', subject)
    monkeypatch.setenv('FB_WINDOWS_PUBLISHER_THUMBPRINT', thumbprint)
    if valid:
        writer(path)
        assert json.loads(path.read_text())['windows_update_signer'] == {
            'subject': subject, 'thumbprint': thumbprint.upper()}
    else:
        with pytest.raises(ValueError, match='Set both'):
            writer(path)
    script = (ROOT / 'packaging/windows/build_wsl_distro.sh').read_text()
    assert '"$HERE/write_update_trust.py" "$CTX/build.json"' in script
