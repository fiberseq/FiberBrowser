"""The app's update check: is a newer FiberBrowser build out on this build's channel, and its download.

Channels follow the build's flavour (ARCHITECTURE.md). Each has a small JSON **update manifest**
(``tools/make_update_manifest.py`` writes it from the built files):

    {"schema": "fiberbrowser.update.v1", "channel": "lab", "version": "3.0.1", "build": "20261005.1432",
     "released": "2026-10-05", "notes": "short plain text", "notes_url": "https://...",
     "minimum_macos": "14.0",
     "downloads": {"macos-arm64": [{"kind": "dmg", "name": "FiberBrowser-3.0.1-arm64.dmg",
                                    "sha256": "...", "size": 190000000}, {"kind": "zip", ...}],
                   "windows-x64": [{"kind": "installer", "name": "FiberBrowser-3.0.1-Setup.exe", ...}]}}

A download names its file (``name``: a release asset, or a file next to the manifest) or gives a ``url``
(https, or relative to the manifest).

Where the manifest is, in order:

1. ``FIBERBROWSER_UPDATE_URL``, else the app setting (Settings > Updates > Manifest), else the build's
   ``update_manifest_url``: an https:// URL, a file:// URL or a path (a shared drive, a Dropbox-synced folder);
2. else the latest GitHub release of the channel's repository, the manifest being one of its assets: the public
   channel reads ``fiberseq/FiberBrowser`` without signing in; a plugin pack names its own channel in its
   manifest (``"update": {"repos": [...], "private": true, "manifest_asset": "..."}``; the first repository
   that answers is used). A private channel signs in to GitHub (services/github_auth.py).

Privacy: a check is a plain GET of the manifest (and of GitHub's release metadata); nothing about this computer,
its data or its use is sent. The quiet check at startup is on by default in a packaged app and off in a source run
or a pip install (services/app_settings.py default_check_at_startup); Settings > FiberHMM & Updates sets it for
every run. A check asked for (Check for Updates…) runs either way, and ``FIBERBROWSER_NO_UPDATE_CHECK=1`` turns
every check off.

An update is never installed by the app: it downloads the file the person asks for, checks its sha256 against
the manifest, and opens it (the DMG, the Windows installer).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Optional

from services import app_settings, github_auth
from services.github_auth import GitHubError, http_get, token_candidates

MANIFEST_SCHEMA = "fiberbrowser.update.v1"
PUBLIC_REPO = "fiberseq/FiberBrowser"
MAX_MANIFEST_BYTES = 1 << 20
MAX_DOWNLOAD_BYTES = 4 << 30
SUCCESS_TTL_S = 3600.0
FAILURE_TTL_S = 600.0
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
BROWSER_DIR = Path(__file__).resolve().parent.parent
PIP_COMMAND = 'pip install -U fiberbrowser "fiberhmm[consensus]>=3.0.2,<4"'


class UpdateError(Exception):
    status = "error"


class AuthRequired(UpdateError):
    status = "auth_required"


class AuthInvalid(UpdateError):
    status = "auth_invalid"


class NotPublished(UpdateError):
    status = "not_published"


# --- the channel ----------------------------------------------------------------------------------------------------

def _pack_channel() -> tuple[str, dict]:
    """(flavour, the pack's "update" settings) from the plugin pack manifests, read without importing them."""
    try:
        manifests = sorted(BROWSER_DIR.glob("*/fiberbrowser-pack.json"))
    except OSError:
        manifests = []
    for manifest in manifests:
        try:
            data = json.loads(manifest.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            update = data.get("update") if isinstance(data.get("update"), dict) else {}
            return str(data.get("flavor") or data.get("name") or manifest.parent.name), update
    return "public", {}


def current_version() -> str:
    from version import __version__
    return __version__


def channel_config() -> dict:
    """Where this build looks for updates (see the module's docstring)."""
    from services.app_build import build_info
    info = build_info() or {}
    flavor, pack = _pack_channel()
    channel = str(info.get("channel") or flavor)
    # The complete release can encounter build metadata copied from an older lab installation.
    if channel == "lab" and flavor == "public":
        channel = "public"
    settings = app_settings.load()["updates"]
    manifest_url, manifest_from = "", None
    for value, origin in ((os.environ.get("FIBERBROWSER_UPDATE_URL", ""), "FIBERBROWSER_UPDATE_URL"),
                          (settings.get("manifest_url", ""), "Settings"),
                          (info.get("update_manifest_url", ""), "the build")):
        if str(value or "").strip():
            manifest_url, manifest_from = str(value).strip(), origin
            break
    repo_override = str(os.environ.get("FIBERBROWSER_UPDATE_REPO") or settings.get("repo") or info.get("update_repo")
                        or "").strip()
    repos = [repo_override] if repo_override else [str(r) for r in pack.get("repos") or []] or [PUBLIC_REPO]
    return {
        "channel": channel,
        "source": "manifest" if manifest_url else "github",
        "manifest_url": manifest_url or None,
        "manifest_from": manifest_from,
        "repos": repos,
        "private": bool(pack.get("private")) and not manifest_url,
        "manifest_asset": str(pack.get("manifest_asset") or f"fiberbrowser-update-{channel}.json"),
    }


# --- versions and manifests -----------------------------------------------------------------------------------------

def version_key(text: str) -> tuple:
    """A comparable key: PEP 440 when ``packaging`` is there (3.0.1rc1 < 3.0.1 < 3.0.1.post1), else numbers."""
    text = str(text or "").strip().lstrip("vV")
    try:
        from packaging.version import Version
        return (1, Version(text))
    except Exception:
        parts = []
        for chunk in re.split(r"[.+-]", text):
            if not chunk.isdigit():
                break
            parts.append(int(chunk))
        return (0, tuple(parts))


def is_newer(remote: str, local: str, remote_build: str = "", local_build: str = "") -> bool:
    """A newer version; on the same version, a newer build (lab rebuilds often keep the version)."""
    r, l = version_key(remote), version_key(local)
    if r[0] != l[0]:
        r, l = (0, tuple(int(x) for x in re.findall(r"\d+", remote))), (0, tuple(int(x) for x in re.findall(r"\d+", local)))
    if r != l:
        return r > l
    if remote_build and local_build:
        return tuple(int(x) for x in re.findall(r"\d+", str(remote_build))) > \
            tuple(int(x) for x in re.findall(r"\d+", str(local_build)))
    return False


def parse_manifest(data) -> dict:
    """A manifest checked and normalised (UpdateError when it isn't one)."""
    if isinstance(data, (bytes, str)):
        try:
            data = json.loads(data)
        except ValueError as error:
            raise UpdateError(f"The update manifest isn't JSON ({error}).") from None
    if not isinstance(data, dict):
        raise UpdateError("The update manifest isn't a JSON object.")
    if data.get("schema") != MANIFEST_SCHEMA:
        raise UpdateError(f"Unknown update manifest schema {data.get('schema')!r} (expected {MANIFEST_SCHEMA}).")
    version = str(data.get("version") or "").strip()
    if not re.fullmatch(r"v?\d+(\.\d+)*([A-Za-z0-9.+-]*)", version):
        raise UpdateError(f"The update manifest's version {version!r} isn't a version.")
    notes_url = str(data.get("notes_url") or "").strip()
    if notes_url and urllib.parse.urlparse(notes_url).scheme != "https":
        notes_url = ""
    downloads: dict[str, list] = {}
    if not isinstance(data.get("downloads") or {}, dict):
        raise UpdateError("The update manifest's downloads aren't an object (platform: files).")
    for platform_key, entries in (data.get("downloads") or {}).items():
        if isinstance(entries, dict):
            entries = [entries]
        clean = []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or "").strip()
            sha = str(entry.get("sha256") or "").strip().lower()
            if not NAME_PATTERN.match(name) or ".." in name:
                raise UpdateError(f"A download in the update manifest has a bad file name: {name!r}.")
            if not SHA256_PATTERN.match(sha):
                raise UpdateError(f"The download {name} has no valid sha256 in the update manifest.")
            size = entry.get("size")
            clean.append({"kind": str(entry.get("kind") or Path(name).suffix.lstrip(".")), "name": name,
                          "sha256": sha, "size": int(size) if isinstance(size, int) and size > 0 else None,
                          "url": str(entry.get("url") or "").strip() or None})
        if clean:
            downloads[str(platform_key)] = clean
    return {"schema": MANIFEST_SCHEMA, "channel": str(data.get("channel") or ""), "version": version.lstrip("vV"),
            "build": str(data.get("build") or ""), "released": str(data.get("released") or ""),
            "notes": str(data.get("notes") or "")[:4000], "notes_url": notes_url or None,
            "minimum_macos": str(data.get("minimum_macos") or "") or None, "downloads": downloads}


PREFERRED_KINDS = {"macos": ("dmg", "zip"), "windows": ("installer", "exe", "zip")}


def pick_download(manifest: dict, platform_key: str) -> Optional[dict]:
    entries = manifest["downloads"].get(platform_key) or []
    order = PREFERRED_KINDS.get(platform_key.split("-")[0], ())
    ranked = sorted(entries, key=lambda e: order.index(e["kind"]) if e["kind"] in order else len(order))
    return ranked[0] if ranked else None


def macos_too_old(minimum: Optional[str]) -> Optional[str]:
    """The running macOS when it is older than ``minimum`` (None: fine, or not a Mac)."""
    if not minimum or sys.platform != "darwin":
        return None
    import platform
    running = platform.mac_ver()[0]
    if running and version_key(running)[1:] < version_key(minimum)[1:]:
        return running
    return None


# --- fetching -------------------------------------------------------------------------------------------------------

def _read_limited(response, limit: int) -> bytes:
    data = response.read(limit + 1)
    response.close()
    if len(data) > limit:
        raise UpdateError("The update manifest is too large.")
    return data


def _local_path(url: str) -> Optional[Path]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "file":
        return Path(urllib.parse.unquote(parsed.path))
    if not parsed.scheme or (len(parsed.scheme) == 1 and url[1:3] in (":\\", ":/")):
        return Path(url).expanduser()
    return None


def _fetch_manifest_url(url: str) -> tuple[dict, dict]:
    local = _local_path(url)
    if local is not None:
        try:
            if local.stat().st_size > MAX_MANIFEST_BYTES:
                raise UpdateError("The update manifest is too large.")
            data = local.read_bytes()
        except OSError as error:
            raise UpdateError(f"Can't read the update manifest at {local} ({error.strerror or error}).") from None
        return parse_manifest(data), {"kind": "file", "base": str(local.parent), "where": str(local)}
    if urllib.parse.urlparse(url).scheme != "https":
        raise UpdateError("The update manifest must be an https:// or file:// address.")
    try:
        response = http_get(url, accept="application/json")
        final = getattr(response, "geturl", lambda: url)() or url  # after redirects: relative files resolve here
        data = _read_limited(response, MAX_MANIFEST_BYTES)
    except GitHubError as error:
        raise UpdateError(f"Couldn't read the update manifest ({error}).") from None
    return parse_manifest(data), {"kind": "https", "base": final, "where": url}


def _fetch_github(config: dict) -> tuple[dict, dict]:
    asset_name = config["manifest_asset"]
    tokens: list = [("none", None)]
    if config["private"]:
        tokens = token_candidates()
        if not tokens:
            raise AuthRequired(
                f"Sign in to check for {config['channel']} updates: sign in with the GitHub CLI (gh auth login) "
                "or add a read-only GitHub token in Settings > Updates.")
    refused: list[str] = []
    not_found: list[str] = []
    for repo in config["repos"]:
        for source, token in tokens:
            try:
                response = http_get(f"https://api.github.com/repos/{repo}/releases/latest", token=token,
                                    accept="application/vnd.github+json")
                release = json.loads(_read_limited(response, MAX_MANIFEST_BYTES * 4))
            except GitHubError as error:
                if error.status == 401 or (error.status == 403 and token is not None):
                    refused.append(source)  # refused or not allowed: the next sign-in may be
                    continue
                if error.status == 404:
                    not_found.append(repo)
                    continue
                if error.status == 403 and token is None:
                    raise UpdateError(f"GitHub refused the check ({error}); try again later.") from None
                raise UpdateError(f"Couldn't check {repo} ({error}).") from None
            except ValueError:
                raise UpdateError(f"GitHub's answer for {repo} isn't JSON.") from None
            assets = {a.get("name"): a for a in release.get("assets") or [] if isinstance(a, dict)}
            asset = assets.get(asset_name)
            if not asset or not asset.get("url"):
                raise UpdateError(f"The latest release of {repo} ({release.get('tag_name')}) has no {asset_name}.")
            try:
                data = _read_limited(http_get(asset["url"], token=token, accept="application/octet-stream"),
                                     MAX_MANIFEST_BYTES)
            except GitHubError as error:
                raise UpdateError(f"Couldn't download {asset_name} from {repo} ({error}).") from None
            manifest = parse_manifest(data)
            origin = {"kind": "github", "repo": repo, "tag": release.get("tag_name"), "token_source": source,
                      "release_url": release.get("html_url"), "where": f"{repo} ({release.get('tag_name')})",
                      "assets": {name: a.get("url") for name, a in assets.items() if a.get("url")}}
            return manifest, origin
    if refused and config["private"]:
        raise AuthInvalid(f"GitHub refused the sign-in ({', '.join(dict.fromkeys(refused))}); sign in again "
                          "(gh auth login) or replace the token in Settings > Updates.")
    if config["private"]:
        raise AuthRequired(f"Sign in to check for {config['channel']} updates: the GitHub account "
                           f"({', '.join(dict.fromkeys(s for s, _ in tokens))}) can't see a release in "
                           f"{' or '.join(config['repos'])}.")
    raise NotPublished(f"No release has been published at {' or '.join(config['repos'])} yet.")


def fetch_manifest(config: dict) -> tuple[dict, dict]:
    if config["source"] == "manifest":
        return _fetch_manifest_url(config["manifest_url"])
    return _fetch_github(config)


# --- the check ------------------------------------------------------------------------------------------------------

_lock = threading.Lock()
_last: Optional[dict] = None
_last_at = 0.0
# What a download needs that the page never sees (asset URLs, which token source).
_last_private: dict = {}


def disabled_reason() -> Optional[str]:
    if str(os.environ.get("FIBERBROWSER_NO_UPDATE_CHECK", "")).strip().lower() in ("1", "true", "yes", "on"):
        return "Update checks are turned off (FIBERBROWSER_NO_UPDATE_CHECK)."
    return None


def _base() -> dict:
    from services.app_build import build_info, is_packaged, platform_key
    info = build_info() or {}
    config = channel_config()
    return {"current": current_version(), "build": info.get("build") or None, "channel": config["channel"],
            "packaged": is_packaged(), "platform": platform_key(), "source": config["source"],
            "where": config["manifest_url"] or " or ".join(config["repos"]), "private": config["private"],
            "check_at_startup": bool(app_settings.load()["updates"]["check_at_startup"])}


def check(*, startup: bool = False, force: bool = False) -> dict:
    """The update status: ``status`` is update_available | up_to_date | disabled | auth_required | auth_invalid |
    not_published | error. ``startup``: the quiet check at startup (nothing when it is turned off)."""
    global _last, _last_at, _last_private
    base = _base()
    reason = disabled_reason()
    if reason or (startup and not base["check_at_startup"]):
        return {**base, "status": "disabled", "message": reason or "The check at startup is turned off."}
    with _lock:
        now = time.monotonic()
        if not force and _last is not None and _last.get("where") == base["where"]:
            ttl = SUCCESS_TTL_S if _last["status"] in ("update_available", "up_to_date") else FAILURE_TTL_S
            if now - _last_at < ttl:
                return {**_last, "check_at_startup": base["check_at_startup"], "cached": True}
        if force:
            # Asked for (Check for Updates..., Try again after `gh auth login`): ask the GitHub CLI again rather
            # than reuse its cached answer (github_auth.gh_token caches a minute).
            github_auth.reset_gh_cache()
        result, private = _check_now(base)
        _last, _last_at, _last_private = result, now, private
        return result


def _check_now(base: dict) -> tuple[dict, dict]:
    config = channel_config()
    try:
        manifest, origin = fetch_manifest(config)
    except UpdateError as error:
        return {**base, "status": error.status, "message": str(error), "checked_at": time.time()}, {}
    if manifest["channel"] and manifest["channel"] != config["channel"]:
        return {**base, "status": "error", "checked_at": time.time(),
                "message": f"The update manifest at {origin.get('where')} is for the {manifest['channel']} channel, "
                           f"not this build's ({config['channel']})."}, {}
    newer = is_newer(manifest["version"], base["current"], manifest["build"], base["build"] or "")
    result = {**base, "checked_at": time.time(), "latest": manifest["version"], "latest_build": manifest["build"] or None,
              "released": manifest["released"] or None, "notes": manifest["notes"] or None,
              "notes_url": manifest["notes_url"] or origin.get("release_url"), "from": origin.get("where"),
              "token_source": origin.get("token_source") if origin.get("token_source") != "none" else None,
              "status": "update_available" if newer else "up_to_date", "download": None, "message": None}
    if not newer:
        return result, {}
    if not base["packaged"]:
        result["message"] = f"FiberBrowser {manifest['version']} is out. Update with: {PIP_COMMAND}"
        result["pip_command"] = PIP_COMMAND
        return result, {}
    entry = pick_download(manifest, base["platform"])
    old_macos = macos_too_old(manifest.get("minimum_macos"))
    if entry is None:
        result["message"] = f"FiberBrowser {manifest['version']} has no download for {base['platform']}."
        return result, {}
    if old_macos:
        result["message"] = (f"FiberBrowser {manifest['version']} needs macOS {manifest['minimum_macos']} or newer "
                             f"(this Mac has {old_macos}).")
        return result, {}
    result["download"] = {"name": entry["name"], "kind": entry["kind"], "size": entry["size"],
                          "sha256": entry["sha256"]}
    return result, {"entry": entry, "origin": origin, "version": manifest["version"]}


# --- download, verify, open -----------------------------------------------------------------------------------------

_job_lock = threading.Lock()
_job: dict = {"state": "idle"}
_cancel = threading.Event()


def downloads_dir() -> Path:
    """Where downloads go: the Downloads folder (Windows' own, from the WSL distribution)."""
    try:
        from services.wsl_interop import is_wsl, to_wsl_path, windows_program
        if is_wsl():
            ps = windows_program("powershell.exe")
            if ps:
                done = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command",
                                       "[Environment]::GetFolderPath('UserProfile')"], capture_output=True,
                                      text=True, timeout=20, stdin=subprocess.DEVNULL)
                profile = done.stdout.strip()
                if done.returncode == 0 and profile:
                    return Path(to_wsl_path(profile, True)) / "Downloads"
    except Exception:
        pass
    return Path.home() / "Downloads"


def download_status() -> dict:
    with _job_lock:
        return dict(_job)


def _open_source(entry: dict, origin: dict):
    """(response or local file, needs_close) for one download entry."""
    if origin["kind"] == "github":
        url = entry.get("url") or origin["assets"].get(entry["name"])
        if not url:
            raise UpdateError(f"The release has no {entry['name']}.")
        token = None
        if origin.get("token_source") not in (None, "none"):
            token = next((t for s, t in token_candidates() if s == origin["token_source"]), None)
        accept = "application/octet-stream" if "api.github.com" in url else None
        return http_get(url, token=token, accept=accept, timeout=60)
    if origin["kind"] == "file":
        rel = entry.get("url") or entry["name"]
        local = _local_path(rel)
        path = local if local is not None and local.is_absolute() else Path(origin["base"]) / rel
        return open(path, "rb")
    url = urllib.parse.urljoin(origin["base"], entry.get("url") or entry["name"])
    return http_get(url, timeout=60)


def start_download() -> dict:
    """Download the last check's file for this platform, in the background (download_status follows it)."""
    global _job
    with _lock:
        private = dict(_last_private)
    if not private.get("entry"):
        raise UpdateError("Check for updates first: there is no download to fetch.")
    with _job_lock:
        if _job.get("state") in ("downloading", "verifying"):
            return dict(_job)
        entry = private["entry"]
        target = downloads_dir() / entry["name"]
        _cancel.clear()
        _job = {"state": "downloading", "name": entry["name"], "version": private["version"], "received": 0,
                "total": entry.get("size"), "path": None, "error": None, "sha256": entry["sha256"]}
    threading.Thread(target=_download, args=(entry, private["origin"], target), name="fiberbrowser-update-download",
                     daemon=True).start()
    return download_status()


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _set(**values) -> None:
    with _job_lock:
        _job.update(values)


def _download(entry: dict, origin: dict, target: Path) -> None:
    part = target.with_name(target.name + ".part")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and sha256_of(target) == entry["sha256"]:
            _set(state="done", path=str(target), received=target.stat().st_size, total=target.stat().st_size)
            return
        limit = entry.get("size") or MAX_DOWNLOAD_BYTES
        digest = hashlib.sha256()
        received = 0
        source = _open_source(entry, origin)
        try:
            with open(part, "wb") as out:
                while True:
                    if _cancel.is_set():
                        raise UpdateError("Cancelled.")
                    block = source.read(1 << 20)
                    if not block:
                        break
                    received += len(block)
                    if received > limit:
                        raise UpdateError(f"{entry['name']} is larger than the update manifest says.")
                    digest.update(block)
                    out.write(block)
                    _set(received=received)
        finally:
            source.close()
        _set(state="verifying")
        if digest.hexdigest() != entry["sha256"]:
            raise UpdateError(f"{entry['name']} failed its checksum (sha256 differs from the update manifest); "
                              "it was deleted.")
        os.replace(part, target)
        _set(state="done", path=str(target))
    except (UpdateError, GitHubError, OSError) as error:
        try:
            part.unlink()
        except OSError:
            pass
        _set(state="cancelled" if _cancel.is_set() else "error", error=str(error))


def cancel_download() -> dict:
    _cancel.set()
    return download_status()


def open_download() -> dict:
    """Open the downloaded, verified file (the DMG mounts, the installer starts). Checked again first."""
    job = download_status()
    if job.get("state") != "done" or not job.get("path"):
        raise UpdateError("There is no finished download to open.")
    path = Path(job["path"])
    if not job.get("sha256") or not path.is_file() or sha256_of(path) != job["sha256"]:
        raise UpdateError(f"{path.name} changed since it was checked; download it again.")
    argv = open_argv(path)
    if argv is None:
        raise UpdateError(f"Open {path} yourself to install the update.")
    subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return {"opened": str(path)}


def open_argv(path: Path) -> Optional[list]:
    if sys.platform == "darwin":
        return ["/usr/bin/open", str(path)]
    try:
        from services.wsl_interop import is_wsl, to_windows_path, windows_program
        if is_wsl():
            explorer = windows_program("explorer.exe")
            target = to_windows_path(str(path))
            return [explorer, target] if explorer and target else None
    except Exception:
        pass
    opener = shutil.which("xdg-open")
    return [opener, str(path)] if opener else None


def forget_check() -> None:
    """Forget the cached check (its settings or sign-in changed); a download in progress goes on."""
    global _last, _last_at, _last_private
    with _lock:
        _last, _last_at, _last_private = None, 0.0, {}


def reset() -> None:
    """Forget the cached check and a finished download (tests). A download in progress is cancelled first."""
    global _job
    forget_check()
    _cancel.set()
    with _job_lock:
        if _job.get("state") not in ("downloading", "verifying"):
            _job = {"state": "idle"}
