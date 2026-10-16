"""Payloads for the Library routes (routers/library.py)."""
from __future__ import annotations

import os
import subprocess
import sys
from typing import Any, Optional

from services import library_inspect as inspect
from services import library_store as store


def _entry_view(entry: dict, map_md5s: dict[str, str], map_paths: dict[str, str]) -> dict:
    view = dict(entry)
    view.pop("canonical_path", None)
    path = entry.get("path") or ""
    identity = inspect.stat_identity(path) if path else None
    view["available"] = identity is not None
    view["changed"] = bool(identity) and not inspect.same_stat(entry.get("identity"), identity)
    if inspect.is_cluster_ref(path):
        # On a cluster: listed as available (Open asks to connect first) and
        # never "changed" just because the host is not connected right now.
        view["remote"] = True
        view["connected"] = identity is not None
        view["available"] = True
        view["changed"] = bool(identity) and bool((entry.get("identity") or {}).get("size")) \
            and identity["size"] != entry["identity"]["size"]
    if identity is not None:
        view["cloud_only"] = identity["cloud_only"]
    if view.pop("qc_run", None) is not None:  # QC run from the Library: shown while the file is unchanged
        from services import library_qc
        run = library_qc.current_qc_run(entry, identity)
        if run is not None:
            view["qc"] = library_qc.qc_summary(run)
    view["label"] = entry.get("label_override") or entry.get("label") or os.path.basename(path)
    view["rerun"] = inspect.needs_rerun(entry.get("advisories"))
    reference = entry.get("reference") or {}
    if entry.get("kind") == "bam":
        linked = []
        for contig in reference.get("contigs") or []:
            map_id = map_md5s.get(str(contig.get("md5") or "").lower())
            if map_id and map_id not in linked:
                linked.append(map_id)
        for declared in reference.get("plasmid_maps") or []:
            map_id = map_paths.get(store.canonical_path(declared["path"])) if declared.get("path") else None
            if map_id and map_id not in linked:
                linked.append(map_id)
        pipeline_map = (entry.get("pipeline") or {}).get("plasmid_map")
        map_id = map_paths.get(store.canonical_path(pipeline_map)) if pipeline_map else None
        if map_id and map_id not in linked:
            linked.append(map_id)
        view["linked_maps"] = linked
    return view


def _slim(view: dict) -> dict:
    """The list row: what the table, filters and Open need (details come from get_entry_view)."""
    view = dict(view)
    reference = dict(view.get("reference") or {})
    if reference.get("contigs"):
        reference["contigs"] = [c for c in reference["contigs"] if c.get("circular")][:20]
    view["reference"] = reference
    if isinstance(view.get("pipeline"), dict):
        view["pipeline"] = {k: v for k, v in view["pipeline"].items() if k != "settings"}
    if isinstance(view.get("fiberhmm"), dict):
        view["fiberhmm"] = {k: v for k, v in view["fiberhmm"].items() if k != "programs"}
    for key in ("previous_paths", "sidecars", "sidecar_roots"):
        view.pop(key, None)
    return view


def _map_lookups(data: dict) -> tuple[dict[str, str], dict[str, str]]:
    map_md5s: dict[str, str] = {}
    map_paths: dict[str, str] = {}
    for entry_id, entry in data["entries"].items():
        if entry.get("kind") == "plasmid_map":
            for contig in (entry.get("reference") or {}).get("contigs") or []:
                if contig.get("md5"):
                    map_md5s.setdefault(str(contig["md5"]).lower(), entry_id)
            if entry.get("canonical_path"):
                map_paths[entry["canonical_path"]] = entry_id
    return map_md5s, map_paths


def get_entry_view(entry_id: str) -> dict:
    """One entry in full (all contigs, programs, settings) for the details pane."""
    data = store.load()
    entry = data["entries"].get(entry_id)
    if entry is None:
        raise KeyError(entry_id)
    return _entry_view(entry, *_map_lookups(data))


def _downloaded_genomes(genomes: set) -> list[str]:
    """Catalog genomes of these entries whose FASTA is on this computer (Open loads
    those; it never starts a multi-GB download by itself)."""
    out = []
    try:
        from services.pipeline_inputs import catalog_genome_fasta
    except Exception:  # pragma: no cover
        return out
    for genome in sorted(g for g in genomes if g):
        try:
            local, _error = catalog_genome_fasta(genome, verify=False)
        except Exception:
            local = None
        if local:
            out.append(genome)
    return out


def library_payload() -> dict:
    from services import library_jobs, library_scan

    data = store.load()
    if data.get("_unreadable"):
        # Show the recovery message; importing finished runs would have to write the
        # damaged file (the store refuses). They are imported once it is recovered.
        jobs = {"imported": 0, "available": True, "skipped": "library unreadable"}
    else:
        jobs = library_jobs.import_finished_jobs()
        if jobs.get("imported"):
            data = store.load()
    map_md5s, map_paths = _map_lookups(data)
    entries = [_slim(_entry_view(e, map_md5s, map_paths)) for e in data["entries"].values()]
    entries.sort(key=lambda e: (-(e.get("last_opened") or 0), -(e.get("added") or 0)))
    return {
        "schema": store.SCHEMA,
        "library_file": str(store.library_file()),
        "unreadable": bool(data.get("_unreadable")),
        "entries": entries,
        "groups": list(data["groups"].values()),
        "watched": list(data["watched"].values()),
        "scan": library_scan.status(),
        "jobs": jobs,
        "genomes_downloaded": _downloaded_genomes({(e.get("reference") or {}).get("genome") for e in entries}),
        "fiberhmm_version": inspect.current_fiberhmm_version(),
        "advisories_available": inspect._advisories_module() is not None,
        "platform": sys.platform,
    }


def get_entry(entry_id: str) -> dict:
    entry = store.load()["entries"].get(entry_id)
    if entry is None:
        raise KeyError(entry_id)
    return entry


def watched_root(entry: dict) -> Optional[str]:
    """The watched folder an entry was found in (its files beside it are read from there only)."""
    watched = store.load()["watched"]
    path = store.canonical_path(entry.get("path") or "")
    for source in entry.get("sources") or []:
        if str(source).startswith("watched:"):
            folder = (watched.get(str(source)[len("watched:"):]) or {}).get("path")
            if folder and inspect.inside(path, os.path.realpath(folder)):
                return folder
    return None


def _inspect(path: str, kind: Optional[str], root: Optional[str] = None) -> dict:
    """``inspect_file`` that never raises (an unexpected failure is the entry's error)."""
    try:
        return inspect.inspect_file(path, kind, root=root)
    except Exception as exc:
        return {"kind": kind or inspect.file_kind(path) or "track", "path": path, "folder": os.path.dirname(path),
                "label": os.path.basename(path), "error": f"{type(exc).__name__}: {exc}"}


def rescan_entry(entry_id: str) -> dict:
    entry = get_entry(entry_id)
    info = _inspect(entry["path"], entry.get("kind"), watched_root(entry))
    if info.get("error") == "file not found":
        return {"success": False, "error": "The file is not at its saved location. Use Locate… to find it."}
    if entry.get("job"):
        info["job"] = entry["job"]
    store.record(info, None)
    return {"success": True, "entry": get_entry(entry_id)}


def add_files(paths: list[str]) -> dict:
    from services.supported_files import not_openable_message, partition_sidecars
    # A BAM's index chosen with it is not an entry of its own (nor a mistake).
    paths, _indexes, errors = partition_sidecars(list(paths))
    added = []
    for path in paths:
        kind = inspect.file_kind(path)
        if kind is None:
            reason = not_openable_message(path)
            errors.append(f"{reason.rstrip('.')} (the Library lists BAM, BigBed and plasmid map files).")
            continue
        info = _inspect(path, kind)
        if info.get("error") == "file not found":
            errors.append(f"{path}: not found")
            continue
        added.append(store.record(info, "added")["id"])
    return {"success": bool(added) or not errors, "ids": added, "errors": errors}


def locate_entry(entry_id: str, new_path: str, *, confirm: bool = False) -> dict:
    """Point a moved entry at its new location, if the file there is the same data.

    The same data means the recorded content digest matches. An entry recorded
    without one (by an older FiberBrowser, or while its file was online-only)
    can't be verified: header and size are only plausibility checks, so it is
    relocated only when the user confirms (``confirm``); the answer then says
    ``needs_confirmation`` and why."""
    entry = get_entry(entry_id)
    kind = entry.get("kind")
    if inspect.file_kind(new_path) not in (kind, None) and kind in ("bam", "bigbed", "plasmid_map"):
        return {"success": False, "error": f"{os.path.basename(new_path)} is not a {kind.replace('_', ' ')} file."}
    info = inspect.inspect_file(new_path, kind)
    if info.get("error"):
        return {"success": False, "error": info["error"]}
    if info.get("cloud_only"):
        return {"success": False, "error": f"{os.path.basename(new_path)} is online-only: make it available "
                                           "offline (so it can be compared with the recorded file), then Locate it again."}
    old = entry.get("identity") or {}
    new = info.get("identity") or {}
    same, why = inspect.same_data(old, new)
    if same and not old.get("header_sha256") and not old.get("content_sha256"):
        # Recorded while online-only: only its size is known, which alone identifies nothing.
        same = bool(old.get("size")) and os.path.basename(new_path) == os.path.basename(entry.get("path") or "")
        why = "the Library never read the recorded file (it was online-only), and the name or size differs"
    if not same:
        return {"success": False, "error": f"That file is different data ({why}); "
                                           "add it to the Library as a new entry instead."}
    if not old.get("content_sha256") and not confirm:
        checked = "its header and size match" if old.get("header_sha256") else "its name and size match"
        return {"success": False, "needs_confirmation": True,
                "error": (f"The Library can't verify that {os.path.basename(new_path)} is the recorded file: the "
                          "entry has no content fingerprint (it was recorded by an older FiberBrowser or while "
                          f"the file was online-only). Only {checked}. Relocate it anyway only if you know it is "
                          "the same file; its tags, notes and experiments move with it.")}
    other = None

    def change(data: dict) -> Optional[str]:
        nonlocal other
        other = store.find_by_path(data, new_path, kind)
        target = data["entries"].get(entry_id)
        if target is None:
            raise KeyError(entry_id)
        target["previous_paths"] = (list(target.get("previous_paths") or []) + [target.get("path")])[-5:]
        if other and other != entry_id:
            # The new location is already listed: keep this entry (tags, notes, groups) and drop the duplicate.
            data["entries"].pop(other, None)
            for group in data["groups"].values():
                ids = [entry_id if e == other else e for e in group.get("entry_ids") or []]
                group["entry_ids"] = list(dict.fromkeys(ids))
        target["path"] = info["path"]
        data["entries"][entry_id] = store._merge(target, info, "located")
        return entry_id

    store.update(change)
    return {"success": True, "entry": get_entry(entry_id), "merged_duplicate": other}


def reveal_command(path: str, platform: str = sys.platform) -> list[str]:
    if platform == "darwin":
        return ["open", "-R", path]
    if platform.startswith("win"):
        return ["explorer", f"/select,{path}"]
    return ["xdg-open", os.path.dirname(path) or "."]


def reveal_entry(entry_id: str) -> dict:
    entry = get_entry(entry_id)
    path = entry.get("path") or ""
    target = path if os.path.exists(path) else os.path.dirname(path)
    if not target or not os.path.exists(target):
        return {"success": False, "error": "Neither the file nor its folder exists any more."}
    from services import wsl_interop
    # In WSL (the Windows app): Windows Explorer, with the file selected.
    argv = (wsl_interop.reveal_argv(target) if wsl_interop.is_wsl() else None) or reveal_command(target)
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, start_new_session=True,
                         cwd=wsl_interop.windows_cwd() if wsl_interop.is_wsl() else None)
    except OSError as exc:
        return {"success": False, "error": f"Could not open the file manager ({argv[0]}): {exc}"}
    return {"success": True, "path": target}


def entry_sidecars(entry: dict) -> "inspect.Sidecars":
    """The folders an entry's QC files may be read from: those its inspection approved
    (the watched folder, or the file's own and its run folder)."""
    roots = entry.get("sidecar_roots")
    if isinstance(roots, list) and roots:
        return inspect.Sidecars([str(r) for r in roots], fixed=True)
    # Recorded before the approved folders were stored.
    return inspect.default_sidecars(entry.get("path") or "", watched_root(entry))


def entry_qc_files(entry: dict, sidecars: Optional["inspect.Sidecars"] = None,
                   qc_data: Optional[dict] = None) -> tuple[Optional[str], dict]:
    """(QC JSON, {name: figure path}) of an entry: only files inside its approved folders."""
    from services.qc_view import plot_files
    sidecars = sidecars or entry_sidecars(entry)
    qc = entry.get("qc") or {}
    json_path = qc.get("json")
    data = qc_data if qc_data is not None else (sidecars.read_json(json_path) if json_path else None)
    if data is None:
        return None, {}
    extra = {"report": qc["report"]} if qc.get("report") else {}
    files = {name: path for name, path in plot_files(data, extra).items() if sidecars.usable(path)}
    return json_path, files


def _entry_curves(qc: dict, json_path: str, data: dict, sidecars: "inspect.Sidecars") -> Optional[dict]:
    from services.qc_view import CURVES_SCHEMA
    outputs = data.get("outputs") if isinstance(data.get("outputs"), dict) else {}
    candidates = [qc.get("curves"), outputs.get("curves")]
    if json_path.endswith(".qc.json"):
        candidates.append(json_path[: -len(".qc.json")] + ".qc.curves.json")
    for candidate in candidates:
        if isinstance(candidate, str) and candidate and sidecars.usable(candidate):
            curves = sidecars.read_json(candidate)
            if curves is not None and curves.get("schema") not in (None, CURVES_SCHEMA):
                curves = {**curves, "schema_warning": f"unknown curves schema {curves.get('schema')!r}"}
            return curves
    return None


def entry_qc_payload(entry_id: str) -> dict:
    """The QC panel of an entry (the same shape as ``qc_view.qc_payload``), read only from
    inside its approved folders and never from a cloud-only placeholder."""
    entry = get_entry(entry_id)
    if entry.get("qc_run"):
        from services import library_qc
        run = library_qc.current_qc_run(entry, inspect.stat_identity(entry.get("path") or ""))
        if run is not None:
            return library_qc.qc_run_payload(entry, run)
    qc = entry.get("qc") or {}
    json_path = qc.get("json")
    sidecars = entry_sidecars(entry)
    data = sidecars.read_json(json_path) if json_path else None
    if data is None:
        return {"available": False, "qc": None, "curves": None, "plots": {},
                "verdicts": qc.get("verdicts") or {},
                "online_only": bool(json_path) and json_path in sidecars.online_only}
    _json, files = entry_qc_files(entry, sidecars, data)
    return {"available": True, "qc": data, "curves": _entry_curves(qc, json_path, data, sidecars),
            "plots": {name: f"/api/library/entries/{entry_id}/qc/files/{name}" for name in files},
            "label": entry.get("label_override") or entry.get("sample")}


def entry_qc_file(entry_id: str, name: str) -> Optional[str]:
    _json, files = entry_qc_files(get_entry(entry_id))
    return files.get(name)


def open_entry_qc_file(entry_id: str, name: str):
    """(binary file, file name, size) of a QC figure the entry lists, or None.

    Opened by services/lab/paths.open_confined inside the entry's approved folders
    (a descriptor walk that follows no symlink and never waits on a FIFO), so what
    is served is the regular file that was checked.
    """
    from services.lab.paths import open_confined
    entry = get_entry(entry_id)
    if entry.get("qc_run"):  # QC run from the Library: its figures, from FiberBrowser's QC cache
        from services import library_qc
        run = library_qc.current_qc_run(entry, inspect.stat_identity(entry.get("path") or ""))
        if run is not None:
            return library_qc.open_run_file(run, name)
    path = entry_qc_file(entry_id, name)
    if not path:
        return None
    opened = open_confined(path, entry_sidecars(entry).roots)
    if opened is None:
        return None
    handle, real, size = opened
    return handle, os.path.basename(real), size


def recall_entry(entry_id: str, body: dict[str, Any]) -> dict:
    from services import library_jobs
    entry = get_entry(entry_id)
    choices = {"outdir": body.get("outdir"), "cores": body.get("cores")}
    if body.get("input"):
        choices["input_path"] = str(body["input"])
    if body.get("keep_old"):
        choices["keep_old"] = [str(k) for k in body["keep_old"]]
    try:
        if body.get("dry_run"):
            plan = library_jobs.plan_recall(entry, **choices)
            plan.pop("command", None)  # argv and environment stay on the server
            plan["entry_id"] = entry_id
            return {"success": True, "plan": plan}
        if not body.get("plan_id"):
            return {"success": False, "error": "Review the re-call plan first (it lists the settings it keeps)."}
        job = library_jobs.submit_recall(entry, plan_id=str(body["plan_id"]), **choices)
    except library_jobs.RecallError as exc:
        out: dict[str, Any] = {"success": False, "error": str(exc)}
        if exc.needs_input:
            out["needs_input"] = exc.needs_input
        if exc.start_new_run:
            out["start_new_run"] = True
        return out
    except ValueError as exc:
        return {"success": False, "error": str(exc)}
    except ImportError as exc:  # pragma: no cover - the job runner is part of FiberBrowser 3
        return {"success": False, "error": f"Runs are not available in this FiberBrowser ({exc})."}
    return {"success": True, "job": job}
