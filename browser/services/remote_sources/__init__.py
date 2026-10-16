"""Pluggable remote storage sources (SSH clusters, S3 buckets, ...).

Datasets, sessions and the Library keep *references* such as
``ssh://hpc/projects/lab/run1.bam`` or ``s3://bucket/run1.bam``. The
source registered for the reference's scheme turns it into something
htslib/pyBigWig can read when a file is opened (``opening.py``).

Adding a storage source is one module::

    from services.remote_sources import register_source
    from services.remote_sources.base import RemoteSource

    class MySource(RemoteSource):
        scheme = "mystore"
        label = "My storage"
        ...  # describe / connect / disconnect / is_connected / list / stat / open_url / fetch_bytes

    register_source(MySource())

and one import line in ``_load_builtin_sources`` below.
"""
from __future__ import annotations

import threading
from typing import Optional

from services.remote_sources.base import NotConnectedError, RemoteSource, RemoteSourceError

__all__ = [
    "NotConnectedError", "RemoteSource", "RemoteSourceError",
    "register_source", "get_source", "source_for_ref", "all_sources",
    "is_source_ref", "is_browsable_ref", "ref_scheme", "SOURCE_SCHEMES",
]

_SOURCES: dict[str, RemoteSource] = {}
_LOCK = threading.Lock()
_LOADED = False

# Schemes that are references handled by a source (not plain http URLs).
SOURCE_SCHEMES = ("ssh",)


def register_source(source: RemoteSource) -> None:
    if not source.scheme or not source.scheme.isalnum():
        raise ValueError("A source needs an alphanumeric scheme")
    with _LOCK:
        _SOURCES[source.scheme] = source


def _load_builtin_sources() -> None:
    global _LOADED
    if _LOADED:
        return
    with _LOCK:
        if _LOADED:
            return
        _LOADED = True
    from services.remote_sources.ssh_source import SshSource
    from services.remote_sources.s3_source import S3Source
    register_source(SshSource())
    register_source(S3Source())


def all_sources() -> list[RemoteSource]:
    _load_builtin_sources()
    return list(_SOURCES.values())


def get_source(scheme: str) -> Optional[RemoteSource]:
    _load_builtin_sources()
    return _SOURCES.get(scheme)


def ref_scheme(path) -> Optional[str]:
    if not isinstance(path, str) or "://" not in path:
        return None
    scheme = path.split("://", 1)[0].lower()
    return scheme if scheme.isalnum() else None


def is_source_ref(path) -> bool:
    """True for references a source resolves at open time (``ssh://`` ...).

    ``s3://`` stays with the existing S3 code paths (htslib reads it natively),
    so it is not listed here even though the S3 source can browse it.
    """
    return ref_scheme(path) in SOURCE_SCHEMES


def is_browsable_ref(path) -> bool:
    """A reference some registered source can stat and fetch (``ssh://``, ``s3://``)."""
    scheme = ref_scheme(path)
    return bool(scheme) and get_source(scheme) is not None


def source_for_ref(path: str) -> Optional[RemoteSource]:
    scheme = ref_scheme(path)
    return get_source(scheme) if scheme else None
