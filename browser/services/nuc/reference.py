"""The random-packing regularity reference of a dataset in the browser (what patch thresholds and the nucreg lane's
colour scale are read against).

One reference per dataset (all its files pooled), computed the way ``fiberhmm-scan`` computes ``nucreg_reference``
in its calibration (``fiberhmm.scan.modules.nuc.nucreg_reference``): the dataset's calibration population (the
hash-ranked primary records of the calibration regions the dataset's active calibration record names, passing the
calibration's read filters, ``calibration_population`` molecules) and ``reference_scores`` with the scan's window
count and seed. It never depends on what was viewed, so every locus is read against the same reference, a restart
gives the same one, and a scan with the same settings computes the same numbers.

- Keyed by what it was computed from (the files, the calibration record and its regions, read filters, the
  regularity parameters, population, windows and seed), kept in memory and next to the stored calibrations.
- Single flight: concurrent requests for one key wait for one computation.
- Off the read path: a read load never computes it (``cached_for_path``; ``request_background`` starts it in the
  background when the dataset is known, and the lane uses its fallback scale until then). A computation that failed
  is not started again for ``FAILURE_BACKOFF`` seconds (``_FAILED``); a request still computes it and reports why.
- Which reference a file's lanes read (``_PATH_KEY``) is registered when a request asks for it, in request order; a
  computation finishing late (a superseded configuration) caches its reference but never re-points the lanes.
- Memory: decoded populations are kept up to ``POPULATION_BYTES`` (the most recently used first, never fewer than
  ``POPULATION_MIN``); the bookkeeping maps are bounded (``MAX_SPECS``).
- Accepted only with at least ``MIN_REFERENCE_SCORES`` finite scores and a finite median (``usable``).
- ``source`` says where it came from (shown in the panel); ``scan_references`` lists bound scans' recorded
  references with the same regularity parameters, which the panel can adopt instead.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import weakref
from collections import OrderedDict
from concurrent.futures import Future
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .inputs import real

#: fiberhmm-scan's nucpatch reference defaults (reference_windows, reference_seed)
REFERENCE_WINDOWS, REFERENCE_SEED = 3000, 1
#: molecules of the population whose tiles give the lane's observed score quantiles (the first ones, deterministic)
OBSERVED_MOLECULES = 400
SCHEMA = 'fiberbrowser.nuc.regularity_reference.v2'
#: references with per-width classes (ends 'truncated') also record the classes' sampled widths (width_centres): a
#: stored v2 one lacks them, so their keys moved; full-window references are unchanged and keep their keys
SCHEMA_PER_WIDTH = 'fiberbrowser.nuc.regularity_reference.v3'


def _schema(params) -> str:
    return SCHEMA_PER_WIDTH if getattr(params, 'ends', None) == 'truncated' else SCHEMA

_LOCK = threading.RLock()
_REFS: Dict[str, dict] = {}                          # key -> reference
_PATH_KEY: "OrderedDict[Tuple[str, str], str]" = OrderedDict()   # (real path, params8) -> its dataset's reference key
_SPEC: "OrderedDict[str, tuple]" = OrderedDict()    # key -> (paths, cfg, params) to compute it
_INFLIGHT: Dict[str, Future] = {}
#: key -> (time.monotonic() of the failure, message): a failed computation, not started again in the background for
#: ``FAILURE_BACKOFF`` seconds (every read load would otherwise start it again)
_FAILED: Dict[str, Tuple[float, str]] = {}
FAILURE_BACKOFF = 120.0
#: the most registrations and computation specs kept (the oldest go first; a spec in use is registered again by its
#: next request)
MAX_SPECS = 256
#: The decoded calibration population of a dataset does not depend on the regularity parameters: it is kept in
#: memory so a reference for new parameters only scores it again (the decode is ~95% of a reference's cost). Kept by
#: bytes (``POPULATION_BYTES``; ~120 MB per PacBio dataset), most recently used first, and never fewer than
#: ``POPULATION_MIN`` populations, so a comparison of many datasets keeps all of theirs. Single flight per key.
POPULATION_BYTES = 3 * 1024 ** 3
POPULATION_MIN = 2
#: (kept for callers: the population count is now bounded by bytes)
POPULATION_CACHE = POPULATION_MIN
_POPS: "OrderedDict[str, list]" = OrderedDict()
_POP_SIZE: Dict[str, int] = {}                       # population key -> its molecules' array bytes
_POP_FILES: Dict[str, frozenset] = {}                # population key -> the real paths it was decoded from
_POP_INFLIGHT: Dict[str, Future] = {}
#: (population key, base params8, n) -> the first molecules' full-window tracks (``_observed_tracks``); dropped with
#: their population
_POP_BASES: "OrderedDict[tuple, list]" = OrderedDict()
MAX_POP_BASES = 64


def _defaults():
    try:
        from fiberhmm.nuc.regularity import CUT_WINDOWS_PER_CLASS, MIN_CUT_SCORES, MIN_REFERENCE_SCORES
    except ImportError:          # an older FiberHMM: full windows only
        CUT_WINDOWS_PER_CLASS, MIN_CUT_SCORES, MIN_REFERENCE_SCORES = 500, 100, 100
    return CUT_WINDOWS_PER_CLASS, MIN_CUT_SCORES, MIN_REFERENCE_SCORES


def _regions(cfg, paths) -> Optional[List[Tuple[str, int, int]]]:
    """The calibration regions of the dataset's active calibration record (its first file's), or None."""
    cal = cfg.calibrations.get(paths[0]) or cfg.calibrations.get(real(paths[0])) or cfg.calibration
    raw = ((cal.wrapper.get('regions') or {}).get(cal.label)) if cal is not None else None
    if not raw:
        return None
    out = []
    for r in raw:
        c, _sep, span = str(r).rpartition(':')
        a, _d, b = span.partition('-')
        out.append((c, int(a), int(b)))
    return out


def _data_regions(cfg, paths) -> List[Tuple[str, int, int]]:
    """The scan's 'data'-scope calibration regions (a calibration record without regions)."""
    from fiberhmm.scan.modules.nuc import _RecordProbe, data_calibration_regions
    from fiberhmm.scan.reads import passes
    from .inputs import reference_of
    filters = (cfg.policy or {}).get('filters') or {}
    with _RecordProbe(list(paths), lambda r: passes(r, filters)) as probe:
        return data_calibration_regions(reference_of(list(paths)), list(paths),
                                        int(cfg.settings.get('calibration_units', 40)), has_records=probe)


def key_of(paths: Sequence[str], cfg, params) -> str:
    cut, min_cut, _m = _defaults()
    cal = cfg.calibrations.get(paths[0]) or cfg.calibrations.get(real(paths[0])) or cfg.calibration
    raw = json.dumps(dict(schema=_schema(params), files=[real(p) for p in paths],
                          content=[_identity(p) for p in paths], settings=cfg.settings_hash,
                          calibration=cal.digest if cal is not None else None,
                          regions=((cal.wrapper.get('regions') or {}).get(cal.label)) if cal is not None else None,
                          filters=(cfg.policy or {}).get('filters') or {}, params=params.digest()[:8],
                          population=int(cfg.settings.get('calibration_population', 2000)),
                          windows=REFERENCE_WINDOWS, seed=REFERENCE_SEED, cut=cut, min_cut=min_cut,
                          **_other_calibrations(paths, cfg)),
                     sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def population_key(paths: Sequence[str], cfg) -> str:
    """What a dataset's calibration population is decoded from (``key_of`` without the regularity parameters)."""
    cal = cfg.calibrations.get(paths[0]) or cfg.calibrations.get(real(paths[0])) or cfg.calibration
    raw = json.dumps(dict(schema=SCHEMA, files=[real(p) for p in paths], content=[_identity(p) for p in paths],
                          settings=cfg.settings_hash, calibration=cal.digest if cal is not None else None,
                          regions=((cal.wrapper.get('regions') or {}).get(cal.label)) if cal is not None else None,
                          filters=(cfg.policy or {}).get('filters') or {},
                          population=int(cfg.settings.get('calibration_population', 2000)),
                          **_other_calibrations(paths, cfg)),
                     sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _other_calibrations(paths: Sequence[str], cfg) -> dict:
    """A multi-file dataset's other files' calibration records (each file of a bound scan's datasets keeps its own):
    a key part, so a new record for any file computes the reference again. {} for one file (its key is unchanged)."""
    if len(paths) < 2:
        return {}
    out = []
    for p in paths[1:]:
        cal = cfg.calibrations.get(p) or cfg.calibrations.get(real(p)) or cfg.calibration
        out.append(cal.digest if cal is not None else None)
    return dict(calibrations=out)


def _population(paths: Sequence[str], cfg, regions, population: int, read_filter):
    """The dataset's decoded calibration population (``fiberhmm.nuc.thinning.load_population``, as
    ``nucreg_reference`` loads it), decoded once per ``population_key`` and kept (``POPULATION_CACHE``)."""
    from fiberhmm.nuc.thinning import load_population
    from .engine import nuc_params
    key = population_key(paths, cfg)
    with _LOCK:
        hit = _POPS.get(key)
        if hit is not None:
            _POPS.move_to_end(key)
            return hit
        fut = _POP_INFLIGHT.get(key)
        mine = fut is None
        if mine:
            fut = _POP_INFLIGHT[key] = Future()
    if not mine:
        return fut.result()
    try:
        mols = load_population(list(paths), nuc_params(cfg.settings), population, regions, read_filter=read_filter,
                               fiber_reads=False)[0]
        with _LOCK:
            _POPS[key] = mols
            _POP_SIZE[key] = _population_bytes(mols)
            _POP_FILES[key] = frozenset(real(p) for p in paths)
            _trim_populations()
        fut.set_result(mols)
        return mols
    except BaseException as error:      # noqa: BLE001 - waiters see the same failure
        fut.set_exception(error)
        raise
    finally:
        with _LOCK:
            _POP_INFLIGHT.pop(key, None)


def _population_bytes(mols) -> int:
    """The bytes a decoded population's molecules hold in arrays (their per-base calls dominate)."""
    n = 0
    for m in mols:
        for v in (vars(m).values() if hasattr(m, '__dict__') else ()):
            if isinstance(v, np.ndarray):
                n += int(v.nbytes)
    return n


def _trim_populations() -> None:
    """Drop the least recently used populations beyond ``POPULATION_BYTES`` (keeping ``POPULATION_MIN``), with
    their observed tracks. Under ``_LOCK``."""
    while len(_POPS) > max(1, POPULATION_MIN) and sum(_POP_SIZE.get(k, 0) for k in _POPS) > POPULATION_BYTES:
        k, _m = _POPS.popitem(last=False)
        _drop_population(k)


def _drop_population(k: str) -> None:
    """Forget a population's bookkeeping and observed tracks (its molecules already left ``_POPS``). Under ``_LOCK``."""
    _POP_SIZE.pop(k, None)
    _POP_FILES.pop(k, None)
    for b in [b for b in _POP_BASES if b[0] == k]:
        _POP_BASES.pop(b, None)


def _identity(path: str):
    try:
        st = os.stat(real(path))
        return [st.st_size, st.st_mtime_ns]
    except OSError:
        return None


def _file(key: str):
    from .calibration import cache_dir
    return cache_dir().parent / 'nuc_regularity_reference' / f'{key}.json'


def _load(key: str) -> Optional[dict]:
    try:
        f = _file(key)
        if not f.is_file():
            return None
        ref = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(ref, dict) or ref.get('key') != key:
        return None
    return ref


def _save(key: str, ref: dict) -> None:
    try:
        f = _file(key)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(f'.{os.getpid()}.{threading.get_ident()}.tmp')
        tmp.write_text(json.dumps(ref, sort_keys=True))
        os.replace(tmp, f)
    except OSError:      # a read-only cache: computed again next run
        pass


def _num(v, digits: int = 4):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, digits) if np.isfinite(f) else None


def compute(paths: Sequence[str], cfg, params, key: str) -> dict:
    """The dataset's reference (module docstring)."""
    from fiberhmm.nuc.regularity import REFERENCE_QUANTILES
    from fiberhmm.scan.reads import passes
    from .engine import nuc_params
    from .regularity import SCORE_EDGES
    cut, min_cut, min_scores = _defaults()
    filters = (cfg.policy or {}).get('filters') or {}
    regions = _regions(cfg, paths)
    scope = 'calibration record'
    if regions is None:
        regions, scope = _data_regions(cfg, paths), 'data windows'
    population = int(cfg.settings.get('calibration_population', 2000))
    kw = dict(n_population=population, n_windows=REFERENCE_WINDOWS, seed=REFERENCE_SEED,
              read_filter=lambda r: passes(r, filters))
    # fiberhmm-scan's nucreg_reference: load_population, then reference_scores with the scan's windows and seed. The
    # population is decoded once per dataset (``_population``), so new parameters only score it again.
    from fiberhmm.nuc.regularity import reference_scores
    mols = _population(list(paths), cfg, regions, population, kw['read_filter'])
    try:
        ref = reference_scores(mols, params, n_windows=REFERENCE_WINDOWS, seed=REFERENCE_SEED, cut_windows=cut,
                               min_cut_scores=min_cut) if mols else None
    except TypeError:        # an older FiberHMM: full windows only
        ref = reference_scores(mols, params, n_windows=REFERENCE_WINDOWS, seed=REFERENCE_SEED) if mols else None
    d8 = params.digest()[:8]
    cal = cfg.calibrations.get(paths[0]) or cfg.calibrations.get(real(paths[0])) or cfg.calibration
    source = dict(kind='calibration', label='calibration population', regions=len(regions), scope=scope,
                  population=population, windows=REFERENCE_WINDOWS, seed=REFERENCE_SEED,
                  calibration=getattr(cal, 'source', None), scanId=getattr(cal, 'scan_id', None), files=len(paths))
    observed = []
    for track in _observed_tracks(paths, cfg, mols[:OBSERVED_MOLECULES], params):
        s = track.score
        observed.append(s[np.isfinite(s)])
    for m in mols:
        # the kept population's cumulative counts (8 bytes per base each) are rebuilt on demand
        m._cum_hit = m._cum_inf = None
    obs = np.concatenate(observed) if observed else np.zeros(0)
    ok = ref is not None and ref.usable(min_scores)
    d = ref.to_dict() if ref is not None else {}
    counts = np.histogram(ref.scores, bins=SCORE_EDGES)[0].tolist() if ref is not None and ref.n else \
        [0] * (len(SCORE_EDGES) - 1)
    out = dict(
        key=key, median=_num(ref.median) if ok else None,
        quantiles={str(q): _num(ref.quantiles.get(q)) for q in REFERENCE_QUANTILES} if ref is not None else {},
        n_windows=int(ref.n) if ref is not None else 0, seed=REFERENCE_SEED, params_digest=d8,
        n_molecules=len(mols), population=population, usable=bool(ok),
        reason=None if ok else f'fewer than {min_scores} random-packing windows could be scored',
        observed_p95=_num(float(np.quantile(obs, 0.95))) if len(obs) else None,
        observed_median=_num(float(np.median(obs))) if len(obs) else None,
        hist=dict(edges=SCORE_EDGES, counts=counts), source=source)
    for k in ('width_deltas', 'width_n', 'width_step', 'window_bp', 'width_centres'):
        if k in d:
            out[k] = d[k]
    return out


def _observed_tracks(paths, cfg, mols, params) -> list:
    """The regularity tracks of the population's first molecules (the lane's observed quantiles), through their
    full-window tracks (FiberHMM ``track_from_base``, identical): a read-end mode change computes no full window
    again."""
    from .regularity import _tracks
    try:
        from fiberhmm.nuc.regularity import base_params, track_from_base
    except ImportError:          # an older FiberHMM
        return [t for _k, t in _tracks(list(enumerate(mols)), params)]
    bp = base_params(params)
    bkey = (population_key(paths, cfg), bp.digest()[:8], len(mols))
    with _LOCK:
        bases = _POP_BASES.get(bkey)
    if bases is None:
        bases = [t for _k, t in _tracks(list(enumerate(mols)), bp)]
        with _LOCK:
            _POP_BASES[bkey] = bases
            while len(_POP_BASES) > MAX_POP_BASES:
                _POP_BASES.popitem(last=False)
    return [track_from_base(m, b, params) for m, b in zip(mols, bases)]


def _publish(key: str, paths: Sequence[str], params, ref: dict) -> None:
    """Cache a computed reference under its key. Never re-points a file's lanes (``_register``): a computation
    finishing after a newer request registered another reference (a superseded configuration) only caches its own."""
    with _LOCK:
        _REFS[key] = ref
        while len(_REFS) > 64:
            _REFS.pop(next(iter(_REFS)))


def _register(key: str, paths: Sequence[str], cfg, params) -> None:
    """Make ``key`` the reference the dataset's files' lanes read for ``params`` (a request asking for it, in
    request order), and remember how to compute it. Bounded (``MAX_SPECS``)."""
    d8 = params.digest()[:8]
    with _LOCK:
        _SPEC[key] = (tuple(paths), cfg, params)
        _SPEC.move_to_end(key)
        for p in paths:
            _PATH_KEY[(real(p), d8)] = key
            _PATH_KEY.move_to_end((real(p), d8))
        while len(_PATH_KEY) > MAX_SPECS:
            _PATH_KEY.popitem(last=False)
        live = set(_PATH_KEY.values()) | set(_INFLIGHT)
        while len(_SPEC) > MAX_SPECS:
            old = next((k for k in _SPEC if k not in live), None)
            if old is None:
                break
            _SPEC.pop(old)


def dataset_reference(paths: Sequence[str], cfg, params, *, compute_now: bool = True) -> Optional[dict]:
    """The dataset's reference for ``params`` (module docstring): cached, stored, or (``compute_now``) computed on
    this thread, joining a computation already running for the same key. Registers the dataset's files for the
    read layer."""
    paths = list(paths)
    if cfg is None or not paths:
        return None
    key = key_of(paths, cfg, params)
    _register(key, paths, cfg, params)
    return _lookup(key, paths, cfg, params, compute_now=compute_now)


def _lookup(key: str, paths, cfg, params, *, compute_now: bool) -> Optional[dict]:
    """The reference of ``key``: cached, stored, or (``compute_now``) computed here; never registers it."""
    with _LOCK:
        hit = _REFS.get(key)
    if hit is not None:
        return hit
    hit = _load(key)
    if hit is not None:
        _publish(key, paths, params, hit)
        _bump(key, paths)
        return hit
    if not compute_now:
        return None
    return _join(key, paths, cfg, params)


def _join(key: str, paths, cfg, params) -> Optional[dict]:
    with _LOCK:
        fut = _INFLIGHT.get(key)
        mine = fut is None
        if mine:
            fut = _INFLIGHT[key] = Future()
    if not mine:
        return fut.result()
    try:
        ref = compute(paths, cfg, params, key)
        _publish(key, paths, params, ref)
        if ref.get('usable'):
            _save(key, ref)
        _bump(key, paths)
        with _LOCK:
            _FAILED.pop(key, None)
        fut.set_result(ref)
        return ref
    except BaseException as error:      # noqa: BLE001 - waiters see the same failure
        import time
        with _LOCK:
            _FAILED[key] = (time.monotonic(), str(error))
            while len(_FAILED) > MAX_SPECS:
                _FAILED.pop(next(iter(_FAILED)))
        fut.set_exception(error)
        raise
    finally:
        with _LOCK:
            _INFLIGHT.pop(key, None)


#: browser states with nucleosome outputs (weak): a reference that becomes the lanes' one drops their cached rows
_WATCHED: "weakref.WeakValueDictionary[int, object]" = weakref.WeakValueDictionary()


def watch(state) -> None:
    """Remember a browser state (an Analyse made a configuration active in it): references finishing later refresh
    its read caches (``_bump``) and a read load can start a dataset's reference before its panel asked
    (``request_background``)."""
    try:
        _WATCHED[id(state)] = state
    except TypeError:          # a state without weak references (tests): nothing to refresh
        pass


def _bump(key: str, paths) -> None:
    """A reference newly cached under ``key``: where it is the one a file's lanes read (``_PATH_KEY``), rows built
    before it (the fallback scale, no patches) are dropped from the read caches of the datasets reading those files
    (``jobs.refresh_after``; their regularity identity moves with ``regularity.revision``), so the next load carries
    the reference's scale and patches. A reference computed in the background (``request_background``, a read load)
    has no request to refresh after it."""
    with _LOCK:
        lanes = sorted({rp for (rp, _d8), k in _PATH_KEY.items() if k == key and rp in {real(p) for p in paths}})
    if not lanes:
        return
    from .jobs import REGULARITY_LAYERS, refresh_after
    for state in list(_WATCHED.values()):
        try:
            refresh_after(state, lanes, REGULARITY_LAYERS)
        except Exception:      # noqa: BLE001 - a state being torn down
            pass


def cached_for_path(path: str, d8: str) -> Optional[dict]:
    """The reference of the dataset that last registered this file for these parameters, if computed (never
    computes; a read load's lookup)."""
    with _LOCK:
        key = _PATH_KEY.get((real(path), d8))
        hit = _REFS.get(key) if key is not None else None
    if hit is None and key is not None:
        hit = _load(key)
        if hit is not None:
            with _LOCK:
                _REFS[key] = hit
    return hit


#: start a dataset's reference for its current regularity parameters when an Analyse makes its configuration active
#: (the population decode then runs beside the job's molecules, not after it). Off by default: on a live test
#: the panel's regularity rows came ~9 s sooner, but the decode competed with the job's own work in the server
#: process and the Analyse took ~6 s longer.
PREFETCH_ON_ANALYSE = False


def start_background(paths: Sequence[str], cfg, params) -> None:
    """Compute the dataset's reference in the background (single flight: a request asking meanwhile joins it)."""
    if not PREFETCH_ON_ANALYSE or cfg is None or not paths:
        return

    def run():
        try:
            dataset_reference(list(paths), cfg, params)        # an Analyse making the configuration active
        except Exception:      # noqa: BLE001 - the panel's request computes it and reports the error
            pass
    threading.Thread(target=run, name='nuc-reference-prefetch', daemon=True).start()


def failed_recently(key: str) -> Optional[str]:
    """The message of the key's computation that failed within ``FAILURE_BACKOFF`` seconds, else None."""
    import time
    with _LOCK:
        got = _FAILED.get(key)
    if got is None or time.monotonic() - got[0] > FAILURE_BACKOFF:
        return None
    return got[1]


def request_background(path: str, d8: str) -> bool:
    """Start computing the reference of the dataset registered for this file in the background (single flight);
    True when one is (or was already) running. A read load calls this instead of computing."""
    with _LOCK:
        key = _PATH_KEY.get((real(path), d8))
        spec = _SPEC.get(key) if key is not None else None
    if spec is None and key is None:
        # no panel asked for this file's reference yet (the lane shown after an Analyse, before the panel's
        # Regularity view): the dataset that reads it, with its active configuration and the lane's parameters
        got = _spec_from_states(path, d8)
        if got is not None:
            _register(*got)
            key = got[0]
            with _LOCK:
                spec = _SPEC.get(key)
    with _LOCK:
        if spec is None or key in _REFS:
            return False
        if key in _INFLIGHT:
            return True
    if failed_recently(key) is not None:
        return False               # failed a moment ago: not again on every read load (the panel reports why)
    paths, cfg, params = spec

    def run():
        try:
            _lookup(key, paths, cfg, params, compute_now=True)     # never re-points the lanes
        except Exception:      # noqa: BLE001 - the panel's next request computes it and reports the error
            pass
    threading.Thread(target=run, name='nuc-reference', daemon=True).start()
    return True


def _spec_from_states(path: str, d8: str):
    """(key, paths, cfg, params) of the reference the lanes of ``path`` read for regularity parameters ``d8``: the
    first watched dataset reading the file with an active configuration, its files pooled, as a panel's request
    registers it (``dataset_reference``); None when none (or the lane's parameters are not ``d8``)."""
    from . import regularity as R
    params = R.path_params(path)
    if R.digest8(params) != d8:
        return None
    from .inputs import datasets_using, nuc_source
    from .jobs import active_config
    for state in list(_WATCHED.values()):
        try:
            for ds_id in datasets_using(state, path):
                cfg = active_config(state, ds_id)
                if cfg is None:
                    continue
                paths = list(nuc_source(state, ds_id).paths)
                return key_of(paths, cfg, params), paths, cfg, params
        except Exception:      # noqa: BLE001 - a dataset that can't be read: none
            continue
    return None


def clear() -> None:
    with _LOCK:
        _POPS.clear()
        _POP_SIZE.clear()
        _POP_FILES.clear()
        _POP_BASES.clear()
        _REFS.clear()
        _PATH_KEY.clear()
        _SPEC.clear()
        _FAILED.clear()


def forget_paths(paths: Sequence[str]) -> None:
    """Drop the registrations and decoded populations of files no dataset reads any more (a removed dataset)."""
    want = {real(p) for p in paths}
    with _LOCK:
        for k in [k for k in _PATH_KEY if k[0] in want]:
            _PATH_KEY.pop(k, None)
        live = set(_PATH_KEY.values()) | set(_INFLIGHT)
        for k in [k for k, spec in _SPEC.items() if k not in live and {real(p) for p in spec[0]} & want]:
            _SPEC.pop(k, None)
        # their decoded populations (~120 MB each): no reference of a removed dataset is computed again
        for k in [k for k, files in _POP_FILES.items() if files & want]:
            _POPS.pop(k, None)
            _drop_population(k)


# ------------------------------------------------------------------ scans' references
def scan_references(state, source, d8: str) -> List[dict]:
    """References recorded by bound scans (``nucreg_reference`` in their nuc calibration record) for this dataset's
    files, made with the same regularity parameters: what the panel can adopt (``scan:<scanId>``)."""
    out = []
    try:
        from services.scan.registry import _inside, list_scans
    except ImportError:
        return out
    try:
        scans = list_scans(state)
    except Exception:      # noqa: BLE001 - no scan registry in this state
        return out
    for scan in scans:
        try:
            block = scan.module('nuc')
            if not block:
                continue
            sid_of = {}
            for sid, bid, _via, by_index in scan.bound_pairs():
                if bid == source.browser_id:
                    for _i, p in by_index.items():
                        sid_of[real(p)] = sid
            sids = {sid_of.get(real(p)) for p in source.paths}
            if len(sids) != 1 or None in sids:
                continue
            sid = sids.pop()
            rel = (block.get('calibration') or {}).get('path') if isinstance(block.get('calibration'), dict) else None
            f = _inside(scan.path, rel or 'nuc/extra/calibration.json')
            if f is None or not f.is_file():
                continue
            ref = (json.loads(f.read_text()).get('nucreg_reference') or {}).get(sid)
        except Exception:      # noqa: BLE001 - an unreadable scan offers nothing
            continue
        if not isinstance(ref, dict) or ref.get('params_digest') != d8 or ref.get('median') is None:
            continue
        out.append(dict(scanId=scan.scan_id, label=getattr(scan, 'label', None) or scan.scan_id, dataset=sid,
                        median=_num(ref['median']), reference=ref))
    return out


def resolve_override(state, source, raw, d8: str, computed: Optional[dict]) -> Optional[dict]:
    """A panel's reference choice for a dataset: None (the computed reference), a number (a median override; the
    computed reference's per-width deltas shift with it) or ``'scan:<scanId>'`` (a bound scan's recorded reference,
    deltas included). Returns ``{'median', 'widths', 'source'}`` or None for the computed one."""
    if raw in (None, ''):
        return None
    if isinstance(raw, str) and raw.startswith('scan:'):
        want = raw[5:]
        for c in scan_references(state, source, d8):
            if c['scanId'] == want:
                return dict(median=float(c['median']), widths=_widths(c['reference']),
                            source=dict(kind='scan', label=f'scan {c["label"]}', scanId=c['scanId'],
                                        dataset=c['dataset']))
        raise ValueError(f'No open scan {want!r} records a regularity reference for this dataset with these '
                         'regularity parameters')
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise ValueError('a reference override is a number or scan:<scanId>') from None
    return dict(median=v, widths=_widths(computed), source=dict(kind='override', label='set by hand'))


def _widths(ref: Optional[dict]) -> Optional[dict]:
    try:
        from fiberhmm.nuc.regularity import reference_widths
    except ImportError:
        return None
    return reference_widths(ref) if ref else None


def widths_of(ref: Optional[dict]) -> Optional[dict]:
    """The per-width deltas of a reference dict (``call_patches``' ``ref_widths``), or None."""
    return _widths(ref)
