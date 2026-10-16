"""Raw Nanopore (POD5) runs and basecaller provenance (FiberHMM 3.0's dorado step).

The wizard's POD5 input and basecall flags, the dorado status (services/external_tools.py),
the "basecall" progress step and its errors, outputs.json basecaller fields in the Library,
and Library re-calls that carry a basecaller override and never basecall again.
The pipeline is tests/fake_fiberhmm_pipeline.py; dorado is a stand-in script.
"""
from __future__ import annotations

import json
import os
import shlex
import stat
import sys
import time

import pytest

from library_fixtures import make_bam, make_fiberhmm_bam, make_pipeline_run, pipeline_settings, seq

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(HERE, "fake_fiberhmm_pipeline.py")
FAKE_COMMAND = f"{shlex.quote(sys.executable)} {shlex.quote(FAKE)}"
MODEL = "dna_r10.4.1_e8.2_400bps_sup@v5.2.0"
MODBASE = f"{MODEL}_6mA@v1"

FAKE_DORADO = """#!{python}
import sys
if sys.argv[1:2] == ["--version"]:
    sys.stderr.write("[2026-10-03 10:00:00.000] [info] Running: \\"--version\\"\\n")
    sys.stdout.write("2.0.1+fake\\n")
    sys.exit(0)
sys.exit(2)
"""


def _executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


@pytest.fixture
def tools(monkeypatch, tmp_path):
    """An isolated tool search: no real dorado from this computer (PATH, ~/.local/bin, /opt) is seen."""
    from services import external_tools as et
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("FIBERHMM_DORADO", raising=False)
    monkeypatch.delenv("CONDA_PREFIX", raising=False)
    monkeypatch.setenv("PATH", os.pathsep.join([str(tmp_path / "empty"), "/usr/bin", "/bin"]))
    monkeypatch.setattr(et, "common_dirs", lambda environ=None: [])
    monkeypatch.setattr(et, "dorado_install_dirs", lambda: [])
    monkeypatch.setattr(et, "_settings_candidates", lambda name: [])
    et.clear_cache()
    yield tmp_path
    et.clear_cache()


@pytest.fixture
def fake_dorado(tools):
    return _executable(tools / "dorado-2.0.1" / "bin" / "dorado", FAKE_DORADO.format(python=sys.executable))


@pytest.fixture
def fake_env(monkeypatch, tools):
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", FAKE_COMMAND)
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tools / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_NO_CAFFEINATE", "1")
    monkeypatch.setenv("FAKE_PIPELINE_STEP_S", "0.05")
    monkeypatch.delenv("FAKE_PIPELINE_MODE", raising=False)
    from services import pipeline_inputs
    pipeline_inputs._help_cache.clear()
    yield tools


def _on_path(monkeypatch, folder):
    monkeypatch.setenv("PATH", os.pathsep.join([str(folder), os.environ["PATH"]]))
    from services import external_tools as et
    et.clear_cache()


def _minknow_run(root, name="yw_2_4h", files=2):
    pod5 = root / name / "20261001_1200_P2S_FAX12345_abcd" / "pod5"
    pod5.mkdir(parents=True, exist_ok=True)
    for i in range(files):
        (pod5 / f"batch{i}.pod5").write_bytes(b"POD5 stand-in " * (i + 1))
    return pod5


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


# --------------------------------------------------------------------------
# dorado status (external_tools)
# --------------------------------------------------------------------------

def test_dorado_status_finds_a_version_printed_after_log_lines(fake_dorado, monkeypatch):
    from services import external_tools as et
    assert not et.dorado_status()["ok"]
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    status = et.dorado_status()
    assert status["ok"] and status["version"] == "2.0.1+fake" and status["path"] == fake_dorado
    assert status["label"] == f"dorado 2.0.1+fake ({fake_dorado})"
    # On the job's PATH too: the pipeline finds that same copy, so no --dorado is passed.
    assert et.dorado_pipeline_args() == []


def test_dorado_missing_gives_the_install_instructions(tools):
    from services import external_tools as et
    status = et.dorado_status()
    assert not status["ok"] and status["label"] == "dorado not found"
    assert "github.com/nanoporetech/dorado" in status["hint"]
    assert et.dorado_pipeline_args() == []  # the pipeline then reports it, with the same instructions


def test_dorado_found_only_by_fiberbrowser_is_passed_with_dorado(fake_dorado, monkeypatch):
    from services import external_tools as et
    # The user's setting (or a folder only FiberBrowser searches): the pipeline would not look there.
    monkeypatch.setattr(et, "_settings_candidates", lambda name: [fake_dorado] if name == "dorado" else [])
    et.clear_cache()
    assert et.dorado_status()["source"] == "settings"
    assert et.dorado_pipeline_args() == ["--dorado", fake_dorado]
    # $FIBERHMM_DORADO is what the pipeline runs first: the resolver shows that one.
    monkeypatch.setattr(et, "_settings_candidates", lambda name: [])
    monkeypatch.setenv("FIBERHMM_DORADO", os.path.dirname(os.path.dirname(fake_dorado)))  # the install folder
    et.clear_cache()
    assert et.dorado_status()["source"] == "environment" and et.dorado_status()["path"] == fake_dorado
    assert et.dorado_pipeline_args() == []


def test_a_broken_dorado_first_on_path_is_skipped(fake_dorado, monkeypatch, tools):
    from services import external_tools as et
    broken = _executable(tools / "broken" / "dorado", "#!/bin/sh\nexit 3\n")
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    _on_path(monkeypatch, os.path.dirname(broken))
    status = et.dorado_status()
    assert status["path"] == fake_dorado and [broken, "exited 3 without a version"] in status["rejected"]
    # The pipeline would try the broken one first: the job is told which dorado to run.
    assert et.dorado_pipeline_args() == ["--dorado", fake_dorado]


# --------------------------------------------------------------------------
# Scanning POD5 input
# --------------------------------------------------------------------------

def test_a_minknow_pod5_folder_is_one_sample_named_after_its_run(tmp_path):
    from services.pipeline_inputs import scan_reads
    pod5 = _minknow_run(tmp_path)
    (pod5 / "sub").mkdir()
    (pod5 / "sub" / "more.pod5").write_bytes(b"x")
    result = scan_reads([str(pod5)], "pod5")
    assert result["input_kind"] == "pod5" and len(result["samples"]) == 1
    sample = result["samples"][0]
    # MinKNOW's pod5/ folder is named after the run folder above it (the pipeline's own default).
    assert sample["name"] == "20261001_1200_P2S_FAX12345_abcd"
    assert sample["files"] == [{"path": str(pod5), "kind": "pod5", "size": sample["size"]}]
    assert sample["size"] == len(b"POD5 stand-in ") * 3 + 1


def test_loose_pod5_files_form_one_sample_per_folder(tmp_path):
    from services.pipeline_inputs import InputError, scan_reads
    a = tmp_path / "runA"
    a.mkdir()
    for name in ("x.pod5", "y.pod5"):
        (a / name).write_bytes(b"p")
    result = scan_reads([str(a / "x.pod5"), str(a / "y.pod5")], "pod5")
    assert [s["name"] for s in result["samples"]] == ["runA"]
    assert [f["path"] for f in result["samples"][0]["files"]] == [str(a / "x.pod5"), str(a / "y.pod5")]
    (tmp_path / "reads.fastq").write_text("@r\nA\n+\nI\n")
    with pytest.raises(InputError):
        scan_reads([str(tmp_path / "reads.fastq")], "pod5")
    empty = tmp_path / "empty"
    empty.mkdir()
    assert scan_reads([str(empty)], "pod5")["warnings"] == [f"{empty} has no POD5 files."]


def test_a_pod5_folder_picked_as_reads_points_to_the_pod5_option(tmp_path):
    from services.pipeline_inputs import scan_reads
    pod5 = _minknow_run(tmp_path)
    result = scan_reads([str(pod5)])
    assert result["samples"] == []
    assert any("Raw Nanopore (POD5)" in w for w in result["warnings"])


# --------------------------------------------------------------------------
# Basecall flags
# --------------------------------------------------------------------------

def test_basecall_defaults_add_no_flags_and_choices_follow_the_help():
    from services import pipeline_inputs as pi
    help_text = ("--dorado PATH --dorado-model MODEL --dorado-modified-bases CODES --dorado-device DEVICE "
                 "--dorado-batchsize N")
    default = pi.normalize_basecall({})
    assert default == {"model": "sup", "modified_bases": "auto", "device": "auto", "batchsize": None}
    for enzyme in ("hia5", "dddb", "ddda"):
        assert pi.basecall_args(default, enzyme, help_text) == []
    assert pi.basecall_labels(default, "hia5") == ["basecall: dorado sup + 6mA"]
    assert pi.basecall_labels(default, "dddb") == ["basecall: dorado sup (no modification model)"]
    # Hia5 without the 6mA model, and DAF-seq with one, are explicit.
    plain = pi.normalize_basecall({"modified_bases": "none"})
    assert pi.basecall_args(plain, "hia5", help_text) == ["--dorado-modified-bases", "none"]
    assert pi.basecall_args(plain, "dddb", help_text) == []
    mods = pi.normalize_basecall({"modified_bases": "6mA, 5mCG_5hmCG"})
    assert pi.basecall_args(mods, "dddb", help_text) == ["--dorado-modified-bases", "6mA 5mCG_5hmCG"]
    advanced = pi.normalize_basecall({"model": "hac@v5.2.0", "device": "metal", "batchsize": "128"})
    assert pi.basecall_args(advanced, "hia5", help_text) == [
        "--dorado-model", "hac@v5.2.0", "--dorado-device", "metal", "--dorado-batchsize", "128"]
    assert pi.basecall_labels(advanced, "hia5") == ["basecall: dorado hac@v5.2.0 + 6mA", "device metal", "batch 128"]
    assert pi.effective_modified_bases(pi.normalize_basecall({"model": "sup,6mA"}), "dddb") == "6mA"
    for bad in ({"model": "--evil"}, {"device": "gpu"}, {"batchsize": -1}, {"modified_bases": "6mA;rm"},
                {"model": "sup,6mA", "modified_bases": "6mA"}, {"model": "/no/such/model/folder"}):
        with pytest.raises(pi.InputError):
            pi.normalize_basecall(bad)
    # A pipeline without the dorado step (before FiberHMM 3.0) is refused up front.
    with pytest.raises(pi.InputError, match="cannot basecall"):
        pi.basecall_args(default, "hia5", "--reference REF")


def test_a_model_folder_is_made_absolute(tmp_path, monkeypatch):
    from services import pipeline_inputs as pi
    folder = tmp_path / "models" / MODEL
    folder.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    assert pi.normalize_basecall({"model": f"models/{MODEL}"})["model"] == str(folder)


# --------------------------------------------------------------------------
# The wizard's request -> jobs
# --------------------------------------------------------------------------

@pytest.fixture
def api(fake_env, client):
    return client


def _pod5_body(tmp_path, **changes):
    pod5 = _minknow_run(tmp_path / "data")
    body = {"input_kind": "pod5",
            "samples": [{"name": "yw_2_4h", "files": [{"path": str(pod5), "kind": "pod5", "size": 10}]}],
            "reference": {"kind": "file", "path": _fasta(tmp_path / "ref.fa")},
            "enzyme": "hia5", "output_root": str(tmp_path / "FiberHMM runs" / "pod5run"), "cores": 1,
            "options": {}, "basecall": {}}
    body.update(changes)
    return body


def test_status_reports_dorado_and_the_basecall_defaults(api, fake_dorado, monkeypatch):
    status = api.get("/api/pipeline/status").json()
    assert status["dorado"]["ok"] is False and "nanoporetech/dorado" in status["dorado"]["hint"]
    assert status["default_basecall"]["model"] == "sup"
    assert {e["id"]: e["raw_only"] for e in status["enzymes"]} == {"dddb": False, "ddda": False, "hia5": True}
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    # Found after installing: "Check again" asks with refresh.
    assert api.get("/api/pipeline/status?refresh=1").json()["dorado"]["version"] == "2.0.1+fake"


def test_validate_a_pod5_run_without_dorado_shows_how_to_install_it(api, fake_env):
    result = api.post("/api/pipeline/validate", json=_pod5_body(fake_env)).json()
    assert not result["ok"]
    error = next(e for e in result["errors"] if e["field"] == "dorado")
    assert "not installed" in error["message"] and "nanoporetech/dorado" in error["hint"]
    assert result["dorado"]["ok"] is False


def test_pod5_and_reads_are_not_mixed_and_hia5_needs_pod5(api, fake_env, fake_dorado, monkeypatch):
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    body = _pod5_body(fake_env, input_kind="reads")
    result = api.post("/api/pipeline/validate", json=body).json()
    fields = {e["field"] for e in result["errors"]}
    assert {"enzyme", "reads"} <= fields  # Hia5 runs start from POD5; a POD5 folder is not reads
    fastq = fake_env / "r.fastq"
    fastq.write_text("@r\nACGT\n+\nIIII\n")
    body = _pod5_body(fake_env)
    body["samples"] = [{"name": "x", "files": [{"path": str(fastq), "kind": "fastq"}]}]
    result = api.post("/api/pipeline/validate", json=body).json()
    assert any("not a POD5 file" in e["message"] for e in result["errors"])


def test_a_pod5_run_basecalls_then_shows_the_basecall_step_and_provenance(api, fake_env, fake_dorado, monkeypatch):
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    body = _pod5_body(fake_env, options={"dedup": "off", "snp_screen": "on"},
                      basecall={"device": "metal", "batchsize": 64})
    preview = api.post("/api/pipeline/validate", json=body).json()
    assert preview["ok"], preview
    assert preview["dorado"]["version"] == "2.0.1+fake"
    result = api.post("/api/pipeline/jobs", json=body).json()
    assert result["success"], result
    job = result["jobs"][0]
    pod5 = body["samples"][0]["files"][0]["path"]
    argv = shlex.split(job["command"])
    assert argv[1] == pod5  # the folder itself, however many files it holds
    assert argv[argv.index("--enzyme") + 1] == "hia5"
    assert "--dorado-device metal --dorado-batchsize 64" in job["command"]
    assert "--dorado-model" not in job["command"] and "--dorado-modified-bases" not in job["command"]
    assert "--dedup" not in job["command"] and "--snp-screen" not in job["command"]  # DAF-only options
    assert "--dorado " not in job["command"]  # the pipeline finds this dorado itself (on PATH)
    assert job["option_labels"][:3] == ["basecall: dorado sup + 6mA", "device metal", "batch 64"]
    assert job["input_kind"] == "pod5" and job["basecall"]["device"] == "metal"

    from services.pipeline_jobs import get_job_manager
    manager = get_job_manager()
    _wait(manager, job["id"], ("done",))
    detail = api.get(f"/api/pipeline/jobs/{job['id']}").json()
    steps = detail["progress"]["steps"]
    assert steps[0]["name"] == "basecall" and steps[0]["label"] == "Basecalling (dorado)"
    assert steps[0]["status"] == "done" and steps[0]["done"] == 40 and steps[0]["unit"] == "reads"
    assert "40 reads basecalled with dorado 2.0.1 (sup, modified bases 6mA)" in steps[0]["message"]
    outputs = detail["outputs"]
    assert outputs["basecalled_bam"].endswith("yw_2_4h.basecalled.bam")
    assert outputs["basecall"]["dorado_version"] == "2.0.1"
    assert outputs["settings"]["basecaller"]["modbase_models"] == [MODBASE]
    deadline = time.time() + 20
    while not (api.get(f"/api/pipeline/jobs/{job['id']}").json().get("summary")):
        assert time.time() < deadline
        time.sleep(0.1)
    assert api.get(f"/api/pipeline/jobs/{job['id']}").json()["summary"]["reads_basecalled"] == 40


def test_basecall_running_events_carry_only_a_message():
    from services.pipeline_jobs import summarize_progress
    events = [
        {"event": "start", "steps": ["basecall", "prepare_reference", "align", "call", "qc"]},
        {"event": "step", "step": "basecall", "status": "running", "message": "looking for dorado"},
        {"event": "step", "step": "basecall", "status": "running", "message": "dorado 2.0.1: 120 MB written, 30 s"},
    ]
    progress = summarize_progress(events)
    assert progress["current_step"] == "basecall"
    assert progress["steps"][0] == {"name": "basecall", "label": "Basecalling (dorado)", "status": "running",
                                    "message": "dorado 2.0.1: 120 MB written, 30 s"}
    assert progress["fraction"] == 0.0


def test_dorado_not_found_is_the_jobs_error_with_the_install_text(api, fake_env, fake_dorado, monkeypatch):
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    monkeypatch.setenv("FAKE_PIPELINE_MODE", "nodorado")
    job = api.post("/api/pipeline/jobs", json=_pod5_body(fake_env)).json()["jobs"][0]
    from services.pipeline_jobs import get_job_manager
    state = _wait(get_job_manager(), job["id"], ("error",))
    assert state["error"] == "dorado was not found"
    assert "nanoporetech/dorado" in state["hint"]


def test_retry_resumes_an_interrupted_basecall(api, fake_env, fake_dorado, monkeypatch):
    _on_path(monkeypatch, os.path.dirname(fake_dorado))
    monkeypatch.setenv("FAKE_PIPELINE_MODE", "fail")  # stops at the call step, after basecalling
    job = api.post("/api/pipeline/jobs", json=_pod5_body(fake_env, enzyme="dddb")).json()["jobs"][0]
    from services.pipeline_jobs import get_job_manager
    manager = get_job_manager()
    _wait(manager, job["id"], ("error",))
    monkeypatch.setenv("FAKE_PIPELINE_MODE", "ok")
    retried = api.post(f"/api/pipeline/jobs/{job['id']}/retry").json()
    assert retried["attempt"] == 2
    _wait(manager, job["id"], ("done",))
    steps = {s["name"]: s for s in manager.describe(job["id"])["progress"]["steps"]}
    # The same command again: the pipeline reuses its finished basecalling (or resumes dorado).
    assert steps["basecall"]["status"] == "skipped" and steps["basecall"]["message"] == "already complete"
    argv = json.loads(open(os.path.join(job["outdir"], "fake_argv.json")).read())
    assert "--redo" not in argv


def test_fiberbrowsers_dorado_is_passed_when_the_pipeline_would_not_find_it(api, fake_env, fake_dorado, monkeypatch):
    from services import external_tools as et
    monkeypatch.setattr(et, "_settings_candidates", lambda name: [fake_dorado] if name == "dorado" else [])
    et.clear_cache()
    result = api.post("/api/pipeline/jobs", json=_pod5_body(fake_env, enzyme="dddb")).json()
    assert result["success"], result
    assert result["jobs"][0]["command"].endswith(f"--dorado {shlex.quote(fake_dorado)}")


# --------------------------------------------------------------------------
# The Library: basecaller provenance and re-calls
# --------------------------------------------------------------------------

@pytest.fixture
def library(tmp_path, monkeypatch):
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    return tmp_path


def _dorado_programs(ds_tokens):
    return [{"ID": "basecaller", "PN": "dorado", "VN": "2.0.1",
             "CL": f"dorado basecaller /m/{MODEL} /data/pod5 --modified-bases-models /m/{MODBASE}"},
            {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "PP": "basecaller", "VN": "3.0.0",
             "CL": "fiberhmm-call -i in.bam -o out.bam", "DS": f"enzyme=hia5 {ds_tokens}"}]


def test_a_bams_basecaller_comes_from_its_header(library):
    from services import library_inspect as inspect
    ds = (f"basecaller=dorado basecaller_version=2.0.1 basecall_model={MODEL} modbase_models={MODBASE} "
          "basecaller_sources=program:pg,version:pg,basecall_model:rg_ds,modbase_models:rg_ds")
    bam = make_fiberhmm_bam(library / "a.bam", programs=_dorado_programs(ds))
    info = inspect.inspect_file(bam)
    caller = info["basecaller"]
    assert caller["available"] and caller["source"] == "BAM header"
    assert (caller["program"], caller["version"], caller["basecall_model"]) == ("dorado", "2.0.1", MODEL)
    assert caller["modbase_models"] == [MODBASE] and not caller["overridden"]
    # Nothing recorded: unknown (never guessed).
    plain = inspect.inspect_file(make_fiberhmm_bam(library / "b.bam"))
    assert plain["basecaller"]["available"] is False and plain["basecaller"]["modbase_models"] is None


def test_the_header_fallback_reads_fiberhmms_ds_tokens(monkeypatch):
    from services import library_inspect as inspect
    import builtins
    real_import = builtins.__import__

    def no_provenance(name, *args, **kwargs):
        if name == "fiberhmm.io.provenance":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_provenance)
    header = {"PG": [{"ID": "fiberhmm-pipeline", "PN": "fiberhmm-pipeline",
                      "DS": "x=1 basecaller=dorado basecaller_version=unknown basecall_model=m modbase_models=none "
                            "basecaller_sources=program:override,basecall_model:rg_ds"}]}
    caller = inspect.basecaller_from_header(header)
    assert caller["available"] and caller["program"] == "dorado" and caller["version"] is None
    assert caller["modbase_models"] == [] and caller["overridden"] is True


def _pod5_run(tmp_path, *, override=None, basecaller=None, aligned=True):
    run = make_pipeline_run(tmp_path / "runs" / "S1", sample="S1", plasmid_seq=seq(4))
    outdir = os.path.dirname(run["called_bam"])
    basecalled = make_bam(os.path.join(outdir, "S1.basecalled.bam"), index=False)
    outputs_path = os.path.join(outdir, "outputs.json")
    raw = json.loads(open(outputs_path).read())
    raw["settings"] = pipeline_settings("dddb", basecaller=basecaller or {
        "available": True, "platform": "nanopore", "program": "dorado", "version": "2.0.1",
        "basecall_model": MODEL, "modbase_models": [], "sources": {"program": "pg", "version": "pg",
                                                                   "basecall_model": "rg_ds",
                                                                   "modbase_models": "rg_ds"},
        "mixed": [], "notes": [], "inputs": [{"path": "/data/pod5", "kind": "pod5", "available": False}]},
        basecaller_override=override)
    raw["basecalled_bam"] = basecalled
    raw["basecall"] = {"reads": 6, "dorado_version": "2.0.1", "model": "sup", "resumed": False}
    if not aligned:
        os.remove(run["aligned_bam"])
        os.remove(run["aligned_bam"] + ".bai")
    with open(outputs_path, "w") as handle:
        json.dump(raw, handle)
    return run, basecalled


def _entry(path):
    from services import library_inspect as inspect
    from services import library_store as store
    entry_id = store.record(inspect.inspect_file(path))["id"]
    return store.load()["entries"][entry_id]


def test_outputs_json_basecaller_is_the_library_entrys(library):
    run, basecalled = _pod5_run(library)
    entry = _entry(run["called_bam"])
    assert entry["basecaller"]["source"] == "outputs.json"
    assert entry["basecaller"]["basecall_model"] == MODEL and entry["basecaller"]["modbase_models"] == []
    assert entry["pipeline"]["basecalled_bam"] == basecalled


def test_an_entry_recorded_before_basecaller_provenance_is_read_again(library):
    from services import library_inspect as inspect
    run, _ = _pod5_run(library)
    info = inspect.inspect_file(run["called_bam"])
    assert not inspect.extras_stale(info, run["called_bam"])
    info.pop("basecaller")
    assert inspect.extras_stale(info, run["called_bam"])


def test_a_recall_accepts_the_basecaller_settings_and_carries_the_override(library, monkeypatch):
    from services import library_jobs as jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    override = {"program": "dorado", "version": "0.9.6", "basecall_model": MODEL, "modbase_models": [MODBASE]}
    run, _ = _pod5_run(library, override=override)
    plan = jobs.plan_recall(_entry(run["called_bam"]), outdir=str(library / "recall"))
    assert plan["settings"]["source"] == "outputs.json"
    assert plan["reads"] == [run["aligned_bam"]]
    assert f"--basecaller-info=program=dorado version=0.9.6 basecall_model={MODEL}" in plan["extra"]
    assert plan["extra"][plan["extra"].index("--modbase-model") + 1] == MODBASE
    assert plan["settings"]["basecaller"]["program"] == "dorado"
    assert f"basecaller (override) program=dorado version=0.9.6 basecall_model={MODEL}" in plan["settings"]["labels"]
    # Known none is passed on as none; no override, no flags.
    none_run, _ = _pod5_run(library / "n", override={"modbase_models": []})
    plan = jobs.plan_recall(_entry(none_run["called_bam"]), outdir=str(library / "recall2"))
    assert plan["extra"][plan["extra"].index("--modbase-model") + 1] == "none"
    assert not any(a.startswith("--basecaller-info") for a in plan["extra"])
    plain_run, _ = _pod5_run(library / "p")
    plan = jobs.plan_recall(_entry(plain_run["called_bam"]), outdir=str(library / "recall3"))
    assert "--basecaller-info" not in plan["display_command"] and "--modbase-model" not in plan["display_command"]


def test_override_args_refuse_what_cannot_be_passed_on():
    from services import library_jobs as jobs
    assert jobs.override_args(None) == []
    for bad in ({"basecall_model": "two words"}, {"modbase_models": "x"}, {"colour": "red"}, "text"):
        with pytest.raises(jobs.RecallError):
            jobs.override_args(bad)


def test_a_pod5_run_recalls_from_its_basecalled_bam_without_basecalling(library, monkeypatch):
    from services import library_jobs as jobs
    monkeypatch.setenv("FIBERBROWSER_PIPELINE_COMMAND", f"{sys.executable} -c pass")
    run, basecalled = _pod5_run(library, aligned=False)
    plan = jobs.plan_recall(_entry(run["called_bam"]), outdir=str(library / "recall"))
    assert plan["reads"] == [basecalled]
    assert not any(a.startswith(("--redo", "--dorado")) for a in plan["extra"])


def test_raw_inputs_are_recognised_for_header_recalls(tmp_path):
    from services import recall_header as rh
    pod5 = _minknow_run(tmp_path)
    assert rh.is_raw_input(str(pod5)) and rh.is_raw_input(str(pod5.parent))  # a folder holding POD5
    assert rh.is_raw_input("/elsewhere/run1/pod5_pass", lambda p: False)  # MinKNOW's name, not here
    assert rh.is_raw_input("/elsewhere/x.pod5", lambda p: False)
    assert not rh.is_raw_input("/elsewhere/run1/reads.bam", lambda p: False)


def test_recorded_override_tokens():
    from services import recall_header as rh
    ds = (f"cpg_mask=x basecaller=dorado basecaller_version=0.9.6 basecall_model={MODEL} modbase_models=none "
          "basecaller_sources=program:override,version:recorded-override,basecall_model:rg_ds,modbase_models:override")
    assert rh.recorded_override(ds) == {"program": "dorado", "version": "0.9.6", "modbase_models": "none"}
    assert rh.recorded_override("basecaller=dorado basecaller_sources=program:pg") == {}


def test_basecall_flags_parse_with_the_real_pipeline(tmp_path):
    """The wizard's flags are the ones FiberHMM 3.0's fiberhmm-pipeline reads (its --help and parser)."""
    parser_module = pytest.importorskip("fiberhmm.cli.pipeline")
    from services import pipeline_inputs as pi
    help_text = parser_module.build_parser().format_help()
    settings = pi.normalize_basecall({"model": "hac", "modified_bases": "none", "device": "cuda:all",
                                      "batchsize": 32})
    extra = pi.basecall_args(settings, "hia5", help_text)
    args = pi.pipeline_args(reads=[str(tmp_path / "pod5")], reference="ref.fa", enzyme="hia5",
                            outdir=str(tmp_path / "o"), sample="s", cores=2, progress="p.jsonl", extra=extra,
                            tool_args=["--dorado", "/opt/dorado/bin/dorado"])
    config = parser_module.config_from_args(parser_module.parse_args(args))
    assert (config.dorado_model, config.dorado_modified_bases, config.dorado_device, config.dorado_batchsize,
            config.dorado) == ("hac", "none", "cuda:all", 32, "/opt/dorado/bin/dorado")
    from fiberhmm.pipeline import basecall as bc
    resolved = bc.resolve_settings("hia5", config.dorado_model, config.dorado_modified_bases)
    assert resolved.model == "hac" and resolved.modified_bases is None
    # The defaults pass no flag and give sup + 6mA (Hia5) / plain (DAF-seq), as the wizard says.
    assert bc.resolve_settings("hia5").modified_bases == ["6mA"] and bc.resolve_settings("dddb").modified_bases is None


# --------------------------------------------------------------------------
# Review fixes (Codex)
# --------------------------------------------------------------------------

def test_a_link_inside_a_pod5_folder_cannot_reach_outside_the_lab_roots(tmp_path, monkeypatch):
    from services import pipeline_inputs as pi
    from services.lab import paths as lab_paths
    root = tmp_path / "data"
    pod5 = _minknow_run(root)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.pod5").write_bytes(b"x")
    (outside / "more").mkdir()
    (outside / "more" / "b.pod5").write_bytes(b"y")

    def permitted(path):
        return os.path.realpath(path).startswith(os.path.realpath(root) + os.sep)

    assert pi.raw_folder_escape(str(pod5), permitted) is None
    os.symlink(outside / "more", pod5 / "linked")  # a linked subfolder
    assert pi.raw_folder_escape(str(pod5), permitted) == str(pod5 / "linked")
    os.remove(pod5 / "linked")
    os.symlink(outside / "secret.pod5", pod5 / "secret.pod5")  # a linked file
    assert pi.raw_folder_escape(str(pod5), permitted) == str(pod5 / "secret.pod5")

    # Where a lab server builds the command (a member's request) ...
    def confine(path, write=False):
        if not permitted(path):
            raise lab_paths.PathDenied("outside the lab's data folders")
        return path

    monkeypatch.setattr(lab_paths, "enforcing", lambda: True)
    monkeypatch.setattr(lab_paths, "confine", confine)
    with pytest.raises(pi.InputError, match="links outside"):
        pi.pipeline_args(reads=[str(pod5)], reference=str(root / "ref.fa"), enzyme="hia5",
                         outdir=str(root / "out"), sample="s", cores=1, progress="p")
    # ... and again when the run starts (a link added after it was checked).
    from services.lab import jobs as lab_jobs
    monkeypatch.setattr(lab_jobs, "_cfg", lambda: object())
    monkeypatch.setattr(lab_jobs, "max_cores", lambda: 64)
    monkeypatch.setattr(lab_paths, "allowed", lambda path, write=False: permitted(path))
    refusal = lab_jobs.spec_refusal({"cores": 1, "outdir": str(root / "out"), "reads": [str(pod5)],
                                     "reference": {"path": str(root / "ref.fa")}})
    assert refusal and "link outside" in refusal


def test_a_relocated_raw_folder_is_refused_too(tmp_path, monkeypatch):
    pytest.importorskip("fiberhmm.cli.pipeline")
    import subprocess
    from services import recall_header as rh
    proc = subprocess.run([sys.executable, "-c", rh.PARSER_PROBE, "fiberhmm.cli.pipeline", "", "table"],
                          capture_output=True, text=True, timeout=120)
    table = rh.Table("fiberhmm-pipeline", json.loads(proc.stdout.strip().splitlines()[-1]))
    found = _minknow_run(tmp_path / "here")
    monkeypatch.setattr(rh, "locate", lambda value, entry_path, mapping, exists: (str(found), "found beside the BAM"))
    ref = _fasta(tmp_path / "ref.fa")
    cl = f"fiberhmm-pipeline /old/machine/signal --reference {ref} --enzyme dddb -o /old/machine/out"
    with pytest.raises(rh.CommandError) as refused:
        rh.build(tool="fiberhmm-pipeline", cl=cl, ds="", table=table, entry_path=str(tmp_path / "e.bam"),
                 enzyme="dddb", platform=None, outdir=str(tmp_path / "new"), cores=2)
    assert refused.value.needs_input["reason"] == "raw"
