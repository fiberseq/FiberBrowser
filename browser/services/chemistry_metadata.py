"""Read versioned FiberHMM chemistry metadata from BAM headers."""
from __future__ import annotations

import os
import tempfile
import shutil
import threading
from pathlib import Path
from typing import Any

import pysam

from services.fiberhmm_runtime import configure_fiberhmm_runtime
from utils.validation import is_url


SUPPORTED_SCAN_CHEMISTRIES = {
    "ddda", "dddb", "hia5-pacbio", "hia5-nanopore",
}


DECLARATIONS = {
    "ddda": {"assay": "daf", "enzyme": "ddda", "platform": "unspecified", "mode": "daf"},
    "dddb": {"assay": "daf", "enzyme": "dddb", "platform": "unspecified", "mode": "daf"},
    "hia5-pacbio": {"assay": "fiber-seq", "enzyme": "hia5", "platform": "pacbio", "mode": "pacbio-fiber"},
    "hia5-nanopore": {"assay": "fiber-seq", "enzyme": "hia5", "platform": "nanopore", "mode": "nanopore-fiber"},
}


_HEADER_WRITE_LOCK = threading.Lock()


def save_bam_chemistry(paths, chemistry, platform=None):
    """Write canonical @CO declarations, staging BAMs and indexes before replacement.

    The canonical writer rejects incompatible declarations. Failed preparation
    leaves every source untouched; failed installation restores original files.
    """
    if chemistry not in DECLARATIONS:
        raise ValueError('Unsupported chemistry')
    sources = list(dict.fromkeys(str(path) for path in paths))
    if not sources or any(is_url(path) or not Path(path).is_file() for path in sources):
        raise ValueError('Writing BAM metadata requires local source files')
    from services.lab.paths import confine
    for source in sources:
        # A lab server: only BAMs in a writable data root (PathDenied is an OSError).
        confine(source, write=True)
        confine(str(Path(source).resolve()), write=True)
    configure_fiberhmm_runtime(strict=True)
    from fiberhmm.io.bam_header import append_chemistry, declared_chemistries
    with _HEADER_WRITE_LOCK:
        staged, folders, installed = [], [], []
        recovery_failed = False
        try:
            for raw in sources:
                source = Path(raw).resolve()
                stat = source.stat()
                with pysam.AlignmentFile(str(source), 'rb', check_sq=False) as bam:
                    declaration = dict(DECLARATIONS[chemistry])
                    existing = declared_chemistries(bam.header)
                    # Preserve exact existing provenance if this assay is already declared.
                    if existing and all(consensus_chemistry_key(item) == chemistry for item in existing):
                        declaration = dict(existing[-1])
                    elif chemistry in ('ddda', 'dddb'):
                        platforms = {str(group.get('PL', '')).lower() for group in bam.header.to_dict().get('RG', [])}
                        inferred = 'pacbio' if platforms & {'pacbio', 'pacbio_smrt'} else 'nanopore' if platforms & {'ont', 'nanopore', 'oxfordnanopore'} else None
                        declaration['platform'] = platform or inferred or 'unspecified'
                        if declaration['platform'] == 'unspecified':
                            raise ValueError('Select the sequencing platform before writing BAM metadata')
                    header = append_chemistry(bam.header, declaration)
                    if str(header) == str(bam.header):
                        continue
                folder = Path(tempfile.mkdtemp(prefix='.fiberbrowser-header-', dir=source.parent))
                folders.append(folder)
                header_path = folder / 'header.sam'
                header_path.write_text(str(header))
                replacement = folder / 'updated.bam'
                replacement.touch()
                pysam.reheader('-P', str(header_path), str(source), save_stdout=str(replacement))
                pysam.quickcheck(str(replacement))
                with pysam.AlignmentFile(str(replacement), 'rb', check_sq=False) as check:
                    if declared_chemistries(check.header) != declared_chemistries(header):
                        raise ValueError('BAM header verification failed')
                index_targets = list(dict.fromkeys(candidate for candidate in (
                    Path(str(source)+'.bai'), source.with_suffix('.bai'),
                    Path(str(source)+'.csi'), source.with_suffix('.csi')) if candidate.exists()))
                if not index_targets:
                    index_targets = [Path(str(source)+'.csi')]
                replacements = [(source, replacement)]
                for i, target in enumerate(index_targets):
                    index = folder / f'index-{i}{target.suffix}'
                    pysam.index('-c' if target.suffix == '.csi' else '-b', '-o', str(index), str(replacement))
                    with pysam.AlignmentFile(str(replacement), 'rb', index_filename=str(index)) as check:
                        check.check_index()
                    replacements.append((target, index))
                os.chmod(replacement, stat.st_mode & 0o777)
                staged.append((source, stat, replacements, folder))
            for source, stat, _, _ in staged:
                now = source.stat()
                if (now.st_size, now.st_mtime_ns, now.st_ino) != (stat.st_size, stat.st_mtime_ns, stat.st_ino):
                    raise ValueError('Source changed while preparing BAM metadata')
            try:
                for _, _, replacements, folder in staged:
                    for i, (target, replacement) in enumerate(replacements):
                        backup = folder / f'original-{i}' if target.exists() else None
                        if backup is not None:
                            os.replace(target, backup)
                        installed.append((target, backup))
                        os.replace(replacement, target)
            except BaseException:
                for target, backup in reversed(installed):
                    try:
                        if backup is None:
                            target.unlink(missing_ok=True)
                        else:
                            os.replace(backup, target)
                    except OSError:
                        recovery_failed = True
                if recovery_failed:
                    raise RuntimeError('Could not restore all files; originals retained in: ' + ', '.join(map(str, folders)))
                raise
            return sources
        finally:
            if not recovery_failed:
                for folder in folders:
                    shutil.rmtree(folder)


def dataset_consensus_chemistry(dataset) -> str | None:
    """A dataset's footprint-class datatype ('ddda', 'dddb', 'hia5-pacbio', 'hia5-nanopore'), from
    ``consensus_chemistry`` or its legacy name ``family_scan_chemistry`` (plain namespaces, FiberHMM's own)."""
    return getattr(dataset, "consensus_chemistry", None) or getattr(dataset, "family_scan_chemistry", None)


def consensus_chemistry_key(declaration: dict[str, str] | None) -> str | None:
    """Translate the BAM-spec vocabulary to the footprint-class chemistry key."""
    if not declaration:
        return None
    assay = str(declaration.get("assay", "")).lower()
    enzyme = str(declaration.get("enzyme", "")).lower()
    platform = str(declaration.get("platform", "")).lower()
    mode = str(declaration.get("mode", "")).lower()
    if enzyme in {"ddda", "dddb"} and assay == "daf" and mode == "daf":
        return enzyme
    if enzyme == "hia5" and assay == "fiber-seq":
        if platform == "nanopore" and mode == "nanopore-fiber":
            return "hia5-nanopore"
        if platform == "pacbio" and mode == "pacbio-fiber":
            return "hia5-pacbio"
    return None


def _heuristic_fiber_chemistry(header) -> dict[str, Any] | None:
    """Narrow fallback for pre-FiberHMM fibertools Fiber-seq BAMs."""
    data = header.to_dict()
    programs = data.get("PG", [])
    program_text = "\n".join(
        " ".join(str(value) for value in program.values()) for program in programs
    ).lower()
    if "fibertools" not in program_text and "ft predict-m6a" not in program_text:
        return None
    platforms = {
        str(group.get("PL", "")).strip().lower()
        for group in data.get("RG", [])
        if group.get("PL")
    }
    if any(value in {"pacbio", "pacbio_smrt"} for value in platforms):
        chemistry = "hia5-pacbio"
        platform = "pacbio"
    elif any(value in {"ont", "nanopore", "oxfordnanopore"} for value in platforms):
        chemistry = "hia5-nanopore"
        platform = "nanopore"
    else:
        return None
    return {
        "chemistry": chemistry,
        "source": "header-heuristic",
        "status": "inferred",
        "declaration": {
            "assay": "fiber-seq",
            "enzyme": "hia5",
            "platform": platform,
            "mode": f"{platform}-fiber",
        },
        "message": "inferred from fibertools provenance and @RG platform",
    }


def chemistry_unavailable(error: Exception | None = None) -> dict[str, Any]:
    """Chemistry can't be read without FiberHMM: say so and how to install it."""
    from services.fiberhmm_runtime import fiberhmm_install_help
    detail = f" ({type(error).__name__}: {error})" if error is not None else ""
    return {
        "chemistry": None,
        "source": "fiberhmm-unavailable",
        "status": "unavailable",
        "message": "Chemistry detection needs FiberHMM, which is not installed or too old"
                   f"{detail}. {fiberhmm_install_help()}",
    }


def inspect_bam_chemistry(path: str) -> dict[str, Any]:
    """Inspect one BAM, preferring the authoritative v1 declaration."""
    configure_fiberhmm_runtime()
    try:
        from fiberhmm.io.bam_header import declared_chemistries, infer_legacy_chemistry
    except ImportError as error:
        return chemistry_unavailable(error)

    try:
        from services.remote_sources.opening import open_alignment_file
        with open_alignment_file(path, "rb", check_sq=False) as bam:
            declarations = declared_chemistries(bam.header)
            if declarations:
                model_keys = {consensus_chemistry_key(value) for value in declarations}
                model_keys.discard(None)
                core = {
                    tuple(str(value.get(key, "")).lower() for key in (
                        "assay", "enzyme", "platform", "mode",
                    ))
                    for value in declarations
                }
                if len(core) != 1 or len(model_keys) != 1:
                    return {
                        "chemistry": None,
                        "source": "declared-v1",
                        "status": "conflict",
                        "declarations": declarations,
                        "message": "BAM contains incompatible chemistry declarations",
                    }
                return {
                    "chemistry": next(iter(model_keys)),
                    "source": "declared-v1",
                    "status": "declared",
                    "declaration": declarations[-1],
                    "declarations": declarations,
                    "message": "authoritative FIBERHMM-CHEMISTRY:v1 declaration",
                }

            legacy = infer_legacy_chemistry(bam.header)
            legacy_key = consensus_chemistry_key(legacy)
            if legacy_key:
                return {
                    "chemistry": legacy_key,
                    "source": "legacy-fiberhmm-pg",
                    "status": "inferred",
                    "declaration": legacy,
                    "message": "inferred from legacy fiberhmm-call @PG provenance",
                }
            heuristic = _heuristic_fiber_chemistry(bam.header)
            if heuristic:
                return heuristic
    except (OSError, ValueError) as error:
        return {
            "chemistry": None,
            "source": "unreadable",
            "status": "unknown",
            "message": str(error),
        }
    return {
        "chemistry": None,
        "source": "none",
        "status": "unknown",
        "message": "no supported chemistry declaration found",
    }


def inspect_dataset_chemistry(paths: list[str]) -> dict[str, Any]:
    """Resolve one model for every BAM composing a logical Browser dataset."""
    represented_paths = [str(path) for path in paths if path]
    if not represented_paths:
        return {
            "chemistry": None,
            "source": "none",
            "status": "unknown",
            "message": "empty dataset; chemistry was not inspected",
            "files": [],
        }
    per_file = []
    for path in represented_paths:
        if is_url(path):
            result = {
                "chemistry": None,
                "source": "remote-uninspected",
                "status": "unknown",
                "message": "remote BAM chemistry was not inspected",
            }
        else:
            result = inspect_bam_chemistry(path)
        per_file.append({"path": str(Path(path)) if not is_url(path) else path, **result})
    unavailable = next((item for item in per_file if item["status"] == "unavailable"), None)
    if unavailable is not None:
        status = "unavailable"
        message = unavailable["message"]
        chemistry = None
    elif any(item["status"] == "conflict" for item in per_file):
        status = "conflict"
        message = "at least one BAM contains incompatible declarations"
        chemistry = None
    else:
        keys = {item["chemistry"] for item in per_file if item.get("chemistry")}
        unknown_count = sum(not item.get("chemistry") for item in per_file)
        if len(keys) > 1:
            status = "conflict"
            message = "BAMs in this dataset declare different chemistries"
            chemistry = None
        elif unknown_count and keys:
            status = "incomplete"
            message = "only some BAMs in this dataset have resolvable chemistry"
            chemistry = None
        elif not keys:
            status = "unknown"
            message = "no BAM in this dataset has resolvable chemistry"
            chemistry = None
        else:
            chemistry = next(iter(keys))
            status = (
                "declared"
                if all(item["status"] == "declared" for item in per_file)
                else "inferred"
            )
            message = (
                "all BAMs carry authoritative declarations"
                if status == "declared"
                else "chemistry resolved from compatible legacy header provenance"
            )
    sources = sorted({str(item.get("source", "none")) for item in per_file})
    return {
        "chemistry": chemistry,
        "source": "+".join(sources),
        "status": status,
        "message": message,
        "files": per_file,
    }


# Legacy name.
family_scan_chemistry = consensus_chemistry_key
