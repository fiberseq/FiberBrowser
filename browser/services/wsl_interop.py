"""Windows integration for a server running inside WSL.

On Windows, FiberBrowser runs in its own WSL distribution ("FiberBrowser",
packaging/windows/) and shows its pages in an Edge app window. These helpers
do what the Mac app does natively, through WSL's Windows interop:

- the Windows programs FiberBrowser runs (powershell.exe for the open
  dialogs, explorer.exe for "Show in Explorer", cmd.exe/wsl.exe for a sign-in
  console), found on PATH or, when the distribution doesn't append the
  Windows PATH, at their usual place on the Windows drive;
- path translation both ways: ``C:\\...``, ``\\\\server\\share\\...`` and
  ``\\\\wsl$\\<distro>\\...`` / ``\\\\wsl.localhost\\<distro>\\...`` to the path
  this server opens (``wslpath``, with fallbacks), and a Linux path to the
  Windows one Explorer shows;
- the note for large files on a Windows drive (``/mnt/c``), which WSL reads
  through its Windows-file bridge, much more slowly than its own disk.

Everything here is a no-op answer (None, the input unchanged) outside WSL.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Optional

WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:([\\/]|$)")
UNC_RE = re.compile(r"^(?:\\\\|//)[^\\/]+[\\/][^\\/]+")
# \\wsl$\Distro\rest, \\wsl.localhost\Distro\rest (either slash style).
WSL_UNC_RE = re.compile(r"^(?:\\\\|//)(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$", re.IGNORECASE)
# A drvfs mount of a Windows drive: /mnt/c, /mnt/d/...
DRVFS_RE = re.compile(r"^/mnt/([A-Za-z])(/|$)")
# file:///C:/... after the scheme is dropped.
SLASHED_DRIVE_RE = re.compile(r"^/[A-Za-z]:[\\/]")

# Where the Windows programs live, relative to the Windows drive's mount.
WINDOWS_PROGRAMS = {
    "powershell.exe": "Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "explorer.exe": "Windows/explorer.exe",
    "cmd.exe": "Windows/System32/cmd.exe",
    "wsl.exe": "Windows/System32/wsl.exe",
}

# Files at least this large on a Windows drive get the "slower there" note.
SLOW_MOUNT_NOTE_BYTES = 1 << 30

_TIMEOUT_S = 10


def is_wsl() -> bool:
    """True when this process runs under Windows Subsystem for Linux."""
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"):
        return True
    try:
        with open("/proc/version", "r", encoding="utf-8") as handle:
            return "microsoft" in handle.read().lower()
    except Exception:
        return False


def distro_name() -> str:
    """This WSL distribution's name (FiberBrowser in the Windows app), or ''."""
    return os.environ.get("WSL_DISTRO_NAME", "")


def _windows_mounts() -> list[str]:
    """Mounted Windows drives (/mnt/c first)."""
    try:
        letters = sorted(name for name in os.listdir("/mnt") if len(name) == 1 and name.isalpha())
    except OSError:
        return []
    letters.sort(key=lambda letter: (letter.lower() != "c", letter))
    return [f"/mnt/{letter}" for letter in letters]


def windows_program(name: str) -> Optional[str]:
    """The path of a Windows program (``powershell.exe``, ``explorer.exe``...), or None."""
    found = shutil.which(name)
    if found:
        return found
    relative = WINDOWS_PROGRAMS.get(name.lower())
    if not relative or not is_wsl():
        return None
    for mount in _windows_mounts():
        candidate = os.path.join(mount, relative)
        if os.path.isfile(candidate):
            return candidate
    return None


def _wslpath(flag: str, value: str) -> Optional[str]:
    try:
        result = subprocess.run(["wslpath", flag, value], capture_output=True, text=True, timeout=_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError):
        return None
    converted = (result.stdout or "").strip()
    return converted if result.returncode == 0 and converted else None


def is_windows_drive_path(path: str) -> bool:
    return bool(WINDOWS_DRIVE_RE.match(path or ""))


def is_unc_path(path: str) -> bool:
    return bool(UNC_RE.match(path or ""))


def is_windows_path(path: str) -> bool:
    return is_windows_drive_path(path) or is_unc_path(path) or bool(SLASHED_DRIVE_RE.match(path or ""))


def wsl_unc_parts(path: str) -> Optional[tuple[str, str]]:
    """(distribution, path inside it) of a ``\\\\wsl$\\...`` / ``\\\\wsl.localhost\\...`` path."""
    match = WSL_UNC_RE.match(path or "")
    if not match:
        return None
    rest = (match.group(2) or "").replace("\\", "/").strip("/")
    return match.group(1), "/" + rest


def other_distro(path: str) -> Optional[str]:
    """The distribution a ``\\\\wsl$\\<distro>\\...`` path points into when it isn't this one."""
    parts = wsl_unc_parts(path)
    if not parts:
        return None
    here = distro_name()
    return parts[0] if here and parts[0].lower() != here.lower() else None


def to_wsl_path(path: str, wsl: Optional[bool] = None) -> str:
    """The path this server opens for a Windows path (unchanged when not one, or outside WSL).

    ``C:\\data\\a.bam`` -> ``/mnt/c/data/a.bam``; ``\\\\wsl.localhost\\<this distro>\\home\\x``
    -> ``/home/x``. A path into another distribution, or a network share that
    isn't mounted in WSL, is returned as wslpath gives it (or unchanged); the
    caller's not-found message explains (see ``local_paths.path_access_error``).
    ``wsl``: whether this runs in WSL (default: ``is_wsl()``).
    """
    value = path or ""
    if not (is_wsl() if wsl is None else wsl) or not is_windows_path(value):
        return value
    if SLASHED_DRIVE_RE.match(value):  # from file:///C:/...
        value = value[1:]
    parts = wsl_unc_parts(value)
    if parts and not other_distro(value):
        return parts[1]  # this distribution's own files
    converted = _wslpath("-u", value)
    if converted:
        return converted
    if is_windows_drive_path(value):
        rest = value[2:].lstrip("\\/").replace("\\", "/")
        return f"/mnt/{value[0].lower()}/{rest}" if rest else f"/mnt/{value[0].lower()}"
    return value


def to_windows_path(path: str) -> Optional[str]:
    """The Windows path of a file this server sees (``C:\\...`` or ``\\\\wsl.localhost\\...``), or None."""
    if not is_wsl() or not path:
        return None
    absolute = os.path.abspath(path)
    converted = _wslpath("-w", absolute)
    if converted:
        return converted
    match = DRVFS_RE.match(absolute)
    if match:
        rest = absolute[len("/mnt/x"):].lstrip("/").replace("/", "\\")
        return f"{match.group(1).upper()}:\\{rest}"
    name = distro_name()
    if name:
        return f"\\\\wsl.localhost\\{name}" + absolute.replace("/", "\\")
    return None


def reveal_argv(path: str) -> Optional[list[str]]:
    """Explorer showing ``path`` (selected when it is a file), or None outside WSL / no Explorer.

    ``/select,`` and the path are separate arguments, so a path with spaces is
    quoted on its own (``explorer.exe /select, "C:\\My data\\a.bam"``).
    Explorer exits with 1 even when it worked: callers mustn't wait on it.
    """
    explorer = windows_program("explorer.exe") if is_wsl() else None
    target = to_windows_path(path) if explorer else None
    if not explorer or not target:
        return None
    if os.path.isdir(path):
        return [explorer, target]
    return [explorer, "/select,", target]


def terminal_argv(script_path: str) -> Optional[list[str]]:
    """A Windows console window running ``sh script_path`` in this distribution, or None.

    For the ssh sign-in (password / Duo prompts): ``cmd.exe /c start`` opens a
    new console that runs ``wsl.exe -d <this distro> -- sh <script>``, so the
    ssh master it starts is the one this server then uses.
    """
    if not is_wsl():
        return None
    cmd = windows_program("cmd.exe")
    wsl = windows_program("wsl.exe")
    name = distro_name()
    if not cmd or not wsl or not name:
        return None
    return [cmd, "/c", "start", "FiberBrowser sign-in", "wsl.exe", "-d", name, "--", "sh", script_path]


def windows_cwd() -> Optional[str]:
    """A Windows-drive folder to run Windows programs from (cmd.exe refuses a Linux one)."""
    mounts = _windows_mounts()
    return mounts[0] if mounts else None


def fast_data_folder() -> str:
    """Where to keep large data: this distribution's own disk (~/data when it exists)."""
    home = os.path.expanduser("~")
    data = os.path.join(home, "data")
    return data if os.path.isdir(data) else home


def slow_mount_note(path: str, min_bytes: int = SLOW_MOUNT_NOTE_BYTES) -> Optional[str]:
    """A note for a large file on a Windows drive, or None (not WSL, small, elsewhere, remote).

    The text doesn't name the file, so opening several such files shows it once
    (the page lists each distinct message once).
    """
    if not path or "://" in path or not is_wsl():
        return None
    if not DRVFS_RE.match(os.path.abspath(path)):
        return None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if size < min_bytes:
        return None
    folder = fast_data_folder()
    shown = to_windows_path(folder) or folder
    return (
        f"Opened. Note: large files on a Windows drive (C:, D:, ...) load and scroll more slowly in "
        f"FiberBrowser, which runs in WSL and reads Windows drives through a slower bridge. For speed, "
        f"keep large BAMs in FiberBrowser's own folder, {shown} (in File Explorer: Linux > "
        f"{distro_name() or 'your distribution'}), and open them from there."
    )


# --- Windows paths in requests -------------------------------------------------------
# In WSL, a Windows path pasted or sent where a path is accepted (C:\data\a.bam,
# \\wsl.localhost\FiberBrowser\home\..., file:///C:/...) is translated before the
# endpoint sees it: query parameters and the top-level fields of a JSON body whose
# names say they hold a path (path, paths, file_path, output_dir, search_root,
# bam_paths, ...). Nested objects (a saved session sent back for checking, with
# its paths also used as keys) are left as they are, and so is every value
# that doesn't look like a Windows path.
PATH_KEY_SUFFIXES = ("path", "paths", "dir", "dirs", "directory", "folder", "file", "files", "root", "fasta",
                     "gtf", "bam", "bams")
MAX_TRANSLATED_BODY = 8 << 20


def is_path_key(key: str) -> bool:
    k = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(key)).lower().replace("-", "_")
    return k.endswith(PATH_KEY_SUFFIXES)


def _translate_value(value):
    if isinstance(value, str):
        return to_wsl_path(value, wsl=True) if is_windows_path(value.strip()) else value
    if isinstance(value, list):
        return [_translate_value(item) if isinstance(item, str) else item for item in value]
    return value


def translate_json_paths(data):
    """A JSON body with the Windows paths of its top-level path fields translated (a new object)."""
    if not isinstance(data, dict):
        return data
    return {key: _translate_value(value) if is_path_key(key) and isinstance(value, (str, list)) else value
            for key, value in data.items()}


def translate_query_string(query: bytes) -> Optional[bytes]:
    """The query string with Windows path values translated, or None when nothing changed."""
    from urllib.parse import parse_qsl, urlencode
    if not query:
        return None
    try:
        pairs = parse_qsl(query.decode("latin-1"), keep_blank_values=True, encoding="utf-8")
    except (UnicodeDecodeError, ValueError):
        return None
    changed = False
    out = []
    for key, value in pairs:
        if is_path_key(key) and is_windows_path(value.strip()):
            new = to_wsl_path(value.strip(), wsl=True)
            changed = changed or new != value
            value = new
        out.append((key, value))
    return urlencode(out, encoding="utf-8").encode("latin-1") if changed else None


class WindowsPathMiddleware:
    """ASGI middleware: Windows paths in requests become the paths this WSL server opens."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        query = translate_query_string(scope.get("query_string") or b"")
        if query is not None:
            scope = dict(scope, query_string=query)
        headers = dict((k.lower(), v) for k, v in scope.get("headers") or [])
        is_json = headers.get(b"content-type", b"").split(b";")[0].strip() == b"application/json"
        if scope.get("method") not in ("POST", "PUT", "PATCH") or not is_json:
            return await self.app(scope, receive, send)

        chunks: list[dict] = []
        size = 0
        while True:
            message = await receive()
            chunks.append(message)
            if message.get("type") != "http.request":
                break
            size += len(message.get("body") or b"")
            if not message.get("more_body") or size > MAX_TRANSLATED_BODY:
                break
        complete = (chunks and chunks[-1].get("type") == "http.request"
                    and not chunks[-1].get("more_body") and size <= MAX_TRANSLATED_BODY)
        if complete:
            body = b"".join(m.get("body") or b"" for m in chunks)
            new_body = None
            try:
                import json
                data = json.loads(body)
                translated = translate_json_paths(data)
                if translated != data:
                    new_body = json.dumps(translated).encode("utf-8")
            except (ValueError, UnicodeDecodeError, RecursionError):
                new_body = None
            if new_body is not None:
                chunks = [{"type": "http.request", "body": new_body, "more_body": False}]
                scope = dict(scope, headers=[(k, v) for k, v in scope.get("headers") or []
                                             if k.lower() != b"content-length"]
                             + [(b"content-length", str(len(new_body)).encode())])
        pending = list(chunks)

        async def replay():
            if pending:
                return pending.pop(0)
            return await receive()

        return await self.app(scope, replay, send)


def install_windows_path_translation(app) -> bool:
    """Add WindowsPathMiddleware when this server runs in WSL (True if it did)."""
    if not is_wsl():
        return False
    app.add_middleware(WindowsPathMiddleware)
    return True
