"""Meta-locus pool index: every read overlapping a BED file's anchor windows, without decoding any read.

A meta-locus pools the reads of many sites (a BED file: promoters, peaks) into one virtual locus, ``-flank..+flank``
around each site's anchor, minus-strand sites flipped. The pool can hold millions of reads, so it is an index, not
decoded reads (META_LOCUS_PLAN.md):

- **Sites.** Each BED region gives an anchor (centre / start / end, strand-aware: ``plots_regions.region_window``)
  and a window of ``2 * flank`` bases: ``[a - flank, a + flank)`` on plus and unstranded sites, ``[a - flank + 1,
  a + flank + 1)`` on minus-strand sites, so after the flip both span exactly ``[-flank, flank)`` and the anchor base
  is virtual 0.
- **One pass per dataset**, block by block (nearby windows read once, ``region_blocks``), reading each record's name,
  extent and BGZF virtual offset only: no tag is parsed, so enumeration costs about the BAM's compressed bytes.
- **Overlap policy** (``policy``). With wide windows (+-10-20 kb around sites a few kb apart) most reads overlap
  several sites' windows. ``per_site`` (default) gives the read an entry in every window it overlaps (``shared``):
  each (read, site) pair is an independent observation of that site (owner), in display, profiles, Plots, counts,
  frequencies and intervals. ``nearest`` keeps one entry, at the site whose anchor is nearest the read's midpoint.
  A molecule has one key and one record either way; counting read names once instead is the ``count_unit`` option
  ("molecule"), off by default. A read crossing a block boundary is kept only by the block that owns each of its
  sites, so no entry is made twice.
- **Stable keys**: services/stable_sample ``stable_key(seed, dataset id, read name)``, the rule of every Plots sampler
  and of ``utils/stableSample.ts``, per molecule (its entries share it and stay together in the sampling order). A
  working set is the lowest keys per dataset; "More reads" is the next keys;
  "Resample" is a new seed. The index itself does not depend on the seed.
- **On-disk cache** per dataset, keyed by the BED's content hash, the dataset's file identity (path, size, mtime),
  anchor, flank, policy and overlap rule; entries are stored in a canonical order, so a cache hit, a rebuild and any
  block layout give the same entries and so the same working sets.

Only unmapped and secondary records are left out here. The display's read filters (terminal gaps, duplicates,
signal filters, minimum footprints) apply when reads are decoded (services/meta_locus_decode), where a filtered read
is replaced from the next keys and counted, never silently lost.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from services.plots_regions import region_blocks, region_window
from services.stable_sample import stable_key

CACHE_VERSION = 3  # 3: molecules carry the uncalled flag (reads without footprint calls)
CACHE_DIR_ENV = "FIBERBROWSER_META_LOCUS_CACHE_DIR"
CACHE_MAX_BYTES_ENV = "FIBERBROWSER_META_LOCUS_CACHE_MAX_BYTES"
DEFAULT_CACHE_MAX_BYTES = 1 << 30

# Every tunable, with its default (a request may override any of them).
DEFAULTS = {
    "anchor": "centre",          # centre | start | end (start / end follow the strand)
    "flank_bp": 10_000,          # window = anchor +- flank (owner: +-10-20 kb; up to MAX_FLANK)
    "policy": "per_site",        # per_site: an entry in every window a read overlaps (shared); nearest: one, nearest anchor
    "min_overlap_bp": 1,         # a read joins a site's pool when it overlaps the window by at least this
    "block_max_gap_bp": 20_000,  # windows closer than this are read in one block
    "block_max_len_bp": 250_000,
    "bam_threads": 1,            # htslib decompression threads per open BAM
    "max_entries": 20_000_000,   # a pool with more entries than this stops with an error (~25 B per entry in memory)
}
MAX_FLANK = 50_000
POLICIES = {"per_site": "per_site", "nearest": "nearest", "all": "per_site", "best": "nearest"}
# Blocks are read in the stable order of this seed (not the user's), so a partly built pool is an unbiased sample of
# sites and its provisional working set is representative.
BLOCK_ORDER_SEED = 0


def fast_keys(seed: int, dataset_id: str, names) -> np.ndarray:
    """``stable_key(seed, dataset_id, name)`` for every name, as uint64 (the hash state of the shared prefix is
    computed once and copied per name: about twice as fast as calling stable_key)."""
    from services.stable_sample import _PREFIX
    h0 = hashlib.blake2b(digest_size=8)
    h0.update(_PREFIX)
    h0.update(b"\x1f" + str(int(seed)).encode("ascii"))
    h0.update(b"\x1f" + str(dataset_id).encode("utf-8"))
    copy = h0.copy

    def one(name):
        h = copy()
        h.update(b"\x1f" + name.encode("utf-8"))
        return h.digest()

    return np.frombuffer(b"".join(map(one, names)), dtype=">u8").astype(np.uint64)


class PoolTooLarge(ValueError):
    pass


class Cancelled(Exception):
    pass


def cache_root() -> Path:
    env = os.environ.get(CACHE_DIR_ENV)
    return Path(env).expanduser() if env else Path.home() / ".fiberhmm" / "meta_locus_cache"


def cache_max_bytes() -> int:
    try:
        return int(os.environ.get(CACHE_MAX_BYTES_ENV, DEFAULT_CACHE_MAX_BYTES))
    except ValueError:
        return DEFAULT_CACHE_MAX_BYTES


def _digest(value, n: int = 24) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()[:n]


def regions_sha256(regions: list) -> str:
    """Content hash of a region list [chrom, start, end, strand, name] (what the pool depends on, not the file)."""
    h = hashlib.sha256()
    for r in regions:
        r = list(r) + ["", "", "", "", ""]
        h.update(f"{r[0]}\t{int(r[1])}\t{int(r[2])}\t{r[3] or '.'}\t{r[4] or ''}\n".encode())
    return h.hexdigest()


# ----------------------------------------------------------------------------------------------------- sites


@dataclass
class Sites:
    chrom: list
    win_start: np.ndarray  # real window [start, end), 2 * flank long (start clamped at 0 near a contig start)
    win_end: np.ndarray
    anchor: np.ndarray     # the anchor base (virtual 0)
    minus: np.ndarray      # bool: minus-strand site (virtual coordinates flipped)
    name: list
    flank: int
    # The window's logical start, never clamped (may be negative): the origin virtual coordinates are projected from,
    # so the anchor is virtual 0 even when the fetch bound (win_start) was clamped at the contig start. None: win_start.
    origin: Optional[np.ndarray] = None

    def __post_init__(self) -> None:
        if self.origin is None:
            self.origin = np.asarray(self.win_start, np.int64).copy()

    def __len__(self) -> int:
        return len(self.chrom)

    def provenance(self, i: int) -> dict:
        return {"site": int(i), "site_name": self.name[i], "chrom": self.chrom[i], "window": [int(self.win_start[i]), int(self.win_end[i])],
                "anchor": int(self.anchor[i]), "strand": "-" if self.minus[i] else "+", "origin": int(self.origin[i])}


def build_sites(regions: list, anchor: str = "centre", flank: int = 1000) -> Sites:
    """BED regions [chrom, start, end, strand, name] -> anchor windows (see the module docstring)."""
    flank = int(flank)
    chrom, ws, we, an, mi, nm, og = [], [], [], [], [], [], []
    for r in regions:
        c, _s, e = region_window(r, anchor, "point", flank, 0)
        a = e - flank  # region_window clamps the start at 0, never the end
        minus = (r[3] if len(r) > 3 else ".") == "-"
        lo = a - flank + 1 if minus else a - flank
        chrom.append(str(c))
        ws.append(max(0, lo))
        we.append(lo + 2 * flank)
        an.append(a)
        mi.append(minus)
        nm.append(str(r[4]) if len(r) > 4 and r[4] else "")
        og.append(lo)
    return Sites(chrom, np.asarray(ws, np.int64), np.asarray(we, np.int64), np.asarray(an, np.int64),
                 np.asarray(mi, bool), nm, flank, origin=np.asarray(og, np.int64))


def _blocks(sites: Sites, max_gap: int, max_len: int) -> list:
    windows = [(sites.chrom[i], int(sites.win_start[i]), int(sites.win_end[i])) for i in range(len(sites))]
    blocks = region_blocks(windows, max_gap=max_gap, max_len=max_len)
    return sorted(blocks, key=lambda b: (stable_key(BLOCK_ORDER_SEED, "block", b[0], b[1], b[2]), b[0], b[1]))


def _contig_index(sites: Sites) -> dict:
    """Per contig: (site indices by anchor, their anchors)."""
    by: dict = {}
    for i, c in enumerate(sites.chrom):
        by.setdefault(c, []).append(i)
    out = {}
    for c, ids in by.items():
        ids.sort(key=lambda i: (int(sites.anchor[i]), i))
        out[c] = (ids, [int(sites.anchor[i]) for i in ids])
    return out


# ----------------------------------------------------------------------------------------------------- index


@dataclass
class DatasetIndex:
    """One dataset's pool: molecules (one per read name: name, extent, file, virtual offset) and entries (one per
    molecule and site it joins: site, molecule), entries in canonical order (site, read name). Entries are the
    (read, site) observations; a molecule in several sites' windows has one entry per site (``shared``) but one key
    and one record."""
    dataset_id: str
    site: np.ndarray      # uint32 per entry
    mol: np.ndarray       # uint32 per entry: its molecule
    names: list           # per molecule
    start: np.ndarray     # int64 per molecule: real extent of its records
    end: np.ndarray
    file: np.ndarray      # uint8 per molecule: which of the dataset's files holds the record
    voff: np.ndarray      # int64 per molecule: BGZF virtual offset of the record (-1: unknown)
    complete: bool = True
    # bool per molecule: it carries footprint calls (services/bam_tags.read_has_footprint_calls; QC-fail records count
    # as called here, as the loaders' uncalled rule leaves them to the QC-fail filter). None: all called.
    called: Optional[np.ndarray] = None
    cache_key: Optional[str] = None  # set: key arrays are kept on disk beside the index (one file per seed)
    _keys: dict = field(default_factory=dict, repr=False)
    _keys_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _keys_pending: dict = field(default_factory=dict, repr=False)
    _shared: Optional[np.ndarray] = field(default=None, repr=False)
    _ranked: dict = field(default_factory=dict, repr=False)

    def __len__(self) -> int:
        return len(self.site)

    @property
    def n_molecules(self) -> int:
        return len(self.names)

    @property
    def shared(self) -> np.ndarray:
        """Per entry: its molecule has entries in other sites too."""
        if self._shared is None or len(self._shared) != len(self.site):
            counts = np.bincount(self.mol, minlength=len(self.names)) if len(self.mol) else np.zeros(0, np.int64)
            self._shared = counts[self.mol] > 1 if len(self.mol) else np.zeros(0, bool)
        return self._shared

    def keys(self, seed: int) -> np.ndarray:
        """uint64 stable keys of the molecules under ``seed`` (memory, then disk, then computed; single flight)."""
        seed = int(seed)
        while True:
            with self._keys_lock:
                k = self._keys.get(seed)
                if k is not None and len(k) == len(self.names):
                    return k
                pending = self._keys_pending.get(seed)
                if pending is None:
                    pending = self._keys_pending[seed] = threading.Event()
                    break
            pending.wait()  # another thread is computing these keys
        try:
            k = self._load_keys(seed)
            if k is None:
                k = fast_keys(seed, self.dataset_id, self.names)
                self._save_keys(seed, k)
            with self._keys_lock:
                while len(self._keys) >= 4:
                    self._keys.pop(next(iter(self._keys)))
                self._keys[seed] = k
            return k
        finally:
            with self._keys_lock:
                self._keys_pending.pop(seed, None)
            pending.set()

    def entry_keys(self, seed: int) -> np.ndarray:
        return self.keys(seed)[self.mol]

    def _keys_path(self, seed: int) -> Optional[Path]:
        # Keys hash the dataset id too (the stable rule), so the same file under another id has other keys.
        return (cache_root() / f"{self.cache_key}.{_digest(self.dataset_id, 8)}.k{int(seed)}.npy"
                if self.cache_key else None)

    def _load_keys(self, seed: int) -> Optional[np.ndarray]:
        path = self._keys_path(seed)
        if path is None or not path.is_file():
            return None
        try:
            k = np.load(path)
        except (OSError, ValueError):
            return None
        if k.dtype != np.uint64 or len(k) != len(self.names):
            return None
        try:
            os.utime(path)
        except OSError:
            pass
        return k

    def _save_keys(self, seed: int, k: np.ndarray) -> None:
        path = self._keys_path(seed)
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".tmp{os.getpid()}.{threading.get_ident()}.npy")
            np.save(tmp, k)
            os.replace(tmp, path)
        except OSError:
            pass  # keys that cannot be kept are recomputed next time

    def ranked(self, seed: int, hide_uncalled: bool = False) -> np.ndarray:
        """Entry indices in key order (a molecule's entries together, by site), the dataset's one sampling order.
        ``hide_uncalled``: without the entries of molecules that carry no footprint calls (Min footprints' rule,
        the read track's default), so a working set of N holds N called reads and uncalled ones are never
        decoded. Kept for the last few (seed, rule) pairs (a sort of millions of entries is the fixed cost of
        every request otherwise)."""
        seed = int(seed)
        hide = bool(hide_uncalled) and self.called is not None and not bool(self.called.all())
        cache_key = (seed, hide)
        with self._keys_lock:
            hit = self._ranked.get(cache_key)
        if hit is not None:
            return hit
        if hide:
            full = self.ranked(seed, False)
            order = full[self.called[self.mol[full]]]
        else:
            k = self.keys(seed)
            order = np.lexsort((np.arange(len(self.site)), self.site, k[self.mol]))
        with self._keys_lock:
            while len(self._ranked) >= 4:
                self._ranked.pop(next(iter(self._ranked)))
            self._ranked[cache_key] = order
        return order

    def n_entries(self, hide_uncalled: bool = False) -> int:
        """Read-site observations in the pool under the uncalled rule."""
        if not hide_uncalled or self.called is None:
            return len(self.site)
        return int(self.called[self.mol].sum()) if len(self.site) else 0

    def nbytes(self) -> int:
        arrays = (self.site, self.mol, self.start, self.end, self.file, self.voff)
        return int(sum(a.nbytes for a in arrays) + sum(len(n) + 57 for n in self.names))

    @classmethod
    def from_rows(cls, dataset_id: str, rows: list, complete: bool = True) -> "DatasetIndex":
        """rows (site, name, start, end, file, voff[, shared]) -> index (canonical order; a molecule's record is the
        one of its first entry in that order, its extent the union)."""
        rows = sorted(rows, key=lambda r: (r[0], r[1], r[4], r[5]))
        mol_of: dict = {}
        names, starts, ends, files, voffs = [], [], [], [], []
        site = np.empty(len(rows), np.uint32)
        mol = np.empty(len(rows), np.uint32)
        for i, r in enumerate(rows):
            m = mol_of.get(r[1])
            if m is None:
                m = mol_of[r[1]] = len(names)
                names.append(r[1])
                starts.append(r[2])
                ends.append(r[3])
                files.append(r[4])
                voffs.append(r[5])
            else:
                starts[m] = min(starts[m], r[2])
                ends[m] = max(ends[m], r[3])
            site[i] = r[0]
            mol[i] = m
        return cls(dataset_id, site, mol, names, np.asarray(starts, np.int64), np.asarray(ends, np.int64),
                   np.asarray(files, np.uint8), np.asarray(voffs, np.int64), complete,
                   called=np.ones(len(names), bool))

    # cache ------------------------------------------------------------------------------------------------
    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = "\n".join(self.names).encode("utf-8")
        tmp = path.with_suffix(f".tmp{os.getpid()}.{threading.get_ident()}.npz")
        np.savez(tmp, version=np.int64(CACHE_VERSION), site=self.site, mol=self.mol, start=self.start, end=self.end,
                 file_index=self.file, voff=self.voff, names=np.frombuffer(blob, np.uint8), n=np.int64(len(self.names)),
                 called=self.called if self.called is not None else np.ones(len(self.names), bool))
        os.replace(tmp, path)

    @classmethod
    def load(cls, dataset_id: str, path: Path) -> Optional["DatasetIndex"]:
        try:
            with np.load(path) as z:
                if int(z["version"]) != CACHE_VERSION:
                    return None
                n = int(z["n"])
                names = bytes(z["names"]).decode("utf-8").split("\n") if n else []
                if len(names) != n:
                    return None
                out = cls(dataset_id, z["site"], z["mol"], names, z["start"], z["end"], z["file_index"], z["voff"],
                          called=z["called"].astype(bool))
        except (OSError, KeyError, ValueError):
            return None
        try:
            os.utime(path)  # LRU by mtime
        except OSError:
            pass
        return out


def dataset_cache_key(dataset_paths: list, spec: dict, chrom_aliases: Optional[dict] = None) -> str:
    """The cache key of one dataset's index: BED content, file identity (path, size, mtime), the pool rules."""
    from services.background_work import file_identity
    return _digest({"v": CACHE_VERSION, "bed": spec["regions_sha256"], "files": file_identity(dataset_paths),
                    "anchor": spec["anchor"], "flank": int(spec["flank_bp"]), "policy": spec["policy"],
                    "min_overlap": int(spec["min_overlap_bp"]), "aliases": sorted((chrom_aliases or {}).items())})


def cache_path(key: str) -> Path:
    return cache_root() / f"{key}.npz"


def evict_cache(max_bytes: Optional[int] = None, keep: tuple = ()) -> int:
    """Delete the least recently used cache files until the cache is at most ``max_bytes``; returns bytes freed."""
    max_bytes = cache_max_bytes() if max_bytes is None else int(max_bytes)
    root = cache_root()
    if not root.is_dir():
        return 0
    files = []
    for p in [*root.glob("*.npz"), *root.glob("*.npy")]:
        try:
            st = p.stat()
        except OSError:
            continue
        files.append((st.st_mtime, st.st_size, p))
    total = sum(f[1] for f in files)
    freed = 0
    for _mtime, size, p in sorted(files):
        if total <= max_bytes:
            break
        if p.name in keep or p.name.split(".")[0] + ".npz" in keep:
            continue
        try:
            p.unlink()
        except OSError:
            continue
        total -= size
        freed += size
    return freed


# ----------------------------------------------------------------------------------------------------- bytes


def estimate_block_bytes(path: str, tid: int, start: int, end: int) -> int:
    """Compressed bytes a fetch of [start, end) reads, from the BAI linear index (0 when unknown)."""
    from services.read_sampling import _bai_refs
    refs = _bai_refs(str(path)) or []
    if tid < 0 or tid >= len(refs):
        return 0
    offsets, meta = refs[tid]
    if meta is None or not len(offsets):
        return 0
    first, last, _mapped = meta
    w0 = max(0, int(start)) >> 14
    w1 = (max(0, int(end) - 1) >> 14) + 3
    if w0 >= len(offsets):
        return 0
    lo = int(offsets[w0]) or first
    hi = int(offsets[w1]) if w1 < len(offsets) and offsets[w1] else last
    return max(0, hi - lo)


# ----------------------------------------------------------------------------------------------------- enumeration


@dataclass
class Progress:
    blocks_total: int = 0
    blocks_done: int = 0
    sites_total: int = 0
    sites_done: int = 0
    bytes_total: int = 0   # compressed bytes the blocks will read, estimated from the BAM index
    bytes_done: int = 0    # the same estimate, for the blocks done (fraction and ETA use these)
    bytes_read: int = 0    # compressed bytes actually read (overlapping blocks read shared bytes again)
    entries: int = 0
    started: float = field(default_factory=time.monotonic)

    def as_dict(self) -> dict:
        elapsed = time.monotonic() - self.started
        frac = (self.bytes_done / self.bytes_total) if self.bytes_total else (self.sites_done / self.sites_total if self.sites_total else 0.0)
        eta = (elapsed / frac - elapsed) if frac > 0.02 else None
        return {"blocks_done": self.blocks_done, "blocks_total": self.blocks_total, "sites_done": self.sites_done,
                "sites_total": self.sites_total, "bytes_done": self.bytes_done, "bytes_total": self.bytes_total,
                "bytes_read": self.bytes_read,
                "entries": self.entries, "fraction": round(min(1.0, frac), 4), "elapsed_s": round(elapsed, 2),
                "eta_s": None if eta is None else round(max(0.0, eta), 1)}


class _Accumulator:
    """Entries found so far, in compact arrays (a wide pool has millions of entries: no per-entry Python objects).
    A molecule's records in one block form an occurrence (extent, file, offset); entries are (site, occurrence)."""

    def __init__(self, dataset_id: str):
        from array import array
        self.dataset_id = dataset_id
        self.mol_of: dict = {}
        self.names: list = []
        self.occ_mol, self.occ_lo, self.occ_hi = array("I"), array("q"), array("q")
        self.occ_file, self.occ_off = array("B"), array("q")
        self.occ_called = array("B")
        self.e_site, self.e_occ = array("I"), array("I")
        self.lock = threading.Lock()

    def add_block(self, extents: dict, hits_of) -> int:
        n0 = len(self.e_site)
        with self.lock:
            for name, (lo, hi, fi, off, called) in extents.items():
                hits = hits_of(lo, hi)
                if not hits:
                    continue
                m = self.mol_of.get(name)
                if m is None:
                    m = self.mol_of[name] = len(self.names)
                    self.names.append(name)
                occ = len(self.occ_mol)
                self.occ_mol.append(m)
                self.occ_lo.append(lo)
                self.occ_hi.append(hi)
                self.occ_file.append(fi)
                self.occ_off.append(off)
                self.occ_called.append(0 if called is False else 1)
                for s in hits:
                    self.e_site.append(s)
                    self.e_occ.append(occ)
        return len(self.e_site) - n0

    def __len__(self) -> int:
        return len(self.e_site)

    def snapshot(self, complete: bool = False) -> DatasetIndex:
        """The entries so far as an index in canonical order (site, read name); a molecule's record is the one of
        its first entry in that order, its extent the union of its occurrences."""
        with self.lock:
            n_mol = len(self.names)
            names = list(self.names)
            occ_mol = np.frombuffer(self.occ_mol, np.uint32).copy()
            occ_lo = np.frombuffer(self.occ_lo, np.int64).copy()
            occ_hi = np.frombuffer(self.occ_hi, np.int64).copy()
            occ_file = np.frombuffer(self.occ_file, np.uint8).copy()
            occ_off = np.frombuffer(self.occ_off, np.int64).copy()
            occ_called = np.frombuffer(self.occ_called, np.uint8).astype(bool)
            e_site = np.frombuffer(self.e_site, np.uint32).copy()
            e_occ = np.frombuffer(self.e_occ, np.uint32).copy()
        if not len(e_site):
            z = np.zeros(0, np.int64)
            return DatasetIndex(self.dataset_id, np.zeros(0, np.uint32), np.zeros(0, np.uint32), [], z, z,
                                np.zeros(0, np.uint8), z, complete, called=np.zeros(0, bool))
        name_rank = np.empty(n_mol, np.int64)
        name_rank[np.asarray(sorted(range(n_mol), key=names.__getitem__), np.int64)] = np.arange(n_mol)
        e_mol = occ_mol[e_occ]
        order = np.lexsort((occ_file[e_occ], name_rank[e_mol], e_site))
        e_site, e_occ, e_mol = e_site[order], e_occ[order], e_mol[order]
        # molecules renumbered by first appearance in canonical order
        first = np.full(n_mol, -1, np.int64)
        seen_idx = np.unique(e_mol, return_index=True)
        first[seen_idx[0]] = seen_idx[1]
        present = np.flatnonzero(first >= 0)
        by_first = present[np.argsort(first[present], kind="stable")]
        new_id = np.full(n_mol, -1, np.int64)
        new_id[by_first] = np.arange(len(by_first))
        lo = np.full(len(by_first), np.iinfo(np.int64).max, np.int64)
        hi = np.full(len(by_first), np.iinfo(np.int64).min, np.int64)
        occ_new = new_id[occ_mol]
        valid = occ_new >= 0
        np.minimum.at(lo, occ_new[valid], occ_lo[valid])
        np.maximum.at(hi, occ_new[valid], occ_hi[valid])
        rec_occ = e_occ[first[by_first]]
        # A molecule is called when any of its occurrences is (its records are one molecule's).
        called = np.zeros(len(by_first), bool)
        np.logical_or.at(called, occ_new[valid], occ_called[valid])
        return DatasetIndex(self.dataset_id, e_site.astype(np.uint32), new_id[e_mol].astype(np.uint32),
                            [names[m] for m in by_first.tolist()], lo, hi, occ_file[rec_occ], occ_off[rec_occ], complete,
                            called=called)


def enumerate_dataset(dataset_id: str, paths: list, sites: Sites, spec: dict, *, chrom_map: Optional[dict] = None,
                      progress: Optional[Progress] = None, on_start: Optional[Callable[["_Accumulator"], None]] = None,
                      cancelled: Optional[Callable[[], bool]] = None) -> DatasetIndex:
    """One dataset's pool index (see the module docstring). ``on_start(accumulator)`` receives the growing entry
    store (``snapshot()`` is a provisional pool); ``cancelled()`` is polled between blocks and every 4096 records."""
    import pysam
    from services.bam_tags import read_has_footprint_calls
    from utils.chrom import resolve_reference_name

    flank = sites.flank
    policy = POLICIES.get(spec["policy"], spec["policy"])
    min_overlap = max(1, int(spec["min_overlap_bp"]))
    max_entries = int(spec.get("max_entries") or DEFAULTS["max_entries"])
    blocks = _blocks(sites, int(spec["block_max_gap_bp"]), int(spec["block_max_len_bp"]))
    contigs = _contig_index(sites)
    threads = max(1, int(spec.get("bam_threads") or 1))
    handles = [pysam.AlignmentFile(str(p), "rb", threads=threads) for p in paths]
    acc = _Accumulator(dataset_id)
    if on_start is not None:
        on_start(acc)
    try:
        resolved = [{c: resolve_reference_name(c, h.references, chrom_map or {}) for c in contigs} for h in handles]
        estimates = []
        for chrom, bstart, bend, _m in blocks:
            est = 0
            for fi, h in enumerate(handles):
                actual = resolved[fi].get(chrom)
                if actual is not None:
                    est += estimate_block_bytes(paths[fi], h.get_tid(actual), bstart, bend)
            estimates.append(est)
        if progress is not None:
            progress.blocks_total += len(blocks)
            progress.sites_total += len(sites)
            progress.bytes_total += sum(estimates)
        for (chrom, bstart, bend, members), est in zip(blocks, estimates):
            if cancelled and cancelled():
                raise Cancelled()
            ids, anchors = contigs[chrom]
            owned = set(members)
            extents: dict = {}
            block_bytes = 0
            for fi, h in enumerate(handles):
                actual = resolved[fi].get(chrom)
                if actual is None:
                    continue
                pos = -1
                first_off = None
                n = 0
                for rec in h.fetch(actual, bstart, bend):
                    off, pos = pos, h.tell()
                    if first_off is None:
                        first_off = pos
                    n += 1
                    if not n & 4095 and cancelled and cancelled():
                        raise Cancelled()
                    if rec.is_unmapped or rec.is_secondary:
                        continue
                    lo = rec.reference_start
                    hi = rec.reference_end or lo + 1
                    # The uncalled rule (3.0.6): a primary record without footprint calls (not QC-fail) is uncalled.
                    # Supplementary records do not decide (None); a molecule with only those counts as called.
                    called = None if rec.is_supplementary else bool(rec.is_qcfail or read_has_footprint_calls(rec))
                    e = extents.get(rec.query_name)
                    if e is None:
                        extents[rec.query_name] = [lo, hi, fi, off, called]
                    else:
                        e[0], e[1] = min(e[0], lo), max(e[1], hi)
                        if called is not None:
                            e[4] = called if e[4] is None else (e[4] or called)
                if first_off is not None and pos >= 0:
                    block_bytes += max(0, (pos >> 16) - (first_off >> 16))

            def hits_of(lo, hi, ids=ids, anchors=anchors, owned=owned):
                i0 = bisect.bisect_left(anchors, lo - flank + min_overlap)
                i1 = bisect.bisect_right(anchors, hi + flank - min_overlap)
                if i0 >= i1:
                    return ()
                if policy == "per_site":
                    return [ids[x] for x in range(i0, i1) if ids[x] in owned]
                mid = (lo + hi) // 2
                j = bisect.bisect_left(anchors, mid, i0, i1)
                cands = [x for x in (j - 1, j) if i0 <= x < i1]
                best = ids[min(cands, key=lambda x: (abs(anchors[x] - mid), ids[x]))]
                return (best,) if best in owned else ()

            added = acc.add_block(extents, hits_of)
            if len(acc) > max_entries:
                raise PoolTooLarge(f"The pool of {dataset_id} has more than {max_entries:,} entries (max_entries)")
            if progress is not None:
                progress.blocks_done += 1
                progress.sites_done += len(members)
                progress.bytes_done += est
                progress.bytes_read += block_bytes
                progress.entries += added
    finally:
        for h in handles:
            h.close()
    return acc.snapshot(complete=True)


# ----------------------------------------------------------------------------------------------------- pool


@dataclass
class Pool:
    pool_id: str
    spec: dict
    sites: Sites
    datasets: dict  # dataset id -> DatasetIndex (complete) ; provisional rows live in the job until done
    order: list     # dataset ids in request order

    def counts(self) -> dict:
        return {d: len(ix) for d, ix in self.datasets.items()}


def take_balanced(indexes: dict, order: list, seed: int, cursor: dict, count: int) -> dict:
    """The next ``count`` ranks, split evenly over the datasets (a dataset that runs out leaves its share to the
    others), from each dataset's ``cursor`` (ranks already consumed). -> {dataset: (rank from, rank to)}."""
    left = {d: max(0, len(indexes[d]) - int(cursor.get(d, 0))) for d in order if d in indexes}
    share = {d: 0 for d in left}
    remaining = int(count)
    while remaining > 0:
        open_ = [d for d in left if left[d] - share[d] > 0]
        if not open_:
            break
        per = max(1, remaining // len(open_))
        for d in open_:
            give = min(per, left[d] - share[d], remaining)
            share[d] += give
            remaining -= give
            if remaining <= 0:
                break
    return {d: (int(cursor.get(d, 0)), int(cursor.get(d, 0)) + share[d]) for d in share}
