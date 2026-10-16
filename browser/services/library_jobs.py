"""Finished "New DAF-seq run" jobs become Library entries.

Reads the job registry of ``services.pipeline_jobs`` (``~/.fiberhmm/jobs/<id>/``,
``FIBERBROWSER_JOBS_DIR``): each job whose ``state.json`` says ``done`` has its
``outputs.json`` (schema ``fiberhmm.pipeline.outputs.v1``) read, and its
called BAM and plasmid map(s) are added once. A job is imported only once
(``imported_jobs`` in the Library), so an entry the user removed stays removed.
Also builds and submits "Re-call with FiberHMM <current>" jobs.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import time
from typing import Any, Optional

from services import library_inspect as inspect
from services import library_store as store


def _jobs():
    from services import pipeline_jobs
    return pipeline_jobs


def _job_rows(skip: Optional[dict] = None) -> list[tuple[str, dict, dict]]:
    """(job id, spec, state) of every finished-OK job in the registry (``skip``: ids already imported, not read)."""
    pj = _jobs()
    root = pj.jobs_dir()
    try:
        names = os.listdir(root)
    except OSError:
        return []
    rows = []
    for name in sorted(names):
        if not pj.valid_job_id(name) or (skip and name in skip):
            continue
        spec = pj._read_json(os.path.join(root, name, "spec.json"), os.path.join(root, name))
        state = pj._read_json(os.path.join(root, name, "state.json"), os.path.join(root, name))
        if spec and state and state.get("status") == "done":
            rows.append((name, spec, state))
    return rows


def _job_outputs(spec: dict, state: dict) -> Optional[dict]:
    outputs = state.get("outputs") if isinstance(state.get("outputs"), dict) else None
    outdir = spec.get("outdir") or ""
    on_disk = _jobs().load_outputs(outdir) if outdir else None
    return on_disk or outputs


def job_files(spec: dict, state: dict) -> list[tuple[str, str]]:
    """(path, kind) a finished job produced that the Library lists."""
    outputs = _job_outputs(spec, state) or {}
    out: list[tuple[str, str]] = []
    opener = outputs.get("open") if isinstance(outputs.get("open"), dict) else {}
    for path in opener.get("datasets") or ([outputs["called_bam"]] if outputs.get("called_bam") else []):
        if isinstance(path, str) and path:
            out.append((path, "bam"))
    maps = list(opener.get("plasmid_maps") or [])
    if outputs.get("plasmid_map") and outputs["plasmid_map"] not in maps:
        maps.append(outputs["plasmid_map"])
    for path in maps:
        if isinstance(path, str) and path:
            out.append((path, "plasmid_map"))
    recall = spec.get("library_recall") or {}
    if not out and recall.get("output_bam"):
        out.append((recall["output_bam"], "bam"))
    return out


def job_details(job_id: str, spec: dict, state: dict) -> dict:
    reference = spec.get("reference") if isinstance(spec.get("reference"), dict) else {}
    return {
        "id": job_id,
        "group": spec.get("group"),
        "sample": spec.get("sample"),
        "enzyme": spec.get("enzyme"),
        "outdir": spec.get("outdir"),
        "reference": {k: reference.get(k) for k in ("path", "kind", "label", "genome_id") if reference.get(k)},
        "created": spec.get("created"),
        "finished_at": state.get("finished_at"),
        "recall_of": (spec.get("library_recall") or {}).get("entry_id"),
        "regions": spec.get("regions") if isinstance(spec.get("regions"), list) else None,
        "options": spec.get("options") if isinstance(spec.get("options"), dict) else None,
    }


def import_finished_jobs() -> dict:
    """Add the results of finished runs not imported yet. Safe to call often.

    Nothing is imported while the Library file is unreadable (damaged, or written
    by a newer FiberBrowser): the store never overwrites it, and the runs are
    imported once it is recovered."""
    data = store.load()
    if data.get("_unreadable"):
        return {"imported": 0, "available": True, "skipped": "library unreadable"}
    seen = data.get("imported_jobs") or {}
    try:
        fresh = _job_rows(seen)
    except ImportError:
        return {"imported": 0, "available": False}
    if not fresh:
        return {"imported": 0, "available": True}
    infos: list[tuple[str, dict]] = []
    for job_id, spec, state in fresh:
        details = job_details(job_id, spec, state)
        for path, kind in job_files(spec, state):
            try:
                info = inspect.inspect_file(path, kind)
            except Exception as exc:  # one unreadable output never blocks the other runs' import
                info = {"kind": kind, "path": os.path.abspath(path), "folder": os.path.dirname(os.path.abspath(path)),
                        "label": os.path.basename(path), "error": f"{type(exc).__name__}: {exc}"}
            info["job"] = details
            if details.get("sample") and kind == "bam":
                info["sample"] = details["sample"]
            if details.get("finished_at") and kind == "bam":
                info["date"] = inspect._iso(details["finished_at"])
                info["date_source"] = "run finished"
            infos.append((job_id, info))

    def change(data: dict) -> int:
        imported = data.setdefault("imported_jobs", {})
        count = 0
        for job_id, info in infos:
            if info.get("error") == "file not found":
                continue
            store.upsert(data, info, f"job:{job_id}")
            count += 1
        for job_id, _spec, state in fresh:
            imported[job_id] = state.get("finished_at") or time.time()
        return count

    return {"imported": store.update(change), "available": True}


# ---------------------------------------------------------------------------
# Re-call with the current FiberHMM
# ---------------------------------------------------------------------------

class RecallError(ValueError):
    """Why a re-call is refused, worded for the Library. ``needs_input``: the input the
    BAM header names was not found (the user may point at it); ``start_new_run``: the
    way forward is a New DAF-seq run."""

    def __init__(self, message: str, *, needs_input: Optional[dict] = None, start_new_run: bool = False):
        super().__init__(message)
        self.needs_input = needs_input
        self.start_new_run = start_new_run


# How each FiberHMM advisory (by its stable ``id``) is remedied by a re-call.
# "recall": a full fiberhmm-pipeline re-call from the aligned reads remakes the
# calls, duplicate flags and QC. "aligned": the same, but only from the run's
# pre-call aligned BAM (the fix needs the un-deduplicated input). An advisory
# not listed needs steps the pipeline does not run (fiberhmm-tag-m5c then
# recall-tfs, fiberhmm-pair, posteriors, consensus): the re-call is refused and
# FiberHMM's own ``fix`` for it is shown. No 3.0 advisory is fixed by
# fiberhmm-recall-tfs alone (hia5-nanopore-gt-table says so explicitly;
# tag-m5c-missing-ucg needs fiberhmm-tag-m5c first), so none selects it.
ADVISORY_REMEDIES = {
    "dddb-gt-table": "recall",
    "hia5-nanopore-gt-table": "recall",
    "hia5-nanopore-called-as-pacbio": "recall",
    "custom-table-without-enzyme-defaults": "recall",  # the recorded call_args (-m ...) are carried
    "qc-nanopore-opportunities": "recall",
    "daf-dedup-orientation": "aligned",
}

# outputs.json "settings" (fiberhmm.pipeline.outputs.v1) a re-call carries; the
# pipeline's own defaults for those not in pipeline_inputs.DEFAULT_OPTIONS.
UNKNOWN_SETTINGS = (
    "The Library cannot tell which calling options this BAM was made with: it has no fiberhmm-pipeline "
    "outputs.json beside it, no New DAF-seq run record, and its header records no FiberHMM calling command, "
    "so it will not re-call it with guessed settings. Start a New DAF-seq run from the aligned reads (or "
    "the original FASTQ) instead, with the reference they were aligned to.")

SETTING_KEYS = ("enzyme", "seq", "min_mapq", "min_read_length", "dedup", "dedup_mode", "snp_screen",
                "snp_mask", "chimera_filter", "primary_only", "prob_threshold", "use_m5c", "cpg_mask_policy",
                "hard_clip", "origin_merge", "qc", "tracks", "call_args",
                # FiberHMM 3.0 (supplementary calling, DAF unaligned-base mask and insert consensus)
                "alignments", "daf_unaligned_mask", "daf_insert_consensus",
                # FiberHMM 3.0 basecaller provenance: what the inputs record (shown, not a calling setting)
                # and the --basecaller-info / --modbase-model override (carried into the re-call)
                "basecaller", "basecaller_override")
PIPELINE_DEFAULTS = {"min_mapq": 20, "min_read_length": 1000, "seq_daf": "nanopore"}


def override_args(override: Any) -> list[tuple[str, list[str]]]:
    """A recorded basecaller override (outputs.json ``settings.basecaller_override``, as
    fiberhmm.io.provenance.parse_override returns it) as the pipeline flags that give it again:
    [(label, flags)]. RecallError for a value the Library cannot pass on unchanged."""
    if override in (None, {}):
        return []
    if not isinstance(override, dict):
        raise RecallError(f"The original run records basecaller_override={override!r}, which this FiberBrowser "
                          "cannot read.")
    unknown = sorted(k for k in override if k not in ("program", "version", "basecall_model", "modbase_models"))
    if unknown:
        raise RecallError(f"The original run's basecaller override records {', '.join(unknown)}, which this "
                          "FiberBrowser cannot carry into a re-call; update FiberBrowser.")
    out: list[tuple[str, list[str]]] = []
    pairs = []
    for key in ("program", "version", "basecall_model"):
        value = override.get(key)
        if value is None:
            continue
        text = str(value)
        if not text or re.search(r"[\s;=]", text):
            raise RecallError(f"The original run's basecaller override {key}={text!r} cannot be passed on "
                              "unchanged (--basecaller-info takes key=value words).")
        pairs.append(f"{key}={text}")
    if pairs:
        info = " ".join(pairs)
        out.append((f"basecaller (override) {info}", [f"--basecaller-info={info}"]))
    mods = override.get("modbase_models")
    if mods is not None:
        if not isinstance(mods, list) or not all(isinstance(m, str) and m and "," not in m and not m.startswith("-")
                                                 for m in mods):
            raise RecallError(f"The original run's basecaller override modbase_models={mods!r} cannot be passed on "
                              "unchanged.")
        value = ",".join(mods) if mods else "none"
        out.append((f"modbase model (override) {value}", ["--modbase-model", value]))
    return out


def _rerun_items(advisories: Optional[dict]) -> list[dict]:
    return [a for a in (advisories or {}).get("items") or []
            if isinstance(a, dict) and str(a.get("severity", "")).startswith("rerun")]


def _manual_refusal(manual: list[dict], tool: str) -> RecallError:
    lines = [f"- {a.get('title') or a.get('id')}: {a.get('fix') or 'see fiberhmm-check'}" for a in manual]
    return RecallError(f"Re-calling with {tool} cannot fix everything FiberHMM reports for this file; "
                       f"it needs steps {tool} does not run:\n" + "\n".join(lines))


def recall_remedy(advisories: Optional[dict]) -> dict:
    """What re-calling must do for an entry's advisories: {'kind', 'ids'}; raises
    RecallError (with FiberHMM's own fix for each) when re-calling cannot fix them all."""
    items = _rerun_items(advisories)
    manual = [a for a in items if ADVISORY_REMEDIES.get(str(a.get("id"))) is None]
    if manual:
        raise _manual_refusal(manual, "fiberhmm-pipeline")
    kinds = {ADVISORY_REMEDIES[str(a.get("id"))] for a in items}
    return {"kind": "aligned" if "aligned" in kinds else "recall", "ids": [str(a.get("id")) for a in items]}


def _job_spec(entry: dict) -> Optional[dict]:
    """The run record (spec.json) of the New DAF-seq run an entry came from, if it is still there."""
    job_id = str((entry.get("job") or {}).get("id") or "")
    try:
        pj = _jobs()
        if not job_id or not pj.valid_job_id(job_id):
            return None
        spec = pj._read_json(os.path.join(pj.jobs_dir(), job_id, "spec.json"), os.path.join(pj.jobs_dir(), job_id))
    except Exception:
        return None
    return spec if isinstance(spec, dict) else None


def _header_programs(path: str) -> Optional[list[dict]]:
    """The @PG records of a local BAM (header only; never for an online-only file, which it would download)."""
    if inspect.is_cluster_ref(path):
        return None
    identity = inspect.stat_identity(os.path.abspath(os.path.expanduser(str(path))))
    if identity is None or identity.get("cloud_only"):
        return None
    try:
        from services.htslib_quiet import quiet_htslib
        with quiet_htslib():
            with inspect._open_bam(path, None) as bam:
                programs = bam.header.to_dict().get("PG") or []
    except Exception:
        return None
    return [dict(pg) for pg in programs if isinstance(pg, dict)]


def _calling_command(entry: dict) -> Optional[str]:
    """The last FiberHMM calling command line in the BAM header."""
    if entry.get("cloud_only"):
        return None
    from services.recall_header import calling_program
    found = calling_program(_header_programs(entry["path"]) or [])
    return found["cl"] if found and found["cl"] else None


def _int_setting(settings: dict, key: str) -> Optional[int]:
    value = settings.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise RecallError(f"The original run records {key}={value!r}, which is not a whole number; "
                          "the Library will not guess what it meant.")
    return int(value)


def _tristate(value: Any, key: str) -> str:
    """outputs.json use_m5c (auto / true / false) and friends as the wizard's auto / on / off."""
    if value in (None, "auto"):
        return "auto"
    if value is True or value == "on":
        return "on"
    if value is False or value == "off":
        return "off"
    raise RecallError(f"The original run records {key}={value!r}, which this FiberBrowser does not know.")


def _call_switch(call_args: list[str], flag: str) -> Optional[bool]:
    """A --flag/--no-flag switch in a fiberhmm-call argument list (the last one wins; None: absent)."""
    negative = "--no-" + flag[2:]
    value = None
    for argument in call_args:
        if argument == flag:
            value = True
        elif argument == negative:
            value = False
    return value


# 3.0 default changes a run recorded before them (outputs.json, run record): text and the pipeline flag
# that keeps the original behaviour. Shared with the header re-call's (services/recall_header.py).
def _pipeline_default_changes() -> dict:
    from services import recall_header as rh
    return {"alignments": (rh.SUPPLEMENTARY_TEXT, ["--alignments", "primary"]),
            "soft_clips": (rh.SOFT_CLIP_TEXT, ["--hard-clip"]),
            "daf_unaligned_mask": (rh.UNALIGNED_MASK_TEXT, ["--no-daf-mask-unaligned"])}


def recall_settings(entry: dict, enzyme: str, help_text: Optional[str],
                    keep_old: Optional[list[str]] = None) -> dict:
    """The original run's calling settings as fiberhmm-pipeline arguments.

    From the run's outputs.json ``settings`` (every effective calling setting),
    else from the New DAF-seq run record (the options chosen in the wizard; the
    rest were the pipeline's defaults), plus the run's --region list when the
    run record has it. Refuses (RecallError) when neither exists, or a setting
    cannot be carried: a re-call never silently changes a calling parameter.

    A run recorded before a FiberHMM 3.0 default changed (supplementary alignments
    called, DAF soft clips kept on linear contigs, DAF inserted/soft-clipped bases
    masked) gets the new default, listed in ``changed_defaults`` with the flag that
    keeps the original behaviour (``keep_old``: the ids to keep). A retired option
    in the recorded fiberhmm-call options is left out and listed in ``rewrites``.
    """
    from services import pipeline_inputs as pi
    from services import recall_header as rh

    spec = _job_spec(entry) or {}
    settings = (entry.get("pipeline") or {}).get("settings")
    daf = enzyme in ("ddda", "dddb")
    source = None
    extra: list[str] = []
    labels: list[str] = []
    changes: list[str] = []
    rewrites: list[dict] = []
    more: list[tuple[str, list[str]]] = []
    if isinstance(settings, dict) and settings:
        source = "outputs.json"
        unknown = sorted(k for k in settings if k not in SETTING_KEYS)
        if unknown:
            raise RecallError("The original run records calling settings this FiberBrowser cannot carry into a "
                              f"re-call ({', '.join(unknown)}); update FiberBrowser, or start a New DAF-seq run "
                              "from the aligned reads.")
        recorded_enzyme = str(settings.get("enzyme") or enzyme).lower()
        if recorded_enzyme != enzyme:
            raise RecallError(f"The original run was called as {recorded_enzyme}, but this BAM declares {enzyme}.")
        call_args = settings.get("call_args") or []
        if not isinstance(call_args, list) or not all(isinstance(a, str) for a in call_args):
            raise RecallError(f"The original run records call_args={call_args!r}, which is not a list of arguments.")
        call_args, dropped = rh.drop_retired(call_args)
        rewrites += [{"flag": f"--call-args {d['flag']}", "from": d["value"], "to": None, "why": d["why"]}
                     for d in dropped]
        # Written before FiberHMM 3.0 called supplementary alignments (and kept DAF soft clips, and masked
        # DAF unaligned bases): its primary_only/hard_clip true were the defaults then.
        legacy = "alignments" not in settings
        primary = settings.get("primary_only")
        if primary is not None and not isinstance(primary, bool):
            raise RecallError(f"The original run records primary_only={primary!r}, which is not true/false.")
        if legacy:
            alignments = "all" if primary is False else "primary-supplementary"
            if primary is not False:
                changes.append("alignments")
        else:
            alignments = settings["alignments"]
            if alignments not in pi.ALIGNMENT_SETS:
                raise RecallError(f"The original run records alignments={alignments!r}, which this FiberBrowser "
                                  "does not know.")
            if primary is not None and primary != (alignments == "primary"):
                raise RecallError(f"The original run records alignments={alignments} with primary_only={primary}, "
                                  "which contradict each other; the Library will not guess which applied.")
        prob = settings.get("prob_threshold")
        options = {
            "dedup": _tristate(settings.get("dedup"), "dedup"),
            "dedup_mode": settings.get("dedup_mode") or "flag",
            "snp_screen": _tristate(settings.get("snp_screen"), "snp_screen"),
            "snp_mask": settings.get("snp_mask") or "",
            "chimera_filter": True if settings.get("chimera_filter") is None else settings["chimera_filter"],
            "alignments": alignments,
            "prob_threshold": None if prob in (None, "auto") else _int_setting(settings, "prob_threshold"),
            "use_m5c": _tristate(settings.get("use_m5c"), "use_m5c"),
            "cpg_mask_policy": settings.get("cpg_mask_policy") or "unmethylated-only",
        }
        if not isinstance(options["chimera_filter"], bool):
            raise RecallError(f"The original run records chimera_filter={options['chimera_filter']!r}, which is "
                              "not true/false.")
        seq = settings.get("seq")
        # A concrete platform is always passed on: since FiberHMM 3.0 a DAF run without --seq takes the
        # platform from the reads' header records, which need not match what the original run used.
        if seq not in (None, "auto"):
            if seq not in ("nanopore", "pacbio"):
                raise RecallError(f"The original run records seq={seq!r}, which this FiberBrowser does not know.")
            more.append((f"{seq} reads", ["--seq", str(seq)]))
        for key, flag, label in (("min_mapq", "--min-mapq", "MAPQ"), ("min_read_length", "--min-read-length",
                                                                          "min read length")):
            value = _int_setting(settings, key)
            if value is not None and value != PIPELINE_DEFAULTS[key]:
                more.append((f"{label} {value}", [flag, str(value)]))
        # hard_clip: on / off / circular since FiberHMM 3.0 (circular: the DAF default); true/false before.
        hard_clip = settings.get("hard_clip")
        if hard_clip is False or hard_clip == "off":
            more.append(("keep soft clips", ["--keep-soft-clips"]))
        elif hard_clip == "on":
            more.append(("hard-clip every contig", ["--hard-clip"]))
        elif hard_clip is True or (hard_clip is None and legacy):
            if daf:
                changes.append("soft_clips")
        elif hard_clip not in (None, "circular"):
            raise RecallError(f"The original run records hard_clip={hard_clip!r}, which this FiberBrowser does "
                              "not know.")
        # daf_unaligned_mask: as fiberhmm-call resolved it (its --call-args switch, else the pipeline's option).
        mask, mask_switch = settings.get("daf_unaligned_mask"), _call_switch(call_args, "--daf-mask-unaligned")
        if mask is False and mask_switch is None:
            more.append(("DAF unaligned bases not masked", ["--no-daf-mask-unaligned"]))
        elif mask is None and "daf_unaligned_mask" not in settings and daf and mask_switch is None:
            changes.append("daf_unaligned_mask")
        elif mask not in (None, True, False):
            raise RecallError(f"The original run records daf_unaligned_mask={mask!r}, which is not true/false.")
        # daf_insert_consensus: fiberhmm-call's default, or "off" from the --call-args carried below.
        if settings.get("daf_insert_consensus") not in (None, "auto", "off"):
            raise RecallError(f"The original run records daf_insert_consensus={settings['daf_insert_consensus']!r}, "
                              "which this FiberBrowser does not know.")
        if settings.get("origin_merge") is False:
            more.append(("no origin merge", ["--no-origin-merge"]))
        if settings.get("qc") is False:
            more.append(("no QC", ["--no-qc"]))
        if settings.get("tracks") is True:
            more.append(("tracks", ["--tracks"]))
        # The basecaller the original run was told about (--basecaller-info / --modbase-model): the
        # re-call's reads keep it in their header too, but it is passed again so it can never be lost.
        more += override_args(settings.get("basecaller_override"))
        if call_args:
            # Attached: a value starting with '-' and without a space would be read as an option.
            more.append((f"fiberhmm-call {' '.join(call_args)}", [f"--call-args={shlex.join(call_args)}"]))
    elif isinstance(spec.get("options"), dict):
        source = "run record"
        options = dict(spec["options"])
        if "alignments" not in options:
            # A run from before FiberHMM 3.0's defaults changed: its pipeline called primary alignments
            # (primary_only false: every alignment), hard-clipped DAF reads and used no unaligned-base mask.
            if options.pop("primary_only", True) is False:
                options["alignments"] = "all"
            else:
                changes.append("alignments")
            if daf:
                changes += ["soft_clips", "daf_unaligned_mask"]
    else:
        raise RecallError(UNKNOWN_SETTINGS, start_new_run=True)
    # 3.0 defaults the original run predates: listed, and the original kept on request.
    keep = set(keep_old or [])
    known = _pipeline_default_changes()
    changed_defaults: list[dict] = []
    for change_id in changes:
        text, restore = known[change_id]
        if help_text is not None and not pi._has_flag(help_text, restore[0]):
            restore = None
        kept = bool(restore) and change_id in keep
        changed_defaults.append({"id": change_id, "text": text, "restore": restore, "kept_old": kept})
        if kept and change_id == "alignments":
            options["alignments"] = "primary"
        elif kept:
            more.append((f"original behaviour kept: {' '.join(restore)}", list(restore)))
    unknown_keep = keep - {c["id"] for c in changed_defaults if c["restore"]}
    if unknown_keep:
        raise RecallError(f"There is no original behaviour to keep for {sorted(unknown_keep)[0]} in this re-call.")
    try:
        options = pi.normalize_options(options)
        extra = pi.option_args(options, enzyme, help_text)
    except pi.InputError as exc:
        raise RecallError(f"The original run's settings cannot be used for a re-call: {exc}") from exc
    labels = pi.changed_options(options, enzyme)
    for label, flag in more:
        name = flag[0].split("=", 1)[0]
        if help_text is not None and not pi._has_flag(help_text, name):
            raise RecallError(f"This FiberHMM's fiberhmm-pipeline has no {name} ({label}), which the original "
                              "run used; update FiberHMM.")
        extra += flag
        labels.append(label)
    regions = spec.get("regions") if isinstance(spec.get("regions"), list) else None
    if regions is not None:
        try:
            regions = pi.parse_regions(regions)
        except pi.InputError as exc:
            raise RecallError(f"The original run's regions cannot be used: {exc}") from exc
    basecaller = None
    if isinstance(settings, dict) and isinstance(settings.get("basecaller"), dict):
        basecaller = inspect.compact_basecaller(settings["basecaller"], "outputs.json")
    return {"source": source, "options": options, "extra": extra, "labels": labels, "regions": regions,
            "changed_defaults": changed_defaults, "keep_old": sorted(keep), "rewrites": rewrites,
            "basecaller": basecaller}


def _reference_for(entry: dict) -> Optional[str]:
    pipeline = entry.get("pipeline") or {}
    job = entry.get("job") or {}
    for candidate in (pipeline.get("plasmid_map"), pipeline.get("reference_fasta"), (job.get("reference") or {}).get("path")):
        if candidate and os.path.isfile(candidate):
            return candidate
    for declared in (entry.get("reference") or {}).get("plasmid_maps") or []:
        if declared.get("path") and os.path.isfile(declared["path"]):
            return declared["path"]
    genome = (entry.get("reference") or {}).get("genome")
    if genome:
        from services.pipeline_inputs import catalog_genome_fasta
        local, _error = catalog_genome_fasta(genome)
        return local
    return None


def _file_identity(path: str) -> dict:
    """What a plan binds a file to: its size, modification time and sampled
    content digest (library_inspect.content_digest), so Start refuses a plan
    whose input changed after the user reviewed it."""
    where = os.path.abspath(os.path.expanduser(str(path)))
    identity = inspect.stat_identity(where)
    if identity is None:
        return {"path": where, "missing": True}
    out = {"path": where, "size": identity["size"], "mtime_ns": identity["mtime_ns"]}
    if not identity.get("cloud_only"):  # never download an online-only file to fingerprint it
        out["digest"] = inspect.content_digest(where, identity["size"])
    return out


def _argument_files(extra: list) -> list[str]:
    """Existing files named in the pipeline arguments (SNP masks, custom tables in --call-args)."""
    words: list[str] = []
    for arg in extra or []:
        text = str(arg)
        try:
            words.extend(shlex.split(text) if " " in text else [text])
        except ValueError:
            words.append(text)
    found = []
    for word in words:
        value = word.split("=", 1)[1] if word.startswith("-") and "=" in word else word
        if value and not value.startswith("-") and os.path.isfile(os.path.expanduser(value)):
            found.append(value)
    return found


def _expanded(path: str) -> list[str]:
    """A read folder or zip as the files a run would read from it (each bound by the plan)."""
    if not os.path.isdir(path) and not path.lower().endswith(".zip"):
        return [path]
    try:
        from services.pipeline_inputs import collect_read_sources
        sources, _warnings = collect_read_sources([path])
    except Exception:
        return [path]
    return [path] + sorted({s.zip_path or s.path for s in sources})


def _plan_inputs(plan: dict) -> list[str]:
    reads = [f for p in plan.get("reads") or [] for f in _expanded(str(p))]
    files = list(reads)
    for bam in reads:
        for index in (bam + ".bai", bam[:-4] + ".bai" if bam.endswith(".bam") else None, bam + ".csi"):
            if index and os.path.isfile(index):
                files.append(index)
    reference = (plan.get("reference") or {}).get("path")
    if reference:
        files.append(reference)
        for side in (reference + ".fai", reference + ".gzi"):
            if os.path.isfile(side):
                files.append(side)
    files.extend(_argument_files(plan.get("extra") or []))
    # Inputs a header re-call names (already one path each, spaces included).
    files.extend(f for p in plan.get("input_files") or [] for f in _expanded(str(p)) if os.path.exists(f))
    return list(dict.fromkeys(files))


def _git_dir(folder: str) -> Optional[str]:
    """The git directory of a work tree root: ``.git`` itself, or the directory a
    ``.git`` file names (``gitdir: <path>``, as in a linked worktree or submodule)."""
    git = os.path.join(folder, ".git")
    if os.path.isdir(git):
        return git
    if os.path.isfile(git):
        try:
            with open(git, encoding="utf-8") as handle:
                line = handle.readline().strip()
        except OSError:
            return None
        if line.startswith("gitdir:"):
            target = line.split(":", 1)[1].strip()
            target = target if os.path.isabs(target) else os.path.join(folder, target)
            return os.path.normpath(target) if os.path.isdir(target) else None
    return None


def _read_ref(git_dirs: list[str], ref: str) -> Optional[str]:
    for git in git_dirs:
        ref_file = os.path.join(git, ref)
        try:
            if os.path.isfile(ref_file):
                with open(ref_file, encoding="utf-8") as handle:
                    return handle.read().strip() or None
            packed = os.path.join(git, "packed-refs")
            if os.path.isfile(packed):
                with open(packed, encoding="utf-8") as handle:
                    for line in handle:
                        if line.rstrip().endswith(" " + ref) and not line.startswith(("#", "^")):
                            return line.split()[0]
        except OSError:
            continue
    return None


def _git_head(start: Optional[str]) -> Optional[str]:
    """The commit checked out in the git work tree holding ``start`` (read from
    the git files, no subprocess; linked worktrees' ``gitdir``/``commondir`` too)."""
    folder = os.path.abspath(start) if start else None
    for _ in range(4):
        if not folder:
            return None
        git = _git_dir(folder)
        if git is not None:
            try:
                with open(os.path.join(git, "HEAD"), encoding="utf-8") as handle:
                    head = handle.read().strip()
            except OSError:
                return None
            if not head.startswith("ref:"):
                return head or None
            dirs = [git]
            try:
                with open(os.path.join(git, "commondir"), encoding="utf-8") as handle:
                    common = handle.read().strip()
                dirs.append(os.path.normpath(common if os.path.isabs(common) else os.path.join(git, common)))
            except OSError:
                pass
            return _read_ref(dirs, head.split(":", 1)[1].strip())
        parent = os.path.dirname(folder)
        folder = parent if parent != folder else None
    return None


# Run in the job's own interpreter and environment: where its ``import <package>``
# would come from. find_spec of a top-level package does not execute it.
_LOCATE_PACKAGE = (
    "import importlib.util, json, os, sys\n"
    "first = sys.argv[2] or os.getcwd()  # what the job's launch puts first: its cwd as Python sees it, or its script's folder\n"
    "if sys.path and sys.path[0] == '':\n"
    "    sys.path[0] = first\n"
    "elif getattr(sys, 'frozen', False) and first not in sys.path:\n"
    "    sys.path.insert(0, first)  # the frozen app's -m role puts its cwd first too (fiberbrowser/frozen_entry.py)\n"
    "spec = importlib.util.find_spec(sys.argv[1])\n"
    "print(json.dumps({'locations': list(getattr(spec, 'submodule_search_locations', None) or []) if spec else [],"
    " 'origin': getattr(spec, 'origin', None) if spec else None, 'python': sys.version.split()[0]}))\n"
)
_VERSION_RE = re.compile(r"""^__version__\s*=\s*['"]([^'"]+)['"]""", re.M)


class _EntryPoint:
    """How the job's command starts Python: the interpreter, its options, the
    top-level package it runs, and what goes first on sys.path ("cwd" for
    ``-m``, else the script's folder)."""

    def __init__(self, interpreter: str, options: list[str], package: str, path0: Optional[str]):
        self.interpreter, self.options, self.package, self.path0 = interpreter, options, package, path0


def _job_entry_point(argv: list[str], env: dict) -> Optional[_EntryPoint]:
    """The job's ``python [options] -m pkg.mod ...``, or a console script whose
    ``#!`` names the interpreter (and its options) and which imports from pkg.
    None for anything else (a binary is fingerprinted as a file only)."""
    import shutil

    if not argv:
        return None
    path = env.get("PATH")
    first = shutil.which(argv[0], path=path) or (argv[0] if os.path.isfile(argv[0]) else None)
    if "-m" in argv[1:-1]:
        at = argv.index("-m", 1)
        if first is None:
            return None
        return _EntryPoint(first, argv[1:at], argv[at + 1].split(".")[0], "cwd")
    if first is None:
        return None
    try:
        with open(first, "rb") as handle:
            head = handle.read(4096).decode("utf-8", "replace")
    except OSError:
        return None
    lines = head.splitlines()
    if not lines or not lines[0].startswith("#!"):
        return None
    words = lines[0][2:].split()
    if words and os.path.basename(words[0]) == "env":
        words = [w for w in words[1:] if w != "-S"]  # "#!/usr/bin/env [-S] python3 [options]"
    if not words:
        return None
    interpreter = words[0] if os.path.isabs(words[0]) else shutil.which(words[0], path=path)
    if not interpreter:
        return None
    # pip's console scripts: "import re / import sys / from fiberhmm.cli.pipeline import main".
    entries = re.findall(r"^\s*from\s+([A-Za-z_]\w*)(?:\.[\w.]+)?\s+import\s", head, re.M)
    return _EntryPoint(interpreter, words[1:], entries[-1] if entries else "fiberhmm",
                       os.path.dirname(os.path.realpath(first)))


def _package_files_digest(root: str) -> tuple[str, int]:
    """sha256 over every file under ``root`` (relative name + content), following
    symlinked files and directories (each real directory once: no cycles);
    compiled caches (__pycache__, .pyc) excluded."""
    digest = hashlib.sha256()
    files = 0
    seen: set = set()

    def links(folder: str, entries: list) -> None:
        # Where each symlink points is part of the identity, not only what it reaches:
        # retargeting a link between folders already read changes the digest.
        for name in entries:
            full = os.path.join(folder, name)
            if os.path.islink(full):
                try:
                    target = os.readlink(full)
                except OSError:
                    target = "<unreadable>"
                digest.update(b"link\0" + os.path.relpath(full, root).encode() + b"\0" + target.encode() + b"\0")

    for folder, dirs, names in os.walk(root, followlinks=True):
        try:
            st = os.stat(folder)
            key = (st.st_dev, st.st_ino)
        except OSError:
            key = folder
        if key in seen:  # a link back to a directory already read
            dirs[:] = []
            digest.update(os.path.relpath(folder, root).encode() + b"\0<cycle>\0")
            continue
        seen.add(key)
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        links(folder, dirs + sorted(names))
        for name in sorted(names):
            if name.endswith((".pyc", ".pyo")):
                continue
            full = os.path.join(folder, name)
            digest.update(os.path.relpath(full, root).encode() + b"\0")
            try:
                with open(full, "rb") as handle:
                    for block in iter(lambda: handle.read(1 << 20), b""):
                        digest.update(block)
            except OSError:
                digest.update(b"<unreadable>")
            files += 1
    return digest.hexdigest(), files


def _probe_environment(env: dict, job_cwd: str) -> dict:
    """The job's environment for the probe. Unchanged when the probe runs in the
    job's existing working folder. For a folder that doesn't exist yet (the
    probe runs elsewhere and never creates it), relative PYTHONPATH entries are
    made absolute as Python will: against the folder's physical path (the
    existing part resolved through symlinks), which is what os.getcwd()
    returns once the launcher has changed into it."""
    out = dict(env)
    raw = out.get("PYTHONPATH")
    if raw is not None and not os.path.isdir(job_cwd):
        physical = os.path.realpath(job_cwd)
        out["PYTHONPATH"] = os.pathsep.join(
            os.path.normpath(os.path.join(physical, entry)) if not os.path.isabs(entry) else entry
            for entry in raw.split(os.pathsep))
    return out


def _package_identity(entry: _EntryPoint, env: dict, job_cwd: str) -> dict:
    """The package the job would import, located by the job's interpreter with the
    job's options, environment and first sys.path entry (its working folder for
    ``-m``, the script's folder for a console script), without creating or
    changing anything: its location, version, git commit and a digest of all
    its files (code and bundled tables, through symlinks)."""
    import subprocess
    import tempfile

    # "" in an existing folder: the probe takes os.getcwd() there, as the job's Python will
    # (a symlinked folder is seen by its physical path).
    if entry.path0 == "cwd":
        path0 = "" if os.path.isdir(job_cwd) else os.path.realpath(job_cwd)
    else:
        path0 = entry.path0
    try:
        with tempfile.TemporaryDirectory(prefix="fiberbrowser-probe-") as empty:
            # In the job's folder when it exists; else in an empty one, as the new folder will be.
            where = job_cwd if os.path.isdir(job_cwd) else empty
            probe = subprocess.run([entry.interpreter, *entry.options, "-c", _LOCATE_PACKAGE, entry.package, path0],
                                   env=_probe_environment(env, job_cwd), cwd=where, stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, timeout=60)
        found = json.loads(probe.stdout.strip().splitlines()[-1]) if probe.returncode == 0 and probe.stdout.strip() else None
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        found = None
    if not found or not (found.get("locations") or found.get("origin")):
        return {"package": entry.package, "found": False}
    root = found["locations"][0] if found.get("locations") else found["origin"]
    if os.path.isdir(root):
        digest, files = _package_files_digest(root)
    else:
        digest, files = hashlib.sha256(json.dumps(_file_identity(root), sort_keys=True).encode()).hexdigest(), 1
    version = None
    init = os.path.join(root, "__init__.py") if os.path.isdir(root) else root
    try:
        with open(init, encoding="utf-8", errors="replace") as handle:
            match = _VERSION_RE.search(handle.read())
        version = match.group(1) if match else None
    except OSError:
        pass
    return {"package": entry.package, "found": True, "location": os.path.realpath(root), "version": version,
            "files": files, "digest": digest, "python": found.get("python"),
            "commit": _git_head(os.path.dirname(os.path.realpath(root)))}


def _job_environment(command: dict) -> dict:
    """The environment the job launcher (pipeline_jobs.JobManager._launch) gives the job."""
    env = dict(os.environ)
    env.update({str(k): str(v) for k, v in (command.get("env") or {}).items()})
    env.setdefault("FIBERHMM_NO_UPDATE_CHECK", "1")
    env["PYTHONUNBUFFERED"] = "1"
    return env


def _fiberhmm_identity(command: dict, cwd: Optional[str] = None) -> dict:
    """What FiberHMM a plan's job runs, resolved as the job launcher runs it: the
    same argv interpreter and interpreter options, the launcher's environment
    (FiberBrowser's own plus the command's, e.g. the PYTHONPATH of
    FIBERHMM_SOURCE_DIR / fiberhmm_source_dir or the bundled runtime) and the
    job's working folder ``cwd`` (the output folder; not created here). Binds the
    command and environment, the executable's file, and the package that
    interpreter would import: its location, version, git commit (worktrees too)
    and a digest of all its files. RecallError when a ``-m`` command's package
    can't be located that way (the plan would bind something else); the
    Browser's own version only for a command that isn't Python."""
    import shutil

    argv = [str(a) for a in command.get("argv") or []]
    extra_env = {str(k): str(v) for k, v in (command.get("env") or {}).items()}
    env = _job_environment(command)
    job_cwd = os.path.abspath(os.path.expanduser(cwd)) if cwd else os.getcwd()
    out: dict = {"argv": argv, "env": extra_env, "cwd": job_cwd}
    executable = shutil.which(argv[0], path=env.get("PATH")) if argv else None
    if executable:
        out["executable"] = _file_identity(os.path.realpath(executable))
    entry = _job_entry_point(argv, env)
    if entry is not None:
        out["runs"] = _package_identity(entry, env, job_cwd)
        if not out["runs"]["found"] and entry.path0 == "cwd":
            raise RecallError(f"The re-call command ({' '.join(argv[:4])}) can't import {entry.package} "
                              "from the job's environment, so the Library can't tell which FiberHMM it would run.")
    if not (out.get("runs") or {}).get("found"):
        # Not a Python entry point it can resolve: bind the Browser's version as the best evidence.
        out["browser_version"] = inspect.current_fiberhmm_version()
    return out


def _job_fiberhmm_version(identity: dict) -> Optional[str]:
    runs = identity.get("runs") or {}
    return runs.get("version") if runs.get("found") else identity.get("browser_version")


def _plan_id(plan: dict, entry: dict, identity: Optional[dict] = None) -> str:
    """Identifies what a plan runs, so Start runs exactly the plan the user reviewed.

    Besides the arguments, it binds the plan to the current identity of every
    input file (reads, their index, the reference and its index, masks and
    tables named in the arguments) and to the FiberHMM that runs it (command,
    environment, version, executable/package files, git commit). Computed
    afresh when the plan is made and again at Start, so a change to any of
    them in between refuses the start."""
    what = {k: plan.get(k) for k in ("tool", "sample", "enzyme", "cores", "reads", "outdir", "regions", "extra",
                                     "options", "advisories_fixed")}
    what["entry"] = entry.get("id")
    what["reference"] = (plan.get("reference") or {}).get("path")
    what["settings"] = {k: (plan.get("settings") or {}).get(k) for k in ("source", "labels", "changed_defaults",
                                                                         "keep_old", "rewrites")}
    header = plan.get("header") or {}
    if header:  # the recorded command, every rewrite of it, and the choices made in the review
        what["header"] = {k: header.get(k) for k in ("command_line", "version", "rewrites", "changed_defaults",
                                                     "input", "keep_old")}
        what["output_bam"] = plan.get("output_bam")
        what["input_files"] = plan.get("input_files")
    what["inputs"] = [_file_identity(path) for path in _plan_inputs(plan)]
    what["fiberhmm"] = identity if identity is not None else _fiberhmm_identity(plan.get("command") or {},
                                                                                 plan.get("outdir"))
    return hashlib.sha256(json.dumps(what, sort_keys=True, default=str).encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Settings from the BAM header: re-run the recorded fiberhmm-call / -pipeline command
# ---------------------------------------------------------------------------

_parser_cache: dict[str, dict] = {}


def _probe_parser(command: dict, tool: str, job_cwd: str, argvs: Optional[list[list[str]]] = None,
                  identity: Optional[dict] = None) -> dict:
    """The current ``tool``'s argparse option table, read by its own parser in the job's
    interpreter, options and environment (as _package_identity resolves the package); with
    ``argvs``, also each argv parsed by that parser ({'namespace'} or {'error'}).
    The table is cached per command and FiberHMM identity."""
    import subprocess
    import tempfile
    from services.recall_header import HEADER_TOOLS, PARSER_PROBE

    argv = [str(a) for a in command.get("argv") or []]
    env = _job_environment(command)
    entry = _job_entry_point(argv, env)
    if entry is None:
        raise RecallError(f"The Library cannot read the options of this {tool} ({' '.join(argv[:3])}): it is not "
                          "a Python command it can ask, so it cannot check the header's command against it.")
    key = json.dumps([argv, command.get("env") or {}, job_cwd, (identity or {}).get("runs")], sort_keys=True,
                     default=str)
    if argvs is None and key in _parser_cache:
        return _parser_cache[key]
    if entry.path0 == "cwd":
        path0 = "" if os.path.isdir(job_cwd) else os.path.realpath(job_cwd)
    else:
        path0 = entry.path0 or ""
    try:
        with tempfile.TemporaryDirectory(prefix="fiberbrowser-probe-") as empty:
            where = job_cwd if os.path.isdir(job_cwd) else empty
            proc = subprocess.run([entry.interpreter, *entry.options, "-c", PARSER_PROBE, HEADER_TOOLS[tool], path0,
                                   "parse" if argvs is not None else "table"],
                                  input=json.dumps(argvs or []), env=_probe_environment(env, job_cwd), cwd=where,
                                  capture_output=True, text=True, timeout=120)
        lines = proc.stdout.strip().splitlines()
        found = json.loads(lines[-1]) if proc.returncode == 0 and lines else None
    except (OSError, ValueError, subprocess.SubprocessError):
        found = None
    if not isinstance(found, dict) or found.get("error") or not found.get("actions"):
        why = (found or {}).get("error") if isinstance(found, dict) else None
        raise RecallError(f"The Library could not read this FiberHMM's {tool} options"
                          + (f" ({why})" if why else "") + ", so it cannot check the header's command against them.")
    if argvs is None:
        _parser_cache[key] = found
    return found


def _settings_source(entry: dict) -> Optional[str]:
    settings = (entry.get("pipeline") or {}).get("settings")
    if isinstance(settings, dict) and settings:
        return "outputs.json"
    if isinstance((_job_spec(entry) or {}).get("options"), dict):
        return "run record"
    return None


def _indexed(path: str) -> bool:
    candidates = (path + ".bai", path[:-4] + ".bai" if path.endswith(".bam") else None, path + ".csi")
    return any(c and os.path.isfile(c) for c in candidates)


def _input_facts(path: str, entry: dict) -> dict:
    """What the Library can tell about a re-call's input without downloading it: online-only,
    the BAM being re-called, FiberHMM output (header only)."""
    identity = inspect.stat_identity(path) or {}
    facts = {"path": path, "cloud_only": bool(identity.get("cloud_only")), "size": identity.get("size"),
             "is_entry": False, "fiberhmm_output": None}
    try:
        facts["is_entry"] = os.path.samefile(path, entry["path"])
    except OSError:
        facts["is_entry"] = os.path.realpath(path) == os.path.realpath(entry["path"])
    if not facts["cloud_only"] and path.lower().endswith((".bam", ".cram")):
        programs = _header_programs(path)
        if programs is not None:
            made = [str(pg.get("PN") or pg.get("ID") or "") for pg in programs]
            made = [name for name in made if name.lower().startswith("fiberhmm")]
            facts["fiberhmm_output"] = made[-1] if made else False
    return facts


def _undeduplicated_problem(facts: dict) -> Optional[str]:
    if facts.get("is_entry"):
        return "the command's input is this BAM itself, not the un-deduplicated reads"
    if facts.get("fiberhmm_output"):
        return (f"its input ({os.path.basename(facts['path'])}) is itself FiberHMM output (its header has a "
                f"{facts['fiberhmm_output']} @PG), not the un-deduplicated reads")
    return None


# Advisories a re-run of the header's fiberhmm-call command can fix (checked per command in _header_remedy).
CALL_REMEDIES = ("dddb-gt-table", "daf-dedup-orientation", "qc-nanopore-opportunities")


def _refuse_manual(items: list[dict], tool: str) -> None:
    """Refuse (with FiberHMM's own fix) advisories that need steps ``tool`` does not run."""
    known = ADVISORY_REMEDIES if tool == "fiberhmm-pipeline" else dict.fromkeys(CALL_REMEDIES, "call")
    manual = [a for a in items if known.get(str(a.get("id"))) is None]
    if manual:
        raise _manual_refusal(manual, tool)


def _header_remedy(entry: dict, tool: str, result: dict, namespace: dict, facts: dict,
                   enzyme: str, call_namespace: Optional[dict] = None) -> tuple[list[str], list[dict]]:
    """(advisories this re-call fixes, [{id, title, reason}] it does not fix). Refuses
    (RecallError) when an advisory needs steps the command does not run, or when it
    would fix none of them."""
    items = _rerun_items(entry.get("advisories"))
    _refuse_manual(items, tool)
    fixed: list[str] = []
    not_fixed: list[dict] = []
    flags = set(result.get("flags") or [])
    if tool == "fiberhmm-call":
        dedups = bool(namespace.get("dedup") or namespace.get("dedup_collapse") or namespace.get("dedup_flag_only")
                      or (namespace.get("dedup") is None and enzyme in ("ddda", "dddb")
                          and namespace.get("mode") in (None, "daf")))
        custom = sorted(flags & {"-m", "--model", "--recall-model"})
    else:
        # The pipeline's own options, then what its --call-args hand fiberhmm-call (parsed by
        # fiberhmm-call's parser; they come after the pipeline's own, so they win there).
        nested = call_namespace or {}
        dedups = namespace.get("dedup") in ("auto", "on")
        if nested.get("dedup") is not None:
            dedups = bool(nested["dedup"])
        elif nested.get("dedup_collapse") or nested.get("dedup_flag_only"):
            dedups = True
        custom = [f"{flag} in --call-args" for key, flag in (("model", "-m"), ("recall_model", "--recall-model"))
                  if nested.get(key)]
    runs_qc = namespace.get("qc") is not False
    for advisory in items:
        aid = str(advisory.get("id"))
        reason = None
        if aid == "dddb-gt-table":
            if custom:
                reason = (f"the original command called with its own table ({custom[0]}); re-running it with the "
                          "same table repeats the problem")
        elif aid == "daf-dedup-orientation":
            if not dedups:
                reason = "the original command turned duplicate marking off, so the re-call would not mark duplicates"
            else:
                reason = _undeduplicated_problem(facts)
        elif aid == "qc-nanopore-opportunities":
            if not runs_qc:
                reason = "the original command skipped QC (--no-qc), so the re-call would not remake it"
        if reason:
            not_fixed.append({"id": aid, "title": advisory.get("title") or aid, "reason": reason,
                              "fix": advisory.get("fix")})
        else:
            fixed.append(aid)
    if not_fixed and not fixed:
        lines = [f"- {n['title']}: {n['reason']}." + (f" FiberHMM's fix: {n['fix']}" if n.get("fix") else "")
                 for n in not_fixed]
        raise RecallError("Re-running the command this BAM's header records would not fix what FiberHMM reports:\n"
                          + "\n".join(lines))
    return fixed, not_fixed


def _confine_header_paths(inputs: list[str], outdir: str, outputs: list[str]) -> None:
    """A lab server: every file the command reads inside the data roots, everything it
    writes in a writable one (a no-op elsewhere)."""
    from services.lab.paths import PathDenied, confine, enforcing
    if not enforcing():
        return
    for path, write in [(p, False) for p in inputs] + [(outdir, True)] + [(p, True) for p in outputs]:
        try:
            confine(path, write=write)
        except PathDenied as exc:
            raise RecallError(f"{exc} ({os.path.basename(str(path))})") from None


def _plan_header_recall(entry: dict, enzyme: str, *, outdir: Optional[str], cores: Optional[int],
                        input_path: Optional[str], keep_old: Optional[list[str]]) -> dict:
    """Re-run the FiberHMM command this BAM's header records, with the current FiberHMM
    and the same tool (see services/recall_header.py)."""
    from services import pipeline_inputs as pi
    from services import recall_header as rh
    from services.lab.jobs import max_cores

    if entry.get("cloud_only"):
        raise RecallError("This BAM is an online-only file: the Library does not download it to read the command "
                          "its header records. Make it available offline (Dropbox: Make available offline) and "
                          "try again, or start a New DAF-seq run from the aligned reads.", start_new_run=True)
    found = rh.calling_program(_header_programs(entry["path"]) or [])
    if found is None or not found["cl"].strip():
        raise RecallError(UNKNOWN_SETTINGS, start_new_run=True)
    tool = found["name"]
    if tool not in rh.HEADER_TOOLS:
        raise RecallError(f"This BAM was made by {tool} {found.get('version') or ''}".rstrip() + ", which the Library "
                          "cannot re-run from its header (FiberHMM 3.0's caller is fiberhmm-call, whose options "
                          "differ). " + UNKNOWN_SETTINGS.split(" so it will not re-call it with guessed settings. ")[-1],
                          start_new_run=True)
    _refuse_manual(_rerun_items(entry.get("advisories")), tool)
    command = pi.call_command() if tool == "fiberhmm-call" else pi.pipeline_command()
    if not command.get("argv"):
        raise RecallError(command.get("hint") or f"{tool} is not installed.")
    sample = pi.sanitize_sample_name(f"{entry.get('sample') or 'sample'}")
    cores = max(1, min(int(cores or pi.default_cores()), max_cores()))
    platform = str((entry.get("chemistry") or {}).get("platform") or "").lower() or None
    identity = _fiberhmm_identity(command, outdir or pi.default_output_root(f"{sample}_recall"))
    version = _job_fiberhmm_version(identity) or "current"
    chosen = outdir
    base = outdir or pi.default_output_root(f"{sample}_recall_fiberhmm{version}")
    for attempt in range(1, 100):
        folder = base if chosen or attempt == 1 else f"{base}_{attempt}"
        folder, _warnings = pi.check_output_dir(folder)
        identity = _fiberhmm_identity(command, folder)
        table = rh.Table(tool, _probe_parser(command, tool, folder, identity=identity))
        call_table = (rh.Table("fiberhmm-call", _probe_parser(command, "fiberhmm-call", folder, identity=identity))
                      if tool == "fiberhmm-pipeline" else None)
        major = str(table.version or "").split(".")[0]
        if not major.isdigit() or int(major) < 3:
            raise RecallError(f"The {tool} the Library would run is FiberHMM {table.version or 'of unknown version'} "
                              f"({' '.join(command['argv'][:3])}); a re-call needs FiberHMM 3.0 or newer.")
        try:
            result = rh.build(tool=tool, cl=found["cl"], ds=found["ds"], table=table, entry_path=entry["path"],
                              enzyme=enzyme, platform=platform, outdir=folder, cores=cores, input_override=input_path,
                              keep_old=keep_old, indexed=_indexed, call_table=call_table)
        except rh.CommandError as exc:
            raise RecallError(str(exc), needs_input=exc.needs_input,
                              start_new_run=exc.needs_input is None) from None
        existing = [p for p in [*result["outputs"], *result["written"]] if os.path.lexists(p) and not os.path.isdir(p)]
        if tool == "fiberhmm-pipeline" and os.path.isdir(folder) and os.listdir(folder):
            existing.append(os.path.join(folder, sorted(os.listdir(folder))[0]))  # a pipeline run needs a new folder
        if not existing:
            break
        if chosen:
            raise RecallError(f"{folder} already has {os.path.basename(existing[0])}; choose another output folder "
                              "(a re-call never overwrites earlier results).")
    else:
        raise RecallError(f"Choose an output folder: {base} and its numbered variants already hold results.")
    outdir = folder
    parsed = _probe_parser(command, tool, outdir, [result["original_args"], result["args"]], identity=identity)
    before, after = (parsed.get("parsed") or [{}, {}])[:2]
    if before.get("error"):
        raise RecallError(f"The header's {tool} options do not parse with this FiberHMM's {tool} ({before['error']}); "
                          "the Library will not change them to make them fit.", start_new_run=True)
    if after.get("error"):
        raise RecallError(f"The re-call's options do not parse with this FiberHMM's {tool} ({after['error']}).")
    silent = rh.silent_changes(before.get("namespace") or {}, after.get("namespace") or {},
                               rh.allowed_changes(tool, result))
    if silent:
        raise RecallError(f"Rewriting the header's command would also change {', '.join(silent)}, which the "
                          "Library does not list as a change; it will not run it.")
    namespace = after.get("namespace") or {}
    call_namespace = None
    if tool == "fiberhmm-pipeline":  # what its --call-args hand fiberhmm-call, as fiberhmm-call reads them
        nested = _probe_parser(command, "fiberhmm-call", outdir,
                               [["-i", "in.bam", "-o", "out.bam", *result["call_args"]]], identity=identity)
        answer = (nested.get("parsed") or [{}])[0]
        if answer.get("error"):
            raise RecallError(f"The original --call-args do not parse with this FiberHMM's fiberhmm-call "
                              f"({answer['error']}).")
        call_namespace = answer.get("namespace") or {}
    main = result["input"]["path"]
    facts = _input_facts(main, entry)
    fixed, not_fixed = _header_remedy(entry, tool, result, namespace, facts, enzyme, call_namespace)
    warnings = list(result["warnings"])
    if facts["cloud_only"]:
        size = f" ({facts['size'] / 1e9:.1f} GB)" if facts.get("size") else ""
        warnings.append(f"The input is an online-only Dropbox file{size}: starting the re-call downloads it. The "
                        "Library has not read it, so it could not check that it is the reads the original "
                        "command called.")
    reads = [main] if tool == "fiberhmm-call" else list(next(i["values"] for i in result["items"]
                                                            if i["dest"] == rh.MAIN_INPUT[tool]))
    reference = namespace.get("reference") if isinstance(namespace.get("reference"), str) else None
    _confine_header_paths(list(dict.fromkeys([*reads, *result["input_files"], *([reference] if reference else []),
                                              *_argument_files(result["args"])])),
                          outdir, result["outputs"])
    labels = [f"the {tool} {found.get('version') or ''}".rstrip() + " command in the BAM header"]
    labels += [f"original behaviour kept: {' '.join(c['restore'])}" for c in result["changed_defaults"]
               if c.get("kept_old")]
    plan = {"tool": tool, "command": command, "outdir": outdir, "sample": sample, "enzyme": enzyme,
            "cores": cores, "reads": reads,
            "reference": ({"path": reference, "kind": pi.reference_kind(reference) or "fasta",
                           "label": os.path.basename(reference)} if reference else None),
            "regions": [], "extra": result["args"], "options": {},
            "settings": {"source": "BAM header", "labels": labels, "regions_recorded": False,
                         "basecaller": entry.get("basecaller")},
            "header": {"program": tool, "version": found.get("version"), "command_line": found["cl"],
                       "rewrites": result["rewrites"], "changed_defaults": result["changed_defaults"],
                       "input": {**result["input"], "cloud_only": facts["cloud_only"]},
                       "warnings": warnings, "not_fixed": not_fixed, "keep_old": sorted(set(keep_old or []))},
            "output_bam": result["output_bam"], "qc_prefix": result["qc_prefix"],
            "input_files": result["input_files"], "advisories_fixed": fixed, "version": version}
    plan["display_command"] = rh.display(tool, result["args"])
    plan["plan_id"] = _plan_id(plan, entry, identity)
    return plan


def _header_job_args(plan: dict, progress: str) -> list[str]:
    """The plan's arguments with the job's progress file in place (only as the --progress-json value)."""
    from services.recall_header import PROGRESS_PLACEHOLDER
    args = list(plan["extra"])
    for i in range(1, len(args)):
        if args[i] == PROGRESS_PLACEHOLDER and args[i - 1] == "--progress-json":
            args[i] = progress
    return args


def plan_recall(entry: dict, *, outdir: Optional[str] = None, cores: Optional[int] = None,
                input_path: Optional[str] = None, keep_old: Optional[list[str]] = None) -> dict:
    """What "Re-call with FiberHMM <current>" runs for an entry (nothing is started).

    With the original run's settings (its outputs.json, else its New DAF-seq run
    record): a full fiberhmm-pipeline re-call from the run's aligned reads with
    those settings and regions. With neither: the FiberHMM command the BAM's
    header records, re-run with the same tool (``input_path``: the input when
    the header's is not found here; ``keep_old``: 3.0 default changes to undo).
    Refused, with the reason, when an advisory needs steps the re-call does not
    run or the original settings cannot be recovered."""
    from services import pipeline_inputs as pi

    if entry.get("kind") != "bam":
        raise RecallError("Only a BAM can be re-called.")
    enzyme = str((entry.get("chemistry") or {}).get("enzyme") or (entry.get("pipeline") or {}).get("enzyme") or "").lower()
    if enzyme not in pi.ENZYMES:
        raise RecallError("Re-calling from the Library handles DddA and DddB DAF-seq; this BAM is "
                          f"{enzyme or 'of unknown chemistry'}.")
    if _settings_source(entry) is None:
        return _plan_header_recall(entry, enzyme, outdir=outdir, cores=cores, input_path=input_path,
                                   keep_old=keep_old)
    if input_path:
        raise RecallError("This re-call keeps the original run's recorded settings and reads; it takes no other "
                          "input.")
    remedy = recall_remedy(entry.get("advisories"))
    command = pi.pipeline_command()
    if not command.get("argv"):
        raise RecallError(command.get("hint") or "fiberhmm-pipeline is not installed.")
    reference = _reference_for(entry)
    if not reference:
        raise RecallError("The reference these reads were aligned to was not found: open the entry, "
                          "load its genome or plasmid map, and start a New DAF-seq run instead.")
    settings = recall_settings(entry, enzyme, pi.pipeline_help(command["argv"], command.get("env")), keep_old)
    pipeline = entry.get("pipeline") or {}
    aligned = pipeline.get("aligned_bam")
    # A run from raw POD5: its basecalled BAM holds every read dorado made (never basecalled again here).
    basecalled = pipeline.get("basecalled_bam")
    if aligned and os.path.isfile(aligned):
        reads = [aligned]
    elif basecalled and os.path.isfile(basecalled):
        reads = [basecalled]
    elif remedy["kind"] == "aligned":
        raise RecallError("FiberHMM's fix needs the un-deduplicated aligned reads (the run's aligned BAM), which "
                          "were not found; re-call from the original reads with a New DAF-seq run instead.")
    else:
        reads = [entry["path"]]
    sample = pi.sanitize_sample_name(f"{entry.get('sample') or 'sample'}")
    # The FiberHMM the job runs (not the Browser's), resolved in the job's own working folder:
    # first to name the default output folder after its version, then in the final folder.
    identity = _fiberhmm_identity(command, outdir or pi.default_output_root(f"{sample}_recall"))
    version = _job_fiberhmm_version(identity) or "current"
    outdir = outdir or pi.default_output_root(f"{sample}_recall_fiberhmm{version}")
    outdir, _warnings = pi.check_output_dir(outdir)
    identity = _fiberhmm_identity(command, outdir)
    from services.lab.jobs import max_cores
    cores = max(1, min(int(cores or pi.default_cores()), max_cores()))  # a lab server's per-run cap
    regions = settings["regions"] or []
    plan = {"tool": "fiberhmm-pipeline", "command": command, "outdir": outdir, "sample": sample,
            "enzyme": enzyme, "cores": cores, "reads": reads,
            "reference": {"path": reference, "kind": pi.reference_kind(reference) or "fasta",
                          "label": os.path.basename(reference)},
            "regions": regions, "extra": settings["extra"], "options": settings["options"],
            "settings": {"source": settings["source"], "labels": settings["labels"],
                         "regions_recorded": settings["regions"] is not None,
                         "changed_defaults": settings["changed_defaults"], "keep_old": settings["keep_old"],
                         "rewrites": settings["rewrites"],
                         "basecaller": settings.get("basecaller") or entry.get("basecaller")},
            "advisories_fixed": remedy["ids"], "version": version}
    args = pi.pipeline_args(reads=reads, reference=reference, enzyme=enzyme, outdir=outdir, sample=sample,
                            cores=cores, progress="<job>/progress.jsonl", regions=regions, extra=settings["extra"])
    plan["display_command"] = pi.display_command(args)
    plan["plan_id"] = _plan_id(plan, entry, identity)
    return plan


def submit_recall(entry: dict, *, plan_id: Optional[str] = None, **kwargs: Any) -> dict:
    """Queue the re-call as a job (it shows in Runs, and in the Library when done).

    ``plan_id``: the plan the user reviewed; refused when the plan is no longer that one."""
    from services import pipeline_inputs as pi
    from services.pipeline_jobs import get_job_manager, new_job_id

    plan = plan_recall(entry, **kwargs)
    if plan_id is not None and plan_id != plan["plan_id"]:
        raise RecallError("The re-call plan changed since it was shown (an input file, the reference, the "
                          "calling settings or the FiberHMM that runs it changed); review the new plan and "
                          "start it again.")
    from services.lab.jobs import check_submit, owner
    busy = check_submit(1)  # a lab server's run limits, as for the New DAF-seq run wizard
    if busy:
        raise RecallError(busy)
    manager = get_job_manager()
    job_id = new_job_id()
    while os.path.exists(os.path.join(manager.root, job_id)):
        job_id = new_job_id()
    progress = os.path.join(manager.root, job_id, "progress.jsonl")
    labels = [f"re-call with FiberHMM {plan['version']}"] + plan["settings"]["labels"]
    recall = {"entry_id": entry.get("id"), "path": entry.get("path"), "tool": plan["tool"],
              "settings_source": plan["settings"]["source"], "extra": plan["extra"],
              "advisories_fixed": plan["advisories_fixed"]}
    if plan["settings"]["source"] == "BAM header":
        from services.recall_header import display
        args = _header_job_args(plan, progress)
        recall.update(output_bam=plan["output_bam"], qc_prefix=plan.get("qc_prefix"),
                      original_command=plan["header"]["command_line"],
                      rewrites=plan["header"]["rewrites"], extra=args)
        display_command = display(plan["tool"], args)
    else:
        args = pi.pipeline_args(reads=plan["reads"], reference=plan["reference"]["path"], enzyme=plan["enzyme"],
                                outdir=plan["outdir"], sample=plan["sample"], cores=plan["cores"],
                                progress=progress, regions=plan["regions"], extra=plan["extra"])
        display_command = pi.display_command(args)
    spec = {
        "id": job_id, "created": time.time(), "group": None,
        "sample": plan["sample"], "enzyme": plan["enzyme"], "reference": plan.get("reference"),
        "reads": plan["reads"], "outdir": plan["outdir"], "output_root": plan["outdir"],
        "cores": plan["cores"], "regions": plan["regions"], "options": plan["options"], "option_labels": labels,
        "argv": [*plan["command"]["argv"], *args], "env": plan["command"].get("env") or {},
        "display_command": display_command, "auto_open": False, "tool": plan["tool"],
        "library_recall": recall,
    }
    if owner():
        spec["user"] = owner()  # lab servers: who started it
    from services.pipeline_jobs import JobRefused
    try:
        # Checked again under the registry lock, so concurrent submissions can't pass the limits.
        return manager.create(spec, admit=lambda: check_submit(1))
    except JobRefused as exc:
        raise RecallError(str(exc)) from None
