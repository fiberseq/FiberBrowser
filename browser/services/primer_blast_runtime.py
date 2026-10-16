"""BLAST subprocess, abort, and cache runtime for primer design."""
from __future__ import annotations

import contextvars
import glob
import os
import shlex
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from typing import Dict, List, Optional

from services.primer_blast_scoring import apply_blast_filters, parse_blast_hits
from services.primer_config import log_primer_diagnostic


class PrimerDesignAborted(Exception):
    pass


# Each design run has its own abort token (the run's context carries it), so a
# run started after Abort can't clear the abort of the run still stopping.
# _abort_event is the token of code running outside any run.
_abort_event = threading.Event()
_job_abort: contextvars.ContextVar[Optional[threading.Event]] = contextvars.ContextVar("primer_job_abort", default=None)
# Tokens of runs still going; primer_design_run removes a run's when it ends.
_active_tokens: set[threading.Event] = set()
_process_lock = threading.Lock()
_processes: list[subprocess.Popen] = []
_cache_lock = threading.Lock()

# Keyed on (seq, db_path, db_signature). Stores raw hit rows so threshold
# tuning re-scores cached rows without re-running BLAST.
BLAST_HIT_CACHE: Dict[tuple, List[tuple]] = {}
BLAST_CACHE_LIMIT = 200_000


@contextmanager
def primer_design_run():
    """One design run: its own abort token for as long as the run lasts.

    Abort reaches the runs in progress only; a run that has ended leaves no
    token behind in its thread for later work to trip over.
    """
    token = threading.Event()
    with _process_lock:
        _active_tokens.add(token)
    handle = _job_abort.set(token)
    try:
        yield token
    finally:
        with _process_lock:
            _active_tokens.discard(token)
        _job_abort.reset(handle)


def reset_primer_blast_runtime() -> threading.Event:
    """Start a design run with its own, clear abort token.

    Another run's abort is left alone: a run aborted a moment ago keeps its
    token set until it stops. The process list is not cleared either: another
    run (another tab) may still have BLAST processes going, and Abort must
    still reach them. Finished processes remove themselves.
    """
    token = threading.Event()
    with _process_lock:
        _active_tokens.add(token)
    _job_abort.set(token)
    return token


def _current_abort() -> threading.Event:
    return _job_abort.get() or _abort_event


def run_in_design_context(executor, fn, *args, **kwargs):
    """``executor.submit`` carrying this run's abort token into the worker thread."""
    ctx = contextvars.copy_context()
    return executor.submit(ctx.run, fn, *args, **kwargs)


def request_primer_design_abort() -> None:
    """Abort every design run in progress and kill their BLAST subprocesses."""
    with _process_lock:
        for token in list(_active_tokens):
            token.set()
        procs = list(_processes)
        _processes.clear()
    for proc in procs:
        if proc.poll() is not None:
            continue
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        except Exception:
            log_primer_diagnostic("Failed to terminate BLAST subprocess during abort")


def check_abort() -> None:
    """Raise if this run was aborted."""
    if _current_abort().is_set():
        raise PrimerDesignAborted()


def blast_thread_count() -> int:
    """Threads to hand to blastn's `-num_threads`."""
    from services.background_work import auxiliary_worker_count
    return auxiliary_worker_count(8)


def blast_db_mtime(db_path: str) -> float:
    """BLAST DB version stamp."""
    for suffix in ('.nhr', '.nsq', ''):
        try:
            return os.path.getmtime(db_path + suffix)
        except OSError:
            continue
    return 0.0


_DB_FILE_SUFFIXES = ('.nal', '.ndb', '.nhr', '.nin', '.nsq', '.not', '.nto', '')


def _alias_volumes(alias_path: str) -> List[str]:
    """Volume prefixes an alias (.nal) file lists on its DBLIST line."""
    volumes: List[str] = []
    try:
        with open(alias_path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                if line.strip().upper().startswith('DBLIST'):
                    for name in shlex.split(line.strip()[len('DBLIST'):]):
                        vol = name if os.path.isabs(name) else os.path.join(os.path.dirname(alias_path), name)
                        volumes.append(vol)
    except (OSError, ValueError):
        pass
    return volumes


def blast_db_signature(db_path: str) -> Optional[tuple]:
    """BLAST DB cache stamp: mtime_ns and size of every file the database reads
    (plain files, numbered volumes, an alias and the volumes it lists), so an
    updated database never reuses stale hits. None when no file is found:
    the caller then skips the cache."""
    paths = set()
    prefixes = [db_path]
    alias = db_path + '.nal'
    if os.path.isfile(alias):
        prefixes.extend(_alias_volumes(alias))
    for prefix in prefixes:
        for suffix in _DB_FILE_SUFFIXES:
            if os.path.isfile(prefix + suffix):
                paths.add(prefix + suffix)
        # Numbered volumes: prefix.00.nsq, prefix.01.nin, ...
        paths.update(p for p in glob.glob(glob.escape(prefix) + '.[0-9]*.n??') if os.path.isfile(p))
    signature = []
    for path in sorted(paths):
        try:
            st = os.stat(path)
        except OSError:
            continue
        signature.append((path, int(st.st_mtime_ns), int(st.st_size)))
    return tuple(signature) or None


def cache_trim() -> None:
    """Cheap FIFO trim based on dict insertion order."""
    with _cache_lock:
        if len(BLAST_HIT_CACHE) <= BLAST_CACHE_LIMIT:
            return
        drop_n = max(1, len(BLAST_HIT_CACHE) - int(BLAST_CACHE_LIMIT * 0.8))
        to_drop = list(BLAST_HIT_CACHE.keys())[:drop_n]
        for key in to_drop:
            BLAST_HIT_CACHE.pop(key, None)


def cache_blast_hits(db_path: str, hit_rows_by_seq: dict) -> None:
    """Promote parsed BLAST hit rows into the shared cache."""
    db_signature = blast_db_signature(db_path)
    if db_signature is None:
        return
    with _cache_lock:
        for seq, rows in hit_rows_by_seq.items():
            BLAST_HIT_CACHE[(seq, db_path, db_signature)] = rows
    cache_trim()


def run_blast(query_file, db_path, output_file):
    """Run BLAST as an abort-aware subprocess. Returns (returncode, stderr_text)."""
    check_abort()
    from services.external_tools import tool_path
    proc = subprocess.Popen(
        [tool_path('blastn') or 'blastn', '-query', query_file, '-db', db_path, '-word_size', '7',
         '-task', 'blastn-short',
         '-num_threads', str(blast_thread_count()),
         '-outfmt', '6 qseqid pident length qstart qend sseqid sstart send',
         '-out', output_file, '-evalue', '1'],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )
    with _process_lock:
        _processes.append(proc)
        should_kill = _current_abort().is_set()
    if should_kill:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    try:
        _, stderr = proc.communicate()
        rc = proc.returncode
    finally:
        with _process_lock:
            try:
                _processes.remove(proc)
            except ValueError:
                pass
    check_abort()
    stderr_text = stderr.decode('utf-8', errors='replace').strip() if stderr else ''
    if stderr_text:
        log_primer_diagnostic(f"BLAST stderr: {stderr_text}")
    return rc, stderr_text


def blast_and_score_cached(seqs_to_check: List[str], db_path: str,
                           check_three_prime: bool = True,
                           off_target_min_pident: float = 90.0,
                           off_target_length_frac: float = 0.85) -> tuple:
    """Resolve per-seq BLAST hit counts using the content-addressed cache."""
    check_abort()
    db_signature = blast_db_signature(db_path)
    dedup = list(dict.fromkeys(seqs_to_check))

    cached_hits: Dict[str, List[tuple]] = {}
    uncached: List[str] = []
    with _cache_lock:
        for seq in dedup:
            hits = None if db_signature is None else BLAST_HIT_CACHE.get((seq, db_path, db_signature))
            if hits is not None:
                cached_hits[seq] = hits
            else:
                uncached.append(seq)

    new_hits: Dict[str, List[tuple]] = {}
    stderr_text = ''
    if uncached:
        with tempfile.NamedTemporaryFile(delete=False, mode='w', suffix='.fa') as tf:
            seq_to_id = {}
            for i, seq in enumerate(uncached):
                qid = f'p{i}'
                tf.write(f'>{qid}\n{seq}\n')
                seq_to_id[qid] = seq
            fasta_file = tf.name
        with tempfile.NamedTemporaryFile(delete=False, suffix='.txt') as to:
            output_file = to.name
        try:
            rc, stderr_text = run_blast(fasta_file, db_path, output_file)
            if rc != 0:
                return set(), {}, len(cached_hits), 0, stderr_text
            _passing, _counts, parsed_hits = parse_blast_hits(
                output_file, seq_to_id,
                off_target_min_pident=off_target_min_pident,
                off_target_length_frac=off_target_length_frac,
                check_three_prime=check_three_prime,
            )
            new_hits = parsed_hits
            cache_blast_hits(db_path, new_hits)
        finally:
            try:
                os.unlink(fasta_file)
            except Exception:
                pass
            try:
                os.unlink(output_file)
            except Exception:
                pass

    all_hits = {**cached_hits, **new_hits}
    counts = {
        seq: apply_blast_filters(
            seq, all_hits.get(seq, []),
            off_target_min_pident=off_target_min_pident,
            off_target_length_frac=off_target_length_frac,
            check_three_prime=check_three_prime,
        )
        for seq in dedup
    }
    passing = {
        seq for seq, counts_for_seq in counts.items()
        if (
            counts_for_seq['on_target'] == 1
            and counts_for_seq['off_target'] == 0
            and counts_for_seq['three_prime_threats'] == 0
        )
    }
    return passing, counts, len(cached_hits), len(uncached), stderr_text
