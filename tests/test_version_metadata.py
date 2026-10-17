"""FiberBrowser version strings agree, and sessions record real versions (audit F3)."""
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def test_backend_and_frontend_versions_agree():
    from version import __version__
    package = json.loads((ROOT / "browser" / "frontend" / "package.json").read_text())
    lock = json.loads((ROOT / "browser" / "frontend" / "package-lock.json").read_text())
    assert __version__ == "3.0.1"
    assert package["version"] == __version__
    assert lock["version"] == __version__ and lock["packages"][""]["version"] == __version__


def test_session_export_records_the_real_fiberbrowser_and_fiberhmm_versions():
    import fiberhmm
    from models.requests import SessionExportRequest
    from services.sessions_endpoint import build_session_export_for_request
    from version import __version__
    state = SimpleNamespace(chroms=[SimpleNamespace(name="chr1")], datasets={}, dataset_order=[],
                            modification_overlays={}, orthogonal_tracks=[], gtf_data=None,
                            current_genome=None, fasta_path=None)
    session = build_session_export_for_request(
        state, SessionExportRequest(), now=datetime(2026, 9, 29, tzinfo=timezone.utc))["session"]
    assert session["fiberbrowser_version"] == __version__
    assert session["fiberhmm_version"] == fiberhmm.__version__  # was a hard-coded "1.0.0"


def test_update_checker_treats_3_0_0_as_newer_than_the_old_2x_releases():
    # The update check (services/app_update.py) behind /api/version and Check for Updates.
    from services.app_update import is_newer
    assert not is_newer("v2.17.1", "3.0.0")
    assert is_newer("v3.0.1", "3.0.0")


def test_citation_file_is_in_step_with_the_version():
    # CITATION.cff (GitHub's "Cite this repository"; About and the docs point to it).
    import re
    from version import __version__
    text = (ROOT / "CITATION.cff").read_text()
    assert re.search(r"^cff-version: 1\.2\.0$", text, re.M)
    assert re.search(rf"^version: {re.escape(__version__)}$", text, re.M)
    # It points to FiberHMM (the footprints FiberBrowser shows).
    assert "repository-code: \"https://github.com/fiberseq/FiberHMM\"" in text
