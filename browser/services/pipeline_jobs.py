"""Background ``fiberhmm-pipeline`` jobs: an on-disk registry and a small queue.

Each job (one sample of a "New DAF-seq run") lives in
``~/.fiberhmm/jobs/<id>/`` (``FIBERBROWSER_JOBS_DIR`` overrides)::

    spec.json       what to run: the argv list, the sample, the output folder
    state.json      queued / running / done / error / cancelled / interrupted
    progress.jsonl  the pipeline's JSON-lines progress (--progress-json)
    log             the pipeline's stdout and stderr
    pid             the running process id
    summary.json    reads aligned / called, duplicates, footprints per read

The pipeline runs as a detached process (its own session, argv list, never a
shell), so it keeps running when the tab closes or FiberBrowser restarts; a
restarted server finds it again through ``pid`` and the progress file. At
most ``FIBERBROWSER_PIPELINE_CORES`` cores (default: all) are used by running
jobs; the rest wait in the queue. On macOS ``caffeinate -i -w <pid>`` keeps
the Mac awake while a job runs.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Callable, Optional

JOBS_DIR_ENV = "FIBERBROWSER_JOBS_DIR"
CORES_ENV = "FIBERBROWSER_PIPELINE_CORES"
NO_CAFFEINATE_ENV = "FIBERBROWSER_NO_CAFFEINATE"
OUTPUTS_SCHEMA = "fiberhmm.pipeline.outputs.v1"
ACTIVE = ("queued", "running", "cancelling")


class JobRefused(RuntimeError):
    """A submission or retry refused by the server's run limits (lab servers)."""
FINISHED = ("done", "error", "cancelled", "interrupted")
CANCEL_GRACE_S = 30.0
_JOB_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$")

STEP_LABELS = {
    "basecall": "Basecalling (dorado)",
    "prepare_reference": "Preparing the reference",
    "reference": "Preparing the reference",
    "index": "Indexing the reference",
    "align": "Aligning reads (minimap2)",
    "call": "Calling footprints",
    "qc": "Quality control",
    "tracks": "Writing tracks",
    "browser": "Preparing FiberBrowser files",
}


def jobs_dir() -> str:
    configured = os.environ.get(JOBS_DIR_ENV)
    path = configured or os.path.join(os.path.expanduser("~"), ".fiberhmm", "jobs")
    return os.path.abspath(os.path.expanduser(path))


def valid_job_id(value: str) -> bool:
    return bool(_JOB_ID.match(str(value or "")))


def new_job_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)


def _now() -> float:
    return round(time.time(), 3)


def _write_json(path: str, payload: dict) -> None:
    tmp = f"{path}.tmp{os.getpid()}.{threading.get_ident()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, default=str)
        handle.write("\n")
    os.replace(tmp, path)


def _open_record(path: str, root: Optional[str] = None):
    """A run record (spec, state, log, progress, summary, the run's outputs) for reading.

    On a lab server, with ``root`` (the job's own folder or the run's output
    folder): only a regular file directly where the record says, opened by a
    descriptor walk from the folder above ``root`` that follows no symlink (so
    neither the record nor the job folder itself may be a link) and never waits
    on a FIFO (services/lab/paths.py). FileNotFoundError when it isn't there,
    PermissionError when something else is. Elsewhere a plain ``open`` as before."""
    from services.lab import get_config
    if root is not None and get_config() is not None:
        from services.lab.paths import open_confined
        parent = os.path.dirname(os.path.abspath(root))
        expected = os.path.join(os.path.realpath(parent), os.path.relpath(os.path.abspath(path), parent))
        opened = open_confined(path, [parent], lab_roots=False)
        if opened is None or opened[1] != expected:
            if opened is not None:
                opened[0].close()
            if not os.path.lexists(path):
                raise FileNotFoundError(path)
            raise PermissionError(f"{os.path.basename(path)}: not a regular file in its own folder")
        return opened[0]
    return open(path, "rb")


def _read_json(path: str, root: Optional[str] = None) -> Optional[dict]:
    try:
        with _open_record(path, root) as handle:
            data = json.loads(handle.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------
# Progress (contract v1, plus the pre-contract event names)
# --------------------------------------------------------------------------

def read_events(path: str, max_bytes: int = 4 << 20, root: Optional[str] = None) -> list[dict]:
    """Complete JSON lines of a progress file (a partial last line is skipped)."""
    try:
        with _open_record(path, root) as handle:
            size = os.fstat(handle.fileno()).st_size
            if size > max_bytes:
                handle.seek(size - max_bytes)
                handle.readline()
            data = handle.read()
    except OSError:
        return []
    events = []
    for line in data.decode("utf-8", errors="replace").split("\n")[:-1]:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


CALL_PROGRESS_SCHEMA = "fiberhmm.progress.v1"


def _call_event(event: dict) -> Optional[dict]:
    """fiberhmm-call's own --progress-json (schema fiberhmm.progress.v1; a Library re-call
    from a BAM header) as one "call" step. Its ``done`` ends the calling only (QC may
    follow), so it is never the job's done: the exit status decides that."""
    name = event.get("event")
    base = {"event": "step", "step": "call", "time": event.get("time")}
    if name == "start":
        return {**base, "status": "running", "done": event.get("regions_done"), "total": event.get("regions_total"),
                "unit": "regions" if event.get("regions_total") else None}
    if name == "region":
        return {**base, "status": "running", "done": event.get("regions_done"), "total": event.get("regions_total"),
                "unit": "regions", "rate": event.get("reads_per_s"), "eta_s": event.get("eta_s")}
    if name == "merge":
        return {**base, "status": "running", "message": "merging the regions"}
    if name == "done":
        return {**base, "status": "done"}
    if name == "stopped":
        return {"event": "log", "level": "warning", "time": event.get("time"),
                "message": f"fiberhmm-call stopped ({event.get('reason') or 'unknown reason'})"}
    return None


def _normalize_event(event: dict) -> Optional[dict]:
    """Map pre-contract names (pipeline_start, step_start, ...) onto contract v1."""
    if event.get("schema") == CALL_PROGRESS_SCHEMA:
        return _call_event(event)
    name = event.get("event")
    if name in ("start", "step", "log", "done"):
        return event
    if name == "pipeline_start":
        return {**event, "event": "start"}
    if name == "step_start":
        return {**event, "event": "step", "status": "running"}
    if name == "step_progress":
        out = {**event, "event": "step", "status": "running"}
        fraction = event.get("fraction")
        if fraction is not None and out.get("total") is None:
            out["done"], out["total"], out["unit"] = round(float(fraction) * 1000), 1000, "permille"
        return out
    if name == "step_done":
        return {**event, "event": "step", "status": "done"}
    if name == "step_skipped":
        return {**event, "event": "step", "status": "skipped", "message": event.get("reason")}
    if name == "pipeline_done":
        return {**event, "event": "done", "status": "ok"}
    if name == "pipeline_failed":
        return {**event, "event": "done", "status": "error"}
    return None


def summarize_progress(events: list[dict]) -> dict:
    """The job's progress for the UI: steps with status, counts, rate and ETA."""
    steps: dict[str, dict] = {}
    order: list[str] = []
    started = None
    finished = None
    logs: list[dict] = []
    settings = None
    version = None
    for raw in events:
        event = _normalize_event(raw)
        if event is None:
            continue
        kind = event["event"]
        if kind == "start":
            # A retry appends a new run: start the step list afresh.
            steps, order, finished, logs = {}, [], None, []
            started = event
            version = event.get("version") or version
            settings = event.get("settings") or event.get("effective_settings") or settings
            for name in event.get("steps") or []:
                if isinstance(name, str) and name not in steps:
                    order.append(name)
                    steps[name] = {"name": name, "label": STEP_LABELS.get(name, name.replace("_", " ").capitalize()),
                                   "status": "pending"}
        elif kind == "step":
            name = str(event.get("step") or "")
            if not name:
                continue
            if name not in steps:
                order.append(name)
                steps[name] = {"name": name, "label": STEP_LABELS.get(name, name.replace("_", " ").capitalize()),
                               "status": "pending"}
            step = steps[name]
            status = event.get("status") or "running"
            step["status"] = status
            for key in ("done", "total", "unit", "rate", "eta_s", "message"):
                if event.get(key) is not None:
                    step[key] = event[key]
            if status in ("done", "skipped"):
                step.pop("eta_s", None)
                if step.get("total") is not None and status == "done":
                    step["done"] = step["total"]
            if event.get("time") is not None:
                step.setdefault("started_at", event.get("time"))
                if status in ("done", "skipped"):
                    step["finished_at"] = event.get("time")
        elif kind == "log":
            logs.append({"level": event.get("level") or "info", "message": str(event.get("message") or "")})
            logs = logs[-50:]
        elif kind == "done":
            finished = event
    current = next((steps[n] for n in order if steps[n]["status"] == "running"), None)
    n_complete = sum(1 for n in order if steps[n]["status"] in ("done", "skipped"))
    fraction = None
    if order:
        partial = 0.0
        if current and current.get("total"):
            partial = min(1.0, float(current.get("done") or 0) / float(current["total"]))
        fraction = (n_complete + partial) / len(order)
    return {
        "version": version,
        "steps": [steps[n] for n in order],
        "current_step": current["name"] if current else None,
        "fraction": fraction,
        "eta_s": current.get("eta_s") if current else None,
        "logs": logs,
        "warnings": [entry["message"] for entry in logs if entry["level"] == "warning"],
        "settings": settings,
        "started": bool(started),
        "done": finished,
    }


# --------------------------------------------------------------------------
# Outputs, QC and the result summary
# --------------------------------------------------------------------------

def _draft_outputs(outdir: str) -> Optional[dict]:
    """outputs.json from a pre-contract pipeline (pipeline_summary.json / fiberbrowser_open.json)."""
    summary = _read_json(os.path.join(outdir, "pipeline_summary.json"), outdir) or {}
    opener = _read_json(os.path.join(outdir, "fiberbrowser_open.json"), outdir) or {}
    outputs = summary.get("outputs") or {}
    if not outputs and not opener:
        return None
    called = outputs.get("called_bam") or next((d.get("path") for d in opener.get("datasets") or []), None)
    plasmid = outputs.get("plasmid_map") or opener.get("plasmid_map")
    qc_json = outputs.get("qc")
    return {
        "schema": OUTPUTS_SCHEMA,
        "sample": summary.get("sample") or opener.get("sample"),
        "aligned_bam": outputs.get("aligned_bam") or opener.get("aligned_bam"),
        "called_bam": called,
        "qc_report": None,
        "qc": {"json": qc_json} if qc_json else None,
        "tracks": [],
        "reference_fasta": outputs.get("reference_fasta") or opener.get("fasta"),
        "plasmid_map": plasmid,
        "contigs": [],
        "open": {"fasta": None if plasmid else (outputs.get("reference_fasta") or opener.get("fasta")),
                 "datasets": [called] if called else [],
                 "plasmid_maps": [plasmid] if plasmid else [], "region": None},
    }


def call_outputs(output_bam: str, qc_prefix: Optional[str] = None) -> Optional[dict]:
    """outputs.json-shaped outputs of a fiberhmm-call job (it writes none): its BAM and
    its QC (``<--qc-output-prefix>.qc.json``, default ``qc/<BAM stem>.qc.json``), when the BAM is there."""
    if not output_bam or not os.path.isfile(output_bam):
        return None
    stem = os.path.splitext(os.path.basename(output_bam))[0]
    qc = (qc_prefix + ".qc.json" if qc_prefix
          else os.path.join(os.path.dirname(output_bam), "qc", f"{stem}.qc.json"))
    return {"schema": OUTPUTS_SCHEMA, "sample": None, "aligned_bam": None, "called_bam": output_bam,
            "qc_report": None, "qc": {"json": qc} if os.path.isfile(qc) else None, "tracks": [],
            "reference_fasta": None, "plasmid_map": None, "contigs": [],
            "open": {"fasta": None, "datasets": [output_bam], "plasmid_maps": [], "region": None}}


def load_outputs(outdir: str, done_event: Optional[dict] = None) -> Optional[dict]:
    outputs = _read_json(os.path.join(outdir, "outputs.json"), outdir)
    if outputs is None and done_event and isinstance(done_event.get("outputs"), dict):
        outputs = done_event["outputs"]
    if outputs is None:
        outputs = _draft_outputs(outdir)
    if outputs is None:
        return None
    outputs = dict(outputs)
    opener = dict(outputs.get("open") or {})
    opener.setdefault("fasta", None)
    opener.setdefault("datasets", [outputs["called_bam"]] if outputs.get("called_bam") else [])
    opener.setdefault("plasmid_maps", [outputs["plasmid_map"]] if outputs.get("plasmid_map") else [])
    opener.setdefault("region", None)
    outputs["open"] = opener
    return outputs


def qc_json_path(outputs: Optional[dict], outdir: Optional[str] = None) -> Optional[str]:
    """The fiberhmm-qc JSON of a run: outputs.qc.json, else qc_report when JSON, else OUTDIR/qc/*.qc.json."""
    outputs = outputs or {}
    qc = outputs.get("qc")
    if isinstance(qc, dict) and qc.get("json") and os.path.isfile(str(qc["json"])):
        return str(qc["json"])
    if isinstance(qc, str) and qc.endswith(".json") and os.path.isfile(qc):
        return qc
    report = outputs.get("qc_report")
    if isinstance(report, str) and report.endswith(".json") and os.path.isfile(report):
        return report
    if outdir:
        qc_dir = os.path.join(outdir, "qc")
        with contextlib.suppress(OSError):
            candidates = sorted(os.path.join(qc_dir, f) for f in os.listdir(qc_dir) if f.endswith(".qc.json"))
            if candidates:
                return candidates[0]
    return None


def _count_bam(path: str, cap: int) -> dict:
    import pysam
    records = mapped = called = duplicates = 0
    nucleosomes = 0
    approximate = False
    with pysam.AlignmentFile(path, check_sq=False) as bam:
        for read in bam.fetch(until_eof=True):
            if read.is_secondary or read.is_supplementary:
                continue
            records += 1
            if not read.is_unmapped:
                mapped += 1
            if read.is_duplicate:
                duplicates += 1
            if read.has_tag("MA") or read.has_tag("nl") or read.has_tag("ns"):
                called += 1
                if read.has_tag("nl"):
                    with contextlib.suppress(Exception):
                        nucleosomes += len(read.get_tag("nl"))
            if records >= cap:
                approximate = True
                break
    return {"records": records, "mapped": mapped, "called": called, "duplicates": duplicates,
            "nucleosomes": nucleosomes, "approximate": approximate}


def compute_summary(outputs: dict, outdir: str, cap: int = 2_000_000) -> dict:
    """Reads aligned, reads called, duplicate %, footprints per read (QC JSON when present)."""
    summary: dict = {"reads_aligned": None, "reads_called": None, "duplicate_percent": None,
                     "footprints_per_read": None, "qc_status": None, "approximate": False}
    basecall = outputs.get("basecall") if isinstance(outputs.get("basecall"), dict) else None
    if basecall and isinstance(basecall.get("reads"), int):
        summary["reads_basecalled"] = basecall["reads"]  # dorado's reads (POD5 input), as the pipeline counted them
    aligned = outputs.get("aligned_bam")
    called = outputs.get("called_bam")
    from services.lab import get_config
    if get_config() is not None:  # a lab server: only the run's own files
        real_out = os.path.realpath(outdir)

        def own(path):
            real = os.path.realpath(path) if isinstance(path, str) and path else ""
            return path if real.startswith(real_out.rstrip(os.sep) + os.sep) else None
        aligned, called = own(aligned), own(called)
    try:
        if aligned and os.path.isfile(aligned):
            counts = _count_bam(aligned, cap)
            summary["reads_aligned"] = counts["mapped"]
            summary["approximate"] |= counts["approximate"]
        if called and os.path.isfile(called):
            counts = _count_bam(called, cap)
            summary["reads_called"] = counts["called"]
            summary["reads_in_called_bam"] = counts["records"]
            if counts["records"]:
                summary["duplicate_percent"] = round(100.0 * counts["duplicates"] / counts["records"], 1)
            if counts["called"] and counts["nucleosomes"]:
                summary["footprints_per_read"] = round(counts["nucleosomes"] / counts["called"], 1)
            summary["approximate"] |= counts["approximate"]
            if summary["reads_aligned"] is None:
                summary["reads_aligned"] = counts["mapped"]
    except Exception as exc:  # a truncated BAM, pysam missing
        summary["error"] = f"{type(exc).__name__}: {exc}"
    qc = _read_json(qc_json_path(outputs, outdir) or "", outdir)
    if qc:
        summary["qc_status"] = (qc.get("overall") or {}).get("status")
        dedup = qc.get("deduplication") or {}
        if dedup.get("duplicate_fraction") is not None:
            summary["duplicate_percent"] = round(100.0 * float(dedup["duplicate_fraction"]), 1)
        footprints = qc.get("footprints") or {}
        tagged = footprints.get("n_tagged_reads")
        if tagged:
            total = (footprints.get("n_nucleosomes") or 0) + (footprints.get("n_tf_footprints") or 0)
            summary["footprints_per_read"] = round(total / tagged, 1)
    return summary


# --------------------------------------------------------------------------
# Processes
# --------------------------------------------------------------------------

def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, timeout=10)
            return str(pid) in out.stdout
        except (OSError, subprocess.SubprocessError):
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _pid_command(pid: int) -> Optional[str]:
    """The process's command line (ps), or None when it cannot be read."""
    if os.name == "nt":
        return None
    # Linux (and WSL): the kernel's copy of argv, never cut to a terminal width.
    try:
        with open(f"/proc/{int(pid)}/cmdline", "rb") as handle:
            raw = handle.read()
        return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip() + "\n" if raw else ""
    except FileNotFoundError:
        if os.path.isdir("/proc/self"):
            return ""  # a /proc system with no such process: it has exited
    except OSError:
        pass
    try:
        # -ww: the full command. Without it procps ps cuts the line to 80 columns when
        # its output is not a terminal, losing the progress-file marker process_matches
        # looks for (a restarted server then called a running job interrupted).
        out = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return "" if not out.stdout.strip() else out.stdout
    return out.stdout


def process_matches(pid: int, marker: str) -> bool:
    """The pid is alive and is this job's pipeline (its argv names the job's progress file)."""
    if not _pid_exists(pid):
        return False
    command = _pid_command(pid)
    if command is None:
        return True  # cannot check: trust the pid
    if not command.strip():
        return False  # exited (or a zombie that ps no longer lists)
    return marker in command


def _keep_awake(pid: int) -> None:
    if sys.platform != "darwin" or os.environ.get(NO_CAFFEINATE_ENV):
        return
    caffeinate = shutil.which("caffeinate")
    if not caffeinate:
        return
    with contextlib.suppress(OSError):
        subprocess.Popen([caffeinate, "-i", "-w", str(pid)], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


class _FileLock:
    """An advisory lock on the jobs folder, so two FiberBrowser servers never start one job twice."""

    def __init__(self, path: str):
        self.path = path
        self.handle = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.handle = open(self.path, "a+")
        try:
            import fcntl
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        return self

    def __exit__(self, *exc):
        try:
            import fcntl
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        self.handle.close()


class JobManager:
    """The registry on disk plus the queue that starts, watches and ends jobs."""

    def __init__(self, root: Optional[str] = None, *, total_cores: Optional[int] = None,
                 poll_s: float = 1.0, launcher: Optional[Callable[[dict, str], subprocess.Popen]] = None):
        self.root = os.path.abspath(root or jobs_dir())
        env_cores = os.environ.get(CORES_ENV)
        self.total_cores = int(total_cores or (int(env_cores) if env_cores and env_cores.isdigit() else 0)
                               or os.cpu_count() or 1)
        self.poll_s = poll_s
        self._launcher = launcher or self._launch
        self._procs: dict[str, subprocess.Popen] = {}
        self._verified: set[str] = set()
        self._lock = threading.RLock()
        # Depth of this manager's hold on the cross-server lock (see _registry).
        self._registry_depth = 0
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._summaries: set[str] = set()

    # ----- registry -------------------------------------------------------
    @contextlib.contextmanager
    def _registry(self):
        """This thread holds the registry: no other thread, manager or server changes a job's
        state meanwhile. Every registration and state transition happens under it (reentrant:
        ``flock`` on a second descriptor of the lock file would block its own holder)."""
        with self._lock:
            if self._registry_depth:
                self._registry_depth += 1
                try:
                    yield
                finally:
                    self._registry_depth -= 1
                return
            with _FileLock(os.path.join(self.root, ".queue.lock")):
                self._registry_depth = 1
                try:
                    yield
                finally:
                    self._registry_depth = 0

    def job_dir(self, job_id: str) -> str:
        if not valid_job_id(job_id):
            raise KeyError(job_id)
        return os.path.join(self.root, job_id)

    def _paths(self, job_id: str) -> dict:
        d = self.job_dir(job_id)
        return {name: os.path.join(d, name) for name in
                ("spec.json", "state.json", "progress.jsonl", "log", "pid", "summary.json")}

    def job_ids(self) -> list[str]:
        try:
            names = os.listdir(self.root)
        except OSError:
            return []
        return sorted((n for n in names if valid_job_id(n) and os.path.isfile(os.path.join(self.root, n, "spec.json"))),
                      reverse=True)

    def spec(self, job_id: str) -> dict:
        spec = _read_json(self._paths(job_id)["spec.json"], self.job_dir(job_id))
        if spec is None:
            raise KeyError(job_id)
        return spec

    def state(self, job_id: str) -> dict:
        # A record without its state is never "queued": only a published state starts a job.
        return _read_json(self._paths(job_id)["state.json"], self.job_dir(job_id)) or {"status": "incomplete"}

    def _set_state(self, job_id: str, **changes) -> dict:
        with self._registry():
            state = self.state(job_id)
            state.update(changes)
            _write_json(self._paths(job_id)["state.json"], state)
            return state

    @contextlib.contextmanager
    def admission(self):
        """Hold the registry while checking limits and registering jobs together, so
        no other request, manager or server queues a job in between."""
        os.makedirs(self.root, exist_ok=True)
        with self._registry():
            yield

    def create(self, spec: dict, *, admit: Optional[Callable[[], Optional[str]]] = None) -> dict:
        """Register a job (queued). ``spec['argv']`` must already hold the full argv list.

        ``admit``: called under the registry lock just before registering; a message
        it returns refuses the job (JobRefused), so limits hold atomically."""
        if not isinstance(spec.get("argv"), list) or not all(isinstance(a, str) for a in spec["argv"]):
            raise ValueError("spec.argv must be a list of strings")
        os.makedirs(self.root, exist_ok=True)
        with self._registry():
            refusal = admit() if admit is not None else None
            if refusal:
                raise JobRefused(refusal)
            job_id = spec.get("id") or new_job_id()
            while os.path.exists(os.path.join(self.root, job_id)):
                job_id = new_job_id()
            self.job_dir(job_id)  # a valid id
            spec = {**spec, "id": job_id}
            # The complete record (spec and queued state) is written in a staging folder that
            # job_ids() never lists, then published with one rename.
            staging = os.path.join(self.root, f".new-{job_id}-{secrets.token_hex(3)}")
            os.makedirs(staging)
            try:
                _write_json(os.path.join(staging, "spec.json"), spec)
                _write_json(os.path.join(staging, "state.json"),
                            {"status": "queued", "created": _now(), "queued_at": _now(), "attempt": 1})
                os.rename(staging, self.job_dir(job_id))
            except BaseException:
                shutil.rmtree(staging, ignore_errors=True)
                raise
        self.ensure_running()
        return self.describe(job_id)

    def progress_path(self, job_id: str) -> str:
        return self._paths(job_id)["progress.jsonl"]

    def log_path(self, job_id: str) -> str:
        return self._paths(job_id)["log"]

    def read_log(self, job_id: str, max_bytes: int = 256_000, *, strict: bool = False) -> str:
        """The log's tail ("" before there is one). ``strict``: PermissionError when a
        lab server refuses what is there (a link, a FIFO, a linked job folder)."""
        path = self.log_path(job_id)
        try:
            # A lab server: only the regular file in the job's own folder (never a
            # symlink to somewhere else), read from the descriptor that was checked.
            with _open_record(path, self.job_dir(job_id)) as handle:
                size = os.fstat(handle.fileno()).st_size
                if size > max_bytes:
                    handle.seek(size - max_bytes)
                return handle.read().decode("utf-8", errors="replace")
        except PermissionError:
            if strict:
                raise
            return ""
        except OSError:
            return ""

    def describe(self, job_id: str, *, with_progress: bool = True) -> dict:
        spec = self.spec(job_id)
        state = self.state(job_id)
        out = {"id": job_id, "sample": spec.get("sample"), "enzyme": spec.get("enzyme"),
               "outdir": spec.get("outdir"), "reference": spec.get("reference"), "cores": spec.get("cores"),
               "reads": spec.get("reads"), "regions": spec.get("regions") or [],
               "options": spec.get("options") or {}, "option_labels": spec.get("option_labels") or [],
               "group": spec.get("group"), "command": spec.get("display_command"),
               "auto_open": bool(spec.get("auto_open")), "user": spec.get("user"),
               "input_kind": spec.get("input_kind") or "reads", "basecall": spec.get("basecall"), **state}
        if with_progress:
            out["progress"] = summarize_progress(read_events(self.progress_path(job_id), root=self.job_dir(job_id)))
        if state.get("status") == "done":
            out["outputs"] = state.get("outputs") or load_outputs(spec.get("outdir") or "")
            out["summary"] = _read_json(self._paths(job_id)["summary.json"], self.job_dir(job_id))
        return out

    def list(self) -> list[dict]:
        self.ensure_running()
        out = []
        for job_id in self.job_ids():
            with contextlib.suppress(KeyError):
                out.append(self.describe(job_id))
        return out

    def forget(self, job_id: str) -> None:
        with self._registry():
            if self.state(job_id).get("status") in ACTIVE:
                raise RuntimeError("Cancel the job before removing it from the list.")
            shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    # ----- control --------------------------------------------------------
    def cancel(self, job_id: str) -> dict:
        # Under the cross-server lock: a launch in progress on another server finishes first,
        # so a job is never reported cancelled while its process starts.
        with self._registry():
            state = self.state(job_id)
            status = state.get("status")
            if status == "queued":
                self._set_state(job_id, status="cancelled", finished_at=_now(), error="Cancelled before it started.")
            elif status in ("running", "cancelling"):
                self._set_state(job_id, status="cancelling", cancel_requested=_now())
                self._signal(job_id, signal.SIGTERM)
        return self.describe(job_id)

    def retry(self, job_id: str, *, admit: Optional[Callable[[], Optional[str]]] = None) -> dict:
        """Queue the same command again; the pipeline skips the steps it already finished.

        ``admit`` as for :meth:`create`: a retry is a new submission for the limits."""
        with self._registry():
            state = self.state(job_id)
            if state.get("status") in ACTIVE:
                raise RuntimeError("The job is still queued or running.")
            refusal = admit() if admit is not None else None
            if refusal:
                raise JobRefused(refusal)
            progress = self.progress_path(job_id)
            if os.path.exists(progress):
                os.replace(progress, progress + f".{int(state.get('attempt') or 1)}")
            with contextlib.suppress(FileNotFoundError):
                os.remove(self._paths(job_id)["summary.json"])
            self._summaries.discard(job_id)
            self._verified.discard(job_id)
            _write_json(self._paths(job_id)["state.json"], {
                "status": "queued", "created": state.get("created") or _now(), "queued_at": _now(),
                "attempt": int(state.get("attempt") or 1) + 1})
        self.ensure_running()
        return self.describe(job_id)

    def _signal(self, job_id: str, sig) -> bool:
        proc = self._procs.get(job_id)
        pid = int(self.state(job_id).get("pid") or 0)
        if proc is not None and proc.poll() is None:
            with contextlib.suppress(OSError):
                if sig == getattr(signal, "SIGKILL", None) and os.name != "nt":
                    os.killpg(proc.pid, sig)
                else:
                    proc.send_signal(sig)
                return True
        if pid and process_matches(pid, self.progress_path(job_id)):
            with contextlib.suppress(OSError):
                if sig == getattr(signal, "SIGKILL", None) and os.name != "nt":
                    os.killpg(pid, sig)
                else:
                    os.kill(pid, sig)
                return True
        return False

    # ----- running --------------------------------------------------------
    def _launch(self, spec: dict, job_dir: str) -> subprocess.Popen:
        env = dict(os.environ)
        env.update({k: str(v) for k, v in (spec.get("env") or {}).items()})
        env.setdefault("FIBERHMM_NO_UPDATE_CHECK", "1")
        # The app's PATH is launchd's minimal one: FiberHMM finds minimap2/samtools where the
        # shared resolver did (Homebrew, conda), after whatever PATH already has.
        try:
            from services.external_tools import path_with_tools
            env["PATH"] = path_with_tools(env.get("PATH", ""))
        except Exception:
            pass
        env["PYTHONUNBUFFERED"] = "1"
        outdir = spec.get("outdir") or job_dir
        os.makedirs(outdir, exist_ok=True)
        log = open(os.path.join(job_dir, "log"), "ab")
        try:
            log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} {spec.get('display_command') or ''}\n".encode())
            log.flush()
            kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": subprocess.STDOUT,
                            "cwd": outdir, "env": env, "close_fds": True}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | \
                    getattr(subprocess, "DETACHED_PROCESS", 0)
            else:
                kwargs["start_new_session"] = True
            # An argv list: never a shell.
            return subprocess.Popen(list(spec["argv"]), **kwargs)
        finally:
            log.close()

    def _start(self, job_id: str) -> None:
        """Launch a queued job (the caller holds the registry)."""
        if self.state(job_id).get("status") != "queued":
            return  # cancelled, or started elsewhere, since the queue was read
        spec = self.spec(job_id)
        from services.lab.jobs import spec_refusal
        refusal = spec_refusal(spec)  # a lab server: checked again at launch (policy/files may have changed)
        if refusal:
            self._set_state(job_id, status="error", finished_at=_now(), error=refusal)
            return
        try:
            proc = self._launcher(spec, self.job_dir(job_id))
        except (OSError, ValueError) as exc:
            self._set_state(job_id, status="error", finished_at=_now(),
                            error=f"Could not start {spec.get('tool') or 'fiberhmm-pipeline'}: {exc}")
            return
        self._procs[job_id] = proc
        self._verified.add(job_id)
        with open(self._paths(job_id)["pid"], "w", encoding="utf-8") as handle:
            handle.write(f"{proc.pid}\n")
        self._set_state(job_id, status="running", started_at=_now(), pid=proc.pid)
        _keep_awake(proc.pid)

    def _alive(self, job_id: str, state: dict) -> tuple[bool, Optional[int]]:
        """(still running, exit code if known)."""
        proc = self._procs.get(job_id)
        if proc is not None:
            code = proc.poll()
            if code is None:
                return True, None
            self._procs.pop(job_id, None)
            return False, code
        pid = int(state.get("pid") or 0)
        if not pid:
            return False, None
        if job_id in self._verified:
            if _pid_exists(pid) and (_pid_command(pid) or "x").strip():
                return True, None
            return False, None
        if process_matches(pid, self.progress_path(job_id)):
            self._verified.add(job_id)
            return True, None
        return False, None

    def _finish(self, job_id: str, state: dict, exit_code: Optional[int]) -> None:
        spec = self.spec(job_id)
        progress = summarize_progress(read_events(self.progress_path(job_id), root=self.job_dir(job_id)))
        done = progress.get("done")
        cancelled = bool(state.get("cancel_requested"))
        changes: dict = {"finished_at": _now(), "exit_code": exit_code}
        if done and done.get("status") == "ok" and not cancelled:
            changes["status"] = "done"
        elif done and done.get("status") == "error":
            error = str(done.get("error") or "The pipeline failed.")
            changes["status"] = "cancelled" if cancelled or error.strip().lower() == "cancelled" else "error"
            changes["error"] = error
            if done.get("hint"):
                changes["hint"] = done["hint"]
        elif cancelled:
            changes["status"] = "cancelled"
            changes["error"] = "Cancelled."
        elif exit_code == 0:
            changes["status"] = "done"
        else:
            changes["status"] = "error" if exit_code is not None else "interrupted"
            tail = self.read_log(job_id, 4000).strip().splitlines()[-8:]
            changes["error"] = ("The pipeline stopped without finishing"
                                + (f" (exit {exit_code})" if exit_code is not None else "")
                                + (": " + " / ".join(tail) if tail else "."))
        if changes["status"] == "done":
            recall = spec.get("library_recall") if isinstance(spec.get("library_recall"), dict) else {}
            if spec.get("tool") == "fiberhmm-call" or recall.get("tool") == "fiberhmm-call":
                outputs = call_outputs(str(recall.get("output_bam") or ""), recall.get("qc_prefix"))
                if outputs is None:
                    changes["warning"] = "fiberhmm-call finished but its output BAM is not there."
            else:
                outputs = load_outputs(spec.get("outdir") or "", done)
                if outputs is None:
                    changes["warning"] = "The pipeline finished but wrote no outputs.json."
            changes["outputs"] = outputs
        self._set_state(job_id, **changes)
        with contextlib.suppress(FileNotFoundError):
            os.remove(self._paths(job_id)["pid"])
        if changes["status"] == "done" and changes.get("outputs"):
            self._summarize_later(job_id)

    def _summarize_later(self, job_id: str) -> None:
        if job_id in self._summaries:
            return
        self._summaries.add(job_id)

        def work():
            try:
                spec = self.spec(job_id)
                outputs = self.state(job_id).get("outputs") or {}
                summary = compute_summary(outputs, spec.get("outdir") or "")
                _write_json(self._paths(job_id)["summary.json"], summary)
            except Exception as exc:  # never kill the monitor
                with contextlib.suppress(Exception):
                    _write_json(self._paths(job_id)["summary.json"], {"error": str(exc)})

        threading.Thread(target=work, name=f"pipeline-summary-{job_id}", daemon=True).start()

    def tick(self) -> None:
        """One scheduler pass: end finished jobs, escalate slow cancels, start queued ones."""
        with self._registry():
            running_cores = 0
            queued: list[tuple[float, str, int]] = []
            for job_id in self.job_ids():
                try:
                    state = self.state(job_id)
                    spec = self.spec(job_id)
                except KeyError:
                    continue
                status = state.get("status")
                cores = max(1, int(spec.get("cores") or 1))
                if status in ("running", "cancelling"):
                    alive, code = self._alive(job_id, state)
                    if alive:
                        running_cores += cores
                        requested = state.get("cancel_requested")
                        if requested and time.time() - float(requested) > CANCEL_GRACE_S:
                            self._signal(job_id, getattr(signal, "SIGKILL", signal.SIGTERM))
                    else:
                        self._finish(job_id, state, code)
                elif status == "queued":
                    queued.append((float(state.get("queued_at") or 0), job_id, cores))
                elif status == "done" and not os.path.exists(self._paths(job_id)["summary.json"]):
                    self._summarize_later(job_id)
            for _, job_id, cores in sorted(queued):
                if running_cores > 0 and running_cores + cores > self.total_cores:
                    break
                self._start(job_id)
                if self.state(job_id).get("status") == "running":
                    running_cores += cores

    def _loop(self) -> None:
        while not self._stop.wait(self.poll_s):
            try:
                self.tick()
            except Exception as exc:  # keep watching
                print(f"[pipeline jobs] {type(exc).__name__}: {exc}")
            if not any(self.state(j).get("status") in ACTIVE for j in self.job_ids()):
                with self._lock:
                    self._thread = None
                return

    def ensure_running(self) -> None:
        """Start the watcher thread when a job is queued or running (idempotent)."""
        self.tick()
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if not any(self.state(j).get("status") in ACTIVE for j in self.job_ids()):
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="pipeline-jobs", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()


_manager: Optional[JobManager] = None
_manager_lock = threading.Lock()


def get_job_manager() -> JobManager:
    """The server's job manager (its folder follows FIBERBROWSER_JOBS_DIR)."""
    global _manager
    with _manager_lock:
        if _manager is None or _manager.root != os.path.abspath(jobs_dir()):
            if _manager is not None:
                _manager.stop()
            _manager = JobManager()
        return _manager


def date_stamp() -> str:
    return _dt.date.today().isoformat()
