"""Open dataset files whatever their location: local path, URL or source reference.

Every place that opens a BAM, BigBed/BigWig or FASTA by a dataset path calls
these instead of pysam/pyBigWig directly, so ``ssh://`` references work
everywhere downstream (reads, coverage, clustering, footprints, plasmids).

- The live URL for a reference (it carries a per-file key derived from the
  connection's secret) exists only inside these calls and is registered with
  ``services.signed_urls``, so printed output, log records and JSON responses
  show the reference instead. htslib's own messages go straight to the
  process's standard error, so opens run with htslib silenced
  (``services.htslib_quiet``) and Python errors are rewritten to show the
  reference, not the URL. A read error *after* a successful open can still
  make htslib print the URL on this computer's standard error; that key opens
  only the one file, and only while connected.
- BAM indexes of references are downloaded once into a private cache and
  passed to pysam explicitly. (htslib would otherwise save a remote index into
  the server's working directory under its basename and reuse any same-named
  file there, whichever BAM it belonged to.) The cache key is the index's
  version *and* its BAM's version (size, nanosecond mtime and ctime, inode:
  a same-size rewrite within one second is still a new version), and a copy
  is kept only when the file did not change while it was being downloaded.
- ``https://`` and ``s3://`` BAMs get the same treatment: their index is
  downloaded once into the cache (keyed by the index's URL and ETag/size/date
  and its BAM's) and passed explicitly. htslib would save it into the
  server's working directory under its basename and reuse it for any BAM of
  that name (``runA/sample.bam`` read with ``runB/sample.bam.bai``: no reads,
  no error), or download it again on every open where that folder is not
  writable. ``s3://`` objects are read through an HTTPS URL made by boto3
  (``s3_utils.S3Manager.open_url``), never by htslib's own S3 code.
- The cache (``~/.fiberhmm/remote_cache``) is pruned: copies unused for
  ``FIBERBROWSER_REMOTE_CACHE_MAX_AGE_DAYS`` (30) days go, then the least
  recently used until it fits in ``FIBERBROWSER_REMOTE_CACHE_MAX_MB``
  (5 GB). Copies used in the last hour are never removed.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import threading
import time
from contextlib import contextmanager
from typing import Optional

try:
    import fcntl
except ImportError:  # Windows: one process per cache is all that is locked
    fcntl = None

from services.remote_sources import is_source_ref, source_for_ref
from services.remote_sources.base import RemoteFileChanged, RemoteSourceError

CACHE_ENV = "FIBERBROWSER_REMOTE_CACHE"
CACHE_MAX_MB_ENV = "FIBERBROWSER_REMOTE_CACHE_MAX_MB"
CACHE_MAX_AGE_ENV = "FIBERBROWSER_REMOTE_CACHE_MAX_AGE_DAYS"
DEFAULT_CACHE_MAX_MB = 5 * 1024
DEFAULT_CACHE_MAX_AGE_DAYS = 30
CACHE_IN_USE_S = 3600.0  # a copy used this recently is never pruned
_PRUNE_INTERVAL = 600.0
MAX_INDEX_BYTES = 512 * 1024 * 1024
MAX_SMALL_FILE_BYTES = 64 * 1024 * 1024
_INDEX_TTL = 30.0
# A cached htslib handle to a cluster file idle this long is reopened before
# use: the helper abandons a stream nobody reads after 15 minutes, and htslib
# can't resume one (see remote_helper.WRITE_TIMEOUT).
REMOTE_HANDLE_MAX_IDLE = 300.0

_index_memo: dict[str, tuple[float, Optional[str], Optional[str]]] = {}
_index_locks: dict[str, threading.Lock] = {}
_index_locks_guard = threading.Lock()
_prune_lock = threading.Lock()
_last_prune = 0.0
# Acquiring a cache entry and pruning take the same lock (a thread lock plus
# an flock on <cache>/.lock for other FiberBrowser processes sharing it), so
# an entry can't be chosen for removal and then handed out, or the reverse.
_cache_lock = threading.RLock()
_leases: dict[str, int] = {}  # folder -> downloads/opens in progress in this process

_TOKEN_URL_RE = re.compile(r"https?://127\.0\.0\.1:\d+/[A-Za-z0-9_-]{32,}/f")


def cache_base() -> str:
    return os.environ.get(CACHE_ENV) or os.path.join(os.path.expanduser("~"), ".fiberhmm", "remote_cache")


def cache_dir(kind: str) -> str:
    path = os.path.join(cache_base(), kind)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def redact(text: str) -> str:
    """Replace live loopback URLs by their ``ssh://`` reference (or a placeholder)."""
    if not text:
        return text
    try:
        from services import signed_urls
        text = signed_urls.redact_text(text)
        from services.remote_sources import get_source
        source = get_source("ssh")
        for conn in list(getattr(source, "_connections", {}).values()):
            text = text.replace(conn.token, "<token>")
    except Exception:
        pass
    return _TOKEN_URL_RE.sub("ssh://<remote>", text)


def forget_remote_state() -> None:
    """Forget per-reference memos (on connect, disconnect and reconnect)."""
    _index_memo.clear()


def version_of(info: Optional[dict]) -> Optional[str]:
    """A remote file's version: the helper's (size, mtime_ns, ctime_ns, inode), else size+mtime."""
    if not info:
        return None
    if info.get("version"):
        return str(info["version"])
    return f"{info.get('size')}:{info.get('mtime')}"


def _stat(source, ref: str, *, fresh: bool = False) -> Optional[dict]:
    if fresh:
        try:
            return source.stat(ref, max_age=0)
        except TypeError:  # a source without its own stat cache
            pass
    return source.stat(ref)


def _touch(path: str) -> None:
    """Mark a cache entry (its folder) as just used."""
    try:
        os.utime(os.path.dirname(path))
    except OSError:
        pass


@contextmanager
def _cache_locked():
    with _cache_lock:
        handle = None
        if fcntl is not None:
            try:
                os.makedirs(cache_base(), mode=0o700, exist_ok=True)
                handle = os.open(os.path.join(cache_base(), ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
                fcntl.flock(handle, fcntl.LOCK_EX)
            except OSError:
                if handle is not None:
                    os.close(handle)
                handle = None
        try:
            yield
        finally:
            if handle is not None:
                try:
                    fcntl.flock(handle, fcntl.LOCK_UN)
                finally:
                    os.close(handle)


def _lease(folder: str, delta: int) -> None:
    with _cache_lock:
        count = _leases.get(folder, 0) + delta
        if count > 0:
            _leases[folder] = count
        else:
            _leases.pop(folder, None)


def _cached_copy(kind: str, source, ref: str, info: dict, max_bytes: int, extra_key: str = "",
                 identity: Optional[str] = None) -> str:
    """A local copy of ``ref`` in the cache, keyed by its version (and ``extra_key``).

    Downloaded only when missing; kept only when the version is unchanged
    across the download (checked range by range by the SSH source, by a
    fresh stat afterwards for others). One retry when it changed meanwhile.
    ``identity`` names the file in the key and the copy's name instead of
    ``ref`` (a signed URL's display form: its signature changes, the file doesn't).
    """
    name_ref = identity or ref
    for attempt in range(2):
        version = version_of(info)
        key = hashlib.sha256(f"{name_ref}\0{version}\0{extra_key}".encode("utf-8")).hexdigest()[:32]
        folder = os.path.join(cache_dir(kind), key)
        name = name_ref
        if name.split("://", 1)[0].lower() in ("http", "https"):
            name = name.split("?", 1)[0].split("#", 1)[0]  # a URL's query is not part of its name
        local = os.path.join(folder, os.path.basename(name.rstrip("/")) or "file")
        with _cache_locked():  # never between a prune's choice and its removal
            os.makedirs(folder, mode=0o700, exist_ok=True)
            _touch(local)
            if os.path.exists(local):
                return local
            _lease(folder, +1)  # held for the whole download
        changed = False
        try:
            fetch = getattr(source, "fetch_to_file", None)
            if fetch is not None:
                try:
                    fetch(ref, local, max_bytes, expected_version=info.get("version"))
                except TypeError:
                    fetch(ref, local, max_bytes)
            else:
                data = source.fetch_bytes(ref, max_bytes)
                tmp = local + ".part"
                with open(tmp, "wb") as out:
                    out.write(data)
                os.replace(tmp, local)
            after = _stat(source, ref, fresh=True)
            changed = after is None or version_of(after) != version
        except RemoteFileChanged:
            if attempt:
                raise
            changed, after = True, _stat(source, ref, fresh=True)
        finally:
            with _cache_locked():
                _touch(local)
                _lease(folder, -1)
        if not changed:
            prune_cache()
            return local
        shutil.rmtree(folder, ignore_errors=True)
        if not after or after.get("type") != "file":
            raise RemoteSourceError(f"{ref} disappeared while it was being copied.")
        info = after
    raise RemoteSourceError(f"{ref} kept changing while it was being copied; try again later.")


def _max_cache_bytes() -> int:
    try:
        return max(0, int(float(os.environ.get(CACHE_MAX_MB_ENV) or DEFAULT_CACHE_MAX_MB) * 1024 * 1024))
    except ValueError:
        return DEFAULT_CACHE_MAX_MB * 1024 * 1024


def _max_cache_age() -> float:
    try:
        return float(os.environ.get(CACHE_MAX_AGE_ENV) or DEFAULT_CACHE_MAX_AGE_DAYS) * 86400.0
    except ValueError:
        return DEFAULT_CACHE_MAX_AGE_DAYS * 86400.0


def _entry_used(folder: str) -> tuple[float, int]:
    """(last use, size): the newest mtime of the folder and its files (a download
    in progress keeps writing its .part file)."""
    used = os.stat(folder).st_mtime
    size = 0
    for name in os.listdir(folder):
        info = os.lstat(os.path.join(folder, name))
        size += info.st_size
        used = max(used, info.st_mtime)
    return used, size


def prune_cache(*, force: bool = False, now: Optional[float] = None) -> list[str]:
    """Remove old / least recently used cache entries; returns the folders removed.

    An entry is one ``<kind>/<key>/`` folder; its last use is the newest
    modification time of the folder or its files (``_touch`` on every use).
    Entries used within ``CACHE_IN_USE_S``, being downloaded in this process,
    or pointed to by the index memo stay. The whole choice-and-removal runs
    under the lock that handing out an entry takes.
    """
    global _last_prune
    now = time.time() if now is None else now
    if not force and now - _last_prune < _PRUNE_INTERVAL:
        return []
    if not _prune_lock.acquire(blocking=False):
        return []
    try:
        _last_prune = now
        with _cache_locked():
            return _prune_locked(now)
    finally:
        _prune_lock.release()


def _prune_locked(now: float) -> list[str]:
    base = cache_base()
    in_memo = {os.path.dirname(m[2]) for m in list(_index_memo.values()) if m[2]}
    entries = []
    for kind in ("index", "files"):
        root = os.path.join(base, kind)
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            folder = os.path.join(root, name)
            try:
                used, size = _entry_used(folder)
            except OSError:
                continue
            entries.append((used, size, folder))
    removed = []
    keep = []
    max_age = _max_cache_age()
    for used, size, folder in entries:
        protected = now - used < CACHE_IN_USE_S or folder in in_memo or folder in _leases
        if not protected and now - used > max_age:
            shutil.rmtree(folder, ignore_errors=True)
            removed.append(folder)
        else:
            keep.append((used, size, folder, protected))
    total = sum(size for _u, size, _f, _p in keep)
    ceiling = _max_cache_bytes()
    for used, size, folder, protected in sorted(keep):
        if total <= ceiling:
            break
        if protected:
            continue
        shutil.rmtree(folder, ignore_errors=True)
        removed.append(folder)
        total -= size
    return removed


def resolve_open_path(path):
    """What htslib/pyBigWig should open for ``path`` (unchanged unless a reference)."""
    if not is_source_ref(path):
        return path
    source = source_for_ref(path)
    if source is None:
        raise RemoteSourceError(f"No source handles {path}")
    return source.open_url(path)


def _index_candidates(path: str) -> tuple[str, ...]:
    stem = path[:-4] if path.lower().endswith(".bam") else path
    return (path + ".bai", stem + ".bai", path + ".csi", stem + ".csi")


def _index_lock(ref: str) -> threading.Lock:
    with _index_locks_guard:
        return _index_locks.setdefault(ref, threading.Lock())


def cached_index_for(ref: str) -> Optional[str]:
    """Local copy of the index of a referenced BAM, or None when it has none.

    Valid for one version of the BAM: a replaced BAM (or index) gets a fresh
    copy, never the previous file's.
    """
    source = source_for_ref(ref)
    bam_version = version_of(_stat(source, ref))
    memo = _index_memo.get(ref)
    if (memo and time.time() - memo[0] < _INDEX_TTL and memo[1] == bam_version
            and (memo[2] is None or os.path.exists(memo[2]))):
        return memo[2]
    with _index_lock(ref):
        local: Optional[str] = None
        for candidate in _index_candidates(ref):
            info = _stat(source, candidate)
            if not info or info.get("type") != "file":
                continue
            local = _cached_copy("index", source, candidate, info, MAX_INDEX_BYTES, extra_key=f"bam={bam_version}")
            break
        _index_memo[ref] = (time.time(), bam_version, local)
        return local


def remote_bam_has_index(ref: str) -> bool:
    try:
        return cached_index_for(ref) is not None
    except RemoteSourceError:
        return False


def open_alignment_file(path, mode: str = "rb", **kwargs):
    """``pysam.AlignmentFile`` for a local path, URL or source reference."""
    import pysam

    if "w" not in mode and is_remote_url_bam(path):
        from services.lab.paths import confine_alignment
        confine_alignment(path, mode, kwargs)  # a lab server's URL rules
        return _open_url_bam(path, mode, kwargs)
    if not is_source_ref(path):
        from services.lab.paths import confine_alignment
        confine_alignment(path, mode, kwargs)  # a lab server's data roots (the file and its index)
        from services.lab.paths import native_open  # lab members: from the checked descriptors
        opened = native_open("bam", path, mode, kwargs, lambda target, **kw: pysam.AlignmentFile(target, mode, **kw))
        return opened if opened is not None else pysam.AlignmentFile(path, mode, **kwargs)
    from services.htslib_quiet import quiet_htslib
    url = resolve_open_path(path)
    if "index_filename" not in kwargs and "filepath_index" not in kwargs:
        index = cached_index_for(path)
        if index:
            kwargs["index_filename"] = index
    try:
        with quiet_htslib():  # htslib prints the URL itself when an open fails
            return pysam.AlignmentFile(url, mode, **kwargs)
    except (OSError, ValueError) as exc:
        raise type(exc)(redact(str(exc)) or f"Could not open {path}") from None


# ---------------------------------------------------------------- https:// and s3:// BAMs

_URL_SCHEMES = ("http", "https", "s3")


def is_s3_ref(path) -> bool:
    """``s3://bucket/key`` (or its ``##idx##`` form)."""
    return isinstance(path, str) and path[:5].lower() == "s3://"


def is_remote_url_bam(path) -> bool:
    """An ``http(s)://`` or ``s3://`` file (optionally ``<data>##idx##<index>``)."""
    if not isinstance(path, str) or "://" not in path:
        return False
    from services.signed_urls import split_index
    data, _index = split_index(path)
    return data.split("://", 1)[0].lower() in _URL_SCHEMES


def _display(url: str) -> str:
    if is_s3_ref(url):
        return url
    from services.signed_urls import display_url
    return display_url(url)


def _identity(url: str) -> str:
    if is_s3_ref(url):
        return url
    from services.signed_urls import source_identity
    return source_identity(url)


class _HttpFiles:
    """``stat``/``fetch_bytes`` for plain http(s) URLs (what ``_cached_copy`` needs)."""

    timeout = 30.0

    def _request(self, url: str, headers: dict):
        import urllib.request
        return urllib.request.urlopen(
            urllib.request.Request(url, headers={"User-Agent": "FiberBrowser", **headers}),
            timeout=self.timeout)

    def _failure(self, url: str, exc: Exception) -> RemoteSourceError:
        import urllib.error
        if isinstance(exc, urllib.error.HTTPError):
            return RemoteSourceError(f"{_display(url)}: HTTP {exc.code}")
        reason = getattr(exc, "reason", None) or exc
        return RemoteSourceError(f"Cannot reach {_display(url)}: {reason}")

    def stat(self, url: str, max_age=None) -> Optional[dict]:
        import urllib.error
        try:
            with self._request(url, {"Range": "bytes=0-0"}) as resp:
                headers = resp.headers
                status = resp.status
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                return None
            raise self._failure(url, exc) from None
        except OSError as exc:
            raise self._failure(url, exc) from None
        total = (headers.get("Content-Range") or "").rsplit("/", 1)[-1]
        size = int(total) if total.isdigit() else (
            int(headers.get("Content-Length")) if status == 200 and (headers.get("Content-Length") or "").isdigit()
            else None)
        etag, modified = headers.get("ETag"), headers.get("Last-Modified")
        return {"type": "file", "size": size, "mtime": modified, "version": f"{etag}:{size}:{modified}"}

    def fetch_bytes(self, url: str, max_bytes: int) -> bytes:
        try:
            with self._request(url, {}) as resp:
                data = resp.read(max_bytes + 1)
        except OSError as exc:
            raise self._failure(url, exc) from None
        if len(data) > max_bytes:
            raise RemoteSourceError(f"{_display(url)} is larger than {max_bytes // (1024 * 1024)} MB.")
        return data


_HTTP_FILES = _HttpFiles()


def _files_for(url: str):
    if is_s3_ref(url):
        from services.remote_sources import get_source
        return get_source("s3")
    return _HTTP_FILES


def _url_index_candidates(data: str) -> tuple[str, ...]:
    """``.bai``/``.csi`` beside an http(s)/s3 BAM; an ordinary query string is kept
    (a signed one doesn't cover the index: that candidate is refused and skipped)."""
    base, sep, query = data.partition("?")
    return tuple(candidate + sep + query for candidate in _index_candidates(base))


def url_index_for(path: str) -> Optional[str]:
    """Local cached copy of the index of an ``https://``/``s3://`` BAM, or None when it has none.

    ``path`` may name its index explicitly (``<bam>##idx##<index>``). Raises
    :class:`RemoteSourceError` when the BAM (or a named index) can't be
    reached. A replaced BAM or index gets a fresh copy, never the old one.
    """
    from services.signed_urls import split_index
    data, explicit = split_index(path)
    bam_info = _stat(_files_for(data), data)
    if not bam_info:
        raise RemoteSourceError(f"Not found: {_display(data)}")
    bam_version = version_of(bam_info)
    memo = _index_memo.get(path)
    if (memo and time.time() - memo[0] < _INDEX_TTL and memo[1] == bam_version
            and (memo[2] is None or os.path.exists(memo[2]))):
        return memo[2]
    with _index_lock(path):
        local: Optional[str] = None
        for candidate in ((explicit,) if explicit else _url_index_candidates(data)):
            source = _files_for(candidate)
            try:
                info = _stat(source, candidate)
            except RemoteSourceError:
                if explicit:
                    raise
                continue  # e.g. 403 for a candidate a signed URL doesn't cover
            if not info or info.get("type") != "file":
                if explicit:
                    raise RemoteSourceError(f"BAM index not found: {_display(candidate)}")
                continue
            try:
                local = _cached_copy("index", source, candidate, info, MAX_INDEX_BYTES,
                                     extra_key=f"bam={_identity(data)}:{bam_version}",
                                     identity=_identity(candidate))
            except OSError as exc:  # an unwritable home folder, a full disk
                raise RemoteSourceError(
                    f"Could not keep the index of {_display(data)} in {cache_base()} ({exc.strerror or exc}); "
                    f"set {CACHE_ENV} to a writable folder.") from None
            break
        _index_memo[path] = (time.time(), bam_version, local)
        return local


def remote_version(path: str) -> Optional[str]:
    """The current version (ETag/size/date) of an https:// or s3:// file (None: unknown)."""
    from services.signed_urls import split_index
    data, _index = split_index(path)
    return version_of(_stat(_files_for(data), data, fresh=True))


def live_url(path: str) -> str:
    """What htslib opens for an ``s3://`` BAM (an HTTPS URL; may be pre-signed,
    so it is registered as a secret shown as the reference). Other paths unchanged."""
    from services.signed_urls import split_index, register_secret
    data, _index = split_index(path)
    if not is_s3_ref(data):
        return path
    url = _files_for(data).open_url(data)
    if url != data:
        register_secret(url, data)
    return url


def _open_url_bam(path: str, mode: str, kwargs: dict):
    import pysam
    from services.htslib_quiet import quiet_htslib
    from services.signed_urls import split_index

    data, explicit = split_index(path)
    display = _display(data)
    try:
        target = live_url(data)
    except RemoteSourceError as exc:
        raise OSError(str(exc)) from None
    if "index_filename" not in kwargs and "filepath_index" not in kwargs:
        index = None
        try:
            index = url_index_for(path)
        except RemoteSourceError as exc:
            # Never left to htslib: it would save the index in the working
            # directory and reuse any same-named one there for this BAM.
            raise OSError(str(exc)) from None
        if index:
            kwargs["index_filename"] = index
        elif explicit and not is_s3_ref(explicit) and target == data:
            target = path  # htslib's own <bam>##idx##<index> handling
    from contextlib import nullcontext
    from services.signed_urls import looks_signed
    # htslib prints the URL itself when an open fails: silenced when it carries a signature.
    secret = target != data or looks_signed(target) or looks_signed(path)
    try:
        with (quiet_htslib() if secret else nullcontext()):
            return pysam.AlignmentFile(target, mode, **kwargs)
    except (OSError, ValueError) as exc:
        text = str(exc)
        for secret in {target, data, path}:
            if secret and secret != display:
                text = text.replace(secret, display)
        raise type(exc)(redact(text) or f"Could not open {display}") from None


def open_bigwig(path, *args):
    """``pyBigWig.open`` for a local path, URL or source reference (None when it fails)."""
    import pyBigWig

    if not is_source_ref(path):
        from services.lab.paths import confine
        confine(path, write=bool(args) and "w" in str(args[0]), urls=True)  # a lab server's data roots
    if is_s3_ref(path) and not args:
        # pyBigWig can't read s3:// itself: the HTTPS URL boto3 makes (as for BAMs).
        try:
            target = live_url(path)
        except RemoteSourceError as exc:
            raise RuntimeError(str(exc)) from None
    else:
        target = resolve_open_path(path)
    if not args:
        from services.pybigwig_support import check_target
        check_target(target)  # a pyBigWig without libcurl: say so, not "Unknown error during file opening"
    try:
        return pyBigWig.open(target, *args)
    except RuntimeError as exc:
        raise RuntimeError(redact(str(exc)) or f"Could not open {path}") from None


def open_fasta(path, **kwargs):
    """``pysam.FastaFile`` for a local path, URL or source reference (remote .fai/.gzi)."""
    import pysam

    if not is_source_ref(path):
        from services.lab.paths import confine_fasta
        confine_fasta(path, kwargs)  # a lab server's data roots (the FASTA, .fai and .gzi)
        from services.lab.paths import native_open  # lab members: from the checked descriptors
        opened = native_open("fasta", path, "r", kwargs, pysam.FastaFile)
        return opened if opened is not None else pysam.FastaFile(path, **kwargs)
    from services.htslib_quiet import quiet_htslib
    url = resolve_open_path(path)
    try:
        with quiet_htslib():
            return pysam.FastaFile(url, **kwargs)
    except (OSError, ValueError) as exc:
        raise type(exc)(redact(str(exc)) or f"Could not open {path}") from None


def local_copy(ref: str, max_bytes: int = MAX_SMALL_FILE_BYTES) -> str:
    """A cached local copy of a small referenced file (plasmid maps, GTF, BED).

    Keyed by the remote file's version, and kept under its own basename so
    loaders that look at the file name keep working.
    """
    from services.remote_sources import is_browsable_ref
    if not is_browsable_ref(ref):
        return ref
    source = source_for_ref(ref)
    info = _stat(source, ref, fresh=True)
    if not info or info.get("type") != "file":
        raise RemoteSourceError(f"{ref} was not found under the shared folders.")
    if int(info.get("size") or 0) > max_bytes:
        raise RemoteSourceError(f"{ref} is larger than {max_bytes // (1024 * 1024)} MB; open it by range instead.")
    return _cached_copy("files", source, ref, info, max_bytes)
