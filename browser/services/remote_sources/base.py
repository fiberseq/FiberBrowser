"""The storage-source interface behind "Connect to cluster…" and the remote file browser.

A *source* turns references like ``ssh://hpc/projects/lab/x.bam`` or
``s3://bucket/x.bam`` into something FiberBrowser can read. Datasets,
sessions and the Library store only the reference; the live URL (which may
carry a per-connection secret) is made at open time and never stored.

To add a storage source, write one module with a ``RemoteSource`` subclass
and call ``register_source(MySource())`` (see ``services/remote_sources/__init__.py``).
"""
from __future__ import annotations

from typing import Any, Optional


class RemoteSourceError(RuntimeError):
    """A user-facing error from a source (never contains secrets)."""


class RemoteReadError(OSError):
    """Reading an open remote file (https://, s3://, ssh://) failed mid-way: the
    network or the store went away. The request fails with this message instead
    of answering with the reads it got so far (or none)."""


class RemoteFileChanged(RemoteSourceError):
    """The remote file was replaced or rewritten while it was being copied."""


class NotConnectedError(RemoteSourceError):
    """The reference's source/host is not connected right now."""

    def __init__(self, message: str, *, scheme: str, target: str):
        super().__init__(message)
        self.scheme = scheme
        self.target = target


class RemoteSource:
    """One kind of remote storage.

    Subclasses set ``scheme`` (the reference prefix, e.g. ``"ssh"``) and
    ``label`` and implement the methods below. References always have the
    form ``<scheme>://<target>/<path>``; ``target`` names the connection
    (an SSH host alias with optional ``user@``, an S3 bucket).
    """

    scheme: str = ""
    label: str = ""
    #: True when the source opens byte ranges through a URL htslib/pyBigWig can read.
    range_access: bool = True

    # -- connections -----------------------------------------------------
    def describe(self) -> dict[str, Any]:
        """Status for the UI: availability and the current connections (no secrets)."""
        raise NotImplementedError

    def connect(self, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def disconnect(self, target: str, **options) -> dict[str, Any]:
        raise NotImplementedError

    def is_connected(self, ref: str) -> bool:
        raise NotImplementedError

    # -- browsing --------------------------------------------------------
    def list(self, ref: str) -> dict[str, Any]:
        """``{"path", "entries": [{name, type, size, mtime}], "truncated"}`` for a folder ref."""
        raise NotImplementedError

    def stat(self, ref: str) -> Optional[dict[str, Any]]:
        """``{"size", "mtime", "type"}`` or None when missing."""
        raise NotImplementedError

    # -- opening ---------------------------------------------------------
    def open_url(self, ref: str) -> str:
        """A URL (or path) htslib and pyBigWig can range-read for ``ref``.

        May embed a per-connection secret: callers must not store or show it.
        """
        raise NotImplementedError

    def fetch_bytes(self, ref: str, max_bytes: int) -> bytes:
        """The whole (small) file."""
        raise NotImplementedError
