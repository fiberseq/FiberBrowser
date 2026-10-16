"""Startup helpers for the browser server CLI."""
from __future__ import annotations

import os
import shutil
import sys
import threading
import webbrowser
from importlib.util import find_spec
from typing import Optional

from utils.ports import check_port_in_use

_TRUE_ENV_VALUES = {"1", "true", "yes", "on"}
_FALSE_ENV_VALUES = {"0", "false", "no", "off"}


def raise_file_limit() -> None:
    """Give native readers and sockets headroom under desktop launch limits."""
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = 8192 if hard == resource.RLIM_INFINITY else min(hard, 8192)
        if soft != resource.RLIM_INFINITY and soft < target:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
    except (ImportError, OSError, ValueError):
        pass  # Windows, or a host that does not permit changing its soft limit.


def _check_port_in_use(port: int, host: str = "127.0.0.1") -> Optional[int]:
    """Compatibility wrapper for runtime port probing."""
    return check_port_in_use(port, host)


def _env_flag(name: str, environ: dict[str, str] | None = None) -> bool | None:
    env = os.environ if environ is None else environ
    value = env.get(name)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in _TRUE_ENV_VALUES:
        return True
    if normalized in _FALSE_ENV_VALUES:
        return False
    return None


def should_open_browser(args, environ: dict[str, str] | None = None) -> bool:
    """Return whether startup should open the local web UI automatically."""
    env = os.environ if environ is None else environ
    explicit = getattr(args, "open_browser", None)
    if explicit is not None:
        return bool(explicit)

    env_override = _env_flag("FIBERBROWSER_OPEN_BROWSER", env)
    if env_override is not None:
        return env_override

    if _env_flag("FIBERBROWSER_NO_OPEN", env):
        return False
    if _env_flag("FIBERBROWSER_HEADLESS", env):
        return False
    if _env_flag("CI", env):
        return False
    if getattr(args, "public", False):
        return False
    return True


def schedule_browser_open(url: str, *, delay_s: float = 0.8, opener=None):
    """Open the UI shortly after uvicorn begins listening.

    The timer avoids racing the browser against server startup and keeps tests
    mockable without launching a GUI browser.
    """
    open_func = opener or webbrowser.open

    def _open():
        try:
            open_func(url, new=2)
        except Exception as exc:
            print(f"  Warning: could not open web browser automatically: {exc}")

    timer = threading.Timer(delay_s, _open)
    timer.daemon = True
    timer.start()
    return timer


def _resolve_port(requested_port: int, *, force_port: bool = False, host: str = "127.0.0.1") -> int:
    """Choose a free port without signalling or taking over another server.

    ``force_port`` remains accepted for older launch scripts. It never grants
    ownership of a process that happens to use the requested port.
    """
    lower = int(os.environ.get("FIBERBROWSER_PORT_MIN", requested_port))
    upper = int(os.environ.get("FIBERBROWSER_PORT_MAX", min(65535, requested_port + 99)))
    if not 1 <= lower <= upper <= 65535 or not lower <= requested_port <= upper:
        raise ValueError("Requested port is outside the allowed port range")
    candidates = [*range(requested_port, upper + 1), *range(lower, requested_port)]
    for port in candidates:
        if _check_port_in_use(port, host) is None:
            if port != requested_port:
                print(f"  Port {requested_port} is in use. Using port {port} instead.")
            return port
    print(f"  Error: No available port found in range {lower}–{upper}.")
    sys.exit(1)


def _check_optional_deps():
    """Check optional dependencies at startup and inform the user."""
    optional = [
        ('pyjaspar', 'pyjaspar', 'Motif identification (JASPAR TF database in footprint panel)'),
        ('primer3', 'primer3-py', 'Primer design panel'),
        ('seqfold', 'seqfold', 'Primer design panel (hairpin checking)'),
        ('cooler', 'cooler', 'Contact matrix visualization (.cool/.mcool files)'),
        ('h5py', 'h5py', 'Contact matrix visualization (.cool/.mcool files)'),
        ('boto3', 'boto3', 'AWS S3 file support'),
    ]
    missing = []
    for module_name, install_name, feature in optional:
        if find_spec(module_name) is None:
            missing.append((install_name, feature))
    if missing:
        by_feature: dict[str, list[str]] = {}
        for pkg, feature in missing:
            by_feature.setdefault(feature, []).append(pkg)
        print("\n  Optional packages not installed:")
        for feature, pkgs in by_feature.items():
            print(f"    - {', '.join(pkgs):30s} {feature}")
        pip_pkgs = [pkg for pkg, _ in missing]
        print(f"\n  Install all with: pip install {' '.join(pip_pkgs)}")
        print()

    missing_tools = [
        tool for tool in ('blastn', 'makeblastdb')
        if shutil.which(tool) is None
    ]
    if missing_tools:
        print("\n  Optional command-line tools not found:")
        print(f"    - {', '.join(missing_tools):30s} Primer specificity and local BLAST DB setup")
        print("\n  Install BLAST+ with: conda install -c bioconda blast")
        print("  macOS/Homebrew alternative: brew install blast")
        print()
