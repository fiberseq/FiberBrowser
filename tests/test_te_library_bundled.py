"""The bundled TE library (every build): where Identify looks for its source files, and the packaging pins and
steps that bundle it (packaging/third_party.sh, the build scripts)."""
import re
import subprocess
import sys
from pathlib import Path

from services.te_library import bundled_library_dir


def test_bundled_te_library_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_BUNDLED_TE_LIBRARIES", str(tmp_path))
    assert bundled_library_dir("dmel-canonical-v10.2") is None
    (tmp_path / "dmel-canonical-v10.2").mkdir()
    assert bundled_library_dir("dmel-canonical-v10.2") == tmp_path / "dmel-canonical-v10.2"
    for bad in ("", ".", "..", "../x", "a/b"):
        assert bundled_library_dir(bad) is None


def test_bundled_te_library_dir_under_the_prefix(tmp_path, monkeypatch):
    # The WSL distribution: <venv>/share/fiberbrowser/te_libraries/<id>
    monkeypatch.delenv("FIBERBROWSER_BUNDLED_TE_LIBRARIES", raising=False)
    monkeypatch.setattr(sys, "prefix", str(tmp_path))
    lib = tmp_path / "share" / "fiberbrowser" / "te_libraries" / "dmel-canonical-v10.2"
    lib.mkdir(parents=True)
    assert bundled_library_dir("dmel-canonical-v10.2") == lib


ROOT = Path(__file__).resolve().parent.parent


def test_te_library_pins():
    out = subprocess.run(["bash", "-c", '. "$1"; for v in TE_DMEL_ID TE_DMEL_COMMIT; do echo "$v=${!v}"; done', "sh",
                          str(ROOT / "packaging" / "third_party.sh")], capture_output=True, text=True, check=True)
    pins = dict(line.split("=", 1) for line in out.stdout.split())
    assert re.fullmatch(r"[0-9a-f]{40}", pins["TE_DMEL_COMMIT"])
    # The id the backend looks up (services/te_library.py) and the notice's commit match the pins.
    notice = (ROOT / "packaging" / "third_party" / "drosophila-transposons-NOTICE.txt").read_text()
    assert pins["TE_DMEL_COMMIT"] in notice


def test_every_build_bundles_the_te_library():
    mac = (ROOT / "packaging" / "macos" / "build_app.sh").read_text()
    wsl = (ROOT / "packaging" / "windows" / "build_wsl_distro.sh").read_text()
    docker = (ROOT / "packaging" / "windows" / "Dockerfile").read_text()
    for script in (mac, wsl):
        assert "fetch_te_dmel" in script
    assert "Contents/Resources/te_libraries" in mac
    assert "/opt/fiberbrowser/share/fiberbrowser/te_libraries/" in docker
