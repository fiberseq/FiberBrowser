"""Single-fibre nucleosome regularity (FiberHMM ``fiberhmm.nuc.regularity``, MA group ``nucreg``) in the browser.

Regularity costs nothing unless something asks for it. A live Compute never computes it; the ``nucreg`` tiles of a
stored record are computed on demand from the store's decoded molecule and kept in a bounded cache per record and
parameters (``_TILES``):

- a read load that names the ``nucreg`` layer (the lane is visible, a ``nuc.reg.*`` Sort/Filter term) computes the
  tiles its rows lack (``tiles_for_row``); a load of every layer (``requested_layers`` None) only uses cached tiles;
- a ``nuc.reg`` / ``nuc.reg.pattern`` cluster column computes a row's tiles when the row has none
  (``services.clustering_features.nuc_reg_intervals``);
- the Regularity view computes its cohort's tiles in a small thread pool (``ensure``).

The regularity parameters are kept apart from the nuc settings: they never enter the settings hash, the calibration
or the store's configuration. Changing them only selects other cache entries; no molecule is recalibrated.
Annotated BAMs and scans keep the tiles of their own tags (``RecordOutputs.groups['nucreg']``).

- ``dataset_params`` / ``set_dataset_params``: the dataset's regularity parameters (session state, default
  FiberHMM's ``DEFAULT_REGULARITY``), mirrored per file for the read-layer injector.
- ``dataset_reference`` / ``path_reference``: the dataset's random-packing reference (``services.nuc.reference``:
  its calibration population, as fiberhmm-scan computes ``nucreg_reference``, independent of the views) and the
  observed 95th percentile of tile scores. The read lane's colour scale runs from the reference median to that
  percentile.
- ``regularity_analysis``: the panel's Regularity view per observation (the frontend sends one observation per
  cluster and dataset): score distribution against the reference, mean score along the region, local repeat
  length, score against m6A density (Spearman), the masked density-matched m6A autocorrelation, and a summary row.
  Per-molecule statistics and whole responses are cached.

Which parameters the lanes show. A request is computed with its own parameters, resolved once at its start (the
panel's, else the dataset's current ones); nothing inside an analysis reads the dataset's parameters again. The read
lanes (``path_params``) show one set per file: when a request finishes, its panel's regularity and patch settings
become the dataset's and the files' together (``adopt_lane``) only if its panel (``requestScope``; requests without
one share a scope) changed them since its last request, it is that panel's first request, or none are chosen yet.
Re-asks with unchanged settings never move the lanes, so two panels with different settings each get their own
responses while the lanes follow the last change. Cluster views (``requestScope`` 'cluster:<panel>',
``NON_ADOPTING_SCOPES``), requests with ``adopt`` false and hub replays compute with their own settings and never
move the lanes. A cancelled request (a disconnect, the same panel's newer request: ``cancel`` checkpoints) caches
nothing and changes nothing.

Per-record caches (tiles, float scores, reach, statistics) are keyed by the decode configuration of the molecules
they were computed from (``config_key``).
"""
from __future__ import annotations

import json
import math
import os
import threading
from collections import OrderedDict
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from functools import lru_cache

from .inputs import real as _real_path


@lru_cache(maxsize=256)
def real(path: str) -> str:
    """The resolved path (cached: per-record cache helpers call it once per record)."""
    return _real_path(path)
from .store import STORE, RecordOutputs

#: the analysis' score histogram (log2) and repeat-length histogram edges
SCORE_EDGES = [round(-2.0 + 0.25 * i, 2) for i in range(45)]          # -2 (FiberHMM's SCORE_LO) .. 9
ACF_LAGS = list(range(0, 1001, 5))
ACF_MASK_BP, ACF_THIN_PER_KB = 300, 25.0
MERGED_BP = 230                                                        # a footprint longer than this: merged
NUC_SIZED = (90, 230)                                                  # nucleosome-sized footprints (spacing)
#: the reference's window count and seed (fiberhmm-scan's nucpatch defaults; services.nuc.reference); the seed also
#: picks the scatter sample
REFERENCE_WINDOWS, REFERENCE_SEED = 3000, 1
MAX_SCATTER, MAX_ACF_MOLECULES = 1500, 200
#: the lane's colour scale without a reference (an annotated BAM nobody computed here): FiberHMM's typical
#: Hia5 random-packing median and an upper end three log2 units above it
FALLBACK_SCALE = (3.0, 6.0)
MAX_TILES, MAX_STATS, MAX_RESPONSES = 200_000, 60_000, 16
#: full-window tracks kept for read-end mode changes (a few kB each)
MAX_BASES = 60_000
#: FFT threads for a single molecule computed on a request's own thread (identical result for any value)
FFT_WORKERS = max(1, min(4, os.cpu_count() or 1))

_LOCK = threading.RLock()
#: Per-record caches are keyed by the store configuration the record's molecule was decoded under (``config_key``):
#: the tiles, scores, reach and statistics all come from ``mol.hits``, which the decode settings change, so a re-Analyse
#: with other settings never reads the previous configuration's values.
_TILES: "OrderedDict[tuple, list]" = OrderedDict()      # (real path, config, sha, occ, params8) -> marks
#: (real path, params8) -> how many times tiles were added for these parameters (part of ``revision``)
_TILE_GEN: Dict[Tuple[str, str], int] = {}
_EPOCH = [0]                                           # moved by clear_references (tests)
_PATH_PARAMS: Dict[str, object] = {}                   # real path -> its dataset's RegularityParams
_REFERENCES: Dict[tuple, dict] = {}                    # unused (references live in services.nuc.reference)
_STATS: "OrderedDict[tuple, dict]" = OrderedDict()     # (real path, config, sha, occ) -> per-molecule statistics
_RESPONSES: "OrderedDict[str, dict]" = OrderedDict()
_REACH: "OrderedDict[tuple, tuple]" = OrderedDict()    # (real path, config, sha, occ, params8) -> grid reach (ref)
#: (real path, config, sha, occ, params8) -> the track's float scores per grid tile (patches are called on these, as the
#: scan calls them; the marks keep byte resolution)
_SCORES: "OrderedDict[tuple, object]" = OrderedDict()
#: (real path, config, sha, occ, params8) -> each grid tile's window width (ends 'truncated' only; with ``_SCORES``):
#: what a cut tile's per-width reference is read at (``mark_ref_deltas``)
_WIDTHS: "OrderedDict[tuple, object]" = OrderedDict()
#: (real path, config, sha, occ, base params8) -> the record's full-window track (ends 'blank'; ``_block_tracks``),
#: bounded by its arrays' bytes (``BASE_BYTES``; ultra-long records have many more tiles than PacBio ones)
_BASE: "OrderedDict[tuple, object]" = OrderedDict()
_BASE_BYTES = [0]
#: the most bytes of full-window tracks kept (``MAX_BASES`` still caps their number)
BASE_BYTES = 512 * 1024 * 1024


# ------------------------------------------------------------------ parameters
def parse_params(raw: Optional[dict]):
    """``RegularityParams`` from the panel's settings; 0 or None turns masking/thinning off."""
    from fiberhmm.nuc.regularity import RegularityParams
    if not raw:
        return RegularityParams()
    if not isinstance(raw, dict):
        raise ValueError('regularity parameters must be an object')
    d = dict(raw)
    for key in ('mask_open_bp', 'thin_per_kb'):
        if key in d and (d[key] in (None, '') or float(d[key]) <= 0):
            d[key] = None
    for key in ('window_bp', 'step_bp', 'min_calls', 'nfft', 'mask_open_bp', 'end_min_bp', 'short_min_bp'):
        if d.get(key) is not None:
            d[key] = int(d[key])
    if d.get('thin_per_kb') is not None:
        d['thin_per_kb'] = float(d['thin_per_kb'])
    for key in ('band_bp', 'ref_bp'):
        if key in d:
            v = d[key]
            if not isinstance(v, (list, tuple)) or len(v) != 2:
                raise ValueError(f'{key} must be [low, high]')
            d[key] = (int(v[0]), int(v[1]))
    try:
        return RegularityParams.from_dict(d)
    except (TypeError, ValueError) as error:
        raise ValueError(str(error)) from None




def _params_state(state) -> dict:
    with _LOCK:
        return state.__dict__.setdefault('nuc_regularity', {})


def dataset_params(state, dataset_id: str):
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    return _params_state(state).get(dataset_id) or DEFAULT_REGULARITY


def chosen_params(state, dataset_id: str):
    """The dataset's regularity parameters chosen in this server session, or None (FiberHMM's defaults apply)."""
    return _params_state(state).get(dataset_id)


def set_dataset_params(state, dataset_id: str, params, paths=()) -> bool:
    """Make ``params`` the dataset's regularity parameters (and its files'); True when they changed."""
    cur = dataset_params(state, dataset_id)
    _params_state(state)[dataset_id] = params
    changed = cur.digest() != params.digest()
    with _LOCK:
        for p in paths:
            rp = real(p)
            old = _PATH_PARAMS.get(rp)
            _PATH_PARAMS[rp] = params
            if old is None or old.digest() != params.digest():
                changed = changed or old is not None    # rows built for other parameters are rebuilt (revision)
    return changed


def path_params(path: str):
    from fiberhmm.nuc.regularity import DEFAULT_REGULARITY
    with _LOCK:
        return _PATH_PARAMS.get(real(path)) or DEFAULT_REGULARITY


def digest8(params) -> str:
    return params.digest()[:8]


def revision(path: str) -> str:
    """What read rows carrying the file's ``nucreg`` lane are built from, as a content identity (the read caches'
    identity): the lane parameters, how many times tiles were added for them, and the reference the lane is read
    against. Returning to earlier settings gives the earlier identity, so their read responses are found again."""
    return content_revision(path, path_params(path))


def content_revision(path: str, params) -> str:
    """``revision`` for any regularity parameters: what the file's tiles and reference for ``params`` are (a response
    computed with ``params`` depends on these, never on the lanes' parameters)."""
    import hashlib
    rp = real(path)
    d8 = digest8(params)
    ref = reference_for_path(path, d8)
    ref_id = None if ref is None else [ref.get('key'), ref.get('median'), ref.get('observed_p95')]
    with _LOCK:
        gen = _TILE_GEN.get((rp, d8), 0)
        epoch = _EPOCH[0]
    raw = json.dumps([params.digest(), gen, ref_id, epoch], default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ------------------------------------------------------------------ tiles
_CURRENT = object()     # a cache helper's ``config`` default: the store's current configuration of the file


def config_key(path: str, cfg=None):
    """The configuration a file's molecules are decoded under for a request (as ``molecules`` resolves it): the active
    configuration's record for the file, else the store's. Part of every per-record cache key."""
    return cfg.config_for(path) if cfg is not None else STORE.config_of(path)


def _ck(path: str, config):
    return STORE.config_of(path) if config is _CURRENT else config


def track_marks(mol, track, calls_digest: str) -> list:
    """The ``nucreg`` marks of a track as the store keeps them: (mol_start, mol_len, ref_start, ref_end, q, AN)."""
    from fiberhmm.nuc.regularity import track_rows
    from fiberhmm.scan.modules.nuc import _ref_envelopes
    tag = f'{calls_digest}.{track.params_digest[:8]}'
    rows = track_rows(track)
    # every tile's envelope in one pass (FiberHMM's _ref_envelopes: _ref_envelope per tile, identical)
    envs = _ref_envelopes(mol, [int(s) for s, _n, _q in rows], [int(s) + int(n) for s, n, _q in rows])
    return [(int(s), int(n), int(a), int(b), tuple(int(x) for x in q), f'nucreg@{tag}_{k}')
            for k, ((s, n, q), (a, b)) in enumerate(zip(rows, envs))]


def mol_envelopes(mol, starts, ends) -> list:
    """``[mol.mol_interval_to_ref(s, e) for s, e in zip(starts, ends)]`` in one pass (None where nothing of the
    interval is aligned), for alignment blocks ordered and disjoint on both sides (every CIGAR-derived block list;
    anything else goes interval by interval)."""
    starts = np.asarray(starts, dtype=np.int64)
    ends = np.asarray(ends, dtype=np.int64)
    blocks = mol.blocks
    if not len(starts):
        return []
    if blocks is None or len(blocks) == 0:
        return [None] * len(starts)
    blocks = np.asarray(blocks)
    q0, r0, n = blocks[:, 0], blocks[:, 1], blocks[:, 2]
    qe, re_ = q0 + n, r0 + n
    if not (bool((n > 0).all()) and bool((q0[1:] >= qe[:-1]).all()) and bool((r0[1:] >= re_[:-1]).all())):
        return [mol.mol_interval_to_ref(int(a), int(b)) for a, b in zip(starts, ends)]
    if mol.is_reverse:
        ss, se = mol.length - ends, mol.length - starts
    else:
        ss, se = starts, ends
    first = np.searchsorted(qe, ss, side='right')
    stop = np.searchsorted(q0, se, side='left')
    ok = (stop > first) & (se > ss)
    f = np.minimum(first, len(q0) - 1)
    l_ = np.clip(stop - 1, 0, len(q0) - 1)
    rs = r0[f] + (np.maximum(q0[f], ss) - q0[f])
    rend = r0[l_] + (np.minimum(qe[l_], se) - q0[l_])
    return [(int(a), int(b)) if good else None for a, b, good in zip(rs.tolist(), rend.tolist(), ok.tolist())]


def _calls_digest(out: RecordOutputs, mol, res) -> str:
    dg = getattr(res, 'digest', None) if res is not None else None
    if dg:
        return str(dg)
    for marks in out.groups.values():
        for m in marks:
            name = str(m[5])
            if '@' in name:
                return name.split('@', 1)[1].split('_', 1)[0].split('.', 1)[0]
    from fiberhmm.nuc.tags import _digest
    return _digest(mol)


def _decode_missing(path: str, cfg, rows: Dict[Tuple[str, int], RecordOutputs], keys) -> Dict[Tuple[str, int], object]:
    """Decode records whose molecule is not cached (their ref spans name where to look)."""
    import pysam
    from fiberhmm.nuc.records import decode_record
    from fiberhmm.scan.reads import iter_records, resolve_read_policy
    from .engine import nuc_params
    from .live import _decode_context, _merge, _params_key, bam_chrom
    want = set(keys)
    if not want:
        return {}
    settings = cfg.settings if cfg is not None else {}
    params = nuc_params(settings)
    regions = _merge([(rows[k].chrom, rows[k].ref_start, max(rows[k].ref_end, rows[k].ref_start + 1)) for k in want])
    filters = {**resolve_read_policy({})['filters'], 'duplicates': 'include', 'supplementary': 'include'}
    out = {}
    with pysam.AlignmentFile(path, 'rb') as bam:
        ctx = _decode_context(path, bam.header, params, _params_key(settings))
        for chrom, a, b in regions:
            name = bam_chrom(list(bam.references), chrom)
            if name is None:
                continue
            for read, sha, occ in iter_records(bam, name, a, b, filters):
                key = (str(sha), int(occ))
                if key in want and key not in out:
                    mol, _why = decode_record(read, ctx)
                    if mol is not None:
                        out[key] = mol
    return out


def molecules(path: str, cfg, rows: Dict[Tuple[str, int], RecordOutputs], keys, *, decode: bool = True) -> Dict[Tuple[str, int], tuple]:
    """(molecule, result or None) per record key: the store's cached decode, else (``decode``) a decode of the BAM
    record."""
    config = cfg.config_for(path) if cfg is not None else STORE.config_of(path)
    out = {}
    if config is not None:
        for k in keys:
            hit = STORE.get_result(path, k[0], k[1], config)
            if hit is not None:
                out[k] = hit
    missing = [k for k in keys if k not in out and k in rows]
    if missing and decode:
        for k, mol in _decode_missing(path, cfg, rows, missing).items():
            out[k] = (mol, None)
    return out


def _reach(mol, params) -> Optional[tuple]:
    """Reference span the molecule's window grid reaches (``fiberhmm.nuc.regularity.window_reach``)."""
    from fiberhmm.nuc.regularity import window_reach
    r = window_reach(int(mol.length), params)
    if r is None:
        return None
    env = mol.mol_interval_to_ref(int(r[0]), int(r[1]))
    return (int(env[0]), int(env[1])) if env is not None else None


def cached_scores(path: str, sha: str, occ: int, d8: str, config=_CURRENT):
    with _LOCK:
        key = (real(path), _ck(path, config), str(sha), int(occ), d8)
        hit = _SCORES.get(key)
        if hit is not None:
            _SCORES.move_to_end(key)      # used with the tiles: evicted with them, not first
        return hit


def _put_scores(path: str, items, d8: str, config=_CURRENT) -> None:
    rp, c = real(path), _ck(path, config)
    with _LOCK:
        for (sha, occ), score in items:
            _SCORES[(rp, c, str(sha), int(occ), d8)] = np.asarray(score, dtype=np.float64).copy()
        while len(_SCORES) > MAX_TILES:
            _SCORES.popitem(last=False)


def _put_widths(path: str, items, d8: str, config=_CURRENT) -> None:
    """Each grid tile's window width of tracks with cut windows (``RegularityTrack.window_widths``, ends 'truncated';
    other tracks have none and store nothing)."""
    rp, c = real(path), _ck(path, config)
    with _LOCK:
        for (sha, occ), widths in items:
            if widths is not None:
                _WIDTHS[(rp, c, str(sha), int(occ), d8)] = np.asarray(widths, dtype=np.int32).copy()
        while len(_WIDTHS) > MAX_TILES:
            _WIDTHS.popitem(last=False)


def mark_widths(path: str, sha: str, occ: int, d8: str, config=_CURRENT) -> Optional[np.ndarray]:
    """The window width of each of a record's ``nucreg`` marks (its scored tiles, in mark order), when the browser
    computed them with cut windows; else None."""
    with _LOCK:
        key = (real(path), _ck(path, config), str(sha), int(occ), d8)
        widths, score = _WIDTHS.get(key), _SCORES.get(key)
    if widths is None or score is None or len(widths) != len(score):
        return None
    return widths[np.isfinite(score)]


def mark_ref_deltas(path: str, sha: str, occ: int, marks, params, ref: Optional[dict], config=_CURRENT):
    """Per ``nucreg`` mark, the per-width shift of the random-packing reference its window is read against
    (FiberHMM ``tile_reference`` minus the median: 0 for full windows, below 0 for cut windows), or None when the
    marks have no cut windows, the reference has no per-width part, or the widths are unknown (a scan's or an
    annotated BAM's own tiles)."""
    if params.ends != 'truncated' or not marks or not ref or not ref.get('width_deltas'):
        return None
    from . import reference as REF
    from fiberhmm.nuc.regularity import tile_reference
    widths = mark_widths(path, sha, occ, digest8(params), config)
    if widths is None or len(widths) != len(marks):
        return None
    out = tile_reference(widths, 0.0, REF.widths_of(ref))
    return None if np.isscalar(out) else np.asarray(out, dtype=float)


#: the ``ref_delta`` quality byte of a live nucreg layer: 128 + 40 * delta (log2), 1..255; 0 = none
REF_DELTA_ZERO, REF_DELTA_SCALE = 128, 40.0


def encode_ref_delta(delta: float) -> int:
    if not math.isfinite(delta):
        return 0
    return int(min(255, max(1, round(REF_DELTA_ZERO + REF_DELTA_SCALE * float(delta)))))


def with_ref_deltas(marks, deltas) -> Tuple[list, Optional[List[str]]]:
    """(marks, quality names) of a nucreg layer: with a third quality, ``ref_delta`` (``encode_ref_delta``), when the
    marks have per-width reference shifts; the marks as they are otherwise (rows of full windows stay identical)."""
    if deltas is None:
        return marks, None
    from .layers import QUALITY_NAMES
    out = [(ms, ml, a, b, tuple(q) + (encode_ref_delta(d),), n) for (ms, ml, a, b, q, n), d in zip(marks, deltas)]
    return out, list(QUALITY_NAMES['nucreg']) + ['ref_delta']


def cached_reach(path: str, sha: str, occ: int, d8: str, config=_CURRENT) -> Optional[tuple]:
    with _LOCK:
        return _REACH.get((real(path), _ck(path, config), str(sha), int(occ), d8))


def _put_reach(path: str, items, d8: str, config=_CURRENT) -> None:
    rp, c = real(path), _ck(path, config)
    with _LOCK:
        for (sha, occ), reach in items:
            if reach is not None:
                _REACH[(rp, c, str(sha), int(occ), d8)] = reach
        while len(_REACH) > MAX_TILES:
            _REACH.popitem(last=False)


def cached_tiles(path: str, sha: str, occ: int, d8: str, config=_CURRENT) -> Optional[list]:
    with _LOCK:
        key = (real(path), _ck(path, config), str(sha), int(occ), d8)
        hit = _TILES.get(key)
        if hit is not None:
            _TILES.move_to_end(key)
        return hit


def _put_tiles(path: str, items, d8: str, *, bump: bool, config=_CURRENT) -> None:
    rp, c = real(path), _ck(path, config)
    with _LOCK:
        for (sha, occ), marks in items:
            _TILES[(rp, c, str(sha), int(occ), d8)] = marks
        while len(_TILES) > MAX_TILES:
            _TILES.popitem(last=False)
        if bump and items:
            _TILE_GEN[(rp, d8)] = _TILE_GEN.get((rp, d8), 0) + 1


def tiles_for_row(path: str, sha: str, occ: int, out: RecordOutputs, params, *, compute: bool) -> Optional[list]:
    """A live record's tiles for ``params``: cached, or (``compute``) computed now from the store's decoded molecule
    (never a BAM decode on a read load; a record whose molecule left the cache has none until a Regularity request)."""
    from fiberhmm.nuc.regularity import sliding_regularity
    d8 = digest8(params)
    config = STORE.config_of(path)
    marks = cached_tiles(path, sha, occ, d8, config)
    if marks is not None or not compute:
        return marks
    hit = STORE.get_result(path, sha, occ, config) if config is not None else None
    if hit is None:
        return None
    mol, res = hit
    track = sliding_regularity(mol, params, workers=FFT_WORKERS)
    marks = track_marks(mol, track, _calls_digest(out, mol, res))
    _put_scores(path, [((sha, occ), track.score)], d8, config)
    _put_widths(path, [((sha, occ), track.window_widths)], d8, config)
    _put_tiles(path, [((sha, occ), marks)], d8, bump=False, config=config)
    _put_reach(path, [((sha, occ), _reach(mol, params))], d8, config)
    return marks


def row_layer(read: dict, region_start: int) -> Optional[dict]:
    """The ``nucreg`` layer of a read row that was built without one (a load of every layer before its tiles were
    cached): computed now from the store when the row is a live record (a nuc.reg cluster column asked for it)."""
    from .layers import NUCREG_REF_KEY, layer_payload, lane_scale_for
    path, sha, occ = read.get('library_id'), read.get('record_sha256'), read.get('alignment_occurrence')
    if not isinstance(path, str) or sha is None or occ is None:
        return None
    out = STORE.get(path, str(sha), int(occ))
    if out is None:
        return None
    params = path_params(path)
    marks = tiles_for_row(path, str(sha), int(occ), out, params, compute=True)
    if not marks:
        return None
    ref = reference_for_path(path, digest8(params))
    marks, names = with_ref_deltas(marks, mark_ref_deltas(path, str(sha), int(occ), marks, params, ref))
    payload = layer_payload('nucreg', marks, int(region_start), 1 << 62, include_qualities=True,
                            quality_names=names)
    if payload is not None:
        payload['scale'] = lane_scale_for(path, digest8(params))
        if ref is not None and ref.get('median') is not None:
            read.setdefault(NUCREG_REF_KEY, float(ref['median']))
    return payload


def _tracks(items, params, workers: int = 4) -> list:
    """sliding_regularity per (key, mol) in a small thread pool (scipy's FFT releases the GIL)."""
    from fiberhmm.nuc.regularity import sliding_regularity
    if len(items) < 32 or workers <= 1:
        return [(k, sliding_regularity(m, params, workers=FFT_WORKERS)) for k, m in items]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=workers) as pool:
        tracks = list(pool.map(lambda km: sliding_regularity(km[1], params), items))
    return [(k, t) for (k, _m), t in zip(items, tracks)]


def _check(cancel) -> None:
    """A cancellation checkpoint: ``cancel`` is a callable raising when the request was abandoned, or an Event."""
    if cancel is None:
        return
    if hasattr(cancel, 'is_set'):
        if cancel.is_set():
            raise InterruptedError('cancelled')
    else:
        cancel()


#: tiles being computed: (real path, config, d8, sha, occ) -> Event set when the computing request is done with it
#: (single flight: the Regularity view's and the patch section's requests of one settings change share the work)
_CLAIMS: Dict[tuple, threading.Event] = {}
#: records claimed (and computed) at a time
CLAIM_BLOCK = 512


def ensure(path: str, cfg, rows: Dict[Tuple[str, int], RecordOutputs], keys, params, *, cancel=None,
           bump: bool = True) -> dict:
    """Compute and cache the tiles of the live records ``keys`` that lack them for ``params``. Returns counts; read
    rows built before pick the tiles up (the file's revision moves when any were added). ``cancel``: a checkpoint
    (callable or Event) between blocks of molecules. Single flight per record: tiles another request is computing
    are waited for (and computed here if that request stops first)."""
    d8 = digest8(params)
    config = config_key(path, cfg)
    rp = real(path)
    computed = missing = 0
    pending = [k for k in dict.fromkeys(keys) if k in rows]
    while pending:
        todo = [k for k in pending if cached_tiles(path, k[0], k[1], d8, config) is None]
        if not todo:
            break
        tried: set = set()
        theirs: List[threading.Event] = []
        # Claim blocks of unclaimed records and compute them; two requests over one cohort split it between them.
        i = 0
        while i < len(todo):
            mine = []
            with _LOCK:
                while i < len(todo) and len(mine) < CLAIM_BLOCK:
                    k = todo[i]
                    i += 1
                    ck = (rp, config, d8, k[0], k[1])
                    ev = _CLAIMS.get(ck)
                    if ev is None:
                        _CLAIMS[ck] = threading.Event()
                        mine.append(k)
                    else:
                        theirs.append(ev)
            if not mine:
                continue
            tried.update(mine)
            try:
                c, m = _compute_tiles(path, cfg, rows, mine, params, d8, config, cancel=cancel, bump=bump)
                computed += c
                missing += m
            finally:
                with _LOCK:
                    for k in mine:
                        ev = _CLAIMS.pop((rp, config, d8, k[0], k[1]), None)
                        if ev is not None:
                            ev.set()
        for ev in theirs:
            while not ev.wait(0.25):
                _check(cancel)
        _check(cancel)
        # what another request was computing is looked up again (computed here if it stopped first); records
        # computed here without a molecule are not asked again
        pending = [k for k in todo if k not in tried]
    return dict(computed=computed, missing=missing)


def rp_key(path: str) -> str:
    return real(path)


def _block_tracks(rp: str, config, items, params, workers: int) -> list:
    """``_tracks`` through the molecules' full-window tracks (FiberHMM ``track_from_base``, identical results): a
    read-end mode change ('blank' / 'extend' / 'truncated') reuses the full windows already computed for a record and
    computes only what differs (nothing for 'extend', the cut windows for 'truncated')."""
    try:
        from fiberhmm.nuc.regularity import base_params, track_from_base
    except ImportError:          # an older FiberHMM: every track in full
        return _tracks(items, params, workers)
    bp = base_params(params)
    b8 = digest8(bp)
    bases, need = {}, []
    with _LOCK:
        for k, m in items:
            hit = _BASE.get((rp, config, k[0], k[1], b8))
            if hit is not None:
                _BASE.move_to_end((rp, config, k[0], k[1], b8))
                bases[k] = hit
            else:
                need.append((k, m))
    if need:
        got = _tracks(need, bp, workers)
        with _LOCK:
            for k, t in got:
                bases[k] = t
                key = (rp, config, k[0], k[1], b8)
                old = _BASE.pop(key, None)
                if old is not None:
                    _BASE_BYTES[0] -= _track_bytes(old)
                _BASE[key] = t
                _BASE_BYTES[0] += _track_bytes(t)
            while _BASE and (len(_BASE) > MAX_BASES or _BASE_BYTES[0] > BASE_BYTES):
                _BASE_BYTES[0] -= _track_bytes(_BASE.popitem(last=False)[1])
    return [(k, track_from_base(m, bases[k], params)) for k, m in items]


def _track_bytes(track) -> int:
    """The bytes a kept track's arrays hold."""
    n = 0
    for v in vars(track).values() if hasattr(track, '__dict__') else ():
        if isinstance(v, np.ndarray):
            n += int(v.nbytes)
    return n + 200


def _compute_tiles(path, cfg, rows, todo, params, d8, config, *, cancel, bump) -> Tuple[int, int]:
    _check(cancel)
    mols = molecules(path, cfg, rows, todo)
    items = [(k, mols[k][0]) for k in todo if k in mols]
    workers = max(1, min(4, (os.cpu_count() or 2) // 2))
    done = []
    for i in range(0, len(items), 512):
        _check(cancel)
        block, wblock = [], []
        for k, track in _block_tracks(rp_key(path), config, items[i:i + 512], params, workers):
            mol, res = mols[k]
            done.append((k, track_marks(mol, track, _calls_digest(rows[k], mol, res))))
            block.append((k, track.score))
            wblock.append((k, track.window_widths))
        _put_scores(path, block, d8, config)
        _put_widths(path, wblock, d8, config)
    _put_reach(path, [(k, _reach(mols[k][0], params)) for k, _m in done], d8, config)
    _put_tiles(path, done, d8, bump=bump, config=config)
    return len(done), len(todo) - len(items)


def tiles_of(path: str, r_key, row: RecordOutputs, params, config=_CURRENT) -> Optional[list]:
    """A cohort row's tiles for ``params``: its own (an annotated BAM or a scan made with these parameters), else
    the cache (``config``: the configuration the request decodes under, ``config_key``)."""
    d8 = digest8(params)
    if row.groups.get('nucreg') and row.regularity_digest == d8:
        return row.groups['nucreg']
    return cached_tiles(path, r_key[0], r_key[1], d8, config)


# ------------------------------------------------------------------ reference
def _tile_scores(marks) -> np.ndarray:
    from fiberhmm.nuc.regularity import decode_score
    s = np.array([decode_score(m[4][0]) for m in marks if m[4]], dtype=float)
    return s[np.isfinite(s)]


def dataset_reference(source, params, cfg, *, compute: bool = True) -> Optional[dict]:
    """The dataset's random-packing reference for ``params`` (``services.nuc.reference``: one per dataset, from its
    calibration population as fiberhmm-scan computes it, never from the records viewed so far)."""
    from . import reference as REF
    if cfg is None:
        return reference_for_path(source.paths[0], digest8(params))
    return REF.dataset_reference(list(source.paths), cfg, params, compute_now=compute)


def prefetch_references(state, sources: dict, params_of, cancel=None) -> Dict[str, BaseException]:
    """Compute the datasets' references at once, one thread each (single flight per reference; a dataset's own
    calibration population decode dominates), so a request naming several datasets waits for the slowest one, not
    their sum. ``params_of(ds_id)``: the request's parameters for the dataset. ``cancel``: checked while waiting (a
    stopped request returns at once; the computations go on in the background and are cached for the next request).
    Returns the failures per dataset: the caller reports them instead of computing a failing reference again."""
    from . import reference as REF
    from .jobs import active_config
    todo = []
    for ds_id, source in sources.items():
        cfg = active_config(state, ds_id)
        if cfg is None:
            continue
        p = params_of(ds_id)
        if REF.dataset_reference(list(source.paths), cfg, p, compute_now=False) is None:
            todo.append((ds_id, (list(source.paths), cfg, p)))
    if len(todo) < 2:
        return {}
    from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
    pool = ThreadPoolExecutor(max_workers=len(todo), thread_name_prefix='nuc-reference')
    futs = {pool.submit(REF.dataset_reference, *t): ds_id for ds_id, t in todo}
    try:
        pending = set(futs)
        while pending:
            _done, pending = wait(pending, timeout=0.25, return_when=FIRST_EXCEPTION)
            if pending:
                _check(cancel)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return {futs[f]: f.exception() for f in futs if f.done() and not f.cancelled() and f.exception() is not None}


def path_reference(path: str, params, *, compute: bool = True, cfg=None, bump: bool = True) -> Optional[dict]:
    """The reference of the dataset this file belongs to (the dataset that registered it last), for ``params``:
    cached or stored; ``compute`` (never on a read load) computes it when the dataset is known. ``cfg``/``bump`` are
    kept for callers; the reference no longer depends on the store's rows."""
    from . import reference as REF
    d8 = digest8(params)
    hit = REF.cached_for_path(path, d8)
    if hit is not None or not compute:
        return hit
    with REF._LOCK:
        key = REF._PATH_KEY.get((real(path), d8))
        spec = REF._SPEC.get(key) if key is not None else None
    if spec is not None:
        return REF.dataset_reference(spec[0], spec[1], spec[2])
    if cfg is not None:
        return REF.dataset_reference([path], cfg, params)
    return None


def reference_for_path(path: str, d8: str) -> Optional[dict]:
    """The reference registered for a file's dataset and these parameters, if computed (never computes)."""
    from . import reference as REF
    return REF.cached_for_path(path, d8)


def reference_source(ref: Optional[dict]) -> Optional[dict]:
    """Where a reference came from, for the panel."""
    if not ref:
        return None
    src = dict(ref.get('source') or {})
    src.setdefault('kind', 'calibration')
    src.update(median=ref.get('median'), usable=ref.get('usable', ref.get('median') is not None),
               windows=ref.get('n_windows'), molecules=ref.get('n_molecules'),
               perWidth=bool(ref.get('width_deltas')), reason=ref.get('reason'))
    return src


def lane_scale(ref: Optional[dict]) -> dict:
    """The read lane's colour scale: zero at the reference median, top at the observed 95th percentile."""
    if not ref or ref.get('median') is None:
        lo, hi = FALLBACK_SCALE
        return dict(zero=lo, top=hi, reference=False)
    lo = float(ref['median'])
    hi = ref.get('observed_p95')
    hi = float(hi) if hi is not None and hi > lo + 0.25 else lo + 3.0
    return dict(zero=round(lo, 3), top=round(hi, 3), reference=True)


def clear_references() -> None:
    """Drop every regularity cache (tests)."""
    with _LOCK:
        _TILES.clear()
        _BASE.clear()
        _BASE_BYTES[0] = 0
        _WIDTHS.clear()
        _REACH.clear()
        _SCORES.clear()
        _REFERENCES.clear()
        from . import reference as REF
        REF.clear()
        _STATS.clear()
        _RESPONSES.clear()
        _PATH_PARAMS.clear()
        _EPOCH[0] += 1


# ------------------------------------------------------------------ analysis
def _num(v, digits: int = 4):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, digits) if math.isfinite(f) else None


def _median(values):
    vs = [v for v in values if v is not None and math.isfinite(v)]
    return float(np.median(vs)) if vs else None


#: the panel's molecule cohorts (fiberhmm-scan's nucgeo ``cohort``): records overlapping the window (default, the
#: scan's default too) or only those spanning it
COHORTS = ('overlapping', 'spanning')
DEFAULT_COHORT = 'overlapping'


def resolve_cohort(cohort: Optional[str] = None, spanning: bool = False) -> str:
    """The cohort of a request: ``cohort`` when given, else the older ``spanning`` flag."""
    if cohort in (None, ''):
        return 'spanning' if spanning else DEFAULT_COHORT
    if cohort not in COHORTS:
        raise ValueError(f'cohort must be one of {", ".join(COHORTS)}')
    return str(cohort)


def _spanning(rec, windows, chrom: Optional[str] = None) -> bool:
    """Whether a record's aligned blocks cover the observation's window from end to end. ``chrom``: the record's
    contig; the window is then the hull of the observation's windows on that contig (a lifted view's windows are
    lift pieces on several haplotype contigs, and each record is measured against its own haplotype's)."""
    from .observations import same_contig, window_hull
    if chrom is not None:
        windows = [w for w in windows or () if same_contig(w[0], chrom)]
    hull = window_hull(windows)
    if hull is None or not rec.blocks:
        return False
    c, w0, w1 = hull
    return min(a for a, _b in rec.blocks) <= w0 and max(b for _a, b in rec.blocks) >= w1


def _molecule_stats(mol, span: Tuple[int, int]) -> dict:
    """m6A density, footprint sizes and nucleosome-sized spacing inside a molecular span."""
    m0, m1 = max(0, int(span[0])), min(int(mol.length), int(span[1]))
    if m1 <= m0:
        return {}
    density = 1000.0 * float(np.count_nonzero(mol.hits[m0:m1])) / (m1 - m0)
    nucs = mol.nucs
    if len(nucs):
        mid = (nucs[:, 0] + nucs[:, 1]) / 2.0
        inside = nucs[(mid >= m0) & (mid < m1)]
    else:
        inside = np.zeros((0, 2), dtype=np.int64)
    sizes = (inside[:, 1] - inside[:, 0]).astype(float) if len(inside) else np.zeros(0)
    spacing = []
    if len(inside) > 1:
        ok = (sizes >= NUC_SIZED[0]) & (sizes <= NUC_SIZED[1])
        centres = (inside[:, 0] + inside[:, 1]) / 2.0
        for i in range(len(inside) - 1):
            if ok[i] and ok[i + 1]:
                spacing.append(float(centres[i + 1] - centres[i]))
    return dict(density=density, sizes=sizes, spacing=spacing)


def _mark_tiles(marks):
    """(scores, periods, reference centres) of tiles."""
    from fiberhmm.nuc.regularity import decode_period, decode_score
    s, p, c = [], [], []
    for ms, ml, a, b, q, _n in marks:
        if not q:
            continue
        sc = decode_score(q[0])
        if not math.isfinite(sc):
            continue
        s.append(sc)
        p.append(decode_period(q[1]) if len(q) > 1 else -1)
        c.append((a + b) / 2.0)
    return s, p, c


def _mark_kept(marks) -> List[int]:
    """The indices of the marks ``_mark_tiles`` keeps (a score byte that decodes to a finite score)."""
    from fiberhmm.nuc.regularity import decode_score
    return [i for i, m in enumerate(marks) if m[4] and math.isfinite(decode_score(m[4][0]))]


def _frame_centres(marks, rf) -> List[float]:
    """``_mark_tiles``' reference centres projected into a lifted view (``frames.RecordFrame``; NaN outside it, so
    the tile still counts in the distributions but not along the region)."""
    from fiberhmm.nuc.regularity import decode_score
    out = []
    for _ms, _ml, a, b, q, _n in marks:
        if not q or not math.isfinite(decode_score(q[0])):
            continue
        t = rf.interval(a, b) if rf is not None else None
        out.append((t[0] + t[1]) / 2.0 if t is not None else float('nan'))
    return out


def _band_periods(params) -> List[int]:
    """The periods (bp) the spectrum reports inside the band: round(nfft / k) for the rfft bins in the band."""
    lo, hi = params.band_bp
    k = np.arange(1, params.nfft // 2 + 1)
    per = params.nfft / k
    return sorted({int(round(p)) for p in per[(per >= lo) & (per <= hi)]})


def _spearman(x, y) -> Optional[float]:
    if len(x) < 3:
        return None
    from scipy.stats import spearmanr
    res = spearmanr(x, y)
    return _num(getattr(res, 'statistic', None) if hasattr(res, 'statistic') else res[0], 3)


def _bins(window, step: int) -> List[float]:
    _c, w0, w1 = window
    width = max(int(step), int(math.ceil((w1 - w0) / 80.0)))
    return [float(w0 + i * width) for i in range(int(math.ceil((w1 - w0) / width)) + 1)]


def _stats_for(path: str, items, cfg, *, acf_budget: int, cancel=None) -> Dict[Tuple[str, int], dict]:
    """Per-molecule statistics (m6A density, footprint sizes, nucleosome-sized spacing and, for the first
    ``acf_budget`` molecules, the masked m6A ACF), cached per record and decode configuration."""
    from fiberhmm.nuc.regularity import masked_mark_acf
    rp, config = real(path), config_key(path, cfg)
    out, need = {}, []
    with _LOCK:
        for i, (k, _row) in enumerate(items):
            hit = _STATS.get((rp, config, k[0], k[1]))
            if hit is not None and (i >= acf_budget or 'acf' in hit):
                out[k] = hit
                _STATS.move_to_end((rp, config, k[0], k[1]))
            else:
                need.append((i, k))
    if need:
        _check(cancel)
        rows = dict(items)
        got = molecules(path, cfg, rows, [k for _i, k in need])
        for n, (i, k) in enumerate(need):
            if n % 256 == 255:
                _check(cancel)
            hit = got.get(k)
            with _LOCK:
                st = dict(_STATS.get((rp, config, k[0], k[1])) or {})
            if hit is None:
                continue
            mol = hit[0]
            if 'density' not in st:
                st.update(_molecule_stats(mol, (0, int(mol.length))) or {})
            if i < acf_budget and 'acf' not in st:
                acf = masked_mark_acf(mol, ACF_LAGS, ACF_MASK_BP, ACF_THIN_PER_KB)
                st['acf'] = acf if acf is not None and np.all(np.isfinite(acf)) else None
            out[k] = st
            with _LOCK:
                _STATS[(rp, config, k[0], k[1])] = st
                while len(_STATS) > MAX_STATS:
                    _STATS.popitem(last=False)
    return out


def observation_regularity(state, obs: dict, policy: dict, params, *, spanning: bool = False,
                           reference: Optional[dict] = None, per_molecule: bool = False, cancel=None) -> dict:
    """One observation's Regularity view (see the module docstring) for the regularity parameters ``params`` (the
    request's; never re-read from the dataset). ``cancel``: a checkpoint (callable or Event)."""
    from .frames import view_frame
    from .observations import observation_cohort, window_hull
    source, recs, windows, cfg, cohort, counts = observation_cohort(state, obs, policy, quick=True)
    if spanning:
        cohort = [(r, row) for r, row in cohort if _spanning(r, windows, row.chrom)]
    window = window_hull(windows)
    target, frame = view_frame(state, source, obs)
    if frame is not None:
        window = target         # a lifted linear view: tiles drawn along the target view (frames.py)
    entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=source.browser_id,
                 records=counts.get('records', len(recs)), notComputed=counts['missing'],
                 withoutCalls=counts['withoutCalls'],
                 window=dict(chrom=window[0], start=window[1], end=window[2]) if window else None)
    by_path: Dict[str, List[Tuple[Tuple[str, int], RecordOutputs]]] = {}
    for r, row in cohort:
        by_path.setdefault(r.path, []).append(((r.sha, r.occ), row))
    tiles: Dict[Tuple[str, str, int], list] = {}
    stats: Dict[Tuple[str, str, int], dict] = {}
    budget = MAX_ACF_MOLECULES
    for path, items in by_path.items():
        _check(cancel)
        rows = dict(items)
        config = config_key(path, cfg)
        # Tiles the rows lack for these parameters (live records, or tags made with other parameters).
        ensure(path, cfg, rows, [k for k, row in items if tiles_of(path, k, row, params, config) is None], params,
               cancel=cancel)
        for k, row in items:
            t = tiles_of(path, k, row, params, config)
            if t is not None:
                tiles[(path, *k)] = t
        for k, st in _stats_for(path, items, cfg, acf_budget=budget, cancel=cancel).items():
            stats[(path, *k)] = st
        budget = max(0, budget - len(items))
    tiles_s, tiles_p, mol_scores, densities, sizes, spacing = [], [], [], [], [], []
    scatter, acfs = [], []
    # Per molecule (Cluster views: the read map's colours): {qname: [median, max]} of the molecule's tile scores.
    per_mol: Dict[str, list] = {}
    bins = _bins(window, int(params.step_bp)) if window else []
    bin_sum = np.zeros(max(0, len(bins) - 1))
    bin_n = np.zeros(max(0, len(bins) - 1), dtype=np.int64)
    # Mean local repeat length per bin, over the tiles with a period (period 0 = none).
    per_sum = np.zeros(max(0, len(bins) - 1))
    per_n = np.zeros(max(0, len(bins) - 1), dtype=np.int64)
    stale = 0
    # ends 'truncated': each tile's excess over the reference read at its own window width (FiberHMM
    # tile_reference), so cut windows at read ends never read as less regular than they are
    per_width = params.ends == 'truncated' and bool(reference and reference.get('width_deltas'))
    excess: List[float] = []
    for r, row in cohort:
        key = (r.path, r.sha, r.occ)
        marks = tiles.get(key)
        if marks is None:
            stale += 1
        # Whole molecules are the unit: every tile of the molecule enters the distributions and the summary; the
        # track along the region bins the tiles centred in the window by reference position.
        s, p, c = _mark_tiles(marks or ())
        if per_width and s:
            dl = mark_ref_deltas(r.path, r.sha, r.occ, marks, params, reference, config_key(r.path, cfg))
            keep = _mark_kept(marks)
            excess += [x - (float(dl[i]) if dl is not None else 0.0) for x, i in zip(s, keep)]
        if frame is not None:
            rf = frame.record(row.chrom, row.ref_start, row.ref_end)
            c = _frame_centres(marks or (), rf)
        tiles_s += s
        tiles_p += [x for x in p if x > 0]
        if len(bins) > 1 and c:
            idx = np.searchsorted(bins, c, side='right') - 1
            ok = (idx >= 0) & (idx < len(bin_sum))
            np.add.at(bin_sum, idx[ok], np.asarray(s)[ok])
            np.add.at(bin_n, idx[ok], 1)
            pa = np.asarray(p, dtype=float)
            okp = ok & (pa > 0)
            np.add.at(per_sum, idx[okp], pa[okp])
            np.add.at(per_n, idx[okp], 1)
        med = float(np.median(s)) if s else None
        if med is not None:
            mol_scores.append(med)
            if per_molecule:
                per_mol[r.qname] = [_num(med, 3), _num(max(s), 3)]
        st = stats.get(key) or {}
        if 'density' in st:
            densities.append(st['density'])
            sizes.append(st['sizes'])
            spacing += st['spacing']
            if med is not None:
                scatter.append((med, st['density']))
        if st.get('acf') is not None:
            acfs.append(st['acf'])
    all_sizes = np.concatenate(sizes) if sizes else np.zeros(0)
    ref_median = reference.get('median') if reference else None
    sc_hist = np.histogram(tiles_s, bins=SCORE_EDGES)[0].tolist()
    # The spectrum's band periods are discrete (nfft / k): one count per period the spectrum can report.
    values = _band_periods(params)
    got = dict(zip(*np.unique(np.asarray(tiles_p, dtype=np.int64), return_counts=True))) if tiles_p else {}
    pr_counts = [int(got.get(v, 0)) for v in values]
    if len(scatter) > MAX_SCATTER:
        rng = np.random.default_rng(REFERENCE_SEED)
        shown = [scatter[i] for i in np.sort(rng.choice(len(scatter), MAX_SCATTER, replace=False))]
    else:
        shown = scatter
    med_score = _median(tiles_s)
    if per_molecule:
        entry['perMolecule'] = per_mol
    entry.update(
        molecules=len(cohort), scored=len(mol_scores), staleTiles=stale,
        scores=dict(edges=SCORE_EDGES, counts=sc_hist, n=len(tiles_s)),
        periods=dict(values=values, counts=pr_counts, n=len(tiles_p)),
        track=dict(edges=bins, mean=[_num(bin_sum[i] / bin_n[i], 3) if bin_n[i] else None for i in range(len(bin_n))],
                   n=bin_n.tolist(),
                   period=[_num(per_sum[i] / per_n[i], 1) if per_n[i] else None for i in range(len(per_n))]),
        scatter=dict(points=[[_num(a, 3), _num(b, 2)] for a, b in shown], n=len(scatter),
                     spearman=_spearman([a for a, _b in scatter], [b for _a, b in scatter])),
        acf=dict(lags=ACF_LAGS, mean=[_num(v, 4) for v in np.mean(acfs, axis=0)] if acfs else None, n=len(acfs),
                 maskBp=ACF_MASK_BP, thinPerKb=ACF_THIN_PER_KB),
        summary=dict(
            molecules=len(cohort), m6aPerKb=_num(_median(densities), 2),
            footprintMedian=_num(float(np.median(all_sizes)), 1) if len(all_sizes) else None,
            mergedPct=_num(100.0 * float(np.mean(all_sizes > MERGED_BP)), 1) if len(all_sizes) else None,
            spacingMedian=_num(_median(spacing), 1), score=_num(med_score, 3),
            moleculeMedian=_num(_median(mol_scores), 3),
            scoreAboveRef=(_num(_median(excess) - ref_median, 3) if per_width and excess and ref_median is not None
                           else _num(med_score - ref_median, 3) if med_score is not None and ref_median is not None
                           else None),
            repeatLength=_num(_median([float(x) for x in tiles_p]), 1)),
    )
    return entry


#: requests whose ``requestScope`` starts with one of these never move the lanes nor relabel them (the cluster views:
#: their cohorts are the clustered series, their settings copy a panel's); they compute with their own parameters
NON_ADOPTING_SCOPES = ('cluster:',)


def adopting(scope: Optional[str], adopt: bool = True) -> bool:
    """Whether a request may move the lanes and relabel them: not a cluster view (``NON_ADOPTING_SCOPES``) and not
    asked not to (``adopt`` False, the request's ``adopt`` field)."""
    return bool(adopt) and not str(scope or '').startswith(NON_ADOPTING_SCOPES)


#: held across a finished request's adoption and installation (``adopt_lane`` then ``install_lane``), so two requests
#: finishing together never install one's regularity with the other's patch settings
_LANE_LOCK = threading.RLock()


def lane_owner(state, dataset_id: str) -> Optional[str]:
    """The scope of the panel whose settings the dataset's lanes took last (``adopt_lane``), or None (none yet)."""
    with _LOCK:
        return _lane_memory(state).get(('owner', str(dataset_id)))


def _lane_memory(state) -> dict:
    return state.__dict__.setdefault('nuc_param_scopes', {})


def _patch_digest(patch_choice) -> Optional[str]:
    if patch_choice is None:
        return None
    patch, ov = patch_choice
    return json.dumps([patch.to_dict(), ov], sort_keys=True, default=str)


def adopt_lane(state, dataset_id: str, scope: Optional[str], *, reg=None, patch=None) -> Tuple[object, object]:
    """The lane parameters a finished request installs for a dataset, as one coherent tuple: (regularity
    parameters or None, (PatchParams, reference choice) or None); (None, None) installs nothing.

    Each panel (``scope``) is remembered with the regularity and patch settings it used last. When a request's
    explicit settings (``reg``; ``patch`` = (PatchParams, reference choice)) differ from its panel's last ones, it is
    the panel's first request, or the dataset has no lane settings chosen yet, the lanes take the panel's whole
    tuple: the settings the request gave, and for a kind it did not give (the Regularity view's request carries no
    patch settings) the panel's last ones. So the regularity and patch lanes always show one panel's settings
    together, never one panel's regularity with another's patches; re-asks with unchanged settings never move them.
    Call only for adopting requests (``adopting``)."""
    from . import nucgeo
    with _LOCK:
        mem = _lane_memory(state)
        k = ('lane', str(dataset_id), str(scope or ''))
        prev = mem.get(k)
        cur = dict(prev or {})
        changed = prev is None
        if reg is not None:
            changed |= prev is None or prev.get('reg') is None or prev['reg'].digest() != reg.digest()
            cur['reg'] = reg
        if patch is not None:
            changed |= prev is None or _patch_digest(prev.get('patch')) != _patch_digest(patch)
            cur['patch'] = patch
        mem[k] = cur
        chosen_reg = chosen_params(state, dataset_id) is not None
        chosen_patch = nucgeo.chosen(state, dataset_id) is not None
    if not (changed or (reg is not None and not chosen_reg) or (patch is not None and not chosen_patch)):
        return None, None
    with _LOCK:
        mem[('owner', str(dataset_id))] = str(scope or '')
    return cur.get('reg'), cur.get('patch')


def _adopt_regularity(state, ds_id: str, source, asked, scope, adopt: bool = True) -> bool:
    """The adoption step of a finished regularity request (``adopt_lane``); True when the lanes' parameters changed.
    Without explicit parameters, files with no lane parameters yet take the dataset's (no change of choice)."""
    if asked is None:
        # mirrored for the read lanes only: reading the dataset's parameters is not choosing them
        cur = dataset_params(state, ds_id)
        with _LOCK:
            for p in source.paths:
                rp = real(p)
                if rp not in _PATH_PARAMS:
                    _PATH_PARAMS[rp] = cur      # rows built under the defaults are rebuilt (revision)
        return False
    if not adopting(scope, adopt):
        return False
    with _LANE_LOCK:
        reg, patch = adopt_lane(state, ds_id, scope, reg=asked)
        return install_lane(state, ds_id, source, reg, patch)


def install_lane(state, ds_id: str, source, reg, patch) -> bool:
    """Make ``reg`` (regularity parameters) and ``patch`` ((PatchParams, reference choice)) the dataset's lane
    parameters together (either may be None: unchanged); True when anything changed."""
    from . import nucgeo
    changed = False
    if reg is not None:
        changed |= set_dataset_params(state, ds_id, reg, source.paths)
    if patch is not None:
        changed |= nucgeo.set_dataset_params(state, ds_id, patch[0], patch[1], source.paths)
    return changed


# A request whose bound scans change while it computes is recomputed up to this many times (then refused).
MAX_SCAN_RETRIES = 2


def bound_scans_identity(state, sources) -> list:
    """The open scans with nuc outputs bound to any of ``sources`` (their rows and references feed the analysis):
    scan id, manifest digest, opening time and bindings, so opening, closing or re-binding a scan changes a response
    key."""
    try:
        from services.scan.registry import list_scans
        scans = list_scans(state)
    except Exception:      # noqa: BLE001 - no scan registry in this state
        return []
    ids = {src.browser_id for src in sources.values()}
    out = []
    for scan in scans:
        try:
            if not scan.module('nuc'):
                continue
            pairs = sorted([sid, bid, str(via), sorted((int(i), real(p)) for i, p in by_index.items())]
                           for sid, bid, via, by_index in scan.bound_pairs() if bid in ids)
        except Exception:      # noqa: BLE001 - a scan that cannot list its bindings binds nothing
            continue
        if pairs:
            out.append([scan.scan_id, scan.manifest_digest, scan.opened_at, pairs])
    return out


def regularity_analysis(state, observations: Sequence[dict], *, params: Optional[dict] = None,
                        spanning: bool = False, include_duplicates: bool = False, include_qcfail: bool = False, per_molecule: bool = False,
                        request_scope: Optional[str] = None, cancel=None,
                        cohort: Optional[str] = None, adopt: bool = True, _attempt: int = 0) -> dict:
    """The panel's Regularity view, computed with the request's own regularity parameters (``params``; without them
    the dataset's current ones), resolved once: nothing inside the analysis reads the dataset's parameters again, so
    two panels with different settings each get a self-consistent response. When the analysis finishes, ``params``
    may become the dataset's lane parameters (``adopt_lane``: the panel ``request_scope`` changed them; never for a
    cluster view's scope or ``adopt`` False). Responses
    are cached per request, parameters, stored outputs and configuration, so a repeated request costs nothing.
    ``cohort``: overlapping (default) or spanning (else the older ``spanning`` flag). ``cancel``: a checkpoint
    (callable raising InterruptedError, or an Event); a cancelled request caches nothing and changes no parameters."""
    from .inputs import browser_read_policy, nuc_source
    from .jobs import REGULARITY_LAYERS, active_config, config_identity, refresh_after
    from .observations import ObservationError
    from services.lift.reads import lift_identity
    from .record_count import warm
    warm()                  # the "not analysed" answer's record counts (observations._not_analysed)
    policy = browser_read_policy(state, include_duplicates=include_duplicates, include_qcfail=include_qcfail)
    asked = parse_params(params) if params is not None else None
    cohort = resolve_cohort(cohort, spanning)
    spanning = cohort == 'spanning'
    ids = list(dict.fromkeys(str(o.get('datasetId') or '') for o in observations))
    updated, references, sources, use = [], {}, {}, {}
    for ds_id in ids:
        try:
            source = nuc_source(state, ds_id)
        except ValueError:
            continue
        sources[ds_id] = source
        use[ds_id] = asked if asked is not None else dataset_params(state, ds_id)
    paths = sorted({p for src in sources.values() for p in src.paths})
    # The bound scans this analysis reads (their rows and references), captured before any input is read: a scan
    # opened, closed or re-bound meanwhile makes the answer stale, so it is recomputed rather than published.
    scans_before = bound_scans_identity(state, sources)

    def key_now() -> str:
        return json.dumps([observations, {d: digest8(use[d]) for d in sources}, cohort, include_duplicates, include_qcfail, policy['filters'].get('uncalled'),
                           per_molecule, [list(map(str, t)) for t in STORE.token(paths)],
                           {d: [content_revision(p, use[d]) for p in src.paths] for d, src in sources.items()},
                           {d: config_identity(active_config(state, d)) for d in sources},
                           {d: lift_identity(state.datasets.get(d)) for d in sources},
                           bound_scans_identity(state, sources)], sort_keys=True, default=str)

    def adopt_lanes() -> List[str]:
        changed = [d for d, src in sources.items() if _adopt_regularity(state, d, src, asked, request_scope, adopt)]
        return refresh_after(state, [p for d in changed for p in sources[d].paths], REGULARITY_LAYERS) if changed else []
    key = key_now()
    with _LOCK:
        hit = _RESPONSES.get(key)
        if hit is not None:
            _RESPONSES.move_to_end(key)
    if hit is not None:
        return {**hit, 'updatedDatasets': sorted(set(adopt_lanes()))}
    before = {p: revision(p) for p in paths}
    failed = prefetch_references(state, sources, lambda d: use[d], cancel)
    for ds_id, source in sources.items():
        _check(cancel)
        cfg = active_config(state, ds_id)
        p = use[ds_id]
        if ds_id in failed:
            raise failed[ds_id]                         # computed once above; never a second failing decode
        ref = dataset_reference(source, p, cfg)         # one per dataset (all its files), view independent
        references[ds_id] = dict(params=p.to_dict(), paramsDigest=digest8(p), reference=ref, scale=lane_scale(ref),
                                 source=reference_source(ref))
    out = []
    for obs in observations:
        _check(cancel)
        ds_id = str(obs.get('datasetId') or '')
        entry = dict(obsId=obs.get('obsId'), label=obs.get('label'), datasetId=ds_id)
        try:
            ref = (references.get(ds_id) or {}).get('reference')
            entry = observation_regularity(state, obs, policy, use.get(ds_id) or dataset_params(state, ds_id),
                                           spanning=spanning,
                                           reference=ref, per_molecule=per_molecule, cancel=cancel)
            entry['cluster'] = obs.get('cluster')
        except (ObservationError, ValueError) as error:
            entry['error'] = str(error)
        out.append(entry)
    _check(cancel)
    if bound_scans_identity(state, sources) != scans_before:
        if _attempt < MAX_SCAN_RETRIES:
            return regularity_analysis(state, observations, params=params, spanning=spanning,
                                       include_duplicates=include_duplicates, include_qcfail=include_qcfail,
                                       per_molecule=per_molecule, request_scope=request_scope, cancel=cancel,
                                       cohort=cohort, adopt=adopt, _attempt=_attempt + 1)
        raise ValueError('The open scans changed during the analysis; ask again')
    for ds_id, source in sources.items():
        if any(revision(p) != before.get(p) for p in source.paths):
            updated += refresh_after(state, source.paths, REGULARITY_LAYERS)
    updated += adopt_lanes()
    result = dict(observations=out, datasets=references, updatedDatasets=sorted(set(updated)), cohort=cohort)
    # Stored under the key of the state it leaves (tiles added and parameters adopted move the revisions).
    done_key = key_now()
    unchanged = bound_scans_identity(state, sources) == scans_before   # never cached under another scan set's key
    with _LOCK:
        if unchanged:
            _RESPONSES[done_key] = result
        while len(_RESPONSES) > MAX_RESPONSES:
            _RESPONSES.popitem(last=False)
    return result
