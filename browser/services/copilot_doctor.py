"""Setup doctor for FiberBrowser and its local Copilot.

`python browser.py --copilot-doctor` prints it; the Copilot panel's "Check
setup" shows the same report (GET /api/nl/doctor). Every check says what it
found and, when something is wrong, the exact command that fixes it.

The report is a dict:
    {"verdict": "ready" | "needs_download" | "needs_fix" | "unsupported",
     "summary": str, "host": {...}, "checks": [{id, status, title, detail, fix}]}
with status "ok" | "warn" | "fail" | "info".
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from typing import Optional

from services import copilot_lifecycle as cl

MIN_PYTHON = (3, 10)
_GB = 1024 ** 3

CORE_PACKAGES = ("numpy", "pandas", "scipy", "fastapi", "uvicorn", "pydantic", "pysam", "pyBigWig", "sklearn", "numba")


def _q(path: str) -> str:
    return f'"{path}"' if " " in path else path


def _check(checks: list, cid: str, status: str, title: str, detail: str = "", fix: str = "") -> None:
    checks.append({"id": cid, "status": status, "title": title, "detail": detail, "fix": fix})


def python_version_problem() -> Optional[str]:
    if sys.version_info < MIN_PYTHON:
        return (f"FiberBrowser needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer; this is "
                f"{sys.version.split()[0]} ({sys.executable}).")
    return None


def python_version_fix() -> str:
    if sys.platform == "darwin":
        return ("Install a current Python (e.g. `brew install python@3.12`, or python.org's macOS installer, or "
                "Miniforge for arm64), then reinstall: python3.12 -m pip install -r requirements.txt")
    return "Install Python 3.10+ (e.g. `conda create -n fiberbrowser python=3.12`), then pip install -r requirements.txt"


def pybigwig_fix() -> str:
    """How to rebuild pyBigWig against the system libraries it was compiled for."""
    py = _q(sys.executable)
    if os.environ.get("CONDA_PREFIX") and sys.executable.startswith(os.environ["CONDA_PREFIX"]):
        return "conda install -c bioconda pybigwig"
    if sys.platform == "darwin":
        # A conda on PATH makes pip build pyBigWig against conda's libcurl/libz,
        # which a non-conda Python can't find at run time.
        return (f"PATH=/usr/bin:/bin:/usr/sbin:/sbin {py} -m pip install --force-reinstall --no-cache-dir pyBigWig")
    # Linux: the same clean PATH, and a source build (--no-binary): the x86_64 wheels on PyPI
    # have no libcurl, so they can't read remote tracks (services/pybigwig_support.py).
    return (f"PATH=/usr/bin:/bin:/usr/sbin:/sbin {py} -m pip install --force-reinstall --no-cache-dir "
            "--no-binary pyBigWig pyBigWig  (needs a C compiler and the libcurl + zlib headers, "
            "e.g. sudo apt install build-essential libcurl4-openssl-dev zlib1g-dev)")


def rosetta_fix() -> str:
    """Exact commands to get a native arm64 Python on an Apple Silicon Mac."""
    return ("Install a native arm64 Python (Miniforge) and reinstall FiberBrowser's packages with it:\n"
            "  curl -LO https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-arm64.sh\n"
            "  bash Miniforge3-MacOSX-arm64.sh -b -p ~/miniforge3\n"
            "  ~/miniforge3/bin/python3 -m venv .venv\n"
            "  .venv/bin/python -m pip install -r requirements.txt\n"
            "  .venv/bin/python browser.py\n"
            "(or run scripts/install.sh, which does this). Check: .venv/bin/python -c \"import platform; "
            "print(platform.machine())\" must print arm64.\n"
            "python.org's macOS installer is also native; if even that prints x86_64, Terminal is set to "
            "\"Open using Rosetta\" (Finder → Applications → Utilities → Terminal → Get Info): untick it.")


def core_dependency_problems() -> list[dict]:
    """Core packages that won't import, each with a fix. Used at startup too."""
    problems = []
    for name in CORE_PACKAGES:
        try:
            importlib.import_module(name)
        except ImportError as exc:
            text = str(exc)
            if name == "pyBigWig" and ("Library not loaded" in text or "libcurl" in text or "libz" in text):
                problems.append({
                    "package": name,
                    "detail": ("pyBigWig is installed but was built against libraries this Python can't find "
                               f"(usually conda's, picked up from PATH at install time): {text.splitlines()[0]}"),
                    "fix": pybigwig_fix(),
                })
            else:
                pip_name = {"sklearn": "scikit-learn", "pyBigWig": "pyBigWig"}.get(name, name)
                problems.append({
                    "package": name,
                    "detail": f"{name} isn't installed in this Python ({sys.executable}): {text.splitlines()[0]}",
                    "fix": f"{_q(sys.executable)} -m pip install -r requirements.txt   (or: -m pip install {pip_name})",
                })
        except Exception as exc:  # a broken compiled extension
            problems.append({"package": name, "detail": f"{name} fails to load: {type(exc).__name__}: {exc}",
                             "fix": f"{_q(sys.executable)} -m pip install --force-reinstall --no-cache-dir {name}"})
    return problems


def _version(module: str) -> Optional[str]:
    try:
        from importlib.metadata import version
        return version(module)
    except Exception:
        return None


def run_doctor(*, network: bool = True, port: Optional[int] = None, copilot: bool = True) -> dict:
    """``copilot=False`` (FiberBrowser.app, --no-copilot): the install only;
    nothing about the Copilot is checked or suggested."""
    checks: list[dict] = []
    info = cl.host_info()
    port = int(port or os.environ.get("FIBERBROWSER_COPILOT_MLX_PORT") or 8080)

    # ── Python + core install ──────────────────────────────────────────
    py_problem = python_version_problem()
    if py_problem:
        _check(checks, "python", "fail", "Python version", py_problem, python_version_fix())
    else:
        _check(checks, "python", "ok", f"Python {info['python']}", info["python_executable"])
    core = core_dependency_problems()
    if core:
        for p in core:
            _check(checks, f"package:{p['package']}", "fail", f"{p['package']} won't load", p["detail"], p["fix"])
    else:
        _check(checks, "packages", "ok", "Core packages load", ", ".join(CORE_PACKAGES))
        from services.pybigwig_support import url_support_problem
        remote_problem = url_support_problem()
        if remote_problem:
            _check(checks, "pybigwig_remote", "warn", "pyBigWig can't read remote tracks", remote_problem,
                   pybigwig_fix())

    if not copilot:
        from services.runtime import COPILOT_NOT_INCLUDED_MESSAGE
        _check(checks, "copilot", "info", "Copilot not included", COPILOT_NOT_INCLUDED_MESSAGE)
        if py_problem or core:
            return {"verdict": "needs_fix", "copilot": False, "host": info, "checks": checks,
                    "summary": "FiberBrowser's own install has a problem; fix the items marked ✗."}
        return {"verdict": "ready", "copilot": False, "host": info, "checks": checks,
                "summary": "FiberBrowser's install checks out."}

    # ── Can this machine run the Copilot model? ────────────────────────
    host_problem = cl.mlx_host_problem(info)
    if info["system"] == "Darwin":
        arch = "Apple Silicon" if info["apple_silicon"] else "Intel"
        py_arch = "arm64 Python" if not info["rosetta"] and info["machine"] == "arm64" else f"{info['machine']} Python"
        label = f"{arch} Mac, macOS {info['macos_version'] or '?'}, {py_arch}"
    else:
        label = f"{info['system']} {info['machine']}"
    if host_problem is None:
        _check(checks, "platform", "ok", "This machine can run the Copilot model", label)
    elif info["rosetta"]:
        _check(checks, "platform", "fail", "Python is running under Rosetta (Intel)", host_problem, rosetta_fix())
    else:
        _check(checks, "platform", "info", "The local Copilot isn't available on this machine", host_problem)

    mlx_problem = None
    if host_problem is None:
        mlx_problem = cl.mlx_import_problem()
        if mlx_problem:
            _check(checks, "mlx", "fail", "mlx-lm (the model runtime) isn't usable", mlx_problem,
                   f"{_q(sys.executable)} -m pip install 'mlx-lm>=0.19' huggingface_hub")
        else:
            _check(checks, "mlx", "ok", "Model runtime installed",
                   f"mlx {_version('mlx') or '?'}, mlx-lm {_version('mlx-lm') or '?'}, "
                   f"huggingface_hub {_version('huggingface_hub') or 'not installed'}")
            if not _version("huggingface_hub"):
                _check(checks, "hub", "fail", "huggingface_hub isn't installed", "It downloads the model.",
                       f"{_q(sys.executable)} -m pip install huggingface_hub")

    # ── Models: what fits, what's here, room to download ───────────────
    ram = cl._detect_ram_gb()
    recommended = cl._pick_model(ram_gb=ram) if host_problem is None else None
    cached = cl.cached_models()
    if host_problem is None:
        if recommended:
            size = cl.estimate_download_bytes(recommended) / _GB
            _check(checks, "model", "info", "Recommended model",
                   f"{recommended.get('label', recommended['id'])} (~{size:.1f} GB) for {ram or '?'} GB of memory")
        else:
            _check(checks, "model", "fail", "No trained model is registered for this machine",
                   "data/copilot_dataset/models.json has no current, trained entry that fits.", "Update FiberBrowser.")
        if cached:
            _check(checks, "cache", "ok", "Downloaded models",
                   ", ".join(m["id"] for m in cached) + f"  (in {cl.COPILOT_HOME})")
        else:
            free = cl.free_disk_bytes(cl.COPILOT_HOME)
            need = cl.estimate_download_bytes(recommended) if recommended else 0
            if free is not None and recommended and not cl._fits_on_disk(recommended, free):
                alt, note = cl.choose_entry_for_disk(recommended)
                _check(checks, "disk", "warn" if alt else "fail", "Disk space", note or "",
                       "" if alt else "Free some space, or set FIBERBROWSER_COPILOT_HOME to a folder on a bigger disk.")
            else:
                _check(checks, "disk", "ok", "Disk space",
                       f"{(free or 0) / _GB:.1f} GB free at {cl.COPILOT_HOME} (needs ~{need / _GB:.1f} GB)")

    # ── Network (only matters when a download is still needed) ─────────
    if network and host_problem is None and not cached:
        offline = cl.hub_offline_problem(timeout=5.0)
        if offline:
            _check(checks, "network", "fail", "Can't reach the model download server", offline,
                   "Connect to the internet (or set HTTPS_PROXY), or download the model on another machine and copy "
                   f"its folder into {cl.COPILOT_HOME}.")
        else:
            _check(checks, "network", "ok", "Model download server reachable", cl.hub_endpoint())

    # ── Model server + Ollama ──────────────────────────────────────────
    served = cl._served_model_ids(f"http://127.0.0.1:{port}", timeout=0.8)
    if served:
        _check(checks, "server", "ok", f"Model server running on port {port}", ", ".join(Path(m).name for m in served))
    elif cl.port_in_use("127.0.0.1", port):
        _check(checks, "server", "warn", f"Port {port} is used by another program",
               "The model server will start on the next free port automatically.",
               "Or pick one: python browser.py --copilot-port 8090")
    elif host_problem is None:
        _check(checks, "server", "info", "Model server not running",
               "It starts automatically once a model is downloaded (Set up Copilot → Download & start).")
    ollama_models = []
    try:
        from services.natural_language_commands import list_ollama_models
        ollama_models = list_ollama_models(timeout=0.5)
    except Exception:
        ollama_models = []
    tuned = cl._registered_ollama_model()
    if ollama_models:
        detail = "models: " + ", ".join(ollama_models[:6])
        if tuned and not any(m.startswith(tuned.split(":")[0]) for m in ollama_models):
            _check(checks, "ollama", "warn", "Ollama is running", detail + ". The FiberBrowser-tuned model isn't pulled.",
                   f"ollama pull {tuned}")
        else:
            _check(checks, "ollama", "ok" if host_problem else "info", "Ollama is running", detail)

    err = cl.last_setup_error()
    if err.get("message"):
        _check(checks, "last_error", "warn", "Last setup problem", err["message"] + (
            "\n" + err["log_tail"] if err.get("log_tail") else ""))

    # ── Verdict ────────────────────────────────────────────────────────
    failing = [c for c in checks if c["status"] == "fail"]
    core_broken = py_problem or core
    if core_broken:
        verdict, summary = "needs_fix", "FiberBrowser's own install has a problem; fix the items marked ✗."
    elif info["rosetta"]:
        verdict, summary = "needs_fix", ("This Python is an Intel build running under Rosetta; install an arm64 "
                                         "Python for the Copilot (the fix is listed above).")
    elif host_problem is not None:
        if ollama_models:
            verdict, summary = "ready", "Copilot uses Ollama on this machine."
        else:
            verdict = "unsupported"
            summary = ("The local Copilot currently needs an Apple Silicon Mac with a native arm64 Python. "
                       "Everything else in FiberBrowser works normally on this machine.")
    elif failing:
        verdict, summary = "needs_fix", "Copilot can't start yet; fix the items marked ✗."
    elif served:
        verdict, summary = "ready", "Copilot is ready."
    elif cached:
        verdict, summary = "needs_download", "A model is downloaded; Set up Copilot → Download & start runs it."
    else:
        verdict, summary = "needs_download", ("Everything checks out. Open the Copilot panel → Set up Copilot → "
                                              "Download & start (one time).")
    return {"verdict": verdict, "summary": summary, "host": info, "checks": checks}


_MARK = {"ok": "✓", "warn": "!", "fail": "✗", "info": "·"}


def format_report(report: dict) -> str:
    title = "FiberBrowser Copilot setup check" if report.get("copilot", True) else "FiberBrowser setup check"
    lines = [title, "=" * len(title)]
    for c in report["checks"]:
        lines.append(f" {_MARK.get(c['status'], '?')} {c['title']}")
        for part in (c.get("detail") or "").splitlines():
            lines.append(f"     {part}")
        if c.get("fix") and c["status"] in ("fail", "warn", "info"):
            lines.append("     fix:")
            for part in c["fix"].splitlines():
                lines.append(f"       {part}")
    lines.append("")
    lines.append(f"Result: {report['summary']}")
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    from argparse import Namespace
    from services.runtime import copilot_left_out
    args = list(argv or [])
    included = not copilot_left_out(Namespace(no_copilot="--no-copilot" in args))
    report = run_doctor(network="--offline" not in args, copilot=included)
    print(format_report(report))
    return 0 if report["verdict"] in ("ready", "needs_download") else 1
