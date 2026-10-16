"""The bundled BLAST+: where FiberBrowser looks for it, and the packaging pins
(packaging/third_party.sh) both builds use."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from fiberbrowser.cli import prepare_process_environment

ROOT = Path(__file__).resolve().parent.parent


def test_blast_usage_reports_are_off_unless_set():
    env = prepare_process_environment({"PATH": "/usr/bin:/bin"})
    assert env["BLAST_USAGE_REPORT"] == "false"
    env = prepare_process_environment({"PATH": "/usr/bin:/bin", "BLAST_USAGE_REPORT": "true"})
    assert env["BLAST_USAGE_REPORT"] == "true"


def _pins() -> dict[str, str]:
    out = subprocess.run(["bash", "-c", '. "$1"; for v in BLAST_VERSION BLAST_MACOS_SHA256; '
                          'do echo "$v=${!v}"; done', "sh",
                          str(ROOT / "packaging" / "third_party.sh")], capture_output=True, text=True, check=True)
    return dict(line.split("=", 1) for line in out.stdout.split())


def test_third_party_pins():
    pins = _pins()
    assert re.fullmatch(r"\d+\.\d+\.\d+", pins["BLAST_VERSION"])
    assert re.fullmatch(r"[0-9a-f]{64}", pins["BLAST_MACOS_SHA256"])
    notices = (ROOT / "packaging" / "third_party" / "THIRD_PARTY_NOTICES.txt").read_text()
    assert f"BLAST+ {pins['BLAST_VERSION']}" in notices
    # WSL: Debian's ncbi-blast+ (no NCBI Linux tarball, no LZO source to carry).
    assert "Debian bookworm packages" in notices and "sources.debian.org" in notices
    blast = (ROOT / "packaging" / "third_party" / "blast" / "BLAST-THIRD-PARTY.txt").read_text()
    assert "OpenLDAP Public License" in blast and "lzo-" not in blast


def test_both_builds_bundle_blast():
    mac = (ROOT / "packaging" / "macos" / "build_app.sh").read_text()
    wsl = (ROOT / "packaging" / "windows" / "build_wsl_distro.sh").read_text()
    docker = (ROOT / "packaging" / "windows" / "Dockerfile").read_text()
    for script in (mac, wsl):
        assert "third_party.sh" in script and "FB_FLAVOR" in script
    assert "fetch_pinned" in mac and "BLAST_LINUX" not in wsl and "LZO" not in wsl
    assert '"$APP/Contents/Helpers/$program"' in mac
    # WSL: Debian's ncbi-blast+, only blastn and makeblastdb kept; Debian's copyright files stay.
    assert "ncbi-blast+" in docker and "blastn|makeblastdb" in docker and "libgomp1" in docker
    assert "! -name copyright" in docker and "/usr/share/doc/*" not in docker
