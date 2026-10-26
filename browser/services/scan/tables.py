"""Region queries over a scan directory's bgzip + tabix tables (pysam only; no FiberHMM import).

Every table starts with ``chrom start end idx_start idx_end`` and one ``#`` header line naming its columns.
``idx_start`` / ``idx_end`` are what tabix indexes: they equal ``start`` / ``end`` except for zero-width rows,
which index ``[p, p + 1)`` so a fetch at ``p`` finds them. Coordinates are 0-based half-open. Empty cells are
empty strings. Format: FiberHMM ``docs/reference/scan-format.md`` (contract ``fiberhmm.scan.v1``).
"""
from __future__ import annotations

import gzip
import threading
from pathlib import Path
from typing import Dict, Iterator, List, Optional

COMMON = ('chrom', 'start', 'end', 'idx_start', 'idx_end')
INT_COLUMNS = frozenset({'start', 'end', 'idx_start', 'idx_end', 'anchor', 'zone_start', 'zone_end', 'n_molecules',
                         'n_callable', 'records', 'mol_start', 'mol_len'})


def index_path(path) -> Optional[Path]:
    """The table's index (``.csi`` for tables beyond 2^29, else ``.tbi``), or None."""
    p = Path(path)
    for suffix in ('.csi', '.tbi'):
        q = Path(str(p) + suffix)
        if q.is_file():
            return q
    return None


def read_header(path) -> List[str]:
    """The column names of a scan table (its first line, without the leading ``#``)."""
    with gzip.open(path, 'rt') as handle:
        first = handle.readline().rstrip('\n')
    if not first.startswith('#'):
        raise ValueError(f'{Path(path).name}: no header line')
    cols = first[1:].split('\t')
    if tuple(cols[:5]) != COMMON:
        raise ValueError(f'{Path(path).name}: a scan table starts with {", ".join(COMMON)}')
    return cols


def _typed(cols: List[str], cells: List[str]) -> dict:
    row = {}
    for name, value in zip(cols, cells):
        if name in INT_COLUMNS and value != '':
            try:
                row[name] = int(value)
                continue
            except ValueError:
                pass
        row[name] = value
    return row


def iter_rows(path) -> Iterator[dict]:
    """Every row of a table, in file order, without opening its index (small tables: units, callable)."""
    with gzip.open(path, 'rt') as handle:
        first = handle.readline().rstrip('\n')
        cols = first[1:].split('\t') if first.startswith('#') else list(COMMON)
        for line in handle:
            yield _typed(cols, line.rstrip('\n').split('\t'))


class Table:
    """One indexed table. ``fetch`` returns rows (dicts; integer columns parsed) overlapping a region."""

    def __init__(self, path):
        import pysam
        self.path = Path(path)
        idx = index_path(self.path)
        if idx is None:
            raise FileNotFoundError(f'{self.path.name}: no tabix index (.tbi or .csi)')
        self.columns = read_header(self.path)
        self._lock = threading.Lock()
        self._tabix = pysam.TabixFile(str(self.path), index=str(idx))
        self.contigs = set(self._tabix.contigs)

    def fetch(self, chrom: str, start: Optional[int] = None, end: Optional[int] = None) -> List[dict]:
        if chrom not in self.contigs:
            return []
        with self._lock:
            if start is None:
                lines = list(self._tabix.fetch(chrom))
            else:
                lines = list(self._tabix.fetch(chrom, max(0, int(start)), max(int(start) + 1, int(end))))
        return [_typed(self.columns, line.split('\t')) for line in lines]

    def rows(self) -> Iterator[dict]:
        """Every row, in file order (small tables only: units, callable)."""
        with gzip.open(self.path, 'rt') as handle:
            handle.readline()
            for line in handle:
                yield _typed(self.columns, line.rstrip('\n').split('\t'))

    def close(self) -> None:
        with self._lock:
            try:
                self._tabix.close()
            except Exception:  # pragma: no cover - already closed
                pass


class TableSet:
    """The tables of one scan directory, opened lazily and kept open."""

    def __init__(self, root: Path, listed: Dict[str, dict]):
        self.root = Path(root)
        self.listed = dict(listed or {})
        self._open: Dict[str, Table] = {}
        self._lock = threading.Lock()

    def has(self, rel: str) -> bool:
        return rel in self.listed and (self.root / rel).is_file()

    def table(self, rel: str) -> Optional[Table]:
        if not self.has(rel):
            return None
        with self._lock:
            t = self._open.get(rel)
            if t is None:
                t = self._open[rel] = Table(self.root / rel)
            return t

    def fetch(self, rel: str, chrom: str, start: Optional[int] = None, end: Optional[int] = None) -> List[dict]:
        t = self.table(rel)
        return t.fetch(chrom, start, end) if t is not None else []

    def close(self) -> None:
        with self._lock:
            for t in self._open.values():
                t.close()
            self._open.clear()
