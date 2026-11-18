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


# The genome id a session gets when only plasmid maps are loaded (routers/genome.py _publish_plasmid): not a
# genome, so no BLAST database is expected to match it.
PLASMID_ONLY_GENOME = 'plasmids'


def _local_file(path) -> Optional[str]:
    if isinstance(path, bytes):
        path = path.decode(errors='replace')
    if isinstance(path, str) and path and os.path.isfile(os.path.expanduser(path)):
        return os.path.expanduser(path)
    return None


def local_primer_fasta(state) -> Optional[str]:
    """The FASTA file primers are designed from, as a local file, or None.

    An explicit primer FASTA wins; otherwise the loaded reference. A genome opened from the Online picker
    keeps its URL in ``fasta_path`` while its handle reads the downloaded copy in the cache: that copy is
    the file (``state.fasta.filename``)."""
    override = getattr(state, 'primer_fasta', None)
    if override:
        return _local_file(override)
    loaded = getattr(state, 'fasta_path', None)
    return _local_file(loaded) or (_local_file(getattr(getattr(state, 'fasta', None), 'filename', None))
                                   if loaded else None)


def primer_fasta_setting(state) -> Optional[str]:
    """The configured primer FASTA as the user named it (override, else loaded reference), local or not."""
    return getattr(state, 'primer_fasta', None) or getattr(state, 'fasta_path', None)


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
    if genome and genome != PLASMID_ONLY_GENOME:
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
    it never reuses or overwrites the genome's.
    """
    loaded = getattr(state, 'fasta_path', None)
    is_loaded = _same_file(fasta_path, loaded) or (
        bool(loaded) and _same_file(fasta_path, _local_file(getattr(getattr(state, 'fasta', None), 'filename', None))))
    genome = getattr(state, 'current_genome', None) if is_loaded else None
    if genome == PLASMID_ONLY_GENOME:
        genome = None
    label = (
        genome
        or strip_fasta_extension(fasta_path)
        or 'genome'
    )
    safe_label = _safe_blast_label(str(label))
    root = (
        os.path.expanduser(output_dir)
        if output_dir
        else os.path.join(os.path.expanduser('~'), '.fiberhmm', 'blast', safe_label)
    )
    return os.path.join(root, safe_label)


# makeblastdb -parse_seqids accepts local sequence ids of at most this many characters.
MAKEBLASTDB_MAX_LOCAL_ID = 50
def _open_fasta_text(path: str):
    import gzip
    with open(path, 'rb') as probe:
        gzipped = probe.read(2) == b'\x1f\x8b'
    if gzipped:
        return gzip.open(path, 'rt', encoding='ascii', errors='replace'), True
    return open(path, 'r', encoding='ascii', errors='replace'), False


def fasta_problem(path: str) -> Optional[str]:
    """Why ``path`` can't be read as a FASTA (None when it can): a binary map such as a SnapGene .dna
    or a GenBank file named as the FASTA is reported here, not by makeblastdb."""
    try:
        handle, _gz = _open_fasta_text(path)
        with handle:
            for line in handle:
                if line.strip():
                    if line.startswith('>'):
                        return None
                    break
    except (OSError, EOFError) as exc:
        return f"Can't read {path}: {exc}"
    name = os.path.basename(path)
    return (f"{name} is not a FASTA file (a FASTA starts with a '>' header line). A plasmid map "
            "(SnapGene .dna, GenBank) is opened with Load plasmid map instead; primers designed on it are "
            "checked against the genome BLAST database you choose.")


def rejected_seq_ids(path: str, limit: int = 5) -> List[str]:
    """Sequence ids (a header's first word) makeblastdb -parse_seqids refuses: longer than
    MAKEBLASTDB_MAX_LOCAL_ID characters. At most ``limit`` are returned."""
    found: List[str] = []
    try:
        handle, _gz = _open_fasta_text(path)
        with handle:
            for line in handle:
                if line.startswith('>'):
                    seq_id = (line[1:].split() or [''])[0]
                    if len(seq_id) > MAKEBLASTDB_MAX_LOCAL_ID:
                        found.append(seq_id)
                        if len(found) >= limit:
                            break
    except (OSError, EOFError):
        pass
    return found


def blast_path_arg(path: str) -> str:
    """A path as BLAST+ reads it: ``-in``/``-db`` split their value on spaces (a list of files or
    databases), so a path with whitespace is passed in double quotes."""
    return f'"{path}"' if any(ch.isspace() for ch in path) else path


class _CompletedLike:
    def __init__(self, returncode, stdout='', stderr=''):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def _run_makeblastdb(input_fasta: str, prefix: str) -> tuple:
    """Run makeblastdb into ``prefix``. makeblastdb can't write to a path with whitespace (even quoted), so
    such a database is built in a temporary folder and its files moved into place."""
    import shutil
    import tempfile
    from services.external_tools import tool_path
    build_prefix, staging = prefix, None
    if any(ch.isspace() for ch in prefix):
        staging = tempfile.mkdtemp(prefix='fiberbrowser-blastdb-')
        if any(ch.isspace() for ch in staging):
            shutil.rmtree(staging, ignore_errors=True)
            return [tool_path('makeblastdb') or 'makeblastdb'], _CompletedLike(1, stderr=(
                f"BLAST+ can't write a database to a folder whose path contains spaces ({os.path.dirname(prefix)}), "
                "and the temporary folder has spaces too. Choose an existing database with Browse instead."))
        build_prefix = os.path.join(staging, os.path.basename(prefix))
    command = [
        tool_path('makeblastdb') or 'makeblastdb',
        '-in', blast_path_arg(input_fasta),
        '-dbtype', 'nucl',
        '-parse_seqids',
        '-out', build_prefix,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=MAKEBLASTDB_TIMEOUT_SECONDS)
        if staging and result.returncode == 0:
            base = os.path.basename(prefix)
            for name in os.listdir(staging):
                if name == base or name.startswith(base + '.'):
                    shutil.move(os.path.join(staging, name), os.path.join(os.path.dirname(prefix), name))
    finally:
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
    return command, result


def no_fasta_to_build_message(state) -> str:
    """Why Build has nothing to work from, naming what is loaded and what to do instead."""
    plasmids = sorted(supplemental_names(state))
    remote = getattr(state, 'fasta_path', None)
    if remote and not local_primer_fasta(state):
        return (f"The loaded reference is not a local file ({remote}), so a BLAST database can't be built from it "
                "here. Download the genome FASTA (or reopen the genome once its download has finished) and build "
                "again, or use Browse to choose an existing BLAST database.")
    if plasmids:
        names = ', '.join(plasmids[:3]) + ('...' if len(plasmids) > 3 else '')
        return (f"No genome FASTA is open, so there is no genome to build a BLAST database from. Primers "
                f"designed on {names} don't need a database built from the plasmid: they are checked against the "
                "genome BLAST database you choose. Use Browse to choose it (for example your dm6 database), or "
                "open the genome FASTA first and build its database.")
    return "No FASTA loaded. Load a reference genome before building a primer BLAST DB."


def supplemental_names(state) -> set:
    sequences = getattr(state, 'plasmid_sequences', None)
    return set(sequences) if isinstance(sequences, dict) else set()


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

    The FASTA is indexed as it is: a database of renamed ids could not map hits back to the contigs, so
    ids makeblastdb refuses are reported for the user to rename.
    """
    if fasta_path:
        resolved_fasta = fasta_path
    else:
        resolved_fasta = local_primer_fasta(state)
        if not resolved_fasta:
            if primer_fasta_setting(state) and not getattr(state, 'fasta_path', None):
                return {"success": False, "message": f"FASTA file not found: {primer_fasta_setting(state)}"}
            return {"success": False, "message": no_fasta_to_build_message(state)}
    if not os.path.isfile(resolved_fasta):
        return {"success": False, "message": f"FASTA file not found: {resolved_fasta}"}
    problem = fasta_problem(resolved_fasta)
    if problem:
        return {"success": False, "message": problem}
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
    try:
        os.makedirs(os.path.dirname(prefix), exist_ok=True)
    except OSError as exc:
        return {"success": False, "message": (
            f"Can't create the BLAST database folder {os.path.dirname(prefix)}: {exc.strerror or exc}. "
            "Choose an existing database with Browse, or open the FASTA from a folder you can write to.")}
    if not os.access(os.path.dirname(prefix), os.W_OK):
        return {"success": False, "message": (
            f"The BLAST database folder {os.path.dirname(prefix)} is not writable. Choose an existing database "
            "with Browse instead.")}
    # An explicitly named FASTA becomes the primer override; the loaded
    # reference is used automatically and so keeps following genome loads.
    override = resolved_fasta if fasta_path else None

    # A database is reused only when it was built from this same FASTA (its
    # recorded source); one built from another file, or since changed, is rebuilt.
    if blast_db_exists(prefix) and not force and blast_db_source_matches(prefix, resolved_fasta):
        set_primer_paths(state, fasta=override, blast_db=prefix)
        return {
            "success": True,
            "message": f"Using existing BLAST DB: {prefix}",
            "created": False,
            "blast_db": prefix,
            **primer_config_payload(state, validate_blast=False),
        }

    with open(resolved_fasta, 'rb') as probe:
        if probe.read(2) == b'\x1f\x8b':
            return {"success": False, "message": (
                f"{os.path.basename(resolved_fasta)} is gzip-compressed; makeblastdb needs a plain FASTA. "
                "Decompress it (gunzip -k) and build from the .fa file.")}
    try:
        command, result = _run_makeblastdb(resolved_fasta, prefix)
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "message": "makeblastdb timed out while building the primer BLAST DB.",
        }

    if result.returncode != 0:
        too_long = rejected_seq_ids(resolved_fasta)
        if too_long:
            names = ', '.join(too_long)
            return {
                "success": False,
                "message": (
                    f"makeblastdb refused sequence names in {os.path.basename(resolved_fasta)} longer than "
                    f"{MAKEBLASTDB_MAX_LOCAL_ID} characters: {names}. Rename those FASTA headers to short names "
                    "without spaces (for example >my_construct) and build again."),
                "command": command,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
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
    set_primer_paths(state, fasta=override, blast_db=prefix)
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

    match = next((sib for sib in siblings if sib != current and prefix_matches_hints(sib, hints)), None)
    pin = getattr(state, 'primer_blast_db_pin', None)
    if pin is not None and tuple(pin) == tuple(hints):
        # The user chose this database with this genome loaded (a background for plasmid primers, say): it
        # stays chosen. A design on this genome's own contigs uses the matching database for that run only.
        if wait and match:
            return match, None
        genome_label = hints[0]
        db_label = os.path.basename(current)
        return None, (
            f"BLAST database '{db_label}' (your choice) doesn't match current genome '{genome_label}'. "
            "Primers on loaded plasmid maps are checked against it. "
            + (f"Designs on {genome_label} contigs use '{os.path.basename(match)}' from the same folder."
               if match else f"For designs on {genome_label} contigs, pick a matching database.")
        )

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
    local = local_primer_fasta(state)
    from services.external_tools import blast_summary
    return {
        "blast_tool": blast_summary(),
        "fasta": fasta,
        "blast_db": getattr(state, 'primer_blast_db', None),
        "configured": fasta is not None,
        # The FASTA as a local file (a genome opened from the picker: its downloaded copy); None when design
        # has no FASTA file to read (Build is then not offered) and works on loaded plasmid maps only.
        "fasta_local": local,
        "plasmids": sorted(supplemental_names(state)),
        "current_genome": getattr(state, 'current_genome', None),
        "blast_db_warning": warning,
    }


def set_primer_paths(state, *, fasta=None, blast_db=None, wait: bool = True, pin: bool = False) -> bool:
    """Publish the primer FASTA / BLAST database (reference fields, routed to a view's context) under the
    workspace's state lock and the view's context lock (services/genome_loading.reference_write_lock).

    ``wait=False`` (the auto-switch made while reading the config, also from /api/status on the event loop): when
    the locks are busy (a genome loading) nothing is written and False is returned; the next read switches.
    ``pin``: the database is the user's choice (see resolve_blast_db_for_genome)."""
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
            # pin: the user chose it (POST /api/primer_config): it is not auto-switched while the genome it
            # was chosen with stays loaded (resolve_blast_db_for_genome). Any other setting (Build, a switch)
            # releases the pin.
            state.primer_blast_db_pin = tuple(genome_hints(state)) if pin else None
        return True
    finally:
        for lock in reversed(taken):
            lock.release()
