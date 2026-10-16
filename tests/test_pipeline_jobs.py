"""New DAF-seq run: read scanning, argv construction, the job registry and queue, routes.

The pipeline is tests/fake_fiberhmm_pipeline.py, a contract-v1 stand-in for
fiberhmm-pipeline (FIBERBROWSER_PIPELINE_COMMAND).
"""
from __future__ import annotations

import gzip
import json
import os
import shlex
import subprocess
import sys
import time
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(HERE, "fake_fiberhmm_pipeline.py")
FAKE_COMMAND = f"{shlex.quote(sys.executable)} {shlex.quote(FAKE)}"


@pytest.fixture
def fake_env(monkeypatch, tmp_path):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", FAKE_COMMAND)
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_NO_CAFFEINATE", "1")
    monkeypatch.setenv("FAKE_PIPELINE_STEP_S", "0.05")
    monkeypatch.delenv("FAKE_PIPELINE_MODE", raising=False)
    from services import pipeline_inputs
    pipeline_inputs._help_cache.clear()
    yield tmp_path


def _fastq(path, n=3):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "wt") as handle:
        for i in range(n):
            handle.write(f"@r{i}\nACGTACGT\n+\nIIIIIIII\n")
    return str(path)


def _fasta(path):
    path.write_text(">chrT\n" + "ACGT" * 50 + "\n")
    return str(path)


def _wait(manager, job_id, statuses, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        manager.tick()
        state = manager.state(job_id)
        if state.get("status") in statuses:
            return state
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} stayed {manager.state(job_id)}; log:\n{manager.read_log(job_id)}")


def _wait_started(manager, job_id, timeout=30.0):
    """Running, and the pipeline has written its start event (its signal handler is set)."""
    _wait(manager, job_id, ("running",), timeout)
    deadline = time.time() + timeout
    while not manager.describe(job_id)["progress"]["started"]:
        assert time.time() < deadline, manager.read_log(job_id)
        time.sleep(0.05)


def _spec(tmp_path, sample="s1", cores=1, extra_env=None, outdir=None):
    from services import pipeline_inputs as pi
    reads = _fastq(tmp_path / f"{sample}.fastq")
    ref = _fasta(tmp_path / "ref.fa")
    outdir = outdir or str(tmp_path / "runs" / sample)
    from services.pipeline_jobs import new_job_id
    job_id = new_job_id()
    progress = str(tmp_path / "jobs" / job_id / "progress.jsonl")
    args = pi.pipeline_args(reads=[reads], reference=ref, enzyme="dddb", outdir=outdir, sample=sample,
                            cores=cores, progress=progress)
    return {"id": job_id, "sample": sample, "enzyme": "dddb", "outdir": outdir, "cores": cores,
            "argv": [*shlex.split(FAKE_COMMAND), *args], "env": extra_env or {},
            "display_command": pi.display_command(args)}


# --------------------------------------------------------------------------
# Reads and samples
# --------------------------------------------------------------------------

def test_scan_groups_plasmidsaurus_files_by_barcode(tmp_path):
    from services.pipeline_inputs import scan_reads
    delivery = tmp_path / "ABC123_results"
    delivery.mkdir()
    _fastq(delivery / "ABC123_1_rerun_sample_a.fastq.gz")
    _fastq(delivery / "ABC123_2_yw 2-4h.fastq")
    _fastq(delivery / "ABC123_10_zen.fastq")
    (delivery / "ABC123_1_report.html").write_text("<html/>")
    result = scan_reads([str(delivery)])
    names = [(s["barcode"], s["name"]) for s in result["samples"]]
    assert names == [("1", "rerun_sample_a"), ("2", "yw_2-4h"), ("10", "zen")]
    assert all(s["order"] == "ABC123" for s in result["samples"])


def test_scan_prefers_fastq_over_provider_bams_and_names_are_unique(tmp_path):
    from services.pipeline_inputs import scan_reads
    _fastq(tmp_path / "a.fastq")
    _fastq(tmp_path / "a.fq.gz")
    (tmp_path / "a.bam").write_bytes(b"not really")
    result = scan_reads([str(tmp_path / "a.fastq"), str(tmp_path / "a.fq.gz"), str(tmp_path / "a.bam")])
    assert [s["name"] for s in result["samples"]] == ["a", "a_2"]
    assert any("BAM" in w for w in result["warnings"])


def test_scan_rejects_non_read_files(tmp_path):
    from services.pipeline_inputs import InputError, scan_reads
    (tmp_path / "notes.txt").write_text("x")
    with pytest.raises(InputError):
        scan_reads([str(tmp_path / "notes.txt")])
    with pytest.raises(InputError):
        scan_reads([str(tmp_path / "missing.fastq")])


def test_zip_is_listed_then_extracted_into_the_run_folder(tmp_path):
    from services.pipeline_inputs import extract_zip_members, scan_reads
    archive = tmp_path / "ABCDEF.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("ABCDEF/ABCDEF_1_sampleA.fastq", "@r\nACGT\n+\nIIII\n")
        z.writestr("ABCDEF/ABCDEF_2_sampleB.fastq", "@r\nACGT\n+\nIIII\n")
        z.writestr("__MACOSX/ABCDEF/._ABCDEF_1_sampleA.fastq", "junk")
        z.writestr("ABCDEF/summary.pdf", "pdf")
    result = scan_reads([str(archive)])
    assert [s["name"] for s in result["samples"]] == ["sampleA", "sampleB"]
    member = result["samples"][0]["files"][0]["member"]
    dest = tmp_path / "run" / "reads"
    out = extract_zip_members(str(archive), [member], str(dest))
    assert os.path.isfile(out[member]) and out[member].startswith(str(dest))


def test_zip_slip_is_refused(tmp_path):
    from services.pipeline_inputs import extract_zip_members
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("../../outside.fastq", "@r\nA\n+\nI\n")
    out = extract_zip_members(str(archive), ["../../outside.fastq"], str(tmp_path / "dest"))
    # '..' parts are dropped: the file lands inside dest (in the archive's own folder), never outside it.
    landed = out["../../outside.fastq"]
    assert os.path.dirname(os.path.dirname(landed)) == str(tmp_path / "dest")
    assert os.path.basename(landed) == "outside.fastq" and os.path.basename(os.path.dirname(landed)).startswith("evil-")
    assert not (tmp_path.parent / "outside.fastq").exists()


# --------------------------------------------------------------------------
# argv construction
# --------------------------------------------------------------------------

def test_pipeline_args_are_one_item_per_value(tmp_path):
    from services.pipeline_inputs import display_command, pipeline_args
    weird = str(tmp_path / "my reads; rm -rf ~.fastq")
    args = pipeline_args(reads=[weird], reference="/refs/dm6 copy.fa", enzyme="dddb", outdir="/out $HOME",
                         sample="s1", cores=2, progress="/j/p.jsonl", regions=["chr2L:1-100"])
    assert args == [weird, "--reference", "/refs/dm6 copy.fa", "--enzyme", "dddb", "-o", "/out $HOME",
                    "--sample", "s1", "--cores", "2", "--progress-json", "/j/p.jsonl", "--region", "chr2L:1-100"]
    # The copyable command quotes every value (and is never executed).
    assert shlex.split(display_command(args))[1:] == args


def test_option_flags_follow_the_pipelines_help():
    from services.pipeline_inputs import InputError, normalize_options, option_args
    choice_help = "  --dedup {auto,on,off}\n  --dedup-mode {flag,collapse}\n  --snp-screen {auto,on,off}\n" \
                  "  --snp-mask SNP_MASK\n  --chimera-filter, --no-chimera-filter\n  --primary, --no-primary\n  --prob-threshold N\n"
    bool_help = "  --dedup, --no-dedup\n  --dedup-collapse\n  --daf-call-snps\n  --no-daf-call-snps\n"
    # primary_only false (a run record from before --alignments) is every alignment.
    options = normalize_options({"dedup": "off", "snp_screen": "on", "primary_only": False, "chimera_filter": False})
    assert options["alignments"] == "all"
    assert option_args(options, "dddb", choice_help) == ["--dedup", "off", "--snp-screen", "on", "--no-chimera-filter",
                                                         "--no-primary"]
    with pytest.raises(InputError, match="no option"):
        option_args(options, "dddb", bool_help)  # no --no-primary or chimera switch there
    options = normalize_options({"dedup": "on", "dedup_mode": "collapse", "snp_screen": "off"})
    assert option_args(options, "dddb", bool_help) == ["--dedup", "--dedup-collapse", "--no-daf-call-snps"]
    # FiberHMM 3.0 spells the alignment set --alignments (--primary/--no-primary are its aliases);
    # its default (primary-supplementary) adds nothing.
    help3 = choice_help + "  --alignments {primary,primary-supplementary,all}\n"
    assert option_args(normalize_options({"alignments": "all"}), "dddb", help3) == ["--alignments", "all"]
    assert option_args(normalize_options({"alignments": "primary"}), "dddb", help3) == ["--alignments", "primary"]
    assert option_args(normalize_options({}), "dddb", help3) == []
    with pytest.raises(InputError, match="Alignments"):
        normalize_options({"alignments": "secondary"})
    # Defaults add nothing; DddA-only options are ignored for DddB.
    assert option_args(normalize_options({"use_m5c": "off"}), "dddb", choice_help) == []
    with pytest.raises(InputError):
        normalize_options({"prob_threshold": 300})


def test_jobs_are_started_with_an_argv_list_never_a_shell(fake_env, monkeypatch):
    from services import pipeline_jobs
    seen = []
    real = subprocess.Popen

    def spy(args, *a, **kw):
        seen.append((args, kw))
        return real(args, *a, **kw)

    monkeypatch.setattr(pipeline_jobs.subprocess, "Popen", spy)
    manager = pipeline_jobs.JobManager(str(fake_env / "jobs"), total_cores=4)
    job = manager.create(_spec(fake_env))
    _wait(manager, job["id"], ("done",))
    launches = [(args, kw) for args, kw in seen if FAKE in args]
    assert launches, seen
    args, kw = launches[0]
    assert isinstance(args, list) and not kw.get("shell")
    assert kw.get("start_new_session") is True  # detached: survives the server
    recorded = json.load(open(os.path.join(manager.spec(job["id"])["outdir"], "fake_argv.json")))
    assert recorded[1:] == manager.spec(job["id"])["argv"][2:]


# --------------------------------------------------------------------------
# Registry and queue
# --------------------------------------------------------------------------

def test_job_runs_to_done_with_progress_outputs_and_summary(fake_env):
    from services.pipeline_jobs import JobManager
    manager = JobManager(str(fake_env / "jobs"), total_cores=4)
    job = manager.create(_spec(fake_env))
    assert job["status"] in ("queued", "running")
    _wait(manager, job["id"], ("done",))
    info = manager.describe(job["id"])
    steps = {s["name"]: s["status"] for s in info["progress"]["steps"]}
    assert steps == {"prepare_reference": "done", "index": "done", "align": "done", "call": "done", "qc": "done"}
    assert info["outputs"]["open"]["datasets"] == [info["outputs"]["called_bam"]]
    for name in ("spec.json", "state.json", "progress.jsonl", "log"):
        assert os.path.isfile(os.path.join(manager.job_dir(job["id"]), name))
    deadline = time.time() + 20
    while manager.describe(job["id"]).get("summary") is None and time.time() < deadline:
        time.sleep(0.1)
    summary = manager.describe(job["id"])["summary"]
    assert summary["reads_aligned"] > 0 and summary["duplicate_percent"] == 12.0  # QC's full-run fraction
    assert summary["footprints_per_read"] == 5.8  # (5000 + 800) / 1000 from the QC JSON


def test_queue_runs_jobs_within_the_core_budget(fake_env, monkeypatch):
    from services.pipeline_jobs import JobManager
    monkeypatch.setenv("FAKE_PIPELINE_STEP_S", "0.6")
    manager = JobManager(str(fake_env / "jobs"), total_cores=4)
    ids = [manager.create(_spec(fake_env, sample=f"s{i}", cores=3))["id"] for i in range(3)]
    manager.tick()
    running = [j for j in ids if manager.state(j)["status"] == "running"]
    assert len(running) == 1
    assert sum(manager.state(j)["status"] == "queued" for j in ids) == 2
    for job_id in ids:
        _wait(manager, job_id, ("done",), timeout=60)


def test_a_restarted_server_reconnects_to_a_running_job(fake_env, monkeypatch):
    from services.pipeline_jobs import JobManager
    monkeypatch.setenv("FAKE_PIPELINE_STEP_S", "1.0")
    first = JobManager(str(fake_env / "jobs"), total_cores=4)
    job_id = first.create(_spec(fake_env))["id"]
    _wait_started(first, job_id)
    pid = first.state(job_id)["pid"]
    first.stop()
    # A new server process: no Popen handle, only the registry on disk.
    second = JobManager(str(fake_env / "jobs"), total_cores=4)
    second.tick()
    assert second.state(job_id)["status"] == "running"
    assert second.describe(job_id)["progress"]["started"]
    first._procs[job_id].wait(timeout=30)  # the old server's child ends (reaped here)
    state = _wait(second, job_id, ("done",))
    assert state["pid"] == pid


@pytest.mark.skipif(os.name == "nt", reason="POSIX process identity")
def test_a_long_command_line_is_matched_in_full(tmp_path, monkeypatch):
    """Linux ps cut `ps -o command=` to 80 columns off a terminal, so the job's
    progress-file marker was missing and a restarted server (WSL) called a running
    job interrupted. Both the /proc reading and the ps fallback see the whole argv."""
    from services import pipeline_jobs as pj
    marker = str(tmp_path / ("deep" * 30) / "jobs" / "20260101-000000-abcdef" / "progress.jsonl")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "--progress", marker])
    try:
        monkeypatch.setenv("COLUMNS", "80")
        assert pj.process_matches(proc.pid, marker)
        real_open = open

        def no_proc(path, *args, **kwargs):
            if str(path).startswith("/proc/"):
                raise PermissionError(path)
            return real_open(path, *args, **kwargs)
        monkeypatch.setattr("builtins.open", no_proc)
        assert pj.process_matches(proc.pid, marker)
    finally:
        proc.kill()
        proc.wait()
    assert not pj.process_matches(proc.pid, marker)


def test_a_job_whose_process_vanished_is_interrupted(fake_env):
    from services.pipeline_jobs import JobManager
    manager = JobManager(str(fake_env / "jobs"), total_cores=4)
    job_id = manager.create(_spec(fake_env))["id"]
    manager.stop()
    # Pretend it ran under a server that died with it: a dead pid, no done event.
    manager._set_state(job_id, status="running", pid=999999, started_at=time.time())
    fresh = JobManager(str(fake_env / "jobs"), total_cores=4)
    fresh.tick()
    assert fresh.state(job_id)["status"] == "interrupted"


def test_cancel_a_running_and_a_queued_job(fake_env, monkeypatch):
    from services.pipeline_jobs import JobManager
    monkeypatch.setenv("FAKE_PIPELINE_STEP_S", "5")
    manager = JobManager(str(fake_env / "jobs"), total_cores=1)
    running = manager.create(_spec(fake_env, sample="a"))["id"]
    queued = manager.create(_spec(fake_env, sample="b"))["id"]
    _wait_started(manager, running)
    assert manager.state(queued)["status"] == "queued"
    assert manager.cancel(queued)["status"] == "cancelled"
    manager.cancel(running)
    state = _wait(manager, running, ("cancelled",), timeout=20)
    assert state["error"] == "cancelled"


def test_failure_reports_the_pipeline_error_and_retry_resumes(fake_env, monkeypatch):
    from services.pipeline_jobs import JobManager
    monkeypatch.setenv("FAKE_PIPELINE_MODE", "fail")
    manager = JobManager(str(fake_env / "jobs"), total_cores=4)
    job_id = manager.create(_spec(fake_env))["id"]
    state = _wait(manager, job_id, ("error",))
    assert "fiberhmm-call failed" in state["error"]
    assert "something broke" in manager.read_log(job_id)
    monkeypatch.setenv("FAKE_PIPELINE_MODE", "ok")
    manager.retry(job_id)
    _wait(manager, job_id, ("done",))
    steps = {s["name"]: s["status"] for s in manager.describe(job_id)["progress"]["steps"]}
    assert steps["align"] == "skipped" and steps["call"] == "done"  # completed steps reused
    assert manager.state(job_id)["attempt"] == 2


def test_missing_aligner_hint_is_kept(fake_env, monkeypatch):
    from services.pipeline_jobs import JobManager
    monkeypatch.setenv("FAKE_PIPELINE_MODE", "noaligner")
    manager = JobManager(str(fake_env / "jobs"), total_cores=4)
    job_id = manager.create(_spec(fake_env))["id"]
    state = _wait(manager, job_id, ("error",))
    assert state["hint"] == "brew install minimap2"


def test_progress_accepts_pre_contract_event_names():
    from services.pipeline_jobs import summarize_progress
    events = [
        {"event": "pipeline_start", "steps": ["align", "call"]},
        {"event": "step_start", "step": "align"},
        {"event": "step_progress", "step": "align", "fraction": 0.5, "eta_s": 12.0},
    ]
    progress = summarize_progress(events)
    assert progress["current_step"] == "align" and progress["eta_s"] == 12.0
    assert progress["fraction"] == pytest.approx(0.25)
    progress = summarize_progress(events + [{"event": "step_done", "step": "align"},
                                            {"event": "pipeline_failed", "error": "boom"}])
    assert progress["done"]["status"] == "error"


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@pytest.fixture
def api(fake_env, client):
    return client


def _run_body(tmp_path, **changes):
    reads = _fastq(tmp_path / "ABC123_1_mysample.fastq")
    body = {"samples": [{"name": "my sample", "files": [{"path": reads, "kind": "fastq"}]}],
            "reference": {"kind": "file", "path": _fasta(tmp_path / "ref.fa")},
            "enzyme": "dddb", "output_root": str(tmp_path / "FiberHMM runs" / "r1"), "cores": 1,
            "options": {"dedup": "off"}}
    body.update(changes)
    return body


def test_route_validate_reports_every_problem(api, fake_env):
    body = _run_body(fake_env, enzyme="hia5", reference={"kind": "file", "path": str(fake_env / "x.txt")},
                     samples=[], cores=10_000)
    (fake_env / "x.txt").write_text("x")
    result = api.post("/api/pipeline/validate", json=body).json()
    assert not result["ok"]
    assert {e["field"] for e in result["errors"]} >= {"enzyme", "reference", "reads", "cores"}


def test_route_submit_runs_the_job_and_serves_qc(api, fake_env):
    result = api.post("/api/pipeline/jobs", json=_run_body(fake_env)).json()
    assert result["success"], result
    job = result["jobs"][0]
    assert job["sample"] == "my_sample" and job["outdir"].endswith("r1")
    assert "--dedup off" in job["command"]
    from services.pipeline_jobs import get_job_manager
    _wait(get_job_manager(), job["id"], ("done",))
    detail = api.get(f"/api/pipeline/jobs/{job['id']}").json()
    assert detail["status"] == "done" and detail["outputs"]["open"]["region"]
    qc = api.get(f"/api/pipeline/jobs/{job['id']}/qc").json()
    assert qc["available"] and qc["qc"]["overall"]["status"] == "PASS"
    assert qc["curves"]["schema"] == "fiberhmm.qc.curves.v1"
    assert "fiberhmm-pipeline" in api.get(f"/api/pipeline/jobs/{job['id']}/log").text
    listed = api.get("/api/pipeline/jobs").json()["jobs"]
    assert job["id"] in [j["id"] for j in listed]
    assert api.delete(f"/api/pipeline/jobs/{job['id']}").json()["success"]
    assert api.get(f"/api/pipeline/jobs/{job['id']}").status_code == 404


def test_route_rejects_malformed_job_ids(api):
    assert api.get("/api/pipeline/jobs/..%2F..%2Fetc").status_code in (400, 404)
    assert api.get("/api/pipeline/jobs/not-a-job").status_code == 400


def test_public_mode_and_tour_tabs_refuse_pipeline_routes(api, monkeypatch, fake_env):
    from services import runtime
    monkeypatch.setattr(runtime, "_public_mode", True)
    for method, path in (("get", "/api/pipeline/status"), ("post", "/api/pipeline/jobs"),
                         ("get", "/api/pipeline/jobs"), ("post", "/api/qc/dataset")):
        response = getattr(api, method)(path, **({"json": {}} if method == "post" else {}))
        assert response.status_code == 403, (path, response.text)
    monkeypatch.setattr(runtime, "_public_mode", False)
    # A tour tab (sandbox) runs as a public visitor even on a local server.
    from routers.pipeline import local_only
    from fastapi import HTTPException
    token = runtime._sandbox_id.set("sb-test")
    try:
        with pytest.raises(HTTPException) as exc:
            local_only()
        assert exc.value.status_code == 403
    finally:
        runtime._sandbox_id.reset(token)


def test_scan_groups_minknow_barcode_folders(tmp_path):
    from services.pipeline_inputs import scan_reads
    for barcode in ("barcode01", "barcode02"):
        folder = tmp_path / "fastq_pass" / barcode
        folder.mkdir(parents=True)
        for i in range(3):
            _fastq(folder / f"FAX123_pass_{barcode}_abc_{i}.fastq.gz")
    result = scan_reads([str(tmp_path / "fastq_pass")])
    assert [(s["name"], len(s["files"])) for s in result["samples"]] == [("barcode01", 3), ("barcode02", 3)]


def test_keep_awake_uses_caffeinate_on_macos(monkeypatch):
    from services import pipeline_jobs
    calls = []
    monkeypatch.setattr(pipeline_jobs.sys, "platform", "darwin")
    monkeypatch.delenv("FIBERBROWSER_NO_CAFFEINATE", raising=False)
    monkeypatch.setattr(pipeline_jobs.shutil, "which", lambda name: "/usr/bin/caffeinate" if name == "caffeinate" else None)
    monkeypatch.setattr(pipeline_jobs.subprocess, "Popen", lambda args, **kw: calls.append((args, kw)))
    pipeline_jobs._keep_awake(4321)
    assert calls and calls[0][0] == ["/usr/bin/caffeinate", "-i", "-w", "4321"] and not calls[0][1].get("shell")
    calls.clear()
    monkeypatch.setattr(pipeline_jobs.sys, "platform", "linux")
    pipeline_jobs._keep_awake(4321)
    assert calls == []  # a no-op elsewhere
