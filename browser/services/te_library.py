"""Transposable-element libraries for "Identify this insertion".

A library is a FASTA of TE consensus/canonical sequences with each family's
class (LTR / LINE / DNA / ...) and, where the source gives them, the element's
features (LTRs, ORFs, poly(A)). The first Identify for an assembly sets its
library up (``ensure_library``, part of the Identify job: progress and Cancel)
and caches it under ``~/.fiberhmm/te_libraries/<library id>/``::

    library.fa      normalised FASTA, headers ``>name#Class/Subclass``
    library.json    source, licence, version, sha256, per-family metadata
    library.n*      a BLAST database of library.fa (when makeblastdb is present)

Sources (both CC0 1.0, so a user's copy can be cached freely):

* D. melanogaster: the canonical TE sequence set (Bergman lab, continuing the
  FlyBase set; github.com/bergmanlab/drosophila-transposons), release v10.2,
  with its GFF3 (LTRs, ORFs, poly(A)). The Mac app and the WSL distribution
  bundle these two files (``bundled_source``), so no download is needed; other
  installs download them.
* Other assemblies: Dfam's curated families for the species and its ancestral
  clades (dfam.org API). Dfam splits LTR elements into ``*_LTR`` and ``*_I``
  families; the identification joins them back.

Downloading a library sends nothing about the user's data: the request names
only the library (a fixed URL, or a taxon id for Dfam).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from typing import Callable, Optional

from services.external_tools import tool_path

ProgressFn = Callable[[str, float], None]


class LibraryAborted(RuntimeError):
    """Setting a library up was stopped (Cancel)."""

BERGMAN_BASE = "https://raw.githubusercontent.com/bergmanlab/drosophila-transposons/master/releases"
DFAM_API = "https://dfam.org/api"
CC0 = {"licence": "CC0 1.0 (public domain dedication)",
       "licence_url": "https://creativecommons.org/publicdomain/zero/1.0/"}

# Assembly -> Dfam taxon (the species; its ancestral clades come too).
DFAM_TAXA = {
    "dm6": (7227, "Drosophila melanogaster"), "dm3": (7227, "Drosophila melanogaster"),
    "hg38": (9606, "Homo sapiens"), "hg19": (9606, "Homo sapiens"), "chm13": (9606, "Homo sapiens"),
    "hs1": (9606, "Homo sapiens"),
    "mm10": (10090, "Mus musculus"), "mm39": (10090, "Mus musculus"),
    "sacCer3": (4932, "Saccharomyces cerevisiae"),
    "ce11": (6239, "Caenorhabditis elegans"), "danRer11": (7955, "Danio rerio"),
}

LIBRARIES: dict[str, dict] = {
    "dmel-canonical-v10.2": {
        "id": "dmel-canonical-v10.2",
        "label": "D. melanogaster TE canonical set v10.2",
        "short": "D. melanogaster TE library",
        "source": "Bergman lab / FlyBase canonical transposon set",
        "homepage": "https://github.com/bergmanlab/drosophila-transposons",
        "citation": "Bergman CM, Han S et al., Drosophila transposon canonical sequence set (FlyBase), release v10.2",
        "genomes": ["dm6", "dm3"],
        "kind": "bergman",
        "fasta_url": f"{BERGMAN_BASE}/D_mel_transposon_sequence_set_v10.2.fa",
        "fasta_sha256": "8f06ef5d5010f9caa08938d4b62e8d8f11cdba821765e274c9c13df68c88612d",
        "gff_url": f"{BERGMAN_BASE}/transposon_sequence_set_v10.2.gff",
        "size_bytes": 640_581 + 188_966,
        "version": "v10.2",
        **CC0,
    },
}


def _dfam_entry(genome: str) -> Optional[dict]:
    taxon = DFAM_TAXA.get(genome)
    if not taxon:
        return None
    taxid, species = taxon
    return {
        "id": f"dfam-curated-{taxid}",
        "label": f"Dfam curated families for {species}",
        "short": f"{species} TE library (Dfam)",
        "source": "Dfam curated families (species and ancestral clades)",
        "homepage": "https://www.dfam.org",
        "citation": "Storer J, Hubley R, Rosen J, Wheeler TJ, Smit AF. The Dfam community resource of transposable "
                    "element families, sequence models, and genome annotations. Mob DNA 12:2 (2021)",
        "genomes": [g for g, t in DFAM_TAXA.items() if t[0] == taxid],
        "kind": "dfam",
        "taxid": taxid,
        "species": species,
        # Measured: ~1.2 MB for D. melanogaster, ~1.9 MB for human.
        "size_bytes": 2_000_000 if taxid == 9606 else 1_200_000,
        "version": "current release",
        **CC0,
    }


def library_root() -> str:
    env = os.environ.get("FIBERBROWSER_TE_LIBRARY_DIR")
    if env:
        return os.path.expanduser(env)
    return os.path.join(os.path.expanduser("~"), ".fiberhmm", "te_libraries")


def library_dir(lib_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", lib_id or ""):
        raise ValueError(f"bad library id: {lib_id!r}")
    return os.path.join(library_root(), lib_id)


# --- The copy bundled with the app (packaging/third_party.sh) ----------------------------
# Kept separate: one lookup, used by download_library in place of the download.

def bundled_library_dir(lib_id: str) -> Optional[Path]:
    """The bundled source files of a TE library (read-only), or None.

    The Mac app has ``Contents/Resources/te_libraries/<lib_id>/``; the WSL
    distribution (and any install that ships them) has
    ``<sys.prefix>/share/fiberbrowser/te_libraries/<lib_id>/``;
    ``FIBERBROWSER_BUNDLED_TE_LIBRARIES`` names another parent folder. The
    folder holds the library's files as published (for
    ``dmel-canonical-v10.2``: ``D_mel_transposon_sequence_set_v10.2.fa``,
    ``transposon_sequence_set_v10.2.gff`` and ``LICENSE.txt``); see
    packaging/third_party.sh. Included in every release.
    """
    import sys
    if not lib_id or "/" in lib_id or "\\" in lib_id or lib_id in (".", ".."):
        return None
    roots: list[Path] = []
    env = os.environ.get("FIBERBROWSER_BUNDLED_TE_LIBRARIES")
    if env:
        roots.append(Path(env).expanduser())
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).resolve().parent.parent / "Resources" / "te_libraries")
    roots.append(Path(sys.prefix) / "share" / "fiberbrowser" / "te_libraries")
    for root in roots:
        candidate = root / lib_id
        if candidate.is_dir():
            return candidate
    return None


def _bundled_dirs(lib_id: str) -> list[str]:
    found = bundled_library_dir(lib_id)
    return [str(found)] if found else []


def bundled_source(entry: dict) -> Optional[dict]:
    """The bundled files of a library, as {url: local path}, when every file is there."""
    urls = [u for u in (entry.get("fasta_url"), entry.get("gff_url")) if u]
    if entry.get("kind") != "bergman" or not urls:
        return None
    for directory in _bundled_dirs(entry["id"]):
        paths = {u: os.path.join(directory, u.rsplit("/", 1)[-1]) for u in urls}
        if all(os.path.isfile(p) for p in paths.values()):
            return paths
    return None


def _genome_key(genome: Optional[str]) -> str:
    return str(genome or "").strip()


def libraries_for_genome(genome: Optional[str]) -> list[dict]:
    """The libraries offered for an assembly, recommended first."""
    key = _genome_key(genome)
    out = [dict(entry) for entry in LIBRARIES.values() if key in entry["genomes"]]
    dfam = _dfam_entry(key)
    if dfam:
        out.append(dfam)
    return out


def library_entry(lib_id: str) -> Optional[dict]:
    if lib_id in LIBRARIES:
        return dict(LIBRARIES[lib_id])
    match = re.fullmatch(r"dfam-curated-(\d+)", lib_id or "")
    if match:
        for genome, (taxid, _species) in DFAM_TAXA.items():
            if taxid == int(match.group(1)):
                return _dfam_entry(genome)
    return None


def installed_info(lib_id: str) -> Optional[dict]:
    """The cached library's metadata (library.json), or None when not downloaded."""
    try:
        directory = library_dir(lib_id)
    except ValueError:
        return None
    meta_path = os.path.join(directory, "library.json")
    fasta = os.path.join(directory, "library.fa")
    if not (os.path.isfile(meta_path) and os.path.isfile(fasta)):
        return None
    try:
        with open(meta_path, encoding="utf-8") as handle:
            meta = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    meta["fasta"] = fasta
    meta["dir"] = directory
    meta["blast_db"] = os.path.join(directory, "library") if _blast_db_present(os.path.join(directory, "library")) else None
    return meta


def _blast_db_present(prefix: str) -> bool:
    return any(os.path.isfile(prefix + ext) for ext in (".nin", ".ndb", ".nal"))


def library_status(genome: Optional[str]) -> dict:
    """What the Identify panel shows: the libraries for this assembly and which are installed."""
    options = []
    for entry in libraries_for_genome(genome):
        info = installed_info(entry["id"])
        options.append({
            **{k: entry[k] for k in ("id", "label", "short", "source", "homepage", "licence", "licence_url",
                                      "citation", "size_bytes", "version") if k in entry},
            "installed": info is not None,
            "bundled": bundled_source(entry) is not None,
            "families": (info or {}).get("n_families"),
            "downloaded": (info or {}).get("downloaded"),
        })
    active = next((o for o in options if o["installed"]), None)
    return {"genome": _genome_key(genome) or None, "libraries": options, "active": active["id"] if active else None}


def active_library(genome: Optional[str], prefer: Optional[str] = None) -> Optional[dict]:
    """The installed library to search: ``prefer`` when installed, else the first installed one."""
    if prefer:
        info = installed_info(prefer)
        if info is not None:
            return info
    for entry in libraries_for_genome(genome):
        info = installed_info(entry["id"])
        if info is not None:
            return info
    return None


# ---------------------------------------------------------------------------
# FASTA / annotation parsing


def parse_fasta(text: str) -> list[tuple[str, str]]:
    records: list[tuple[str, str]] = []
    header, chunks = None, []
    for line in text.splitlines():
        if line.startswith(">"):
            if header is not None:
                records.append((header, "".join(chunks)))
            header, chunks = line[1:].strip(), []
        elif header is not None:
            chunks.append(line.strip())
    if header is not None:
        records.append((header, "".join(chunks)))
    return records


def split_class(header: str) -> tuple[str, str, str]:
    """``name#Class/Subclass extra`` -> (name, class, subclass)."""
    token = header.split()[0] if header.split() else header
    name, _, cls = token.partition("#")
    major, _, minor = cls.partition("/")
    return name, major or "Unknown", minor


_FEATURE_TYPES = {
    "five_prime_LTR": "LTR", "three_prime_LTR": "LTR", "long_terminal_repeat": "LTR",
    "CDS": "ORF", "polyA_sequence": "polyA", "terminal_inverted_repeat": "TIR",
}


def parse_bergman_gff(text: str) -> dict[str, list[dict]]:
    """Family name -> features in element coordinates (1-based inclusive in the GFF; 0-based half-open here)."""
    names: dict[str, str] = {}
    features: dict[str, list[dict]] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) < 9:
            continue
        seqid, ftype = cols[0], cols[2]
        attrs = dict(kv.split("=", 1) for kv in cols[8].split(";") if "=" in kv)
        if ftype in ("LTR_retrotransposon", "non_LTR_retrotransposon", "transposable_element", "retrotransposon",
                     "terminal_inverted_repeat_element", "helitron", "mite", "foldback_element", "SINE-like elements"):
            raw = attrs.get("name", "")
            if raw.startswith("Dmel\\"):
                names[seqid] = raw.split("\\", 1)[1]
            continue
        kind = _FEATURE_TYPES.get(ftype)
        if not kind:
            continue
        try:
            start, end = int(cols[3]) - 1, int(cols[4])
        except ValueError:
            continue
        label = kind
        if kind == "ORF":
            raw = attrs.get("name", "")
            label = raw.rsplit("\\", 1)[-1] if "\\" in raw else "ORF"
        elif ftype == "five_prime_LTR":
            label = "5′ LTR"
        elif ftype == "three_prime_LTR":
            label = "3′ LTR"
        features.setdefault(seqid, []).append({"type": kind, "label": label, "start": start, "end": end})
    return {names[seqid]: feats for seqid, feats in features.items() if seqid in names}


def _dfam_class(item: dict) -> tuple[str, str]:
    major = item.get("repeat_type_name") or ""
    minor = item.get("repeat_subtype_name") or ""
    if not major:
        cls = str(item.get("classification") or "")
        major = cls.split(";")[-1] if cls else "Unknown"
    return major or "Unknown", minor


# ---------------------------------------------------------------------------
# Download


_download_lock = threading.Lock()


def _acquire(lock: threading.Lock, abort: Optional[threading.Event]) -> None:
    """Take ``lock``, giving up when ``abort`` is set (Cancel while another job holds it)."""
    while not lock.acquire(timeout=0.25):
        if abort is not None and abort.is_set():
            raise LibraryAborted("Stopped")


def _run_cancellable(cmd: list[str], abort: Optional[threading.Event], timeout: float = 600) -> None:
    """Run ``cmd``; Cancel (``abort``) or the timeout kills it."""
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    deadline = time.monotonic() + timeout
    try:
        while proc.poll() is None:
            if abort is not None and abort.is_set():
                raise LibraryAborted("Stopped")
            if time.monotonic() > deadline:
                raise RuntimeError(f"{os.path.basename(cmd[0])} took longer than {timeout:.0f} s")
            time.sleep(0.1)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def _fetch(url: str, opener, timeout: float = 120.0, abort: Optional[threading.Event] = None) -> bytes:
    if abort is not None and abort.is_set():
        raise LibraryAborted("Stopped")
    req = urllib.request.Request(url, headers={"User-Agent": "FiberBrowser (TE library download)"})
    with opener(req, timeout=timeout) as resp:
        chunks = []
        while True:  # in pieces, so Cancel takes effect within one
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
            if abort is not None and abort.is_set():
                raise LibraryAborted("Stopped")
        return b"".join(chunks)


def _local_opener(paths: dict[str, str]):
    """An opener that reads the bundled copies of these URLs (and nothing else)."""
    def opener(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if url not in paths:
            raise OSError(f"not bundled: {url}")
        return open(paths[url], "rb")
    return opener


def _about(entry: dict) -> str:
    """Size and licence, for the progress line."""
    size = entry.get("size_bytes") or 0
    return f"{size / 1e6:.1f} MB, {entry.get('licence', '')}".strip(", ")


def _dfam_pages(taxid: int, fmt: str, opener, progress: Optional[ProgressFn], label: str,
                abort: Optional[threading.Event] = None) -> list:
    """Every page of a Dfam family listing (``fasta`` text pages or ``summary`` result lists)."""
    out: list = []
    start, total, limit = 0, None, 1000
    while total is None or start < total:
        query = urllib.parse.urlencode({"clade": taxid, "clade_relatives": "ancestors", "format": fmt,
                                        "limit": limit, "start": start})
        raw = json.loads(_fetch(f"{DFAM_API}/families?{query}", opener, abort=abort).decode("utf-8"))
        if fmt == "summary":
            total = int(raw.get("total_count") or 0)
            results = raw.get("results") or []
            out.extend(results)
            got = len(results)
        else:
            body = raw.get("body", "") if isinstance(raw, dict) else ""
            if isinstance(raw, dict) and raw.get("encoding") not in (None, "identity"):
                import base64
                import gzip
                body = gzip.decompress(base64.b64decode(body)).decode("utf-8")
            out.append(body)
            got = body.count(">")
            if total is None:
                total = got if got < limit else None
        if progress:
            progress(f"Downloading {label}: {start + got:,} families", 0.1)
        if got == 0:
            break
        start += got
        if total is None and got < limit:
            break
    return out


def download_library(lib_id: str, *, opener=None, progress: Optional[ProgressFn] = None,
                     build_blast_db: bool = True, abort: Optional[threading.Event] = None) -> dict:
    """Download (or read the bundled copy of), normalise and cache a library (once).
    Returns its installed info. ``abort`` (set by Cancel) stops it between reads."""
    entry = library_entry(lib_id)
    if entry is None:
        raise ValueError(f"Unknown TE library: {lib_id}")
    bundled = bundled_source(entry) if opener is None else None
    opener = _local_opener(bundled) if bundled else (opener or urllib.request.urlopen)
    _acquire(_download_lock, abort)
    try:
        directory = library_dir(lib_id)
        os.makedirs(library_root(), exist_ok=True)
        tmp = tempfile.mkdtemp(prefix=f".{lib_id}.", dir=library_root())
        try:
            families: dict[str, dict] = {}
            records: list[tuple[str, str]] = []
            source_sha = None
            if entry["kind"] == "bergman":
                if progress:
                    progress(f"Setting up the {entry['short']} (bundled with FiberBrowser; {entry['licence']})"
                             if bundled else f"Downloading the {entry['short']} once ({_about(entry)})", 0.05)
                fasta_bytes = _fetch(entry["fasta_url"], opener, abort=abort)
                source_sha = hashlib.sha256(fasta_bytes).hexdigest()
                if entry.get("fasta_sha256") and source_sha != entry["fasta_sha256"]:
                    raise RuntimeError("The downloaded TE library does not match its published checksum; not used.")
                gff_feats: dict[str, list[dict]] = {}
                try:
                    gff_feats = parse_bergman_gff(_fetch(entry["gff_url"], opener, abort=abort).decode("utf-8", "replace"))
                except LibraryAborted:
                    raise
                except Exception:
                    gff_feats = {}  # features are an extra: the sequences identify on their own
                for header, seq in parse_fasta(fasta_bytes.decode("utf-8", "replace")):
                    name, major, minor = split_class(header)
                    records.append((f"{name}#{major}/{minor}" if minor else f"{name}#{major}", seq))
                    families[name] = {"class": major, "subclass": minor, "length": len(seq),
                                      "features": gff_feats.get(name, [])}
            else:
                label = f"the {entry['short']} once ({_about(entry)})"
                summary = _dfam_pages(entry["taxid"], "summary", opener, progress, label, abort)
                meta = {str(item.get("accession")): item for item in summary if isinstance(item, dict)}
                pages = _dfam_pages(entry["taxid"], "fasta", opener, progress, label, abort)
                for header, seq in parse_fasta("\n".join(pages)):
                    parts = header.split()
                    accession = parts[0].split(".")[0] if parts else ""
                    name = parts[1] if len(parts) > 1 else accession
                    item = meta.get(accession, {})
                    major, minor = _dfam_class(item)
                    safe = re.sub(r"[^A-Za-z0-9._:+-]", "_", name)
                    records.append((f"{safe}#{major}/{minor}" if minor else f"{safe}#{major}", seq))
                    families[safe] = {"class": major, "subclass": minor, "length": len(seq), "accession": accession,
                                      "description": str(item.get("title") or "")[:200], "features": []}
                source_sha = hashlib.sha256("".join(s for _, s in records).encode()).hexdigest()
            if not records:
                raise RuntimeError("The TE library download was empty.")
            with open(os.path.join(tmp, "library.fa"), "w", encoding="utf-8") as handle:
                for header, seq in records:
                    handle.write(f">{header}\n")
                    for i in range(0, len(seq), 80):
                        handle.write(seq[i:i + 80] + "\n")
            info = {
                "id": lib_id, "label": entry["label"], "source": entry["source"], "homepage": entry["homepage"],
                "licence": entry["licence"], "licence_url": entry["licence_url"], "citation": entry["citation"],
                "version": entry["version"], "url": entry.get("fasta_url") or f"{DFAM_API}/families?clade={entry.get('taxid')}",
                "sha256": source_sha, "n_families": len(records), "downloaded": time.strftime("%Y-%m-%d"),
                "bundled": bool(bundled),
                "families": families,
            }
            with open(os.path.join(tmp, "library.json"), "w", encoding="utf-8") as handle:
                json.dump(info, handle)
            makeblastdb = tool_path("makeblastdb") if build_blast_db else None
            if abort is not None and abort.is_set():
                raise LibraryAborted("Stopped")
            if makeblastdb:
                if progress:
                    progress("Indexing the TE library", 0.12)
                try:
                    _run_cancellable([makeblastdb, "-in", os.path.join(tmp, "library.fa"), "-dbtype", "nucl",
                                      "-out", os.path.join(tmp, "library")], abort)
                except RuntimeError:
                    pass  # no index: the library is searched with minimap2, or indexed on first use
            if abort is not None and abort.is_set():  # stopped while indexing: nothing is published
                raise LibraryAborted("Stopped")
            if os.path.isdir(directory):
                shutil.rmtree(directory)
            os.replace(tmp, directory)
            tmp = None
        finally:
            if tmp and os.path.isdir(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
    finally:
        _download_lock.release()
    info = installed_info(lib_id)
    if info is None:
        raise RuntimeError("The TE library could not be saved.")
    return info


def auto_library(genome: Optional[str]) -> Optional[dict]:
    """The library Identify sets up by itself for this assembly (the recommended one), or
    None when one is installed already or none is offered."""
    if active_library(genome) is not None:
        return None
    offered = libraries_for_genome(genome)
    return offered[0] if offered else None


def ensure_library(lib_id: str, *, progress: Optional[ProgressFn] = None,
                   abort: Optional[threading.Event] = None) -> dict:
    """The installed library, set up now (bundled copy or one download) when missing."""
    info = installed_info(lib_id)
    if info is not None:
        return info
    _acquire(_ensure_lock, abort)  # two Identify jobs at once: one sets it up, the other then uses it
    try:
        info = installed_info(lib_id)
        if info is not None:
            return info
        return download_library(lib_id, progress=progress, abort=abort)
    finally:
        _ensure_lock.release()


_ensure_lock = threading.Lock()


def ensure_library_blast_db(info: dict) -> Optional[str]:
    """The library's BLAST database, built beside it if makeblastdb appeared since the download."""
    if info.get("blast_db"):
        return info["blast_db"]
    makeblastdb = tool_path("makeblastdb")
    if not makeblastdb:
        return None
    prefix = os.path.join(info["dir"], "library")
    subprocess.run([makeblastdb, "-in", info["fasta"], "-dbtype", "nucl", "-out", prefix],
                   capture_output=True, text=True, timeout=600, check=False)
    return prefix if _blast_db_present(prefix) else None


def family_meta(info: Optional[dict], name: str) -> dict:
    if not info:
        return {}
    return (info.get("families") or {}).get(name) or {}
