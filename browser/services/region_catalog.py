"""The user's region catalog, kept across sessions: one file per reference.

The Regions panel keeps named regions in categories (saved views, imported BED
files, a dataset's amplicons...). They are coordinates on a reference, so they
are stored per reference (``dm6``, ``hg38``, a FASTA's file name) and follow
the user from dataset to dataset on it. A dataset's detected amplicons are a
category of their own carrying the dataset's content fingerprint
(region_detect.dataset_fingerprint), so renamed amplicons come back the next
time that BAM is opened, whatever its path.

Files: ``~/.fiberhmm/regions/<reference>.json`` (``FIBERBROWSER_REGION_CATALOG_DIR``
overrides the folder). Written atomically under a lock (as recent_tracks.py).
Only the known fields are kept. A write over the size limits is refused
(CatalogTooLarge), never cut short; a file read back is capped.

Whose and which reference:
- On a lab server each signed-in member has their own catalogs
  (``members/<name>/`` in the folder); the server's own user keeps the top folder.
- A registry genome (``hg38``) is its id. A reference from a FASTA file is keyed
  by its file name in the browser (``reference.fa``, ``fasta:reference``), which
  two unrelated FASTAs can share: its file is also keyed by a digest of its
  contig names and lengths (``reference_identity``), so their regions never mix.
  A catalog saved before under the bare name is taken over once, by the first
  such reference its regions fit.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Iterator, Optional

try:  # POSIX: lock across server processes sharing the folder
    import fcntl
except ImportError:  # pragma: no cover - Windows falls back to the thread lock
    fcntl = None

VERSION = 1
MAX_ENTRIES = 200_000
MAX_CATEGORIES = 2_000
MAX_TEXT = 500
_LOCK = threading.Lock()
_KEY_RE = re.compile(r"[^A-Za-z0-9_.-]+")

CATEGORY_FIELDS = {"id": str, "name": str, "parent": str, "collapsed": bool, "source": str,
                   "fingerprint": str, "dataset": str, "note": str, "created": str}
ENTRY_FIELDS = {"id": str, "chrom": str, "start": int, "end": int, "label": str, "autoLabel": str,
                "category": str, "source": str, "reads": int, "score": float, "strand": str,
                "gene": str, "detail": str, "note": str, "created": str, "color": str}


def _root_dir() -> Path:
    configured = os.environ.get("FIBERBROWSER_REGION_CATALOG_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".fiberhmm" / "regions"


def _safe(key: str) -> str:
    safe = _KEY_RE.sub("_", key).strip("._") or "none"
    # A key that had to be changed or shortened gets a digest of the whole key (no two collide).
    if safe != key or len(safe) > 80:
        safe = f"{safe[:60]}-{hashlib.sha1(key.encode('utf-8', 'replace')).hexdigest()[:12]}"
    return safe


def catalog_dir() -> Path:
    """This request's folder: a lab member's own, else the server user's."""
    from services.runtime import current_lab_user, get_lab_mode
    root = _root_dir()
    user = current_lab_user() if get_lab_mode() else None
    if user is not None and getattr(user, "name", None):
        return root / "members" / _safe(str(user.name))
    return root


def storage_key(genome: str, identity: Optional[str] = None) -> str:
    """The catalog's file key: the reference key, with its contig digest when it has one."""
    key = str(genome or "none")
    return f"{key}#{identity}" if identity else key


def catalog_path(genome: str, identity: Optional[str] = None) -> Path:
    """The file of one reference's catalog (a safe file name, unique per key)."""
    return catalog_dir() / f"{_safe(storage_key(genome, identity))}.json"


class Reference:
    """A FASTA-based reference's identity (a digest of its contigs) and its contig lengths
    (None: an identity the browser read the catalog under, ``bound_reference``)."""

    def __init__(self, identity: str, lengths: Optional[dict]):
        self.identity = identity
        self.lengths = lengths


_IDENTITY_RE = re.compile(r"^[0-9a-f]{1,64}$")


def bound_reference(state, genome: str, identity: Optional[str]) -> Optional[Reference]:
    """The catalog a write or reset is for. The browser sends the identity the catalog
    was read under (GET answers it): a save that lands after the reference was closed,
    or after another FASTA of that name was loaded, still goes to the catalog it was
    read from. ``""``: the bare key (a registry genome). None (not sent): the
    reference loaded now."""
    if identity is None:
        return reference_identity(state, genome)
    if identity == "" or not _IDENTITY_RE.match(identity):
        return None
    return Reference(identity, None)


def reference_identity(state, genome: str) -> Optional[Reference]:
    """The reference ``genome`` names in this workspace (the main genome or a panel's
    own), when it is a FASTA (or a dataset's own contigs): a digest of its contig
    names and lengths. None for a registry genome (its id is unique) and for a key
    not loaded now (its catalog is then read by the key alone)."""
    try:
        from services.genome_registry import GENOME_REGISTRY
        if not genome or genome in GENOME_REGISTRY:
            return None
        from services.region_detect import region_genome_key
        ref = None
        if region_genome_key(state) == genome:
            ref = state
        else:
            from services.panel_genomes import contexts, genome_view
            if genome in contexts(state):
                ref = genome_view(state, genome)
        fasta = getattr(ref, "fasta", None) if ref is not None else None
        if fasta is None:
            return None
        names = [str(n) for n in fasta.references]
        lengths = [int(n) for n in (getattr(fasta, "lengths", None) or [fasta.get_reference_length(n) for n in names])]
        if not names:
            return None
        text = "\n".join(f"{n}\t{l}" for n, l in sorted(zip(names, lengths)))
        known = dict(zip(names, lengths))
        # Plasmid maps keep their regions in the genome's catalog: they count as its
        # chromosomes when a saved catalog is taken over (not in the digest: maps come and go).
        for name, sequence in (getattr(ref, "plasmid_sequences", None) or {}).items():
            known.setdefault(str(name), len(sequence))
        return Reference(hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:16], known)
    except Exception:
        return None


def _fits(raw: Any, lengths: dict) -> bool:
    """A catalog saved under a bare FASTA name could be this reference's: no region
    lies beyond its chromosome's end, and (when it has regions) one is on it."""
    from utils.chrom import get_chrom_variants
    entries = [e for e in ((raw or {}).get("entries") or []) if isinstance(e, dict)]
    known = 0
    for entry in entries:
        chrom = str(entry.get("chrom") or "")
        size = next((lengths[v] for v in get_chrom_variants(chrom) if v in lengths), None)
        if size is None:
            continue  # a plasmid map's region (kept with the genome's)
        known += 1
        try:
            if int(entry.get("end") or 0) > size:
                return False
        except (TypeError, ValueError):
            continue
    return known > 0 or not entries


@contextlib.contextmanager
def _locked() -> Iterator[None]:
    with _LOCK:
        if fcntl is None:
            yield
            return
        folder = catalog_dir()
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / ".lock", "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)


def _clean_record(raw: Any, fields: dict) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    for name, kind in fields.items():
        value = raw.get(name)
        if value is None:
            continue
        try:
            if kind is bool:
                out[name] = bool(value)
            elif kind is int:
                if isinstance(value, bool):
                    continue
                out[name] = int(value)
            elif kind is float:
                number = float(value)
                if number == number and abs(number) != float("inf"):
                    out[name] = number
            else:
                out[name] = str(value)[:MAX_TEXT]
        except (TypeError, ValueError):
            continue
    return out


class CatalogTooLarge(Exception):
    """A write over MAX_ENTRIES regions or MAX_CATEGORIES categories (refused, not cut short)."""

    def __init__(self, entries: int, categories: int):
        parts = []
        if entries > MAX_ENTRIES:
            parts.append(f"{entries:,} regions (at most {MAX_ENTRIES:,})")
        if categories > MAX_CATEGORIES:
            parts.append(f"{categories:,} categories (at most {MAX_CATEGORIES:,})")
        super().__init__(f"Too many to save: {' and '.join(parts)}.")
        self.entries = entries
        self.categories = categories


class CatalogConflict(Exception):
    """The catalog changed since the writer read it (another tab or window saved meanwhile)."""

    def __init__(self, current: dict):
        super().__init__("region catalog changed since it was read")
        self.current = current


def _revision(raw: Any) -> int:
    try:
        return max(0, int((raw or {}).get("revision") or 0))
    except (TypeError, ValueError, AttributeError):
        return 0


def clean_catalog(genome: str, raw: Any) -> dict:
    """A catalog with only the known fields; invalid records dropped; sizes capped."""
    raw = raw if isinstance(raw, dict) else {}
    categories = []
    seen: set = set()
    for item in (raw.get("categories") or [])[:MAX_CATEGORIES]:
        cat = _clean_record(item, CATEGORY_FIELDS)
        if not cat or not cat.get("id") or cat["id"] in seen:
            continue
        cat.setdefault("name", "Regions")
        seen.add(cat["id"])
        categories.append(cat)
    entries = []
    ids: set = set()
    for item in (raw.get("entries") or [])[:MAX_ENTRIES]:
        entry = _clean_record(item, ENTRY_FIELDS)
        if not entry or not entry.get("id") or entry["id"] in ids or not entry.get("chrom"):
            continue
        if "start" not in entry or "end" not in entry or entry["end"] <= entry["start"] or entry["start"] < 0:
            continue
        ids.add(entry["id"])
        entries.append(entry)
    return {"version": VERSION, "genome": str(genome or "none"), "revision": _revision(raw),
            "categories": categories, "entries": entries}


def _read_raw(path: Path) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _path_for(genome: str, reference: Optional[Reference]) -> Path:
    """The file of this reference's catalog. A FASTA reference's own file; before it
    exists, a catalog saved under the bare name is taken over (moved) when its
    regions fit this reference, so a second FASTA of that name starts empty.
    Call under _locked()."""
    if reference is None:
        return catalog_path(genome)
    path = catalog_path(genome, reference.identity)
    if reference.lengths is None:
        return path  # bound by the browser: the catalog it read
    legacy = catalog_path(genome)
    if not path.exists() and legacy.exists():
        raw = _read_raw(legacy)
        if _fits(raw, reference.lengths):
            with contextlib.suppress(OSError):
                os.replace(legacy, path)
    return path


def read_catalog(genome: str, reference: Optional[Reference] = None) -> dict:
    """One reference's catalog; ``revision`` counts its writes (0: never written)."""
    with _locked():
        path = _path_for(genome, reference)
    return clean_catalog(genome, _read_raw(path))


def _write(path: Path, catalog: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".regions.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(catalog, handle, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def write_catalog(genome: str, raw: Any, base_revision: Optional[int] = None,
                  reference: Optional[Reference] = None) -> dict:
    """Replace one reference's catalog. With ``base_revision`` (the revision the writer
    read), refused with CatalogConflict when it was written since; the new revision is
    one more than the current one. Over the size limits: CatalogTooLarge (nothing written)."""
    if isinstance(raw, dict):
        n_entries = len(raw.get("entries") or []) if isinstance(raw.get("entries"), list) else 0
        n_categories = len(raw.get("categories") or []) if isinstance(raw.get("categories"), list) else 0
        if n_entries > MAX_ENTRIES or n_categories > MAX_CATEGORIES:
            raise CatalogTooLarge(n_entries, n_categories)
    with _locked():
        path = _path_for(genome, reference)
        current = clean_catalog(genome, _read_raw(path))
        if base_revision is not None and int(base_revision) != current["revision"]:
            raise CatalogConflict(current)
        catalog = clean_catalog(genome, raw)
        catalog["revision"] = current["revision"] + 1
        _write(path, catalog)
    return catalog


def delete_catalog(genome: str, reference: Optional[Reference] = None) -> dict:
    """Forget one reference's regions (Reset). The file is kept, empty, with the next
    revision, so a window still holding the old regions can't silently write them back."""
    with _locked():
        path = _path_for(genome, reference)
        current = clean_catalog(genome, _read_raw(path))
        had = bool(current["entries"] or current["categories"])
        empty = clean_catalog(genome, {})
        empty["revision"] = current["revision"] + 1
        _write(path, empty)
    return {"deleted": had, "revision": empty["revision"]}
