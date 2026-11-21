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
    groups: Dict[str, List[Mark]]            # 'nucsz', 'nucseg', 'nucreg'
    nucmol: List[int]                        # the nucmol group's bytes (CONTRACTS §11.3 codecs)
    scalars: Dict[str, Optional[float]]      # exact values (live) or decoded bytes (annotated BAMs)
    source: str = 'live'                     # 'live' | 'scan:<scan id>'
    low_information: bool = False
    #: the regularity parameters' digest (8 hex) of the ``nucreg`` marks ('' without them); never part of ``config``
    regularity_digest: str = ''

    def to_json(self) -> dict:
        return dict(qname=self.qname, inputIndex=self.input_index, chrom=self.chrom, refStart=self.ref_start,
                    refEnd=self.ref_end, reverse=self.reverse, supplementary=self.supplementary, hp=self.hp,
                    groups={g: [list(m[:4]) + [list(m[4]), m[5]] for m in marks] for g, marks in self.groups.items()},
                    scalars=self.scalars, source=self.source, lowInformation=self.low_information,
                    regularityDigest=self.regularity_digest)


@dataclass
class _FileOutputs:
    config: Tuple[str, str]                  # (settings_hash, calibration digest)
    rows: Dict[Tuple[str, int], RecordOutputs] = field(default_factory=dict)
    revision: int = 0
    #: records FiberHMM could not decode (no calls, a hard-clipped record, no evidence): why
    failed: Dict[Tuple[str, int], str] = field(default_factory=dict)
    #: (chrom, start, end) regions a compute finished under this configuration (BAM contig names)
    regions: List[Tuple[str, int, int]] = field(default_factory=list)


class NucStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._files: Dict[str, _FileOutputs] = {}
        self._results: "OrderedDict[Tuple[str, str, int, Tuple[str, str]], tuple]" = OrderedDict()
        self._serial = 0

    def _path(self, path: str) -> str:
        # Record joins already carry canonical paths. Avoid walking every directory component again on
        # each lookup; aliases still go through realpath, so retargeting a symlink remains observable.
        return path if path in self._files else real(path)

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
            cur = self._files.get(self._path(path))
            return cur.config if cur is not None else None

    # ---- rows
    def put(self, path: str, config: Tuple[str, str], items: Iterable[Tuple[Tuple[str, int], RecordOutputs]]) -> int:
        p = real(path)
        added = 0
        with self._lock:
            cur = self._files.get(p)
            if cur is None or cur.config != config:
                return 0
            changed = False
            for key, out in items:
                if key not in cur.rows:
                    added += 1
                changed |= cur.rows.get(key) is not out
                cur.rows[key] = out
            if changed:
                self._serial += 1
                cur.revision = self._serial
        return added

    def put_failed(self, path: str, config: Tuple[str, str], items: Iterable[Tuple[Tuple[str, int], str]]) -> None:
        with self._lock:
            cur = self._files.get(real(path))
            if cur is None or cur.config != config:
                return
            for key, why in items:
                if cur.failed.get(key) != why:
                    self._serial += 1
                    cur.revision = self._serial
                cur.failed[key] = why

    def mark_region(self, path: str, config: Tuple[str, str], chrom: str, start: int, end: int) -> None:
        """A compute finished every record of ``[start, end)`` on ``chrom`` under ``config``."""
        with self._lock:
            cur = self._files.get(real(path))
            if cur is not None and cur.config == config:
                cur.regions.append((str(chrom), int(start), int(end)))
                if len(cur.regions) > 4096:
                    del cur.regions[:len(cur.regions) - 4096]

    def touches(self, path: str, chrom_names, start: int, end: int) -> bool:
        """Whether anything was computed over ``[start, end)`` of the file (a finished region, a stored row or a
        record of a partial compute); ``chrom_names``: the contig's names (the view's and the BAM's)."""
        names = set(chrom_names)
        with self._lock:
            cur = self._files.get(self._path(path))
            if cur is None:
                return False
            if any(c in names and a < end and b > start for c, a, b in cur.regions):
                return True
            return any(r.chrom in names and r.ref_start < end and r.ref_end > start for r in cur.rows.values())

    def token(self, paths) -> tuple:
        """All output changes, including failures and empty configurations (for observation caches)."""
        with self._lock:
            return tuple((p, self._files[p].config, self._files[p].revision)
                         if p in self._files else (p, None) for p in paths)

    def failed(self, path: str, sha: str, occ: int) -> Optional[str]:
        """Why FiberHMM could not decode a record of this configuration (None: not tried, or decoded)."""
        with self._lock:
            cur = self._files.get(self._path(path))
            return cur.failed.get((str(sha), int(occ))) if cur is not None else None

    def get(self, path: str, sha: str, occ: int) -> Optional[RecordOutputs]:
        with self._lock:
            cur = self._files.get(self._path(path))
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

    def results_of(self, path: str, config: Tuple[str, str]) -> Dict[Tuple[str, int], tuple]:
        """The cached (molecule, result) pairs of a file under ``config``, by record key (no LRU touch)."""
        p = self._path(path)
        with self._lock:
            return {(k[1], k[2]): v for k, v in self._results.items() if k[0] == p and k[3] == config}

    def get_result(self, path: str, sha: str, occ: int, config: Tuple[str, str]):
        with self._lock:
            key = (self._path(path), str(sha), int(occ), config)
            hit = self._results.get(key)
            if hit is not None:
                self._results.move_to_end(key)
            return hit


STORE = NucStore()


def nuc_identity(dataset, regularity: bool = True) -> tuple:
    """What a dataset's rows depend on through the nucleosome store: per file with outputs, its configuration
    and revision (() when none): part of the read caches' identity. ``regularity``: with the regularity tiles' and
    patches' revisions (rows carrying nucreg or nucpatch depend on them; the others do not)."""
    out = []
    for p in getattr(dataset, 'paths', None) or ():
        if not isinstance(p, str) or '://' in p:
            continue
        rev = STORE.revision(p)
        if rev is not None:
            if regularity:
                # (the geometry labels are not part of it: the linear lanes take them as an overlay and the graph
                # panel's composed rows draw no patches, so a relabel never evicts composed rows)
                from .regularity import revision as reg_revision
                from .nucgeo import revision as geo_revision
                out.append((rev[0], rev[1], reg_revision(p), geo_revision(p)))
            else:
                out.append((rev[0], rev[1]))
    return ('nuc', tuple(out)) if out else ()


def regularity_identity(dataset) -> tuple:
    """The revisions of a dataset's regularity tiles and patches, per file with outputs (() when none): what rows
    carrying nucreg or nucpatch depend on beyond the dataset's source identity."""
    out = []
    for p in getattr(dataset, 'paths', None) or ():
        if not isinstance(p, str) or '://' in p or STORE.revision(p) is None:
            continue
        from .regularity import revision as reg_revision
        from .nucgeo import revision as geo_revision
        out.append((reg_revision(p), geo_revision(p)))
    return tuple(out)


def patch_labels_identity(dataset) -> str:
    """The content identity of a dataset's nucpatch geometry labels ('' without any): the read lanes fetch the labels
    (``/api/nuc/patch_labels``) when it moves, without reloading their rows."""
    out = []
    for p in getattr(dataset, 'paths', None) or ():
        if not isinstance(p, str) or '://' in p or STORE.revision(p) is None:
            continue
        from .nucgeo import labels_revision
        out.append(labels_revision(p))
    return '.'.join(out) if any(out) else ''
