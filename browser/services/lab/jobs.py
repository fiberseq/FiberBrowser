"""New DAF-seq runs on a lab server: off unless ``[jobs] enabled = true``.

When on, runs are shared like everything else (every member sees every run,
each attributed to who started it), their output folders must be in a
writable data root (``paths``), and the caps of ``[jobs]`` apply: cores per
run (``max_cores_per_user``), runs queued or running per member
(``max_concurrent_per_user``) and on the server (``max_concurrent_total``);
the scheduler's total core budget is ``max_cores_total``
(``FIBERBROWSER_PIPELINE_CORES``). Only the member who started a run, or an
admin, can cancel, retry or remove it.
"""
from __future__ import annotations

import os
from typing import Optional

DISABLED_MESSAGE = ("New DAF-seq runs are turned off on this lab server. An admin can enable them "
                    "([jobs] enabled = true in the server config).")


def _cfg():
    from services.lab import get_config
    return get_config()


def refusal() -> Optional[str]:
    """Why pipeline routes are unavailable to this request (None: available)."""
    cfg = _cfg()
    if cfg is None:
        return None
    if not cfg.jobs.enabled:
        return DISABLED_MESSAGE
    return None


def max_cores() -> int:
    """Most cores one run may use here."""
    cpu = os.cpu_count() or 1
    cfg = _cfg()
    if cfg is None:
        return cpu
    limits = [v for v in (cfg.jobs.max_cores_per_user, cfg.jobs.max_cores_total) if v] or [cpu]
    return max(1, min([cpu, *limits]))  # never above the server's total either


def check_submit(new_jobs: int) -> Optional[str]:
    """Why this member may not queue ``new_jobs`` more runs (None: they may)."""
    cfg = _cfg()
    if cfg is None:
        return None
    from services.pipeline_jobs import ACTIVE, get_job_manager
    from services.runtime import current_lab_user
    user = current_lab_user()
    manager = get_job_manager()
    mine = total = 0
    for job_id in manager.job_ids():
        try:
            status = manager.state(job_id).get("status")
            owner = manager.spec(job_id).get("user")
        except KeyError:
            continue
        if status in ACTIVE:
            total += 1
            if user is not None and owner == user.name:
                mine += 1
    if mine + new_jobs > cfg.jobs.max_concurrent_per_user:
        return (f"You can have {cfg.jobs.max_concurrent_per_user} run(s) queued or running at once on this "
                f"server ({mine} now). Wait for one to finish, or cancel one.")
    if total + new_jobs > cfg.jobs.max_concurrent_total:
        return (f"This server takes {cfg.jobs.max_concurrent_total} run(s) at once ({total} now); "
                "try again when one finishes.")
    return None


def spec_refusal(spec: dict) -> Optional[str]:
    """Why a stored run may not start under the current lab policy (None: it may).

    For a retry and again when the scheduler launches it: runs recorded under an
    older configuration, or whose files have moved since, are replanned rather
    than started with stale cores, inputs or output folder."""
    cfg = _cfg()
    if cfg is None:
        return None
    from services.lab.paths import allowed, is_remote_url
    replan = " Start it again (Re-call, or a New DAF-seq run) so it is planned with the current settings."
    try:
        cores = int(spec.get("cores") or 1)
    except (TypeError, ValueError):
        cores = 1
    if cores > max_cores():
        return f"This run was set up for {cores} cores; this server now allows {max_cores()} per run." + replan
    outdir = spec.get("outdir")
    if outdir and not allowed(str(outdir), write=True):
        return "This run's output folder is not in a writable data root of this server." + replan
    reference = spec.get("reference")
    reference = reference.get("path") if isinstance(reference, dict) else reference
    inputs = [*(spec.get("reads") or []), *([reference] if isinstance(reference, str) and reference else [])]
    options = spec.get("options") if isinstance(spec.get("options"), dict) else {}
    if options.get("snp_mask"):
        inputs.append(options["snp_mask"])
    recall = spec.get("library_recall") if isinstance(spec.get("library_recall"), dict) else {}
    from services.pipeline_inputs import run_option_paths
    for path, exists in run_option_paths(recall.get("extra") or [], outdir):
        if not allowed(path, write=not exists):
            return f"A file this run's options name is outside the lab's data folders ({os.path.basename(path)})." \
                + replan
    for path in inputs:
        if isinstance(path, str) and path and not is_remote_url(path) and not allowed(path):
            return f"An input of this run is outside the lab's data folders ({os.path.basename(path)})." + replan
    from services.pipeline_inputs import raw_folder_escape
    for path in spec.get("reads") or []:
        # A raw POD5 folder: dorado reads what is inside it, so a link put there since it was checked counts.
        if isinstance(path, str) and os.path.isdir(path):
            escape = raw_folder_escape(path, allowed)
            if escape:
                return f"{os.path.basename(path)} holds a link outside the lab's data folders " \
                       f"({os.path.relpath(escape, path)})." + replan
    return None


def owner() -> Optional[str]:
    from services.runtime import current_lab_user
    user = current_lab_user()
    return user.name if user is not None else None


def may_manage(spec: dict) -> bool:
    """The member who started a run, or an admin (always true off the lab profile)."""
    if _cfg() is None:
        return True
    from services.runtime import current_lab_user
    user = current_lab_user()
    return user is not None and (user.is_admin or spec.get("user") == user.name)
