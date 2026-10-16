"""Thread-safe reference FASTA access through bounded shared readers."""
from __future__ import annotations

import os
from typing import Optional

from services.file_handles import handles, file_stamp


def get_fasta_handle(path: str):
    """A shared FASTA reader; native fetches are serialized per file."""
    from services.remote_sources import is_source_ref
    from services.remote_sources import opening as op

    path = os.fspath(path)
    remote = is_source_ref(path)
    def version():
        if remote:
            return op.resolve_open_path(path)
        from services.lab.paths import confine_fasta
        confine_fasta(path, {})
        return file_stamp(path, (path + '.fai', path + '.gzi'))
    return handles.get('fasta', path, lambda: op.open_fasta(path),
                       version,
                       max_idle=op.REMOTE_HANDLE_MAX_IDLE if remote else None)


def release_fasta_handle(path: str) -> None:
    """Retire this reference across every worker pool."""
    handles.discard(path, kind='fasta')


def close_all_fasta_handles() -> None:
    """Retire every reference, closing after any active fetch finishes."""
    handles.discard(kind='fasta')


class ThreadLocalFasta:
    """A FASTA reference whose reads use shared, synchronized handles.

    Opening one validates the file and its index (pysam raises as before) and
    records the sequence names and lengths, which never change.
    """

    def __init__(self, path: str):
        self.filename = os.fspath(path)
        handle = get_fasta_handle(self.filename)
        self.references = tuple(handle.references)
        self.lengths = tuple(int(n) for n in handle.lengths)
        self._lengths = dict(zip(self.references, self.lengths))
        self.closed = False

    @property
    def nreferences(self) -> int:
        return len(self.references)

    def get_reference_length(self, reference: str) -> int:
        try:
            return self._lengths[reference]
        except KeyError:
            raise KeyError(f"sequence '{reference}' not present") from None

    def fetch(self, reference: Optional[str] = None, start: Optional[int] = None,
              end: Optional[int] = None, region: Optional[str] = None) -> str:
        if self.closed:
            raise ValueError("I/O operation on closed file")
        handle = get_fasta_handle(self.filename)
        if region is not None:
            return handle.fetch(region=region)
        return handle.fetch(reference, start, end)

    def close(self) -> None:
        """Close the shared reader after its current fetch; other views can reopen it."""
        self.closed = True
        release_fasta_handle(self.filename)

    def __contains__(self, reference: str) -> bool:
        return reference in self._lengths

    def __repr__(self) -> str:
        return f"ThreadLocalFasta({self.filename!r}, {self.nreferences} sequences)"
