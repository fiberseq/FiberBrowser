"""Open .cool/.mcool contact maps from a local path or ``s3://``.

cooler and h5py open file names only: ``cooler.Cooler("s3://...")`` fails
("unable to open file") whatever is installed. An ``s3://`` map is read
through an HTTPS URL made by boto3 (``S3Manager.open_url``: pre-signed for a
private object, plain for a public one, at the configured endpoint), by range,
as a file object h5py can open. So contact maps use the same S3 settings as
BAMs and BigBeds, and need no s3fs.

The URL is asked for again before every range request: a pre-signed URL is
renewed by ``S3Manager`` before it expires, so a map left open for hours keeps
reading.
"""
from __future__ import annotations

import io
import threading
from collections import OrderedDict
from typing import Callable, Optional

BLOCK_BYTES = 1 << 20  # one range request reads this much
MAX_BLOCKS = 64  # blocks kept per open map (64 MB)
MAX_OPEN_MAPS = 4
TIMEOUT_S = 60.0


def is_remote_cool(path) -> bool:
    return isinstance(path, str) and path.startswith("s3://")


class RangeFile(io.RawIOBase):
    """A read-only, seekable file over HTTP range requests, with a block cache."""

    def __init__(self, url_for: Callable[[], str], display: str, *, block: int = BLOCK_BYTES,
                 max_blocks: int = MAX_BLOCKS, session=None, on_replaced: Optional[Callable[[], None]] = None):
        super().__init__()
        self._on_replaced = on_replaced
        self._url_for = url_for
        self.name = display
        self._block = int(block)
        self._max_blocks = int(max_blocks)
        self._blocks: OrderedDict[int, bytes] = OrderedDict()
        self._pos = 0
        self._lock = threading.RLock()
        if session is None:
            import requests
            session = requests.Session()
        self._session = session
        self._etag: Optional[str] = None
        self._size = self._fetch_size()

    # -- network -----------------------------------------------------------------
    def _get(self, start: int, end: int):
        headers = {"Range": f"bytes={start}-{end}"}
        if self._etag:
            headers["If-Match"] = self._etag  # never mix blocks of a replaced file
        url = self._url_for()
        try:
            return self._session.get(url, headers=headers, timeout=TIMEOUT_S)
        except Exception as exc:  # connection refused, DNS, timeout
            raise OSError(f"Cannot read {self.name}: {type(exc).__name__}") from None

    def _checked(self, response, start: int):
        if response.status_code == 206:
            return response
        if response.status_code == 200 and start == 0:
            return response  # a server without range support sent everything
        if response.status_code == 412:
            if self._on_replaced is not None:
                self._on_replaced()  # a reload then opens the new object
            raise OSError(f"{self.name} was replaced on the server since it was opened: load the contact map again")
        if response.status_code in (401, 403):
            raise OSError(f"{self.name}: access denied (HTTP {response.status_code})")
        if response.status_code == 404:
            raise OSError(f"{self.name}: not found")
        raise OSError(f"{self.name}: HTTP {response.status_code}")

    def _fetch_size(self) -> int:
        response = self._checked(self._get(0, 0), 0)
        self._etag = response.headers.get("ETag") or None
        total = (response.headers.get("Content-Range") or "").rsplit("/", 1)[-1]
        if total.isdigit():
            return int(total)
        length = response.headers.get("Content-Length")
        if response.status_code == 200 and length and length.isdigit():
            return int(length)
        raise OSError(f"{self.name}: the server did not report the file size")

    def _block_data(self, index: int) -> bytes:
        data = self._blocks.get(index)
        if data is not None:
            self._blocks.move_to_end(index)
            return data
        start = index * self._block
        end = min(self._size, start + self._block) - 1
        response = self._checked(self._get(start, end), start)
        data = response.content
        if response.status_code == 200:
            data = data[start:end + 1]
        if len(data) != end - start + 1:
            raise OSError(f"{self.name}: short read at byte {start}")
        self._blocks[index] = data
        while len(self._blocks) > self._max_blocks:
            self._blocks.popitem(last=False)
        return data

    # -- io.RawIOBase --------------------------------------------------------------
    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        with self._lock:
            if whence == io.SEEK_SET:
                pos = offset
            elif whence == io.SEEK_CUR:
                pos = self._pos + offset
            elif whence == io.SEEK_END:
                pos = self._size + offset
            else:
                raise ValueError(f"invalid whence {whence}")
            if pos < 0:
                raise ValueError("negative seek position")
            self._pos = pos
            return pos

    def readinto(self, buffer) -> int:
        with self._lock:
            view = memoryview(buffer).cast("B")
            want = min(len(view), max(0, self._size - self._pos))
            done = 0
            while done < want:
                pos = self._pos + done
                index, offset = divmod(pos, self._block)
                data = self._block_data(index)
                take = min(want - done, len(data) - offset)
                view[done:done + take] = data[offset:offset + take]
                done += take
            self._pos += done
            return done

    def close(self) -> None:
        try:
            self._session.close()
        except Exception:
            pass
        self._blocks.clear()
        super().close()


# s3 ref -> (h5py.File, RangeFile, serial). Entries are dropped, never closed,
# when evicted or when the S3 settings change: a Cooler built on one (the
# loaded map, microc_matrix's per-resolution handles) keeps its file. Such a
# file stops reading once the settings change (_s3_url_for), with a message.
_open_maps: OrderedDict[str, tuple] = OrderedDict()
_open_lock = threading.Lock()
_serial = 0


def _s3_url_for(ref: str) -> Callable[[], str]:
    from s3_utils import s3_manager
    from services.signed_urls import register_secret
    s3_manager._ensure_configured()  # a first use configures: not a change of settings
    generation = s3_manager.generation

    def url_for() -> str:
        if s3_manager.generation != generation:
            raise OSError(f"The S3 settings changed since {ref} was opened: load the contact map again")
        url = s3_manager.open_url(ref)
        if url != ref:
            register_secret(url, ref)  # never printed or logged in full
        return url

    return url_for


def _current(ref: str):
    from s3_utils import s3_manager
    entry = _open_maps.get(ref)
    if entry is not None and entry[3] != s3_manager.generation:
        _open_maps.pop(ref, None)  # opened under other S3 settings
        return None
    return entry


def map_serial(cool_file: str) -> Optional[int]:
    """Which opening of an ``s3://`` map is current (None: local, or not open):
    caches of objects built on the map key on it, so a reloaded map is reread."""
    if not is_remote_cool(cool_file):
        return None
    with _open_lock:
        entry = _current(cool_file)
        return entry[2] if entry is not None else None


def map_token(cool_file: str, h5py_module=None) -> Optional[int]:
    """``map_serial`` of the current opening, opening the map if it isn't (an
    evicted map's caches must not share the key None with a later opening)."""
    if not is_remote_cool(cool_file):
        return None
    remote_h5(cool_file, h5py_module)
    return map_serial(cool_file)


def remote_h5(ref: str, h5py_module=None):
    """The h5py file of an ``s3://`` map, opened once and shared (h5py serialises access)."""
    global _serial
    with _open_lock:
        entry = _current(ref)
        if entry is not None:
            _open_maps.move_to_end(ref)
            return entry[0]
    if h5py_module is None:
        import h5py as h5py_module
    from s3_utils import s3_manager
    if not s3_manager.is_available:
        raise OSError("S3 support is not installed (pip install boto3).")
    s3_manager._ensure_configured()
    generation = s3_manager.generation
    url_for = _s3_url_for(ref)
    url_for()  # a missing object or refused access: a clear error now
    holder: list = []

    def replaced() -> None:
        with _open_lock:
            entry = _open_maps.get(ref)
            if entry is not None and holder and entry[1] is holder[0]:
                _open_maps.pop(ref, None)

    raw = RangeFile(url_for, ref, on_replaced=replaced)
    holder.append(raw)
    try:
        handle = h5py_module.File(raw, "r")
    except Exception as exc:
        raw.close()
        raise OSError(f"{ref} is not a readable .cool/.mcool file: {exc}") from None
    with _open_lock:
        existing = _current(ref)
        if existing is not None:  # another thread opened it meanwhile
            handle.close()
            raw.close()
            return existing[0]
        _serial += 1
        _open_maps[ref] = (handle, raw, _serial, generation)
        while len(_open_maps) > MAX_OPEN_MAPS:
            _open_maps.popitem(last=False)  # dropped, not closed: it may still be in use
    return handle


def forget_remote_maps(*, close: bool = False) -> None:
    """Forget every open ``s3://`` map; ``close`` also closes them (tests only:
    a map still in use would stop reading)."""
    with _open_lock:
        entries = list(_open_maps.values())
        _open_maps.clear()
    if close:
        for handle, raw, *_rest in entries:
            for item in (handle, raw):
                try:
                    item.close()
                except Exception:
                    pass


def open_cooler(cooler_module, cool_file: str, resolution: Optional[int] = None, h5py_module=None):
    """``cooler.Cooler`` for a local or ``s3://`` map, at ``resolution`` for an .mcool."""
    if not is_remote_cool(cool_file):
        uri = f"{cool_file}::/resolutions/{resolution}" if resolution is not None else cool_file
        return cooler_module.Cooler(uri)
    handle = remote_h5(cool_file, h5py_module)
    group = handle[f"resolutions/{resolution}"] if resolution is not None else handle
    return cooler_module.Cooler(group)


def mcool_resolutions(cool_file: str, h5py_module=None) -> list[int]:
    """The resolutions stored in an .mcool (local or ``s3://``), smallest first."""
    if h5py_module is None:
        import h5py as h5py_module
    if is_remote_cool(cool_file):
        return sorted(int(r) for r in remote_h5(cool_file, h5py_module)["resolutions"].keys())
    with h5py_module.File(cool_file, "r") as handle:
        return sorted(int(r) for r in handle["resolutions"].keys())
