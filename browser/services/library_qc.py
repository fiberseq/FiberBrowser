"""Run fiberhmm-qc on a Library entry (no need to open it first) and remember the result.

The run is ``qc_view.run_dataset_qc`` (the same command and cache as "QC a dataset"):
its files go to FiberBrowser's own QC cache (``~/.fiberhmm/qc_cache/<key>``),
never beside the user's BAM. The entry keeps a pointer to that result
(``entry["qc_run"]``: cache key, file name, verdicts and the size and modification
time of the file it was computed for). It is shown as the entry's QC only while
the file still has that size and modification time, so a changed file is never
shown with an earlier file's verdict. A rescan never drops it (``_merge`` keeps
fields an inspection does not produce, except the ones it lists).
"""
from __future__ import annotations

import os
import re
import time
from typing import Optional

from services import library_inspect as inspect
from services import library_store as store

QC_RUN = "qc_run"
FASTA_SUFFIXES = (".fa", ".fasta", ".fna", ".fa.gz", ".fasta.gz", ".fna.gz")
NO_REFERENCE_NOTE = ("Ran without a reference FASTA (none found for this file). fiberhmm-qc only needs one "
                     "for raw DAF BAMs whose reads lack MD tags; FiberHMM-called BAMs are checked in full.")
_KEY_RE = re.compile(r"[0-9a-f]{16}")


def entry_enzyme(entry: dict) -> str:
    """The chemistry fiberhmm-qc is told: the run's enzyme, else the header's; else automatic."""
    for value in ((entry.get("pipeline") or {}).get("enzyme"), (entry.get("job") or {}).get("enzyme")):
        if isinstance(value, str) and value.lower() in ("ddda", "dddb", "hia5"):
            return value.lower()
    chemistry = entry.get("chemistry") or {}
    key = str(chemistry.get("key") or "").lower()
    if key in ("ddda", "dddb"):
        return key
    if key.startswith("hia5"):
        return "hia5"
    enzyme = str(chemistry.get("enzyme") or "").lower()
    return enzyme if key not in ("conflict",) and enzyme in ("ddda", "dddb", "hia5") else "auto"


def _is_fasta(path) -> bool:
    return isinstance(path, str) and path.lower().endswith(FASTA_SUFFIXES) and os.path.isfile(path)


def entry_reference(entry: dict) -> Optional[str]:
    """The entry's reference FASTA on this computer (``library_jobs._reference_for``, skipping
    a plasmid map, which fiberhmm-qc can't read), or None. Never downloads a genome."""
    try:
        from services.library_jobs import _reference_for
        found = _reference_for(entry)
    except Exception:
        found = None
    if _is_fasta(found):
        return found
    pipeline, job = entry.get("pipeline") or {}, entry.get("job") or {}
    for candidate in (pipeline.get("reference_fasta"), (job.get("reference") or {}).get("path")):
        if _is_fasta(candidate):
            return candidate
    genome = (entry.get("reference") or {}).get("genome")
    if genome:
        try:
            from services.pipeline_inputs import catalog_genome_fasta
            local, _error = catalog_genome_fasta(genome)
        except Exception:
            local = None
        if _is_fasta(local):
            return local
    return None


def refusal(entry: dict) -> Optional[str]:
    """Why QC can't run on this entry here (None: it can)."""
    path = entry.get("path") or ""
    name = os.path.basename(path) or "This entry"
    if entry.get("kind") != "bam":
        return f"{name} is not a BAM file: fiberhmm-qc checks FiberHMM BAMs."
    if inspect.is_cluster_ref(path) or "://" in path:
        return (f"{name} is on a cluster or in cloud storage: QC from the Library runs on files on this "
                "computer. Run fiberhmm-qc where the file is, or copy it here.")
    if inspect.stat_identity(path) is None or not os.path.isfile(path):
        return f"{name} is not at its saved location. Use Locate… to find it, then run QC."
    return None


def _confined_inputs(path: str, reference: Optional[str]) -> tuple[str, Optional[str]]:
    """(BAM, reference) as fiberhmm-qc gets them: resolved, and on a lab server checked inside
    the data folders (the BAM and the index htslib reads beside it: PathDenied otherwise;
    a reference that isn't allowed is left out). The child gets the resolved paths that
    were checked, as a lab run's inputs are (services/lab/jobs.py)."""
    from services.lab.paths import PathDenied, confine_alignment, confine_fasta
    real = os.path.realpath(path)
    confine_alignment(path, "rb", {})
    confine_alignment(real, "rb", {})
    if reference:
        reference = os.path.realpath(reference)
        try:
            confine_fasta(reference, {})
        except PathDenied:
            reference = None
    return real, reference


def run_entry_qc(entry_id: str, *, confirm: bool = False) -> dict:
    """Run fiberhmm-qc on an entry's BAM (cached per file version), remember it on the entry,
    and answer like ``/api/qc/dataset`` plus the entry id, chemistry and reference used."""
    from services.lab.paths import PathDenied
    from services.qc_view import run_dataset_qc
    entry = store.load()["entries"].get(entry_id)
    if entry is None:
        raise KeyError(entry_id)
    refused = refusal(entry)
    if refused:
        return {"success": False, "entry_id": entry_id, "error": refused}
    path = entry["path"]
    before = inspect.stat_identity(path)
    if before is None:
        return {"success": False, "entry_id": entry_id, "error": refusal(entry) or "The file is missing."}
    from services.cloud_placeholders import availability
    state = availability(path)
    if state == "empty":
        return {"success": False, "entry_id": entry_id,
                "error": f"{os.path.basename(path)} is empty (0 bytes): there are no reads to check."}
    if (before["cloud_only"] or state == "cloud") and not confirm:
        size = before["size"]
        how_big = f" ({size / 1e9:.1f} GB)" if size >= 1e8 else ""
        return {"success": False, "entry_id": entry_id, "needs_confirmation": True, "online_only": True,
                "error": (f"{os.path.basename(path)} is online-only (a cloud placeholder){how_big}. Running QC "
                          "downloads the whole file to this computer first. Run QC anyway?")}
    enzyme = entry_enzyme(entry)
    real, reference = _confined_inputs(path, entry_reference(entry))
    try:
        payload = run_dataset_qc(real, enzyme=enzyme, reference_fasta=reference)
    except PathDenied:
        raise
    except (RuntimeError, ValueError, FileNotFoundError, OSError) as exc:
        return {"success": False, "entry_id": entry_id, "error": str(exc) or type(exc).__name__}
    except Exception as exc:  # subprocess timeout and the like
        return {"success": False, "entry_id": entry_id, "error": f"{type(exc).__name__}: {exc}"}
    after = inspect.stat_identity(path)
    if after is None or after["size"] != before["size"] or \
            (not before["cloud_only"] and after["mtime_ns"] != before["mtime_ns"]):
        return {"success": False, "entry_id": entry_id,
                "error": f"{os.path.basename(path)} changed while QC ran; run QC again."}
    key = payload.get("cache_key")
    json_path = payload.get("json_path")
    if payload.get("available") and key and json_path:
        record = {"cache_key": key, "json_name": os.path.basename(json_path), "enzyme": enzyme,
                  "reference": reference, "identity": {"size": after["size"], "mtime_ns": after["mtime_ns"]},
                  "verdicts": inspect.qc_verdicts(payload.get("qc")), "numbers": inspect.qc_numbers(payload.get("qc")),
                  "ran": time.time()}

        def change(data: dict) -> bool:
            target = data["entries"].get(entry_id)
            if target is None or target.get("path") != path:
                return False  # removed or relocated meanwhile: the result is not this entry's any more
            target[QC_RUN] = record
            return True

        try:
            payload["remembered"] = bool(store.update(change))
        except RuntimeError:  # an unreadable Library is left as it is
            payload["remembered"] = False
    # A remembered result's figures come from the entry (like its other QC files).
    base = f"/api/library/entries/{entry_id}/qc/files" if payload.get("remembered") else f"/api/qc/files/{key}"
    payload["plots"] = {name: f"{base}/{name}" for name in payload.get("plots") or {}}
    payload.pop("json_path", None)
    return {"success": True, "entry_id": entry_id, "label": entry.get("label_override") or entry.get("label"),
            **payload, "enzyme": enzyme, "reference": reference,
            "reference_note": None if reference else NO_REFERENCE_NOTE}


def _run_json(run: dict) -> Optional[str]:
    from services.qc_view import qc_cache_dir
    key, name = str(run.get("cache_key") or ""), str(run.get("json_name") or "")
    if not _KEY_RE.fullmatch(key) or not name.endswith(".qc.json") or os.sep in name or name.startswith("."):
        return None
    return os.path.join(qc_cache_dir(), key, name)


def current_qc_run(entry: dict, identity: Optional[dict]) -> Optional[dict]:
    """The entry's remembered QC run, only if it was computed for the file as it is now
    (same size and modification time) and its result is still in the cache."""
    run = entry.get(QC_RUN)
    if not isinstance(run, dict) or not identity:
        return None
    saved = run.get("identity") or {}
    if saved.get("size") != identity.get("size") or saved.get("mtime_ns") != identity.get("mtime_ns"):
        return None
    from services.qc_view import qc_complete
    return run if qc_complete(_run_json(run)) else None


def qc_summary(run: dict) -> dict:
    """The run as the entry's ``qc`` (what the table's QC column and filter read)."""
    return {"verdicts": dict(run.get("verdicts") or {}), "numbers": dict(run.get("numbers") or {}),
            "json": _run_json(run), "curves": None, "report": None, "source": "fiberhmm-qc (run from the Library)",
            "ran": run.get("ran"), "enzyme": run.get("enzyme"), "reference": run.get("reference")}


def qc_run_payload(entry: dict, run: dict) -> dict:
    """The QC panel for a remembered run (read only from its cache folder)."""
    from services.qc_view import qc_payload
    json_path = _run_json(run)
    payload = qc_payload(json_path, roots=[os.path.dirname(json_path)])
    entry_id = entry.get("id")
    payload["plots"] = {name: f"/api/library/entries/{entry_id}/qc/files/{name}" for name in payload.get("plots") or {}}
    payload.pop("json_path", None)
    return {**payload, "label": entry.get("label_override") or entry.get("sample"), "source": "library-run",
            "enzyme": run.get("enzyme"), "reference": run.get("reference"), "ran": run.get("ran"),
            "reference_note": None if run.get("reference") else NO_REFERENCE_NOTE}


def open_run_file(run: dict, name: str):
    """(binary file, file name, size) of a figure the remembered run lists, opened by
    descriptor inside its cache folder (services/lab/paths.open_confined), or None."""
    from services.lab.paths import open_confined
    from services.qc_view import _read_json, plot_files
    json_path = _run_json(run)
    if not json_path:
        return None
    folder = os.path.dirname(json_path)
    path = plot_files(_read_json(json_path, roots=[folder]), roots=[folder]).get(name)
    opened = open_confined(path, [folder], lab_roots=False) if path else None
    if opened is None:
        return None
    handle, real, size = opened
    return handle, os.path.basename(real), size
