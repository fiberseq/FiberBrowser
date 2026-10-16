"""Inputs of a "New DAF-seq run": reads, samples, reference, the pipeline command.

A DAF-seq amplicon run (e.g. a Plasmidsaurus Nanopore delivery: a zip or
folder of per-barcode FASTQs) goes through ``fiberhmm-pipeline`` (FiberHMM),
one job per sample. This module turns what the user picked into validated
pipeline arguments; ``services/pipeline_jobs.py`` runs them. The interface
with the pipeline (argv, JSON-lines progress, outputs.json) is contract v1:
``fiberhmm-pipeline READS... --reference REF --enzyme {ddda,dddb} -o OUTDIR
--sample NAME --cores N --progress-json FILE [--region CHR:S-E ...]``.

Raw Nanopore input (POD5 files, or a folder of them such as MinKNOW's
``pod5/``) is basecalled by the pipeline with dorado first (FiberHMM 3.0's
``basecall`` step): a picked POD5 folder is one sample and is passed as it is;
the basecalling choices become ``--dorado-*`` flags (only those that differ
from the pipeline's defaults: ``sup``, 6mA for Hia5, plain for DAF-seq).

Nothing here runs a shell: every command is an argv list.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import hashlib
import importlib.util
import os
import re
import secrets
import shlex
import shutil
import stat
import sys
import zipfile
import zlib
from dataclasses import dataclass, field
from typing import Iterable, Optional

READ_SUFFIXES = (".fastq", ".fq", ".fastq.gz", ".fq.gz", ".bam")
RAW_SUFFIXES = (".pod5", ".fast5")  # raw Nanopore signal: basecalled with dorado by the pipeline
MAX_RAW_FILES = 200_000
FASTQ_SUFFIXES = (".fastq", ".fq", ".fastq.gz", ".fq.gz")
FASTA_SUFFIXES = (".fa", ".fasta", ".fna", ".fa.gz", ".fasta.gz", ".fna.gz")
PLASMID_MAP_SUFFIXES = (".dna", ".gb", ".gbk", ".genbank", ".embl")
ENZYMES = {
    "dddb": "DddB: deaminates C on both strands; the recommended DAF-seq enzyme (Plasmidsaurus route).",
    "ddda": "DddA: deaminates C in TC context on one strand per molecule; for DddA (SsDddA) libraries.",
}
# The wizard's chemistries: DAF-seq (ENZYMES; also what the Library re-calls), plus Hia5 m6A
# Fiber-seq for raw Nanopore input, which the pipeline basecalls with dorado sup + 6mA.
PIPELINE_ENZYMES = {
    **ENZYMES,
    "hia5": "Hia5: m6A Fiber-seq on Nanopore; POD5 is basecalled with dorado sup and the 6mA modification model.",
}
DAF_ONLY_OPTIONS = ("dedup", "dedup_mode", "snp_screen", "snp_mask", "chimera_filter", "use_m5c", "cpg_mask_policy")
PIPELINE_ENV = "FIBERBROWSER_PIPELINE_COMMAND"
CALL_ENV = "FIBERBROWSER_CALL_COMMAND"
MAX_SCAN_FILES = 2000
MAX_SCAN_DEPTH = 4
SAMPLE_NAME_MAX = 80

# Plasmidsaurus names reads <ORDER>_<barcode>_<sample name>.fastq(.gz),
# e.g. ABC123_1_rerun_sample_a_1.5-2.5_9.fastq.
_PLASMIDSAURUS = re.compile(r"^(?P<order>[A-Z0-9]{5,8})_(?P<barcode>\d{1,3})_(?P<name>.+)$")
_REGION = re.compile(r"^(?P<chrom>[^\s:]+):(?P<start>[\d,]+)-(?P<end>[\d,]+)$")


class InputError(ValueError):
    """A problem with what the user picked, worded for the wizard."""

    def __init__(self, message: str, field_name: str = "", hint: str = ""):
        super().__init__(message)
        self.field = field_name
        self.hint = hint


def _lower_suffix(name: str, suffixes: Iterable[str]) -> Optional[str]:
    lowered = name.lower()
    for suffix in sorted(suffixes, key=len, reverse=True):
        if lowered.endswith(suffix):
            return suffix
    return None


def read_file_kind(name: str) -> Optional[str]:
    """'fastq', 'bam' or None for a read file name."""
    suffix = _lower_suffix(name, READ_SUFFIXES)
    if suffix is None:
        return None
    return "bam" if suffix == ".bam" else "fastq"


def is_raw_file(name: str) -> bool:
    return str(name).lower().endswith(RAW_SUFFIXES) and not os.path.basename(str(name)).startswith(".")


def raw_files_in(folder: str, limit: Optional[int] = None) -> list[str]:
    """POD5/FAST5 files under a folder, searched recursively (as fiberhmm-pipeline searches it)."""
    found: list[str] = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if not _skip_dir(d))
        for name in sorted(files):
            if is_raw_file(name):
                found.append(os.path.join(root, name))
                if limit and len(found) >= limit:
                    return found
    return found


def raw_folder_escape(folder: str, permitted) -> Optional[str]:
    """The first file a raw folder would have dorado read that ``permitted(path)`` refuses (a lab
    server's data roots): every POD5/FAST5 file in it and every linked subfolder, judged by where
    it really is, so a link inside a permitted folder cannot point dorado at files elsewhere.
    None when there is none."""
    for root, dirs, files in os.walk(folder):
        for name in dirs:
            path = os.path.join(root, name)
            if os.path.islink(path) and not permitted(path):
                return path
        for name in files:
            path = os.path.join(root, name)
            if is_raw_file(name) and not permitted(path):
                return path
    return None


def raw_input_kind(path: str) -> Optional[str]:
    """'pod5' for a POD5/FAST5 file or a folder holding some (recursively), else None."""
    if os.path.isdir(path):
        return "pod5" if raw_files_in(path, limit=1) else None
    return "pod5" if is_raw_file(path) else None


def raw_sample_name(path: str) -> str:
    """The pipeline's own default sample name for raw input: a MinKNOW ``pod5``/``pod5_pass`` folder is
    named after the run folder above it (fiberhmm.pipeline.runner.default_sample_name)."""
    try:
        from fiberhmm.pipeline.runner import default_sample_name
        return sanitize_sample_name(default_sample_name(path))
    except Exception:
        pass
    name = os.path.basename(os.path.normpath(path))
    if os.path.isdir(path) and re.fullmatch(r"(pod5|fast5)(_(pass|fail|skip))?", name.lower()):
        name = os.path.basename(os.path.dirname(os.path.abspath(path))) or name
    for suffix in (".pod5", ".fast5"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
    return sanitize_sample_name(name)


def scan_raw(paths: list[str]) -> dict:
    """POD5 input -> samples: each picked folder is one sample (passed to the pipeline as the folder, however
    many files it holds); POD5 files picked on their own form one sample per folder they are in."""
    warnings: list[str] = []
    samples: list[DetectedSample] = []
    loose: dict[str, list[ReadSource]] = {}
    for raw in paths:
        text = str(raw or "").strip()
        if not text:
            continue
        path = os.path.abspath(os.path.expanduser(text))
        if not os.path.exists(path):
            raise InputError(f"Not found: {path}", "reads")
        if os.path.isdir(path):
            files = raw_files_in(path, limit=MAX_RAW_FILES)
            if not files:
                warnings.append(f"{path} has no POD5 files.")
                continue
            size = 0
            for item in files:
                with contextlib.suppress(OSError):
                    size += os.path.getsize(item)
            approx = len(files) >= MAX_RAW_FILES
            source = ReadSource(path=path, kind="pod5", size=size)
            sample = DetectedSample(key=f"pod5:{path}", name=raw_sample_name(path))
            sample.files.append(source)
            samples.append(sample)
            fast5 = sum(1 for f in files if f.lower().endswith(".fast5"))
            if fast5:
                warnings.append(f"{os.path.basename(path)}: {fast5} FAST5 file(s); dorado 1.0 and later read POD5 only "
                                "(convert them with 'pod5 convert fast5').")
            if approx:
                warnings.append(f"{os.path.basename(path)}: more than {MAX_RAW_FILES:,} POD5 files; the size shown is "
                                "a lower bound.")
            continue
        if not is_raw_file(path):
            raise InputError(f"{os.path.basename(path)} is not a POD5 file (or a folder of them).", "reads")
        if not os.access(path, os.R_OK):
            raise InputError(f"Cannot read {path} (permissions).", "reads")
        loose.setdefault(os.path.dirname(path), []).append(
            ReadSource(path=path, kind="pod5", size=os.path.getsize(path)))
    for folder, files in loose.items():
        sample = DetectedSample(key=f"pod5files:{folder}", name=raw_sample_name(folder))
        sample.files.extend(files)
        samples.append(sample)
    unique_sample_names(samples)
    return {"success": True, "samples": [s.to_dict() for s in samples], "warnings": warnings, "zips": [],
            "n_files": sum(len(s.files) for s in samples), "input_kind": "pod5"}


def strip_read_suffix(name: str) -> str:
    base = os.path.basename(name)
    suffix = _lower_suffix(base, READ_SUFFIXES)
    return base[: -len(suffix)] if suffix else base


def sanitize_sample_name(name: str) -> str:
    """A sample name that is safe as a file name and a read-group id."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "").strip()).strip("._-")
    return cleaned[:SAMPLE_NAME_MAX] or "sample"


def _skip_dir(name: str) -> bool:
    return name.startswith(".") or name == "__MACOSX"


def _is_pipeline_output(path: str) -> bool:
    """Files a previous run wrote (never re-read as input reads)."""
    base = os.path.basename(path).lower()
    return base.endswith((".fiberhmm.bam", ".aligned.bam")) or f"{os.sep}.fiberhmm-pipeline{os.sep}" in path


@dataclass
class ReadSource:
    """One read file: on disk, or a member of a zip that is extracted at submit."""
    path: str
    kind: str
    size: int
    zip_path: Optional[str] = None
    member: Optional[str] = None

    def to_dict(self) -> dict:
        out = {"path": self.path, "kind": self.kind, "size": self.size}
        if self.zip_path:
            out.update({"zip": self.zip_path, "member": self.member})
        return out


@dataclass
class DetectedSample:
    key: str
    name: str
    files: list[ReadSource] = field(default_factory=list)
    order: Optional[str] = None
    barcode: Optional[str] = None

    def to_dict(self) -> dict:
        kinds = sorted({f.kind for f in self.files})
        return {"key": self.key, "name": self.name, "order": self.order, "barcode": self.barcode,
                "files": [f.to_dict() for f in self.files], "kinds": kinds,
                "size": sum(f.size for f in self.files)}


def _sources_from_zip(zip_path: str, warnings: list[str]) -> list[ReadSource]:
    out: list[ReadSource] = []
    try:
        with zipfile.ZipFile(zip_path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                parts = [p for p in re.split(r"[\\/]", info.filename) if p]
                if not parts or any(_skip_dir(p) for p in parts[:-1]) or parts[-1].startswith("."):
                    continue
                kind = read_file_kind(parts[-1])
                if kind is None:
                    continue
                out.append(ReadSource(path="/".join(parts), kind=kind, size=int(info.file_size),
                                      zip_path=os.path.abspath(zip_path), member=info.filename))
                if len(out) >= MAX_SCAN_FILES:
                    warnings.append(f"{os.path.basename(zip_path)}: only the first {MAX_SCAN_FILES} read files are used.")
                    break
    except (OSError, zipfile.BadZipFile) as exc:
        raise InputError(f"{os.path.basename(zip_path)} is not a readable zip file ({exc}).", "reads") from exc
    if not out:
        warnings.append(f"{os.path.basename(zip_path)} has no FASTQ or BAM files.")
    return out


def _sources_from_dir(root: str, warnings: list[str]) -> list[ReadSource]:
    out: list[ReadSource] = []
    root = os.path.abspath(root)
    base_depth = root.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not _skip_dir(d))
        if dirpath.count(os.sep) - base_depth >= MAX_SCAN_DEPTH:
            dirnames[:] = []
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = os.path.join(dirpath, name)
            if name.lower().endswith(".zip"):
                out.extend(_sources_from_zip(path, warnings))
                continue
            kind = read_file_kind(name)
            if kind is None or _is_pipeline_output(path):
                continue
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            out.append(ReadSource(path=path, kind=kind, size=size))
            if len(out) >= MAX_SCAN_FILES:
                warnings.append(f"{root}: only the first {MAX_SCAN_FILES} read files are used.")
                return out
    return out


def collect_read_sources(paths: Iterable[str]) -> tuple[list[ReadSource], list[str]]:
    """Every read file under the picked files, folders and zips."""
    warnings: list[str] = []
    sources: list[ReadSource] = []
    seen: set[str] = set()
    for raw in paths:
        path = os.path.abspath(os.path.expanduser(str(raw or "").strip()))
        if not raw or not str(raw).strip():
            continue
        if not os.path.exists(path):
            raise InputError(f"Not found: {path}", "reads")
        if os.path.isdir(path):
            found = _sources_from_dir(path, warnings)
            if not found:
                warnings.append(f"{path} has no FASTQ or BAM files.")
        elif path.lower().endswith(".zip"):
            found = _sources_from_zip(path, warnings)
        else:
            kind = read_file_kind(path)
            if kind is None:
                raise InputError(
                    f"{os.path.basename(path)} is not a read file (FASTQ, FASTQ.gz, BAM, a folder or a .zip).", "reads")
            if not os.access(path, os.R_OK):
                raise InputError(f"Cannot read {path} (permissions).", "reads")
            found = [ReadSource(path=path, kind=kind, size=os.path.getsize(path))]
        for source in found:
            key = f"{source.zip_path}::{source.member}" if source.zip_path else source.path
            if key not in seen:
                seen.add(key)
                sources.append(source)
    return sources, warnings


def detect_samples(sources: list[ReadSource], warnings: Optional[list[str]] = None) -> list[DetectedSample]:
    """Group read files into samples.

    Plasmidsaurus files group by order and barcode (their name is the sample
    name); MinKNOW chunks group by barcode (a ``barcodeNN`` folder or name);
    anything else is one sample per file. When FASTQs are present, BAMs are ignored (a delivery
    can carry the provider's own alignments next to the raw reads).
    """
    warnings = warnings if warnings is not None else []
    fastqs = [s for s in sources if s.kind == "fastq"]
    if fastqs and len(fastqs) != len(sources):
        warnings.append(f"Using the {len(fastqs)} FASTQ file(s); {len(sources) - len(fastqs)} BAM file(s) next to them are ignored.")
        sources = fastqs
    groups: dict[str, DetectedSample] = {}
    for source in sources:
        stem = strip_read_suffix(source.path)
        match = _PLASMIDSAURUS.match(stem)
        if match:
            key = f"ps:{match['order']}:{int(match['barcode'])}"
            name = match["name"]
            order, barcode = match["order"], str(int(match["barcode"]))
        else:
            parent = os.path.dirname(source.path)
            parent_name = os.path.basename(parent)
            chunk = re.search(r"(?:^|_)(barcode\d+)(?:_|$)", stem, flags=re.IGNORECASE)
            order = barcode = None
            if re.fullmatch(r"barcode\d+|unclassified", parent_name or "", flags=re.IGNORECASE):
                # MinKNOW: fastq_pass/barcode07/<many chunks>.fastq.gz is one sample.
                key, name = f"dir:{source.zip_path or ''}:{parent}", parent_name
            elif chunk:
                key, name = f"bc:{source.zip_path or ''}:{parent}:{chunk.group(1).lower()}", chunk.group(1).lower()
            else:
                key = f"file:{source.zip_path or ''}:{source.path}"
                name = re.sub(r"(_reads|\.reads)$", "", stem)
            bc = re.search(r"barcode(\d+)", name, flags=re.IGNORECASE)
            if bc:
                barcode = str(int(bc.group(1)))
        sample = groups.get(key)
        if sample is None:
            sample = groups[key] = DetectedSample(key=key, name=sanitize_sample_name(name), order=order, barcode=barcode)
        sample.files.append(source)
    samples = list(groups.values())
    samples.sort(key=lambda s: (s.order or "", int(s.barcode) if s.barcode and s.barcode.isdigit() else 10 ** 6, s.name))
    unique_sample_names(samples)
    return samples


def unique_sample_names(samples) -> None:
    """Make names unique in place (name, name_2, ...)."""
    used: set[str] = set()
    for sample in samples:
        base = sample.name if hasattr(sample, "name") else sample["name"]
        name, counter = base, 2
        while name.lower() in used:
            name = f"{base}_{counter}"
            counter += 1
        used.add(name.lower())
        if hasattr(sample, "name"):
            sample.name = name
        else:
            sample["name"] = name


def _raw_hint(paths: Iterable[str]) -> Optional[str]:
    """A picked folder (or file) that holds raw POD5 rather than reads: say where to go instead."""
    for raw in paths:
        path = os.path.abspath(os.path.expanduser(str(raw or "").strip()))
        if raw and os.path.exists(path) and raw_input_kind(path):
            return (f"{os.path.basename(path) or path} holds raw Nanopore POD5 files: choose "
                    "\"Raw Nanopore (POD5)\" to basecall them with dorado first.")
    return None


def scan_reads(paths: list[str], input_kind: str = "reads") -> dict:
    if input_kind == "pod5":
        return scan_raw(paths)
    sources, warnings = collect_read_sources(paths)
    samples = detect_samples(sources, warnings)
    if not samples:
        hint = _raw_hint(paths)
        if hint:
            warnings = [w for w in warnings if "has no FASTQ or BAM files" not in w] + [hint]
    zips = sorted({s.zip_path for s in sources if s.zip_path})
    return {"success": True, "samples": [s.to_dict() for s in samples], "warnings": warnings,
            "zips": zips, "n_files": len(sources), "input_kind": "reads"}


# --------------------------------------------------------------------------
# Zip extraction (at submit, into the run folder)
# --------------------------------------------------------------------------

def _zip_member_parts(filename: str) -> list[str]:
    """A member's path re-rooted: no absolute paths, drive letters, ``.`` or ``..``."""
    parts = [p for p in re.split(r"[\\/]", filename) if p not in ("", ".", "..")]
    parts = [re.sub(r"^[A-Za-z]:", "", p) for p in parts]
    return [p for p in parts if p not in ("", ".", "..")]


def zip_namespace(zip_path: str, archive: zipfile.ZipFile) -> str:
    """The folder one archive extracts into: its name plus a digest of its contents
    (member names, CRCs and sizes), so two archives never share a path unless every
    member is identical."""
    listing = sorted((i.filename, i.CRC, i.file_size) for i in archive.infolist() if not i.is_dir())
    digest = hashlib.sha256(repr(listing).encode("utf-8", "surrogatepass")).hexdigest()[:12]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.splitext(os.path.basename(zip_path))[0]).strip("._")
    return f"{stem[:48] or 'archive'}-{digest}"


def _file_crc32(read) -> int:
    crc = 0
    for block in iter(lambda: read(1 << 20), b""):
        crc = zlib.crc32(block, crc)
    return crc & 0xFFFFFFFF


_DIR_FD_OK = (os.open in os.supports_dir_fd and os.mkdir in os.supports_dir_fd
              and os.rename in os.supports_dir_fd and os.stat in os.supports_dir_fd
              and os.unlink in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")
              and hasattr(os, "O_DIRECTORY"))


def _symlink_error(path: str) -> "InputError":
    return InputError(f"Refusing to extract through {path}: it is a symbolic link or not a plain "
                      "folder/file. Choose another output folder.", "reads")


def _open_dir(name: str, dir_fd: Optional[int], shown: str) -> int:
    """Open (creating it when missing) the folder ``name`` without following a symlink."""
    try:
        os.mkdir(name, 0o700, dir_fd=dir_fd)
    except FileExistsError:
        pass
    try:
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except OSError as exc:
        raise _symlink_error(shown) from exc


def _extract_member_at(archive, info, dir_fd: int, name: str, shown: str) -> None:
    """Write one member as ``name`` in the folder ``dir_fd``: reused only when its size and
    CRC match, else written to a fresh exclusive temp file and renamed over it."""
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        st = None
    if st is not None:
        if not stat.S_ISREG(st.st_mode):
            raise _symlink_error(shown)
        if st.st_size == info.file_size:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
            with os.fdopen(fd, "rb") as existing:
                if _file_crc32(existing.read) == (info.CRC & 0xFFFFFFFF):
                    return
    tmp = f".{name}.{secrets.token_hex(6)}.partial"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
    try:
        with os.fdopen(fd, "wb") as dst, archive.open(info) as src:
            shutil.copyfileobj(src, dst, 8 << 20)
        os.rename(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp, dir_fd=dir_fd)
        raise


def _extract_member_by_path(archive, info, target: str, root: str) -> None:
    """Fallback without ``dir_fd`` (Windows): no symlink or junction on the way, and the
    resolved target inside ``root``."""
    here = root
    for part in os.path.relpath(os.path.dirname(target), root).split(os.sep):
        if part in ("", "."):
            continue
        here = os.path.join(here, part)
        if os.path.lexists(here) and (os.path.islink(here) or not os.path.isdir(here)):
            raise _symlink_error(here)
        os.makedirs(here, exist_ok=True)
    real_root = os.path.realpath(root)
    if os.path.commonpath([os.path.realpath(os.path.dirname(target)), real_root]) != real_root:
        raise _symlink_error(os.path.dirname(target))
    if os.path.lexists(target):
        if os.path.islink(target) or not os.path.isfile(target):
            raise _symlink_error(target)
        if os.path.getsize(target) == info.file_size:
            with open(target, "rb") as existing:
                if _file_crc32(existing.read) == (info.CRC & 0xFFFFFFFF):
                    return
    tmp = os.path.join(os.path.dirname(target), f".{os.path.basename(target)}.{secrets.token_hex(6)}.partial")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as dst, archive.open(info) as src:
            shutil.copyfileobj(src, dst, 8 << 20)
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def extract_zip_members(zip_path: str, members: list[str], dest: str) -> dict[str, str]:
    """Extract the named members under ``dest``; returns member -> extracted path.

    Each archive gets its own folder ``dest/<name>-<content digest>/`` (see
    zip_namespace), so archives whose members share a name never share or
    overwrite each other's reads. Member paths are re-rooted inside it (no
    absolute paths or ``..``); ``dest``, that folder and every folder below
    are opened without following symbolic links, and an existing symlink (or
    any non-regular file) in the way is refused. An existing file is reused
    only when its size and CRC match the member.
    """
    dest = os.path.abspath(dest)
    wanted = set(members)
    out: dict[str, str] = {}
    with zipfile.ZipFile(zip_path) as archive:
        namespace = zip_namespace(zip_path, archive)
        chosen = [info for info in archive.infolist() if info.filename in wanted and not info.is_dir()]
        parents = os.path.dirname(dest)
        os.makedirs(parents, exist_ok=True)
        if _DIR_FD_OK:
            parent_fd = os.open(parents, os.O_RDONLY | os.O_DIRECTORY)
            try:
                dest_fd = _open_dir(os.path.basename(dest), parent_fd, dest)
            finally:
                os.close(parent_fd)
            try:
                ns_fd = _open_dir(namespace, dest_fd, os.path.join(dest, namespace))
            finally:
                os.close(dest_fd)
            try:
                for info in chosen:
                    parts = _zip_member_parts(info.filename)
                    if not parts:
                        raise InputError(f"Unsafe path in zip: {info.filename}", "reads")
                    fds = [ns_fd]
                    shown = os.path.join(dest, namespace)
                    try:
                        for part in parts[:-1]:
                            shown = os.path.join(shown, part)
                            fds.append(_open_dir(part, fds[-1], shown))
                        _extract_member_at(archive, info, fds[-1], parts[-1], os.path.join(shown, parts[-1]))
                    finally:
                        for fd in fds[1:]:
                            os.close(fd)
                    out[info.filename] = os.path.join(dest, namespace, *parts)
            finally:
                os.close(ns_fd)
        else:
            for path in (dest, os.path.join(dest, namespace)):
                if os.path.lexists(path) and (os.path.islink(path) or not os.path.isdir(path)):
                    raise _symlink_error(path)
                os.makedirs(path, exist_ok=True)
            root = os.path.join(dest, namespace)
            for info in chosen:
                parts = _zip_member_parts(info.filename)
                if not parts:
                    raise InputError(f"Unsafe path in zip: {info.filename}", "reads")
                target = os.path.abspath(os.path.join(root, *parts))
                if os.path.commonpath([target, root]) != root:
                    raise InputError(f"Unsafe path in zip: {info.filename}", "reads")
                _extract_member_by_path(archive, info, target, root)
                out[info.filename] = target
    missing = wanted - set(out)
    if missing:
        raise InputError(f"{os.path.basename(zip_path)} no longer has {sorted(missing)[0]}.", "reads")
    return out


# --------------------------------------------------------------------------
# Reference
# --------------------------------------------------------------------------

def genome_cache_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")


def catalog_genome_fasta(genome_id: str, *, verify: bool = True) -> tuple[Optional[str], Optional[str]]:
    """(local FASTA path or None, error) for a genome in FiberBrowser's catalog. ``verify=False`` only says
    whether it is downloaded (listings); a path that will be used is verified (the default)."""
    from services.genome_registry import GENOME_REGISTRY
    from state.browser_state import cached_fasta_path
    info = GENOME_REGISTRY.get(genome_id)
    if info is None:
        return None, f"Unknown genome: {genome_id}"
    urls = list(info.get("fasta_urls") or [])
    if info.get("fasta_url") and info["fasta_url"] not in urls:
        urls.insert(0, info["fasta_url"])
    if not urls:
        return None, f"{genome_id} has no FASTA in the catalog"
    local = cached_fasta_path(genome_cache_dir(), urls)
    if os.path.isfile(local) and os.path.getsize(local) > 0 and not verify:
        return local, None
    if os.path.isfile(local) and os.path.getsize(local) > 0:
        # Its index verified to describe it (rebuilt if not; refused if it cannot be), as when it is loaded.
        from state.browser_state import ReferenceIndexError, verified_cached_fasta
        try:
            verified = verified_cached_fasta(urls)
        except ReferenceIndexError as exc:
            return None, str(exc)
        if verified:
            return verified, None
    return None, f"{info['name']} is not downloaded on this computer yet."


def genome_choices(state=None) -> list[dict]:
    from services.genome_registry import GENOME_REGISTRY
    current = getattr(state, "current_genome", None) if state is not None else None
    out = []
    for genome_id, info in GENOME_REGISTRY.items():
        local, _ = catalog_genome_fasta(genome_id, verify=False)
        out.append({"id": genome_id, "name": info["name"], "downloaded": bool(local),
                    "fasta": local, "loaded": genome_id == current})
    return out


def loaded_references(state) -> list[dict]:
    """References loaded in this workspace that are local files (usable by the pipeline)."""
    out = []
    if state is None:
        return out
    fasta_path = getattr(state, "fasta_path", None)
    if fasta_path and not re.match(r"^[a-z][a-z0-9+.-]*://", str(fasta_path)) and os.path.isfile(str(fasta_path)):
        out.append({"kind": "file", "path": str(fasta_path), "label": os.path.basename(str(fasta_path)),
                    "genome": getattr(state, "current_genome", None)})
    for name, meta in sorted((getattr(state, "plasmid_metadata", None) or {}).items()):
        path = (meta or {}).get("path")
        if path and os.path.isfile(str(path)) and _lower_suffix(str(path), PLASMID_MAP_SUFFIXES + FASTA_SUFFIXES):
            out.append({"kind": "file", "path": str(path), "label": f"{meta.get('label') or name} (plasmid map)",
                        "plasmid": name})
    return out


def reference_kind(path: str) -> Optional[str]:
    if _lower_suffix(path, PLASMID_MAP_SUFFIXES):
        return "plasmid_map"
    if _lower_suffix(path, FASTA_SUFFIXES):
        return "fasta"
    return None


def resolve_reference(ref: dict) -> dict:
    """{'path', 'kind', 'label', 'genome_id'?} for the wizard's reference choice."""
    ref = ref or {}
    choice = ref.get("kind")
    if choice == "genome":
        genome_id = str(ref.get("genome_id") or "")
        local, error = catalog_genome_fasta(genome_id)
        if local is None:
            raise InputError(error or "Genome unavailable", "reference",
                             hint="download_genome" if error and "not downloaded" in error else "")
        return {"path": local, "kind": "fasta", "label": genome_id, "genome_id": genome_id}
    if choice == "file":
        raw = str(ref.get("path") or "").strip()
        if not raw:
            raise InputError("Choose a reference: a genome, a FASTA or a plasmid map.", "reference")
        path = os.path.abspath(os.path.expanduser(raw))
        if not os.path.isfile(path):
            raise InputError(f"Reference not found: {path}", "reference")
        if not os.access(path, os.R_OK):
            raise InputError(f"Cannot read {path} (permissions).", "reference")
        kind = reference_kind(path)
        if kind is None:
            raise InputError(
                f"{os.path.basename(path)} is not a FASTA (.fa/.fasta/.fna) or a plasmid map (.dna/.gb/.gbk/.embl).",
                "reference")
        return {"path": path, "kind": kind, "label": os.path.basename(path)}
    raise InputError("Choose a reference: a genome, a FASTA or a plasmid map.", "reference")


def parse_regions(values) -> list[str]:
    out = []
    for raw in values or []:
        text = str(raw or "").strip()
        if not text:
            continue
        m = _REGION.match(text)
        if not m:
            raise InputError(f"Region '{text}' is not chrom:start-end (e.g. chr2L:1,000-5,000).", "regions")
        start, end = int(m["start"].replace(",", "")), int(m["end"].replace(",", ""))
        if end <= start:
            raise InputError(f"Region '{text}' ends before it starts.", "regions")
        out.append(f"{m['chrom']}:{start}-{end}")
    return out


# --------------------------------------------------------------------------
# The pipeline command and its aligner check
# --------------------------------------------------------------------------

def _fiberhmm_source_root() -> Optional[str]:
    try:
        from services.fiberhmm_runtime import bundled_fiberhmm_root
        root = bundled_fiberhmm_root()
    except Exception:
        return None
    return str(root) if root else None


def _module_available(name: str) -> bool:
    try:
        from services.fiberhmm_runtime import configure_fiberhmm_runtime
        configure_fiberhmm_runtime()
    except Exception:
        pass
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def pipeline_command() -> dict:
    """How to start fiberhmm-pipeline: {'argv': [...], 'source', 'env'} or {'argv': None, 'hint'}.

    FIBERBROWSER_PIPELINE_COMMAND (an argv, shell-quoted) overrides; else the
    FiberHMM this Browser uses (its Python, ``-m fiberhmm.cli.pipeline``);
    else a ``fiberhmm-pipeline`` on PATH.
    """
    override = os.environ.get(PIPELINE_ENV, "").strip()
    if override:
        return {"argv": shlex.split(override), "source": "environment", "env": {}}
    if _module_available("fiberhmm.cli.pipeline"):
        env = {}
        root = _fiberhmm_source_root()
        if root:
            env["PYTHONPATH"] = root + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")
        return {"argv": [sys.executable, "-m", "fiberhmm.cli.pipeline"], "source": "fiberhmm", "env": env}
    found = shutil.which("fiberhmm-pipeline")
    if found:
        return {"argv": [found], "source": "path", "env": {}}
    try:
        from services.fiberhmm_runtime import fiberhmm_install_help
        hint = fiberhmm_install_help()
    except Exception:
        hint = "Install FiberHMM 3 (pip install 'fiberhmm[consensus]>=3.0,<4') in FiberBrowser's Python."
    return {"argv": None, "source": None, "env": {},
            "hint": "fiberhmm-pipeline (FiberHMM 3.0 or newer) is not installed. " + hint}


def call_command() -> dict:
    """How to start fiberhmm-call, from the same FiberHMM as fiberhmm-pipeline:
    {'argv', 'source', 'env'} or {'argv': None, 'hint'}.

    FIBERBROWSER_CALL_COMMAND (an argv, shell-quoted) overrides. Else it is
    resolved as pipeline_command() resolves fiberhmm-pipeline: the same
    interpreter and environment with ``-m fiberhmm.cli.call``, or the
    ``fiberhmm-call`` beside (or, for a bare name, on the PATH like) the
    ``fiberhmm-pipeline`` it would run."""
    override = os.environ.get(CALL_ENV, "").strip()
    if override:
        return {"argv": shlex.split(override), "source": "environment", "env": {}}
    pipeline = pipeline_command()
    argv = list(pipeline.get("argv") or [])
    if not argv:
        return {"argv": None, "source": None, "env": {},
                "hint": str(pipeline.get("hint") or "").replace("fiberhmm-pipeline", "fiberhmm-call")
                or "fiberhmm-call (FiberHMM 3.0 or newer) is not installed."}
    if "-m" in argv[1:-1]:
        at = argv.index("-m", 1)
        if argv[at + 1] == "fiberhmm.cli.pipeline":
            return {**pipeline, "argv": [*argv[:at + 1], "fiberhmm.cli.call", *argv[at + 2:]]}
    name = os.path.basename(argv[0])
    stem, ext = os.path.splitext(name)
    if stem == "fiberhmm-pipeline":
        folder = os.path.dirname(argv[0])
        sibling = (os.path.join(folder, "fiberhmm-call" + ext) if folder
                   else shutil.which("fiberhmm-call" + ext) or "")
        if sibling and os.path.isfile(sibling):
            return {**pipeline, "argv": [sibling, *argv[1:]]}
    return {"argv": None, "source": None, "env": {},
            "hint": f"The Library runs fiberhmm-pipeline as {' '.join(argv)}, but cannot tell which fiberhmm-call "
                    f"goes with it; set {CALL_ENV} to that fiberhmm-call command."}


GENERIC_ALIGNER_HINT = (
    "minimap2 is needed to align the reads. Install it with one of: "
    "brew install minimap2 (macOS), conda install -c bioconda minimap2, "
    "sudo apt install minimap2 (Debian/Ubuntu), or pip install mappy."
)


def aligner_status(command: Optional[dict] = None) -> dict:
    """Whether the pipeline can align, using the pipeline's own check when it is importable."""
    command = command or pipeline_command()
    if command.get("source") == "environment":
        return {"ok": True, "checked": False, "name": None, "hint": ""}
    # The job's PATH puts the resolver's minimap2 first (pipeline_jobs), so FiberHMM finds it
    # there even when the server's PATH doesn't have it (the Mac app from the Finder).
    from services.external_tools import resolve
    mm2 = resolve("minimap2")
    if mm2.ok:
        return {"ok": True, "checked": True, "name": f"minimap2 {mm2.version}".strip(), "hint": ""}
    if _module_available("fiberhmm.pipeline.aligner"):
        try:
            from fiberhmm.pipeline.aligner import AlignerNotFound, find_aligner
        except Exception as exc:  # a broken install
            return {"ok": False, "checked": True, "name": None, "hint": f"{GENERIC_ALIGNER_HINT} ({exc})"}
        try:
            aligner = find_aligner("auto")
        except AlignerNotFound as exc:
            return {"ok": False, "checked": True, "name": None, "hint": str(exc).strip()}
        except Exception as exc:
            return {"ok": False, "checked": True, "name": None, "hint": f"{GENERIC_ALIGNER_HINT} ({exc})"}
        kind = getattr(aligner, "kind", None) or getattr(aligner, "name", None) or "aligner"
        version = getattr(aligner, "version", None)
        return {"ok": True, "checked": True, "name": f"{kind} {version}".strip() if version else str(kind), "hint": ""}
    if _module_available("mappy"):
        return {"ok": True, "checked": True, "name": "mappy", "hint": ""}
    return {"ok": False, "checked": True, "name": None, "hint": GENERIC_ALIGNER_HINT}


def default_cores() -> int:
    return max(1, min(4, os.cpu_count() or 1))


def default_output_root(name: str, today: Optional[_dt.date] = None) -> str:
    today = today or _dt.date.today()
    folder = f"{today.isoformat()}_{sanitize_sample_name(name)}"
    from services.lab.paths import write_roots
    roots = write_roots()
    if roots:  # a lab server: its first writable data root, not the server account's home
        return os.path.join(roots[0], folder)
    return os.path.join(os.path.expanduser("~"), "FiberHMM runs", folder)


def display_command(args: list[str]) -> str:
    """The equivalent terminal command (for "Copy command"); never executed."""
    return " ".join(shlex.quote(a) for a in ["fiberhmm-pipeline", *args])


def _call_arg_values(call_args: list[str]) -> list[str]:
    """Every string value in fiberhmm-call arguments, resolved with fiberhmm-call's own
    parser (FiberHMM's fiberhmm.pipeline.runner, the way its pipeline finds the
    files --call-args depends on): ``-m PATH``, ``-mPATH``, ``--model=PATH`` and
    unique prefixes all give PATH. Tokens the parser doesn't know, or all of them
    when it is unavailable or refuses them, are taken whole (and after ``=``, and
    after a short option letter)."""
    import contextlib
    import io
    leftover = list(call_args)
    values: list[str] = []
    try:
        from fiberhmm.pipeline import runner
        parser = runner._call_parser()
    except Exception:
        parser = None
    if parser is not None:
        for action in parser._actions:
            action.required = False

        class _Refused(Exception):
            pass

        def error(message):
            raise _Refused(message)

        parser.error = error
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                defaults = vars(parser.parse_known_args([])[0])
                namespace, leftover = parser.parse_known_args(list(call_args))
        except (_Refused, SystemExit, ValueError, TypeError):
            leftover = list(call_args)
        else:
            for key, value in vars(namespace).items():
                if key in defaults and defaults[key] == value:
                    continue  # fiberhmm-call's own default (bundled models...), not from these arguments
                items = value if isinstance(value, (list, tuple)) else [value]
                values.extend(item for item in items if isinstance(item, str))
    for token in leftover:
        values.append(token)
        if token.startswith("-") and "=" in token:
            values.append(token.split("=", 1)[1])
        elif token.startswith("-") and not token.startswith("--") and len(token) > 2:
            values.append(token[2:])
    return values


def run_option_paths(extra, cwd: Optional[str]) -> list[tuple[str, bool]]:
    """(absolute path, exists) for every file or folder a run's extra pipeline options
    name, including each file-valued fiberhmm-call option inside ``--call-args``.
    Relative values resolve against ``cwd`` (the run's output folder, where the
    pipeline runs); values that aren't paths (numbers, choices) are left out."""
    import shlex
    from services.lab.paths import is_remote_url
    tokens = [str(t) for t in (extra or [])]
    values: list[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        call_text = None
        if token == "--call-args" and i + 1 < len(tokens):
            call_text, i = tokens[i + 1], i + 1
        elif token.startswith("--call-args="):
            call_text = token.split("=", 1)[1]
        if call_text is not None:
            try:
                values += _call_arg_values(shlex.split(call_text))
            except ValueError:
                values += call_text.split()
        else:
            values.append(token)
            if token.startswith("-") and "=" in token:
                values.append(token.split("=", 1)[1])
        i += 1
    out: list[tuple[str, bool]] = []
    for value in values:
        if not value or value.startswith("-") or is_remote_url(value):
            continue
        expanded = os.path.expanduser(value)
        full = expanded if os.path.isabs(expanded) or not cwd else os.path.join(cwd, expanded)
        exists = os.path.exists(full)
        if exists or os.sep in value or value.startswith(("~", ".")):
            out.append((os.path.abspath(full), exists))
    return out


def _confine_run_paths(reads, reference, outdir, extra) -> None:
    """A lab server: every file a run reads (reads, reference, files named in its
    options, including those recovered from a run's stored settings) inside the data
    roots, and its output folder in a writable one, checked where the command is
    built; InputError otherwise. A no-op elsewhere."""
    from services.lab.paths import PathDenied, confine, enforcing
    if not enforcing():
        return
    checks = [(p, False, "reads") for p in reads] + [(reference, False, "reference"), (outdir, True, "output")]
    # Files named by its options (a SNP mask, a model given to fiberhmm-call with -m
    # inside --call-args...): existing ones are read, others would be written.
    checks += [(p, not exists, "options") for p, exists in run_option_paths(extra, outdir)]
    for path, write, field_name in checks:
        try:
            confine(path, write=write)
        except PathDenied as exc:
            raise InputError(f"{exc} ({os.path.basename(str(path))})", field_name) from None
    # A raw POD5 folder is given to the pipeline (and dorado) as a folder: what is inside counts too.
    for path in reads:
        if isinstance(path, str) and os.path.isdir(path):
            def permitted(item: str) -> bool:
                try:
                    confine(item)
                    return True
                except PathDenied:
                    return False
            escape = raw_folder_escape(path, permitted)
            if escape:
                raise InputError(f"{os.path.basename(path)} holds {os.path.relpath(escape, path)}, which links outside "
                                 "the lab's data folders.", "reads")


def pipeline_args(*, reads: list[str], reference: str, enzyme: str, outdir: str, sample: str,
                  cores: int, progress: str, regions: Optional[list[str]] = None,
                  extra: Optional[list[str]] = None, tool_args: Optional[list[str]] = None) -> list[str]:
    """The arguments after the command (contract v1). Values are separate argv items.

    ``tool_args``: programs FiberBrowser chose for the job (``--dorado PATH``); they are not
    data, so a lab server does not confine them to its data folders as it does ``extra``."""
    if enzyme not in PIPELINE_ENZYMES:
        raise InputError(f"Unknown enzyme: {enzyme}", "enzyme")
    if not reads:
        raise InputError("No read files for this sample.", "reads")
    _confine_run_paths(reads, reference, outdir, extra)
    args = [*reads, "--reference", reference, "--enzyme", enzyme, "-o", outdir,
            "--sample", sample, "--cores", str(int(cores)), "--progress-json", progress]
    for region in regions or []:
        args += ["--region", region]
    return args + list(extra or []) + list(tool_args or [])


def check_output_dir(path: str) -> tuple[str, list[str]]:
    """Absolute output folder; raises when it cannot be created or written."""
    warnings: list[str] = []
    raw = str(path or "").strip()
    if not raw:
        raise InputError("Choose an output folder.", "output")
    out = os.path.abspath(os.path.expanduser(raw))
    from services.lab.paths import PathDenied, confine
    try:
        confine(out, write=True)  # a lab server: only in a writable data root
    except PathDenied as exc:
        raise InputError(str(exc), "output") from None
    probe = out
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    if os.path.exists(out) and not os.path.isdir(out):
        raise InputError(f"{out} is a file, not a folder.", "output")
    if not os.access(probe, os.W_OK):
        raise InputError(f"Cannot write to {probe}.", "output")
    return out, warnings


# --------------------------------------------------------------------------
# Calling options (contract addendum): defaults are fiberhmm-call's defaults,
# and only a changed option adds a flag. The flag spelling is read from the
# installed pipeline's --help, so an older pipeline without an option is
# refused up front instead of failing on an unknown argument.
# --------------------------------------------------------------------------

DEFAULT_OPTIONS = {
    "dedup": "auto",            # auto | on | off (DAF PCR-duplicate marking)
    "dedup_mode": "flag",       # flag (mark 0x400, keep all reads) | collapse (remove copies)
    "snp_screen": "auto",       # auto | on | off (DAF recurrent-SNP screen)
    "snp_mask": "",             # BED of SNP sites to mask (optional)
    "chimera_filter": True,     # skip strand-swap chimeras
    "alignments": "primary-supplementary",  # primary | primary-supplementary (3.0 default) | all
    "prob_threshold": None,     # ML threshold override (0-255)
    "use_m5c": "auto",          # DddA CpG-aware recall: auto | on | off
    "cpg_mask_policy": "unmethylated-only",
}
CPG_POLICIES = ("unmethylated-only", "methylated-only")
ALIGNMENT_SETS = ("primary", "primary-supplementary", "all")
_help_cache: dict[tuple, Optional[str]] = {}


def pipeline_help(argv: list[str], env: Optional[dict] = None, timeout: float = 60.0) -> Optional[str]:
    """``<pipeline> --help`` output (cached per command), or None when it cannot run."""
    import subprocess
    key = tuple(argv)
    if key in _help_cache:
        return _help_cache[key]
    run_env = dict(os.environ)
    run_env.update(env or {})
    run_env.setdefault("FIBERHMM_NO_UPDATE_CHECK", "1")
    try:
        proc = subprocess.run([*argv, "--help"], capture_output=True, text=True, timeout=timeout,
                              env=run_env, stdin=subprocess.DEVNULL)
        text = (proc.stdout or "") + (proc.stderr or "")
        result = text if proc.returncode == 0 and text.strip() else None
    except (OSError, subprocess.SubprocessError):
        result = None
    _help_cache[key] = result
    return result


def _has_flag(help_text: str, flag: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(flag)}(?![\w-])", help_text) is not None


def _has_choice_flag(help_text: str, flag: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(flag)}[ =]\{{", help_text) is not None


def normalize_options(raw: Optional[dict]) -> dict:
    options = dict(DEFAULT_OPTIONS)
    for key, value in (raw or {}).items():
        if key in options:
            options[key] = value
    # Before FiberHMM 3.0's --alignments: primary_only (true: primary records only; false: every record).
    if "alignments" not in (raw or {}) and "primary_only" in (raw or {}):
        options["alignments"] = "primary" if raw["primary_only"] else "all"
    if options["alignments"] not in ALIGNMENT_SETS:
        raise InputError("Alignments: choose primary, primary-supplementary or all.", "options")
    for key in ("dedup", "snp_screen", "use_m5c"):
        if options[key] not in ("auto", "on", "off"):
            raise InputError(f"{key}: choose auto, on or off.", "options")
    if options["dedup_mode"] not in ("flag", "collapse"):
        raise InputError("Duplicate handling: choose mark (keep all reads) or collapse.", "options")
    if options["cpg_mask_policy"] not in CPG_POLICIES:
        raise InputError("CpG masking policy: unmethylated-only or methylated-only.", "options")
    options["chimera_filter"] = bool(options["chimera_filter"])
    threshold = options["prob_threshold"]
    if threshold in ("", None):
        options["prob_threshold"] = None
    else:
        try:
            threshold = int(threshold)
        except (TypeError, ValueError) as exc:
            raise InputError("ML threshold: a whole number from 0 to 255.", "options") from exc
        if not 0 <= threshold <= 255:
            raise InputError("ML threshold: a whole number from 0 to 255.", "options")
        options["prob_threshold"] = threshold
    mask = str(options["snp_mask"] or "").strip()
    if mask:
        mask = os.path.abspath(os.path.expanduser(mask))
        if not os.path.isfile(mask):
            raise InputError(f"SNP mask not found: {mask}", "options")
        if not _lower_suffix(mask, (".bed", ".bed.gz")):
            raise InputError("The SNP mask is a BED file (.bed or .bed.gz).", "options")
    options["snp_mask"] = mask
    return options


def changed_options(options: dict, enzyme: str) -> list[str]:
    """Human names of the options that differ from the defaults (for the job card)."""
    labels = []
    if options["dedup"] != "auto":
        labels.append(f"duplicates {options['dedup']}")
    if options["dedup_mode"] == "collapse" and options["dedup"] != "off":
        labels.append("collapse duplicates")
    if options["snp_screen"] != "auto":
        labels.append(f"SNP screen {options['snp_screen']}")
    if options["snp_mask"]:
        labels.append("SNP mask")
    if not options["chimera_filter"]:
        labels.append("keep chimeras")
    if options["alignments"] == "primary":
        labels.append("primary alignments only")
    elif options["alignments"] == "all":
        labels.append("all alignments")
    if options["prob_threshold"] is not None:
        labels.append(f"ML threshold {options['prob_threshold']}")
    if enzyme == "ddda" and options["use_m5c"] != "auto":
        labels.append(f"CpG-aware recall {options['use_m5c']}")
    if enzyme == "ddda" and options["cpg_mask_policy"] != "unmethylated-only":
        labels.append(f"CpG mask {options['cpg_mask_policy']}")
    return labels


def option_args(options: dict, enzyme: str, help_text: Optional[str]) -> list[str]:
    """Pipeline flags for the non-default options, spelled as this pipeline spells them."""
    wanted: list[tuple[str, list[list[str]]]] = []

    def want(name: str, *spellings: list[str]) -> None:
        wanted.append((name, list(spellings)))

    if options["dedup"] == "on":
        want("PCR duplicate marking on", ["--dedup", "on"], ["--dedup"])
    elif options["dedup"] == "off":
        want("PCR duplicate marking off", ["--dedup", "off"], ["--no-dedup"])
    if options["dedup_mode"] == "collapse" and options["dedup"] != "off":
        want("collapse duplicates", ["--dedup-mode", "collapse"], ["--dedup-collapse"])
    if options["snp_screen"] == "on":
        want("SNP screen on", ["--snp-screen", "on"], ["--daf-call-snps"])
    elif options["snp_screen"] == "off":
        want("SNP screen off", ["--snp-screen", "off"], ["--no-snp-screen"], ["--no-daf-call-snps"])
    if options["snp_mask"]:
        want("SNP mask file", ["--snp-mask", options["snp_mask"]], ["--daf-snp-mask", options["snp_mask"]])
    if not options["chimera_filter"]:
        want("keep chimeras", ["--no-chimera-filter"], ["--keep-chimeras"])
    if options["alignments"] == "primary":
        want("primary alignments only", ["--alignments", "primary"], ["--primary"])
    elif options["alignments"] == "all":
        want("call all alignments", ["--alignments", "all"], ["--no-primary"])
    if options["prob_threshold"] is not None:
        value = str(options["prob_threshold"])
        want("ML threshold", ["--prob-threshold", value], ["--ml-threshold", value])
    if enzyme == "ddda" and options["use_m5c"] == "on":
        want("CpG-aware recall on", ["--use-m5c"])
    elif enzyme == "ddda" and options["use_m5c"] == "off":
        want("CpG-aware recall off", ["--no-use-m5c"])
    if enzyme == "ddda" and options["cpg_mask_policy"] != "unmethylated-only":
        want("CpG masking policy", ["--cpg-mask-policy", options["cpg_mask_policy"]])

    args: list[str] = []
    for name, spellings in wanted:
        chosen = None
        for spelling in spellings:
            flag = spelling[0]
            if help_text is None:
                chosen = spellings[0]
                break
            # A two-item spelling whose value is a choice word needs the
            # choice form (--dedup {auto,on,off}); a path/number value or a
            # bare flag just needs the flag.
            is_choice = len(spelling) == 2 and spelling[1] in ("on", "off", "collapse", *ALIGNMENT_SETS)
            if (is_choice and _has_choice_flag(help_text, flag)) or (not is_choice and _has_flag(help_text, flag)):
                chosen = spelling
                break
        if chosen is None:
            raise InputError(
                f"This FiberHMM's fiberhmm-pipeline has no option for '{name}'. "
                "Update FiberHMM, or leave that option at its default.", "options")
        args += chosen
    return args


# --------------------------------------------------------------------------
# Basecalling (raw Nanopore POD5 input): the pipeline runs dorado (FiberHMM 3.0)
# --------------------------------------------------------------------------

DEFAULT_BASECALL = {
    "model": "sup",             # fast / hac / sup[@vX.Y.Z], a model complex (sup,6mA) or a model folder
    "modified_bases": "auto",   # auto (6mA for Hia5, none for DAF) | none | codes, e.g. "6mA" or "5mCG_5hmCG 6mA"
    "device": "auto",           # auto | metal | cpu | cuda:all | cuda:0[,1...]
    "batchsize": None,          # dorado --batchsize (None: dorado chooses)
}
DEFAULT_MODIFIED_BASES = {"hia5": "6mA", "ddda": None, "dddb": None}
_MODEL = re.compile(r"^[A-Za-z0-9_.@,+~/\\:-][A-Za-z0-9_.@,+~/\\: -]*$")
_DEVICE = re.compile(r"^(auto|metal|cpu|cuda(:all|:\d+(,\d+)*)?)$")
_MOD_CODE = re.compile(r"^[A-Za-z0-9_]+$")


def normalize_basecall(raw: Optional[dict]) -> dict:
    """The wizard's basecalling choices, checked (InputError otherwise)."""
    settings = dict(DEFAULT_BASECALL)
    for key, value in (raw or {}).items():
        if key in settings:
            settings[key] = value
    model = str(settings["model"] or "").strip() or "sup"
    if model.startswith("-") or not _MODEL.match(model):
        raise InputError("Basecalling model: fast, hac or sup (optionally @vX.Y.Z), or a dorado model folder.",
                         "basecall")
    if model.startswith("~") or os.sep in model or "/" in model:
        # A model folder: the job runs in its output folder, without a shell to expand ~.
        model = os.path.abspath(os.path.expanduser(model))
        if not os.path.isdir(model):
            raise InputError(f"Basecalling model folder not found: {model}", "basecall")
    settings["model"] = model
    mods = str(settings["modified_bases"] or "auto").strip()
    if mods.lower() in ("auto", "none"):
        mods = mods.lower()
    elif "," in model:
        raise InputError("The model already names its modification models (a model complex such as sup,6mA); "
                         "leave Modified bases on Automatic.", "basecall")
    elif not all(_MOD_CODE.match(code) for code in re.split(r"[\s,]+", mods) if code):
        raise InputError("Modified bases: automatic, none, or dorado codes such as 6mA or 5mCG_5hmCG.", "basecall")
    else:
        mods = " ".join(code for code in re.split(r"[\s,]+", mods) if code)
    settings["modified_bases"] = mods
    device = str(settings["device"] or "auto").strip().lower()
    if not _DEVICE.match(device):
        raise InputError("Device: automatic, metal (Apple), cuda:all / cuda:0 (NVIDIA) or cpu.", "basecall")
    settings["device"] = device
    batch = settings["batchsize"]
    if batch in ("", None, 0):
        settings["batchsize"] = None
    else:
        try:
            batch = int(batch)
        except (TypeError, ValueError) as exc:
            raise InputError("Batch size: a whole number (blank: dorado chooses).", "basecall") from exc
        if not 1 <= batch <= 100_000:
            raise InputError("Batch size: a whole number from 1 to 100000 (blank: dorado chooses).", "basecall")
        settings["batchsize"] = batch
    return settings


def effective_modified_bases(settings: dict, enzyme: str) -> Optional[str]:
    """What dorado will call besides the bases: the codes, or None (plain basecalling)."""
    mods = settings.get("modified_bases") or "auto"
    if "," in str(settings.get("model") or ""):
        return str(settings["model"]).split(",", 1)[1]
    if mods == "auto":
        return DEFAULT_MODIFIED_BASES.get(enzyme)
    return None if mods == "none" else mods


def basecall_labels(settings: dict, enzyme: str) -> list[str]:
    """The job card's words for the basecalling: always shown for a POD5 run."""
    mods = effective_modified_bases(settings, enzyme)
    model = str(settings.get("model") or "sup").split(",", 1)[0]
    words = f"basecall: dorado {model}" + (f" + {mods}" if mods else " (no modification model)")
    labels = [words]
    if settings.get("device") not in (None, "auto"):
        labels.append(f"device {settings['device']}")
    if settings.get("batchsize"):
        labels.append(f"batch {settings['batchsize']}")
    return labels


def basecall_args(settings: dict, enzyme: str, help_text: Optional[str]) -> list[str]:
    """``--dorado-*`` flags for the choices that differ from the pipeline's own defaults (none for the
    defaults: sup, the enzyme's modification model, device auto, dorado's batch size). Refused up front
    when this pipeline cannot basecall (FiberHMM before 3.0)."""
    if help_text is not None and not _has_flag(help_text, "--dorado"):
        raise InputError("This FiberHMM's fiberhmm-pipeline cannot basecall raw Nanopore POD5 (it has no dorado "
                         "step). Update FiberHMM to 3.0 or newer, or basecall with dorado yourself and give the "
                         "BAM as reads.", "basecall")
    args: list[str] = []
    if settings["model"] != DEFAULT_BASECALL["model"]:
        args += ["--dorado-model", settings["model"]]
    mods = settings["modified_bases"]
    if mods == "none":
        if DEFAULT_MODIFIED_BASES.get(enzyme) and "," not in settings["model"]:
            args += ["--dorado-modified-bases", "none"]
    elif mods != "auto" and mods != DEFAULT_MODIFIED_BASES.get(enzyme):
        args += ["--dorado-modified-bases", mods]
    if settings["device"] != "auto":
        args += ["--dorado-device", settings["device"]]
    if settings["batchsize"]:
        args += ["--dorado-batchsize", str(settings["batchsize"])]
    if help_text is not None:
        for flag in [a for a in args if a.startswith("--")]:
            if not _has_flag(help_text, flag):
                raise InputError(f"This FiberHMM's fiberhmm-pipeline has no {flag}; update FiberHMM, or leave that "
                                 "basecalling choice at its default.", "basecall")
    return args


def dorado_status(*, refresh: bool = False) -> dict:
    """The dorado a POD5 run would use (path, version) or how to install it (services/external_tools.py)."""
    from services.external_tools import dorado_status as status
    return status(refresh=refresh)
