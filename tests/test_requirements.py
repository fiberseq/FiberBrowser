"""The declared dependencies match what the Browser imports (audit F2)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _requirements(name):
    lines = (ROOT / name).read_text().splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def test_runtime_requirements_declare_fiberhmm_3_and_requests():
    reqs = _requirements("requirements.txt")
    assert "fiberhmm[consensus]>=3.2.2,<4" in reqs
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


def test_install_script_fiberhmm_check_uses_the_declared_floor(tmp_path):
    """Release audit 3.1.0 (recheck): the installer's import check follows requirements.txt (>=3.2.2,<4), not
    major >= 3."""
    import re
    import subprocess
    import sys
    script = (ROOT / "scripts" / "install.sh").read_text()
    lines = [line for line in script.splitlines() if line.startswith(("FIBERHMM_REQ=", "FIBERHMM_MIN=", "FIBERHMM_MAX_MAJOR="))]
    assert len(lines) == 3
    check = re.search(r"if ! \"\$PY\" -c ('import sys, fiberhmm.*?' \"\$FIBERHMM_MIN\" \"\$FIBERHMM_MAX_MAJOR\")",
                      script, re.S)
    assert check, "the FiberHMM version check moved"
    for version, ok in [("3.1.0", False), ("3.2.0", False), ("3.2.1", False), ("3.2.2", True), ("3.4.1", True),
                        ("4.0.0", False), ("2.9", False)]:
        fake = tmp_path / version / "fiberhmm"
        fake.mkdir(parents=True)
        (fake / "__init__.py").write_text(f"__version__ = {version!r}\n")
        body = "\n".join(lines) + f"\nPY={sys.executable}\n\"$PY\" -c " + check.group(1) + "\n"
        run = subprocess.run(["bash", "-c", body], cwd=ROOT, env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(fake.parent)},
                             capture_output=True, text=True)
        assert (run.returncode == 0) is ok, (version, run.stderr)
