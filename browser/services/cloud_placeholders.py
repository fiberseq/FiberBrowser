"""Files whose data is not on this computer: online-only cloud placeholders.

Dropbox, iCloud Drive, OneDrive and Google Drive can keep a file "online-only":
its name is in the folder, its data is not. Opened as it is, an online-only BAM
was added as a dataset with no reads and no message (audit M21). These checks
read metadata only (``stat`` and, on macOS, one extended attribute), never the
file's data: a read could start a download and block the server meanwhile.

- macOS File Provider (iCloud Drive, Dropbox and OneDrive on File Provider):
  the ``SF_DATALESS`` flag, or a large file with no blocks allocated.
- Dropbox's own placeholders: a zero-length file with the
  ``com.dropbox.placeholder`` extended attribute.
- iCloud's older stubs: ``.name.icloud`` next to a missing ``name``.

A zero-length file without that metadata is "empty" (an empty BED is a valid
track; an empty BAM is not a dataset); in a synced folder its message says it
may be online-only.

The Library has its own record of online-only files (services/library_inspect.py).
"""
from __future__ import annotations

import os
import stat
import sys
from typing import Optional

SF_DATALESS = 0x40000000   # macOS: the file's data lives in the cloud (File Provider)
UF_COMPRESSED = 0x20       # macOS: transparently compressed (may have no data blocks)
PLACEHOLDER_XATTRS = ("com.dropbox.placeholder",)
# A file at least this large with no blocks allocated has its data elsewhere.
_DATALESS_MIN_SIZE = 64 * 1024
# Path segments of folders a cloud client syncs.
_CLOUD_SEGMENTS = ("dropbox", "onedrive", "google drive", "googledrive", "icloud drive", "box sync")
_CLOUD_PARTS = ("/library/cloudstorage/", "/library/mobile documents/")

CLOUD_MESSAGE = ("{name} is in the cloud and not downloaded: make it available offline "
                 "in Dropbox/iCloud, then reopen it.")
EMPTY_MESSAGE = "{name} is empty (0 bytes): there is nothing to read in it."
EMPTY_SYNCED_MESSAGE = ("{name} is empty (0 bytes). If it is online-only, make it available offline "
                        "in Dropbox/iCloud, then reopen it.")


_getxattr = None


def _xattr_size(path: str, name: str) -> Optional[int]:
    """The size of an extended attribute (None: absent, or not on macOS)."""
    global _getxattr
    if sys.platform != "darwin":
        return None
    try:
        if _getxattr is None:
            import ctypes
            import ctypes.util
            libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
            fn = libc.getxattr
            fn.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t,
                           ctypes.c_uint32, ctypes.c_int)
            fn.restype = ctypes.c_ssize_t
            _getxattr = fn
        size = _getxattr(os.fsencode(path), name.encode(), None, 0, 0, 0)
    except Exception:
        return None
    return int(size) if size >= 0 else None


def has_placeholder_xattr(path: str) -> bool:
    return any(_xattr_size(path, name) is not None for name in PLACEHOLDER_XATTRS)


def in_cloud_folder(path: str) -> bool:
    """The file is in a folder a cloud client syncs (Dropbox, iCloud Drive, ...)."""
    try:
        real = os.path.realpath(path)
    except OSError:
        real = path
    low = real.replace("\\", "/").lower()
    if any(part in low for part in _CLOUD_PARTS):
        return True
    return any(seg.startswith(_CLOUD_SEGMENTS) for seg in low.split("/")[:-1])


def _icloud_stub(path: str) -> Optional[str]:
    """iCloud's stub for an evicted file (``.name.icloud``), when ``path`` itself is missing."""
    folder, name = os.path.split(path)
    stub = os.path.join(folder, f".{name}.icloud")
    return stub if name and os.path.isfile(stub) else None


def availability(path: str, st: Optional[os.stat_result] = None) -> Optional[str]:
    """``"cloud"`` (online-only), ``"empty"`` (zero bytes, not a placeholder), or
    None (a regular file with data here, a folder, a URL, or nothing there)."""
    if not path or "://" in str(path):
        return None
    if st is None:
        try:
            st = os.stat(path)
        except FileNotFoundError:
            return "cloud" if _icloud_stub(path) else None
        except OSError:
            return None
    if not stat.S_ISREG(st.st_mode):
        return None
    flags = getattr(st, "st_flags", 0) or 0
    if sys.platform == "darwin" and flags & SF_DATALESS:
        return "cloud"
    if has_placeholder_xattr(path):
        return "cloud"
    if st.st_size == 0:
        return "empty"
    blocks = getattr(st, "st_blocks", None)
    if (sys.platform == "darwin" and blocks == 0 and st.st_size >= _DATALESS_MIN_SIZE
            and not flags & UF_COMPRESSED):
        return "cloud"
    return None


def unavailable_message(path: str, st: Optional[os.stat_result] = None) -> Optional[str]:
    """Why a local file can't be read (online-only, or empty), naming it; None when it can."""
    state = availability(path, st)
    name = os.path.basename(str(path).rstrip("/\\")) or str(path)
    if state == "cloud":
        return CLOUD_MESSAGE.format(name=name)
    if state == "empty":
        return (EMPTY_SYNCED_MESSAGE if in_cloud_folder(path) else EMPTY_MESSAGE).format(name=name)
    return None


def _bam_indexes(path: str) -> list[str]:
    """The index files htslib looks for next to a BAM, in its order (CSI first)."""
    stem = path[:-4] if path.lower().endswith(".bam") else path
    return [path + ".csi", stem + ".csi", path + ".bai", stem + ".bai"]


def dataset_unavailable_message(path: str) -> Optional[str]:
    """A local BAM/BigBed that can't be read, or a BAM whose index is online-only."""
    message = unavailable_message(path)
    if message or not str(path).lower().endswith(".bam"):
        return message
    candidates = _bam_indexes(path)
    # The index htslib opens (the first that is here), else an iCloud stub of one.
    index = next((c for c in candidates if os.path.isfile(c)), None) \
        or next((c for c in candidates if _icloud_stub(c)), None)
    state = availability(index) if index else None
    bam = os.path.basename(path)
    if state == "cloud":
        return (f"{os.path.basename(index)} (the index of {bam}) is in the cloud "
                "and not downloaded: make it available offline in Dropbox/iCloud, then reopen it.")
    if state == "empty":
        return (f"{os.path.basename(index)} (the index of {bam}) is empty (0 bytes): "
                f"re-index the BAM (samtools index {bam}).")
    return None
