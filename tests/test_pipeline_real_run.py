"""New DAF-seq run with the REAL fiberhmm-pipeline (no stand-in), through the wizard's API.

scan -> validate -> submit -> poll, as DafRunWizard does, on a tiny synthetic
input (tests/synthetic_runs.py), then the called BAM itself: index, FiberHMM
tags, every read kept, and the recorded settings read back. Skips when
FiberHMM 3 or an aligner is not installed in this Python.
"""
from __future__ import annotations

import os
import time

import pytest

import synthetic_runs as synth

pysam = pytest.importorskip("pysam")

# What fiberhmm-call 3.x writes on a called read (docs/workflows/calling.md "Calls").
FIBERHMM_TAGS = ("ns", "nl", "as", "al", "nq", "MA", "AQ")
# The wizard's defaults (frontend utils/dafRun.ts DEFAULT_OPTIONS), as buildRunRequest sends them.
WIZARD_OPTIONS = {"dedup": "auto", "dedup_mode": "flag", "snp_screen": "auto", "snp_mask": "",
                  "chimera_filter": True, "alignments": "primary-supplementary", "prob_threshold": None,
                  "use_m5c": "auto", "cpg_mask_policy": "unmethylated-only"}


@pytest.fixture
def real_pipeline(monkeypatch, tmp_path, client):
    monkeypatch.delenv("FIBERBROWSER_PIPELINE_COMMAND", raising=False)
    monkeypatch.delenv("FIBERBROWSER_CALL_COMMAND", raising=False)
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_NO_CAFFEINATE", "1")
    monkeypatch.setenv("FIBERHMM_MINIMAP2_INDEX_DIR", str(tmp_path / "mmi"))  # never ~/.fiberhmm
    monkeypatch.setenv("FIBERHMM_NO_UPDATE_CHECK", "1")
    # A finished run joins the Library in the background: this test's own scratch Library.
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_QC_CACHE_DIR", str(tmp_path / "qc_cache"))
    from services import pipeline_inputs as pi
    pi._help_cache.clear()
    command = pi.pipeline_command()
    if command.get("source") not in ("fiberhmm", "path"):
        pytest.skip("fiberhmm-pipeline (FiberHMM 3) is not installed for this Python")
    if not pi.aligner_status(command).get("ok"):
        pytest.skip("no aligner (minimap2 or mappy) for fiberhmm-pipeline")
    return client


def _wait_done(client, job_id: str, timeout: float = 240.0) -> dict:
    from services.pipeline_jobs import get_job_manager
    manager = get_job_manager()
    deadline = time.time() + timeout
    while time.time() < deadline:
        manager.tick()
        job = client.get(f"/api/pipeline/jobs/{job_id}").json()
        # A finished run's summary (read counts) is computed in the background after "done", as the UI polls it.
        if job["status"] in ("error", "cancelled", "interrupted") or (job["status"] == "done" and job.get("summary")):
            return job
        time.sleep(0.25)
    raise AssertionError(f"job {job_id} did not finish; log:\n{client.get(f'/api/pipeline/jobs/{job_id}/log').text}")


def _submit_like_the_wizard(client, reads_path: str, fasta: str, enzyme: str, outdir: str) -> tuple[dict, dict]:
    scan = client.post("/api/pipeline/scan", json={"paths": [reads_path], "input_kind": "reads"}).json()
    assert scan["success"], scan
    (sample,) = scan["samples"]
    body = {"samples": [{"name": sample["name"], "files": sample["files"]}],
            "reference": {"kind": "file", "path": fasta}, "regions": [], "enzyme": enzyme,
            "output_root": outdir, "cores": 2, "options": dict(WIZARD_OPTIONS), "auto_open": False,
            "input_kind": "reads"}
    check = client.post("/api/pipeline/validate", json=body).json()
    assert check["ok"], check["errors"]
    submitted = client.post("/api/pipeline/jobs", json=body).json()
    assert submitted["success"], submitted
    (job,) = submitted["jobs"]
    return _wait_done(client, job["id"]), sample


def _assert_called_bam(job: dict, names: set[str]) -> dict:
    assert job["status"] == "done", (job.get("error"), job.get("hint"))
    outputs = job["outputs"]
    called = outputs["called_bam"]
    assert os.path.isfile(called) and os.path.isfile(called + ".bai")
    with pysam.AlignmentFile(called) as bam:
        assert bam.check_index()
        records = [r for r in bam.fetch(until_eof=True) if not (r.is_secondary or r.is_supplementary)]
    # Every input read is in the called BAM once (nothing dropped, nothing doubled).
    assert sorted(r.query_name for r in records) == sorted(names)
    called_reads = [r for r in records if r.has_tag("ns") or r.has_tag("as")]
    assert len(called_reads) == len(records), "reads left uncalled"
    for tag in FIBERHMM_TAGS:
        assert all(r.has_tag(tag) for r in called_reads), f"{tag} missing"
    assert sum(len(r.get_tag("ns")) for r in called_reads) > len(called_reads)  # footprints were found
    return outputs


def test_wizard_api_runs_the_real_pipeline_to_a_called_bam(real_pipeline, tmp_path):
    client = real_pipeline
    genome = synth.random_genome()
    fasta = synth.write_fasta(tmp_path / "genome.fa", genome)
    reads = synth.daf_reads(genome, n=60)
    fastq = synth.write_fastq(tmp_path / "synthetic_daf.fastq", reads)
    job, sample = _submit_like_the_wizard(client, fastq, fasta, "dddb", str(tmp_path / "runs" / "r1"))
    outputs = _assert_called_bam(job, {name for name, _ in reads})
    assert outputs["enzyme"] == "dddb" and outputs["sample"] == sample["name"]

    # The UI's summary and steps come from the real pipeline's progress stream.
    assert job["summary"]["reads_aligned"] == len(reads) and job["summary"]["reads_called"] == len(reads)
    steps = {s["name"]: s["status"] for s in job["progress"]["steps"]}
    assert steps and set(steps.values()) <= {"done", "skipped"} and steps["call"] == "done"

    # The recorded settings are the wizard's defaults, and FiberBrowser serves them as written.
    import json
    recorded = json.loads(open(os.path.join(job["outdir"], "outputs.json")).read())["settings"]
    assert outputs["settings"] == recorded
    assert (recorded["enzyme"], recorded["dedup"], recorded["dedup_mode"], recorded["snp_screen"]) == \
        ("dddb", "auto", "flag", "auto")
    assert recorded["chimera_filter"] is True and recorded["alignments"] == "primary-supplementary"
    assert recorded["prob_threshold"] == "auto" and recorded["snp_mask"] is None

    # Library > Re-call rebuilds the run from those settings: the real pipeline parser reads them back
    # unchanged, the chimera mode FiberHMM records in call_args included (once, not once per re-call).
    _assert_recall_round_trip(job, recorded, tmp_path)
    assert recorded["call_args"] == ["--chimeras", "flag"]


def _recall_settings(job: dict, tmp_path) -> dict:
    parser = pytest.importorskip("fiberhmm.cli.pipeline")
    from services import library_inspect as inspect
    from services import library_jobs as jobs
    from services import library_store as store
    from services import pipeline_inputs as pi
    from services.library_hooks import wait_idle
    wait_idle(20)  # the finished run's own background Library import, before recording here
    entry_id = store.record(inspect.inspect_file(job["outputs"]["called_bam"]))["id"]
    plan = jobs.plan_recall(store.load()["entries"][entry_id], outdir=str(tmp_path / "recall"))
    args = pi.pipeline_args(reads=plan["reads"], reference=plan["reference"]["path"], enzyme=plan["enzyme"],
                            outdir=plan["outdir"], sample=plan["sample"], cores=plan["cores"],
                            progress=str(tmp_path / "p.jsonl"), regions=plan["regions"], extra=plan["extra"])
    plan["entry"] = store.load()["entries"][entry_id]
    return parser.config_from_args(parser.parse_args(args)).calling_settings(), plan


def _assert_recall_round_trip(job: dict, recorded: dict, tmp_path) -> dict:
    again, plan = _recall_settings(job, tmp_path)
    compare = dict(recorded)
    compare.pop("basecaller", None)  # provenance read from the inputs, not a calling setting
    if not _records_chimeras_once():
        # FiberHMM 3.0.3 repeats --chimeras when the re-call passes it back; same mode, last one wins.
        again = dict(again, call_args=_drop_repeated_chimeras(again.get("call_args") or []))
    assert {k: again.get(k) for k in compare} == compare
    return plan


def _records_chimeras_once() -> bool:
    import tempfile
    parser = pytest.importorskip("fiberhmm.cli.pipeline")
    with tempfile.TemporaryDirectory() as tmp:
        argv = ["a.bam", "--reference", "ref.fa", "--enzyme", "dddb", "-o", tmp, "--call-args", "--chimeras flag"]
        settings = parser.config_from_args(parser.parse_args(argv)).calling_settings()
    return settings["call_args"].count("--chimeras") == 1


def _drop_repeated_chimeras(call_args: list) -> list:
    out, seen = [], False
    i = 0
    while i < len(call_args):
        if call_args[i] == "--chimeras" and i + 1 < len(call_args):
            if not seen:
                out += call_args[i:i + 2]
            seen = True
            i += 2
            continue
        out.append(call_args[i])
        i += 1
    return out


@pytest.mark.parametrize("aligned", [True, False], ids=["aligned", "unaligned"])
def test_wizard_api_runs_a_pacbio_hia5_bam(real_pipeline, tmp_path, aligned):
    """Hia5 Fiber-seq from reads with MM/ML m6A calls (no kinetics): the platform comes from the reads."""
    client = real_pipeline
    genome = synth.random_genome()
    fasta = synth.write_fasta(tmp_path / "genome.fa", genome)
    bam = tmp_path / "synthetic_hia5.bam"
    names = synth.write_hia5_pacbio_bam(bam, genome, n=40, aligned=aligned)
    status = client.get("/api/pipeline/status").json()
    assert {e["id"]: e["raw_only"] for e in status["enzymes"]}["hia5"] is False
    job, sample = _submit_like_the_wizard(client, str(bam), fasta, "hia5", str(tmp_path / "runs" / "h1"))
    outputs = _assert_called_bam(job, set(names))
    assert outputs["enzyme"] == "hia5" and outputs["sample"] == sample["name"]
    assert job["summary"]["reads_called"] == len(names)
    if not aligned:
        assert job["summary"]["reads_aligned"] == len(names)

    import json
    recorded = json.loads(open(os.path.join(job["outdir"], "outputs.json")).read())["settings"]
    assert outputs["settings"] == recorded
    assert recorded["enzyme"] == "hia5" and recorded["seq"] == "pacbio"  # detected from the T-a MM spec
    # m6A calls kept: the called reads still carry MM/ML.
    with pysam.AlignmentFile(outputs["called_bam"]) as called:
        assert all(r.has_tag("MM") and r.has_tag("ML") for r in called.fetch(until_eof=True))

    # Library > Re-call of a Hia5 run: the same settings back through the real pipeline parser, with none of
    # DAF-seq's options passed (the run records them as off) and none listed as a change.
    plan = _assert_recall_round_trip(job, recorded, tmp_path)
    assert plan["enzyme"] == "hia5" and plan["extra"][:2] == ["--seq", "pacbio"]
    daf_flags = {"--dedup", "--dedup-mode", "--snp-screen", "--snp-mask", "--no-chimera-filter", "--use-m5c",
                 "--no-use-m5c", "--cpg-mask-policy"}
    assert not daf_flags & set(plan["extra"]), plan["extra"]
    assert not any(label.startswith(("duplicates", "SNP", "keep chimeras", "CpG")) for label in plan["settings"]["labels"])
    if aligned:
        # ...and the re-call itself runs, keeps every read and gives the same calls.
        from services import library_jobs as jobs
        from services.pipeline_jobs import get_job_manager
        recall = jobs.submit_recall(plan["entry"], outdir=plan["outdir"], cores=plan["cores"], plan_id=plan["plan_id"])
        manager = get_job_manager()
        deadline = time.time() + 240
        while manager.state(recall["id"]).get("status") in ("queued", "running", "cancelling") and time.time() < deadline:
            manager.tick()
            time.sleep(0.25)
        state = manager.state(recall["id"])
        assert state["status"] == "done", manager.read_log(recall["id"])
        assert state["outputs"]["enzyme"] == "hia5"

        def calls(path):
            with pysam.AlignmentFile(path) as bam:
                return {r.query_name: tuple(tuple(r.get_tag(t)) if hasattr(r.get_tag(t), "__len__") else r.get_tag(t)
                                            for t in FIBERHMM_TAGS)
                        for r in bam.fetch(until_eof=True) if not (r.is_secondary or r.is_supplementary)}
        assert calls(state["outputs"]["called_bam"]) == calls(outputs["called_bam"])


@pytest.fixture
def pipeline_without_aligner(monkeypatch, tmp_path, client):
    """The real fiberhmm-pipeline with no minimap2 anywhere: the tool resolver finds none and the
    job's PATH holds none (mappy is not importable in a run that needs it either)."""
    import shutil
    from services import external_tools as et
    from services import pipeline_inputs as pi
    monkeypatch.delenv("FIBERBROWSER_PIPELINE_COMMAND", raising=False)
    monkeypatch.delenv("FIBERBROWSER_CALL_COMMAND", raising=False)
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_NO_CAFFEINATE", "1")
    monkeypatch.setenv("FIBERHMM_MINIMAP2_INDEX_DIR", str(tmp_path / "mmi"))
    monkeypatch.setenv("FIBERHMM_NO_UPDATE_CHECK", "1")
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_QC_CACHE_DIR", str(tmp_path / "qc_cache"))
    pi._help_cache.clear()
    command = pi.pipeline_command()
    if command.get("source") not in ("fiberhmm", "path"):
        pytest.skip("fiberhmm-pipeline (FiberHMM 3) is not installed for this Python")
    try:
        import mappy  # noqa: F401
        pytest.skip("mappy is importable: the pipeline would align with it")
    except ImportError:
        pass
    import sys
    minimal = os.pathsep.join(["/usr/bin", "/bin", "/usr/sbin", "/sbin", os.path.dirname(sys.executable)])
    if shutil.which("minimap2", path=minimal):
        pytest.skip("minimap2 is installed in a system folder")
    monkeypatch.setenv("PATH", minimal)
    real_resolve = et.resolve
    monkeypatch.setattr(et, "resolve",
                        lambda name, *a, **k: et.ToolInfo(name=name) if name == "minimap2" else real_resolve(name, *a, **k))
    monkeypatch.setattr(et, "_shim_dir", None)
    return client


def test_fastq_without_an_aligner_is_refused_with_how_to_install(pipeline_without_aligner, tmp_path):
    client = pipeline_without_aligner
    genome = synth.random_genome()
    fasta = synth.write_fasta(tmp_path / "genome.fa", genome)
    fastq = synth.write_fastq(tmp_path / "synthetic_daf.fastq", synth.daf_reads(genome, n=4))
    scan = client.post("/api/pipeline/scan", json={"paths": [fastq], "input_kind": "reads"}).json()
    (sample,) = scan["samples"]
    body = {"samples": [{"name": sample["name"], "files": sample["files"]}],
            "reference": {"kind": "file", "path": fasta}, "regions": [], "enzyme": "dddb",
            "output_root": str(tmp_path / "runs" / "f1"), "cores": 2, "options": dict(WIZARD_OPTIONS),
            "auto_open": False, "input_kind": "reads"}
    check = client.post("/api/pipeline/validate", json=body).json()
    assert not check["ok"]
    (error,) = [e for e in check["errors"] if e["field"] == "aligner"]
    assert "minimap2" in error["message"] and "install" in error["hint"].lower()
    assert not client.post("/api/pipeline/jobs", json=body).json()["success"]


def test_an_aligned_daf_bam_runs_without_an_aligner(pipeline_without_aligner, tmp_path):
    """A DAF BAM already aligned to the reference (MD tags, index) is called in place by fiberhmm-pipeline,
    which needs no minimap2 for it: the wizard lets it run (with a warning) instead of refusing it."""
    client = pipeline_without_aligner
    genome = synth.random_genome()
    fasta = synth.write_fasta(tmp_path / "genome.fa", genome)
    bam = tmp_path / "synthetic_daf.bam"
    names = synth.write_daf_aligned_bam(bam, genome, n=40)
    scan = client.post("/api/pipeline/scan", json={"paths": [str(bam)], "input_kind": "reads"}).json()
    (scanned,) = scan["samples"]
    check = client.post("/api/pipeline/validate", json={
        "samples": [{"name": scanned["name"], "files": scanned["files"]}], "reference": {"kind": "file", "path": fasta},
        "regions": [], "enzyme": "dddb", "output_root": str(tmp_path / "runs" / "d0"), "cores": 2,
        "options": dict(WIZARD_OPTIONS), "auto_open": False, "input_kind": "reads"}).json()
    assert check["ok"] and any("minimap2 is not installed" in w for w in check["warnings"]), check
    job, sample = _submit_like_the_wizard(client, str(bam), fasta, "dddb", str(tmp_path / "runs" / "d1"))
    outputs = _assert_called_bam(job, set(names))
    assert outputs["enzyme"] == "dddb" and outputs["sample"] == sample["name"]
    steps = {s["name"]: s["status"] for s in job["progress"]["steps"]}
    assert steps.get("align") in (None, "skipped") and steps["call"] == "done"


def test_aligned_bams_that_need_realigning_still_need_an_aligner(pipeline_without_aligner, tmp_path):
    """Two aligned BAMs in one sample are realigned together (fiberhmm-pipeline), and a BAM without an
    index is realigned too: both still need minimap2."""
    client = pipeline_without_aligner
    genome = synth.random_genome()
    fasta = synth.write_fasta(tmp_path / "genome.fa", genome)
    a, b = tmp_path / "a.bam", tmp_path / "b.bam"
    synth.write_daf_aligned_bam(a, genome, n=4, seed=1)
    synth.write_daf_aligned_bam(b, genome, n=4, seed=2)
    unindexed = tmp_path / "c.bam"
    synth.write_daf_aligned_bam(unindexed, genome, n=4, seed=3)
    os.remove(str(unindexed) + ".bai")
    for files in ([str(a), str(b)], [str(unindexed)]):
        body = {"samples": [{"name": "s", "files": [{"path": p, "kind": "bam"} for p in files]}],
                "reference": {"kind": "file", "path": fasta}, "regions": [], "enzyme": "dddb",
                "output_root": str(tmp_path / "runs" / "x"), "cores": 2, "options": dict(WIZARD_OPTIONS),
                "auto_open": False, "input_kind": "reads"}
        check = client.post("/api/pipeline/validate", json=body).json()
        assert not check["ok"] and any(e["field"] == "aligner" for e in check["errors"]), (files, check)
