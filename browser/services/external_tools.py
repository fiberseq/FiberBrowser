"""Finding the command-line tools FiberBrowser runs (BLAST+, minimap2, samtools), and dorado.

The Mac app started from Finder inherits launchd's minimal PATH
(``/usr/bin:/bin:/usr/sbin:/sbin``), so a Homebrew or conda install the user
made is invisible to ``shutil.which``. Every place that shells out asks this
module instead. Candidates, in order:

1. a path the user set in ``~/.fiberhmm/browser_settings.json``
   (``"tools": {"blastn": "/path/to/blastn"}``, or ``"blast_dir"`` for the
   BLAST+ folder): an explicit choice wins;
2. the app bundle's own copy (``Contents/Helpers``, ``Contents/Resources/bin``);
3. PATH;
4. common install locations: ``/opt/homebrew/bin``, ``/usr/local/bin``, the
   active conda environment (``CONDA_PREFIX``), ``~/miniconda3``,
   ``~/miniforge3``, ``~/mambaforge``, ``~/anaconda3``, ``~/.local/bin`` and
   ``/usr/bin`` (a distribution's package, e.g. Debian's ncbi-blast+ in the WSL
   distribution, even when PATH leaves it out).

A candidate counts only if it runs and prints a version (``-version`` /
``--version``); a broken or foreign binary is skipped with the reason kept for
the status report. Results are cached per (PATH, settings) and re-checked
with ``refresh=True`` (the panels' "Check again").

dorado (Oxford Nanopore's basecaller, for raw POD5 input) is resolved for its
status only: fiberhmm-pipeline finds and runs it. Its candidates add
``$FIBERHMM_DORADO`` (which the pipeline honours first) right after the
settings, and dorado's usual install folders (``~/dorado-*/bin``,
``/opt/dorado*/bin``, ... as ``fiberhmm.pipeline.basecall`` lists them) after
PATH. :func:`dorado_pipeline_args` passes ``--dorado`` to a job only when the
pipeline would not find that same copy itself.
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
import sys
import threading
from dataclasses import asdict, dataclass, field
from typing import Optional

VERSION_ARGS = {
    "blastn": ["-version"], "makeblastdb": ["-version"], "dustmasker": ["-version"],
    "minimap2": ["--version"], "samtools": ["--version"], "dorado": ["--version"],
}
BLAST_TOOLS = ("blastn", "makeblastdb")
VERIFY_TIMEOUT = 15

INSTALL_HINTS = {
    "blast": "Install BLAST+ with 'brew install blast' or 'conda install -c bioconda blast', "
             "or set its folder in ~/.fiberhmm/browser_settings.json (\"blast_dir\").",
    "minimap2": "Install minimap2 with 'brew install minimap2' or 'conda install -c bioconda minimap2'.",
    "samtools": "Install samtools with 'brew install samtools' or 'conda install -c bioconda samtools'.",
    "dorado": "dorado (Oxford Nanopore's basecaller) is not bundled: download it from "
              "https://github.com/nanoporetech/dorado (Releases), unpack it anywhere (e.g. ~/dorado) and add its "
              "bin/ folder to PATH, or set its path in ~/.fiberhmm/browser_settings.json (\"tools\": {\"dorado\": ...}).",
}
DORADO_ENV = "FIBERHMM_DORADO"
_VERSION_NUMBER = re.compile(r"\b(\d+\.\d+\.\d+\S*)")


@dataclass
class ToolInfo:
    name: str
    path: Optional[str] = None
    version: Optional[str] = None
    source: Optional[str] = None  # settings / bundle / PATH / common
    rejected: list = field(default_factory=list)  # [path, why] of candidates that did not run

    @property
    def ok(self) -> bool:
        return self.path is not None

    def to_dict(self) -> dict:
        out = asdict(self)
        out["ok"] = self.ok
        out["hint"] = "" if self.ok else install_hint(self.name)
        return out


def install_hint(name: str) -> str:
    if name == "dorado":
        return dorado_install_help()
    return INSTALL_HINTS["blast"] if name in BLAST_TOOLS or name == "dustmasker" else INSTALL_HINTS.get(name, "")


def dorado_install_help() -> str:
    """FiberHMM's own instructions (fiberhmm.pipeline.basecall.INSTALL_HELP) when it is importable."""
    try:
        from fiberhmm.pipeline.basecall import INSTALL_HELP
        return str(INSTALL_HELP)
    except Exception:
        return INSTALL_HINTS["dorado"]


def dorado_install_dirs() -> list[str]:
    """dorado's usual install folders, as fiberhmm-pipeline searches them (its own list when importable)."""
    try:
        from fiberhmm.pipeline.basecall import candidate_paths
        return [os.path.dirname(p) for p in candidate_paths()]
    except Exception:
        pass
    home = os.path.expanduser("~")
    patterns = [os.path.join(home, ".local", "bin", "dorado"), os.path.join(home, "dorado*", "bin", "dorado"),
                os.path.join(home, "local", "dorado*", "bin", "dorado"),
                os.path.join(home, "local", "dorado", "dorado*", "bin", "dorado"),
                os.path.join(home, "Applications", "dorado*", "bin", "dorado"),
                os.path.join(home, "opt", "dorado*", "bin", "dorado"), "/opt/dorado*/bin/dorado",
                "/opt/ont/dorado*/bin/dorado", "/usr/local/dorado*/bin/dorado", "/Applications/dorado*/bin/dorado"]
    found: list[str] = []
    for pattern in patterns:
        for path in sorted(glob.glob(pattern), reverse=True):
            if os.path.dirname(path) not in found:
                found.append(os.path.dirname(path))
    return found


def _bundle_dirs() -> list[str]:
    try:
        from fiberbrowser._paths import bundle_bin_dirs
        return [str(d) for d in bundle_bin_dirs()]
    except Exception:
        if not getattr(sys, "frozen", False):
            return []
        contents = os.path.dirname(os.path.dirname(os.path.realpath(sys.executable)))
        return [d for d in (os.path.join(contents, "Helpers"), os.path.join(contents, "Resources", "bin")) if os.path.isdir(d)]


def common_dirs(environ: Optional[dict] = None) -> list[str]:
    env = os.environ if environ is None else environ
    home = os.path.expanduser("~")
    dirs = ["/opt/homebrew/bin", "/usr/local/bin"]
    if env.get("CONDA_PREFIX"):
        dirs.append(os.path.join(env["CONDA_PREFIX"], "bin"))
    for name in ("miniconda3", "miniforge3", "mambaforge", "anaconda3"):
        dirs.append(os.path.join(home, name, "bin"))
    dirs.append(os.path.join(home, ".local", "bin"))
    dirs.append("/usr/bin")
    return dirs


def _settings_candidates(name: str) -> list[str]:
    try:
        from services.user_settings import load_user_settings
        settings = load_user_settings()
    except Exception:
        return []
    out = []
    tools = settings.get("tools")
    if isinstance(tools, dict) and tools.get(name):
        value = os.path.expanduser(str(tools[name]))
        if os.path.isdir(value) and name == "dorado" and os.path.isfile(os.path.join(value, "bin", name)):
            out.append(os.path.join(value, "bin", name))  # dorado's install folder
        else:
            out.append(os.path.join(value, name) if os.path.isdir(value) else value)
    if name in VERSION_ARGS and name not in ("minimap2", "samtools", "dorado") and settings.get("blast_dir"):
        out.append(os.path.join(os.path.expanduser(str(settings["blast_dir"])), name))
    return out


def candidates(name: str, environ: Optional[dict] = None) -> list[tuple[str, str]]:
    """Every place ``name`` could be, in preference order, as (path, source)."""
    env = os.environ if environ is None else environ
    out: list[tuple[str, str]] = [(p, "settings") for p in _settings_candidates(name)]
    if name == "dorado":
        explicit = (env.get(DORADO_ENV) or "").strip()
        if explicit:  # fiberhmm-pipeline's own override: what it would run
            explicit = os.path.expanduser(explicit)
            if os.path.isdir(explicit):
                explicit = next((p for p in (os.path.join(explicit, "bin", name), os.path.join(explicit, name))
                                 if os.path.isfile(p)), os.path.join(explicit, name))
            out.append((explicit, "environment"))
    else:
        out += [(os.path.join(d, name), "bundle") for d in _bundle_dirs()]  # dorado is never bundled
    # Every PATH entry, in order (a broken first one must not hide a working later one).
    for folder in (env.get("PATH", "") or "").split(os.pathsep):
        if folder:
            out.append((os.path.join(folder, name), "PATH"))
    if name == "dorado":
        out += [(os.path.join(d, name), "common") for d in dorado_install_dirs()]
    out += [(os.path.join(d, name), "common") for d in common_dirs(env)]
    seen, unique = set(), []
    for path, source in out:
        key = os.path.realpath(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append((path, source))
    return unique


def verify(path: str, name: str) -> tuple[Optional[str], Optional[str]]:
    """(version, None) when ``path`` runs and reports a version, else (None, why)."""
    if not (os.path.isfile(path) and os.access(path, os.X_OK)):
        return None, "not found"
    try:
        proc = subprocess.run([path, *VERSION_ARGS.get(name, ["--version"])], capture_output=True, text=True,
                              timeout=VERIFY_TIMEOUT, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"does not run ({type(exc).__name__})"
    text = (proc.stdout or proc.stderr or "").strip()
    if proc.returncode != 0 or not text:
        return None, f"exited {proc.returncode} without a version"
    if name == "dorado":  # dorado logs to stderr; the version is the number wherever it is printed
        found = _VERSION_NUMBER.search((proc.stdout or "") + "\n" + (proc.stderr or ""))
        if not found:
            return None, "printed no dorado version"
        return found.group(1)[:60], None
    first = text.splitlines()[0].strip()
    if name in BLAST_TOOLS or name == "dustmasker":
        first = first.split(":", 1)[-1].strip() if ":" in first else first  # "blastn: 2.17.0+"
    return first[:120], None


_lock = threading.Lock()
_cache: dict[tuple, ToolInfo] = {}


def _cache_key(name: str, environ: Optional[dict]) -> tuple:
    env = os.environ if environ is None else environ
    try:
        from services.user_settings import load_user_settings
        settings = load_user_settings()
        stamp = repr((settings.get("tools"), settings.get("blast_dir")))
    except Exception:
        stamp = ""
    return (name, env.get("PATH", ""), env.get("CONDA_PREFIX", ""), stamp, tuple(_bundle_dirs()),
            env.get(DORADO_ENV, "") if name == "dorado" else "", os.path.expanduser("~"))


def resolve(name: str, *, refresh: bool = False, environ: Optional[dict] = None) -> ToolInfo:
    """The first candidate for ``name`` that runs (cached)."""
    key = _cache_key(name, environ)
    with _lock:
        if not refresh and key in _cache:
            return _cache[key]
    info = ToolInfo(name=name)
    for path, source in candidates(name, environ):
        version, why = verify(path, name)
        if version is not None:
            info.path, info.version, info.source = os.path.abspath(path), version, source
            break
        if why != "not found" or source in ("settings", "bundle", "PATH", "environment"):
            info.rejected.append([path, why])
    with _lock:
        _cache[key] = info
    return info


def tool_path(name: str, **kw) -> Optional[str]:
    return resolve(name, **kw).path


class ToolMissing(RuntimeError):
    def __init__(self, name: str):
        self.name = name
        super().__init__(f"{name} was not found. {install_hint(name)}")


def require(name: str, **kw) -> str:
    path = tool_path(name, **kw)
    if not path:
        raise ToolMissing(name)
    return path


def status(names=("blastn", "makeblastdb", "minimap2"), *, refresh: bool = False) -> dict:
    return {n: resolve(n, refresh=refresh).to_dict() for n in names}


def blast_summary(*, refresh: bool = False) -> dict:
    """What the panels show: which BLAST+ is used, its version, or how to install it."""
    blastn = resolve("blastn", refresh=refresh)
    makeblastdb = resolve("makeblastdb", refresh=refresh)
    if blastn.ok:
        label = f"BLAST+ {blastn.version} ({blastn.path})"
    else:
        label = "BLAST+ not found"
    return {"ok": blastn.ok, "label": label, "blastn": blastn.to_dict(), "makeblastdb": makeblastdb.to_dict(),
            "hint": "" if blastn.ok and makeblastdb.ok else install_hint("blastn")}


_shim_lock = threading.Lock()
_shim_dir: Optional[str] = None


def tool_shim_dir(names=("minimap2", "samtools")) -> Optional[str]:
    """A private folder holding links to exactly the resolved tools (nothing else from their
    folders), for subprocesses that look tools up on PATH themselves. None when no tool was
    found or links can't be made."""
    global _shim_dir
    with _shim_lock:
        if _shim_dir is None or not os.path.isdir(_shim_dir):
            import tempfile
            _shim_dir = tempfile.mkdtemp(prefix="fiberbrowser-tools-")
        linked = False
        for name in names:
            found = tool_path(name)
            link = os.path.join(_shim_dir, name)
            try:
                if os.path.islink(link) and os.readlink(link) != found:
                    os.remove(link)
                if found and not os.path.lexists(link):
                    os.symlink(found, link)
                linked = linked or bool(found)
            except OSError:
                return None
        return _shim_dir if linked else None


def path_with_tools(path: str, names=("minimap2", "samtools")) -> str:
    """``path`` for a subprocess that finds the tools itself (the FiberHMM pipeline): the
    resolver's choices come first, through a folder of links to just those programs, so a
    different (or broken) copy earlier on PATH is not used and nothing else is shadowed."""
    entries = [p for p in (path or "").split(os.pathsep) if p]
    shim = tool_shim_dir(names)
    if shim:
        return os.pathsep.join([shim] + [e for e in entries if e != shim])
    for name in names:  # links unavailable: fall back to appending the folders
        found = tool_path(name)
        if found and os.path.dirname(found) not in entries:
            entries.append(os.path.dirname(found))
    return os.pathsep.join(entries)


def dorado_status(*, refresh: bool = False) -> dict:
    """What the New run wizard shows before a POD5 run: the dorado found (path, version), or how to install it."""
    info = resolve("dorado", refresh=refresh)
    out = info.to_dict()
    out["label"] = f"dorado {info.version} ({info.path})" if info.ok else "dorado not found"
    return out


def _pipeline_dorado(environ: Optional[dict] = None) -> Optional[str]:
    """The dorado fiberhmm-pipeline would pick by itself in a job (fiberhmm.pipeline.basecall.find_dorado:
    $FIBERHMM_DORADO, the job's PATH, then the usual install folders): the first executable candidate,
    without running anything."""
    import shutil
    env = os.environ if environ is None else environ
    explicit = (env.get(DORADO_ENV) or "").strip()
    if explicit:
        explicit = os.path.expanduser(explicit)
        if os.path.isdir(explicit):
            explicit = next((p for p in (os.path.join(explicit, "bin", "dorado"), os.path.join(explicit, "dorado"))
                             if os.path.isfile(p)), explicit)
        return explicit
    job_path = path_with_tools(env.get("PATH", ""))
    for path in [shutil.which("dorado", path=job_path)] + [os.path.join(d, "dorado") for d in dorado_install_dirs()]:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def dorado_pipeline_args(environ: Optional[dict] = None) -> list[str]:
    """``['--dorado', PATH]`` for a POD5 job when FiberBrowser found dorado somewhere the pipeline would not
    look first (a path in the settings, a folder only FiberBrowser searches, a broken copy earlier on PATH),
    so the job runs the dorado the wizard showed; ``[]`` when the pipeline finds that same one itself, or
    FiberBrowser found none (the pipeline then reports it, with the install instructions)."""
    info = resolve("dorado", environ=environ)
    if not info.ok:
        return []
    own = _pipeline_dorado(environ)
    if own and os.path.realpath(own) == os.path.realpath(info.path):
        return []
    return ["--dorado", info.path]


def clear_cache() -> None:
    with _lock:
        _cache.clear()
