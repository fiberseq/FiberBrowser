"""The declared dependencies match what the Browser imports (audit F2)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _requirements(name):
    lines = (ROOT / name).read_text().splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def test_runtime_requirements_declare_fiberhmm_3_and_requests():
    reqs = _requirements("requirements.txt")
    assert "fiberhmm[consensus]>=3.0,<4" in reqs
    assert any(r.startswith("requests") for r in reqs)
    # FastAPI has a tested upper bound (0.142 changed router internals).
    assert any(r.startswith("fastapi>=") and "<" in r for r in reqs)


def test_dev_requirements_cover_the_test_suite():
    reqs = " ".join(_requirements("requirements-dev.txt"))
    for package in ("pytest", "httpx", "primer3-py", "seqfold"):
        assert package in reqs


def test_install_script_checks_requests_and_fiberhmm():
    script = (ROOT / "scripts" / "install.sh").read_text()
    assert "import requests" in script
    assert "import sys, fiberhmm" in script
