"""Independent, dependency-free FiberHMM wheel overlays outside the signed app.

Only explicit owner actions write files/settings. Checks share the app update
preferences and TTLs; failures are logged and silent in the UI.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from email.parser import BytesParser
from importlib import metadata
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from urllib.request import urlopen

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import InvalidVersion, Version

from services import app_build, app_settings, app_update
from services import fiberhmm_runtime as runtime

PYPI_JSON_URL = "https://pypi.org/pypi/fiberhmm/json"
log = logging.getLogger(__name__)
_lock = threading.Lock()
_last: dict | None = None
_last_at = 0.0
_offer: dict | None = None
_job = {"state": "idle"}
MAX_WHEEL = 128 << 20


class UpdateError(ValueError):
    pass


def minimum_version() -> str:
    return str((app_build.build_info() or {}).get("fiberhmm_min_version") or "3.0.3")


def pip_command() -> str:
    return f'pip install -U "fiberhmm[consensus]>={minimum_version()},<4"'


def supported(version: str) -> bool:
    try:
        v = Version(version)
        return not v.is_prerelease and not v.is_devrelease and Version(minimum_version()) <= v < Version("4")
    except InvalidVersion:
        return False


def overlays_dir() -> Path:
    return app_settings.settings_path().parent / "fiberhmm"


def overlay_site(version: str) -> Path:
    if not supported(version) or str(Version(version)) != version or not re.fullmatch(r"[A-Za-z0-9.+!-]+", version):
        raise UpdateError("Unsupported FiberHMM overlay version.")
    return overlays_dir() / version / "site"


def _url_ok(url: str) -> bool:
    parsed = urlparse(url)
    # Loopback HTTP is for offline tests; release downloads must use TLS.
    return parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1"))


def _read_url(url: str, limit: int) -> bytes:
    if not _url_ok(url):
        raise UpdateError("The FiberHMM download must use HTTPS.")
    with urlopen(url, timeout=8) as response:
        if not _url_ok(response.geturl()):
            raise UpdateError("Unsafe FiberHMM download redirect.")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("FiberHMM download exceeds its size limit.")
    return data


def select_release(data: dict) -> dict | None:
    candidates = []
    for version, files in data.get("releases", {}).items():
        if not supported(version):
            continue
        for entry in files:
            if entry.get("yanked") or entry.get("packagetype") != "bdist_wheel":
                continue
            try:
                name, wheel_version, _, tags = parse_wheel_filename(entry.get("filename", ""))
            except ValueError:
                continue
            digest = entry.get("digests", {}).get("sha256", "")
            if (name != "fiberhmm" or wheel_version != Version(version) or
                    not any(str(tag) == "py3-none-any" for tag in tags) or
                    not re.fullmatch(r"[a-fA-F0-9]{64}", digest) or not _url_ok(entry.get("url", ""))):
                continue
            candidates.append({"version": str(wheel_version), "url": entry["url"], "sha256": digest.lower(),
                               "filename": entry["filename"]})
    return max(candidates, key=lambda e: Version(e["version"])) if candidates else None


def check(*, startup=False, force=False) -> dict:
    global _last, _last_at, _offer
    selection = runtime.fiberhmm_selection()
    base = {"current": selection["version"], "packaged": app_build.is_packaged(), "pip_command": pip_command(),
            "blocked": bool(os.environ.get("FIBERHMM_SOURCE_DIR") or
                            app_settings.load()["fiberhmm"]["source"] == "custom")}
    if app_update.disabled_reason() or (startup and not app_settings.load()["updates"]["check_at_startup"]):
        return {**base, "status": "disabled"}
    with _lock:
        now = time.monotonic()
        ttl = app_update.FAILURE_TTL_S if _last and _last["status"] == "unavailable" else app_update.SUCCESS_TTL_S
        if not force and _last and now - _last_at < ttl:
            return {**_last, **base}
        try:
            candidate = select_release(json.loads(_read_url(PYPI_JSON_URL, 8 << 20)))
            current = Version(base["current"] or "0")
            available = candidate is not None and Version(candidate["version"]) > current
            _offer = candidate if available else None
            result = {**base, "status": "update_available" if available else "up_to_date"}
            if available:
                result["latest"] = candidate["version"]
        except Exception as error:
            log.warning("FiberHMM update check failed: %s", error)
            result = {**base, "status": "unavailable"}
            _offer = None
        _last, _last_at = result, now
        return dict(result)


def _allow_changes() -> None:
    if not app_build.is_packaged():
        raise UpdateError(pip_command())
    if os.environ.get("FIBERHMM_SOURCE_DIR") or app_settings.load()["fiberhmm"]["source"] == "custom":
        raise UpdateError("FIBERHMM_SOURCE_DIR or Custom path is set; that FiberHMM takes precedence.")


def bundled_versions() -> dict[str, str]:
    """Ignore overlay distribution metadata, even after this process selected one."""
    root = overlays_dir().resolve()
    paths = [p for p in sys.path if not Path(p or ".").resolve().is_relative_to(root)]
    installed = {}
    for distribution in metadata.distributions(path=paths):
        name = distribution.metadata.get("Name")
        if name:
            installed.setdefault(canonicalize_name(name), distribution.version)
    return installed


def unmet_requirements(info) -> list[str]:
    installed = bundled_versions()
    missing = []
    for text in info.get_all("Requires-Dist", []):
        req = Requirement(text)
        if req.marker and not any(req.marker.evaluate({"extra": extra}) for extra in ("", "consensus")):
            continue
        version = installed.get(canonicalize_name(req.name))
        if req.url or version is None or not req.specifier.contains(version, prereleases=True):
            missing.append(text)
    requires_python = info.get("Requires-Python")
    if requires_python:
        from packaging.specifiers import SpecifierSet
        if not SpecifierSet(requires_python).contains(".".join(map(str, sys.version_info[:3]))):
            missing.append("Python " + requires_python)
    return missing


def _unpack(data: bytes, site: Path, version: str):
    """Install only FiberHMM's pure wheel contents, with no pip or dependencies."""
    with zipfile.ZipFile(io.BytesIO(data)) as wheel:
        entries = wheel.infolist()
        metadata_entries = [e for e in entries if re.fullmatch(r"fiberhmm-[^/]+\.dist-info/METADATA", e.filename)]
        if len(metadata_entries) != 1:
            raise UpdateError("The wheel has no unique FiberHMM METADATA.")
        info = BytesParser().parsebytes(wheel.read(metadata_entries[0]))
        if canonicalize_name(info.get("Name", "")) != "fiberhmm" or Version(info.get("Version", "0")) != Version(version):
            raise UpdateError("The wheel's identity does not match the release.")
        wheel_info = BytesParser().parsebytes(wheel.read(metadata_entries[0].filename.replace("METADATA", "WHEEL")))
        if wheel_info.get("Root-Is-Purelib", "").lower() != "true" or "py3-none-any" not in wheel_info.get_all("Tag", []):
            raise UpdateError("FiberHMM must be a py3-none-any pure Python wheel.")
        if sum(e.file_size for e in entries) > 512 << 20:
            raise UpdateError("The FiberHMM wheel expands beyond its size limit.")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if (not path.parts or path.is_absolute() or ".." in path.parts or "\\" in entry.filename or
                    stat.S_ISLNK(entry.external_attr >> 16) or
                    path.parts[0] not in ("fiberhmm", metadata_entries[0].filename.split("/")[0])):
                raise UpdateError("The FiberHMM wheel contains an unsafe path.")
        missing = unmet_requirements(info)
        if missing:
            raise UpdateError(f"FiberHMM {version} needs a newer FiberBrowser app; update the app")
        wheel.extractall(site)


def status() -> dict:
    with _lock:
        return dict(_job)


def start_install() -> dict:
    _allow_changes()
    with _lock:
        if _job["state"] == "installing":
            return dict(_job)
        if not _offer:
            raise UpdateError("Check for a newer FiberHMM first.")
        offer = dict(_offer)
        _job.clear()
        _job.update(state="installing", version=offer["version"])
        threading.Thread(target=_install, args=(offer,), daemon=True, name="fiberhmm-update").start()
        return dict(_job)


def _install(offer: dict) -> None:
    version = offer["version"]
    stage = None
    try:
        data = _read_url(offer["url"], MAX_WHEEL)
        if hashlib.sha256(data).hexdigest() != offer["sha256"]:
            raise UpdateError("FiberHMM SHA-256 mismatch; download rejected.")
        target = overlay_site(version).parent
        target.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=target.parent))
        site = stage / "site"
        _unpack(data, site, version)
        error = runtime.check_overlay(site, version)
        if error:
            raise UpdateError(f"FiberHMM compatibility check failed: {error}")
        # Recheck overrides after the download, immediately before activation.
        with _lock:
            _allow_changes()
            if target.exists():
                error = runtime.check_overlay(target / "site", version)
                if error:
                    active = runtime.fiberhmm_selection()
                    if active['source'] == 'updated' and runtime._app_choice()[2] == version:
                        raise UpdateError("Use bundled FiberHMM and restart before repairing this overlay.")
                    # Keep the damaged copy until its verified replacement is
                    # installed. A failed rename restores it without touching
                    # the user's selection or any running overlay.
                    damaged = stage.with_name(stage.name + '.broken')
                    os.replace(target, damaged)
                    try:
                        os.replace(stage, target)
                    except Exception:
                        os.replace(damaged, target)
                        raise
                    stage = None
                    shutil.rmtree(damaged, ignore_errors=True)
            else:
                os.replace(stage, target)
                stage = None
            previous = app_settings.load()["fiberhmm"].get("overlay_version", "")
            running = runtime._APP_CHOICE
            if running and running[0] == "updated" and running[2] != version:
                previous = running[2]
            app_settings.update("fiberhmm", {"source": "updated", "overlay_version": version,
                                             "previous_overlay_version": previous if previous != version else
                                             app_settings.load()["fiberhmm"].get("previous_overlay_version", "")})
            prune()
            outcome = dict(state="ready", version=version, message="FiberHMM update saved. Restart FiberBrowser to use it.")
    except Exception as error:
        log.warning("FiberHMM update rejected: %s", error)
        outcome = dict(state="needs_app_update" if "needs a newer FiberBrowser" in str(error) else "error",
                       version=version, message=str(error))
    finally:
        if stage:
            shutil.rmtree(stage, ignore_errors=True)
        with _lock:
            _job.update(outcome)


def prune() -> None:
    choice = app_settings.load()["fiberhmm"]
    keep = {choice.get("overlay_version"), choice.get("previous_overlay_version")}
    # A running process still uses its previous selection until restart.
    if runtime._APP_CHOICE and runtime._APP_CHOICE[0] == "updated" and len(runtime._APP_CHOICE) > 2:
        keep.add(runtime._APP_CHOICE[2])
    try:
        folders = list(overlays_dir().iterdir()) if overlays_dir().is_dir() else []
    except OSError as error:
        log.warning("Could not list FiberHMM overlays: %s", error)
        return
    for folder in folders:
        if folder.name not in keep and supported(folder.name) and folder.is_dir() and not folder.is_symlink():
            try:
                shutil.rmtree(folder)
            except OSError as error:
                log.warning("Could not prune FiberHMM overlay %s: %s", folder.name, error)


def revert() -> dict:
    _allow_changes()
    with _lock:
        if _job["state"] == "installing":
            raise UpdateError("Wait for the FiberHMM installation to finish.")
        choice = app_settings.load()["fiberhmm"]
        app_settings.update("fiberhmm", {"source": "bundled", "overlay_version": "",
                                         "previous_overlay_version": choice.get("overlay_version") or
                                         choice.get("previous_overlay_version", "")})
        prune()
        _job.clear()
        _job.update(state="ready", message="Bundled FiberHMM selected. Restart FiberBrowser to use it.")
        return dict(_job)


def restart() -> dict:
    _allow_changes()
    from services.app_install import launch_restart
    with _lock:
        if _job["state"] == "restarting":
            return dict(_job)
        if _job["state"] == "installing":
            raise UpdateError("Wait for the FiberHMM installation to finish.")
        try:
            launch_restart()
        except Exception as error:
            raise UpdateError(str(error)) from error
        _job.update(state="restarting")
        return dict(_job)


def reset() -> None:
    global _last, _last_at, _offer
    _last, _last_at, _offer = None, 0.0, None
    _job.clear()
    _job.update(state="idle")
