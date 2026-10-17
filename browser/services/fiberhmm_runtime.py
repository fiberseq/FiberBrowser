"""Resolve the FiberHMM inference package used by FiberBrowser.

Which FiberHMM a process runs (``fiberhmm_selection``):

- **Packaged apps** (the Mac app, the Windows app's WSL distribution; services/app_build.py) run the FiberHMM
  bundled with them. ``FIBERHMM_SOURCE_DIR`` > the app's own choice (Settings > FiberHMM: bundled or a custom
  source tree, ``~/.fiberhmm/app_settings.json``) > bundled. ``fiberhmm_source_dir`` in
  ``~/.fiberhmm/browser_settings.json`` does not apply to them.
- **Source runs and pip installs** (``python browser.py``, ``fiberbrowser``): ``FIBERHMM_SOURCE_DIR`` >
  ``fiberhmm_source_dir`` in ``~/.fiberhmm/browser_settings.json`` > the ``fiberhmm`` installed in their Python
  (``pip install "fiberhmm[consensus]>=3.0.2,<4"``).

A source tree is put first on ``sys.path`` so an older installed package never shadows it.

Each build declares the FiberHMM features it needs: core needs FiberHMM 3.0 (``CORE_REQUIREMENTS``), a plugin
pack adds its own (``"fiberhmm"`` in its ``fiberbrowser-pack.json``). The selected FiberHMM is checked from its
files, without importing it (a package imported and then swapped is never safe). A packaged app whose custom
FiberHMM lacks a feature falls back to its bundled one, with a one-line notice; a source run keeps the tree it was
pointed at and says what won't work. Nothing runs silently without the features. ``log_fiberhmm_runtime`` prints
the choice and its notices at startup.
"""
from __future__ import annotations

import importlib
import importlib.machinery
import json
import os
import re
import sys
from pathlib import Path
from typing import Iterable, Optional


_CONFIGURED_ROOT: Optional[str] = None
# The app's own choice (Settings), read once per process: changing it takes effect at the next start.
_APP_CHOICE: Optional[tuple] = None


MIN_FIBERHMM_MAJOR = 3
FIBERHMM_REQUIREMENT = "fiberhmm[consensus]>=3.0.2,<4"
# What every build needs. Plugin packs add theirs in their manifest (plugins/packs.py, ARCHITECTURE.md):
#   "fiberhmm": {"features": [{"label": "...", "module": "fiberhmm.x.y",
#                              "names": ["function", ...],                       (optional: defined in that module)
#                              "schema": {"module": "fiberhmm.x.y.z", "name": "SCHEMA", "min": "prefix.v1"}}],
#                "min_version": "3.0"}                                             (optional)
CORE_REQUIREMENTS = {
    "min_version": "3.0",
    "features": [
        {"label": "FiberHMM 3.0 core (footprint classes)", "module": "fiberhmm.inference.consensus.workflow"},
        {"label": "FiberHMM 3.0 core (strand rescue)", "module": "fiberhmm.inference.strand_rescue"},
    ],
}
BROWSER_DIR = Path(__file__).resolve().parent.parent


def _valid_source_tree(path: str) -> Optional[Path]:
    """The folder when it holds a FiberHMM package (``fiberhmm/``), else None. What the package lacks is the
    capability check's business (a source run keeps such a tree; a packaged app falls back)."""
    resolved = Path(path).expanduser().resolve()
    pkg = resolved / "fiberhmm"
    if (pkg / "__init__.py").is_file() or (pkg / "inference" / "strand_rescue.py").is_file():
        return resolved
    return None


def _version_key(text: str) -> tuple:
    parts = []
    for chunk in str(text or "").lstrip("vV").split("."):
        digits = re.match(r"\d+", chunk)
        if not digits:
            break
        parts.append(int(digits.group()))
    return tuple(parts)


def required_features() -> list[dict]:
    """Core's requirements plus those of this build's plugin packs (read from their manifests, never imported)."""
    out = [dict(CORE_REQUIREMENTS)]
    try:
        manifests = sorted(BROWSER_DIR.glob("*/fiberbrowser-pack.json"))
    except OSError:
        manifests = []
    for manifest in manifests:
        try:
            data = json.loads(manifest.read_text())
        except (OSError, ValueError):
            continue
        req = data.get("fiberhmm") if isinstance(data, dict) else None
        if isinstance(req, dict):
            out.append({**req, "pack": data.get("label") or data.get("name")})
    return out


def _module_file(package_dir: Path, module: str) -> Optional[Path]:
    base = package_dir.parent
    stem = base.joinpath(*module.split("."))
    for candidate in (stem.with_suffix(".py"), stem / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


def _read(path: Path) -> str:
    try:
        return path.read_text(errors="replace")
    except OSError:
        return ""


def package_version(package_dir: Optional[Path]) -> Optional[str]:
    """``__version__`` of a FiberHMM package folder, read from its files."""
    if package_dir is None:
        return None
    for name in ("__init__.py", "_version.py", "version.py"):
        match = re.search(r"^__version__\s*=\s*['\"]([^'\"]+)['\"]", _read(package_dir / name), re.M)
        if match:
            return match.group(1)
    return None


def _schema_ok(found: str, minimum: str) -> bool:
    lead = re.match(r"(.*?)(\d+)$", minimum)
    have = re.match(r"(.*?)(\d+)$", found or "")
    if not lead or not have:
        return found == minimum
    return have.group(1) == lead.group(1) and int(have.group(2)) >= int(lead.group(2))


def missing_features(package_dir: Optional[Path], requirements: Optional[list] = None) -> list[str]:
    """The labels of the required features a FiberHMM package folder lacks (checked from its files)."""
    if package_dir is None or not (package_dir / "__init__.py").is_file():
        return ["FiberHMM itself"]
    missing: list[str] = []
    version = package_version(package_dir)
    for req in requirements if requirements is not None else required_features():
        minimum = req.get("min_version")
        if minimum and version and _version_key(version) < _version_key(minimum):
            label = f"FiberHMM {minimum} or newer"
            if label not in missing:
                missing.append(label)
        for feature in req.get("features") or []:
            label = str(feature.get("label") or feature.get("module"))
            path = _module_file(package_dir, str(feature.get("module") or ""))
            ok = path is not None
            if ok and feature.get("names"):
                text = _read(path)
                ok = all(re.search(rf"^(def|class)\s+{re.escape(n)}\b|^{re.escape(n)}\s*=", text, re.M)
                         for n in feature["names"])
            schema = feature.get("schema")
            if ok and isinstance(schema, dict):
                schema_file = _module_file(package_dir, str(schema.get("module") or feature.get("module")))
                name = re.escape(str(schema.get("name") or "SCHEMA"))
                match = re.search(rf"^{name}\s*=\s*['\"]([^'\"]+)['\"]", _read(schema_file) if schema_file else "", re.M)
                ok = bool(match) and _schema_ok(match.group(1), str(schema.get("min") or ""))
            if not ok and label not in missing:
                missing.append(label)
    return missing


def default_package_dir(exclude: Iterable[str] = ()) -> Optional[Path]:
    """The FiberHMM package this Python has without a source tree: the bundled one in a packaged app, the
    installed one elsewhere. Found without importing it (and never inside ``exclude``d source trees)."""
    skip = {str(Path(p).resolve()) for p in exclude if p}
    if _CONFIGURED_ROOT:
        skip.add(_CONFIGURED_ROOT)
    search = [p for p in sys.path if str(Path(p or ".").resolve()) not in skip]
    try:
        spec = importlib.machinery.PathFinder.find_spec("fiberhmm", search)
    except (ImportError, ValueError):
        spec = None
    if spec is not None and spec.origin and os.path.isfile(spec.origin):
        return Path(spec.origin).resolve().parent
    if spec is not None and spec.submodule_search_locations:
        return Path(list(spec.submodule_search_locations)[0]).resolve()
    return None


def _default_version(package_dir: Optional[Path]) -> Optional[str]:
    try:
        from importlib.metadata import version as dist_version
        if package_dir is not None and getattr(sys, "frozen", False):
            return dist_version("fiberhmm")
    except Exception:
        pass
    return package_version(package_dir)


def _app_choice() -> tuple:
    global _APP_CHOICE
    if _APP_CHOICE is None:
        from services import app_settings
        choice = app_settings.load()["fiberhmm"]
        _APP_CHOICE = (str(choice.get("source") or "bundled"), str(choice.get("custom_path") or ""))
    return _APP_CHOICE


def _join(labels: list) -> str:
    return labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " and " + labels[-1]


_SOURCE_NAMES = {"env": "FIBERHMM_SOURCE_DIR", "app": "the app's Settings", "settings": "browser_settings.json",
                 "bundled": "bundled with the app", "installed": "installed in this Python"}


def fiberhmm_selection() -> dict:
    """Which FiberHMM this process runs, why, and what it lacks (see the module's docstring).

    ``source``: ``env`` | ``app`` | ``settings`` (a source tree) or ``bundled`` | ``installed``; ``root``: the
    source tree put on ``sys.path`` (None: the bundled / installed package); ``notices``: one-line messages for
    the person (a fallback, missing features).
    """
    from services.app_build import is_packaged
    from services.user_settings import settings_file_fiberhmm_source_dir
    packaged = is_packaged()
    default_kind = "bundled" if packaged else "installed"
    env = os.environ.get("FIBERHMM_SOURCE_DIR") or ""
    if env:
        requested = ("env", env)
    elif packaged:
        source, custom = _app_choice()
        requested = ("app", custom) if source == "custom" and custom else ("bundled", "")
    else:
        from_file = settings_file_fiberhmm_source_dir()
        requested = ("settings", from_file) if from_file else ("installed", "")
    kind, raw = requested
    notices: list[str] = []
    root: Optional[Path] = None
    requirements = required_features()
    default_dir = default_package_dir()
    default_version = _default_version(default_dir)
    default_label = f"the {default_kind} FiberHMM" + (f" {default_version}" if default_version else "")
    if raw:
        root = _valid_source_tree(raw)
        if root is None:
            notices.append(f"Custom FiberHMM at {raw} ({_SOURCE_NAMES[kind]}) is not a FiberHMM source tree; "
                           f"using {default_label}.")
            kind = default_kind
    package_dir = (root / "fiberhmm") if root is not None else default_dir
    missing = missing_features(package_dir, requirements)
    if root is not None and missing and packaged:
        notices.append(f"Custom FiberHMM at {root} lacks {_join(missing)}; using {default_label}.")
        root, kind, package_dir = None, default_kind, default_dir
        missing = missing_features(package_dir, requirements)
    version = package_version(package_dir) if root is not None else default_version
    if missing and package_dir is not None and "FiberHMM itself" not in missing:
        where = "Custom FiberHMM" if root is not None else f"The {kind} FiberHMM"
        notices.append(f"{where}{' ' + version if version else ''} at {package_dir.parent if root is not None else package_dir} "
                       f"lacks {_join(missing)}; what needs it won't work.")
    choice = None
    if packaged:
        from services import app_settings
        stored = app_settings.load()["fiberhmm"]
        choice = {"source": stored.get("source"), "custom_path": stored.get("custom_path") or "",
                  "restart_needed": (str(stored.get("source")), str(stored.get("custom_path") or "")) != _app_choice()}
    return {
        "packaged": packaged,
        "requested": {"source": requested[0], "path": requested[1] or None},
        "source": kind,
        "source_label": _SOURCE_NAMES[kind],
        "root": str(root) if root is not None else None,
        "package_dir": str(package_dir) if package_dir is not None else None,
        "version": version,
        "bundled": {"path": str(default_dir) if default_dir else None, "version": default_version, "kind": default_kind},
        "requirements": [f.get("label") for r in requirements for f in r.get("features") or []],
        "missing": missing,
        "notices": notices,
        "app_choice": choice,
    }


def bundled_fiberhmm_root() -> Optional[Path]:
    """The FiberHMM source tree this process puts first on ``sys.path``, or None for the bundled / installed
    package (``fiberhmm_selection``; the name predates packaged apps: it is the *selected* source tree)."""
    root = fiberhmm_selection()["root"]
    return Path(root) if root else None


def fiberhmm_install_help(source: Optional[str] = None) -> str:
    """How to install a compatible FiberHMM into the Browser's own Python."""
    import shlex
    python = shlex.quote(sys.executable)
    command = f"{python} -m pip install --upgrade {shlex.quote(FIBERHMM_REQUIREMENT)}"
    text = (
        f"Install a compatible FiberHMM ({MIN_FIBERHMM_MAJOR}.x) with its consensus dependencies in the same Python "
        f"environment as FiberBrowser, then restart the Browser. Command: {command}."
    )
    if source:
        text += (
            f" For the FiberHMM source tree this Browser is configured to use: "
            f"{python} -m pip install --upgrade {shlex.quote(str(source) + '[consensus]')}."
        )
    return text


def _major(version: str) -> Optional[int]:
    try:
        return int(str(version).split(".")[0])
    except (TypeError, ValueError):
        return None


def describe_fiberhmm() -> dict:
    """Which FiberHMM this process imports: version, location, compatibility."""
    configure_fiberhmm_runtime()
    try:
        import fiberhmm
    except Exception as error:  # ImportError, or a broken install
        return {"available": False, "version": None, "path": None, "compatible": False,
                "error": f"{type(error).__name__}: {error}"}
    version = str(getattr(fiberhmm, "__version__", "") or "unknown")
    major = _major(version)
    path = str(Path(getattr(fiberhmm, "__file__", "") or "").parent) or None
    return {"available": True, "version": version, "path": path,
            "compatible": major is not None and major >= MIN_FIBERHMM_MAJOR, "error": None}


def fiberhmm_version() -> Optional[str]:
    """The imported FiberHMM's version string, or None when it isn't installed."""
    info = describe_fiberhmm()
    return info["version"] if info["available"] else None


def log_fiberhmm_runtime(printer=print) -> dict:
    """Print the FiberHMM version and location; warn when missing or too old."""
    info = describe_fiberhmm()
    if not info["available"]:
        printer(f"  FiberHMM: not installed ({info['error']}). Browsing works; footprint classes, "
                f"chemistry detection and BAM export need it. {fiberhmm_install_help()}")
    elif not info["compatible"]:
        printer(f"  WARNING: FiberHMM {info['version']} at {info['path']} is older than "
                f"{MIN_FIBERHMM_MAJOR}.0; footprint classes may fail or disagree with this Browser. "
                f"{fiberhmm_install_help()}")
    else:
        printer(f"  FiberHMM: {info['version']} ({info['path']})")
    try:
        selection = fiberhmm_selection()
    except Exception as error:  # never stop the server over the report
        printer(f"  WARNING: could not check which FiberHMM to use: {error}")
        return info
    for notice in selection["notices"]:
        printer(f"  NOTE: {notice}")
    info = {**info, "selection": selection}
    return info


def configure_fiberhmm_runtime(*, strict: bool = False) -> Optional[str]:
    """Prefer paired source; inference may require a non-shadowed runtime.

    Basic browsing can still start when an embedding process loaded a different
    package first. Inference must request ``strict=True`` and fail with a restart
    instruction rather than silently use that older package. Never hot-swap a
    partly imported Python package.
    """
    global _CONFIGURED_ROOT
    root = bundled_fiberhmm_root()
    if root is None:
        return _CONFIGURED_ROOT
    root_text = str(root)

    loaded = sys.modules.get("fiberhmm")
    loaded_path = Path(getattr(loaded, "__file__", "")).resolve() if loaded else None
    package_matches = loaded_path is None or loaded_path.parent == root / 'fiberhmm'
    if loaded_path and not package_matches:
        try:
            # Mounted case-insensitive filesystems can expose the same source
            # through differently cased paths. Compare directory identity, not
            # just the __init__ file (which might itself be a copied hardlink).
            package_matches = loaded_path.parent.samefile(root / 'fiberhmm')
        except OSError:
            pass
    if loaded_path and not package_matches:
        if strict:
            raise ValueError(
                f"FiberHMM runtime mismatch: loaded {str(loaded_path)!r}, expected source {root_text!r}. "
                "Restart FiberBrowser with FIBERHMM_SOURCE_DIR set before importing FiberHMM; "
                "do not mix an older installed or shadow package with the current caller."
            )
        return None

    sys.path[:] = [value for value in sys.path if str(Path(value or ".").resolve()) != root_text]
    sys.path.insert(0, root_text)
    importlib.invalidate_caches()
    _CONFIGURED_ROOT = root_text
    return _CONFIGURED_ROOT


