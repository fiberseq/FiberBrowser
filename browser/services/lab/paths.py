"""Data-root confinement on a lab server.

Members may read files only under the configured data roots (plus the
server's own upload folder) and write only under roots marked
``writable = true``. Paths are compared after ``realpath``, so a symlink
inside a root that points outside it is outside, and ``..`` can't climb out.

Every path is resolved once by :func:`resolve`, with the decoder the readers
use (``services.local_paths.normalize_local_path``: quotes, ``file://`` URLs
with their %-escapes, Windows paths under WSL), then ``~``, the working
directory (what ``open`` resolves a relative or bare name against) and
symlinks.

Layers:

- the file operations themselves: :func:`confine` (a no-op off the lab
  profile and outside a member's or visitor's request) at the places that open
  or write files by a path: the BAM/BigWig/FASTA openers, contact maps,
  session files, output folders, in-place BAM edits, index creation, and the
  files served from stored run/QC records (:func:`open_confined`);
- the routes that list folders or pick output folders call :func:`check`
  themselves (the in-page file browser starts at the first root and never
  lists above a root);
- defence in depth, :func:`scan_query` / :func:`scan_body` on every lab
  request check every path-like value of the query string and body: values
  under keys that name a file or folder (``path``, ``bam_path``,
  ``output_dir``, ...; a bare file name too when it exists), and any other
  absolute path that exists on disk. Output keys need a writable root. The
  scan fails closed: a body it cannot read completely (too large, too many
  values, too deep, not parseable although the route would parse it) is
  refused.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Optional
from urllib.parse import parse_qsl, unquote, urlsplit

OUTSIDE_MESSAGE = "That location is outside the lab's data folders."
READONLY_MESSAGE = "That folder is read-only on this server; choose a folder in a writable data root."

# Keys whose string values are file or folder paths.
_PATH_KEY = re.compile(
    r"(^|_)(path|paths|file|files|filename|filepath|dir|dirs|directory|folder|bam|bams|bigbed|bigwig|fasta|fa|gtf|"
    r"gff|bed|cool|mcool|reads|reference|genbank|bundle|bundle_path|bundle_paths|session_path|catalog|package|near|manifest)$",
    re.IGNORECASE)
# Keys that name a place to write.
_WRITE_KEY = re.compile(r"(^|_)(output|outdir|out_dir|output_dir|output_root|output_path|save_path|dest|destination|"
                        r"export_dir|export_path|cache_dir)$", re.IGNORECASE)
# Scan budgets: above any legitimate request (a lab-shelf session is at most
# 32 MB); a body beyond them is refused, never passed on unscanned.
MAX_SCAN_BYTES = 64 << 20
_MAX_VALUES = 2_000_000
_MAX_DEPTH = 256
TOO_LARGE_MESSAGE = "That request is too large for this lab server to check its file paths; it was refused."
UNREADABLE_MESSAGE = "That request body could not be read as JSON; it was refused."


class PathDenied(PermissionError):
    pass


def _cfg():
    from services.lab import get_config
    return get_config()


# Root pinning. A configured folder (a data root, the uploads folder, the genome
# caches...) is resolved once, when first used after the profile is configured
# (at start-up for the data roots), and remembered as that real path and its
# device+inode. A root whose name was later pointed elsewhere (retargeted
# symlink, a swapped ancestor, a folder moved and replaced) no longer matches its
# identity and admits nothing; the descriptor walk checks the identity again
# as it passes through the root, so a swap during the open is caught too.
_ROOT_REAL: dict[str, str] = {}
_PINS: dict[str, tuple[int, int]] = {}


def pin_roots(cfg) -> None:
    """Forget old pins; pin ``cfg``'s data roots now (lab.configure calls this)."""
    _ROOT_REAL.clear()
    _PINS.clear()
    if cfg is None:
        return
    for root in cfg.data_roots:
        _pinned(root.path)


def _pinned(path: str) -> Optional[str]:
    """The real path ``path`` was pinned to, while its identity is unchanged; None
    when it has changed since (it then admits nothing). Files aren't pinned."""
    key = os.path.abspath(os.path.expanduser(path))
    real = _ROOT_REAL.get(key)
    if real is None:
        real = os.path.realpath(key)
        try:
            st = os.stat(real)
        except OSError:
            return real  # not there (yet): nothing under it can be opened either
        if not os.path.isdir(real):
            return real
        _ROOT_REAL[key] = real
        _PINS[real] = (st.st_dev, st.st_ino)
        return real
    try:
        st = os.stat(real)
    except OSError:
        return None
    if _PINS.get(real) not in (None, (st.st_dev, st.st_ino)):
        return None
    return real


def read_roots() -> list[str]:
    cfg = _cfg()
    if cfg is None:
        return []
    roots = [_pinned(r.path) for r in cfg.data_roots]
    roots.append(_pinned(cfg.uploads_dir))
    roots.extend(_server_reference_paths(cfg))
    return [r for r in roots if r]


_catalog_cache: dict[tuple, list[str]] = {}


def _catalog_paths(catalog: str) -> list[str]:
    """Local files and folders a catalog JSON lists (cached until the file changes)."""
    try:
        key = (catalog, os.stat(catalog).st_mtime_ns)
    except OSError:
        return []
    if key in _catalog_cache:
        return _catalog_cache[key]
    paths: list[str] = []
    try:
        with open(catalog, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = None
    base = os.path.dirname(os.path.abspath(catalog))
    found: list = []
    try:
        _walk(data, "", found)
    except _ScanLimit:
        pass
    for key_name, value in found:
        if _PATH_KEY.search(key_name) and _looks_like_path(value) and "://" not in value:
            paths.append(value if os.path.isabs(value) else os.path.join(base, value))
    _catalog_cache.clear()
    _catalog_cache[key] = paths
    return paths


def _server_reference_paths(cfg) -> list[str]:
    """Read-only places the server itself put files members' sessions refer to:
    the downloaded-genome caches (``~/.fiberhmm/genomes``, ``~/.fiberhmm/cache``),
    the bundled demo dataset of the guided tour (``browser/data/demo``),
    the configured GTF/FASTA/catalog, and the local files the catalog lists."""
    home = os.path.expanduser("~")
    paths = [os.path.join(home, ".fiberhmm", "genomes"), os.path.join(home, ".fiberhmm", "cache")]
    from services.demo_data import DEMO_DIR
    paths.append(str(DEMO_DIR))  # the bundled tour dataset (read-only)
    paths += [p for p in (cfg.gtf, cfg.fasta, cfg.catalog, cfg.public_catalog.catalog) if p and "://" not in p]
    for catalog in {cfg.catalog, cfg.public_catalog.catalog} - {""}:
        paths += _catalog_paths(catalog)
    return sorted({real for real in (_pinned(p) for p in paths) if real})


def write_roots() -> list[str]:
    cfg = _cfg()
    if cfg is None:
        return []
    return [real for real in (_pinned(r.path) for r in cfg.writable_roots()) if real]


def _under(real: str, roots: Iterable[str]) -> bool:
    for root in roots:
        if real == root or real.startswith(root.rstrip(os.sep) + os.sep):
            return True
    return False


def _real(value: str) -> str:
    return os.path.realpath(os.path.abspath(os.path.expanduser(value)))


def resolve(path: str) -> str:
    """The real location a path names, decoded as the readers decode it
    (``normalize_local_path``: quotes, ``file://`` URLs and their %-escapes),
    then ``~``, the working directory, ``..`` and symlinks resolved."""
    from services.local_paths import normalize_local_path
    value = str(path).strip()
    decoded = normalize_local_path(value)
    if value.lower().startswith("file://") and decoded == value:
        decoded = unquote(urlsplit(value).path)  # FILE://... (the readers only decode file://)
    return _real(decoded)


def _interpretations(path: str) -> list[str]:
    """Every real location a reader might open for ``path``: decoded, and the
    raw string when it names something else that exists."""
    first = resolve(path)
    raw = str(path).strip()
    out = [first]
    if raw:
        literal = _real(raw)
        if literal != first and os.path.lexists(literal):
            out.append(literal)
    return out


def allowed(path: str, *, write: bool = False) -> bool:
    cfg = _cfg()
    if cfg is None:
        return True
    roots = write_roots() if write else read_roots()
    return all(_under(real, roots) for real in _interpretations(path))


def check(path: str, *, write: bool = False) -> str:
    """The resolved path, or PathDenied when it is outside the (writable) roots."""
    cfg = _cfg()
    if cfg is None:
        return path
    reals = _interpretations(path)
    roots = write_roots() if write else read_roots()
    if all(_under(real, roots) for real in reals):
        return reals[0]
    if write and all(_under(real, read_roots()) for real in reals):
        raise PathDenied(READONLY_MESSAGE)
    raise PathDenied(OUTSIDE_MESSAGE)


def enforcing() -> bool:
    """Confinement applies to this call: a lab server, in a member's or an
    anonymous visitor's request (server start-up and its own background work,
    such as the configured datasets and run workers, are not confined)."""
    if _cfg() is None:
        return False
    from services.runtime import current_lab_user, is_anonymous_visitor
    return current_lab_user() is not None or is_anonymous_visitor()


def readable(path) -> bool:
    """This request may read ``path`` (for optional sidecar files: skip, don't refuse)."""
    try:
        confine(path)
    except PathDenied:
        return False
    return True


def open_text(path):
    """A text reader for a local (optionally gzip) file: ``open``/``gzip.open`` as
    before off the lab profile; on a lab server through :func:`open_read`."""
    import gzip
    gz = str(path).lower().endswith(".gz")
    if not enforcing():
        return gzip.open(path, "rt") if gz else open(path, "rt")
    import io
    raw = open_read(path)
    if gz:
        return gzip.open(raw, "rt", encoding="utf-8", errors="replace")
    return io.TextIOWrapper(raw, encoding="utf-8", errors="replace")


def open_local_text(path):
    """``open(path, "r")`` off the lab profile (exactly as before); on a lab server,
    in a member's or visitor's request, the confined descriptor walk of
    :func:`open_read` (UTF-8, undecodable bytes replaced)."""
    if not enforcing():
        return open(path, "r")
    return open_read(path, text=True)


# URL schemes the native readers (htslib, pyBigWig, cooler/fsspec) open themselves.
# Anything else with "://" is, to a reader, a local relative path ("odd://x" is
# the folder "odd:" in the working directory) and is confined as one.
REMOTE_SCHEMES = ("http", "https", "ftp", "s3", "gs")


def is_remote_url(value) -> bool:
    """``value`` is a URL a URL-capable reader fetches over the network (not a local path)."""
    if not isinstance(value, str) or "://" not in value:
        return False
    return value.split("://", 1)[0].lower() in REMOTE_SCHEMES


def confine(path, *, write: bool = False, urls: bool = False):
    """``path`` unchanged when this request may read (``write``: write) it;
    PathDenied otherwise. For the file operations themselves, so a path that
    reached them from stored data or a body the scan never saw is still checked.
    ``urls``: the reader also fetches http(s)/ftp/s3/gs URLs (they pass); for a
    reader that only opens local files every string is a local path.
    Off the lab profile, and outside member/visitor requests, a no-op."""
    if not isinstance(path, (str, os.PathLike)) or not enforcing():
        return path  # None, an open file object, ...
    value = os.fspath(path)
    if not isinstance(value, str) or not value.strip() or value == "-":
        return path
    from services.remote_sources import is_source_ref
    if is_source_ref(value):
        raise PathDenied(OUTSIDE_MESSAGE)  # never on a lab server (Connect to cluster is refused)
    if urls and is_remote_url(value.strip()):
        return path  # governed by the URL rules, not the data roots
    check(value, write=write)
    return path


def _server_owned_dirs() -> list[str]:
    """Folders the server itself fills for members (uploads, downloaded genomes and
    caches): an index or cache written beside a file there changes no member's data."""
    cfg = _cfg()
    if cfg is None:
        return []
    home = os.path.expanduser("~")
    return [real for real in (_pinned(p) for p in (cfg.uploads_dir, os.path.join(home, ".fiberhmm", "genomes"),
                                                    os.path.join(home, ".fiberhmm", "cache"))) if real]


def confine_sidecar(path):
    """Like ``confine(path, write=True)`` for an index or cache file written beside a
    data file (``.bai``, ``.fai``, a parsed-annotation cache): also allowed in the
    server's own folders (uploads, genome downloads), never in a read-only data root."""
    if not isinstance(path, (str, os.PathLike)) or not enforcing():
        return path
    if all(_under(real, _server_owned_dirs()) for real in _interpretations(os.fspath(path))):
        return path
    return confine(path, write=True)


def _index_candidates(path: str, suffixes: tuple) -> list[str]:
    stem = os.path.splitext(path)[0]
    out = []
    for suffix in suffixes:
        for base in (path, stem):
            if base + suffix not in out:
                out.append(base + suffix)
    return out


def confine_alignment(path, mode: str, kwargs: dict) -> None:
    """A lab server's rules for ``pysam.AlignmentFile(path, mode, **kwargs)``: the file,
    an explicit index, and every index htslib would find beside it by itself
    (``.bai``/``.csi``/``.crai``: an existing one that resolves outside the roots is
    refused, since htslib would read it)."""
    if not enforcing() or not isinstance(path, (str, os.PathLike)):
        return
    value = os.fspath(path)
    confine(value, write="w" in mode, urls=True)
    if "w" in mode or is_remote_url(value):
        return
    for key in ("index_filename", "filepath_index"):
        if kwargs.get(key):
            confine(kwargs[key], urls=True)
    for candidate in _index_candidates(value, (".bai", ".csi", ".crai")):
        if os.path.lexists(candidate):
            confine(candidate)


def _is_gzip(path: str) -> bool:
    """The file starts with the gzip magic (read from the confined descriptor; a
    file that can't be read counts as compressed, so its sidecar is checked)."""
    try:
        with open_read(path) as handle:
            return handle.read(2) == b"\x1f\x8b"
    except PathDenied:
        raise  # never fall back to opening a refused file by name
    except OSError:
        return True


def confine_fasta(path, kwargs: dict) -> None:
    """A lab server's rules for ``pysam.FastaFile(path, **kwargs)``: the FASTA, and the
    ``.fai`` (and for bgzip ``.gzi``) htslib reads beside it, or writes when missing:
    an existing one must resolve inside the roots, a missing one may only be created
    where writing is allowed (a writable root or the server's own folders)."""
    if not enforcing() or not isinstance(path, (str, os.PathLike)):
        return
    value = os.fspath(path)
    confine(value, urls=True)
    if is_remote_url(value) or not os.path.exists(value):
        return
    sidecars = [kwargs.get("filepath_index") or value + ".fai"]
    # BGZF is recognised by its content, whatever the name: htslib writes a
    # .gzi for any compressed FASTA without one.
    if kwargs.get("filepath_index_compressed") or _is_gzip(value):
        sidecars.append(kwargs.get("filepath_index_compressed") or value + ".gzi")
    for sidecar in sidecars:
        if os.path.lexists(sidecar):
            confine(sidecar)
        else:
            confine_sidecar(sidecar)  # htslib would write it beside the FASTA


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_OPEN_DIR = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | _CLOEXEC
_OPEN_FILE = os.O_RDONLY | _NOFOLLOW | _NONBLOCK | _CLOEXEC


def _descriptor_walk_supported() -> bool:
    return os.open in os.supports_dir_fd and bool(_NOFOLLOW)


def _open_regular_fd(fd_or_path, name: Optional[str] = None) -> int:
    """Open a regular file without blocking (a FIFO would wait for a writer) and
    without following a last symlink; the descriptor is then made blocking again."""
    import stat as _stat
    fd = os.open(name, _OPEN_FILE, dir_fd=fd_or_path) if name is not None else os.open(fd_or_path, _OPEN_FILE)
    try:
        if not _stat.S_ISREG(os.fstat(fd).st_mode):
            raise PathDenied("Not a regular file.")
        if _NONBLOCK:
            import fcntl
            fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) & ~_NONBLOCK)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _walk_open(real: str, root: str) -> int:
    """A descriptor of the regular file ``real`` (a resolved path) inside ``root``
    (a resolved folder, or a file itself), opened by a walk of directory
    descriptors from the root that follows no symlink, so the check and the open
    are the same operation: a folder swapped for a link meanwhile is refused.
    PathDenied/OSError when it isn't there as a regular file."""
    if real != root and not real.startswith(root.rstrip(os.sep) + os.sep):
        raise PathDenied(OUTSIDE_MESSAGE)
    if real == root and not os.path.isfile(root):
        raise PathDenied(OUTSIDE_MESSAGE)
    parts = [part for part in real.split(os.sep) if part]
    if not parts or ".." in parts or "." in parts:
        raise PathDenied(OUTSIDE_MESSAGE)
    if not _descriptor_walk_supported():  # pragma: no cover - Windows
        return _open_regular_fd(real)
    # From "/" itself: no component of the root's own path, nor of the rest, may
    # have become a link since it was resolved; the root must still be the
    # folder that was pinned.
    pin = _PINS.get(root)
    cur = os.open(os.sep, _OPEN_DIR)
    try:
        here = os.sep
        for name in parts[:-1]:
            nxt = os.open(name, _OPEN_DIR, dir_fd=cur)
            os.close(cur)
            cur = nxt
            here = os.path.join(here, name)
            if pin is not None and here == root:
                st = os.fstat(cur)
                if (st.st_dev, st.st_ino) != pin:
                    raise PathDenied("That data folder has changed since the server started.")
        return _open_regular_fd(cur, parts[-1])
    finally:
        os.close(cur)


_DEV_FD = os.path.isdir("/dev/fd")


def _walk_open_checked(path: str) -> int:
    real = check(path)
    root = _best_root(real, read_roots())
    if root is None:
        raise PathDenied(OUTSIDE_MESSAGE)
    return _walk_open(real, root)


def native_open(kind: str, path, mode: str, kwargs: dict, opener):
    """Open a BAM (``kind`` "bam") or plain FASTA ("fasta") for a lab member from
    descriptors, so htslib reads exactly the files that were checked.

    The file and its index are opened by the confined descriptor walk and handed
    to ``opener`` (pysam) as ``/dev/fd/N`` (on Linux and macOS that names the
    already-open file, never the path again); the descriptors are closed once
    ``opener`` has its own. Returns None (the caller opens by path, after
    :func:`confine_alignment`/:func:`confine_fasta`) off the lab profile, outside
    member requests, for URLs, writes, CRAM, BGZF FASTA and a FASTA without its
    .fai (htslib must then write one), or where /dev/fd doesn't exist."""
    if not (_DEV_FD and enforcing() and isinstance(path, str)) or "://" in path or "w" in (mode or "r"):
        return None
    if kind == "bam" and path.lower().endswith(".cram"):
        return None
    fds: list[int] = []
    try:
        kwargs = dict(kwargs)
        if kind == "fasta":
            index = kwargs.get("filepath_index") or path + ".fai"
            if kwargs.get("filepath_index_compressed") or _is_gzip(path) or not os.path.exists(index):
                return None
            fds.append(_walk_open_checked(path))
            fds.append(_walk_open_checked(index))
            kwargs["filepath_index"] = f"/dev/fd/{fds[1]}"
        else:
            index = kwargs.pop("index_filename", None) or kwargs.pop("filepath_index", None)
            if not index:  # htslib's own order: .csi, then .bai, beside it or in place of .bam
                stem = path[:-4] if path.lower().endswith(".bam") else None
                for candidate in (path + ".csi", stem and stem + ".csi", path + ".bai", stem and stem + ".bai"):
                    if candidate and os.path.exists(candidate):
                        index = candidate
                        break
            fds.append(_walk_open_checked(path))
            if index:
                fds.append(_walk_open_checked(index))
                kwargs["index_filename"] = f"/dev/fd/{fds[1]}"
        return opener(f"/dev/fd/{fds[0]}", **kwargs)
    finally:
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass


def _best_root(real: str, roots: Iterable[str]) -> Optional[str]:
    best = None
    for root in roots:
        if _under(real, [root]) and (best is None or len(root) > len(best)):
            best = root
    return best


def open_confined(path: str, roots: Iterable[str], *, lab_roots: bool = True):
    """(binary file, real path, size) of the regular file ``path`` names when its
    real location is inside one of ``roots`` (and, with ``lab_roots`` on a lab
    server, a data root); None otherwise.

    For files named by stored data (run records, QC manifests, shelf entries):
    opened by a descriptor walk from the root (:func:`_walk_open`: no symlink
    followed, a FIFO never waited on), so what is served is what was checked.
    """
    if not path:
        return None
    try:
        real = os.path.realpath(os.fspath(path))
    except (TypeError, ValueError):
        return None
    root = _best_root(real, [os.path.realpath(r) for r in roots if r])
    if root is None:
        return None
    if lab_roots and _cfg() is not None and not _under(real, read_roots()):
        return None
    try:
        fd = _walk_open(real, root)
    except (OSError, PathDenied):
        return None
    return os.fdopen(fd, "rb"), real, int(os.fstat(fd).st_size)


def open_read(path, *, text: bool = False):
    """Open a local file a request names (or one found from it) for reading.

    Off the lab profile, and outside member/visitor requests: plain ``open`` of
    ``path``. On a lab server: ``path`` must be inside the read roots
    (:func:`check`, decoded as the readers decode it) and is opened by the same
    descriptor walk as :func:`open_confined`, so it can't be swapped for a link
    to somewhere else between the check and the open. PathDenied/OSError otherwise.
    """
    if not enforcing():
        return open(path, "rt" if text else "rb", **({"encoding": "utf-8", "errors": "replace"} if text else {}))
    value = os.fspath(path)
    real = check(value)
    root = _best_root(real, read_roots())
    if root is None:
        raise PathDenied(OUTSIDE_MESSAGE)
    handle = os.fdopen(_walk_open(real, root), "rb")
    if text:
        import io
        return io.TextIOWrapper(handle, encoding="utf-8", errors="replace")
    return handle


def root_for(path: str) -> Optional[str]:
    real = resolve(path)
    best = None
    for root in read_roots():
        if _under(real, [root]) and (best is None or len(root) > len(best)):
            best = root
    return best


def roots_listing() -> list[dict]:
    cfg = _cfg()
    if cfg is None:
        return []
    return [{"path": r.path, "label": r.label, "writable": r.writable} for r in cfg.data_roots]


# ---------------------------------------------------------------------------
# Request scanning
# ---------------------------------------------------------------------------

def _looks_like_path(value: str) -> bool:
    if not value or len(value) > 4096:
        return False
    if is_remote_url(value):
        return False  # http(s), ftp and s3 URLs are not local files
    from services.remote_sources import is_source_ref
    if is_source_ref(value):
        return True  # refused by check(): never on a lab server
    return value.startswith(("/", "~", "./", "../")) or "/" in value or "\\" in value or value in (".", "..")


class _ScanLimit(Exception):
    pass


def _walk(value: Any, key: str, out: list, depth: int = 0) -> None:
    """(key, string) pairs of a parsed body; _ScanLimit when it is beyond the budgets."""
    stack = [(value, key, depth)]
    while stack:
        item, name, level = stack.pop()
        if level > _MAX_DEPTH:
            raise _ScanLimit()
        if isinstance(item, dict):
            for k, v in item.items():
                stack.append((v, str(k), level + 1))
        elif isinstance(item, list):
            for v in item:
                stack.append((v, name, level + 1))
        elif isinstance(item, str):
            out.append((name, item))
            if len(out) > _MAX_VALUES:
                raise _ScanLimit()


def violations(pairs: Iterable[tuple[str, str]]) -> Optional[str]:
    """The first refusal message for (key, value) pairs, or None."""
    seen: set = set()
    for key, value in pairs:
        value = value.strip()
        if not value:
            continue
        write = bool(_WRITE_KEY.search(key))
        path_key = write or bool(_PATH_KEY.search(key))
        if (value, write, path_key) in seen:
            continue
        seen.add((value, write, path_key))
        if path_key:
            if not _looks_like_path(value):
                # A bare name ("secret.json") is a file in the working directory
                # when one exists there; other bare values (a genome id, a format
                # name) name no file.
                if "://" in value or len(value) > 4096 or not os.path.lexists(resolve(value)):
                    continue
        elif not (value.startswith(("/", "~")) or value.lower().startswith("file://")):
            continue
        elif not os.path.lexists(resolve(value)) and not os.path.lexists(os.path.expanduser(value)):
            continue  # an absolute-looking string that isn't a file (an API path, a pattern)
        try:
            check(value, write=write)
        except PathDenied as exc:
            return f"{exc} ({key})"
    return None


def scan_query(query_string: str) -> Optional[str]:
    return violations(parse_qsl(query_string or "", keep_blank_values=False))


def scan_json_body(body: bytes) -> Optional[str]:
    """The refusal for a JSON body (None: every path in it is allowed)."""
    return scan_body(body, "application/json")


def body_kind(content_type: Optional[str]) -> str:
    """How a route would read a body of this Content-Type: "json" (FastAPI parses
    an absent type and application/json, */*+json as JSON), "form", "multipart",
    or "other" (raw bytes; still scanned when they happen to be JSON)."""
    value = (content_type or "").split(";", 1)[0].strip().lower()
    if not value or value == "application/json" or value.endswith("+json"):
        return "json"
    if value == "application/x-www-form-urlencoded":
        return "form"
    if value.startswith("multipart/"):
        return "multipart"
    return "other"


def scan_body(body: bytes, content_type: Optional[str]) -> Optional[str]:
    """The refusal for a request body (None: every path in it is allowed).

    Fails closed: a body over the budgets, or one that is not JSON although a
    route would parse it as JSON, is refused rather than passed on unscanned.
    Multipart bodies (file uploads) carry no path fields; their file names are
    reduced to a base name by the upload route.
    """
    if not body:
        return None
    kind = body_kind(content_type)
    if kind == "multipart":
        return None
    if len(body) > MAX_SCAN_BYTES:
        return TOO_LARGE_MESSAGE
    if kind == "form":
        return violations(parse_qsl(body.decode("latin-1"), keep_blank_values=False))
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return UNREADABLE_MESSAGE if kind == "json" else None
    pairs: list = []
    try:
        _walk(payload, "", pairs)
    except _ScanLimit:
        return TOO_LARGE_MESSAGE
    return violations(pairs)
