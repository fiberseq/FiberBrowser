"""Local path normalization and diagnostics for user-selected files.

The frontend can run in a Windows browser while the Python backend runs in a
different filesystem view, most commonly WSL. In that setup a path that works
in a Windows application such as IGV may be invisible to the backend unless the
drive/share is mounted inside WSL. Keep that failure explicit.
"""
from __future__ import annotations

import os
import re
import urllib.parse

# The WSL helpers live in services/wsl_interop.py (the Windows app runs the
# server in WSL); re-exported here for the callers that import them from here.
from services.wsl_interop import (  # noqa: E402,F401
    UNC_RE,
    WINDOWS_DRIVE_RE,
    is_unc_path,
    is_windows_drive_path,
    is_windows_path,
    is_wsl,
    other_distro,
)
from services import wsl_interop  # noqa: E402

WSL_MOUNT_RE = re.compile(r"^/mnt/[A-Za-z]($|/)")


def clean_local_path(path: str | None) -> str:
    """Trim common shell/browser quoting without changing meaningful spaces."""
    value = (path or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    if value.startswith("file://"):
        parsed = urllib.parse.urlparse(value)
        value = urllib.parse.unquote(parsed.path or value)
    return value


def convert_windows_path_to_wsl(path: str) -> str:
    """Convert a Windows path to a WSL-visible path when it can be resolved (else unchanged)."""
    value = clean_local_path(path)
    if not value or not is_wsl():
        return value
    return wsl_interop.to_wsl_path(value, wsl=True)


def normalize_local_path(path: str | None) -> str:
    """Return the path form the backend should try to open."""
    value = clean_local_path(path)
    if is_wsl() and is_windows_path(value):
        return convert_windows_path_to_wsl(value)
    return value


def normalize_local_paths(paths: list[str]) -> list[str]:
    return [normalize_local_path(path) for path in paths]


def _stat_path(path: str):
    try:
        return os.stat(path)
    except FileNotFoundError:
        return None
    except PermissionError:
        return "permission"
    except OSError:
        return None


def local_path_exists(path: str) -> bool:
    return _stat_path(path) not in (None, "permission")


def path_access_error(
    path: str,
    *,
    original_path: str | None = None,
    expected: str = "file or directory",
) -> str | None:
    """Return a user-facing access error, or None when the path is visible."""
    from services.remote_sources import is_browsable_ref
    if is_browsable_ref(path):
        return source_ref_access_error(path, expected=expected)
    normalized = normalize_local_path(path)
    original = clean_local_path(original_path) if original_path else clean_local_path(path)
    stat_result = _stat_path(normalized)
    if stat_result == "permission":
        return (
            f"Permission denied reading {expected}: {normalized}. "
            "Check the filesystem permissions for the user running FiberBrowser."
        )
    if stat_result is not None:
        return None

    lines = [f"{expected.capitalize()} not found or not readable by FiberBrowser: {original}"]
    if normalized != original:
        lines.append(f"Backend translated that path to: {normalized}")

    elsewhere = other_distro(original) if is_wsl() else None
    if elsewhere:
        lines.append(
            f"That path is inside another WSL distribution ({elsewhere}). FiberBrowser runs in its own "
            f"distribution ({wsl_interop.distro_name()}) and can't read another one's files: copy the file "
            "to a Windows folder (e.g. C:\\Users\\you\\data) or to FiberBrowser's own folder "
            f"({wsl_interop.to_windows_path(wsl_interop.fast_data_folder()) or '~/data'}) and open it there."
        )
    elif is_wsl() or WSL_MOUNT_RE.match(normalized) or is_windows_path(original):
        lines.append(
            "If this is a Windows mapped network drive, the Windows browser/file dialog may see it "
            "while the Python backend cannot. Mount the share inside WSL (for example with "
            "sudo mount -t drvfs '\\\\server\\share' /mnt/lab) and load the /mnt/... path, "
            "or run FiberBrowser from Windows Python in the same user session that mounted the drive."
        )
    elif is_unc_path(original):
        lines.append(
            "UNC/network shares must be readable by the backend process. Try the mounted local path "
            "for that share, or run FiberBrowser in the same environment that can access it."
        )
    else:
        parent = os.path.dirname(normalized)
        if parent and not os.path.exists(parent):
            lines.append(f"Parent directory is also not visible: {parent}")
        lines.append("Confirm the path is accessible from the machine/environment running the FiberBrowser backend.")
    return "\n".join(lines)


def source_ref_access_error(ref: str, *, expected: str = "file") -> str | None:
    """Like ``path_access_error`` for ``ssh://`` references (connected, exists)."""
    from services.remote_sources import source_for_ref
    from services.remote_sources.base import RemoteSourceError

    source = source_for_ref(ref)
    if source is None:
        return f"No remote source handles {ref}"
    try:
        info = source.stat(ref)
    except RemoteSourceError as exc:
        return str(exc)
    except ValueError as exc:  # malformed host/user in the reference
        return f"Invalid reference {ref}: {exc}"
    if not info:
        return f"{expected.capitalize()} not found under the shared cluster folders: {ref}"
    if expected == "file" and info.get("type") != "file":
        return f"Not a file: {ref}"
    return None
