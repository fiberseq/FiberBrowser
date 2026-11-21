"""Library "Run QC" with the real fiberhmm-qc (no FIBERBROWSER_QC_COMMAND stand-in).

test_library_qc_run.py drives the Library route with a fake QC script; this runs the
FiberHMM QC module FiberBrowser finds on its own, on a small DddA BAM, and checks that
the Library's verdicts are the ones in the JSON fiberhmm-qc wrote.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pysam
import pytest

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing")


def _small_daf_bam(path: Path, n_reads: int = 120) -> str:
    """The first reads of the tracked DddA demo, renamed, as their own indexed BAM."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(DEMO_BAM)) as src, pysam.AlignmentFile(str(path), "wb", template=src) as out:
        for i, read in enumerate(src):
            if i >= n_reads:
                break
            read.query_name = f"synthetic-read-{i:04d}"
            out.write(read)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def env(tmp_path, monkeypatch):
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_QC_CACHE_DIR", str(tmp_path / "qc_cache"))
    monkeypatch.delenv("FIBERBROWSER_QC_COMMAND", raising=False)
    from services import pipeline_inputs
    monkeypatch.setattr(pipeline_inputs, "catalog_genome_fasta", lambda genome: (None, "not downloaded"))
    return tmp_path


def test_run_qc_runs_the_real_fiberhmm_qc_and_the_library_shows_its_verdicts(client, env):
    from services import qc_view
    command = qc_view.qc_command()
    assert command["argv"], command.get("hint")  # FiberHMM is a hard dependency of this suite
    assert "fake" not in " ".join(command["argv"])

    bam = _small_daf_bam(env / "d" / "small.bam")
    entry_id = client.post("/api/library/entries", json={"paths": [bam]}).json()["ids"][0]
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is True, body
    assert body["enzyme"] == "ddda"

    # What fiberhmm-qc itself wrote into FiberBrowser's cache folder.
    folder = env / "qc_cache" / body["cache_key"]
    (qc_json,) = [p for p in folder.iterdir() if p.name.endswith(".qc.json")]
    real = json.loads(qc_json.read_text())
    assert real["overall"]["status"] in ("PASS", "WARN", "FAIL")
    assert body["qc"]["overall"] == real["overall"]
    curves = [p for p in folder.iterdir() if p.name.endswith(".qc.curves.json")]
    assert curves and body["curves"]["schema"] == json.loads(curves[0].read_text())["schema"]

    # The Library row carries the same verdicts, section by section.
    listed = next(e for e in client.get("/api/library").json()["entries"] if e["id"] == entry_id)
    verdicts = listed["qc"]["verdicts"]
    assert verdicts["overall"] == real["overall"]["status"]
    for section in ("signal", "periodicity"):
        if isinstance(real.get(section), dict) and "status" in real[section]:
            assert verdicts[section] == real[section]["status"]

    # The plot route serves the PNG fiberhmm-qc drew, and nothing was written beside the BAM.
    plot = client.get(body["plots"]["plot"])
    assert plot.status_code == 200 and plot.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert sorted(os.listdir(env / "d")) == ["small.bam", "small.bam.bai"]
