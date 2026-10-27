"""Per-record nucleosome outputs, keyed by the source record (NUC §5.2 "record-key joins").

A record is named as FiberHMM and the compact-read loader name it: its BAM file, the SHA-256 of its SAM text and
its identical-record occurrence (``record_sha256``, ``alignment_occurrence``). A row of any frame (a native row,
a lifted row, a graph row) carries that identity, so outputs join it with no BAM re-read; split lifted rows of
one record share them.

The store is process-wide (outputs depend only on the file, the nuc settings and the calibration) and holds,
per BAM file, one configuration (settings hash + calibration digest): computing with another configuration
replaces the file's outputs. Each change bumps the file's revision, which enters the read caches' identity
(``nuc_identity``) so rows built before it are rebuilt with the new layers.

Besides the rows (``RecordOutputs``) the store keeps, in a bounded cache, each record's decoded molecule and
FiberHMM ``MoleculeResult`` for window metrics and phasing.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

from .inputs import real

#: (mol_start, mol_len, ref_start, ref_end, quality bytes, AN name): one mark of an MA group
Mark = Tuple[int, int, int, int, Tuple[int, ...], str]
MAX_RESULTS = 60_000


@dataclass
class RecordOutputs:
    qname: str
    input_index: int
    chrom: str
    ref_start: int
    ref_end: int
    reverse: bool
    supplementary: bool
    hp: Optional[int]
    groups: Dict[str, List[Mark]]            # 'nucsz', 'nucseg'
    nucmol: List[int]                        # the nucmol group's bytes (CONTRACTS §11.3 codecs)
    scalars: Dict[str, Optional[float]]      # exact values (live) or decoded bytes (annotated BAMs)
    source: str = 'live'                     # 'live' | 'scan:<scan id>'
    low_information: bool = False

    def to_json(self) -> dict:
        return dict(qname=self.qname, inputIndex=self.input_index, chrom=self.chrom, refStart=self.ref_start,
                    refEnd=self.ref_end, reverse=self.reverse, supplementary=self.supplementary, hp=self.hp,
                    groups={g: [list(m[:4]) + [list(m[4]), m[5]] for m in marks] for g, marks in self.groups.items()},
                    scalars=self.scalars, source=self.source, lowInformation=self.low_information)


@dataclass
class _FileOutputs:
    config: Tuple[str, str]                  # (settings_hash, calibration digest)
    rows: Dict[Tuple[str, int], RecordOutputs] = field(default_factory=dict)
    revision: int = 0
    #: records FiberHMM could not decode (no calls, a hard-clipped record, no evidence): why
    failed: Dict[Tuple[str, int], str] = field(default_factory=dict)


class NucStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._files: Dict[str, _FileOutputs] = {}
        self._results: "OrderedDict[Tuple[str, str, int, Tuple[str, str]], tuple]" = OrderedDict()
        self._serial = 0

    # ---- configuration
    def configure(self, path: str, config: Tuple[str, str]) -> bool:
        """Use ``config`` for ``path``; returns True when it replaced another configuration's outputs."""
        p = real(path)
        with self._lock:
            cur = self._files.get(p)
            if cur is not None and cur.config == config:
                return False
            self._serial += 1
            self._files[p] = _FileOutputs(config, revision=self._serial)
            for key in [k for k in self._results if k[0] == p and k[3] != config]:
                self._results.pop(key, None)
            return cur is not None

    def config_of(self, path: str) -> Optional[Tuple[str, str]]:
        with self._lock:
            cur = self._files.get(real(path))
            return cur.config if cur is not None else None

    # ---- rows
    def put(self, path: str, config: Tuple[str, str], items: Iterable[Tuple[Tuple[str, int], RecordOutputs]]) -> int:
        p = real(path)
        added = 0
        with self._lock:
            cur = self._files.get(p)
            if cur is None or cur.config != config:
                return 0
            for key, out in items:
                if key not in cur.rows:
                    added += 1
                cur.rows[key] = out
            if added:
                self._serial += 1
                cur.revision = self._serial
        return added

    def put_failed(self, path: str, config: Tuple[str, str], items: Iterable[Tuple[Tuple[str, int], str]]) -> None:
        with self._lock:
            cur = self._files.get(real(path))
            if cur is None or cur.config != config:
                return
            for key, why in items:
                cur.failed[key] = why

    def failed(self, path: str, sha: str, occ: int) -> Optional[str]:
        """Why FiberHMM could not decode a record of this configuration (None: not tried, or decoded)."""
        with self._lock:
            cur = self._files.get(real(path))
            return cur.failed.get((str(sha), int(occ))) if cur is not None else None

    def get(self, path: str, sha: str, occ: int) -> Optional[RecordOutputs]:
        with self._lock:
            cur = self._files.get(real(path))
            return cur.rows.get((str(sha), int(occ))) if cur is not None else None

    def has(self, path: str, sha: str, occ: int) -> bool:
        return self.get(path, sha, occ) is not None

    def rows_of(self, path: str) -> Dict[Tuple[str, int], RecordOutputs]:
        with self._lock:
            cur = self._files.get(real(path))
            return dict(cur.rows) if cur is not None else {}

    def has_rows(self, path: str) -> bool:
        with self._lock:
            cur = self._files.get(real(path))
            return bool(cur is not None and cur.rows)

    def revision(self, path: str) -> Optional[Tuple[Tuple[str, str], int, int]]:
        with self._lock:
            cur = self._files.get(real(path))
            return (cur.config, cur.revision, len(cur.rows)) if cur is not None and cur.rows else None

    def clear(self, path: Optional[str] = None) -> None:
        with self._lock:
            if path is None:
                self._files.clear()
                self._results.clear()
                return
            p = real(path)
            self._files.pop(p, None)
            for key in [k for k in self._results if k[0] == p]:
                self._results.pop(key, None)

    # ---- decoded molecules and results (window metrics, phasing)
    def put_result(self, path: str, sha: str, occ: int, config: Tuple[str, str], mol, result) -> None:
        key = (real(path), str(sha), int(occ), config)
        with self._lock:
            self._results[key] = (mol, result)
            self._results.move_to_end(key)
            while len(self._results) > MAX_RESULTS:
                self._results.popitem(last=False)

    def get_result(self, path: str, sha: str, occ: int, config: Tuple[str, str]):
        key = (real(path), str(sha), int(occ), config)
        with self._lock:
            hit = self._results.get(key)
            if hit is not None:
                self._results.move_to_end(key)
            return hit


STORE = NucStore()


def nuc_identity(dataset) -> tuple:
    """What a dataset's rows depend on through the nucleosome store: per file with outputs, its configuration
    and revision (() when none): part of the read caches' identity."""
    out = []
    for p in getattr(dataset, 'paths', None) or ():
        if not isinstance(p, str) or '://' in p:
            continue
        rev = STORE.revision(p)
        if rev is not None:
            out.append((rev[0], rev[1]))
    return ('nuc', tuple(out)) if out else ()
