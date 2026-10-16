"""Auto-launch / auto-download lifecycle for the Copilot model server.

Goal: a tester runs `python browser.py --copilot mlx` and the launcher:
  1. probes the host RAM,
  2. picks the largest registered model tier that fits,
  3. downloads it from the Hugging Face Hub if not already cached,
  4. starts mlx_lm.server as a managed child process pointing at it,
  5. sets the env vars the planner reads,
  6. shuts the server down cleanly with the browser.

Falls back gracefully when mlx-lm or huggingface_hub aren't installed; the
copilot just won't auto-launch and the user gets a clear message.
"""
from __future__ import annotations

import atexit
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

# Where downloaded fused models land. Same parent as ~/.fiberhmm/genomes/ so
# all of FiberBrowser's auto-pulled artifacts share a tree.
COPILOT_HOME = Path(os.environ.get(
    "FIBERBROWSER_COPILOT_HOME",
    str(Path.home() / ".fiberhmm" / "copilot_models"),
))
# Model-server logs: beside the models, never the launch directory (a Finder
# double-click or a read-only checkout has no writable ./logs).
COPILOT_LOG_DIR = Path(os.environ.get(
    "FIBERBROWSER_COPILOT_LOG_DIR",
    str(COPILOT_HOME.parent / "logs"),
))

# Hugging Face Hub: fail instead of hanging when the network is slow, proxied
# or absent (HPC compute nodes). setdefault keeps an operator's own values.
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "20")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

# MLX supports macOS 13.5 or later (its wheels are tagged for macOS 13+, Darwin 22).
MLX_MIN_MACOS = (13, 5)


# ---------------------------------------------------------------------------
# Host checks — shared by setup, the download flow and the setup doctor.
# ---------------------------------------------------------------------------

def _sysctl(name: str) -> Optional[str]:
    try:
        out = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def host_info() -> dict:
    """What this machine is, for deciding whether the local Copilot can run.

    ``rosetta`` means this Python is an Intel (x86_64) build running under
    Rosetta on an Apple Silicon Mac: MLX can't load there, and pip silently
    skips mlx-lm (its marker asks for arm64).
    """
    system = platform.system()
    machine = platform.machine()
    info = {
        "system": system,
        "machine": machine,
        "python": platform.python_version(),
        "python_executable": sys.executable,
        "apple_silicon": False,
        "rosetta": False,
        "macos_version": None,
    }
    if system == "Darwin":
        info["macos_version"] = platform.mac_ver()[0] or None
        hw_arm64 = _sysctl("hw.optional.arm64") == "1"
        translated = _sysctl("sysctl.proc_translated") == "1"
        info["apple_silicon"] = hw_arm64 or machine == "arm64"
        info["rosetta"] = translated or (hw_arm64 and machine != "arm64")
    return info


def _version_tuple(text: Optional[str]) -> tuple[int, ...]:
    parts = []
    for piece in (text or "").split("."):
        if not piece.isdigit():
            break
        parts.append(int(piece))
    return tuple(parts)


def mlx_host_problem(info: Optional[dict] = None) -> Optional[str]:
    """Why MLX can't run here, in plain words; None when this host can run it."""
    info = info or host_info()
    if info["system"] != "Darwin":
        name = {"Linux": "a Linux machine", "Windows": "a Windows PC"}.get(info["system"], "this machine")
        return (f"The local Copilot currently needs an Apple Silicon Mac (M1 or later) with a native "
                f"arm64 Python; this is {name}. Everything else in FiberBrowser works normally without it.")
    if not info["apple_silicon"]:
        return ("The local Copilot currently needs an Apple Silicon Mac (M1 or later) with a native "
                "arm64 Python; this is an Intel Mac. Everything else in FiberBrowser works normally without it.")
    if info["rosetta"]:
        return ("This Python is an Intel (x86_64) build running under Rosetta, so the Apple Silicon "
                "model runtime (MLX) can't load in it. Install a native arm64 Python and reinstall "
                "FiberBrowser's requirements with it; `python browser.py --copilot-doctor` (or Check setup) "
                "prints the exact commands. Everything else in FiberBrowser works normally meanwhile.")
    mac = _version_tuple(info.get("macos_version"))
    if mac and mac < MLX_MIN_MACOS:
        return (f"The local Copilot model needs macOS {MLX_MIN_MACOS[0]}.{MLX_MIN_MACOS[1]} or later; this Mac runs "
                f"macOS {info['macos_version']}. Update macOS to use it.")
    return None


def mlx_import_problem() -> Optional[str]:
    """Why mlx / mlx_lm can't be imported (None when both import)."""
    try:
        import mlx_lm  # noqa: F401
        import mlx.core  # noqa: F401
    except ImportError:
        return (f"mlx-lm isn't installed in this Python ({sys.executable}). Install it with: "
                f"{_quote(sys.executable)} -m pip install 'mlx-lm>=0.19' huggingface_hub")
    except Exception as exc:  # a broken install (e.g. a missing Metal library)
        return f"mlx-lm is installed but won't load: {type(exc).__name__}: {exc}"
    return None


def _quote(path: str) -> str:
    return f'"{path}"' if " " in path else path


def free_disk_bytes(path: Path) -> Optional[int]:
    """Free space on the volume holding ``path`` (its nearest existing parent)."""
    probe = Path(path)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


def hub_endpoint() -> str:
    return (os.environ.get("HF_ENDPOINT") or "https://huggingface.co").rstrip("/")


def hub_offline_problem(timeout: float = 5.0) -> Optional[str]:
    """Plain-language reason the Hugging Face Hub can't be reached (None when it can).

    A short connect timeout so an offline machine (an HPC compute node, a
    captive network) fails in seconds instead of hanging a download.
    """
    if os.environ.get("HF_HUB_OFFLINE", "").strip().lower() in ("1", "true", "yes"):
        return "HF_HUB_OFFLINE is set, so models can't be downloaded. Unset it, or copy a model into ~/.fiberhmm/copilot_models/."
    url = f"{hub_endpoint()}/api/models?limit=1"
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return None
    except urllib.error.HTTPError:
        return None  # the server answered: reachable
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        text = f"{type(reason).__name__}: {reason}"
        if "CERTIFICATE" in text.upper() or "SSL" in text.upper():
            return (f"Can't make a secure connection to {hub_endpoint()} ({text}). Behind a proxy that "
                    "re-signs traffic, point SSL_CERT_FILE / REQUESTS_CA_BUNDLE at your organisation's "
                    "certificate bundle.")
        return (f"Can't reach {hub_endpoint()} to download the model ({text}). Check the internet "
                "connection or proxy (HTTPS_PROXY); on a cluster, compute nodes are often offline.")
    except (OSError, ValueError) as exc:
        return f"Can't reach {hub_endpoint()} ({type(exc).__name__}: {exc})."


def port_in_use(host: str, port: int) -> bool:
    """Whether something already listens on ``host:port``."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        try:
            return sock.connect_ex((host, port)) == 0
        except OSError:
            return False


def _free_port_near(host: str, port: int, span: int = 20) -> Optional[int]:
    for candidate in range(port + 1, port + 1 + span):
        if not port_in_use(host, candidate):
            return candidate
    return None


def _log_tail(path: Path, lines: int = 15) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.strip().splitlines()[-lines:])


# The last setup failure, in plain words (+ server log tail), for the panel.
_last_error: dict = {"message": None, "log_tail": None, "at": 0.0}


def _record_error(message: str, log_tail: Optional[str] = None) -> None:
    _last_error.update(message=message, log_tail=log_tail or None, at=time.time())
    print(f"  [copilot] {message}", file=sys.stderr)


def last_setup_error() -> dict:
    return dict(_last_error)


def cached_models() -> list[dict]:
    """Registered models whose weights are already on this machine."""
    return [m for m in _load_registry() if m.get("trained") and _is_model_cached(m)]


def copilot_setup_message(backend: str = "mlx") -> str:
    """What the user should do to get the Copilot answering, in plain words.

    Cheap (no network): used whenever a question can't reach a model.
    """
    host_problem = mlx_host_problem()
    import_problem = None if host_problem else mlx_import_problem()
    ollama_hint = ("If you run Ollama, start it (`ollama serve`) and pull a model"
                   + (f" (`ollama pull {_registered_ollama_model()}`)" if _registered_ollama_model() else "")
                   + ", then click Re-detect in Set up Copilot.")
    if backend == "ollama" and (host_problem or import_problem):
        return f"{host_problem or import_problem} {ollama_hint}"
    if host_problem:
        return host_problem
    if import_problem:
        return import_problem
    status = dict(_download_status)
    if status.get("state") in ("downloading", "spawning"):
        return f"Copilot is still getting ready ({status.get('message') or status['state']}). Try again in a moment."
    err = last_setup_error()
    recent = err.get("message") and time.time() - float(err.get("at") or 0) < 3600
    if cached_models():
        base = ("A Copilot model is downloaded but its server isn't running. Open ⚙ Set up Copilot in this "
                "panel and click Download & start (it starts without downloading again).")
    else:
        base = ("Copilot isn't set up yet. Open ⚙ Set up Copilot in this panel and click Download & start "
                "(a one-time download of about 1–4 GB; it then runs offline).")
    return f"{base} Last problem: {err['message']}" if recent else base


def _registered_ollama_model() -> Optional[str]:
    """The FiberBrowser-tuned Ollama model this host should pull, if one is published."""
    ranked = [m for m in _load_registry()
              if m.get("ollama_model") and m.get("trained") and not m.get("deprecated")]
    if not ranked:
        return None
    ram = _detect_ram_gb()
    fitting = [m for m in ranked if ram is None or ram >= float(m.get("min_ram_gb") or 0)] or ranked
    fitting.sort(key=lambda m: (int(m.get("version") or 1), float(m.get("size_b") or 0)), reverse=True)
    return str(fitting[0]["ollama_model"])


# Module-level handle to the managed child process; atexit clean-up reads it.
_managed_proc: Optional[subprocess.Popen] = None
_backend_lock = threading.Lock()


def _http_ok(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False


def _set_active_backend(backend: str, *, mlx_base_url: Optional[str] = None) -> None:
    with _backend_lock:
        os.environ["FIBERBROWSER_COPILOT_BACKEND"] = backend
        if mlx_base_url:
            os.environ["FIBERBROWSER_COPILOT_MLX_URL"] = f"{mlx_base_url}/v1/chat/completions"
            os.environ["FIBERBROWSER_COPILOT_MLX_MODELS_URL"] = f"{mlx_base_url}/v1/models"

        # If services.natural_language_commands has already been imported, its
        # module-level COPILOT_BACKEND would otherwise stay stale until restart.
        planner = sys.modules.get("services.natural_language_commands")
        set_backend = getattr(planner, "set_backend", None) if planner is not None else None
        if callable(set_backend):
            try:
                set_backend(backend)
            except Exception:
                pass


def _detect_ram_gb() -> Optional[float]:
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page_size > 0:
            return round(pages * page_size / (1024 ** 3), 1)
    except (ValueError, OSError, AttributeError):
        pass
    return None


def _load_registry() -> list[dict]:
    """Read data/copilot_dataset/models.json from the repo."""
    import json
    registry = Path(__file__).resolve().parents[2] / "data" / "copilot_dataset" / "models.json"
    try:
        return json.loads(registry.read_text(encoding="utf-8")).get("models", [])
    except Exception:
        return []


def _pick_model(*, override_id: Optional[str] = None, ram_gb: Optional[float] = None) -> Optional[dict]:
    """Pick the largest model that fits on this host. Override always wins."""
    if override_id:
        for m in _load_registry():
            if m.get("id") == override_id:
                return m
        return None
    ranked = _ranked_models(ram_gb=ram_gb)
    return ranked[0] if ranked else None


def _ranked_models(*, ram_gb: Optional[float] = None) -> list[dict]:
    """Trained, current models that fit this host's RAM, best first."""
    registry = _load_registry()
    if ram_gb is None:
        ram_gb = _detect_ram_gb()
    candidates = []
    for m in registry:
        if not m.get("trained"):
            continue  # Don't auto-pick a tier we haven't trained.
        if m.get("deprecated"):
            continue  # Don't auto-pick a tier we've explicitly retired.
        if not m.get("hf_repo") and not _is_model_cached(m):
            # Local-only entry (no Hub repo yet) whose fused_path isn't on this
            # machine: it can be neither downloaded nor served.
            continue
        rec = float(m.get("recommended_ram_gb") or 0)
        mn = float(m.get("min_ram_gb") or 0)
        size = float(m.get("size_b") or 0)
        version = int(m.get("version") or 1)
        if ram_gb is None:
            fit_score = 0
        elif ram_gb >= rec:
            fit_score = 2  # comfortable
        elif ram_gb >= mn:
            fit_score = 1  # minimum
        else:
            fit_score = -1  # insufficient
        # Sort key: (fit, version, size). Newer version always beats older
        # within the same fit tier, then larger model wins as the tiebreaker.
        # Without `version` in the key, an old non-quantized v1 would beat a
        # newer non-quantized v4 of the same tier just because they're equal
        # on (fit, size).
        candidates.append((fit_score, version, size, m))
    candidates.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    return [c[3] for c in candidates if c[0] >= 0]


def _local_model_path(entry: dict) -> Path:
    """Where this tier's files live on disk after download."""
    # A local-only entry may carry "hf_repo": null.
    repo_dir = (entry.get("hf_repo") or entry["id"]).split("/")[-1]
    return COPILOT_HOME / repo_dir


def _is_model_cached(entry: dict) -> bool:
    """True when the model's weights are fully present on disk (no download needed).

    A complete cache must have config.json AND at least one .safetensors weight
    shard. Checking config.json alone produces silent failures when
    huggingface_hub's snapshot_download was interrupted mid-pull — the small
    files commit first, the multi-GB shards download last. A truncated cache
    leaves config.json + model.safetensors.index.json but zero weight shards,
    which makes mlx_lm.server crash with `FileNotFoundError: No safetensors
    found` on every chat request. Local-only entries (no hf_repo) count as
    cached when their fused_path directory exists.
    """
    hf_repo = entry.get("hf_repo")
    if not hf_repo:
        if not entry.get("fused_path"):
            return False
        local = Path(__file__).resolve().parents[2] / entry["fused_path"]
        return local.is_dir()
    target = _local_model_path(entry)
    if not (target / "config.json").exists():
        return False
    # A sharded model lists its shards in the index: all of them must be here
    # (an interrupted pull can leave the first shard but not the rest).
    index = target / "model.safetensors.index.json"
    if index.exists():
        import json
        try:
            shards = set((json.loads(index.read_text(encoding="utf-8")).get("weight_map") or {}).values())
        except (OSError, ValueError):
            return False
        return bool(shards) and all((target / name).is_file() for name in shards)
    return any(target.glob("*.safetensors"))


def _download_model(entry: dict, *, download: bool = True) -> Optional[Path]:
    """Resolve the fused model path, pulling from HF Hub if needed.

    When ``download=False`` (auto mode), never fetch weights — return the cached
    path if present, else None. The browser must never block startup on a
    multi-GB download; that only happens on explicit ``--copilot mlx`` or the
    in-app download flow.
    """
    hf_repo = entry.get("hf_repo")
    if not hf_repo:
        # No HF repo registered yet; fall back to local fused_path if it exists.
        local = Path(__file__).resolve().parents[2] / entry.get("fused_path", "")
        return local if local.is_dir() else None

    target = _local_model_path(entry)
    if _is_model_cached(entry):
        return target  # already cached and weights present
    if not download:
        return None  # auto mode: present-only, never pull weights

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        _record_error("huggingface_hub isn't installed, so the model can't be downloaded. Install it with: "
                      f"{_quote(sys.executable)} -m pip install huggingface_hub")
        return None

    offline = hub_offline_problem()
    if offline:
        _record_error(offline)
        return None

    print(f"  [copilot] downloading {hf_repo} → {target} ...")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _record_error(f"Can't create {target.parent} ({exc}). Set FIBERBROWSER_COPILOT_HOME to a writable folder.")
        return None
    kwargs = {"repo_id": hf_repo, "local_dir": str(target)}
    import inspect
    try:
        # huggingface_hub < 0.23 symlinked into its cache unless told not to;
        # the argument is deprecated (and later removed) since then.
        if "local_dir_use_symlinks" in inspect.signature(snapshot_download).parameters:
            import huggingface_hub
            if _version_tuple(getattr(huggingface_hub, "__version__", "")) < (0, 23):
                kwargs["local_dir_use_symlinks"] = False
    except (TypeError, ValueError):
        pass
    try:
        # Resumes a partial download: files already complete are skipped.
        snapshot_download(**kwargs)
    except Exception as exc:
        text = f"{type(exc).__name__}: {exc}"
        if "SSL" in text.upper() or "CERTIFICATE" in text.upper():
            hint = (" Behind a proxy that re-signs traffic, point SSL_CERT_FILE / REQUESTS_CA_BUNDLE at "
                    "your organisation's certificate bundle.")
        elif "space" in text.lower():
            hint = " The disk looks full; free some space and try again (the download resumes)."
        else:
            hint = " Try again: the download resumes where it stopped."
        _record_error(f"Downloading {hf_repo} failed ({text}).{hint}")
        return None
    if not _is_model_cached(entry):
        _record_error(f"The download of {hf_repo} finished but its weight files are missing; try again to resume it.")
        return None
    return target


def _server_start_timeout(model_path: Path) -> float:
    """Seconds to wait for the server to load its weights: more for bigger models
    (a 7B fp16 is ~14 GB off disk), within 60 s – 10 min."""
    try:
        gb = sum(p.stat().st_size for p in Path(model_path).glob("*.safetensors")) / (1024 ** 3)
    except OSError:
        gb = 0.0
    return float(min(600.0, max(60.0, 60.0 + 20.0 * gb)))


def _mlx_server_command(model_path: Path, host: str, port: int) -> list[str]:
    """Run the server with THIS interpreter (never a PATH lookup, which may be
    another Python). Newer mlx-lm has a `python -m mlx_lm server` CLI (and
    deprecates `-m mlx_lm.server`); older releases (still >= 0.19) only have
    `-m mlx_lm.server`, so use whichever this install provides."""
    import importlib.util
    try:
        has_cli = importlib.util.find_spec("mlx_lm.__main__") is not None
    except (ImportError, ValueError):
        has_cli = False
    module = ["mlx_lm", "server"] if has_cli else ["mlx_lm.server"]
    return [sys.executable, "-m", *module, "--model", str(model_path),
            "--host", host, "--port", str(port)]


def _start_mlx_server(model_path: Path, *, host: str, port: int, log_path: Path,
                      timeout_s: Optional[float] = None) -> Optional[subprocess.Popen]:
    """Spawn mlx_lm.server as a child process. Returns the Popen handle."""
    try:
        import mlx_lm  # noqa: F401
    except ImportError:
        _record_error("mlx-lm isn't installed in this Python, so the model server can't start. Install it with: "
                      f"{_quote(sys.executable)} -m pip install 'mlx-lm>=0.19'")
        return None
    except Exception as exc:  # installed but can't initialise (no Metal device, broken install)
        _record_error(f"mlx-lm is installed but won't load: {type(exc).__name__}: {exc}")
        return None

    base_url = f"http://{host}:{port}"
    # Something else already answers on this port: our child couldn't bind it,
    # and its answers would look like our server starting.
    if _http_ok(f"{base_url}/v1/models", timeout=0.5):
        _record_error(f"Port {port} is already serving another model server; not starting a second one.")
        return None

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        log_path = Path(os.environ.get("TMPDIR", "/tmp")) / log_path.name
    cmd = _mlx_server_command(model_path, host, port)
    print(f"  [copilot] starting mlx_lm.server on {host}:{port}  → {log_path}")
    try:
        # The child keeps its own copy of the log descriptor; ours closes here.
        with open(log_path, "ab", buffering=0) as log_fp:
            proc = subprocess.Popen(
                cmd,
                stdout=log_fp,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
    except Exception as exc:
        _record_error(f"Could not start the model server ({type(exc).__name__}: {exc}).")
        return None

    # Wait for the server to start accepting connections (longer for bigger
    # models). The child exiting is checked first, so a server that died can't
    # pass as ready.
    wait_s = timeout_s if timeout_s is not None else _server_start_timeout(model_path)
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            _record_error(f"The model server exited while starting (exit code {proc.returncode}). Its log: {log_path}",
                          _log_tail(log_path))
            return None
        if _http_ok(f"{base_url}/v1/models", timeout=0.5):
            return proc
        time.sleep(0.5)
    # Never became ready: not a working server. Stop it rather than report
    # it ready (and leave a child holding the port and memory).
    _record_error(f"The model server didn't answer within {int(wait_s)} s, so it was stopped "
                  f"(a slow disk or too little free memory can cause this). Its log: {log_path}",
                  _log_tail(log_path))
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass
    return None


def _shutdown_managed():
    """atexit hook: SIGTERM the managed child if any, escalate to SIGKILL."""
    global _managed_proc
    if _managed_proc is None:
        return
    if _managed_proc.poll() is not None:
        _managed_proc = None
        return
    try:
        if os.name == "nt":  # no process groups on Windows
            _managed_proc.terminate()
        else:
            os.killpg(os.getpgid(_managed_proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    for _ in range(40):
        time.sleep(0.1)
        if _managed_proc.poll() is not None:
            _managed_proc = None
            return
    try:
        if os.name == "nt":
            _managed_proc.kill()
        else:
            os.killpg(os.getpgid(_managed_proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    _managed_proc = None


def _served_model_ids(url: str, timeout: float = 0.8) -> Optional[list[str]]:
    """Model ids a running server reports, or None when nothing answers."""
    import json
    try:
        with urllib.request.urlopen(f"{url}/v1/models", timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
        return None
    return [str(m.get("id", "")) for m in (data.get("data") or []) if isinstance(m, dict)]


def _serves(model_ids: list[str], entry: dict) -> bool:
    """Whether a server's reported ids are this registry entry's model (its id, repo or local folder)."""
    names = {entry.get("id") or "", entry.get("hf_repo") or "", _local_model_path(entry).name}
    names.discard("")
    return any(mid in names or mid.rstrip("/").split("/")[-1] in names for mid in model_ids)


def _adopt_existing_server(host: str, port: int, entry: Optional[dict] = None) -> bool:
    """Point the planner at an mlx_lm.server already running. No spawn, no teardown.

    With ``entry`` (a model was asked for), only a server that serves it counts.
    """
    url = f"http://{host}:{port}"
    model_ids = _served_model_ids(url)
    if model_ids is None:
        return False
    # A requested model must actually be listed (an empty list is a server
    # still loading, or one with no model: not the one asked for).
    if entry is not None and not _serves(model_ids, entry):
        return False
    _set_active_backend("mlx", mlx_base_url=url)
    print(f"  [copilot] adopting mlx_lm.server already running on {host}:{port}")
    return True


def _ollama_reachable(timeout: float = 0.5) -> bool:
    tags_url = os.environ.get(
        "FIBERBROWSER_COPILOT_OLLAMA_TAGS_URL",
        "http://127.0.0.1:11434/api/tags",
    )
    return _http_ok(tags_url, timeout=timeout)


def _spawn_mlx(args, entry: dict, *, allow_download: bool = True) -> bool:
    """Spawn mlx_lm.server for ``entry``, register teardown, set env vars.

    With ``allow_download=True`` the model is pulled from HF if not cached;
    with ``allow_download=False`` (auto startup) only an already-cached model is
    used — an uncached model returns False without any download. Returns True on
    success."""
    model_path = _download_model(entry, download=allow_download)
    if model_path is None:
        if allow_download:
            print(f"  [copilot] no usable model files for {entry['id']}", file=sys.stderr)
        return False

    host = "127.0.0.1"
    port = _claim_port(host, int(getattr(args, "copilot_port", 8080) or 8080))
    if port is None:
        return False
    log_path = COPILOT_LOG_DIR / f"copilot_{entry['id']}.log"
    proc = _start_mlx_server(model_path, host=host, port=port, log_path=log_path)
    if proc is None:
        return False

    _manage(proc)
    _set_active_backend("mlx", mlx_base_url=f"http://{host}:{port}")
    print(f"  [copilot] ready: {entry['label']} ({model_path.name}) on {host}:{port}")
    return True


def _claim_port(host: str, port: int) -> Optional[int]:
    """The port the model server should bind: ``port``, or a free one nearby
    when another (non-model-server) program holds it (8080 is popular)."""
    if port_in_use(host, port) and _served_model_ids(f"http://{host}:{port}", timeout=0.5) is None:
        free = _free_port_near(host, port)
        if free is None:
            _record_error(f"Port {port} is in use by another program and no nearby port is free; "
                          "start FiberBrowser with --copilot-port <free port>.")
            return None
        print(f"  [copilot] port {port} is taken by another program; using {free} for the model server")
        port = free
        os.environ["FIBERBROWSER_COPILOT_MLX_PORT"] = str(port)
    return port


_atexit_registered = False
_signal_handlers_installed = False


def install_shutdown_handlers() -> None:
    """Stop the managed model server however the browser exits (atexit,
    SIGTERM, Ctrl+C). Idempotent.

    Signal handlers can only be set on the main thread, so setup_copilot
    installs them at startup, before uvicorn runs: that also covers a server
    started later by the panel's download (a worker thread). Without them,
    uvicorn re-raises SIGTERM after its graceful shutdown, the default action
    kills the process before atexit runs, and the model server is orphaned,
    holding its port and gigabytes of memory.
    """
    global _atexit_registered, _signal_handlers_installed
    if not _atexit_registered:
        atexit.register(_shutdown_managed)
        _atexit_registered = True
    if _signal_handlers_installed or threading.current_thread() is not threading.main_thread():
        return
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            prev = signal.getsignal(sig)
            def _handler(signum, frame, _prev=prev):
                _shutdown_managed()
                if callable(_prev):
                    _prev(signum, frame)
                elif _prev == signal.SIG_DFL:
                    signal.signal(signum, signal.SIG_DFL)
                    os.kill(os.getpid(), signum)
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            return
    _signal_handlers_installed = True


def _manage(proc: subprocess.Popen) -> None:
    """Own the child: stop it when the browser exits."""
    global _managed_proc
    _managed_proc = proc
    install_shutdown_handlers()


def setup_copilot(args) -> bool:
    """Wire up the Copilot backend at startup. True when a backend is ready.

    Modes:
      - **auto** (default): pick whatever's already up. If an mlx_lm.server
        responds on the configured port, adopt it. Else if mlx-lm is
        installed and a trained tier is cached, spawn one. Else if Ollama
        is reachable, use Ollama. Else stay silent (planner returns a
        clear error only when the user actually tries to plan).
      - **mlx**: force MLX. Adopt a running server if present, otherwise
        try to spawn. Won't fall back to Ollama.
      - **ollama**: force Ollama. Just sets the env var.
      - **off**: skip all of this.

    Off Apple Silicon (Linux, Windows, Intel Macs, Rosetta Python) nothing
    is spawned or downloaded: auto only adopts a running server or Ollama.
    """
    mode = getattr(args, "copilot", "auto")
    # The panel's "Download & start" (/api/nl/setup, /api/nl/download) runs
    # later, with only the environment to go on: it uses the same port.
    if getattr(args, "copilot_port", None):
        os.environ["FIBERBROWSER_COPILOT_MLX_PORT"] = str(int(args.copilot_port))
    if mode == "off":
        return False
    # Now, on the main thread: a model server the panel starts later (from a
    # worker thread) must still stop with the browser.
    install_shutdown_handlers()
    if mode == "ollama":
        _set_active_backend("ollama")
        return True

    port = int(getattr(args, "copilot_port", 8080) or 8080)
    host = "127.0.0.1"

    # Adopt an already-running mlx_lm.server first — no spawn, no port
    # conflict, no waiting on weights to reload into memory. When a specific
    # model was asked for, only a server serving it is adopted; our own server
    # running another model is replaced.
    override_id = getattr(args, "copilot_model", None)
    wanted = _pick_model(override_id=override_id) if override_id else None
    if _adopt_or_free_port(host, port, wanted):
        return True

    # Spawn mlx_lm.server. Only explicit `--copilot mlx` may download weights;
    # `auto` spawns ONLY an already-cached model and never blocks startup on a
    # multi-GB pull (the in-app panel drives consented downloads instead).
    entry = _pick_model(override_id=override_id)
    if mode != "mlx" and not override_id and entry is not None and not _is_model_cached(entry):
        # Auto never downloads: the best model already on disk beats none.
        entry = next((m for m in _ranked_models() if _is_model_cached(m)), entry)
    if mode == "mlx":
        problem = mlx_host_problem() or mlx_import_problem()
        if problem:
            _record_error(problem)
            return False
        if entry is None:
            _record_error("No trained Copilot model is registered for this machine "
                          "(data/copilot_dataset/models.json); update FiberBrowser.")
            return False
        if not override_id:
            entry, note = choose_entry_for_disk(entry)
            if entry is None:
                _record_error(note)
                return False
            if note:
                print(f"  [copilot] {note}")
    if entry is not None and mlx_host_problem() is None:
        try:
            import mlx_lm  # noqa: F401
            mlx_available = True
        except ImportError:
            mlx_available = False
        except Exception as exc:  # e.g. "[metal::load_device] No Metal device available"
            # mlx is installed but can't initialise here: Copilot is off, the
            # browser still starts.
            _record_error(f"mlx-lm is installed but won't load: {type(exc).__name__}: {exc}")
            mlx_available = False
        if mlx_available:
            if _spawn_mlx(args, entry, allow_download=(mode == "mlx")):
                return True
            if mode == "mlx":
                print("  [copilot] mlx spawn failed and --copilot=mlx was requested; not falling back to Ollama.", file=sys.stderr)
                return False

    # Auto mode: nothing MLX-shaped available. Try Ollama silently.
    if _ollama_reachable():
        _set_active_backend("ollama")
        print("  [copilot] using Ollama backend (mlx_lm.server not reachable)")
        return True

    # Nothing running yet. On a Mac that can run MLX, stay on MLX so the panel
    # offers its one-click download (not Ollama instructions); elsewhere the
    # panel explains what this machine can use.
    problem = mlx_host_problem() or mlx_import_problem()
    if problem is None:
        _set_active_backend("mlx", mlx_base_url=f"http://{host}:{port}")
        print("  [copilot] not set up yet: open the Copilot panel → Set up Copilot to download a model "
              "(one time, 1–4 GB). `python browser.py --copilot-doctor` checks everything.")
    else:
        print(f"  [copilot] off: {problem}")
    return False


def setup_copilot_safely(args) -> bool:
    """``setup_copilot`` for server startup: the genome browser must start even
    when the Copilot can't (mlx raising at import on a Mac without a usable
    Metal device, a broken install, an unexpected bug). Any failure is logged,
    recorded for the Copilot panel, and the Copilot is turned off."""
    try:
        return setup_copilot(args)
    except Exception as exc:
        _record_error(f"Copilot setup failed ({type(exc).__name__}: {exc}); "
                      "the browser runs without Copilot.")
        try:
            args.copilot = "off"
        except Exception:
            pass
        return False


def _adopt_or_free_port(host: str, port: int, wanted: Optional[dict]) -> bool:
    """Adopt a server already serving ``wanted`` (or any, when None): True.

    Otherwise, when our own managed server is running another model, stop it
    so a new one can bind the port; False means the caller should spawn.
    """
    if _adopt_existing_server(host, port, wanted):
        return True
    if wanted is not None and _managed_proc is not None and _managed_proc.poll() is None:
        _shutdown_managed()
    return False


# ---------------------------------------------------------------------------
# In-app (consented) model download — drives the panel's "Download & start"
# flow. Runs in a background thread so the HTTP request returns immediately and
# the frontend can poll byte-level progress. This is the ONLY path (besides
# explicit --copilot mlx) that pulls weights; startup `auto` never does.
# ---------------------------------------------------------------------------

_GB = 1024 ** 3

_download_lock = threading.Lock()
_download_status: dict = {
    "state": "idle",      # idle | downloading | spawning | ready | error
    "model_id": None,
    "label": None,
    "bytes_total": 0,
    "message": "",
    "error": None,
}
_download_thread: Optional[threading.Thread] = None


def estimate_download_bytes(entry: dict) -> int:
    """Rough on-disk size of a tier, for size labels and as a progress fallback.

    fp16 weights ≈ 2 bytes/param; int4 (q4) ≈ ~0.55 bytes/param incl. metadata.
    """
    size_b = float(entry.get("size_b") or 0) * 1e9
    per_param = 0.55 if entry.get("quantized") else 2.0
    return int(size_b * per_param)


_DISK_HEADROOM = 1.1          # need 10% over the download size
_DISK_SLACK = 512 * 1024 ** 2  # plus half a GB, so the disk isn't filled to the brim


def _fits_on_disk(entry: dict, free: Optional[int]) -> bool:
    if free is None or _is_model_cached(entry):
        return True
    return free >= estimate_download_bytes(entry) * _DISK_HEADROOM + _DISK_SLACK


def choose_entry_for_disk(entry: dict) -> tuple[Optional[dict], Optional[str]]:
    """The model to download given free disk space: ``entry`` when it fits, else
    the best smaller one that does (its q4 build, then smaller tiers), with a
    note; (None, reason) when nothing fits."""
    free = free_disk_bytes(COPILOT_HOME)
    if _fits_on_disk(entry, free):
        return entry, None
    for alt in _ranked_models():
        if alt.get("id") == entry.get("id") or not alt.get("hf_repo"):
            continue
        if estimate_download_bytes(alt) >= estimate_download_bytes(entry):
            continue
        if _fits_on_disk(alt, free):
            return alt, (f"Only {free / _GB:.1f} GB free on the disk, too little for {entry.get('label', entry['id'])} "
                         f"(~{estimate_download_bytes(entry) / _GB:.1f} GB); using {alt.get('label', alt['id'])} "
                         f"(~{estimate_download_bytes(alt) / _GB:.1f} GB) instead.")
    return None, (f"Only {free / _GB:.1f} GB free on the disk holding {COPILOT_HOME}; the smallest Copilot model "
                  "needs about 1.5 GB. Free some space, or set FIBERBROWSER_COPILOT_HOME to a folder on a bigger disk.")


def _remote_total_bytes(entry: dict) -> int:
    """Sum of the HF repo's file sizes (exact), falling back to the estimate."""
    hf_repo = entry.get("hf_repo")
    if hf_repo:
        try:
            from huggingface_hub import HfApi
            try:
                info = HfApi().model_info(hf_repo, files_metadata=True, timeout=15)
            except TypeError:  # an older huggingface_hub without `timeout`
                info = HfApi().model_info(hf_repo, files_metadata=True)
            total = sum(int(getattr(s, "size", 0) or 0) for s in (info.siblings or []))
            if total > 0:
                return total
        except Exception:
            pass
    return estimate_download_bytes(entry)


def _dir_bytes(path: Path) -> int:
    """Recursive on-disk size, including the .cache/*.incomplete staging area."""
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


def _run_download(args, entry: dict) -> None:
    """Background worker: pull weights, then adopt or spawn the server."""
    try:
        if entry.get("hf_repo") and not _is_model_cached(entry):
            offline = hub_offline_problem()
            if offline:
                _record_error(offline)
                with _download_lock:
                    _download_status.update(state="error", error="offline", message=offline, log_tail=None)
                return
        # The exact size needs the Hub (can be slow): here, not in the request.
        total = _remote_total_bytes(entry)
        with _download_lock:
            _download_status["bytes_total"] = total
            _download_status["message"] = "Downloading model weights…"
        path = _download_model(entry, download=True)
        if path is None:
            err = last_setup_error()
            with _download_lock:
                _download_status.update(state="error", error="download failed",
                                        message=err.get("message") or "Could not download the model files.",
                                        log_tail=err.get("log_tail"))
            return
        with _download_lock:
            _download_status.update(state="spawning",
                                    message="Starting the model server (loading the weights into memory)…")
        # A server already serving this model is used as is; our own serving
        # another model is replaced (the port would otherwise be taken).
        port = int(getattr(args, "copilot_port", 8080) or 8080)
        if _adopt_or_free_port("127.0.0.1", port, entry) or _spawn_mlx(args, entry, allow_download=False):
            with _download_lock:
                _download_status.update(state="ready",
                                        message=f"{entry.get('label', entry['id'])} ready.")
        else:
            err = last_setup_error()
            with _download_lock:
                _download_status.update(state="error", error="spawn failed",
                                        message=err.get("message") or "Downloaded, but the model server did not start.",
                                        log_tail=err.get("log_tail"))
    except Exception as exc:  # pragma: no cover - defensive
        with _download_lock:
            _download_status.update(state="error", error=f"{type(exc).__name__}: {exc}",
                                    message=f"Download failed ({type(exc).__name__}: {exc}).")


def start_background_download(model_id: Optional[str] = None,
                             copilot_port: int = 8080) -> dict:
    """Begin a consented model download in the background. Idempotent while a
    download is in flight. Returns the current status dict."""
    global _download_thread
    with _download_lock:
        if _download_status["state"] in ("downloading", "spawning"):
            return dict(_download_status)  # already running; let the client poll
    # Fail fast, in plain words, before starting a thread: a machine that can't
    # run the model, no mlx-lm, no disk space. (Network reachability is checked
    # in the worker, with a short timeout, so this request never waits on it.)
    problem = mlx_host_problem() or mlx_import_problem()
    entry = None if problem else _pick_model(override_id=model_id)
    note = None
    if problem is None and entry is None:
        problem = "No matching model tier to download."
    if problem is None:
        entry, note = choose_entry_for_disk(entry)
        if entry is None:
            problem = note
    with _download_lock:
        if problem:
            _record_error(problem)
            _download_status.update(state="error", model_id=model_id, label=None,
                                    bytes_total=0, error="setup failed", message=problem,
                                    log_tail=None)
            return dict(_download_status)
        _download_status.update(
            state="downloading",
            model_id=entry["id"],
            label=entry.get("label", entry["id"]),
            bytes_total=0,
            message=note or "Preparing download…",
            error=None,
            log_tail=None,
        )

    import types
    args = types.SimpleNamespace(copilot="mlx", copilot_model=entry["id"], copilot_port=copilot_port)
    with _download_lock:
        # The size lookup (model_info, a network call) runs in the worker.
        _download_status["bytes_total"] = estimate_download_bytes(entry)
        _download_thread = threading.Thread(target=_run_download, args=(args, entry),
                                            daemon=True)
        _download_thread.start()
        return dict(_download_status)


def get_download_status() -> dict:
    """Current download status with live byte progress computed on read."""
    with _download_lock:
        status = dict(_download_status)
    entry = _pick_model(override_id=status.get("model_id")) if status.get("model_id") else None
    bytes_done = _dir_bytes(_local_model_path(entry)) if entry else 0
    total = status.get("bytes_total") or 0
    if status["state"] == "ready":
        bytes_done = total or bytes_done
    pct = int(min(100, round(100 * bytes_done / total))) if total else 0
    status["bytes_done"] = bytes_done
    status["pct"] = pct
    return status

