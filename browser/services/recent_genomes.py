"""Recent and pinned genomes: the reference/annotation pairs the user loaded, kept on this computer.

``~/.fiberhmm/recent_genomes.json`` (``FIBERBROWSER_RECENT_GENOMES`` points at another file), next to the analysis
preferences: it survives restarts and is shared by every port and browser (browser storage is per origin).

An entry is one reference:

``kind``
    ``fasta`` (a local FASTA, maybe with its annotation) or ``registry`` (an online genome; its download and cache
    count once, as does a catalog's genome).
``fasta`` / ``gtf``
    Real paths (``realpath``), or None. Entries are deduplicated by the FASTA's real path (``registry:<id>`` for a
    registry genome).
``genome_id`` / ``assembly``
    The registry genome, or the assembly its index's contig lengths name.
``last_used``, ``pinned``, ``pin_order``
    Recent entries are listed most recent first, at most ``recent_genomes_max`` of them (analysis preferences,
    default 8; the file keeps up to ``MAX_RECENT``). Pinned entries are listed first, in the order they were pinned,
    never count toward the cap and survive "Clear recent".

On a lab server, an entry belongs to the member who loaded it, and only paths inside the member's data roots are
recorded or listed (services/lab/paths.py). The routes are owner/local only (not on a public server).

Matching (``best_match``): each entry's index (``.fai``, never the sequence) is scored against the loaded datasets'
header contigs, by name and length; scores are cached by path and modification time. Pinned entries are tried first.
"""
from __future__ import annotations

import contextlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA = 'fiberbrowser.recent_genomes/1'
MAX_RECENT = 50
MAX_PINNED = 100
DEFAULT_SHOWN = 8
_lock = threading.Lock()


@contextlib.contextmanager
def _locked():
    """One read-modify-write at a time, across threads and (POSIX) across server processes: every port and the app
    share the file, so two pins made at once in two servers must both stay."""
    with _lock:
        try:
            import fcntl
        except ImportError:  # Windows: threads only
            yield
            return
        lock_path = store_path().with_suffix('.lock')
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, 'a') as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)


def store_path() -> Path:
    override = os.environ.get('FIBERBROWSER_RECENT_GENOMES')
    return Path(override).expanduser() if override else Path.home() / '.fiberhmm' / 'recent_genomes.json'


def _owner() -> Optional[str]:
    """The lab member of this request (entries are theirs), else None (the local user)."""
    try:
        from services.runtime import current_lab_user
        user = current_lab_user()
    except Exception:
        return None
    if user is None:
        return None
    return str(getattr(user, 'name', None) or getattr(user, 'username', None) or getattr(user, 'id', None) or user)


def _allowed(path: Optional[str]) -> bool:
    if not path:
        return True
    try:
        from services.lab.paths import allowed, enforcing
        return not enforcing() or allowed(path)
    except Exception:
        return True


def _real(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    text = str(path)
    if '://' in text:
        return None
    return os.path.realpath(os.path.expanduser(text))


def _read() -> list[dict]:
    try:
        raw = json.loads(store_path().read_text())
    except (OSError, ValueError):
        return []
    entries = raw.get('entries') if isinstance(raw, dict) else None
    return [e for e in entries if isinstance(e, dict) and isinstance(e.get('key'), str)] if isinstance(entries, list) else []


def _write(entries: list[dict]) -> None:
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.recent_genomes.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump({'schema': SCHEMA, 'entries': entries}, handle, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _bounded(entries: list[dict]) -> list[dict]:
    """Every owner's pinned entries, and at most MAX_RECENT unpinned ones per owner (most recent first)."""
    out, counts = [], {}
    for e in sorted(entries, key=lambda e: -float(e.get('last_used') or 0)):
        owner = e.get('owner')
        if e.get('pinned'):
            out.append(e)
            continue
        counts[owner] = counts.get(owner, 0) + 1
        if counts[owner] <= MAX_RECENT:
            out.append(e)
    return out


def _assembly_of_fai(fasta: str) -> Optional[str]:
    contigs = fai_contigs(fasta)
    if not contigs:
        return None
    try:
        from services.assembly_fingerprint import Contig, fingerprint
        fp = fingerprint([Contig(n, l) for n, l in contigs.items()], labels=[os.path.basename(fasta)])
        return fp.assembly if fp.kind == 'genome' else None
    except Exception:
        return None


def entry_for_state(state) -> Optional[dict]:
    """The entry the state's main reference is: a registry genome (its download, cache or catalog), or a local FASTA
    with the annotation loaded beside it. None: no reference, a remote FASTA, or a collection of pairs."""
    from services.genome_registry import GENOME_REGISTRY
    fasta_path = getattr(state, 'fasta_path', None)
    genome = getattr(state, 'current_genome', None)
    registry = getattr(state, 'registry_fasta', None)
    gtf_path = getattr(state, 'gtf_path', None) if getattr(state, 'gtf_data', None) is not None else None
    if getattr(state, 'reference_pairs', None):
        return None
    if genome in GENOME_REGISTRY and (registry == (genome, fasta_path) or (fasta_path and '://' in str(fasta_path))):
        return {'key': f'registry:{genome}', 'kind': 'registry', 'genome_id': genome, 'assembly': genome,
                'name': GENOME_REGISTRY[genome]['name'], 'fasta': None, 'gtf': None}
    real = _real(fasta_path)
    if not real or getattr(state, 'fasta', None) is None:
        return None
    gtf_real = _real(gtf_path)
    return {'key': real, 'kind': 'fasta', 'genome_id': genome if genome in GENOME_REGISTRY else None,
            'assembly': _assembly_of_fai(real), 'name': None, 'fasta': real, 'gtf': gtf_real}


def record(state) -> Optional[dict]:
    """Note the state's main reference as the most recent (after a load the user asked for). Never raises."""
    try:
        from services.runtime import current_sandbox_id, get_public_mode
        if get_public_mode() or current_sandbox_id() is not None:
            return None   # a visitor's or a tour tab's load is not the user's
        entry = entry_for_state(state)
        if entry is None or not _allowed(entry.get('fasta')) or not _allowed(entry.get('gtf')):
            return None
        owner = _owner()
        with _locked():
            entries = _read()
            old = next((e for e in entries if e['key'] == entry['key'] and e.get('owner') == owner), None)
            entries = [e for e in entries if not (e['key'] == entry['key'] and e.get('owner') == owner)]
            new = {**entry, 'owner': owner, 'last_used': time.time(),
                   'pinned': bool(old and old.get('pinned')), 'pin_order': (old or {}).get('pin_order')}
            if old and entry['kind'] == 'fasta' and not entry.get('gtf') and old.get('gtf') and old.get('fasta') == entry['fasta']:
                # Loaded again without its annotation (it follows in a moment): the pair is kept.
                new['gtf'] = old['gtf']
            entries.insert(0, new)
            _write(_bounded(entries))
            return new
    except Exception as exc:  # recording is a convenience: a load never fails for it
        print(f"  Recent genomes: not recorded ({exc})")
        return None


def _shown_max() -> int:
    try:
        from services.analysis_preferences import load_preferences
        value = load_preferences().get('recent_genomes_max')
        return int(value) if isinstance(value, int) and 1 <= value <= MAX_RECENT else DEFAULT_SHOWN
    except Exception:
        return DEFAULT_SHOWN


def _public(entry: dict) -> dict:
    fasta, gtf = entry.get('fasta'), entry.get('gtf')
    exists = True
    cached = None
    if entry.get('kind') == 'fasta':
        exists = bool(fasta) and os.path.isfile(fasta)
    else:
        cached = _registry_cached(entry.get('genome_id'))
    return {
        'key': entry['key'], 'kind': entry.get('kind'), 'genome_id': entry.get('genome_id'),
        'assembly': entry.get('assembly'), 'name': entry.get('name'),
        'fasta': fasta, 'fasta_name': os.path.basename(fasta) if fasta else None,
        'gtf': gtf, 'gtf_name': os.path.basename(gtf) if gtf else None,
        'gtf_exists': bool(gtf) and os.path.isfile(gtf),
        'exists': exists, 'cached': cached,
        'last_used': entry.get('last_used'), 'pinned': bool(entry.get('pinned')),
    }


def _registry_cached(genome_id) -> Optional[bool]:
    try:
        from services.genome_check import _genome_cached
        return _genome_cached(genome_id) if genome_id else None
    except Exception:
        return None


def _mine(entries: Iterable[dict]) -> list[dict]:
    owner = _owner()
    return [e for e in entries if e.get('owner') == owner and _allowed(e.get('fasta')) and _allowed(e.get('gtf'))]


def listing(limit: Optional[int] = None) -> dict:
    """``{"pinned": [...], "recent": [...], "max": N}``: pinned in pin order, then the N most recent others."""
    shown = limit if isinstance(limit, int) and limit > 0 else _shown_max()
    entries = _mine(_read())
    pinned = sorted((e for e in entries if e.get('pinned')), key=lambda e: (float(e.get('pin_order') or 0), e['key']))
    recent = sorted((e for e in entries if not e.get('pinned')), key=lambda e: -float(e.get('last_used') or 0))[:shown]
    return {'pinned': [_public(e) for e in pinned], 'recent': [_public(e) for e in recent], 'max': shown}


def find(key: str) -> Optional[dict]:
    return next((e for e in _mine(_read()) if e['key'] == key), None)


def _update(fn) -> dict:
    owner = _owner()
    with _locked():
        entries = _read()
        mine = [e for e in entries if e.get('owner') == owner]
        others = [e for e in entries if e.get('owner') != owner]
        mine = fn(mine)
        _write(_bounded(others + mine))
    return listing()


def remove(key: str) -> dict:
    return _update(lambda mine: [e for e in mine if e['key'] != key])


def clear_recent() -> dict:
    """Every unpinned entry goes; pinned ones stay."""
    return _update(lambda mine: [e for e in mine if e.get('pinned')])


def set_pinned(key: str, pinned: bool) -> dict:
    def change(mine):
        top = max([float(e.get('pin_order') or 0) for e in mine if e.get('pinned')] + [0.0])
        for e in mine:
            if e['key'] == key:
                if pinned and not e.get('pinned'):
                    e['pinned'], e['pin_order'] = True, top + 1
                elif not pinned:
                    # Back to Recent, as just used (so it is not cut by the cap at once).
                    e['pinned'], e['pin_order'], e['last_used'] = False, None, time.time()
        if sum(1 for e in mine if e.get('pinned')) > MAX_PINNED:
            raise ValueError(f'At most {MAX_PINNED} pinned genomes')
        return mine
    return _update(change)


def reorder_pinned(keys: list[str]) -> dict:
    """The pinned entries in this order (keys not pinned are ignored; pinned ones not named keep theirs, after)."""
    def change(mine):
        rank = {k: i for i, k in enumerate(keys)}
        pinned = sorted((e for e in mine if e.get('pinned')),
                        key=lambda e: (rank.get(e['key'], len(rank)), float(e.get('pin_order') or 0)))
        for i, e in enumerate(pinned):
            e['pin_order'] = float(i + 1)
        return mine
    return _update(change)


# ------------------------------------------------------------------------------------------------ matching the data

_FAI_CACHE: dict[str, tuple[float, dict[str, int]]] = {}


def fai_contigs(fasta: Optional[str]) -> dict[str, int]:
    """A FASTA's contigs and lengths from its index (``.fai``; the sequence is never read), cached by modification
    time. {} when there is no index."""
    if not fasta:
        return {}
    fai = f'{fasta}.fai'
    # On a lab server both the FASTA and its index must be inside the member's roots (an allowed FASTA can have a
    # .fai link to elsewhere), checked before a cached copy is served, and the index is opened by the confined
    # descriptor walk (lab/paths.open_read).
    if not _index_readable(fasta):
        return {}
    try:
        mtime = os.path.getmtime(fai)
    except OSError:
        return {}
    hit = _FAI_CACHE.get(fai)
    if hit and hit[0] == mtime:
        return hit[1]
    contigs: dict[str, int] = {}
    try:
        from services.lab.paths import open_read
        with open_read(fai, text=True) as fh:
            for line in fh:
                parts = line.split('\t')
                if len(parts) >= 2:
                    contigs[parts[0]] = int(parts[1])
    except Exception:  # OSError, ValueError, PathDenied
        return {}
    _FAI_CACHE[fai] = (mtime, contigs)
    return contigs


def _index_readable(fasta: str) -> bool:
    """This request may read the FASTA and its ``.fai`` (always off a lab server)."""
    try:
        from services.lab.paths import readable
        return readable(fasta) and readable(f'{fasta}.fai')
    except Exception:
        return False


def _alias_keys(name: str) -> set:
    lower = str(name or '').lower()
    stripped = lower[3:] if lower.startswith('chr') else lower
    keys = {lower, stripped, f'chr{stripped}'}
    if stripped in ('m', 'mt'):
        keys |= {'m', 'mt', 'chrm', 'chrmt'}
    return keys


def contig_fit(data: dict[str, int], reference: dict[str, int]) -> int:
    """How many of the data's contigs the reference has, by name (UCSC or Ensembl spelling) and the same length."""
    by_key: dict[str, int] = {}
    for name, length in reference.items():
        for k in _alias_keys(name):
            by_key.setdefault(k, length)
    matched = 0
    for name, length in data.items():
        if any(by_key.get(k) == length for k in _alias_keys(name)):
            matched += 1
    return matched


def _entry_fasta(entry: dict) -> Optional[str]:
    if entry.get('kind') == 'fasta':
        return entry.get('fasta')
    try:
        from services.genome_registry import GENOME_REGISTRY
        from state.browser_state import cached_fasta_path
        info = GENOME_REGISTRY[entry['genome_id']]
        urls = list(info.get('fasta_urls') or ([info['fasta_url']] if info.get('fasta_url') else []))
        local = cached_fasta_path(os.path.join(os.path.expanduser('~'), '.fiberhmm', 'genomes'), urls)
        return local if os.path.isfile(local) else None
    except Exception:
        return None


def best_match(data_contigs: dict[str, int], current: dict[str, int], *, exclude_key: Optional[str] = None) -> Optional[dict]:
    """The pinned or recent entry whose contigs fit the data clearly better than the loaded reference, or None.

    Clearly better: more of the data's contigs matched, at least half of them, and at least 10 points more of them
    than the loaded reference matches. Pinned entries are tried first and win ties. Missing files are skipped."""
    total = len(data_contigs)
    if not total:
        return None
    current_matched = contig_fit(data_contigs, current) if current else 0
    lists = listing(limit=MAX_RECENT)
    best = None
    for entry in lists['pinned'] + lists['recent']:
        if entry['key'] == exclude_key or not entry.get('exists'):
            continue
        fasta = _entry_fasta(entry)
        contigs = fai_contigs(fasta)
        if not contigs or (current and contigs == current):
            continue
        matched = contig_fit(data_contigs, contigs)
        if matched <= current_matched or matched * 2 < total or (matched - current_matched) * 10 < total:
            continue
        if best is None or matched > best['matched']:
            best = {**entry, 'matched': matched}
    if best is None:
        return None
    label = best.get('name') or best.get('genome_id') or best.get('assembly') or best.get('fasta_name') or best['key']
    fit = f'all {total:,} contigs match' if best['matched'] == total else f"{best['matched']:,} of {total:,} contigs match"
    return {'key': best['key'], 'label': label, 'pinned': best['pinned'], 'fasta_name': best.get('fasta_name'),
            'gtf_name': best.get('gtf_name'), 'matched': best['matched'], 'total': total,
            'current_matched': current_matched, 'fit': fit}
