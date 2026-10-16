"""New DAF-seq run: reads (or raw POD5) + reference -> fiberhmm-pipeline jobs -> results and QC.

Local servers only: a public server or a tour tab refuses every route here
(services/public_mode_guard.py denies them; the routes check again). Jobs
start ``fiberhmm-pipeline`` with an argv list, never a shell.
"""
from __future__ import annotations

import asyncio
import os
import re
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

from state.dependencies import get_state

router = APIRouter(tags=["pipeline"])

LOCAL_ONLY = "New DAF-seq runs are only available in FiberBrowser on your own computer."


def local_only() -> None:
    from services.runtime import get_public_mode
    if get_public_mode():  # --public, and tour-tab sandboxes
        raise HTTPException(status_code=403, detail=LOCAL_ONLY)
    from services.lab.jobs import refusal
    lab_refusal = refusal()  # a lab server: only with [jobs] enabled = true
    if lab_refusal:
        raise HTTPException(status_code=403, detail=lab_refusal)


def _may_manage(job_id: str) -> None:
    """Lab servers: only the member who started a run, or an admin, may change it."""
    from services.lab.jobs import may_manage
    if not may_manage(_manager().spec(job_id)):
        raise HTTPException(status_code=403, detail="Only the member who started this run, or an admin, can change it.")


class ScanRequest(BaseModel):
    paths: list[str] = Field(default_factory=list)
    input_kind: str = "reads"  # reads (FASTQ/BAM) | pod5 (raw Nanopore, basecalled with dorado first)


class RunSample(BaseModel):
    name: str
    files: list[dict[str, Any]] = Field(default_factory=list)


class RunRequest(BaseModel):
    samples: list[RunSample] = Field(default_factory=list)
    reference: dict[str, Any] = Field(default_factory=dict)
    regions: list[str] = Field(default_factory=list)
    enzyme: str = "dddb"
    output_root: str = ""
    cores: int = 0
    options: dict[str, Any] = Field(default_factory=dict)
    auto_open: bool = False
    input_kind: str = "reads"  # reads | pod5
    basecall: dict[str, Any] = Field(default_factory=dict)  # POD5 only: model, modified_bases, device, batchsize


class DatasetQcRequest(BaseModel):
    dataset_id: str
    enzyme: str = "auto"


def _manager():
    from services.pipeline_jobs import get_job_manager
    return get_job_manager()


def _job_or_404(job_id: str) -> None:
    from services.pipeline_jobs import valid_job_id
    if not valid_job_id(job_id):
        raise HTTPException(status_code=400, detail="Malformed job id.")
    try:
        _manager().spec(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="No such job.") from exc


# --------------------------------------------------------------------------
# Planning: validation and argv construction
# --------------------------------------------------------------------------

def plan_run(req: RunRequest, *, check_tools: bool = True) -> dict:
    """Validate a run and build one job spec per sample (nothing is started or extracted)."""
    from services import pipeline_inputs as pi

    errors: list[dict] = []
    warnings: list[str] = []

    def fail(exc: pi.InputError) -> None:
        errors.append({"field": exc.field or "", "message": str(exc), "hint": exc.hint or ""})

    input_kind = str(req.input_kind or "reads").lower()
    raw = input_kind == "pod5"
    if input_kind not in ("reads", "pod5"):
        fail(pi.InputError(f"Unknown input kind: {input_kind}", "reads"))
        raw = False
    # Tools first: without the pipeline nothing else matters.
    command = pi.pipeline_command()
    aligner = {"ok": True, "hint": ""}
    dorado = None
    help_text = None
    if check_tools:
        if not command.get("argv"):
            errors.append({"field": "pipeline", "message": command.get("hint") or "fiberhmm-pipeline is not installed.",
                           "hint": ""})
        else:
            aligner = pi.aligner_status(command)
            if not aligner.get("ok"):
                errors.append({"field": "aligner", "message": "minimap2 is not installed.",
                               "hint": aligner.get("hint") or pi.GENERIC_ALIGNER_HINT})
            help_text = pi.pipeline_help(command["argv"], command.get("env"))
        if raw:
            # dorado is not bundled: the pipeline finds it, the wizard shows which (or how to install it).
            dorado = pi.dorado_status()
            if not dorado.get("ok"):
                errors.append({"field": "dorado", "message": "dorado (Oxford Nanopore's basecaller) is not installed; "
                               "raw POD5 must be basecalled with it first.", "hint": dorado.get("hint") or ""})

    enzyme = str(req.enzyme or "").lower()
    if enzyme not in (pi.PIPELINE_ENZYMES if raw else pi.ENZYMES):
        fail(pi.InputError("Choose the enzyme: DddB, DddA or Hia5 (Fiber-seq)." if raw else
                           "Choose the enzyme: DddB or DddA (Hia5 Fiber-seq: start from raw Nanopore POD5).",
                           "enzyme"))
    from services.lab.jobs import max_cores as _lab_max_cores
    max_cores = _lab_max_cores()  # os.cpu_count(), or a lab server's per-run cap
    cores = int(req.cores or min(pi.default_cores(), max_cores))
    if not 1 <= cores <= max_cores:
        fail(pi.InputError(f"Cores: 1 to {max_cores} on this computer.", "cores"))
        cores = max(1, min(cores, max_cores))

    reference = None
    try:
        reference = pi.resolve_reference(req.reference)
    except pi.InputError as exc:
        fail(exc)
    regions: list[str] = []
    try:
        regions = pi.parse_regions(req.regions)
    except pi.InputError as exc:
        fail(exc)
    options = dict(pi.DEFAULT_OPTIONS)
    extra: list[str] = []
    try:
        options = pi.normalize_options(req.options)
        if enzyme == "hia5":  # DAF-seq's calling options do not apply to m6A Fiber-seq
            options.update({k: pi.DEFAULT_OPTIONS[k] for k in pi.DAF_ONLY_OPTIONS})
        extra = pi.option_args(options, enzyme, help_text)
    except pi.InputError as exc:
        fail(exc)
    basecall = None
    tool_args: list[str] = []
    if raw:
        try:
            basecall = pi.normalize_basecall(req.basecall)
            extra += pi.basecall_args(basecall, enzyme, help_text)
        except pi.InputError as exc:
            fail(exc)
        if dorado and dorado.get("ok"):
            from services.external_tools import dorado_pipeline_args
            tool_args = dorado_pipeline_args()

    samples = [{"name": pi.sanitize_sample_name(s.name), "files": s.files} for s in req.samples]
    if not samples:
        fail(pi.InputError("Add raw Nanopore data: a POD5 folder (e.g. MinKNOW's pod5/) or POD5 files." if raw else
                           "Add reads: FASTQ files, a folder or a Plasmidsaurus .zip.", "reads"))
    pi.unique_sample_names(samples)
    for original, sample in zip(req.samples, samples):
        if pi.sanitize_sample_name(original.name) != original.name.strip():
            warnings.append(f"Sample '{original.name}' will be named '{sample['name']}' (letters, digits, . _ - only).")

    output_root = None
    try:
        output_root, more = pi.check_output_dir(
            req.output_root or pi.default_output_root(samples[0]["name"] if len(samples) == 1 else "run"))
        warnings.extend(more)
    except pi.InputError as exc:
        fail(exc)

    jobs: list[dict] = []
    for sample in samples:
        files = sample["files"]
        if not files:
            fail(pi.InputError(f"Sample '{sample['name']}' has no read files.", "reads"))
            continue
        reads: list[str] = []
        zips: dict[str, list[str]] = {}
        for entry in files:
            path = str(entry.get("path") or "")
            zip_path = entry.get("zip")
            if raw or entry.get("kind") == "pod5":
                path = os.path.abspath(os.path.expanduser(path))
                if not raw:
                    fail(pi.InputError(f"{os.path.basename(path)} is raw Nanopore POD5: choose Raw Nanopore (POD5) "
                                       "to basecall it first.", "reads"))
                elif zip_path or not os.path.exists(path):
                    fail(pi.InputError(f"POD5 input not found: {path}", "reads"))
                elif not os.access(path, os.R_OK):
                    fail(pi.InputError(f"Cannot read {path} (permissions).", "reads"))
                elif pi.raw_input_kind(path) != "pod5":
                    fail(pi.InputError(f"{os.path.basename(path)} is not a POD5 file or a folder of them.", "reads"))
                else:
                    reads.append(path)
                continue
            if zip_path:
                if not os.path.isfile(str(zip_path)):
                    fail(pi.InputError(f"Zip not found: {zip_path}", "reads"))
                    continue
                zips.setdefault(str(zip_path), []).append(str(entry.get("member") or path))
                continue
            path = os.path.abspath(os.path.expanduser(path))
            if not os.path.isfile(path):
                fail(pi.InputError(f"Read file not found: {path}", "reads"))
            elif not os.access(path, os.R_OK):
                fail(pi.InputError(f"Cannot read {path} (permissions).", "reads"))
            elif pi.read_file_kind(path) is None:
                fail(pi.InputError(f"{os.path.basename(path)} is not a FASTQ or BAM file.", "reads"))
            else:
                reads.append(path)
        if output_root is None:
            continue
        outdir = output_root if len(samples) == 1 else os.path.join(output_root, sample["name"])
        if os.path.isfile(os.path.join(outdir, "outputs.json")):
            warnings.append(f"{outdir} already has results: finished steps are reused; the pipeline "
                            "refuses the run if its inputs or settings changed.")
        jobs.append({"sample": sample["name"], "outdir": outdir, "reads": reads, "zips": zips})

    return {"ok": not errors, "errors": errors, "warnings": warnings, "jobs": jobs, "enzyme": enzyme,
            "cores": cores, "reference": reference, "regions": regions, "options": options, "extra": extra,
            "output_root": output_root, "command": command, "aligner": aligner, "input_kind": input_kind,
            "basecall": basecall, "tool_args": tool_args, "dorado": dorado}


def _job_argv(plan: dict, job: dict, reads: list[str], progress: str) -> tuple[list[str], list[str]]:
    from services import pipeline_inputs as pi
    args = pi.pipeline_args(reads=reads, reference=plan["reference"]["path"], enzyme=plan["enzyme"],
                            outdir=job["outdir"], sample=job["sample"], cores=plan["cores"],
                            progress=progress, regions=plan["regions"], extra=plan["extra"],
                            tool_args=plan.get("tool_args"))
    return [*plan["command"]["argv"], *args], args


def _preview(plan: dict) -> list[dict]:
    from services import pipeline_inputs as pi
    out = []
    for job in plan["jobs"]:
        reads = job["reads"] + [f"<{os.path.basename(z)} → reads/>" for z in job["zips"]]
        if plan["reference"] and plan["enzyme"] in pi.PIPELINE_ENZYMES and reads:
            _, args = _job_argv(plan, job, reads, "<job>/progress.jsonl")
            command = pi.display_command(args)
        else:
            command = None
        out.append({"sample": job["sample"], "outdir": job["outdir"], "command": command,
                    "n_files": len(job["reads"]) + sum(len(v) for v in job["zips"].values())})
    return out


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@router.get("/api/pipeline/status", dependencies=[Depends(local_only)])
async def pipeline_status(refresh: bool = False, state=Depends(get_state)):
    """Is the pipeline installed, can it align (and basecall: dorado), what references and defaults to offer.

    ``refresh``: look for dorado again (the wizard's "Check again" after installing it)."""
    from services import pipeline_inputs as pi

    def work():
        command = pi.pipeline_command()
        aligner = pi.aligner_status(command) if command.get("argv") else {"ok": False, "hint": ""}
        return {
            "available": bool(command.get("argv")), "source": command.get("source"),
            "hint": command.get("hint") or "", "aligner": aligner,
            "cores": os.cpu_count() or 1, "default_cores": pi.default_cores(),
            "default_output_root": pi.default_output_root("run"),
            "output_parent": os.path.join(os.path.expanduser("~"), "FiberHMM runs"),
            "enzymes": [{"id": k, "description": v, "raw_only": k not in pi.ENZYMES}
                        for k, v in pi.PIPELINE_ENZYMES.items()],
            "dorado": pi.dorado_status(refresh=refresh),
            "default_basecall": pi.DEFAULT_BASECALL,
            "genomes": pi.genome_choices(state),
            "loaded_references": pi.loaded_references(state),
            "current_genome": getattr(state, "current_genome", None),
            "default_options": pi.DEFAULT_OPTIONS,
        }
    return await asyncio.to_thread(work)


@router.post("/api/pipeline/scan", dependencies=[Depends(local_only)])
async def pipeline_scan(req: ScanRequest):
    """Read files, folders and zips -> detected samples (Plasmidsaurus names -> sample names)."""
    from services import pipeline_inputs as pi
    try:
        return await asyncio.to_thread(pi.scan_reads, req.paths, str(req.input_kind or "reads").lower())
    except pi.InputError as exc:
        return {"success": False, "error": str(exc), "samples": [], "warnings": []}


@router.post("/api/pipeline/validate", dependencies=[Depends(local_only)])
async def pipeline_validate(req: RunRequest):
    plan = await asyncio.to_thread(plan_run, req)
    return {"ok": plan["ok"], "errors": plan["errors"], "warnings": plan["warnings"],
            "jobs": _preview(plan), "output_root": plan["output_root"], "aligner": plan["aligner"],
            "dorado": plan["dorado"]}


@router.post("/api/pipeline/jobs", dependencies=[Depends(local_only)])
async def pipeline_submit(req: RunRequest):
    """Queue one fiberhmm-pipeline job per sample."""
    from services import pipeline_inputs as pi

    def work():
        plan = plan_run(req)
        if not plan["ok"]:
            return {"success": False, "errors": plan["errors"], "warnings": plan["warnings"]}
        from services.lab.jobs import check_submit, owner
        busy = check_submit(len(plan["jobs"]))
        if busy:
            return {"success": False, "errors": [{"field": "", "message": busy, "hint": ""}],
                    "warnings": plan["warnings"]}
        manager = _manager()
        group = secrets.token_hex(4)
        created = []
        # Every archive is extracted before any job starts, so no running job reads a file
        # that a later extraction is still writing.
        job_reads = []
        for job in plan["jobs"]:
            reads = list(job["reads"])
            for zip_path, members in job["zips"].items():
                # Into the run folder: <output>/reads/<zip name>-<content digest>/<the zip's folders>/...
                dest = os.path.join(plan["output_root"], "reads")
                extracted = pi.extract_zip_members(zip_path, members, dest)
                reads.extend(extracted[m] for m in members)
            job_reads.append(reads)
        with manager.admission():  # the limits hold for the whole batch, atomically
            busy = check_submit(len(plan["jobs"]))
            if busy:
                return {"success": False, "errors": [{"field": "", "message": busy, "hint": ""}],
                        "warnings": plan["warnings"]}
            _create_jobs(manager, plan, job_reads, group, created, owner(), bool(req.auto_open))
        return {"success": True, "jobs": created, "warnings": plan["warnings"], "group": group}

    try:
        return await asyncio.to_thread(work)
    except pi.InputError as exc:
        return {"success": False, "errors": [{"field": exc.field, "message": str(exc), "hint": exc.hint}],
                "warnings": []}


def _create_jobs(manager, plan: dict, job_reads: list, group: str, created: list, user,
                 auto_open: bool) -> None:
    """Register one job per sample of a validated plan (under manager.admission())."""
    from services import pipeline_inputs as pi
    from services.pipeline_jobs import new_job_id
    for job, reads in zip(plan["jobs"], job_reads):
        job_id = new_job_id()
        while os.path.exists(os.path.join(manager.root, job_id)):
            job_id = new_job_id()
        progress = os.path.join(manager.root, job_id, "progress.jsonl")
        argv, args = _job_argv(plan, job, reads, progress)
        spec = {
            "id": job_id, "created": time.time(), "group": group,
            "sample": job["sample"], "enzyme": plan["enzyme"], "reference": plan["reference"],
            "reads": reads, "outdir": job["outdir"], "output_root": plan["output_root"],
            "cores": plan["cores"], "regions": plan["regions"], "options": plan["options"],
            "option_labels": ((pi.basecall_labels(plan["basecall"], plan["enzyme"]) if plan.get("basecall") else [])
                              + pi.changed_options(plan["options"], plan["enzyme"])),
            "input_kind": plan.get("input_kind") or "reads",
            **({"basecall": plan["basecall"]} if plan.get("basecall") else {}),
            "argv": argv, "env": plan["command"].get("env") or {},
            "display_command": pi.display_command(args), "auto_open": auto_open,
        }
        if user:
            spec["user"] = user  # lab servers: who started it
        created.append(manager.create(spec))


@router.get("/api/pipeline/jobs", dependencies=[Depends(local_only)])
async def pipeline_jobs():
    return {"jobs": await asyncio.to_thread(_manager().list)}


@router.get("/api/pipeline/jobs/{job_id}", dependencies=[Depends(local_only)])
async def pipeline_job(job_id: str):
    _job_or_404(job_id)
    return await asyncio.to_thread(_manager().describe, job_id)


@router.get("/api/pipeline/jobs/{job_id}/log", dependencies=[Depends(local_only)])
async def pipeline_job_log(job_id: str):
    _job_or_404(job_id)
    try:
        text = await asyncio.to_thread(_manager().read_log, job_id, strict=True)
    except PermissionError as exc:  # a lab server refused what is there: not this job's log
        raise HTTPException(status_code=404, detail="No such log.") from exc
    return PlainTextResponse(text)


@router.post("/api/pipeline/jobs/{job_id}/cancel", dependencies=[Depends(local_only)])
async def pipeline_job_cancel(job_id: str):
    _job_or_404(job_id)
    _may_manage(job_id)
    return await asyncio.to_thread(_manager().cancel, job_id)


@router.post("/api/pipeline/jobs/{job_id}/retry", dependencies=[Depends(local_only)])
async def pipeline_job_retry(job_id: str):
    from services.lab.jobs import check_submit
    from services.pipeline_jobs import JobRefused
    _job_or_404(job_id)
    _may_manage(job_id)
    try:
        # A retry queues the run again: a lab server's run limits apply as to a new one.
        from services.lab.jobs import spec_refusal
        manager = _manager()
        # Its stored cores, inputs and output folder must suit the current policy too.
        return await asyncio.to_thread(manager.retry, job_id,
                                       admit=lambda: spec_refusal(manager.spec(job_id)) or check_submit(1))
    except JobRefused as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/api/pipeline/jobs/{job_id}", dependencies=[Depends(local_only)])
async def pipeline_job_forget(job_id: str):
    """Remove a finished job from the list (its output folder is kept)."""
    _job_or_404(job_id)
    _may_manage(job_id)
    try:
        await asyncio.to_thread(_manager().forget, job_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"success": True}


def _job_roots(spec: dict):
    """Where a run's served files may be on a lab server: its own output folder
    (whatever its stored record names), inside the data roots. None elsewhere:
    a personal server serves what the run's QC lists, as before."""
    from services.lab import get_config
    from services.lab.paths import allowed
    if get_config() is None:
        return None
    outdir = spec.get("outdir")
    if not isinstance(outdir, str) or not outdir or not allowed(outdir):
        return []
    return [os.path.realpath(outdir)]


def _job_qc(job_id: str) -> dict:
    from services.pipeline_jobs import qc_json_path
    from services.qc_view import qc_payload
    manager = _manager()
    spec = manager.spec(job_id)
    state = manager.state(job_id)
    outputs = state.get("outputs") or {}
    qc = outputs.get("qc") if isinstance(outputs.get("qc"), dict) else {}
    payload = qc_payload(qc_json_path(outputs, spec.get("outdir")), qc.get("plots") or {},
                         outputs.get("qc_report"), qc.get("curves"), roots=_job_roots(spec))
    payload["plots"] = {name: f"/api/pipeline/jobs/{job_id}/files/{name}" for name in payload["plots"]}
    payload.pop("json_path", None)
    return payload


@router.get("/api/pipeline/jobs/{job_id}/qc", dependencies=[Depends(local_only)])
async def pipeline_job_qc(job_id: str):
    """The run's fiberhmm-qc verdicts, metrics and curves (for the QC panel)."""
    _job_or_404(job_id)
    return await asyncio.to_thread(_job_qc, job_id)


@router.get("/api/pipeline/jobs/{job_id}/files/{name}", dependencies=[Depends(local_only)])
async def pipeline_job_file(job_id: str, name: str):
    """A QC figure/report of the run (only the files the QC lists)."""
    from services.pipeline_jobs import qc_json_path
    from services.qc_view import _read_json, plot_files
    from services.lab.paths import open_confined
    _job_or_404(job_id)
    manager = _manager()
    spec = manager.spec(job_id)
    roots = _job_roots(spec)
    outputs = manager.state(job_id).get("outputs") or {}
    qc = outputs.get("qc") if isinstance(outputs.get("qc"), dict) else {}
    extra = dict(qc.get("plots") or {})
    if outputs.get("qc_report"):
        extra.setdefault("report", outputs["qc_report"])
    files = plot_files(_read_json(qc_json_path(outputs, spec.get("outdir")), roots), extra, roots)
    path = files.get(name)
    if not path:
        raise HTTPException(status_code=404, detail="No such file.")
    if roots is None:  # a personal server: as before
        return FileResponse(path, filename=os.path.basename(path))
    # A lab server: the file checked and opened by descriptor inside the run's folder.
    from services.file_responses import opened_file_response
    opened = open_confined(path, roots)
    if not opened:
        raise HTTPException(status_code=404, detail="No such file.")
    return opened_file_response(opened, os.path.basename(path))


# --------------------------------------------------------------------------
# QC of any loaded dataset
# --------------------------------------------------------------------------

@router.post("/api/qc/dataset", dependencies=[Depends(local_only)])
async def dataset_qc(req: DatasetQcRequest, state=Depends(get_state)):
    """Run fiberhmm-qc on a loaded BAM dataset (cached) and return verdicts and curves."""
    from services.qc_view import run_dataset_qc
    datasets = getattr(state, "datasets", {}) or {}
    dataset = datasets.get(req.dataset_id) if isinstance(datasets, dict) else None
    if dataset is None:
        raise HTTPException(status_code=404, detail="No such dataset.")
    path = getattr(dataset, "path", None)
    if getattr(dataset, "data_type", None) != "bam" or getattr(dataset, "is_remote", False) or not path \
            or len(getattr(dataset, "paths", [path]) or []) != 1:
        return {"success": False, "error": "QC runs on one local BAM file (not a BigBed, URL or merged dataset)."}
    reference = getattr(state, "fasta_path", None)
    try:
        payload = await asyncio.to_thread(run_dataset_qc, path, enzyme=req.enzyme,
                                          reference_fasta=reference if isinstance(reference, str) else None)
    except (RuntimeError, ValueError, FileNotFoundError, OSError) as exc:
        return {"success": False, "error": str(exc)}
    except Exception as exc:  # subprocess timeout and the like
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    key = payload.get("cache_key")
    payload["plots"] = {name: f"/api/qc/files/{key}/{name}" for name in payload["plots"]}
    payload.pop("json_path", None)
    return {"success": True, "label": getattr(dataset, "label", None), **payload}


@router.get("/api/qc/files/{cache_key}/{name}", dependencies=[Depends(local_only)])
async def dataset_qc_file(cache_key: str, name: str):
    from services.qc_view import _read_json, plot_files, qc_cache_dir
    if not re.fullmatch(r"[0-9a-f]{16}", cache_key):
        raise HTTPException(status_code=400, detail="Malformed key.")
    folder = os.path.join(qc_cache_dir(), cache_key)
    candidates = [f for f in (os.listdir(folder) if os.path.isdir(folder) else []) if f.endswith(".qc.json")]
    if not candidates:
        raise HTTPException(status_code=404, detail="No such QC.")
    from services.lab import get_config
    if get_config() is None:  # a personal server: as before
        files = plot_files(_read_json(os.path.join(folder, candidates[0])))
        path = files.get(name)
        if not path or os.path.commonpath([os.path.realpath(path), os.path.realpath(folder)]) != os.path.realpath(folder):
            raise HTTPException(status_code=404, detail="No such file.")
        return FileResponse(path, filename=os.path.basename(path))
    from services.file_responses import opened_file_response
    from services.lab.paths import open_confined
    files = plot_files(_read_json(os.path.join(folder, candidates[0]), roots=[folder]), roots=[folder])
    path = files.get(name)
    opened = open_confined(path, [folder], lab_roots=False) if path else None
    if not opened:
        raise HTTPException(status_code=404, detail="No such file.")
    return opened_file_response(opened, os.path.basename(path))
