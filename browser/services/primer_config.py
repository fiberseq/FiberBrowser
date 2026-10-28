"""Primer-design configuration helpers."""
from __future__ import annotations

import glob
import os
import re
import subprocess
from typing import List, Optional

from services.diagnostics import env_flag_enabled, log_if_enabled

PRIMER_DIAGNOSTICS_ENV = "FIBERBROWSER_PRIMER_DIAGNOSTICS"
BLAST_DB_MARKER_EXTENSIONS = ('.nin', '.ndb', '.nal')
BLAST_DB_FILE_EXTENSIONS = (
    '.nin', '.nsq', '.nhr',
    '.ndb', '.not', '.ntf', '.nto',
    '.nal',
)
FASTA_EXTENSIONS = ('.fa.gz', '.fasta.gz', '.fna.gz', '.fa', '.fasta', '.fna')
MAKEBLASTDB_TIMEOUT_SECONDS = 60 * 60


def primer_diagnostics_enabled() -> bool:
    return env_flag_enabled(PRIMER_DIAGNOSTICS_ENV)


def log_primer_diagnostic(message: str) -> None:
    log_if_enabled(PRIMER_DIAGNOSTICS_ENV, message)


def blast_db_exists(prefix: str) -> bool:
    """Return True when a nucleotide BLAST database exists for ``prefix``.

    Only files blastn opens for ``-db prefix`` count: numbered volumes
    (``prefix.00.nin``) alone don't, as blastn needs the alias
    (``prefix.nal``) that makeblastdb writes next to them.
    """
    return any(os.path.isfile(f"{prefix}{ext}") for ext in BLAST_DB_FILE_EXTENSIONS)


def _numbered_volumes(prefix: str) -> List[str]:
    """``prefix.NN`` volume prefixes present on disk, sorted."""
    volumes = set()
    for ext in ('.nin', '.nsq'):
        for path in glob.glob(f"{glob.escape(prefix)}.*{ext}"):
            volume = path[:-len(ext)]
            if volume[len(prefix) + 1:].isdigit():
                volumes.add(volume)
    return sorted(volumes)


def blast_db_missing_message(prefix: str) -> str:
    """Why ``prefix`` can't be used; volumes without their alias/index are named."""
    volumes = _numbered_volumes(prefix)
    if volumes:
        names = ' '.join(os.path.basename(v) for v in volumes)
        base = os.path.basename(prefix)
        return (
            f"BLAST database {prefix} is incomplete: it has numbered volumes ({names}) but not the "
            f"{base}.nal alias and {base}.ndb index that makeblastdb writes beside them, so blastn "
            f"can't open it. Copy those files over too, or rebuild the database from the FASTA."
        )
    return f"BLAST database not found: {prefix}"


def strip_fasta_extension(path: str) -> str:
    """Return a FASTA basename without common compressed/uncompressed suffixes."""
    basename = os.path.basename(path)
    lower = basename.lower()
    for ext in FASTA_EXTENSIONS:
        if lower.endswith(ext):
            return basename[:-len(ext)]
    return os.path.splitext(basename)[0]


def blast_install_message() -> str:
    """User-facing install hint for the NCBI BLAST+ command-line tools."""
    from services.external_tools import install_hint
    return (
        "BLAST+ was not found (looked in the app, PATH, Homebrew and conda folders). "
        + install_hint('blastn')
    )


def makeblastdb_available() -> bool:
    from services.external_tools import tool_path
    return tool_path('makeblastdb') is not None


def normalize_blast_db_prefix(marker_path: str) -> Optional[str]:
    """Convert a BLAST DB marker file path into the prefix passed to blastn.

    ``makeblastdb`` commonly emits ``prefix.nin``/``prefix.ndb`` files, while
    alias and multi-volume layouts can look like ``prefix.nal`` or
    ``prefix.00.nin``. ``blastn -db`` expects the shared prefix, so strip a
    numeric volume suffix when present.
    """
    root, ext = os.path.splitext(marker_path)
    if ext.lower() not in BLAST_DB_MARKER_EXTENSIONS:
        return None
    base, volume = os.path.splitext(root)
    if volume[1:].isdigit():
        return base
    return root


def _marker_prefixes(directory: str) -> set:
    prefixes = set()
    for ext in BLAST_DB_MARKER_EXTENSIONS:
        for marker in glob.glob(os.path.join(glob.escape(directory), f'*{ext}')):
            prefix = normalize_blast_db_prefix(marker)
            if prefix:
                prefixes.add(prefix)
    return prefixes


def scan_blast_dbs(directory: str) -> List[str]:
    """Scan a directory for nucleotide BLAST database prefixes blastn can open.

    A multi-volume database is offered by its shared prefix when its alias
    (``prefix.nal``) is there; bare numbered volumes without one are not (see
    ``unopenable_blast_dbs``), so a listed prefix always configures.
    """
    return sorted(p for p in _marker_prefixes(directory) if blast_db_exists(p))


def unopenable_blast_dbs(directory: str) -> List[str]:
    """Multi-volume prefixes in ``directory`` that lack the alias blastn needs."""
    return sorted(p for p in _marker_prefixes(directory) if not blast_db_exists(p))


def genome_hints(state) -> List[str]:
    """Collect lowercase tokens that identify the reference primer design uses.

    An explicit primer FASTA (``primer_fasta``, set only by the user) is what
    primers are designed from, so the BLAST database must match it, not the
    browser's loaded genome; otherwise the loaded genome and FASTA identify it.
    """
    hints: List[str] = []
    override = getattr(state, 'primer_fasta', None)
    loaded = getattr(state, 'fasta_path', None)
    if override and not (loaded and os.path.abspath(os.path.expanduser(override))
                         == os.path.abspath(os.path.expanduser(loaded))):
        return [strip_fasta_extension(override).lower()]
    genome = getattr(state, 'current_genome', None)
    if genome:
        hints.append(genome.lower())
    fasta_path = loaded or override
    if fasta_path:
        hints.append(strip_fasta_extension(fasta_path).lower())
    return hints


def _safe_blast_label(value: str) -> str:
    label = re.sub(r'[^A-Za-z0-9._-]+', '_', value).strip('._-')
    return label or 'genome'


def _same_file(a: Optional[str], b: Optional[str]) -> bool:
    return bool(a and b) and os.path.abspath(os.path.expanduser(a)) == os.path.abspath(os.path.expanduser(b))


def default_blast_db_prefix(state, fasta_path: str, output_dir: Optional[str] = None) -> str:
    """Return the default local BLAST DB prefix for a FASTA.

    The loaded genome's name labels only the loaded reference's database; any
    other FASTA (a custom primer reference) gets a database of its own name, so
    it never reuses or overwrites the genome's. FIBERBROWSER_BLAST_DB_DIR
    overrides the cache root; an explicit output_dir still takes precedence.
    """
    genome = getattr(state, 'current_genome', None) if _same_file(fasta_path, getattr(state, 'fasta_path', None)) else None
    label = (
        genome
        or strip_fasta_extension(fasta_path)
        or 'genome'
    )
    safe_label = _safe_blast_label(str(label))
    root = (
        os.path.expanduser(output_dir)
        if output_dir
        else os.path.join(os.path.expanduser(os.environ.get('FIBERBROWSER_BLAST_DB_DIR')
                                            or os.path.join('~', '.fiberhmm', 'blast')), safe_label)
    )
    return os.path.join(root, safe_label)


def build_blast_db_from_fasta(
    state,
    *,
    fasta_path: Optional[str] = None,
    output_dir: Optional[str] = None,
    force: bool = False,
) -> dict:
    """Build/select a local nucleotide BLAST database for primer design.

    The browser already has a FASTA loaded for sequence/genome operations, so
    this helper turns that same FASTA into a local BLAST DB and updates primer
    configuration. It never downloads data; missing BLAST+ is reported with a
    concrete install command.
    """
    resolved_fasta = fasta_path or getattr(state, 'primer_fasta', None) or getattr(state, 'fasta_path', None)
    if not resolved_fasta:
        return {
            "success": False,
            "message": "No FASTA loaded. Load a reference genome before building a primer BLAST DB.",
        }
    if not os.path.isfile(resolved_fasta):
        return {"success": False, "message": f"FASTA file not found: {resolved_fasta}"}
    if not makeblastdb_available():
        return {
            "success": False,
            "message": blast_install_message(),
            "missing_dependency": True,
            "dependency": "makeblastdb",
        }

    prefix = default_blast_db_prefix(state, resolved_fasta, output_dir)
    if output_dir:
        from services.lab.paths import confine
        confine(output_dir, write=True)  # a lab server: only in a writable data root
    os.makedirs(os.path.dirname(prefix), exist_ok=True)

    # A database is reused only when it was built from this same FASTA (its
    # recorded source); one built from another file, or since changed, is rebuilt.
    if blast_db_exists(prefix) and not force and blast_db_source_matches(prefix, resolved_fasta):
        set_primer_paths(state, fasta=resolved_fasta if fasta_path else None, blast_db=prefix)
        return {
            "success": True,
            "message": f"Using existing BLAST DB: {prefix}",
            "created": False,
            "blast_db": prefix,
            **primer_config_payload(state, validate_blast=False),
        }

    from services.external_tools import tool_path
    command = [
        tool_path('makeblastdb') or 'makeblastdb',
        '-in', resolved_fasta,
        '-dbtype', 'nucl',
        '-parse_seqids',
        '-out', prefix,
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=MAKEBLASTDB_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "message": "makeblastdb timed out while building the primer BLAST DB.",
            "command": command,
        }

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        message = "makeblastdb failed while building the primer BLAST DB."
        if detail:
            message = f"{message} {detail}"
        return {
            "success": False,
            "message": message,
            "command": command,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }

    if not blast_db_exists(prefix):
        return {
            "success": False,
            "message": f"makeblastdb completed but no BLAST DB marker files were found for {prefix}.",
            "command": command,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }

    record_blast_db_source(prefix, resolved_fasta)
    # An explicitly named FASTA becomes the primer override; the loaded
    # reference is used automatically and so keeps following genome loads.
    set_primer_paths(state, fasta=resolved_fasta if fasta_path else None, blast_db=prefix)
    return {
        "success": True,
        "message": f"Built BLAST DB: {prefix}",
        "created": True,
        "blast_db": prefix,
        "output_dir": os.path.dirname(prefix),
        "command": command,
        **primer_config_payload(state, validate_blast=False),
    }


def _blast_db_source_file(prefix: str) -> str:
    return prefix + '.fiberbrowser-source.json'


def _fasta_identity(fasta_path: str) -> dict:
    st = os.stat(fasta_path)
    return {'path': os.path.abspath(os.path.expanduser(fasta_path)), 'size': st.st_size, 'mtime_ns': st.st_mtime_ns}


def record_blast_db_source(prefix: str, fasta_path: str) -> None:
    """Record which FASTA a database was built from, next to the database."""
    import json
    try:
        with open(_blast_db_source_file(prefix), 'w') as handle:
            json.dump(_fasta_identity(fasta_path), handle)
    except OSError:
        pass


def blast_db_source_matches(prefix: str, fasta_path: str) -> bool:
    """Whether the database at prefix was built from this FASTA as it is now.

    A database without a record (built before records, or by hand) is accepted,
    as before: its name was derived from this FASTA's.
    """
    import json
    try:
        with open(_blast_db_source_file(prefix)) as handle:
            recorded = json.load(handle)
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        return False
    try:
        return recorded == _fasta_identity(fasta_path)
    except OSError:
        return False


def prefix_matches_hints(prefix: str, hints: List[str]) -> bool:
    """Return True when a BLAST DB basename looks like it belongs to hints."""
    db_base = os.path.basename(prefix).lower()
    for hint in hints:
        if hint and (hint in db_base or db_base in hint):
            return True
    return False


def auto_detect_blast_db(prefixes: List[str], state) -> Optional[str]:
    """Try to match a BLAST DB prefix to the current genome or FASTA filename."""
    hints = genome_hints(state)
    if not hints:
        return None
    for prefix in prefixes:
        if prefix_matches_hints(prefix, hints):
            return prefix
    return None


SWITCH_DEFERRED = ("The BLAST database will switch to the current genome's once the genome has finished loading; "
                   "design waits for it.")


def resolve_blast_db_for_genome(state, *, wait: bool = False):
    """Validate or auto-switch the configured BLAST DB for the active genome.

    Returns ``(db, None)`` only for a database validated against the current reference. ``wait=False`` (reading
    the config, status polling): when a switch is needed but the reference is being replaced (locks busy), returns
    ``(None, SWITCH_DEFERRED)``: deferred, never reported as valid. Design resolves with ``wait=True`` under the
    reference locks (primer_orchestration)."""
    current = getattr(state, 'primer_blast_db', None)
    if not current:
        return None, "BLAST database not configured. Pick one from the Primer panel."

    hints = genome_hints(state)
    if not hints:
        return current, None

    if prefix_matches_hints(current, hints):
        return current, None

    parent_dir = os.path.dirname(current) or '.'
    try:
        siblings = scan_blast_dbs(parent_dir)
    except Exception:
        siblings = []

    if len(siblings) > 1:
        for sibling in siblings:
            if sibling != current and prefix_matches_hints(sibling, hints):
                if not set_primer_paths(state, blast_db=sibling, wait=wait):
                    return None, SWITCH_DEFERRED  # the reference is being replaced: switch on the next read
                log_primer_diagnostic(
                    f"[primer] BLAST DB auto-switched: "
                    f"{os.path.basename(current)} -> {os.path.basename(sibling)} "
                    f"(matches current genome {hints[0]})"
                )
                return sibling, None

    genome_label = hints[0]
    db_label = os.path.basename(current)
    sibling_hint = (
        f" Folder '{parent_dir}' contains {len(siblings)} databases "
        f"({', '.join(os.path.basename(s) for s in siblings)}) but none match."
        if siblings else
        f" No sibling databases found in '{parent_dir}'."
    )
    return None, (
        f"BLAST database '{db_label}' doesn't match current genome '{genome_label}'. "
        f"Pick a matching database (or disable primer design)." + sibling_hint
    )


def primer_config_payload(state, *, validate_blast: bool = True) -> dict:
    """Return primer configuration, optionally resolving DB to active genome.

    Reading primer config is intentionally allowed to auto-switch the BLAST DB:
    genome changes should update the active DB before a design job is launched,
    not only after the user reselects a BLAST folder.
    """
    warning = None
    if validate_blast and getattr(state, 'primer_blast_db', None):
        _, warning = resolve_blast_db_for_genome(state)
    # The FASTA design will use: an explicit override, else the loaded reference.
    fasta = getattr(state, 'primer_fasta', None) or getattr(state, 'fasta_path', None)
    from services.external_tools import blast_summary
    return {
        "blast_tool": blast_summary(),
        "fasta": fasta,
        "blast_db": getattr(state, 'primer_blast_db', None),
        "configured": fasta is not None,
        "current_genome": getattr(state, 'current_genome', None),
        "blast_db_warning": warning,
    }


def set_primer_paths(state, *, fasta=None, blast_db=None, wait: bool = True) -> bool:
    """Publish the primer FASTA / BLAST database (reference fields, routed to a view's context) under the
    workspace's state lock and the view's context lock (services/genome_loading.reference_write_lock).

    ``wait=False`` (the auto-switch made while reading the config, also from /api/status on the event loop): when
    the locks are busy (a genome loading) nothing is written and False is returned; the next read switches."""
    from services.genome_loading import reference_write_lock
    locks = reference_write_lock(state)._locks
    taken = []
    try:
        for lock in locks:
            if not lock.acquire(blocking=wait):
                return False
            taken.append(lock)
        if fasta is not None:
            state.primer_fasta = fasta
        if blast_db is not None:
            state.primer_blast_db = blast_db
        return True
    finally:
        for lock in reversed(taken):
            lock.release()
