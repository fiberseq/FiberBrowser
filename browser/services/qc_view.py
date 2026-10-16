"""fiberhmm-qc results for the QC panel: verdicts, metrics and the curves behind the plots.

``fiberhmm-qc`` writes ``<prefix>.qc.json`` (PASS/WARN/FAIL verdicts and
metrics), ``<prefix>.qc.curves.json`` (schema ``fiberhmm.qc.curves.v1``: the
per-read deamination/methylation-rate ECDF with the bundled reference ECDF,
the phasogram with its reference, footprint-size histograms) and a PNG/PDF
figure. The panel draws the curves natively; the figure is offered as a
download. A pipeline run has these files already; any other FiberHMM-called
BAM gets them by running ``fiberhmm-qc`` once into a cache folder.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
from typing import Optional

QC_COMMAND_ENV = "FIBERBROWSER_QC_COMMAND"
QC_CACHE_ENV = "FIBERBROWSER_QC_CACHE_DIR"
CURVES_SCHEMA = "fiberhmm.qc.curves.v1"
PLOT_SUFFIXES = (".png", ".pdf", ".html", ".svg")


def _inside(path: Optional[str], roots: Optional[list]) -> bool:
    """``path`` resolves inside one of ``roots``; always true when ``roots`` is None."""
    if roots is None:
        return True
    if not isinstance(path, str) or not path:
        return False
    real = os.path.realpath(path)
    return any(real == r or real.startswith(r.rstrip(os.sep) + os.sep)
                                 for r in (os.path.realpath(x) for x in roots if x))


def _read_json(path: Optional[str], roots: Optional[list] = None) -> Optional[dict]:
    """A JSON object from ``path``; with ``roots`` only a regular file inside them,
    read from the descriptor services/lab/paths.open_confined checked."""
    if not path or not _inside(path, roots):
        return None
    try:
        if roots is not None:
            from services.lab.paths import open_confined
            opened = open_confined(path, roots, lab_roots=False)
            if opened is None:
                return None
            with opened[0] as handle:
                data = json.loads(handle.read().decode("utf-8"))
        else:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def curves_path_for(qc_json: str, qc: Optional[dict], hint: Optional[str] = None) -> Optional[str]:
    outputs = (qc or {}).get("outputs") or {}
    for candidate in (hint, outputs.get("curves")):
        if isinstance(candidate, str) and candidate and os.path.isfile(candidate):
            return candidate
    if qc_json.endswith(".qc.json"):
        sibling = qc_json[: -len(".qc.json")] + ".qc.curves.json"
        if os.path.isfile(sibling):
            return sibling
    return None


def plot_files(qc: Optional[dict], extra: Optional[dict] = None, roots: Optional[list] = None) -> dict[str, str]:
    """Named figure files that exist: {'plot': .png, 'pdf': .pdf, ...} (``roots``: only
    those resolving inside these folders)."""
    out: dict[str, str] = {}
    seen: set[str] = set()
    outputs = (qc or {}).get("outputs") or {}
    for key in ("plot", "pdf", "html"):
        path = outputs.get(key)
        if isinstance(path, str) and path.lower().endswith(PLOT_SUFFIXES) and os.path.isfile(path) \
                and _inside(path, roots):
            out[key] = path
            seen.add(os.path.realpath(path))
    for name, path in (extra or {}).items():
        if isinstance(path, str) and path.lower().endswith(PLOT_SUFFIXES) and os.path.isfile(path) \
                and _inside(path, roots) and os.path.realpath(path) not in seen:
            safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(name))[:60] or "plot"
            out.setdefault(safe, path)
            seen.add(os.path.realpath(path))
    return out


def qc_payload(qc_json: Optional[str], extra_plots: Optional[dict] = None,
               report: Optional[str] = None, curves_hint: Optional[str] = None,
               roots: Optional[list] = None) -> dict:
    """{'available', 'qc', 'curves', 'plots': {name: path}} for a QC JSON path
    (``roots``: every file read or listed must resolve inside these folders)."""
    qc = _read_json(qc_json, roots)
    if qc is None:
        return {"available": False, "qc": None, "curves": None, "plots": {}}
    curves = _read_json(curves_path_for(qc_json, qc, curves_hint), roots)
    if curves is not None and curves.get("schema") not in (None, CURVES_SCHEMA):
        curves = {**curves, "schema_warning": f"unknown curves schema {curves.get('schema')!r}"}
    extra = dict(extra_plots or {})
    if report and report.lower().endswith(PLOT_SUFFIXES):
        extra.setdefault("report", report)
    return {"available": True, "qc": qc, "curves": curves, "plots": plot_files(qc, extra, roots),
            "json_path": qc_json}


# --------------------------------------------------------------------------
# QC of any loaded dataset
# --------------------------------------------------------------------------

def qc_cache_dir() -> str:
    configured = os.environ.get(QC_CACHE_ENV)
    path = configured or os.path.join(os.path.expanduser("~"), ".fiberhmm", "qc_cache")
    return os.path.abspath(os.path.expanduser(path))


def qc_command() -> dict:
    override = os.environ.get(QC_COMMAND_ENV, "").strip()
    if override:
        return {"argv": shlex.split(override), "env": {}}
    from services.pipeline_inputs import _fiberhmm_source_root, _module_available
    if _module_available("fiberhmm.cli.qc"):
        env = {}
        root = _fiberhmm_source_root()
        if root:
            env["PYTHONPATH"] = root + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")
        return {"argv": [sys.executable, "-m", "fiberhmm.cli.qc"], "env": env}
    found = shutil.which("fiberhmm-qc")
    if found:
        return {"argv": [found], "env": {}}
    return {"argv": None, "env": {},
            "hint": "fiberhmm-qc (FiberHMM 3) is not installed in FiberBrowser's Python."}


def cache_key(bam_path: str, enzyme: str = "auto", reference_fasta: Optional[str] = None) -> str:
    """The QC of one file version: its real path, size and modification time, the
    chemistry asked for and the reference FASTA given (its path, size and modification
    time). A changed BAM or reference is a new key."""
    real = os.path.realpath(bam_path)
    stat = os.stat(real)
    raw = f"{real}\0{stat.st_size}\0{stat.st_mtime_ns}\0{enzyme}"
    if reference_fasta:
        ref = os.path.realpath(reference_fasta)
        ref_stat = os.stat(ref)
        raw += f"\0ref:{ref}\0{ref_stat.st_size}\0{ref_stat.st_mtime_ns}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


#: Written into a cache folder after fiberhmm-qc finished there; without it the folder
#: is a run in progress (in this or another server process), or one that failed.
DONE_MARKER = ".fiberbrowser-qc-done"

_RUN_LOCKS: dict[str, threading.Lock] = {}
_RUN_LOCKS_GUARD = threading.Lock()


def _run_lock(key: str) -> threading.Lock:
    """One fiberhmm-qc at a time per cache key (the Library and "QC a dataset" may ask together)."""
    with _RUN_LOCKS_GUARD:
        return _RUN_LOCKS.setdefault(key, threading.Lock())


@contextlib.contextmanager
def _folder_lock(out_dir: str):
    """The cache folder's lock across server processes (POSIX ``flock``), inside the thread lock."""
    os.makedirs(out_dir, exist_ok=True)
    try:
        import fcntl
    except ImportError:  # pragma: no cover - Windows: the thread lock only
        yield
        return
    with open(os.path.join(out_dir, ".lock"), "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def qc_complete(qc_json: Optional[str]) -> bool:
    """``qc_json`` exists and the run that wrote it finished."""
    return bool(qc_json) and os.path.isfile(qc_json) and \
        os.path.isfile(os.path.join(os.path.dirname(qc_json), DONE_MARKER))


def _stem(path: str) -> str:
    name = os.path.basename(path)
    for suffix in (".bam", ".cram"):
        if name.lower().endswith(suffix):
            return name[: -len(suffix)]
    return name


def run_dataset_qc(bam_path: str, *, enzyme: str = "auto", reference_fasta: Optional[str] = None,
                   timeout: float = 900.0) -> dict:
    """Run fiberhmm-qc on a BAM once (cached per file version) and return the QC payload."""
    if not os.path.isfile(bam_path):
        raise FileNotFoundError(bam_path)
    if enzyme not in ("auto", "hia5", "ddda", "dddb"):
        raise ValueError(f"unknown enzyme {enzyme!r}")
    reference = reference_fasta if reference_fasta and os.path.isfile(reference_fasta) else None
    key = cache_key(bam_path, enzyme, reference)
    out_dir = os.path.join(qc_cache_dir(), key)
    qc_json = os.path.join(out_dir, _stem(bam_path) + ".qc.json")
    with _run_lock(key), _folder_lock(out_dir):
        if not qc_complete(qc_json):
            _run_into(bam_path, out_dir, qc_json, enzyme, reference, timeout)
    payload = qc_payload(qc_json)
    payload["cache_key"] = key
    return payload


def _clear_outputs(out_dir: str) -> None:
    """A run's earlier or partial outputs (never a cached result); the lock file stays."""
    for name in os.listdir(out_dir):
        path = os.path.join(out_dir, name)
        if name != ".lock" and os.path.isfile(path) and not os.path.islink(path):
            os.remove(path)


def _run_into(bam_path: str, out_dir: str, qc_json: str, enzyme: str, reference: Optional[str],
              timeout: float) -> None:
    command = qc_command()
    if not command.get("argv"):
        raise RuntimeError(command.get("hint") or "fiberhmm-qc is not available")
    _clear_outputs(out_dir)
    argv = [*command["argv"], "-i", bam_path, "-o", out_dir]
    if enzyme != "auto":
        argv += ["--enzyme", enzyme]
        if enzyme in ("ddda", "dddb"):
            argv += ["--mode", "daf"]
    if reference:
        argv += ["--reference", reference]
    env = dict(os.environ)
    env.update(command.get("env") or {})
    env.setdefault("FIBERHMM_NO_UPDATE_CHECK", "1")
    env.setdefault("MPLBACKEND", "Agg")
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env,
                              stdin=subprocess.DEVNULL)
        with open(os.path.join(out_dir, "fiberhmm-qc.log"), "w", encoding="utf-8") as handle:
            handle.write((proc.stdout or "") + (proc.stderr or ""))
        if proc.returncode != 0 or not os.path.isfile(qc_json):
            tail = ((proc.stderr or "") + (proc.stdout or "")).strip().splitlines()[-6:]
            raise RuntimeError("fiberhmm-qc failed" + (": " + " / ".join(tail) if tail else ""))
    except BaseException:
        # A failed or timed-out run's partial output is never a cached result.
        with contextlib.suppress(OSError):
            if os.path.isfile(qc_json):
                os.remove(qc_json)
        raise
    with open(os.path.join(out_dir, DONE_MARKER), "w", encoding="utf-8") as handle:
        handle.write("ok\n")
