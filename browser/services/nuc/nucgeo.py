"""Regularity patches and shared patch geometries in the browser (FiberHMM ``fiberhmm.nuc.patches`` /
``fiberhmm.nuc.geometries``; layer ``nucpatch``; the Regularity view's patch section).

Nothing here runs unless something asks for it: the ``nucpatch`` layer only for a read load that names it, the
geometry analysis only from the panel's patch section. Both start from the ``nucreg`` tiles of
``services.nuc.regularity`` (computed on demand and cached there) and FiberHMM's own functions:

- a record's full regularity track is rebuilt from its tiles (``fiberhmm.nuc.regularity.track_from_rows``: the
  window grid of the regularity parameters, byte-resolution scores), cached per record and regularity parameters
  together with what patch calling and projection need from the molecule (its nucleosome calls, aligned blocks,
  length, strand, m6A density, TF footprints), so later parameter changes never touch the decoded molecule;
- patches: ``call_patches`` with the dataset's random-packing reference (``regularity.dataset_reference``: one per
  dataset, all its files, from its calibration population; with ends 'truncated' per window width), or the panel's
  choice (a median override, or a bound scan's recorded reference), cached per record, regularity, patch
  parameters and reference;
- layouts: ``molecule_layout``'s projection and view clipping (``_layout``, identical, plus the tile scores);
- geometries: ``find_geometries`` / ``assign_states`` / ``support`` / ``density_matched_shares`` on the pooled
  observations (pool -> find -> compare); folding (none / near / all) as FiberHMM sets it;
- association: geometry carriage against a site's NFR open/closed or TF occupancy state through FiberHMM's M1
  co-occurrence test (``fiberhmm.assoc.cooccur``: Mantel-Haenszel and the adjusted test, m6A density strata within
  each dataset), plus the prototype's density-matched open - closed comparison of the flanks.

Kinds. With ``low`` in the panel's patch settings (``PatchParams.low``) every record is also called for
low-regularity patches; geometries are found per kind (G1.. high, L1.. low; ``find_all_geometries``), and the
outputs carry the kind wherever it matters (geometry rows, nested pairs, stacks, assignments, the share profiles,
patch summaries, the association's flank shares and the co-occurrence rows). The ``nucpatch`` layer's geometry
numbers count within each kind; flag bit 4 says which.

Parameters are per dataset (session state) and per file for the layer (``path_params``); changing them only selects
other cache entries. Which parameters the lanes show (``regularity.adopt_lane``): an analysis always computes with
the request's own parameters (resolved once at the start); when it finishes, its panel's regularity and patch
settings become the dataset's lane parameters together, only when that panel (``requestScope``) changed them since
its last request (or on its first), or none are chosen yet. A panel re-asking with unchanged settings never takes the
lanes from another panel; cluster views (``requestScope`` 'cluster:...') and hub replays never move them. The layer's
geometry numbers come from the last analysis made with the lane parameters (a cached response restores them); labels
and rows carry the patch generation they belong to (``generation``, ``pg``).

A lifted dataset's linear observation is projected into the target view first (``frames.view_frame``: its records'
envelopes, tiles and patches through the view's primary lift pieces), so its haplotypes, and lifted and native
datasets, pool in the main genome's frame. Pooling is per chromosome and reference frame (``frame_of``):
observations on different chromosomes, or in different frames (a graph observation on a haplotype path), never pool
into one geometry; each part's molecules are
grouped on their own, and a molecule in another part never spans a geometry. The profiles and the association are
drawn over the main window (the part with the widest windows).

Hub. The panel's geometries are a feature-hub set (``nuc.geometry``, the scan's type, hit ids
``geometry:<start>-<end>`` / ``geometry-low:<start>-<end>`` as the scan writes them). Their per-record states
(``geometry_record_states``, for Cluster / Sort / Filter and the hub's association) are FiberHMM's
``assign_states`` mapped as the scan maps them (``SCAN_STATE``: carries 1; partly or absent 0; no call or not
spanned '.'), from the same cached analysis the panel shows.
"""
from __future__ import annotations

import json
import math
import threading
from collections import OrderedDict
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from functools import lru_cache

from .inputs import real as _real_path
from .store import STORE


@lru_cache(maxsize=256)
def real(path: str) -> str:
    """The resolved path (cached: called once per record per request)."""
    return _real_path(path)

_LOCK = threading.RLock()
MAX_GRIDS, MAX_PATCHES, MAX_RESPONSES = 120_000, 240_000, 12
#: per record, keyed by the decode configuration too (``regularity.config_key``: the density and the tiles come
#: from the decoded m6A calls)
_GRIDS: "OrderedDict[tuple, dict]" = OrderedDict()        # (rp, config, sha, occ, reg8) -> track + molecule bits
_PATCHES: "OrderedDict[tuple, object]" = OrderedDict()    # (rp, config, sha, occ, reg8, patch8) -> MoleculePatches
_RESPONSES: "OrderedDict[str, dict]" = OrderedDict()
_STATES: "OrderedDict[str, dict]" = OrderedDict()          # response key -> geometryId -> {(ds, key): state}
_LABELS: "OrderedDict[str, dict]" = OrderedDict()          # response key -> rp -> (ident, labels) (see _GEO_OF)
_EPOCH = [0]                                             # moved by clear (tests)
#: rp -> content digest of its ``_GEO_OF`` entry: the nucpatch layer's geometry labels, delivered to the read lanes as
#: an overlay (``patch_labels``), so a relabel (fold, tolerance, another geometry answer) never reloads the reads
_LABEL_ID: Dict[str, str] = {}
_PATH_PARAMS: Dict[str, dict] = {}                       # real path -> {'patch': PatchParams, 'ref': float|None}
#: rp -> (ident, {(sha, occ) -> {patch idx -> (geo, root)}}): the nucpatch layer's geometry numbers from the last
#: analysis made with the file's lane parameters; ``ident`` = that analysis' patch generation (``generation``: decode
#: configuration, regularity digest8, patch key), so the layer only shows numbers of patches called from the same
#: evidence with the parameters it calls them with.
_GEO_OF: Dict[str, Tuple[str, Dict[tuple, Dict[int, Tuple[int, int]]]]] = {}
#: (rp, panel reference choice, regularity digest) -> the resolved reference ({'median', 'widths', 'source'})
_RESOLVED: Dict[tuple, dict] = {}
MAX_RESOLVED = 512

#: panel defaults that are not FiberHMM dataclass fields
VIEW_DEFAULTS = dict(stack_per_geometry=40, profile_min_molecules=8, share_min_molecules=10,
                     site_open_bp=300, site_nuc_min_bp=90, site_min_share=0.08, site_min_gap_bp=1000,
                     site_max=8, flank_near_bp=1000, flank_far_bp=3000, tf_window_bp=100, carriers='full')
QUALITY_NAMES = ['score', 'period', 'flags', 'geometry', 'root', 'patch']


# ------------------------------------------------------------------ parameters
def parse_params(raw: Optional[dict]):
    """(PatchParams, GeometryParams, view options) from the panel's patch settings (FiberHMM field names; ``edges``
    'grid' turns snapping and snapped grouping off together)."""
    from fiberhmm.nuc.geometries import GeometryParams
    from fiberhmm.nuc.patches import PatchParams
    if raw is not None and not isinstance(raw, dict):
        raise ValueError('patch parameters must be an object')
    raw = dict(raw or {})
    pk = {f for f in PatchParams.__dataclass_fields__}
    gk = {f for f in GeometryParams.__dataclass_fields__}
    p = {k: raw[k] for k in pk if k in raw and raw[k] is not None}
    g = {k: raw[k] for k in gk if k in raw and raw[k] is not None}
    edges = raw.get('edges')
    if edges is not None:
        if edges not in ('grid', 'snap'):
            raise ValueError("edges must be 'grid' or 'snap'")
        p['snap'] = g['snapped'] = edges == 'snap'
    for key in ('min_tiles', 'nuc_min_bp', 'search_bp', 'merged_bp', 'core_bp', 'open_bp'):
        if key in p:
            p[key] = int(p[key])
    for key in ('enter', 'extend', 'tol_frac'):
        if key in p:
            p[key] = float(p[key])
    for key in ('tol_bp', 'min_molecules', 'near_max_bp', 'edge_min_bp'):
        if key in g:
            g[key] = int(g[key])
    if 'min_share' in g:
        g['min_share'] = float(g['min_share'])
    if g.get('max_geometries') in (0, ''):
        g['max_geometries'] = None
    dp = PatchParams()
    if p.get('extend', dp.extend) > p.get('enter', dp.enter):
        p['extend'] = p.get('enter', dp.enter)   # the prototype's rule: extend never above enter (either one given)
    low = raw.get('low')
    if low is not None:
        if not isinstance(low, dict):
            raise ValueError('low patch parameters must be an object or null')
        from fiberhmm.nuc.patches import LowPatchParams
        lk = {f for f in LowPatchParams.__dataclass_fields__} - {'low'}
        lo = {k: low[k] for k in lk if k in low and low[k] is not None}
        if low.get('edges') is not None:
            if low['edges'] not in ('grid', 'snap'):
                raise ValueError("low edges must be 'grid' or 'snap'")
            lo['snap'] = low['edges'] == 'snap'
        for key in ('min_tiles', 'nuc_min_bp', 'search_bp', 'merged_bp', 'core_bp', 'open_bp'):
            if key in lo:
                lo[key] = int(lo[key])
        for key in ('enter', 'extend', 'tol_frac'):
            if key in lo:
                lo[key] = float(lo[key])
        dl = LowPatchParams()
        enter, extend = lo.get('enter', dl.enter), lo.get('extend', dl.extend)
        if extend < enter:
            lo['extend'] = extend = enter      # mirrored: extend never below enter
        high_extend = p.get('extend', PatchParams().extend)
        if extend >= high_extend:              # the kinds never overlap
            lo['extend'] = round(high_extend - 0.05, 4)
            lo['enter'] = min(enter, lo['extend'])
        p['low'] = lo
    else:
        p.pop('low', None)
    view = dict(VIEW_DEFAULTS)
    for k in VIEW_DEFAULTS:
        if k in raw and raw[k] is not None:
            view[k] = type(VIEW_DEFAULTS[k])(raw[k])
    if view['carriers'] not in ('full', 'any'):
        raise ValueError("carriers must be 'full' or 'any'")
    try:
        return PatchParams.from_dict(p), GeometryParams.from_dict(g), view
    except (TypeError, ValueError) as error:
        raise ValueError(str(error)) from None


def _state(state) -> dict:
    with _LOCK:
        return state.__dict__.setdefault('nuc_geometry', {})


def set_dataset_params(state, dataset_id: str, patch, ref_override: Optional[float], paths=()) -> bool:
    """The dataset's patch parameters (and its files', for the ``nucpatch`` layer); True when they changed."""
    _state(state)[dataset_id] = dict(patch=patch, ref=ref_override)
    changed = False
    with _LOCK:
        for p in paths:
            rp = real(p)
            old = _PATH_PARAMS.get(rp)
            _PATH_PARAMS[rp] = dict(patch=patch, ref=ref_override)
            if old is None or old['patch'] != patch or old['ref'] != ref_override:
                changed = True          # rows carrying patches are rebuilt (revision)
    return changed


def _dataset_label(state, dataset_id: str) -> str:
    ds = (getattr(state, 'datasets', None) or {}).get(dataset_id)
    return str(getattr(ds, 'label', None) or dataset_id)


def chosen(state, dataset_id: str) -> Optional[dict]:
    """The dataset's patch settings chosen in this server session ({'patch', 'ref'}), or None."""
    return _state(state).get(dataset_id)


def path_params(path: str) -> dict:
    from fiberhmm.nuc.patches import DEFAULT_PATCHES
    with _LOCK:
        return _PATH_PARAMS.get(real(path)) or dict(patch=DEFAULT_PATCHES, ref=None)


def revision(path: str) -> str:
    """What read rows carrying the file's ``nucpatch`` lane are built from, as a content identity (the read caches'
    identity): the lane's patch parameters and reference choice, the regularity parameters and the reference the
    patches are called against. The geometry labels are not part of it: they reach the lanes as an overlay
    (``patch_labels``, ``labels_revision``)."""
    import hashlib
    from . import regularity as R
    reg = R.path_params(path)
    pp = path_params(path)
    got = file_reference(path, reg, compute=False)
    with _LOCK:
        epoch = _EPOCH[0]
    raw = json.dumps([pp['patch'].to_dict(), pp['ref'], R.digest8(reg), got, epoch], sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def labels_revision(path: str) -> str:
    """The content identity of the file's geometry labels as ``patch_labels`` gives them ('' without any: none, or
    found with other parameters than the lane's)."""
    rp = real(path)
    with _LOCK:
        geo, lid = _GEO_OF.get(rp), _LABEL_ID.get(rp, '')
    return lid if geo is not None and _labels_current(rp, geo[0]) else ''


def generation(config, d8: str, pk: str) -> str:
    """The patch-generation identity ``pg`` (FIX contract): a digest of what a file's patches are called from: the
    decode configuration of its molecules, the regularity parameters (digest8) and the patch key (the patch
    parameters with the reference median and per-width part they are read against, ``patch_key``). Every live
    nucpatch layer and every ``patch_labels`` file entry carries it; labels apply only to rows of the same ``pg``."""
    import hashlib
    raw = json.dumps([list(config) if config is not None else None, str(d8), str(pk)], default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def lane_generation(path: str) -> Optional[str]:
    """The ``pg`` of the file's lane patches now (its store configuration, lane regularity and patch parameters and
    reference), or None when the lane has no reference yet (no patches)."""
    from . import regularity as R
    reg = R.path_params(path)
    got = file_reference(path, reg, compute=False)
    if got is None:
        return None
    return generation(STORE.config_of(path), R.digest8(reg), patch_key(path_params(path)['patch'], got[0], got[1]))


def forget_paths(paths) -> None:
    """Drop the per-file bookkeeping (resolved references, geometry labels, reference registrations) of files no
    dataset reads any more (a removed dataset)."""
    from . import reference as REF
    want = {real(p) for p in paths if isinstance(p, str) and '://' not in p}
    with _LOCK:
        for k in [k for k in _RESOLVED if k[0] in want]:
            _RESOLVED.pop(k, None)
        for rp in want:
            _GEO_OF.pop(rp, None)
            _LABEL_ID.pop(rp, None)
    REF.forget_paths(list(want))


def clear() -> None:
    """Drop every cache (tests)."""
    with _LOCK:
        _GRIDS.clear(); _PATCHES.clear(); _RESPONSES.clear(); _STATES.clear(); _LABELS.clear(); _GEO_OF.clear()
        _PATH_PARAMS.clear(); _RESOLVED.clear(); _LABEL_ID.clear()
        _EPOCH[0] += 1


# ------------------------------------------------------------------ per record
class LightMol:
    """What projection needs from a decoded molecule (aligned blocks, length, strand), without its per-base arrays."""
    __slots__ = ('blocks', 'length', 'is_reverse', 'name')

    def __init__(self, mol):
        self.blocks = None if mol.blocks is None else np.asarray(mol.blocks).copy()
        self.length = int(mol.length)
        self.is_reverse = bool(getattr(mol, 'is_reverse', False))
        self.name = str(getattr(mol, 'name', ''))

    def mol_interval_to_ref(self, start, end):
        from fiberhmm.nuc.records import NucMolecule
        return NucMolecule.mol_interval_to_ref(self, start, end)


def _grid_entry(mol, marks, reg, scores=None) -> dict:
    """The record's rebuilt track and the molecule bits patch calling, projection and site states need. ``scores``:
    the track's float scores when the browser computed the tiles (patches then equal the scan's exactly); without
    them (an annotated BAM's tags) the tiles' byte-resolution scores."""
    from fiberhmm.nuc.regularity import open_mask, thinned_hits, track_from_rows
    thin = reg.thin_per_kb if reg.signal == 'm6a' else None
    _h, _t, density = thinned_hits(mol, thin, open_mask(mol, reg.mask_open_bp))
    rows = [m for m in marks if m[4]]
    track = track_from_rows(mol.length, [(int(m[0]), int(m[1])) for m in rows], [m[4] for m in rows], reg,
                            density_per_kb=density)
    exact = False
    if scores is not None and len(scores) == len(track.score) and \
            np.array_equal(np.isfinite(scores), np.isfinite(track.score)):
        track.score = np.asarray(scores, dtype=float).copy()
        exact = True
    light = LightMol(mol)
    # Reference envelopes of the whole tile grid, once (layouts clip them per view).
    from .regularity import mol_envelopes
    env = mol_envelopes(light, track.tile_starts, track.tile_ends)
    return dict(track=track, mol=light, nucs=np.asarray(mol.nucs, dtype=np.int64).reshape(-1, 2).copy(),
                tfs=np.asarray(getattr(mol, 'tfs', np.zeros((0, 2))), dtype=np.int64).reshape(-1, 2).copy(),
                env=env, density=float(density), exact=exact)


def _put(cache, key, value, cap):
    with _LOCK:
        cache[key] = value
        while len(cache) > cap:
            cache.popitem(last=False)


def _get(cache, key):
    with _LOCK:
        hit = cache.get(key)
        if hit is not None:
            cache.move_to_end(key)
        return hit


def grids(path: str, cfg, rows, keys, reg, *, decode: bool = True, cancel=None) -> Dict[Tuple[str, int], dict]:
    """Grid entries of ``keys`` (tiles computed on demand for the regularity parameters). ``cancel``: a checkpoint."""
    from . import regularity as R
    rp, d8 = real(path), R.digest8(reg)
    config = R.config_key(path, cfg)
    out, need = {}, []
    for k in keys:
        hit = _get(_GRIDS, (rp, config, k[0], k[1], d8))
        # a grid built from the tiles' byte scores is rebuilt once the exact scores are there (patches equal the
        # scan's on the exact track)
        if hit is not None and (hit.get('exact') or R.cached_scores(path, k[0], k[1], d8, config) is None):
            out[k] = hit
        else:
            need.append(k)
    if not need:
        return out
    # tiles added here count as added for these parameters (revision), whichever request computes them first
    R.ensure(path, cfg, rows, [k for k in need if R.tiles_of(path, k, rows[k], reg, config) is None], reg,
             cancel=cancel)
    R._check(cancel)
    mols = R.molecules(path, cfg, rows, need, decode=decode)
    for n, k in enumerate(need):
        if n % 256 == 255:
            R._check(cancel)
        marks = R.tiles_of(path, k, rows[k], reg, config) if k in rows else None
        if marks is None or k not in mols:
            continue
        e = _grid_entry(mols[k][0], marks, reg, R.cached_scores(path, k[0], k[1], d8, config))
        _put(_GRIDS, (rp, config, k[0], k[1], d8), e, MAX_GRIDS)
        out[k] = e
    return out


def patch_key(patch, ref: float, widths: Optional[dict] = None) -> str:
    return patch.digest(ref, widths)[:12] if widths else patch.digest(ref)[:12]


def patches_of(path: str, key, entry: dict, reg, patch, ref: float, *, d8: Optional[str] = None,
               pk: Optional[str] = None, config=None, widths: Optional[dict] = None):
    """A record's patches (cached per record, decode configuration, regularity and patch parameters and reference;
    ``widths``: the reference's per-width deltas, ends 'truncated'; ``config`` None: the store's current
    configuration of the file)."""
    from fiberhmm.nuc.patches import call_patches
    from . import regularity as R
    config = STORE.config_of(path) if config is None else config
    ck = (real(path), config, key[0], key[1], d8 or R.digest8(reg), pk or patch_key(patch, ref, widths),
          bool(entry.get('exact')))
    hit = _get(_PATCHES, ck)
    if hit is None:
        kw = {'ref_widths': widths} if widths else {}
        hit = call_patches(entry['track'], entry['nucs'], ref_median=float(ref), params=patch, **kw)
        _put(_PATCHES, ck, hit, MAX_PATCHES)
    return hit


def _layout(entry: dict, mp, dataset: str, snapped: bool, view, uid: str, snapped_low: Optional[bool] = None,
            rf=None, tile_ref=None):
    """``fiberhmm.nuc.geometries.molecule_layout`` from the cached grid envelopes (same projection and clipping),
    plus each kept tile's score. ``rf`` (``frames.RecordFrame``): a lifted record's envelopes and patches are
    projected into the target view first (a reversed piece swaps the patches' open ends). ``tile_ref``: the
    per-tile reference (FiberHMM ``tile_reference`` of the track's window widths, ends 'truncated'): the third
    value is then each kept tile's reference, else None."""
    from fiberhmm.nuc.geometries import MoleculeLayout, RefPatch
    from fiberhmm.nuc.patches import patch_ref_interval
    track, mol = entry['track'], entry['mol']
    per_tile = tile_ref is not None and not np.isscalar(tile_ref)
    lo, hi, st, sc, rt = [], [], [], [], []
    for i, env in enumerate(entry['env']):
        if env is not None and rf is not None:
            env = rf.interval(*env)
        if env is None:
            continue
        a, b = env
        if view is not None:
            a, b = max(a, view[0]), min(b, view[1])
            if b <= a:
                continue
        lo.append(a); hi.append(b); st.append(int(mp.tile_state[i])); sc.append(float(track.score[i]))
        if per_tile:
            rt.append(float(tile_ref[i]))
    order = np.argsort(np.asarray(lo, dtype=np.int64), kind='stable')
    lo = np.asarray(lo, dtype=np.int64)[order]
    hi = np.asarray(hi, dtype=np.int64)[order]
    st = np.asarray(st, dtype=np.int8)[order]
    sc = np.asarray(sc, dtype=float)[order]
    rt = np.asarray(rt, dtype=float)[order] if per_tile else None
    pts = []
    kept = [p for p in mp.patches if p.end > p.start]      # the nucpatch rows' order (patch_rows)
    for k, p in enumerate(kept):
        # low patches are grouped by the edges they are drawn with (their own snap setting)
        r = patch_ref_interval(mol, p, snapped if (p.kind != 'low' or snapped_low is None) else snapped_low)
        if r is None:
            continue
        a, b, ol, orr = r
        cl = cr = False
        if rf is not None:
            t = rf.interval(a, b)
            if t is None:
                continue
            # an end in an unlifted stretch (inside an insertion, past the lifted pieces) has no target position:
            # cut there, open, as a view edge cuts it (never a closed end at the piece edge)
            hl, hr = rf.hidden_ends(a, b)
            ol, orr, cl, cr = ol or hl, orr or hr, hl, hr
            a, b = t
            if rf.reverse:
                ol, orr, cl, cr = orr, ol, cr, cl
        if view is not None:
            if b <= view[0] or a >= view[1]:
                continue
            if a < view[0]:
                a, ol, cl = view[0], True, True
            if b > view[1]:
                b, orr, cr = view[1], True, True
        pts.append((RefPatch(a, b, bool(ol), bool(orr), p.mean_score, p.period, p.kind, cl, cr), k))
    pts.sort(key=lambda x: (x[0].start, x[0].end))
    lay = MoleculeLayout(uid, dataset, [x[0] for x in pts], lo, hi, st, float(entry['density']))
    lay.meta['row'] = [x[1] for x in pts]          # layout patch -> nucpatch row index
    return lay, sc, rt


# ------------------------------------------------------------------ the nucpatch layer
def reference_median(path: str, reg, *, compute: bool, cfg=None) -> Optional[float]:
    r = file_reference(path, reg, compute=compute, cfg=cfg)
    return None if r is None else r[0]


def file_reference(path: str, reg, *, compute: bool, cfg=None) -> Optional[Tuple[float, Optional[dict]]]:
    """(median, per-width deltas) the file's patches are read against: the panel's choice for its dataset, else
    the dataset's reference (the one the geometry analysis used). ``compute`` never computes on this thread for a
    read load: it starts the dataset's reference in the background (the patches lane is empty until it is ready)."""
    from . import reference as REF
    from . import regularity as R
    d8 = R.digest8(reg)
    pp = path_params(path)
    computed = R.reference_for_path(path, d8)
    if computed is None and compute:
        REF.request_background(path, d8)
    raw = pp.get('ref')
    if raw is not None:
        with _LOCK:
            got = _RESOLVED.get((real(path), str(raw), d8))
        if got is not None:
            return float(got['median']), got.get('widths')
        if not isinstance(raw, str):
            return float(raw), REF.widths_of(computed)
        return None
    if computed is None or computed.get('median') is None:
        with _LOCK:
            got = _RESOLVED.get((real(path), 'None', d8))      # a bound scan's, adopted without a choice
        return (float(got['median']), got.get('widths')) if got is not None else None
    return float(computed['median']), REF.widths_of(computed)


def marks_for_row(path: str, sha: str, occ: int, out, *, compute: bool,
                  generation_out: Optional[list] = None) -> Optional[list]:
    """A record's ``nucpatch`` marks (mol_start, mol_len, ref_start, ref_end, q, AN) for the file's parameters:
    q = [score, period, flags, geometry, root, patch] (geometry / root: 1-based numbers of the last geometry analysis
    with these parameters, 0 = none; patch: the patch's 1-based index in the record, what ``patch_labels`` names). Only with ``compute`` (a load that names the layer); never decodes a BAM."""
    from fiberhmm.nuc.patches import patch_rows
    from . import regularity as R
    if not compute:
        return None
    reg = R.path_params(path)
    got = file_reference(path, reg, compute=True)
    if got is None:
        return None
    ref, widths = got
    k = (str(sha), int(occ))
    rp, d8 = real(path), R.digest8(reg)
    config = STORE.config_of(path)
    entry = _get(_GRIDS, (rp, config, k[0], k[1], d8))
    if entry is not None and not entry.get('exact') and R.cached_scores(path, k[0], k[1], d8, config) is not None:
        entry = None           # built from byte scores before the exact ones were there
    if entry is None:
        marks0 = R.tiles_for_row(path, k[0], k[1], out, reg, compute=True)   # the store's decode only
        hit = STORE.get_result(path, k[0], k[1], config) if config is not None and marks0 is not None else None
        if hit is None:
            return None
        entry = _grid_entry(hit[0], marks0, reg, R.cached_scores(path, k[0], k[1], d8, config))
        _put(_GRIDS, (rp, config, k[0], k[1], d8), entry, MAX_GRIDS)
    patch = path_params(path)['patch']
    pk = patch_key(patch, ref, widths)
    mp = patches_of(path, k, entry, reg, patch, ref, d8=d8, pk=pk, config=config, widths=widths)
    pg = generation(config, d8, pk)
    if generation_out is not None:
        generation_out.append(pg)
    with _LOCK:
        geo = _GEO_OF.get(rp)
    labels = geo[1].get(k, {}) if geo is not None and geo[0] == pg else {}
    marks = []
    for k, (p, (s, n, q)) in enumerate(zip([p for p in mp.patches if p.end > p.start], patch_rows(mp))):
        env = entry['mol'].mol_interval_to_ref(int(s), int(s) + int(n))
        if env is None:
            continue
        g, root = labels.get(k, (0, 0))
        if entry['mol'].is_reverse:          # the flags' start/end bits in reference orientation, as the lanes read them
            from .layers import flip_patch_flags
            q = [q[0], q[1], flip_patch_flags(q[2])]
        marks.append((int(s), int(n), int(env[0]), int(env[1]),
                      tuple(int(x) for x in q) + (int(g), int(root), k + 1), f'nucpatch@{mp.params_digest}_{k}'))
    return marks


def layer_payload(marks, region_start: int, region_end: int, *, include_qualities: bool = True,
                  include_calls: bool = False) -> Optional[dict]:
    from .layers import layer_payload as _lp
    return _lp('nucpatch', marks, region_start, region_end, include_qualities=include_qualities,
               include_calls=include_calls)


# ------------------------------------------------------------------ analysis helpers
def _num(v, digits: int = 4):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, digits) if math.isfinite(f) else None


def _median(vs):
    vs = [v for v in vs if v is not None and math.isfinite(v)]
    return float(np.median(vs)) if vs else None


def _open_stretches(nucs: np.ndarray, open_bp: int, nuc_min_bp: int, mol) -> List[Tuple[int, int]]:
    """Reference spans of the molecule's open stretches: at least ``open_bp`` between nucleosome-sized calls."""
    if not len(nucs):
        return []
    big = nucs[(nucs[:, 1] - nucs[:, 0]) >= nuc_min_bp]
    big = big[np.argsort(big[:, 0], kind='stable')]
    out = []
    for i in range(len(big) - 1):
        a, b = int(big[i, 1]), int(big[i + 1, 0])
        if b - a >= open_bp:
            env = mol.mol_interval_to_ref(a, b)
            if env is not None:
                out.append(env)
    return out


def _in_frame(spans, rf) -> List[Tuple[int, int]]:
    """Reference spans in the view's frame (``frames.RecordFrame``; as they are without one)."""
    if rf is None:
        return spans
    out = [rf.interval(a, b) for a, b in spans]
    return sorted(s for s in out if s is not None)


def _tf_spans(tfs: np.ndarray, mol) -> List[Tuple[int, int]]:
    out = []
    for a, b in tfs:
        env = mol.mol_interval_to_ref(int(a), int(b))
        if env is not None:
            out.append(env)
    return out


def _sites(opens: Sequence[List[Tuple[int, int]]], window, view: dict) -> List[dict]:
    """Positions open on many molecules (the prototype's nfrSites): local maxima of the pooled open share on a 50 bp
    grid, at least ``site_min_share``, at least ``site_min_gap_bp`` apart, at most ``site_max``."""
    _c, w0, w1 = window
    B = 50
    xs = np.arange(w0, w1 + 1, B)
    fr = np.zeros(len(xs))
    for spans in opens:
        for a, b in spans:
            i0 = max(0, int(math.ceil((a - w0) / B)))
            i1 = min(len(xs) - 1, int((b - w0) // B))
            if i1 >= i0:
                fr[i0:i1 + 1] += 1
    fr /= max(1, len(opens))
    cand = []
    for i in range(len(xs)):
        if fr[i] < view['site_min_share']:
            continue
        lo, hi = max(0, i - 10), min(len(xs) - 1, i + 10)
        nb = fr[lo:hi + 1]
        if (nb > fr[i]).any() or any(fr[q] == fr[i] and q < i for q in range(lo, i)):
            continue
        cand.append(dict(pos=int(xs[i]), share=float(fr[i])))
    out = []
    for s in sorted(cand, key=lambda s: -s['share']):
        if len(out) < view['site_max'] and all(abs(t['pos'] - s['pos']) >= view['site_min_gap_bp'] for t in out):
            out.append(s)
    return sorted(out, key=lambda s: s['pos'])


# ------------------------------------------------------------------ the analysis
def geometry_analysis(state, observations: Sequence[dict], *, patch_params: Optional[dict] = None,
                      reg_params: Optional[dict] = None, ref_override: Optional[dict] = None, spanning: bool = False,
                      include_duplicates: bool = False, include_qcfail: bool = False, site: Optional[int] = None, site_state: str = 'nfr',
                      show: str = 'patch', apply_params: bool = True, request_scope: Optional[str] = None,
                      cancel=None, _key_out: Optional[list] = None,
                      cohort: Optional[str] = None, adopt: bool = True, _attempt: int = 0) -> dict:
    """The Regularity view's patch section (module docstring). Cached per request and stored outputs.

    The request's own parameters (patch, regularity, reference override; without regularity parameters the
    dataset's current ones) are resolved once and used throughout. When the analysis finishes they may become the
    datasets' lane parameters (module docstring: which parameters the lanes show; ``regularity.adopt_lane``), and
    its geometry numbers label the lanes where its parameters are the lanes'. ``apply_params=False`` (the hub's
    states replaying a panel's request), a cluster view's request (``regularity.NON_ADOPTING_SCOPES``) and
    ``adopt=False`` compute with their own parameters like any other request but never change a dataset's
    parameters nor relabel its lanes. ``cancel``: a checkpoint (callable raising InterruptedError, or an Event); a
    cancelled analysis caches nothing and changes no parameters or layer labels."""
    import time
    from . import regularity as R
    from .inputs import browser_read_policy, nuc_source
    from .jobs import REGULARITY_LAYERS, active_config, config_identity, refresh_after
    from services.lift.reads import lift_identity
    from .frames import view_frame
    from .observations import ObservationError, observation_cohort, window_hull
    t0 = time.time()
    patch, gp, view = parse_params(patch_params)
    cohort_kind = R.resolve_cohort(cohort, spanning)
    spanning = cohort_kind == 'spanning'
    if site_state not in ('nfr', 'tf'):
        raise ValueError("site state must be 'nfr' or 'tf'")
    policy = browser_read_policy(state, include_duplicates=include_duplicates, include_qcfail=include_qcfail)
    ids = list(dict.fromkeys(str(o.get('datasetId') or '') for o in observations))
    sources = {}
    for ds_id in ids:
        try:
            sources[ds_id] = nuc_source(state, ds_id)
        except ValueError:
            continue
    reg_new = R.parse_params(reg_params) if reg_params is not None else None
    regs, ovs = {}, {}
    for ds_id, source in sources.items():
        ov = (ref_override or {}).get(ds_id) if isinstance(ref_override, dict) else None
        if ov in (None, ''):
            ov = None
        elif not (isinstance(ov, str) and ov.startswith('scan:')):
            ov = float(ov)                  # a median by hand; 'scan:<scanId>' adopts a bound scan's reference
        ovs[ds_id] = ov
        regs[ds_id] = reg_new if reg_new is not None else R.dataset_params(state, ds_id)
    paths = sorted({p for s in sources.values() for p in s.paths})
    # the bound scans (their rows and references feed the analysis), captured before any input is read: a scan
    # opened, closed or re-bound meanwhile makes the answer stale, so it is recomputed rather than published
    scans_before = R.bound_scans_identity(state, sources)
    # the lanes' tile revisions now: tiles this analysis adds for the lane parameters (``grids``) move them, and rows
    # cached without those tiles are dropped when it finishes (as a Regularity request does)
    before = {p: R.revision(p) for p in paths}
    # a replay (the hub's states) and a cluster view never move the lanes nor relabel them
    lanes = apply_params and R.adopting(request_scope, adopt)

    def adopt_step() -> bool:
        """The finished request's adoption step (``regularity.adopt_lane``: the panel's regularity and patch settings
        together); True when lane parameters changed."""
        changed = False
        if not lanes:
            return False
        for ds_id, source in sources.items():
            with R._LANE_LOCK:
                reg, pt = R.adopt_lane(state, ds_id, request_scope, reg=reg_new, patch=(patch, ovs[ds_id]))
                changed |= R.install_lane(state, ds_id, source, reg, pt)
        return changed

    def finish(stored_labels: dict) -> List[str]:
        """Adopt, then give the layer this analysis' geometry numbers where its parameters are the lane's and its
        panel is the one whose settings the lanes took last (``regularity.lane_owner``; or none took them yet): a
        panel re-asking with other geometry settings (fold, tolerance) never relabels another panel's lanes."""
        changed = adopt_step()
        relabelled = False
        if lanes:
            _take_labels_on_regroup(state, sources, request_scope, gp)
            mine = {real(p) for ds_id, s in sources.items()
                    if R.lane_owner(state, ds_id) in (None, str(request_scope or '')) for p in s.paths}
            relabelled = _apply_labels({rp: v for rp, v in stored_labels.items() if rp in mine})
        # A relabel reaches the lanes as an overlay (patch_labels: the datasets' label identity moves, their
        # regularity identity does not, so no read reloads); the server's cached rows are still dropped so rows it
        # builds next (and Filter/Sort terms on them) carry the new geometry bytes.
        tiles = any(R.revision(p) != before.get(p) for p in paths)
        return refresh_after(state, paths, REGULARITY_LAYERS) if changed or relabelled or tiles else []

    refs: Dict[str, Optional[float]] = {}
    ref_widths: Dict[str, Optional[dict]] = {}
    ref_sources: Dict[str, Optional[dict]] = {}
    scan_refs: Dict[str, list] = {}
    from . import reference as REF
    failed = R.prefetch_references(state, sources, lambda d: regs[d], cancel)
    for ds_id, source in sources.items():
        R._check(cancel)
        # One reference per dataset (all its files), the same one the nucpatch lane reads every file against.
        reg = regs[ds_id]
        cfg = active_config(state, ds_id)
        d8 = R.digest8(reg)
        if ds_id in failed:
            raise failed[ds_id]                     # computed once above; never a second failing decode
        computed = R.dataset_reference(source, reg, cfg)
        raw = ovs[ds_id]
        scan_refs[ds_id] = [dict(scanId=c['scanId'], label=c['label'], median=c['median'])
                            for c in REF.scan_references(state, source, d8)]
        try:
            chosen = REF.resolve_override(state, source, raw, d8, computed)
        except ValueError as error:
            raise ValueError(f'{_dataset_label(state, ds_id)}: {error}') from None
        if chosen is None and (not computed or computed.get('median') is None) and scan_refs[ds_id]:
            # no reference computed here (an opened scan or annotated BAM without an Analyse): the bound scan's
            c = REF.scan_references(state, source, d8)[0]
            chosen = dict(median=float(c['median']), widths=REF.widths_of(c['reference']),
                          source=dict(kind='scan', label=f'scan {c["label"]}', scanId=c['scanId'], dataset=c['dataset']))
        if chosen is not None:
            refs[ds_id], ref_widths[ds_id] = chosen['median'], chosen['widths']
            ref_sources[ds_id] = dict(chosen['source'], median=_num(chosen['median']))
            with _LOCK:
                for p in source.paths:
                    _RESOLVED[(real(p), str(raw), d8)] = chosen
                while len(_RESOLVED) > MAX_RESOLVED:
                    _RESOLVED.pop(next(iter(_RESOLVED)))
        else:
            refs[ds_id] = None if not computed or computed.get('median') is None else float(computed['median'])
            ref_widths[ds_id] = REF.widths_of(computed)
            ref_sources[ds_id] = R.reference_source(computed)
    t_ref = time.time()

    def key_now() -> str:
        # built after the references (computing one moves the file's revision): the key a repeat request builds
        return json.dumps([observations, patch.to_dict(), gp.to_dict(), view, ref_override, cohort_kind,
                           include_duplicates, include_qcfail, policy['filters'].get('uncalled'), site, site_state, show, {d: R.digest8(regs[d]) for d in sources},
                           refs, [list(map(str, t)) for t in STORE.token(paths)],
                           {d: [R.content_revision(p, regs[d]) for p in s.paths] for d, s in sources.items()},
                           {d: config_identity(active_config(state, d)) for d in sources},
                           {d: lift_identity(state.datasets.get(d)) for d in sources},
                           R.bound_scans_identity(state, sources)], sort_keys=True, default=str)
    key = key_now()
    with _LOCK:
        hit = _RESPONSES.get(key)
        hit_states = _STATES.get(key)
        hit_labels = _LABELS.get(key)
    if hit is not None and hit_states is not None and hit_labels is not None:
        if _key_out is not None:
            _key_out.append(key)
        return {**hit, 'updatedDatasets': sorted(set(finish(hit_labels))), 'cached': True}
    # ---- cohorts -> layouts (one per physical record and chromosome; observations may share a dataset, datasets
    # may share a file: every (dataset, read) alias of a record is kept for its states)
    lays, scores, metas, lay_chrom = [], [], [], []      # lay_chrom: each layout's (chrom, frame) part
    obs_index: Dict[str, List[int]] = {}
    seen: Dict[tuple, int] = {}
    windows = []
    errors = {}
    # Pass 1: each observation's cohort, window and part. Pass 2 builds every record's layout over its part's pooled
    # window (the hull of the part's observation windows), so a record seen by two observations gets one layout
    # whatever their order, and every geometry of the part is measured on it.
    plans = []
    for obs in observations:
        R._check(cancel)
        oid = str(obs.get('obsId'))
        ds_id = str(obs.get('datasetId') or '')
        obs_index[oid] = []
        if ds_id not in sources or refs.get(ds_id) is None:
            why = (ref_sources.get(ds_id) or {}).get('reason')
            errors[oid] = f'No usable regularity reference: {why}' if why else \
                'No regularity reference yet: run Analyse first'
            continue
        try:
            source, recs, wins, cfg, cohort, counts = observation_cohort(state, obs, policy, quick=True)
        except (ObservationError, ValueError) as error:
            errors[oid] = str(error)
            continue
        # Geometry support counts molecules by their primary record, as fiberhmm-scan does (it skips supplementary
        # records): a molecule seen here only through a supplementary record is not in the geometry cohort.
        cohort = [(r, row) for r, row in cohort if not getattr(r, 'supplementary', False)]
        if spanning:
            cohort = [(r, row) for r, row in cohort if R._spanning(r, wins, row.chrom)]
        win = window_hull(wins)
        target, frame = view_frame(state, source, obs)
        if frame is not None:
            win = target            # a lifted linear view: records projected into the target view
        if win is None:
            continue
        part = (win[0], None if frame is not None else frame_of(state, ds_id))
        windows.append((part, win[1], win[2]))
        plans.append((oid, ds_id, cfg, cohort, frame, part, (counts or {}).get('aliases') or {}))
    hull: Dict[tuple, Tuple[int, int]] = {}
    for part, a, b in windows:
        h = hull.get(part)
        hull[part] = (a, b) if h is None else (min(h[0], a), max(h[1], b))
    for oid, ds_id, cfg, cohort, frame, part, mol_aliases in plans:
        R._check(cancel)
        pview = hull[part]
        reg = regs[ds_id]
        ref, widths = refs[ds_id], ref_widths.get(ds_id)
        d8, pk = R.digest8(reg), patch_key(patch, ref, widths)
        by_path: Dict[str, list] = {}
        for r, row in cohort:
            by_path.setdefault(r.path, []).append((r, row))
        for path, items in by_path.items():
            rows = {(r.sha, r.occ): row for r, row in items}
            got = grids(path, cfg, rows, list(rows), reg, cancel=cancel)
            config = R.config_key(path, cfg)
            pg = generation(config, d8, pk)
            for r, row in items:
                k = (r.sha, r.occ)
                rf = frame.record(row.chrom, row.ref_start, row.ref_end) if frame is not None else None
                if frame is not None and rf is None:
                    continue            # no primary piece of the view holds it, or mixed orientations
                ident = (part, real(path), r.sha, r.occ)
                # every (dataset, read) alias of the record, and of the molecule's other records (other QNAMEs of
                # one physical molecule, mol:v1): each gets the record's states
                new_aliases = [dict(ds=ds_id, path=path, key=k, qname=r.qname)] + \
                    [dict(ds=ds_id, path=o.path, key=(o.sha, o.occ), qname=o.qname)
                     for o in mol_aliases.get((r.path, r.sha, r.occ), ())]
                if ident in seen:
                    li = seen[ident]
                    obs_index[oid].append(li)
                    for alias in new_aliases:
                        if not any(a['ds'] == alias['ds'] and a['key'] == alias['key']
                                   and real(a['path']) == real(alias['path']) for a in metas[li]['aliases']):
                            metas[li]['aliases'].append(alias)
                    continue
                e = got.get(k)
                if e is None:
                    continue
                mp = patches_of(path, k, e, reg, patch, ref, d8=d8, pk=pk, config=config, widths=widths)
                tw = e['track'].window_widths if widths else None
                tile_ref = None
                if tw is not None:
                    from fiberhmm.nuc.regularity import tile_reference
                    tile_ref = tile_reference(tw, ref, widths)
                lay, sc, rt = _layout(e, mp, ds_id, gp.snapped, pview, f'{ds_id}|{r.qname}|{r.sha}|{r.occ}',
                                      snapped_low=patch.low.snap if patch.low is not None else None, rf=rf,
                                      tile_ref=tile_ref)
                if not len(lay.tile_lo):
                    continue
                seen[ident] = len(lays)
                obs_index[oid].append(len(lays))
                lays.append(lay)
                lay_chrom.append(part)
                # each tile's excess over the reference at its own window width (ends 'truncated'), else the median
                scores.append(sc - rt if rt is not None else sc - ref)
                metas.append(dict(path=path, key=k, qname=r.qname, ds=ds_id, entry=e, mp=mp, ref=ref, d8=d8, pk=pk,
                                  pg=pg, aliases=new_aliases, rf=rf))
    t_lay = time.time()
    R._check(cancel)
    from fiberhmm.nuc.geometries import CARRIES, PARTIAL, density_matched_shares, nested_pairs, support
    G, states, gchrom = pooled_geometries(lays, lay_chrom, gp, patch.kinds)
    t_geo = time.time()
    num = _numbers(G)
    # which patch of each record belongs to which geometry (numbers within its kind), for the layer's colours
    labels: Dict[str, Dict[tuple, Dict[int, Tuple[int, int]]]] = {}
    # Every file of the request's datasets gets this analysis' patch generation (``generation``: its decode
    # configuration, the request's regularity, patch parameters and reference), even with no molecule in the answer
    # (all filtered out), so a later answer replaces earlier labels instead of leaving them on the lane.
    idents: Dict[str, str] = {}
    for ds_id, source in sources.items():
        if refs.get(ds_id) is None:
            continue
        cfg = active_config(state, ds_id)
        d8, pk = R.digest8(regs[ds_id]), patch_key(patch, refs[ds_id], ref_widths.get(ds_id))
        for p in source.paths:
            idents.setdefault(real(p), generation(R.config_key(p, cfg), d8, pk))
    for gi, g in enumerate(G):
        root = g.parent if g.parent is not None else gi
        for li, pk in g.members:
            m = metas[li]
            if idents.get(real(m['path'])) != m['pg']:
                continue                # a file shared with another dataset of other settings: its first dataset's
            mk = lays[li].meta['row'][pk]
            labels.setdefault(real(m['path']), {}).setdefault(m['key'], {})[mk] = (num[gi], num[root])
    stored_labels = {rp: (ident, labels.get(rp, {})) for rp, ident in idents.items()}
    main = _union_window(windows)                 # (part, start, end) of the widest part
    win = (main[0][0], main[1], main[2]) if main else None
    out = dict(window=dict(chrom=win[0], start=win[1], end=win[2]) if win else None,
               chromosomes=list(dict.fromkeys(p[0] for p in lay_chrom)),
               params=dict(patch=patch.to_dict(), geometry=gp.to_dict(), view=view, cohort=cohort_kind),
               references={d: _num(v) for d, v in refs.items()}, referenceSources=ref_sources,
               scanReferences=scan_refs, shareDefinitions=SHARE_DEFINITIONS, errors=errors,
               nMolecules=len(lays), nPatches=sum(len(l.patches) for l in lays),
               kinds=list(patch.kinds),
               nPatchesByKind={k: sum(1 for l in lays for q in l.patches if q.kind == k) for k in patch.kinds})
    out['geometries'] = _geometry_rows(G, lays, states, metas, observations, obs_index, sources, support,
                                       density_matched_shares, CARRIES, PARTIAL, [p[0] for p in gchrom])
    # nested pairs only within a part
    pairs = [z for z in nested_pairs(G, gp.tol_bp) if gchrom[z.child] == gchrom[z.parent]]
    out['nested'] = _nested_rows(G, pairs, lays, scores, states, gp, view, lay_chrom, gchrom)
    out['stack'] = _stack(G, lays, view)
    # the profiles and the association are drawn over the main window: its part's molecules and geometries
    Gv, lays_v, scores_v, states_v, metas_v, obs_v = _on_chromosome(main[0] if main else None, G, gchrom, lays,
                                                                    lay_chrom, scores, states, metas, obs_index)
    out['profiles'] = _profiles(Gv, lays_v, scores_v, states_v, observations, obs_v, win, view, R, CARRIES) if win else {}
    out['patchStats'] = _patch_stats(lays, observations, obs_index, patch.kinds)
    out['assignments'] = _assignments(G, metas, states, CARRIES, PARTIAL, alias_keys(state, metas), patch.kinds)
    record_states = _record_states(state, G, metas, states)
    t_out = time.time()
    R._check(cancel)
    if win:
        out['association'] = _association(Gv, lays_v, scores_v, states_v, metas_v, observations, obs_v, win, view,
                                          site, site_state, show, CARRIES, PARTIAL)
    t_assoc = time.time()
    out['timings'] = dict(reference=round(t_ref - t0, 3), layouts=round(t_lay - t_ref, 3),
                          geometries=round(t_geo - t_lay, 3), summaries=round(t_out - t_geo, 3),
                          association=round(t_assoc - t_out, 3), total=round(t_assoc - t0, 3))
    R._check(cancel)     # the last checkpoint: from here on the analysis is kept and applied
    if R.bound_scans_identity(state, sources) != scans_before:
        if _attempt < R.MAX_SCAN_RETRIES:
            return geometry_analysis(state, observations, patch_params=patch_params, reg_params=reg_params,
                                     ref_override=ref_override, spanning=spanning,
                                     include_duplicates=include_duplicates, include_qcfail=include_qcfail, site=site,
                                     site_state=site_state, show=show, apply_params=apply_params,
                                     request_scope=request_scope, cancel=cancel, _key_out=_key_out, cohort=cohort_kind,
                                     adopt=adopt, _attempt=_attempt + 1)
        raise ValueError('The open scans changed during the analysis; ask again')
    updated = finish(stored_labels)
    done_key = key_now()
    if _key_out is not None:
        _key_out.append(done_key)
    unchanged = R.bound_scans_identity(state, sources) == scans_before   # never cached under another scan set's key
    with _LOCK:
        if unchanged:
            _RESPONSES[done_key] = out
            _STATES[done_key] = record_states
            _LABELS[done_key] = stored_labels
        for cache in (_RESPONSES, _STATES, _LABELS):
            while len(cache) > MAX_RESPONSES:
                cache.popitem(last=False)
    return {**out, 'updatedDatasets': sorted(set(updated)), 'cached': False}


def _take_labels_on_regroup(state, sources, scope, gp) -> None:
    """A panel that changed its grouping settings (``GeometryParams``: fold, tolerance, shares) since its last
    request takes the lanes' labels (``regularity.lane_owner``), as a change of its regularity or patch settings takes
    the lanes; a re-ask with unchanged settings does not."""
    from . import regularity as R
    digest = json.dumps(gp.to_dict(), sort_keys=True, default=str)
    with R._LOCK:
        mem = R._lane_memory(state)
        for ds_id in sources:
            k = ('geometry', str(ds_id), str(scope or ''))
            prev = mem.get(k)
            mem[k] = digest
            if prev is not None and prev != digest:
                mem[('owner', str(ds_id))] = str(scope or '')


def _apply_labels(stored: dict) -> bool:
    """Give the nucpatch layer an analysis' geometry numbers for each file whose lane parameters (regularity digest,
    patch parameters, reference) are the ones the analysis called its patches with; True when any file's numbers
    changed (its label identity moves; the lanes take them from ``patch_labels``, the rows are not rebuilt)."""
    changed = False
    for rp, (ident, labels) in stored.items():
        if ident is None or ident != lane_generation(rp):
            continue
        with _LOCK:
            if _GEO_OF.get(rp) != (ident, labels):
                _GEO_OF[rp] = (ident, labels)
                _LABEL_ID[rp] = _labels_digest(ident, labels)
                changed = True
    return changed


def _labels_digest(ident, labels) -> str:
    import hashlib
    items = sorted((f'{k[0]}:{k[1]}', sorted((int(i), int(g), int(r)) for i, (g, r) in v.items()))
                   for k, v in labels.items() if v)
    return hashlib.sha256(json.dumps([ident, items], default=str).encode()).hexdigest()[:16]


@lru_cache(maxsize=256)
def file_tag(path: str) -> str:
    """A short tag of a file, the first part of its rows' patch label keys (``label_key``)."""
    import hashlib
    return hashlib.sha256(real(path).encode()).hexdigest()[:8]


def label_key(path: str, sha: str, occ: int) -> str:
    """The key a live record's ``nucpatch`` layer carries (``lk``) to find its geometry labels in ``patch_labels``."""
    return f'{file_tag(path)}:{str(sha)[:20]}:{int(occ)}'


def patch_labels(state, dataset_ids: Sequence[str]) -> dict:
    """The geometry labels of the datasets' live nucpatch rows (the read lanes' overlay, so a relabel never reloads
    the reads): per dataset, its files' tags, the labels' identity, ``pg`` = {file tag: the patch generation the
    labels are for (``generation``; '' without patches)} and per record key (``label_key``) the [patch index,
    geometry, root] of each patch in a geometry (1-based numbers within the kind, as the layer's geometry/root
    bytes). Records without labels are absent: their patches are in no geometry. A client applies a file's labels
    only to rows whose nucpatch layer carries the same ``pg`` (rows called with other settings keep their own)."""
    from .inputs import nuc_source
    out = {}
    for ds_id in dict.fromkeys(str(d) for d in dataset_ids):
        try:
            source = nuc_source(state, ds_id)
        except ValueError:
            continue
        from .store import patch_labels_identity
        files, labels, pgs = [], {}, {}
        identity = patch_labels_identity(state.datasets.get(ds_id)) if state.datasets.get(ds_id) is not None else ''
        for p in source.paths:
            rp = real(p)
            tag = file_tag(p)
            files.append(tag)
            pgs[tag] = lane_generation(p) or ''
            with _LOCK:
                geo = _GEO_OF.get(rp)
            if geo is None or not _labels_current(rp, geo[0]):
                continue
            for (sha, occ), per in geo[1].items():
                if per:
                    labels.setdefault(f'{tag}:{str(sha)[:20]}:{int(occ)}',
                                      [[int(i), int(g), int(r)] for i, (g, r) in sorted(per.items())])
        out[ds_id] = dict(files=files, identity=identity, labels=labels, pg=pgs)
    return out


def _labels_current(rp: str, ident) -> bool:
    """Whether labels found with patch generation ``ident`` (``generation``) are the ones of the file's lane
    patches (same decode configuration, regularity and patch parameters and reference)."""
    return ident is not None and ident == lane_generation(rp)


def frame_of(state, dataset_id: str):
    """The reference frame of an observation left in its records' coordinates: None for the main genome (native
    datasets), the lift map for a lifted dataset's graph observation (the haplotype's own path, on the map's source
    assembly). A lifted linear observation is projected into the main genome first (``frames.view_frame``)."""
    ds = (getattr(state, 'datasets', None) or {}).get(dataset_id)
    if getattr(ds, 'data_type', None) != 'bam_livelift':
        return None
    return str(getattr(getattr(ds, 'live_lift', None), 'manifest', None) or dataset_id)


def pooled_geometries(lays, parts: Sequence, gp, kinds):
    """FiberHMM's ``find_all_geometries`` / ``assign_states`` per part (a chromosome name, or a (chromosome, frame)
    pair, ``frame_of``): molecules of different parts never pool. Returns (geometries with global layout indices and
    parents, per-layout states over every geometry, each geometry's part). A molecule of another part is ``not
    spanned`` for a geometry (never callable). Geometry numbers run within each kind over all parts (G1.., L1..)."""
    import hashlib
    from fiberhmm.nuc.geometries import NOT_SPANNED, assign_states, find_all_geometries
    G, gchrom = [], []
    states: List[Dict[str, str]] = [dict() for _ in lays]
    for c in dict.fromkeys(parts):
        idx = [i for i, x in enumerate(parts) if x == c]
        sub = [lays[i] for i in idx]
        chrom, frame = c if isinstance(c, tuple) else (c, None)
        # the frame enters the geometry ids (the same contig name in two frames never gives one id)
        tag = str(chrom) if frame is None else f'{chrom}@{hashlib.sha256(str(frame).encode()).hexdigest()[:8]}'
        Gc = find_all_geometries(sub, gp, chrom=tag, kinds=kinds)
        for j, st in enumerate(assign_states(sub, Gc)):
            states[idx[j]].update(st)
        off = len(G)
        for g in Gc:
            g.members = [(idx[li], pk) for li, pk in g.members]
            if g.parent is not None:
                g.parent += off
        G += Gc
        gchrom += [c] * len(Gc)
    if len(set(gchrom)) > 1:
        # one numbering per kind across chromosomes (each chromosome's search numbers from 1)
        rename, seen = {}, {}
        for g in G:
            seen[g.kind] = seen.get(g.kind, 0) + 1
            new = f'{"G" if g.kind == "high" else "L"}{seen[g.kind]}_{g.geometry_id.split("_", 1)[1]}'
            rename[g.geometry_id], g.geometry_id = new, new
        for g in G:
            g.parent_id = G[g.parent].geometry_id if g.parent is not None else None
        states = [{rename.get(k, k): v for k, v in st.items()} for st in states]
    for st in states:
        for g in G:
            st.setdefault(g.geometry_id, NOT_SPANNED)
    return G, states, gchrom


def _on_chromosome(chrom, G, gchrom, lays, lay_chrom, scores, states, metas, obs_index):
    """The analysis restricted to one part's molecules and geometries (``chrom``: the part, as in ``lay_chrom``;
    indices renumbered), for the outputs drawn over one window; everything as it is when there is one part."""
    import dataclasses
    if chrom is None or all(c == chrom for c in lay_chrom):
        return G, lays, scores, states, metas, obs_index
    iv = [i for i, c in enumerate(lay_chrom) if c == chrom]
    pos = {i: j for j, i in enumerate(iv)}
    gv = [gi for gi, c in enumerate(gchrom) if c == chrom]
    gpos = {gi: j for j, gi in enumerate(gv)}
    Gv = [dataclasses.replace(G[gi], members=[(pos[li], pk) for li, pk in G[gi].members],
                              parent=gpos.get(G[gi].parent) if G[gi].parent is not None else None) for gi in gv]
    obs_v = {oid: [pos[i] for i in idx if i in pos] for oid, idx in obs_index.items()}
    return (Gv, [lays[i] for i in iv], [scores[i] for i in iv], [states[i] for i in iv], [metas[i] for i in iv],
            obs_v)


def _union_window(windows):
    if not windows:
        return None
    by: Dict[str, List[int]] = {}
    for c, a, b in windows:
        h = by.setdefault(c, [a, b, 0])
        h[0], h[1], h[2] = min(h[0], a), max(h[1], b), h[2] + (b - a)
    c, (a, b, _n) = max(by.items(), key=lambda kv: kv[1][2])
    return c, int(a), int(b)


def _numbers(G) -> List[int]:
    """1-based number of each geometry within its kind (G3 -> 3, L2 -> 2)."""
    seen: Dict[str, int] = {}
    out = []
    for g in G:
        seen[g.kind] = seen.get(g.kind, 0) + 1
        out.append(seen[g.kind])
    return out


def _label(g) -> str:
    return g.geometry_id.split('_', 1)[0]


def hit_id(g) -> str:
    """The hub hit id of a geometry, as fiberhmm-scan writes it (``fiberhmm.scan.modules.nuc``)."""
    return f'geometry:{int(g.start)}-{int(g.end)}' if g.kind == 'high' else f'geometry-low:{int(g.start)}-{int(g.end)}'


def hit_ids(G) -> List[str]:
    """``hit_id`` of each geometry, a second geometry of one kind with the same consensus span suffixed with its
    label (``geometry:<start>-<end>:G4``), as fiberhmm-scan keys them: every geometry keeps its own hit."""
    out, seen = [], set()
    for g in G:
        h = hit_id(g)
        if h in seen:
            h = f'{h}:{_label(g)}'
        seen.add(h)
        out.append(h)
    return out


def alias_keys(state, metas) -> List[List[Tuple[str, str]]]:
    """Per layout, the (dataset, read key) of each of its aliases: the read name, or the record key for live-lift
    datasets (``services.scan.states._Keyer``; what their rows' ``analysis_id`` names)."""
    keyers: Dict[str, object] = {}

    def key_of(m):
        ds = (getattr(state, 'datasets', None) or {}).get(m['ds'])
        if getattr(ds, 'data_type', None) != 'bam_livelift':
            return m['qname']
        if m['ds'] not in keyers:
            from services.scan.states import _Keyer
            keyers[m['ds']] = (_Keyer(state, m['ds'], dict(enumerate(ds.paths))), list(ds.paths))
        keyer, paths = keyers[m['ds']]
        index = next((i for i, p in enumerate(paths) if real(p) == real(m['path'])), 0)
        return keyer.key(index, m['qname'], f"{m['key'][0]}:{m['key'][1]}")
    return [[(a['ds'], key_of(a)) for a in m.get('aliases') or (m,)] for m in metas]


def _record_states(state, G, metas, states) -> Dict[str, Dict[Tuple[str, str], str]]:
    """geometryId -> {(dataset, read key): '1' / '0' / '.'} (the scan's mapping; a read name whose records disagree
    is '.'). Read keys are read names, or record keys for live-lift datasets (``services.scan.states._Keyer``).
    A physical record shared by several datasets (one BAM opened twice) is one layout with every (dataset, read)
    alias: each alias gets the state."""
    from fiberhmm.nuc.geometries import SCAN_STATE
    keys = alias_keys(state, metas)
    out: Dict[str, Dict[Tuple[str, str], str]] = {}
    for g in G:
        per: Dict[Tuple[str, str], set] = {}
        for i, ks in enumerate(keys):
            v = SCAN_STATE[states[i][g.geometry_id]]
            for k in ks:
                per.setdefault(k, set()).add(v)
        out[g.geometry_id] = {k: next(iter(v)) if len(v) == 1 else '.' for k, v in per.items()}
    return out


REPLAY_ANALYSE_TIMEOUT = 900.0


def _ensure_analysed(state, request: dict) -> None:
    """A replay whose datasets have no nucleosome analysis of its views in this server session (a restarted server,
    a reopened session, an analysis of another locus): run the panel's Analyse for the request's views first (stored calibration; the request's ``analysis``
    parameters, else the defaults) and wait for it, as the panel's first open would. A running Analyse is waited for,
    never replaced."""
    from . import jobs as J
    obs = [o for o in request['observations'] if isinstance(o, dict)]
    ids = list(dict.fromkeys(str(o.get('datasetId') or '') for o in obs))

    def unanalysed(d) -> bool:
        """No analysis of the dataset in this session, or a view of the request with records not computed (an
        analysis elsewhere does not cover this view)."""
        if J.active_config(state, d) is None:
            return True
        from .inputs import browser_read_policy
        from .observations import ObservationError, observation_cohort
        policy = browser_read_policy(state, include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')))
        for o in obs:
            if str(o.get('datasetId') or '') != d:
                continue
            try:
                if observation_cohort(state, o, policy, quick=True)[5]['missing'] > 0:
                    return True
            except (ObservationError, ValueError):
                continue
        return False

    def missing():
        return [d for d in ids if d and unanalysed(d)]

    def wait_live():
        for job in J.list_jobs(state):
            if job.get('status') in ('queued', 'running', 'cancelling'):
                try:
                    J.wait(state, job['job_id'], timeout=REPLAY_ANALYSE_TIMEOUT)
                except (KeyError, TimeoutError):
                    pass
    analysis = request.get('analysis') if isinstance(request.get('analysis'), dict) else None
    done: dict = {}
    for _attempt in range(3):
        if not missing():
            return
        wait_live()
        todo = missing()
        if not todo:
            return
        views = [dict(datasetId=str(o['datasetId']), chrom=str(o['chrom']), start=int(o['start']), end=int(o['end']))
                 for o in obs if str(o.get('datasetId')) in todo and o.get('chrom')
                 and o.get('start') is not None and o.get('end') is not None]
        if not views:
            return
        params = analysis
        if params is None:
            # a dataset analysed elsewhere keeps its settings (never the defaults over the panel's)
            active = next((J.active_config(state, d) for d in todo if J.active_config(state, d) is not None), None)
            params = dict(active.settings) if active is not None else None
        job = J.submit(state, dict(datasets=todo, views=views, include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')),
                                   **({'parameters': params} if params else {})))
        try:
            done = J.wait(state, job['job_id'], timeout=REPLAY_ANALYSE_TIMEOUT)
        except TimeoutError:
            raise ValueError('The nucleosome analysis behind these geometries is still running: try again shortly') from None
        if done.get('status') == 'complete':
            return
        if done.get('status') != 'cancelled' or done.get('message') != J._REPLACED:
            break
        # replaced by a newer Analyse (the panel's own, opening at the same time): wait for it and look again
    if not missing():
        return
    raise ValueError(f'The nucleosome analysis behind these geometries did not finish ({done.get("message") or done.get("status")}): '
                     'open the nucleosome panel and choose Analyse this view')


def _tolerance(out: dict) -> int:
    """The grouping tolerance an analysis used (``GeometryParams.tol_bp``; 0 is a tolerance, not a missing one)."""
    tol = ((out.get('params') or {}).get('geometry') or {}).get('tol_bp')
    return 500 if tol is None else int(tol)


def _same_geometry(rows: Sequence[dict], kind: str, span: Tuple[int, int], tol: int) -> Optional[str]:
    """The geometry id of the row of this kind whose ends are both within ``tol`` of ``span`` (the closest)."""
    near = [(abs(int(r['start']) - span[0]) + abs(int(r['end']) - span[1]), r['geometryId']) for r in rows
            if (r.get('kind') or 'high') == kind and abs(int(r['start']) - span[0]) <= tol
            and abs(int(r['end']) - span[1]) <= tol]
    return min(near)[1] if near else None


def geometry_record_states(state, request: dict, geometry_id: str, *, span: Optional[Tuple[int, int]] = None,
                           kind: Optional[str] = None):
    """Per-record states of one geometry of a panel's request (the hub's ``nuc-geometry`` stateSpec): the request's
    analysis computed with its own settings (the same cached response the panel got), whatever another panel or a
    cluster view has made the datasets' lane settings since; a replay never changes those nor relabels the lanes.
    After a restart the view is analysed first. Returns ({(dataset, key): state}, datasets)."""
    if not isinstance(request, dict) or not isinstance(request.get('observations'), list) or not request['observations']:
        raise ValueError('This geometry has no panel request: select it again from the nucleosome panel')
    _ensure_analysed(state, request)
    keys: list = []
    site = request.get('site')
    out = geometry_analysis(
        state, request['observations'], patch_params=request.get('patches'), reg_params=request.get('regularity'),
        ref_override=request.get('reference'), spanning=bool(request.get('spanning')), cohort=request.get('cohort'),
        include_duplicates=bool(request.get('include_duplicates')), include_qcfail=bool(request.get('include_qcfail')), site=int(site) if site is not None else None,
        site_state=str(request.get('site_state') or 'nfr'), show=str(request.get('show') or 'patch'),
        apply_params=False, _key_out=keys)
    with _LOCK:
        per = (_STATES.get(keys[0]) or {}) if keys else {}
    if geometry_id not in per:
        ids = [g.get('geometryId') for g in out.get('geometries') or []]
        if geometry_id not in ids:
            # The analysis was recomputed (a restart) and its geometries moved a little: the same geometry is the one
            # of this kind with both ends within the grouping tolerance, as the Saved list matches them.
            again = None
            if span is not None:
                k = kind or ('low' if geometry_id.startswith('L') else 'high')
                tol = _tolerance(out)
                again = _same_geometry(out.get('geometries') or [], k, (int(span[0]), int(span[1])), tol)
            if again is None:
                raise ValueError(f'Geometry {geometry_id.split("_", 1)[0]} is not in this analysis any more: select it again')
            geometry_id = again
    states = per.get(geometry_id, {})
    datasets = sorted({ds for ds, _k in states}) or sorted({str(o.get('datasetId')) for o in request['observations']})
    return states, datasets


def _geometry_rows(G, lays, states, metas, observations, obs_index, sources, support, dms, CARRIES, PARTIAL,
                   gchrom=None):
    rows = []
    datasets = list(dict.fromkeys(d for m in metas for d in _alias_datasets(m)))
    num = _numbers(G)
    dm_in = _per_dataset_layouts(lays, states, metas)
    # Each dataset's molecules, once each: layouts are one per physical record, so two overlapping panels (or two
    # series) of a dataset never count a molecule twice (summing perObservation would). A record shared by two
    # datasets (its aliases) counts for each.
    ds_index: Dict[str, List[int]] = {}
    for li, m in enumerate(metas):
        for d in _alias_datasets(m):
            ds_index.setdefault(str(d), []).append(li)
    hids = hit_ids(G)
    for gi, g in enumerate(G):
        per_ds = {}
        for d, idx in ds_index.items():
            col = [states[i][g.geometry_id] for i in idx]
            per_ds[d] = dict(molecules=len(idx), full=sum(x == CARRIES for x in col), partial=sum(x == PARTIAL for x in col),
                             callable=sum(x in (CARRIES, PARTIAL, 'absent') for x in col))
        per_obs = {}
        for obs in observations:
            oid = str(obs.get('obsId'))
            idx = obs_index.get(oid) or []
            n = len(idx)
            full = sum(states[i][g.geometry_id] == CARRIES for i in idx)
            part = sum(states[i][g.geometry_id] == PARTIAL for i in idx)
            call = sum(states[i][g.geometry_id] in (CARRIES, PARTIAL, 'absent') for i in idx)
            sidx = set(idx)
            sc = [lays[li].patches[pk].mean_score for li, pk in g.members if li in sidx]
            per_obs[oid] = dict(molecules=n, full=full, partial=part, callable=call,
                                fullShare=_num(full / n if n else None), partialShare=_num(part / n if n else None),
                                callableShare=_num(full / call if call else None), score=_num(_median(sc), 3))
        root = g.parent if g.parent is not None else gi
        rows.append(dict(
            id=_label(g), kind=g.kind, number=num[gi], rootNumber=num[root], hitId=hids[gi],
            chrom=(gchrom[gi] if gchrom else None),
            geometryId=g.geometry_id, start=int(g.start), end=int(g.end), width=int(g.width),
            openLeft=bool(g.open_left), openRight=bool(g.open_right), molecules=int(g.n_molecules),
            patches=int(g.n_patches), startMad=_num(g.start_mad, 1), endMad=_num(g.end_mad, 1),
            score=_num(g.mean_score, 3), period=int(g.period),
            parent=(_label(G[g.parent]) if g.parent is not None else None),
            parentIndex=g.parent, children=[_label(h) for c, h in enumerate(G) if h.parent == gi],
            perObservation=per_obs,
            perDataset=per_ds,
            # carriers among callable molecules: m6A density matched across datasets; one dataset: the plain
            # callable share (fiberhmm-scan's share_dm, the same denominator either way). A record shared by two
            # datasets (its aliases) counts for each, as in perDataset.
            densityMatched={d: _num(v) for d, v in dms(*dm_in, g.geometry_id, datasets).items()}
            if len(datasets) > 1 else {d: _num(_callable_share(states, metas, g.geometry_id, d, CARRIES, PARTIAL))
                                       for d in datasets}))
    return rows


#: what the share columns divide by (the panel's labels)
SHARE_DEFINITIONS = dict(
    fullShare='carriers / all molecules of the observation',
    callableShare='carriers / callable molecules (carrying, partly carrying or absent)',
    densityMatched='carriers / callable molecules, m6A density matched across datasets (one dataset: the plain '
                   'callable share)')


def _alias_datasets(m) -> List[str]:
    """The datasets of a layout's aliases (a record shared by datasets: each once), its own first."""
    return list(dict.fromkeys(str(a['ds']) for a in (m.get('aliases') or (m,))))


def _per_dataset_layouts(lays, states, metas):
    """(layouts, states) with a layout repeated for every further dataset of its aliases (``dataset`` set to it), so
    a record shared by two datasets enters each one's density-matched share; the inputs as they are otherwise."""
    import dataclasses
    if all(len(_alias_datasets(m)) <= 1 for m in metas):
        return lays, states
    out_l, out_s = [], []
    for lay, st, m in zip(lays, states, metas):
        for d in _alias_datasets(m):
            out_l.append(lay if d == lay.dataset else dataclasses.replace(lay, dataset=d))
            out_s.append(st)
    return out_l, out_s


def _callable_share(states, metas, gid, ds, CARRIES, PARTIAL) -> Optional[float]:
    idx = [i for i, m in enumerate(metas) if ds in _alias_datasets(m)]
    call = sum(states[i][gid] in (CARRIES, PARTIAL, 'absent') for i in idx)
    return sum(states[i][gid] == CARRIES for i in idx) / call if call else None


def _scores_in(lay, sc, a, b):
    c = (lay.tile_lo + lay.tile_hi) / 2.0
    sel = (c >= a) & (c <= b) & np.isfinite(sc)
    return float(sc[sel].mean()) if sel.any() else None


def _nested_rows(G, pairs, lays, scores, states, gp, view, lay_chrom=None, gchrom=None):
    out = []
    carr = [{i for i, _k in g.members} for g in G]
    none_all = [i for i in range(len(lays)) if not any(i in c for c in carr)]
    for z in sorted(pairs, key=lambda z: (z.parent, z.child)):
        c, q = G[z.child], G[z.parent]
        # molecules carrying no geometry, on the pair's chromosome
        none = none_all if not gchrom or not lay_chrom else [i for i in none_all if lay_chrom[i] == gchrom[z.child]]
        a, b = (c.end, q.end) if z.shared == 'start' else (q.start, c.start)

        def med(idx):
            v = [_scores_in(lays[i], scores[i], a, b) for i in idx]
            v = [x for x in v if x is not None]
            return _num(float(np.median(v)), 3) if len(v) >= 5 else None
        short_only = [i for i in carr[z.child] if i not in carr[z.parent]]
        out.append(dict(child=_label(c), parent=_label(q), kind=c.kind, shared=z.shared, moved=int(z.moved),
                        near=bool(z.moved <= gp.near_max_bp), folded=G[z.child].parent is not None,
                        rest=[int(a), int(b)], shortOnly=med(short_only), longCarriers=med(carr[z.parent]),
                        noGeometry=med(none), nShortOnly=len(short_only)))
    return out


def _stack(G, lays, view):
    out = []
    per = int(view['stack_per_geometry'])
    for gi, g in enumerate(G):
        mem = sorted([(lays[li].patches[pk].start, lays[li].patches[pk].end) for li, pk in g.members],
                     key=lambda x: x[1] - x[0])
        step = max(1.0, len(mem) / per) if per > 0 else len(mem) + 1
        pick, q = [], 0.0
        while q < len(mem) and len(pick) < per:
            pick.append(list(mem[int(q)]))
            q += step
        out.append(dict(id=_label(g), kind=g.kind, n=len(mem), patches=pick))
    return out


def _bin_edges(win, step: int):
    _c, w0, w1 = win
    width = max(int(step), int(math.ceil((w1 - w0) / 120.0)))
    return np.arange(w0, w1 + width, width, dtype=float)


def _binned(idx, lays, values_of, edges, min_n):
    """Per bin: the mean over molecules of each molecule's mean value in the bin (molecules, not tiles, count);
    None where fewer than ``min_n`` molecules have a value."""
    nb = len(edges) - 1
    mols, bins, vals = [], [], []
    for i in idx:
        lay = lays[i]
        v = values_of(i)
        if not len(v):
            continue
        c = (lay.tile_lo + lay.tile_hi) / 2.0
        b = np.searchsorted(edges, c, side='right') - 1
        ok = np.isfinite(v) & (b >= 0) & (b < nb)
        if ok.any():
            mols.append(np.full(int(ok.sum()), i, dtype=np.int64)); bins.append(b[ok]); vals.append(v[ok])
    if not mols:
        return [None] * nb, [0] * nb
    m, b, v = np.concatenate(mols), np.concatenate(bins), np.concatenate(vals)
    key = m * (nb + 1) + b
    uk, inv = np.unique(key, return_inverse=True)
    mean = np.bincount(inv, weights=v) / np.bincount(inv)
    ub = uk % (nb + 1)
    s = np.bincount(ub, weights=mean, minlength=nb)[:nb]
    n = np.bincount(ub, minlength=nb)[:nb]
    return [(_num(s[k] / n[k], 3) if n[k] >= min_n else None) for k in range(nb)], n.astype(int).tolist()


def _profiles(G, lays, scores, states, observations, obs_index, win, view, R, CARRIES):
    step = 250
    edges = _bin_edges(win, step)
    excess = lambda i: scores[i]
    carriers = {}
    allc = set()
    for gi, g in enumerate(G):
        idx = sorted({i for i, _k in g.members})
        allc |= set(idx)
        carriers[_label(g)] = _binned(idx, lays, excess, edges, view['profile_min_molecules'])[0]
    none = [i for i in range(len(lays)) if i not in allc]
    share, share_low = {}, {}
    low_on = any(g.kind == 'low' for g in G) or any(q.kind == 'low' for l in lays for q in l.patches)
    for obs in observations:
        oid = str(obs.get('obsId'))
        share[oid] = _binned(obs_index.get(oid) or [], lays, _in_kind(lays, 1), edges, view['share_min_molecules'])[0]
        if low_on:
            share_low[oid] = _binned(obs_index.get(oid) or [], lays, _in_kind(lays, 2), edges,
                                     view['share_min_molecules'])[0]
    out = dict(edges=edges.tolist(), carriers=carriers,
               none=_binned(none, lays, excess, edges, view['profile_min_molecules'])[0], share=share)
    if low_on:
        out['shareLow'] = share_low
    return out


def _in_kind(lays, code: int):
    """Per tile of a molecule: 1 inside a patch of the kind (tile state 1 high, 2 low), 0 elsewhere, NaN unscored."""
    return lambda i: np.where(lays[i].tile_state == -1, np.nan, (lays[i].tile_state == code).astype(float))


def _patch_stats(lays, observations, obs_index, kinds=('high',)):
    """Per observation: patch counts, share of scored tiles in patches, closed lengths and scores, for high patches
    (top level) and, with low calling, the same for low patches under ``low``."""
    def stats(idx, kind, code):
        pats = [p for i in idx for p in lays[i].patches if p.kind == kind]
        closed = [p.end - p.start for p in pats if not p.open_left and not p.open_right]
        fr = []
        for i in idx:
            st = lays[i].tile_state
            called = st != -1
            if called.any():
                fr.append(float((st[called] == code).mean()))
        sc = [p.mean_score for p in pats]
        hist_edges = list(range(0, 8251, 250))
        h = np.histogram(closed, bins=hist_edges)[0].tolist() if closed else [0] * (len(hist_edges) - 1)
        return dict(molecules=len(idx), patches=len(pats), perMolecule=_num(len(pats) / len(idx), 3),
                    shareInPatches=_num(float(np.mean(fr)) if fr else None, 3),
                    medianClosed=_num(_median([float(x) for x in closed]), 0), score=_num(_median(sc), 3),
                    lengths=dict(edges=hist_edges, counts=h, n=len(closed)))
    out = {}
    for obs in observations:
        oid = str(obs.get('obsId'))
        idx = obs_index.get(oid) or []
        if not idx:
            out[oid] = dict(molecules=0)
            continue
        out[oid] = stats(idx, 'high', 1)
        if 'low' in kinds:
            out[oid]['low'] = stats(idx, 'low', 2)
    return out


def _assignments(G, metas, states, CARRIES, PARTIAL, keys=None, kinds=()):
    """Per dataset, read key -> the geometry group a read falls in for Group/Sort (1-based index in the geometry
    list of the root of the first high geometry it carries in full, else of one it carries partly; 0 = none),
    ``groupLow`` likewise over the low geometries, the geometries it carries (indices + 1) and those it carries
    partly (``partial``). Read keys as ``alias_keys`` gives them (``keys``; read names without), every dataset alias
    of a shared record included. A read with several records carries what any of them carries (a record that
    misses the geometry never takes a carrier's group away). ``groupLow`` is there whenever low calling is on
    (``kinds``), also with no shared low geometry (every read 0: "none", not "no data")."""
    out: Dict[str, dict] = {}
    root = lambda gi: (G[gi].parent if G[gi].parent is not None else gi) + 1      # noqa: E731
    low_on = 'low' in (kinds or ()) or any(g.kind == 'low' for g in G)
    per: Dict[Tuple[str, str], Tuple[set, set]] = {}
    for i, m in enumerate(metas):
        carried = {gi for gi, g in enumerate(G) if states[i][g.geometry_id] == CARRIES}
        partial = {gi for gi, g in enumerate(G) if states[i][g.geometry_id] == PARTIAL}
        ks = keys[i] if keys is not None else [(a['ds'], a['qname']) for a in m.get('aliases') or (m,)]
        for k in ks:
            c, p = per.setdefault(k, (set(), set()))
            c |= carried
            p |= partial
    for (ds, rk), (c, p) in per.items():
        p = p - c
        d = out.setdefault(ds, dict(group={}, carried={}, partial={}, **({'groupLow': {}} if low_on else {})))
        for kind, key in (('high', 'group'), ('low', 'groupLow')):
            if key not in d:
                continue
            ck = sorted(gi for gi in c if G[gi].kind == kind)
            pk = sorted(gi for gi in p if G[gi].kind == kind)
            d[key][rk] = root(ck[0]) if ck else (root(pk[0]) if pk else 0)
        d['carried'][rk] = [gi + 1 for gi in sorted(c)]
        d['partial'][rk] = [gi + 1 for gi in sorted(p)]
    return out


def _association(G, lays, scores, states, metas, observations, obs_index, win, view, site, site_state, show,
                 CARRIES, PARTIAL):
    """Site states (NFR open/closed or TF bound/unbound among open molecules), the regularity profile per state,
    the flank table with the density-matched open - closed difference, and FiberHMM's co-occurrence test of each
    root geometry's carriage against the site state."""
    ok_key = ('opens', int(view['site_open_bp']), int(view['site_nuc_min_bp']))
    opens = []
    for m in metas:
        e = m['entry']
        if ok_key not in e:          # cached on the record's grid entry (its own coordinates)
            e[ok_key] = _open_stretches(e['nucs'], view['site_open_bp'], view['site_nuc_min_bp'], e['mol'])
        opens.append(_in_frame(e[ok_key], m.get('rf')))
    sites = _sites(opens, win, view)
    out = dict(sites=sites, site=None, state=site_state, show=show)
    if site is None:
        if not sites:
            return out
        site = max(sites, key=lambda s: s['share'])['pos']
    x = int(site)
    out['site'] = x
    # per molecule: 1 / 0 / None
    st = []
    for i, m in enumerate(metas):
        lay = lays[i]
        if not len(lay.tile_lo) or lay.tile_lo[0] > x or lay.tile_hi[-1] < x:
            st.append(None)
            continue
        o = next(((a, b) for a, b in opens[i] if a <= x <= b), None)
        if site_state == 'nfr':
            st.append(1 if o else 0)
        else:
            if o is None:
                st.append(None)
                continue
            w = view['tf_window_bp']
            e = m['entry']
            if 'tf_spans' not in e:
                e['tf_spans'] = _tf_spans(e['tfs'], e['mol'])
            tf = any(a <= x + w and b >= x - w and a >= o[0] - 5 and b <= o[1] + 5
                     for a, b in _in_frame(e['tf_spans'], m.get('rf')))
            st.append(1 if tf else 0)
    names = ('closed', 'open') if site_state == 'nfr' else ('unbound', 'bound')
    out['stateNames'] = list(names)
    # profiles per state x observation
    edges = _bin_edges(win, 250)
    val = _in_kind(lays, 1) if show == 'patch' else _in_kind(lays, 2) if show == 'low' else (lambda i: scores[i])
    prof = []
    for obs in observations:
        oid = str(obs.get('obsId'))
        idx = obs_index.get(oid) or []
        for s in (0, 1):
            sub = [i for i in idx if st[i] == s]
            prof.append(dict(obsId=oid, state=s, n=len(sub),
                             values=_binned(sub, lays, val, edges, view['share_min_molecules'])[0]))
    out['profiles'] = dict(edges=edges.tolist(), series=prof)
    # flank table (prototype): windows centred flank_near..flank_far from the site on each side
    near, far = view['flank_near_bp'], view['flank_far_bp']

    def flank_vals(idx, side, kind):
        a, b = (x - far, x - near) if side < 0 else (x + near, x + far)
        hit = tot = 0
        vs = []
        code = 2 if kind == 'low' else 1
        for i in idx:
            lay = lays[i]
            c = (lay.tile_lo + lay.tile_hi) / 2.0
            sel = (c >= a) & (c <= b)
            if kind in ('share', 'low'):
                s = lay.tile_state[sel]
                tot += int((s != -1).sum()); hit += int((s == code).sum())
            else:
                v = scores[i][sel]
                vs += [float(z) for z in v if np.isfinite(z)]
        if kind in ('share', 'low'):
            return hit / tot if tot else None
        return float(np.mean(vs)) if vs else None
    low_on = any(g.kind == 'low' for g in G) or any(q.kind == 'low' for l in lays for q in l.patches)

    table = []
    for obs in observations:
        oid = str(obs.get('obsId'))
        idx = [i for i in (obs_index.get(oid) or []) if st[i] is not None]
        # density-matched open - closed (share in a patch), within m6A/kb quintiles of the observation
        matched, matched_low = {}, {}
        for kind, dest in (('share', matched),) + ((('low', matched_low),) if low_on else ()):
            for side in (-1, 1):
                srt = sorted(idx, key=lambda i: lays[i].density_per_kb)
                num = w = 0.0
                for q in range(5):
                    b = srt[q * len(srt) // 5:(q + 1) * len(srt) // 5]
                    op = [i for i in b if st[i] == 1]
                    cl = [i for i in b if st[i] == 0]
                    if len(op) < 5 or len(cl) < 5:
                        continue
                    va, vb = flank_vals(op, side, kind), flank_vals(cl, side, kind)
                    if va is None or vb is None:
                        continue
                    num += (va - vb) * len(op)
                    w += len(op)
                dest['up' if side < 0 else 'down'] = _num(num / w if w else None, 4)
        for s in (0, 1):
            sub = [i for i in idx if st[i] == s]
            table.append(dict(obsId=oid, state=s, molecules=len(sub),
                              m6aPerKb=_num(_median([lays[i].density_per_kb for i in sub]), 1),
                              upShare=_num(flank_vals(sub, -1, 'share'), 4) if len(sub) >= 10 else None,
                              upScore=_num(flank_vals(sub, -1, 'score'), 3) if len(sub) >= 10 else None,
                              downShare=_num(flank_vals(sub, 1, 'share'), 4) if len(sub) >= 10 else None,
                              downScore=_num(flank_vals(sub, 1, 'score'), 3) if len(sub) >= 10 else None,
                              matched=matched if s == 1 else None,
                              **(dict(upLowShare=_num(flank_vals(sub, -1, 'low'), 4) if len(sub) >= 10 else None,
                                      downLowShare=_num(flank_vals(sub, 1, 'low'), 4) if len(sub) >= 10 else None,
                                      matchedLow=matched_low if s == 1 else None) if low_on else {})))
    out['table'] = table
    out['tests'] = _cooccurrence(G, lays, states, metas, st, x, win, view, CARRIES, PARTIAL)
    return out


def _cooccurrence(G, lays, states, metas, st, x, win, view, CARRIES, PARTIAL):
    """FiberHMM M1 co-occurrence (``fiberhmm.assoc.cooccur``) of root geometries' carriage against the site state:
    per pair Mantel-Haenszel OR with its exact stratified test, strata = dataset x m6A density bins."""
    from fiberhmm.assoc.cooccur import FeatureStates, MoleculeTable, cooccurrence
    roots = [gi for gi, g in enumerate(G) if g.parent is None]
    if not roots:
        return dict(rows=[], note='no geometries')
    ids = [lays[i].uid for i in range(len(lays))]
    mt = MoleculeTable(ids, channel=np.array([m['ds'] for m in metas], dtype=object),
                       density=np.array([lays[i].density_per_kb for i in range(len(lays))], dtype=float))
    carry = (CARRIES,) if view['carriers'] == 'full' else (CARRIES, PARTIAL)
    gh, gm, gs = [], [], []
    for h, gi in enumerate(roots):
        gid = G[gi].geometry_id
        for i in range(len(lays)):
            s = states[i][gid]
            if s in carry:
                gh.append(h); gm.append(i); gs.append(1)
            elif s in ('absent', PARTIAL):
                gh.append(h); gm.append(i); gs.append(0)
    A = FeatureStates('nuc.geometry', [_label(G[gi]) for gi in roots], [win[0]] * len(roots),
                      [G[gi].start for gi in roots], [G[gi].end for gi in roots],
                      [(G[gi].start + G[gi].end) // 2 for gi in roots], gh, gm, gs, footprint_like=True)
    sm = [i for i, s in enumerate(st) if s is not None]
    B = FeatureStates('site', ['site'], [win[0]], [x], [x + 1], [x], [0] * len(sm), sm, [st[i] for i in sm],
                      footprint_like=True)
    try:
        res = cooccurrence(A, B, mt, max_distance=int(win[2] - win[1]) + 1, test='strata', effect=False,
                           min_molecules=10, min_pool_molecules=5, n_flip=2000, seed=0)
    except Exception as error:   # noqa: BLE001 - a degenerate table is reported, not raised
        return dict(rows=[], note=str(error))
    rows = []
    for r in res.get('pairs') or []:
        rows.append({k: (_num(v, 6) if isinstance(v, float) else v) for k, v in r.items()
                     if not isinstance(v, (list, dict))})
    return dict(rows=rows, skipped=res.get('skipped') or [], method='fiberhmm.assoc.cooccur (strata: dataset x '
                'm6A density)')
