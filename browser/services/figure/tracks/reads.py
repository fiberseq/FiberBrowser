"""Read track (read-track/ReadTrack.tsx + ReadTrackCanvas.ts).

Which reads: the same /api/reads/compact request the browser makes for the
panel (layers, methylation, caps and filter_ids from ReadTrack.tsx /
useReadTrackData.ts), then the browser's client-side derivation: duplicate
filter, filteredReadIds, cluster-branch scope, clusterFocus, readSortOrder /
cluster ordering, and fit-mode sampling (sampleReadsForFit) or the
"all reads" cap.

How: every read row is painted like drawReadTrack in the browser's z-order
(read background, FIRE, primary nuc/FP, base marks, TF/custom overlays in
render-rank order, evidence marks) with the browser's colouring (Cart
entries, colormap rules incl. conditions/targets/quality gates/gradients,
layer colours and opacities, TF overlay, quality shading, edge ambiguity
strict/soft/loose). The rows are rasterised with numpy (see _read_raster)
and placed as one image, like the browser's own image export; cluster
separators, read-boundary lines, selections and labels are vector.

The figure always shows every displayed read (the browser Export's "expand
read tracks"): height = rows x (row height + separator gap).
"""
from __future__ import annotations

import math
import urllib.parse
from itertools import chain
from typing import Optional

import numpy as np

from services.figure.tracks import TrackContext, register
from services.figure.tracks import _read_colors as rc
from services.figure.tracks import _read_sv as sv
from services.figure.tracks._read_raster import RowRaster, gaussian_blur
from services.read_marks import m6a_positions

SIDEBAR_WIDTH = 16
DEFAULT_ROW_HEIGHT = 2.0
DEFAULT_PANEL_HEIGHT = 838      # track area assumed when there is no browser layout (1500x1000 window)
MIN_READ_TRACK_HEIGHT = 120
DEFAULT_ALL_READS_DISPLAY_CAP = 2000
MAX_QUERY_FILTER_IDS = 5000
MAX_QUERY_FILTER_BYTES = 32000
HISTOGRAM_HEIGHT = 30
EMPTY_HEIGHT = 60
DEFAULT_SEED = 'fiberbrowser-analysis'

METHYLATION_LAYER_KEYS = ('m6a', 'mod', 'm5c', 'deam')
PRIMARY_INTERVAL_LAYER_KEYS = {'footprint', 'subnuc'}
SERVER_METAPROFILE_EXCLUDED_KEYS = {'m6a', 'mod', 'm5c', 'deam', 'deam_opportunity'}
# The same read-signal sources the Peaks track (and the browser) scan on the server.
from services.peak_scanning import READ_SIGNAL_SOURCES as BACKEND_PEAK_SOURCES, is_read_signal_source  # noqa: E402,F401


# --------------------------------------------------------------------------
# small ports
# --------------------------------------------------------------------------
def _num(value, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def strip_segment_suffix(read_id: str) -> str:
    import re
    return re.sub(r'_\d+$', '', read_id)


def cluster_for(assignments: dict, read_id: str) -> Optional[int]:
    """clusterAssignmentForRead."""
    if read_id in assignments:
        return assignments[read_id]
    return assignments.get(strip_segment_suffix(read_id))


def row_gap(row_height: float, mode: str = 'auto', min_height: float = 3, width: float = 1) -> float:
    """computeReadRowGap (layout.ts)."""
    if mode == 'off':
        return 0.0
    if row_height < max(0.0, _num(min_height, 0)):
        return 0.0
    if mode == 'fixed':
        return max(0.0, min(10.0, max(0.0, row_height - 0.5), _num(width, 0) or 0))
    if row_height < 6:
        return 0.5
    if row_height < 9:
        return 1.0
    if row_height < 12:
        return 1.5
    if row_height < 16:
        return 2.0
    return 3.0


def display_capacity(height: float, row_height, mode: str, min_h: float, sep_w: float) -> int:
    height = max(0.0, height)
    if row_height == 'auto':
        return max(1, math.floor(height))
    rh = _num(row_height, 1)
    return max(1, math.floor(height / (rh + row_gap(rh, mode, min_h, sep_w))))


def _fnv(value: str) -> int:
    h = 2166136261
    for unit in value.encode('utf-16-le').decode('utf-16-le'):
        h = ((h ^ ord(unit)) * 16777619) & 0xFFFFFFFF
    return h


def sample_reads_for_fit(reads: list, limit: int, seed: str) -> list:
    """sampleReadsForFit: stable hash sample that keeps the input order."""
    if limit <= 0:
        return []
    if len(reads) <= limit:
        return reads
    keyed = sorted(((_fnv(f"{seed}:{r['id']}"), i) for i, r in enumerate(reads)))[:limit]
    return [reads[i] for i in sorted(i for _, i in keyed)]


def format_read_status(displayed: int, returned: int, working: int, in_scope: int,
                       overlapping: Optional[int], spanning: int) -> str:
    """formatReadStatus (readCounts.ts) -> the 'N reads' label."""
    working = max(0, working if working > 0 else returned)
    in_scope = max(0, in_scope if in_scope > 0 else working)
    overlapping = max(0, in_scope if overlapping is None else overlapping)
    if displayed == 0 and returned == 0 and working == 0 and overlapping > 0 and spanning == 0:
        return f"0 spanning / {overlapping:,} overlapping"
    return f"{displayed:,} reads" if displayed == working else f"{displayed:,}/{working:,} visible"


def _id_set(values) -> Optional[set]:
    if not values:
        return None
    return {str(v) for v in values}


def _filter_set(values) -> Optional[set]:
    """A saved read filter: None when absent, and an empty set when it matches no reads."""
    if values is None:
        return None
    return {str(v) for v in values}


def request_filter_param(*sets: Optional[set]) -> str:
    """requestFilterParamFromSets (useReadTrackData.ts)."""
    active = [{strip_segment_suffix(v) for v in s} for s in sets if s]
    active = [s for s in active if s]
    if not active:
        return ''
    active.sort(key=len)
    smallest, rest = active[0], active[1:]
    if len(smallest) > MAX_QUERY_FILTER_IDS:
        return ''
    ids = sorted(i for i in smallest if all(i in s for s in rest))
    if not ids or len(ids) > MAX_QUERY_FILTER_IDS:
        return ''
    param = ','.join(ids)
    if len(urllib.parse.urlencode({'filter_ids': param})) > MAX_QUERY_FILTER_BYTES:
        return ''
    return param


# --------------------------------------------------------------------------
# per-panel state (ReadTrack.tsx)
# --------------------------------------------------------------------------
def _per_key(fe: dict, name: str, key: str):
    value = fe.get(name) or {}
    return value.get(key) if isinstance(value, dict) else None


def _has_any_clusters(fe: dict) -> bool:
    ca = fe.get('clusterAssignments') or {}
    return isinstance(ca, dict) and any(isinstance(v, dict) and v for v in ca.values())


def _panel_state(fe: dict, key: str) -> dict:
    assignments = {str(k): int(v) for k, v in (_per_key(fe, 'clusterAssignments', key) or {}).items()
                   if v is not None}
    focus_raw = _per_key(fe, 'clusterFocus', key)
    focus = {int(c) for c in focus_raw} if focus_raw else None
    filt = _filter_set(_per_key(fe, 'filteredReadIds', key))
    nodes = fe.get('clusterTreeNodes') or {}
    active_id = fe.get('activeClusterTreeNodeId')
    branch_node = nodes.get(active_id) if isinstance(nodes, dict) and active_id else None
    branch_active = bool(isinstance(branch_node, dict) and branch_node.get('parentId'))

    def scope_ids(focus_set, include_all):
        if focus_set:
            return {r for r, c in assignments.items() if c in focus_set}
        return set(assignments) if include_all else None

    return {
        'assignments': assignments,
        'order': [int(c) for c in (_per_key(fe, 'clusterOrder', key) or [])],
        'sort': [str(r) for r in (_per_key(fe, 'readSortOrder', key) or [])],
        'focus': focus,
        'filter': filt,
        'has_cluster': bool(assignments),
        'branch_active': branch_active,
        'branch_ids': scope_ids(focus if branch_active else None, branch_active),
        'root_focus_ids': None if branch_active else scope_ids(focus, False),
        'selected': _id_set(_per_key(fe, 'selectedReadIds', key)) or set(),
    }


def _layer_available(ds: dict, key: str) -> bool:
    layers = ds.get('available_layers') or {}
    lt = ds.get('layer_type')
    if layers.get(key) or lt == key:
        return True
    if key == 'm6a' and (layers.get('mod') or lt == 'mod'):
        return True
    if key == 'mod' and (layers.get('m6a') or lt == 'm6a'):
        return True
    if key == 'fire':
        return bool(layers.get('fire') or layers.get('msp') or lt == 'msp')
    if ds.get('data_type') == 'bam' and not ds.get('available_layers'):
        return key in ('footprint', 'nuc', 'tf', 'fire', 'msp', 'mod', 'm6a')
    return False


def _metaprofile_key(layer: Optional[str]) -> Optional[str]:
    if not layer:
        return None
    key = 'fire' if layer == 'msp' else layer
    return 'nuc' if key == 'footprint' else key


def _active_metaprofile_ids(fe: dict) -> set:
    ids = set()
    for comp in fe.get('compositeTracks') or []:
        if not isinstance(comp, dict) or not comp.get('visible', True) or comp.get('kind') != 'metaprofile':
            continue
        for src in comp.get('sources') or []:
            ref = (src or {}).get('ref') or {}
            if not src.get('visible') or ref.get('kind') != 'metaprofile':
                continue
            rule = ref.get('ruleId')
            key = _metaprofile_key('m6a' if rule == 'mod' else rule)
            if key:
                ids.add(key)
    return ids


def _source_ids(ds: dict, cached: dict, cache_only: bool) -> set:
    from services.figure.defaults import metaprofile_source_entries
    ids = set()
    for entry in metaprofile_source_entries([ds]):
        key = _metaprofile_key('m6a' if entry['key'] == 'mod' else entry['key'])
        if not key:
            continue
        if cache_only:
            if key in ('nuc', 'footprint') or bool((cached or {}).get(key)):
                ids.add(key)
        elif key not in SERVER_METAPROFILE_EXCLUDED_KEYS:
            ids.add(key)
    return ids


def _request_plan(fe: dict, ds: dict) -> dict:
    """What ReadTrack.tsx asks /api/reads/compact for (layers, methylation, qualities)."""
    enabled = fe.get('enabledModTypes') or {}
    meta = fe.get('enabledMetaProfiles') or {}
    active = _active_metaprofile_ids(fe)
    cached = _source_ids(ds, fe.get('cachedLayerTypes') or {}, True)
    layer_backed = _source_ids(ds, {}, False)

    wants_methyl = any(enabled.get(k) or meta.get(k) or k in active or k in cached for k in METHYLATION_LAYER_KEYS)
    needs_methyl = wants_methyl and any(_layer_available(ds, k) for k in METHYLATION_LAYER_KEYS)

    names: set = set()

    def add(key, on):
        if not on:
            return
        canon = 'fire' if key == 'msp' else key
        if canon == 'deam_opportunity' or canon in PRIMARY_INTERVAL_LAYER_KEYS or canon in METHYLATION_LAYER_KEYS:
            return
        if canon == 'fire':
            names.add('fire')
        elif _layer_available(ds, canon):
            names.add(canon)

    for k, v in enabled.items():
        add(k, v)
    for k, v in meta.items():
        add(k, v)
    for k in cached | active:
        add(k, True)
    if fe.get('footprintAnalysisLayer'):
        add(fe['footprintAnalysisLayer'], True)
    available = [n for n, p in (ds.get('available_layers') or {}).items() if p]
    if names & {'nuc_sr', 'tf_sr'}:
        names |= {n for n in ('nuc_sr', 'tf_sr') if n in available}
    if 'tf_consensus' in names and 'tf_sr' in available:
        names.add('tf_sr')
    requested = sorted(names)

    cmap = fe.get('activeColormap') or {}
    edge = cmap.get('edgeAmbiguity') or {}
    edge_active = edge.get('mode') in ('soft', 'loose') and bool(edge.get('applyNuc') or edge.get('applyTf'))

    def needs_qualities(layers):
        if not layers:
            return False
        req = {('fire' if l == 'msp' else l) for l in layers}

        def includes(layer):
            key = 'fire' if layer == 'msp' else layer
            return bool(key) and (key in req or (key == 'fire' and 'msp' in req))
        if req & {'nuc_sr', 'tf_sr', 'tf_consensus', 'tf_cross_consensus'}:
            return True
        qs = cmap.get('qualityShading') or {}
        if qs.get('enabled') and qs.get('mode') == 'quality':
            return True
        if any(f.get('enabled') and _num(f.get('minValue'), 0) > 0 and includes(f.get('layer'))
               for f in cmap.get('qualityFilters') or [] if isinstance(f, dict)):
            return True
        for rule in cmap.get('rules') or []:
            if not rule.get('enabled') or not rule.get('qualityGates'):
                continue
            targets = rule.get('targetLayers') or []
            if not targets or any(includes(t) for t in targets):
                return True
        return False

    server_meta = sorted(active)
    if not server_meta or any(k not in layer_backed for k in server_meta):
        server_meta = []
    return {
        'layers': requested,
        'needs_layers': bool(requested) or edge_active,
        'qualities': needs_qualities(requested) or edge_active,
        'methylation': needs_methyl,
        'server_meta_ok': bool(server_meta) and len(server_meta) == len(active),
    }


def _row_height(spec, fe: dict) -> float:
    if spec.read_row_height:
        return max(0.5, float(spec.read_row_height))
    value = fe.get('readRowHeight')
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 1:
        return float(value)
    return DEFAULT_ROW_HEIGHT


COVERAGE_MIN, COVERAGE_MAX, COVERAGE_DEFAULT = 20, 240, 40


def _coverage_height(fe: dict, row, shown: bool = True) -> float:
    """The coverage row (trackRegistry 'coverage'): with Coverage histogram on, its height or the default."""
    if not fe.get('showCoverageHistogram') or not shown:
        return 0
    override = getattr(row, 'height', None)
    if override is None:
        return COVERAGE_DEFAULT
    return max(COVERAGE_MIN, min(COVERAGE_MAX, _num(override, COVERAGE_DEFAULT)))


ROW_COLLAPSE_BAR_HEIGHT = 20
HIDDEN_SUBTRACK_STRIP_HEIGHT = 24


def _fixed_height(ctx: TrackContext, fe_panel: dict) -> float:
    """calcFixedHeight (SubTrackDispatch.tsx): header + non-read tracks of the panel."""
    fe, h = ctx.fe, ctx.heights()
    total = h['panelHeader']
    composites = {c.get('id'): c for c in fe.get('compositeTracks') or [] if isinstance(c, dict)}
    open_panels = {p.get('contentType') for p in fe.get('panels') or [] if isinstance(p, dict)}
    has_fasta = bool(getattr(ctx.state, 'fasta', None) or getattr(ctx.state, 'fasta_path', None))
    sub_tracks = fe_panel.get('subTracks') or [{'type': t.type, 'visible': True, 'heightOverride': t.height}
                                               for t in ctx.panel.tracks]
    for t in sub_tracks:
        if not isinstance(t, dict) or not t.get('visible', True) or t.get('removed'):
            continue
        kind, override = str(t.get('type')), t.get('heightOverride')
        fixed = {'axis': h['axis'], 'meta': h['meta'], 'fire': h['fire'], 'gene': h['gene']}
        if kind in fixed:
            total += override if override is not None else fixed[kind]
        elif kind == 'capture' and 'capture' in open_panels:
            total += override if override is not None else h['capture']
        elif kind == 'primer' and 'primer-design' in open_panels:
            total += override if override is not None else h['primer']
        elif kind == 'sequence' and has_fasta and ctx.end - ctx.start <= 2000:
            total += override if override is not None else h['sequence']
        elif kind.startswith('composite-'):
            comp = composites.get(kind[len('composite-'):])
            if comp and comp.get('visible', True):
                default = h['annotation'] if comp.get('kind') == 'annotation' else h['ortho']
                total += override if override is not None else default
        # consensus / microc / coacc / ortho-* depend on browser-only state (not counted)
    if any(isinstance(t, dict) and not t.get('visible', True) and not t.get('removed') for t in fe_panel.get('subTracks') or []):
        total += HIDDEN_SUBTRACK_STRIP_HEIGHT
    return total


def _read_area_height(ctx: TrackContext) -> float:
    """The browser's read-track height for this panel (TrackContainer.tsx), for fit-mode capacity."""
    fe, spec = ctx.fe, ctx.spec
    layout = {}
    if spec.source == 'current':
        layout = (getattr(ctx.state, 'live_figure_state', None) or {}).get('layout') or {}
    panels = [p for p in fe.get('panels') or [] if isinstance(p, dict)]
    rows = {(p.get('layoutRow') if p.get('layoutRow') is not None else (1 if p.get('layoutPosition') == 'column' else 0))
            for p in panels if not p.get('collapsed')} or {0}
    collapsed_rows = set(fe.get('collapsedRows') or [])
    expanded = max(1, len(rows - collapsed_rows))
    area = _num(layout.get('height'), 0) or DEFAULT_PANEL_HEIGHT
    reserved = ROW_COLLAPSE_BAR_HEIGHT * len(rows)
    panel_h = max(200, math.floor((area - reserved) / expanded))
    fe_panel = next((p for p in panels if str(p.get('id')) == ctx.panel.id), {})
    height = max(MIN_READ_TRACK_HEIGHT, panel_h - _fixed_height(ctx, fe_panel))
    cov_row = next((t for t in ctx.panel.tracks if t.type == 'coverage'), None)
    return height - _coverage_height(fe, cov_row, 'coverage' not in (getattr(ctx.panel, 'rows_off', set()) or set()))


# --------------------------------------------------------------------------
# which reads (useReadTrackData.ts)
# --------------------------------------------------------------------------
def _hydrate(read: dict) -> dict:
    """hydrateDerivedReadLayers: nuc derived from the primary stream."""
    if 'nuc' not in (read.get('derived_layers') or []) or (read.get('layers') or {}).get('nuc'):
        return read
    nuc = [iv for iv in read.get('intervals') or [] if iv[2] > 0]
    if not nuc:
        return read
    out = dict(read)
    out['layers'] = {**(read.get('layers') or {}), 'nuc': {'intervals': nuc}}
    return out


def _fetch(ctx: TrackContext, plan: dict, max_reads: int, filter_param: str, server_meta: bool,
           profile_cap: int) -> dict:
    """The exact /api/reads/compact request useReadTrackData.ts sends for this panel.

    DataCache.compact_reads can't express every parameter the browser sends
    (min_footprints, include_layer_qualities=false, the metaprofile request),
    and those change which reads the server samples, so the request is
    issued here through DataCache.get with a key of all its parameters.
    """
    from services.read_endpoint import compact_reads_payload_for_request
    from services.lift.capability import require

    # Figure read tracks paint extent hulls: refused for live-lift datasets (§3.10).
    require(ctx.state.get_dataset(ctx.panel.dataset_id) if hasattr(ctx.state, 'get_dataset') else None, 'figure')
    fe, ds = ctx.fe, ctx.panel.dataset
    meta_layers = sorted(_active_metaprofile_ids(fe)) if server_meta else []
    params = dict(
        chrom=ctx.chrom, start=ctx.start, end=ctx.end, max_reads=int(max_reads),
        spanning=bool(fe.get('spanningOnly')), dataset_id=ctx.panel.dataset_id,
        include_methylation=bool(plan['methylation']), include_layers=bool(plan['needs_layers']),
        layer_names=','.join(plan['layers']) or None, include_layer_qualities=bool(plan['qualities']),
        ml_threshold=125,
        fill_gap_size=int(_num(fe.get('fillGapSize'), 0)) if fe.get('fillSmallGaps') and _num(fe.get('fillGapSize'), 0) > 0 else None,
        min_fp_quality=int(_num(fe.get('minFpQuality'), 0)) if ds.get('data_type') == 'bam' else 0,
        min_footprints=int(_num(fe.get('minFootprints', 5), 5)),
        filter_ids=filter_param or None,
        hide_terminal_gaps=bool(fe.get('hideTerminalGaps', True)),
        terminal_gap_threshold=int(_num(fe.get('terminalGapThreshold'), 500)),
        infer_legacy_layers=bool(fe.get('legacyLayerInference', True)),
        legacy_nuc_min_size=int(_num(fe.get('legacyNucMinSize'), 90)),
        include_duplicates=bool(fe.get('showDuplicateReads')),
        include_metaprofile=bool(server_meta),
        profile_max_reads=int(profile_cap) if server_meta else 1000,
        metaprofile_layers=','.join(meta_layers) or None,
        sample_seed=fe.get('analysisSampleSeed') or DEFAULT_SEED,
        strand=ctx.panel.strand,
        # SV display (fb-n9-sv): each read's events and the panel's SV summary.
        min_sv_len=sv.settings(fe)[1],
        include_sv_summary=sv.settings(fe)[0] and ds.get('data_type') == 'bam',
    )
    if ctx.panel.strand:
        params['include_methylation'] = True  # a read's strand comes from its deamination marks
    key = ('reads-compact',) + tuple(sorted((k, v) for k, v in params.items()))
    return ctx.data.get(key, lambda: compact_reads_payload_for_request(ctx.state, **params))


def _display(ctx: TrackContext) -> dict:
    """Memoized per panel: the reads the browser draws, in order, plus counts."""
    key = ('reads-view', ctx.panel.id, ctx.panel.strand) + ctx.region
    return ctx.data.get(key, lambda: _compute_display(ctx))


def _compute_display(ctx: TrackContext) -> dict:
    fe, spec, panel = ctx.fe, ctx.spec, ctx.panel
    st = _panel_state(fe, panel.state_key)
    plan = _request_plan(fe, panel.dataset)
    region = ctx.end - ctx.start
    max_region = _num(fe.get('maxRegionForReads'), 100_000)
    n_datasets = len(getattr(ctx.state, 'datasets', {}) or {}) or len(spec.panels)
    # canUseServerMetaprofile (ReadTrack.tsx)
    use_server_meta = (plan['server_meta_ok'] and not st['has_cluster'] and n_datasets <= 1
                       and (st['filter'] is None or 0 < len(st['filter']) <= 5000))
    base = {'state': st, 'plan': plan, 'reads': [], 'pool': [], 'payload': {}, 'zoomed_out': region > max_region,
            'use_server_meta': use_server_meta}
    if base['zoomed_out']:
        return base

    display_max = max(1, min(50_000, int(_num(fe.get('allReadsDisplayCap'), 0) or DEFAULT_ALL_READS_DISPLAY_CAP)))
    bg_cap = fe.get('backgroundReadCap')
    profile_cap = 0 if bg_cap is None else max(1, min(1_000_000, int(_num(bg_cap, 1000))))
    mode = fe.get('readDisplayMode') or 'sample'
    downsample = fe.get('downsampleCount')
    if spec.max_reads:
        fit_limit = max(1, int(spec.max_reads))
        desired = fit_limit
        sample_display = mode != 'all'
    elif mode == 'all':
        fit_limit = math.inf
        desired = display_max
        sample_display = False
    else:
        capacity = display_capacity(_read_area_height(ctx), fe.get('readRowHeight', 1),
                                    fe.get('readSeparatorMode') or 'auto',
                                    _num(fe.get('readSeparatorMinHeight'), 3), _num(fe.get('readSeparatorWidth'), 1))
        fit_limit = min(downsample if downsample and downsample > 0 else math.inf, capacity, display_max)
        desired = fit_limit
        sample_display = True
    fetch_cap = max(1, math.floor(desired))

    clustered = set(st['assignments']) or None
    filter_param = request_filter_param(
        st['branch_ids'] if st['branch_active'] else None,
        st['filter'],
        st['root_focus_ids'],
        clustered,
    )
    if st['branch_active'] and not st['branch_ids']:
        filter_param = request_filter_param(set(), st['filter'], st['root_focus_ids'], clustered)
    cohort = st['root_focus_ids'] or clustered
    full_pool = bool(cohort) and not filter_param
    if full_pool:
        max_reads = 0
    elif use_server_meta:
        max_reads = fetch_cap
    else:
        max_reads = 0 if profile_cap == 0 else max(profile_cap, fetch_cap)

    payload = _fetch(ctx, plan, max_reads, filter_param, use_server_meta, profile_cap) or {}
    reads = [_hydrate(r) for r in payload.get('reads') or []]

    if not fe.get('showDuplicateReads'):
        reads = [r for r in reads if not r.get('duplicate')]
    if st['filter'] is not None:
        # An applied filter matching no reads shows none (useReadTrackData.ts).
        expanded = st['filter'] | {strip_segment_suffix(i) for i in st['filter']}
        reads = [r for r in reads if r['id'] in expanded or strip_segment_suffix(r['id']) in expanded]
    if st['branch_active']:
        ids = st['branch_ids']
        if not ids:
            reads = []
        else:
            expanded = ids | {strip_segment_suffix(i) for i in ids}
            reads = [r for r in reads if r['id'] in expanded or strip_segment_suffix(r['id']) in expanded]
    assignments = st['assignments']
    if st['focus']:
        reads = [r for r in reads if cluster_for(assignments, r['id']) in st['focus']]

    order, sort = st['order'], st['sort']
    if sort and st['has_cluster'] and order:
        cpos = {c: i for i, c in enumerate(order)}
        rpos = {r: i for i, r in enumerate(sort)}
        reads = sorted(reads, key=lambda r: (cpos.get(_c999(assignments, r['id']), 999), rpos.get(r['id'], 999999)))
    elif sort:
        rpos = {r: i for i, r in enumerate(sort)}
        reads = sorted(reads, key=lambda r: rpos.get(r['id'], 999999))
    elif st['has_cluster'] and order:
        cpos = {c: i for i, c in enumerate(order)}
        reads = sorted(reads, key=lambda r: cpos.get(_c999(assignments, r['id']), 999))
    elif st['has_cluster']:
        reads = sorted(reads, key=lambda r: _c999(assignments, r['id']))

    seed = fe.get('analysisSampleSeed') or DEFAULT_SEED
    if sample_display:
        shown = sample_reads_for_fit(reads, max(1, math.floor(fit_limit)), seed)
    else:
        # An explicit max_reads also caps "all reads" mode.
        shown = reads[:min(display_max, math.floor(fit_limit)) if math.isfinite(fit_limit) else display_max]
    # profileReads: the metaprofile's pool is the sorted reads, not the drawn sample.
    pool = reads if profile_cap == 0 else sample_reads_for_fit(reads, profile_cap, seed)
    return {**base, 'reads': shown, 'pool': pool, 'use_server_meta': use_server_meta,
            'payload': payload, 'server_count': len(payload.get('reads') or [])}


def display_read_ids(ctx: TrackContext) -> list:
    """The reads this panel draws (the browser's activeReadIds), e.g. for peak scans."""
    return [r['id'] for r in _display(ctx).get('reads') or []]


def profile_view(ctx: TrackContext) -> dict:
    """{pool, use_server_meta, zoomed_out}: what the panel's metaprofile is computed from."""
    view = _display(ctx)
    return {'pool': view.get('pool') or [], 'use_server_meta': bool(view.get('use_server_meta')),
            'zoomed_out': bool(view.get('zoomed_out'))}


def panel_cohort_ids(ctx: TrackContext) -> Optional[list]:
    """Reads the panel is limited to (read filter, cluster branch, cluster focus), or None."""
    st = _panel_state(ctx.fe, ctx.panel.state_key)
    ids: Optional[set] = set(st['filter']) if st['filter'] is not None else None
    if st['branch_active']:
        branch = set(st['branch_ids'] or ())
        ids = branch if ids is None else ids & branch
    if st['focus']:
        focused = {r for r, c in (st['assignments'] or {}).items() if c in st['focus']}
        ids = focused if ids is None else ids & focused
    return sorted(ids) if ids is not None else None


def _c999(assignments, read_id):
    c = cluster_for(assignments, read_id)
    return 999 if c is None else c


# --------------------------------------------------------------------------
# genes + peaks for colormap rule conditions
# --------------------------------------------------------------------------
def _genes(ctx: TrackContext) -> list:
    def load():
        from services.read_auxiliary_endpoint import get_genes_payload
        try:
            payload = get_genes_payload(ctx.state, chrom=ctx.chrom, start=ctx.start, end=ctx.end)
        except Exception:
            return []
        content = payload.get('content') if isinstance(payload, dict) and 'content' in payload else payload
        return list((content or {}).get('genes') or [])
    return ctx.data.get(('genes', ctx.chrom, ctx.start, ctx.end), load)


def _all_peaks(ctx: TrackContext) -> list:
    """getAllPeaks(): peaks of enabled peak rules; auto-scanned like the browser when unknown.

    Only those on this panel's chromosome: a peak without a chrom was scanned
    in the main view; panels at other loci have peaks tagged with theirs.
    """
    def load():
        return [p for p in ctx.data.get(('all_peaks',), lambda: _load_peaks(ctx))
                if (p.get('chrom') or ctx.spec.chrom) == ctx.chrom]
    return ctx.data.get(('all_peaks',) + ctx.region, load)


def _load_peaks(ctx: TrackContext) -> list:
    fe = ctx.fe
    rules = [r for r in fe.get('peakRules') or [] if isinstance(r, dict)]
    by_rule = fe.get('peaksByRule')
    if isinstance(by_rule, dict) or any(p.region for p in ctx.spec.panels):
        # The Peaks track's own peaks: the saved ones, rescanned when they came
        # from another view (a region override) or are missing, and a scan of
        # each region for panels at other loci. Colouring matches what it draws.
        from services.figure.tracks.peaks import peaks_by_rule
        found = peaks_by_rule(ctx)
        return [p for r in rules if r.get('enabled') for p in found.get(r.get('id')) or [] if isinstance(p, dict)]
    if fe.get('peaksLocked'):
        return []
    try:
        from models.requests import ScanPeaksRequest
        from services.clustering_endpoint import run_scan_peaks_endpoint
    except Exception:
        return []
    spec = ctx.spec
    # Every panel of a dataset counts (CT and GA panels, a filtered copy): the
    # union of what they show, as the browser's collectScanReadIds does.
    ids_by_ds: dict = {}
    for panel in spec.panels:
        other = TrackContext(ctx.state, spec, panel, ctx.data, ctx.width)
        shown = _display(other)['reads']
        if shown:
            ids = ids_by_ds.setdefault(panel.dataset_id, [])
            have = set(ids)
            ids.extend(r['id'] for r in shown if r['id'] not in have)
    if not ids_by_ds:
        return []
    datasets = list(dict.fromkeys(p.dataset_id for p in spec.panels))
    peaks = []
    for rule in rules:
        if not rule.get('enabled') or rule.get('source') == 'custom' or not is_read_signal_source(rule.get('source')):
            continue
        th = list(rule.get('thresholds') or [0.5, 0.3, 0.15, 0.08]) + [0.5, 0.3, 0.15, 0.08]
        req = ScanPeaksRequest(
            min_width=int(rule.get('minPeakWidth') or 80), min_reads=int(rule.get('minReads') or 5),
            smooth_width=int(rule.get('smoothWidth') or 100),
            threshold_strong=th[0], threshold_medium=th[1], threshold_weak=th[2], threshold_rare=th[3],
            read_ids_by_dataset=ids_by_ds, dataset_ids=list(ids_by_ds), signal_source=rule.get('source'),
            return_signal=False, sample_seed=fe.get('analysisSampleSeed') or DEFAULT_SEED,
        )
        try:
            res = run_scan_peaks_endpoint(state=ctx.state, req=req, chrom=ctx.chrom, start=ctx.start, end=ctx.end,
                                          dataset_id=datasets[0] if len(datasets) == 1 else None, spanning=False)
        except Exception:
            continue
        peaks.extend(p for p in res.get('peaks') or [] if isinstance(p, dict))
    return peaks


# --------------------------------------------------------------------------
# measure
# --------------------------------------------------------------------------
def _geometry(ctx: TrackContext) -> dict:
    fe = ctx.fe
    rh = _row_height(ctx.spec, fe)
    gap = row_gap(rh, fe.get('readSeparatorMode') or 'auto', _num(fe.get('readSeparatorMinHeight'), 3),
                  _num(fe.get('readSeparatorWidth'), 1))
    # The SV and coverage rows (their own tracks in the browser, fb-n11-tracks) sit above the reads,
    # at their own heights; here they are drawn at the top of the reads.
    # A panel with SV / coverage rows of its own draws them where they sit (the 'sv' and 'coverage'
    # modules below); without them (a spec built by hand, an older client) they go on top of the reads.
    rows = {t.type: t for t in ctx.panel.tracks}
    off = getattr(ctx.panel, 'rows_off', set()) or set()
    cov = _coverage_height(fe, None, 'coverage' not in off and 'coverage' not in rows)
    summary = sv.visible_summary(_display(ctx).get('payload') or {}, fe) if ctx.panel.dataset.get('data_type') == 'bam' else None
    band = sv.band_height(summary, fe, None, 'sv' not in off and 'sv' not in rows)
    return {'rh': rh, 'gap': gap, 'stride': rh + gap, 'hist': cov + band, 'cov': cov, 'sv_band': band,
            'sv_summary': summary, 'sidebar': SIDEBAR_WIDTH if _has_any_clusters(fe) else 0}


def measure(ctx: TrackContext, track) -> float:
    view = _display(ctx)
    if view['zoomed_out']:
        return float(track.height or MIN_READ_TRACK_HEIGHT)
    geo = _geometry(ctx)
    n = len(view['reads'])
    if n == 0:
        return float(geo['hist'] + EMPTY_HEIGHT)
    return float(geo['hist'] + math.ceil(n * geo['stride']))


# --------------------------------------------------------------------------
# draw
# --------------------------------------------------------------------------
class _Flat:
    """One layer's intervals over all displayed reads, as arrays."""

    def __init__(self, rows, ivs, per_read, n_total):
        self.rows = rows
        self.s, self.e, self.size = ivs[:, 0], ivs[:, 1], ivs[:, 2]
        self.per_read = per_read            # [(row, layer dict, offset, count)]
        self.n = n_total


def _flatten(reads: list, getter) -> Optional[_Flat]:
    rows, chunks, per_read, offset = [], [], [], 0
    for row, read in enumerate(reads):
        layer = getter(read)
        if not layer:
            continue
        ivs = layer.get('intervals') or []
        if not ivs:
            continue
        rows.append(np.full(len(ivs), row, dtype=np.int64))
        chunks.append(ivs)
        per_read.append((row, layer, offset, len(ivs)))
        offset += len(ivs)
    if not offset:
        return None
    arr = np.array(list(chain.from_iterable(chunks)), dtype=np.float64).reshape(-1, 3)
    return _Flat(np.concatenate(rows), arr, per_read, offset)


def _flat_qualities(flat: _Flat, names: Optional[set] = None) -> dict:
    """{quality name: (N,) float array, NaN where the interval lacks it}."""
    out: dict[str, np.ndarray] = {}
    for _, layer, off, cnt in flat.per_read:
        qn = layer.get('quality_names') or []
        qs = layer.get('qualities') or []
        for qi, name in enumerate(qn):
            if names is not None and name not in names:
                continue
            if name not in out:
                out[name] = np.full(flat.n, np.nan)
            row = qs[qi] if qi < len(qs) else None
            if row:
                vals = np.array([np.nan if v is None else v for v in row[:cnt]], dtype=float)
                out[name][off:off + len(vals)] = vals
    return out


def _flat_strings(flat: _Flat, field: str) -> Optional[np.ndarray]:
    if not any(layer.get(field) for _, layer, _, _ in flat.per_read):
        return None
    out = np.full(flat.n, '', dtype=object)
    for _, layer, off, cnt in flat.per_read:
        vals = layer.get(field) or []
        for i, v in enumerate(vals[:cnt]):
            out[off + i] = v or ''
    return out


class _Painter:
    """Shared drawing state: coordinates, opacity helpers, raster."""

    def __init__(self, ctx: TrackContext, geo: dict, n_rows: int, scale: float):
        fe = ctx.fe
        self.ctx = ctx
        self.fe = fe
        self.cmap = fe.get('activeColormap') or {}
        self.width = ctx.width
        self.sidebar = geo['sidebar']
        self.region = ctx.end - ctx.start
        self.scale = (self.width - self.sidebar) / max(1, self.region)
        self.rev = bool(fe.get('isReversed'))
        self.rh, self.gap = geo['rh'], geo['gap']
        self.fh = self.rh - self.gap                 # rowHeight - rowGap
        bg = rc.normalize_hex(self.cmap.get('noReadBackgroundColor', self.cmap.get('backgroundColor')), '#ffffff')
        self.raster = RowRaster(n_rows, self.width, geo['stride'], scale, rc.rgb(bg))
        self.fill_band = (0.0, self.fh)
        self.border_band = (self.fh - 1, self.fh)
        # Per-row (x0, x1) of each read's drawn body while its calls are drawn
        # (withReadBodyClip in ReadTrackCanvas.ts); None = no clip.
        self.body_x: Optional[tuple[np.ndarray, np.ndarray]] = None

    def x(self, rel):
        rel = np.asarray(rel, dtype=np.float64)
        return self.sidebar + (self.region - rel) * self.scale if self.rev else self.sidebar + rel * self.scale

    def span(self, a, b, min_w: float = 1.0):
        """Genomic span -> (x0, x1) with the browser's max(1, w) minimum width."""
        xa, xb = self.x(a), self.x(b)
        x0 = np.minimum(xa, xb)
        return x0, x0 + np.maximum(min_w, np.abs(xb - xa))

    def layer_opacity(self, name: str, fallback: float) -> float:
        disp = rc.display_layer(name)
        ops = self.cmap.get('layerOpacities') or {}
        raw = ops.get(disp, ops.get(name, fallback))
        return max(0.0, min(1.0, _num(raw, fallback)))

    def layer_bg_opacity(self, name: str) -> float:
        disp = rc.display_layer(name)
        ops = self.cmap.get('layerBackgroundOpacities') or {}
        return rc.clamp01(ops.get(disp, ops.get(name, 1)))

    def add(self, band, rows, x0, x1, color, alpha, clip=True):
        if clip and self.body_x is not None:
            rows = np.asarray(rows, dtype=np.int64)
            if rows.size:
                idx = np.clip(rows, 0, len(self.body_x[0]) - 1)
                x0 = np.maximum(np.broadcast_to(np.asarray(x0, dtype=np.float64), rows.shape), self.body_x[0][idx])
                x1 = np.minimum(np.broadcast_to(np.asarray(x1, dtype=np.float64), rows.shape), self.body_x[1][idx])
        self.raster.add(band, rows, x0, x1, color, alpha, clip_left=self.sidebar if clip else 0.0)

    def soft_rect(self, rows, x0, w, color, alpha, gap_l, gap_r, soft_mask):
        """drawStrictToLooseSoftEdgeRect for the rows in soft_mask; plain fills otherwise."""
        use = soft_mask & (self.fh >= 4) & ((gap_l >= 0.5) | (gap_r >= 0.5)) & (alpha > 0)
        plain = ~use
        self.add(self.fill_band, rows[plain], x0[plain], x0[plain] + w[plain], color[plain], alpha[plain])
        if not use.any():
            return
        r, x, ww, c, a = rows[use], x0[use], w[use], color[use], alpha[use]
        self.add(self.fill_band, r, x, x + ww, c, a)
        for gaps, left in ((gap_l[use], True), (gap_r[use], False)):
            ok = gaps >= 0.5
            steps = np.where(gaps >= 6, 3, np.where(gaps >= 2, 2, 1))
            start = np.where(left, x - gaps, x + ww)
            for i in range(3):
                m = ok & (i < steps)
                if not m.any():
                    continue
                st = steps[m].astype(float)
                seg0 = start[m] + i / st * gaps[m]
                seg1 = start[m] + (i + 1) / st * gaps[m]
                segw = np.maximum(0.5, seg1 - seg0)
                t = (i + 0.5) / st
                t = t if left else 1 - t
                self.add(self.fill_band, r[m], seg0, seg0 + segw, c[m], a[m] * np.clip(t, 0.08, 0.9))


def _extent(read: dict):
    """getCompactReadExtent."""
    lo, hi = math.inf, -math.inf
    for iv in read.get('intervals') or []:
        lo, hi = min(lo, iv[0]), max(hi, iv[1])
    if hi > lo:
        return lo, hi
    for layer in (read.get('layers') or {}).values():
        for iv in (layer or {}).get('intervals') or []:
            lo, hi = min(lo, iv[0]), max(hi, iv[1])
    for iv in read.get('fire') or []:
        lo, hi = min(lo, iv[0]), max(hi, iv[1])
    for pos in chain(read.get('methyl_m6a') or read.get('methyl') or [], read.get('methyl_m5c') or [],
                     (d[0] for d in read.get('deam') or [])):
        lo, hi = min(lo, pos), max(hi, pos + 1)
    return (lo, hi) if hi > lo else None


def _group_on_chrom(group: dict, chrom) -> bool:
    ref = group.get('referenceChrom')
    if not ref or group.get('referenceAbsStart') is None or not chrom:
        return True
    from utils.chrom import same_chrom
    return same_chrom(str(ref), str(chrom))


def _paint_reads(p: _Painter, reads: list, st: dict, peaks: list, genes: list, dataset: dict):
    ctx, fe, cmap = p.ctx, p.fe, p.cmap
    n = len(reads)
    rows_all = np.arange(n)
    enabled = fe.get('enabledModTypes') or {}
    rules = [r for r in cmap.get('rules') or [] if isinstance(r, dict)]
    from services.figure.tracks.composite import RuleTracks
    rctx = rc.RuleContext(genes, peaks, ctx.start, ctx.end, ctx.chrom, tracks=RuleTracks(ctx))
    # A definition pinned to a position on another chromosome doesn't apply
    # here (the browser's rule); one without a position applies everywhere.
    all_groups = [g for g in fe.get('footprintGroups') or []
                  if isinstance(g, dict) and _group_on_chrom(g, ctx.chrom)]
    groups = [g for g in all_groups if g.get('enabled')]
    layer_colors = {k: v.get('color') for k, v in (dataset.get('derived_layers') or {}).items()
                    if isinstance(v, dict) and v.get('color')}
    targeted = set()
    for rule in rules:
        for t in rule.get('targetLayers') or []:
            targeted.add(t)
            if t == 'fire':
                targeted.add('msp')
            if t == 'msp':
                targeted.add('fire')

    def has_targeted(name):
        return name in targeted or rc.display_layer(name) in targeted

    edge = cmap.get('edgeAmbiguity') or {'mode': 'strict', 'applyNuc': True, 'applyTf': True, 'maxGapBp': 30}
    edge_mode = edge.get('mode') or 'strict'
    max_gap = _num(edge.get('maxGapBp'), 30)

    def gap_bp(q):
        return max_gap * (1 - np.clip(np.nan_to_num(q, nan=255.0), 0, 255) / 255)

    # --- cluster sidebar (drawn before the genomic clip) --------------------
    p.raster.phase()
    if st['has_cluster'] and p.sidebar > 0:
        rows, cols, alphas = [], [], []
        for i, read in enumerate(reads):
            c = cluster_for(st['assignments'], read['id'])
            if c is None:
                continue
            focused = bool(st['focus']) and c in st['focus']
            rows.append(i)
            cols.append(rc.rgb(rc.cluster_color(c)))
            alphas.append(1.0 if focused else 0x66 / 255)
        if rows:
            p.add(p.fill_band, np.array(rows), 0.0, p.sidebar - 2, np.array(cols), np.array(alphas), clip=False)

    # --- read backgrounds -------------------------------------------------
    p.raster.phase()
    read_bg = rc.rgb(rc.normalize_hex(cmap.get('readBackgroundColor'), '#f1f5f9'))
    ext = [_extent(r) for r in reads]
    has = np.array([e is not None for e in ext], dtype=bool)
    body_x0, body_x1 = np.full(n, -np.inf), np.full(n, np.inf)
    if has.any():
        lo = np.array([e[0] if e else 0 for e in ext], float)[has]
        hi = np.array([e[1] if e else 0 for e in ext], float)[has]
        cs, ce = np.maximum(0, lo), np.minimum(p.region, hi)
        ok = ce > cs
        x0, x1 = p.span(cs[ok], ce[ok])
        p.add((0.0, max(1.0, p.fh)), rows_all[has][ok], x0, x1, read_bg, 1.0)
        # A read's calls are drawn inside its body only (an MSP in a hidden
        # terminal gap is not left floating off the read); a read whose body
        # is out of view draws none.
        body_x0[has], body_x1[has] = 0.0, 0.0
        rows_ok = rows_all[has][ok]
        body_x0[rows_ok], body_x1[rows_ok] = x0, x1
    p.body_x = (body_x0, body_x1)

    # --- overlay layers (FIRE first, the rest after the primary) ------------
    layer_names: list[str] = []
    for read in reads:
        for name in (read.get('layers') or {}):
            if name not in layer_names:
                layer_names.append(name)
    first_seen = {nm: i for i, nm in enumerate(layer_names)}
    layer_names.sort(key=lambda nm: (rc.layer_render_rank(nm), first_seen[nm]))
    fire_layers = [nm for nm in layer_names if nm in ('msp', 'fire')]
    other_layers = [nm for nm in layer_names if nm not in ('msp', 'fire', 'nuc')]

    for name in fire_layers:
        _paint_overlay(p, reads, name, enabled, rules, rctx, groups, all_groups, layer_colors,
                       has_targeted, edge, edge_mode, gap_bp)

    # --- legacy FIRE (read.fire when there is no msp/fire layer) -----------
    if enabled.get('fire'):
        legacy = [(i, r) for i, r in enumerate(reads)
                  if not (r.get('layers') or {}).get('msp') and not (r.get('layers') or {}).get('fire') and r.get('fire')]
        if legacy:
            flat = _flatten([r for _, r in legacy], lambda r: {'intervals': r.get('fire')})
            rows = np.array([legacy[i][0] for i in flat.rows])
            q = np.where(np.isfinite(flat.size), flat.size, 255.0)
            fs, fe_ = flat.s, flat.e
            size = fe_ - fs
            vis = ~((fe_ < 0) | (fs > p.region))
            color = np.broadcast_to(rc.rgb(rc.MOD_COLORS['fire']), (flat.n, 3)).copy()
            vo = np.ones(flat.n, np.float32)
            if has_targeted('fire'):
                m, cols, ops = rc.match_rules(rules, rctx, fs, fe_, size, 'fire', {'aq': q}, None,
                                              eligible=lambda rule: bool(rule.get('targetLayers'))
                                              and rc.rule_targets_layer(rule, 'fire'))
                color[m] = cols[m]
                vo = np.where(m, ops, p.layer_bg_opacity('fire')).astype(np.float32)
            keep = vis & (vo > 0)
            x0, x1 = p.span(np.maximum(0, fs), np.minimum(p.region, fe_))
            alpha = np.round(255 * p.layer_opacity('fire', 0.55) * vo * (0.35 + 0.65 * (q / 255))) / 255
            p.raster.phase()
            p.add(p.fill_band, rows[keep], x0[keep], x1[keep], color[keep], alpha[keep])
            p.raster.phase()
            p.add(p.border_band, rows[keep], x0[keep], x1[keep], color[keep], (np.round(0x90 * vo) / 255)[keep])

    # --- primary nuc / FP --------------------------------------------------
    _paint_primary(p, reads, enabled, rules, rctx, groups, has_targeted, layer_colors, edge, edge_mode, gap_bp)

    # --- base modification marks ------------------------------------------
    _paint_marks(p, reads, enabled, evidence=False)

    for name in other_layers:
        _paint_overlay(p, reads, name, enabled, rules, rctx, groups, all_groups, layer_colors,
                       has_targeted, edge, edge_mode, gap_bp)

    if enabled.get('deam_opportunity'):
        _paint_marks(p, reads, enabled, evidence=True)
    # A deletion breaks the body (ReadTrackCanvas bodyClipRects): its span
    # shows the empty background, over anything painted there (the calls
    # were split at it by the loader, but a soft edge may reach in).
    on, min_len, _collapsed = sv.settings(fe)
    if on and ctx.panel.dataset.get('data_type') == 'bam':
        d_rows, d_s, d_e = sv.deleted_spans(reads, ctx.start, ctx.end, min_len)
        if d_rows.size:
            empty = rc.rgb(rc.normalize_hex(cmap.get('noReadBackgroundColor', cmap.get('backgroundColor')), '#ffffff'))
            xa, xb = p.x(np.maximum(0, d_s)), p.x(np.minimum(p.region, d_e))
            p.raster.phase()
            p.add((0.0, max(1.0, p.fh)), d_rows, np.minimum(xa, xb), np.maximum(xa, xb), empty, 1.0, clip=False)
    p.body_x = None


def _paint_primary(p: _Painter, reads, enabled, rules, rctx, groups, has_targeted, layer_colors, edge, edge_mode, gap_bp):
    ctx = p.ctx
    ds = ctx.panel.dataset
    layer_type = ds.get('layer_type')
    toggle = layer_type if (ds.get('data_type') != 'bam' and layer_type and layer_type not in ('footprint', 'bam')) else 'footprint'
    for layer_name in ('nuc', 'footprint'):
        if layer_name == 'nuc':
            sel = [(i, r) for i, r in enumerate(reads) if (r.get('layers') or {}).get('nuc')]
            on = enabled.get('nuc', True)
            getter = lambda r: r['layers']['nuc']  # noqa: E731
        else:
            sel = [(i, r) for i, r in enumerate(reads) if not (r.get('layers') or {}).get('nuc')]
            on = enabled.get(toggle, True)
            getter = lambda r: {'intervals': [iv for iv in r.get('intervals') or [] if iv[2] > 0],  # noqa: E731
                                'quality_names': ['q'] if r.get('qualities') else [],
                                'qualities': [r.get('qualities')] if r.get('qualities') else []}
        if not sel or not on:
            continue
        flat = _flatten([r for _, r in sel], getter)
        if flat is None:
            continue
        rows = np.array([sel[i][0] for i in flat.rows])
        s, e, size = flat.s, flat.e, flat.size
        pos = size > 0
        quals = _flat_qualities(flat)
        if layer_name == 'nuc':
            first = None
            for _, layer, _, _ in flat.per_read:
                if layer.get('quality_names'):
                    first = layer['quality_names'][0]
                    break
            quality = quals.get(first) if first else None
            ql = quals.get('el', quals.get('lq'))
            qr = quals.get('er', quals.get('rq'))
            edge_on = np.zeros(flat.n, bool)
            if edge.get('applyNuc', True) and (ql is not None or qr is not None):
                edge_on = (~np.isnan(ql) if ql is not None else False) | (~np.isnan(qr) if qr is not None else False)
                edge_on = np.asarray(edge_on, bool)
        else:
            quality = quals.get('q')
            ql = qr = None
            edge_on = np.zeros(flat.n, bool)
        gl = np.where(edge_on, gap_bp(ql) if ql is not None else 0.0, 0.0)
        gr = np.where(edge_on, gap_bp(qr) if qr is not None else 0.0, 0.0)
        ds_, de_ = s.copy(), e.copy()
        if edge_mode == 'loose':
            ds_ = np.where(edge_on, s - gl, s)
            de_ = np.where(edge_on, e + gr, e)
        soft = edge_on & (edge_mode == 'soft')
        vs = np.where(soft, s - gl, ds_)
        ve = np.where(soft, e + gr, de_)
        keep = pos & ~((ve < 0) | (vs > p.region))

        color = np.broadcast_to(rc.rgb(rc.UNMATCHED_COLOR), (flat.n, 3)).copy()
        vo = np.ones(flat.n, np.float32)
        cart_hit, cart_cols = rc.cart_match(groups, ctx.start + s, ctx.start + e, size, layer_name, active=keep)
        color[cart_hit] = cart_cols[cart_hit]
        m, cols, ops = rc.match_rules(rules, rctx, s, e, size, layer_name, active=keep & ~cart_hit)
        color[m] = cols[m]
        vo[m] = ops[m]
        matched = cart_hit | m
        if has_targeted(layer_name):
            un = ~matched
            color[un] = rc.layer_color_rgb(layer_name, layer_colors)
            vo[un] = p.layer_bg_opacity(layer_name)
        keep &= vo > 0
        alpha = (p.layer_opacity(layer_name, 1.0 if layer_name == 'nuc' else 0.85) * vo).astype(np.float64)
        qs = p.cmap.get('qualityShading') or {}
        if qs.get('enabled') and qs.get('mode') == 'quality' and quality is not None:
            has_q = ~np.isnan(quality)
            qv = np.nan_to_num(quality) / 255
            t = 1 - qv if qs.get('invert') else qv
            a2 = _num(qs.get('minOpacity'), 0.2) + t * (_num(qs.get('maxOpacity'), 1) - _num(qs.get('minOpacity'), 0.2))
            if qs.get('vizMode', 'opacity') in ('opacity', 'both'):
                alpha = np.where(has_q, a2 * alpha, alpha)
        alpha = np.clip(alpha, 0, 1)
        x0, x1 = p.span(ds_, de_)
        gvl = (gr if p.rev else gl) * p.scale
        gvr = (gl if p.rev else gr) * p.scale
        p.raster.phase()
        k = keep
        p.soft_rect(rows[k], x0[k], (x1 - x0)[k], color[k], alpha[k], gvl[k], gvr[k], soft[k])


def _paint_marks(p: _Painter, reads, enabled, evidence: bool):
    mh = max(2.0, p.fh)
    mw = max(1.0, p.scale * 0.8)
    band = (0.0, mh)

    def marks(field_getter, color, opacity, band_=band):
        rows, pos = [], []
        for i, r in enumerate(reads):
            vals = field_getter(r)
            if vals:
                rows.append(np.full(len(vals), i))
                pos.append(np.asarray(vals, float))
        if not rows:
            return
        rows_a, pos_a = np.concatenate(rows), np.concatenate(pos)
        ok = (pos_a >= 0) & (pos_a <= p.region)
        x = p.x(pos_a[ok])
        p.raster.phase()
        p.add(band_, rows_a[ok], x - mw / 2, x + mw / 2, rc.rgb(color), opacity)

    if not evidence and (enabled.get('m6a') or enabled.get('mod')):
        marks(m6a_positions,
              rc.MOD_COLORS['m6a'], p.layer_opacity('m6a', 1))
    if not evidence and enabled.get('m5c'):
        marks(lambda r: r.get('methyl_m5c'), rc.MOD_COLORS['m5c'], p.layer_opacity('m5c', 1))
    show_opp = bool(enabled.get('deam_opportunity'))
    if show_opp and evidence:
        op = p.layer_opacity('deam_opportunity', 1)
        tick = max(1.0, min(3.0, math.floor(mh / 3)))
        marks(lambda r: r.get('possible_deam_ct'), rc.MOD_COLORS['deam_possible_ct'], op, (0.0, tick))
        marks(lambda r: r.get('possible_deam_ga'), rc.MOD_COLORS['deam_possible_ga'], op, (mh - tick, mh))
    if enabled.get('deam') and evidence == show_opp:
        op = p.layer_opacity('deam', 1)
        if show_opp:
            marks(lambda r: [d[0] for d in r.get('deam') or []], rc.MOD_COLORS['deam_observed'], op)
        else:
            marks(lambda r: [d[0] for d in r.get('deam') or [] if d[1] != 1], rc.MOD_COLORS['deam_r'], op)
            marks(lambda r: [d[0] for d in r.get('deam') or [] if d[1] == 1], rc.MOD_COLORS['deam_y'], op)


def _consensus_record_color(record: dict, colors: dict) -> str:
    """consensusRecordColor (consensusVisual.ts): a call's best-fit class colour."""
    from services.figure.tracks.consensus import family_color
    if record.get('manual_ignored') or record.get('classification_status') == 'manual_ignored':
        return '#94a3b8'
    if record.get('manual_group_id'):
        return family_color(str(record['manual_group_id']), colors)
    if record.get('classification_status') == 'provisional_unresolved':
        return '#9ba6ae'
    if record.get('family'):
        return family_color(str(record['family']), colors)
    kind = record.get('kind')
    if kind == 'recaller_broader':
        return '#b4bec8'
    if kind == 'new_recall':
        return '#db2777'
    if kind == 'internal_accessible_separator':
        return '#e9a123'
    if kind in ('projection_equivalent_normalization', 'likelihood_compatible_edge_change'):
        return '#8b5cf6'
    return '#328b7b' if kind == 'alternative_protected_piece' else '#9ba6ae'


def _paint_consensus_records(p: _Painter, rows, flat: _Flat, name: str) -> None:
    """ReadTrackCanvas: consensus-workflow layers paint each frozen per-unit span in its class colour.

    No Cart, rule, quality or family-median geometry applies to these calls.
    """
    from services.figure.tracks.consensus import load_catalog, palette
    colors: dict = {}
    for job_id in {layer.get('job_id') for _, layer, _, _ in flat.per_read if layer.get('job_id')}:
        catalog, _ = load_catalog(p.ctx, str(job_id))
        if catalog:
            colors.update(palette(catalog))
    n = flat.n
    fill = np.zeros((n, 3), np.float64)
    alpha = np.zeros(n, np.float32)
    outline = np.zeros(n, bool)
    s_in, e_in = flat.s.astype(float).copy(), flat.e.astype(float).copy()     # drawn span
    s_out, e_out = s_in.copy(), e_in.copy()                                     # soft mode: faint widest span
    edge = p.cmap.get('edgeAmbiguity') or {}
    apply_tf = bool(edge.get('applyTf', True))
    mode = edge.get('mode', 'strict')
    has_range = np.zeros(n, bool)
    rc_stroke = np.zeros(n, bool)      # recaller-added or looser-tier call: thin dark outline
    rc_dashed = np.zeros(n, bool)      # looser tier (edge / overlap): dashed
    for _, layer, off, cnt in flat.per_read:
        records = layer.get('consensus_records') or []
        for i in range(cnt):
            record = records[i] if i < len(records) else {}
            fill[off + i] = rc.rgb(_consensus_record_color(record, colors))
            outline[off + i] = layer.get('draw_style') == 'outline'
            alpha[off + i] = 0.5 if name == 'tf_native_replay' else 0.95
            # Looser-tier calls take their edges from the class and the molecule's protected run: drawn whole. Edge
            # ranges apply only while TF edge ambiguity is on (ReadTrackCanvas: edgeAmb.applyTf); otherwise the
            # supplied span is drawn unchanged.
            looser = name == 'tf_rc' and str(record.get('tier') or '') in ('edge', 'loose')
            if name == 'tf_rc' and (record.get('recaller_added') or looser):
                rc_stroke[off + i] = True
                rc_dashed[off + i] = looser
            er = (record.get('edge_range') if name == 'tf_rc' and apply_tf and not looser
                  and layer.get('draw_style') != 'outline' else None)
            if er:
                # Recaller calls: strict = sure inner span, loose = widest span the marks allow, soft = both.
                lo, hi = (er[0][1], er[1][0]) if er[0][1] < er[1][0] else (record['interval'][0], record['interval'][1])
                if mode == 'loose':
                    lo, hi = er[0][0], er[1][1]
                s_in[off + i], e_in[off + i] = lo - p.ctx.start, hi - p.ctx.start
                s_out[off + i], e_out[off + i] = er[0][0] - p.ctx.start, er[1][1] - p.ctx.start
                has_range[off + i] = mode == 'soft'
    alpha[outline] = 0
    keep = (e_in > 0) & (s_in < p.region)
    if has_range.any():
        o0, o1 = p.span(np.maximum(0, s_out), np.minimum(p.region, e_out))
        k = keep & has_range
        p.raster.phase()
        p.add(p.fill_band, rows[k], o0[k], o1[k], fill[k], np.full(int(k.sum()), .35, np.float32))
    x0, x1 = p.span(np.maximum(0, s_in), np.minimum(p.region, e_in))
    x1 = np.maximum(x1, x0 + 1)
    p.raster.phase()
    p.add(p.fill_band, rows[keep], x0[keep], x1[keep], fill[keep], alpha[keep])
    if outline.any():
        k = keep & outline
        p.raster.phase()
        p.add(p.border_band, rows[k], x0[k], x1[k], fill[k], np.ones(int(k.sum()), np.float32))
    k = keep & rc_stroke
    if k.any():
        # Footprint-class calls the native caller did not make (the recaller's own): a thin dark outline, dashed for
        # calls counted only by a looser rule (edge / overlap). Stroked around the record's supplied span.
        s0, s1 = p.span(np.maximum(0, flat.s.astype(float)), np.minimum(p.region, flat.e.astype(float)))
        _stroke_rects(p, rows[k], s0[k], s1[k], rc_dashed[k])


def _stroke_rects(p: _Painter, rows, x0, x1, dashed) -> None:
    """ctx.strokeRect(x + .25, y + .25, w - .5, h - .5) in #1f2937 at alpha .75, line width min(1, max(.5, h / 4)),
    dashed [2, 1.5] where ``dashed`` (the dash pattern restarts on each side).

    Each vertical band gets its own raster phase: ops of one phase must not share a pixel, and bands that only
    partly cover a pixel line would. The sides run between the top and bottom strokes, so corners are painted once."""
    h = p.fh
    lw = min(1.0, max(0.5, h / 4))
    half = lw / 2
    color = np.asarray(rc.rgb('#1f2937'), np.float64)
    alpha = np.float32(0.75)
    top = 0.25
    bottom = top + max(0.5, h - 0.5)
    left = x0 + 0.25
    right = left + np.maximum(0.5, (x1 - x0) - 0.5)

    def horizontal(band):
        a, b = left - half, right + half
        p.raster.phase()
        solid = ~dashed
        p.add(band, rows[solid], a[solid], b[solid], color, alpha)
        if dashed.any():
            r, a, b = rows[dashed], a[dashed], b[dashed]
            for i in range(int(np.ceil(np.max(b - a) / 3.5)) + 1):
                s0 = a + i * 3.5
                s1 = np.minimum(b, s0 + 2.0)
                m = s1 > s0
                p.add(band, r[m], s0[m], s1[m], color, alpha)

    def vertical(band, sel):
        if not sel.any():
            return
        p.raster.phase()
        # Left and right sides of one rectangle only meet when it is under a pixel wide; the raster splits those.
        p.add(band, np.concatenate([rows[sel], rows[sel]]), np.concatenate([left[sel], right[sel]]) - half,
              np.concatenate([left[sel], right[sel]]) + half, color, alpha)

    horizontal((top - half, top + half))
    horizontal((bottom - half, bottom + half))
    y0, y1 = top + half, bottom - half
    if y1 > y0:
        vertical((y0, y1), ~dashed)
        y = y0
        while y < y1:
            vertical((y, min(y1, y + 2.0)), dashed)
            y += 3.5


def _paint_overlay(p: _Painter, reads, name, enabled, rules, rctx, groups, all_groups, layer_colors,
                   has_targeted, edge, edge_mode, gap_bp):
    ctx, cmap = p.ctx, p.cmap
    is_fire = name in ('msp', 'fire')
    disp = rc.display_layer(name)
    fam_enabled = bool(enabled.get('tf_consensus'))
    base_on = bool(enabled.get('fire') or enabled.get('msp')) if name == 'msp' else bool(enabled.get(name))

    def native(layer):
        return name == 'tf_sr' and 'fi' in (layer.get('quality_names') or [])

    sel = [(i, r) for i, r in enumerate(reads)
           if (r.get('layers') or {}).get(name) and (base_on or (native(r['layers'][name]) and fam_enabled))]
    if not sel:
        return
    flat = _flatten([r for _, r in sel], lambda r: r['layers'][name])
    if flat is None:
        return
    rows = np.array([sel[i][0] for i in flat.rows])
    if all(layer.get('consensus_workflow') and layer.get('consensus_records') for _, layer, _, _ in flat.per_read):
        _paint_consensus_records(p, rows, flat, name)
        return
    n = flat.n
    ls, le, lsize = flat.s, flat.e, flat.size
    size = np.where(np.isfinite(lsize), lsize, le - ls)
    is_tf = name == 'tf'
    is_sr = rc.is_strand_rescue(name)
    consensus_fam = name in ('tf_consensus', 'tf_cross_consensus')
    tf_cfg = cmap.get('tfOverlay') if is_tf else None
    base_color = (tf_cfg.get('color') if tf_cfg and tf_cfg.get('color')
                  else (layer_colors.get(disp) or rc.layer_color(disp)))
    max_op = 1.0 if consensus_fam else p.layer_opacity(disp, _num(tf_cfg.get('maxOpacity'), 0.85) if tf_cfg else 0.65)
    min_op = 1.0 if consensus_fam else min(_num(tf_cfg.get('minOpacity'), 0.2) if tf_cfg else 0.25, max_op)
    min_q = _num(tf_cfg.get('minTq'), 0) if tf_cfg else 0.0

    quals = _flat_qualities(flat)
    # Body quality: q0 for refinement layers, else the layer's first dimension.
    q = np.full(n, 255.0)
    edge_l = np.full(n, np.nan)
    edge_r = np.full(n, np.nan)
    has_edge = np.zeros(n, bool)
    carries_native = np.zeros(n, bool)
    meta_parts = []
    for _, layer, off, cnt in flat.per_read:
        qn = layer.get('quality_names') or []
        qs = layer.get('qualities') or []
        q_idx = (qn.index('q0') if 'q0' in qn else -1) if is_sr else (0 if qn else -1)
        vals = None
        if q_idx >= 0 and q_idx < len(qs) and qs[q_idx]:
            vals = np.array([np.nan if v is None else v for v in qs[q_idx][:cnt]], float)
        fire_unavailable = (is_fire and q_idx >= 0 and qn[q_idx] == 'aq' and vals is not None and len(vals)
                            and all(np.isnan(v) or v in (0, 128) for v in vals))
        if vals is not None and not fire_unavailable:
            seg = np.where(np.isnan(vals), 255.0, vals)
            q[off:off + len(seg)] = seg
        if not is_sr:
            li = qn.index('el') if 'el' in qn else (qn.index('lq') if 'lq' in qn else -1)
            ri = qn.index('er') if 'er' in qn else (qn.index('rq') if 'rq' in qn else -1)
            if li >= 0 or ri >= 0:
                has_edge[off:off + cnt] = True
                for idx, dest in ((li, edge_l), (ri, edge_r)):
                    if idx >= 0 and idx < len(qs) and qs[idx]:
                        v = np.array([np.nan if x is None else x for x in qs[idx][:cnt]], float)
                        dest[off:off + len(v)] = v
        if native(layer):
            carries_native[off:off + cnt] = True
        want_meta = consensus_fam or (native(layer) and fam_enabled)
        meta_parts.append(rc.family_metadata(layer, cnt) if want_meta else None)

    keep = q >= min_q
    meta = None
    if any(m is not None for m in meta_parts):
        meta = {'fid': np.zeros(n, np.int64), 'conf': np.zeros(n), 'kind': np.full(n, '', dtype=object),
                'ann': np.full(n, '', dtype=object)}
        for (_, _, off, cnt), m in zip(flat.per_read, meta_parts):
            if m is not None:
                for k in meta:
                    meta[k][off:off + cnt] = m[k]
    has_meta = meta['fid'] > 0 if meta is not None else np.zeros(n, bool)

    edge_mode_eff = (edge_mode if edge.get('applyTf', True) else 'strict') if is_tf else 'soft'
    gl = np.where(has_edge, gap_bp(edge_l), 0.0)
    gr = np.where(has_edge, gap_bp(edge_r), 0.0)
    src = [layer.get('source_intervals') for _, layer, _, _ in flat.per_read]
    abs_s = ctx.start + ls
    abs_e = ctx.start + le
    if any(src):
        for (_, layer, off, cnt), si in zip(flat.per_read, src):
            for i, iv in enumerate((si or [])[:cnt]):
                if iv:
                    abs_s[off + i] = ctx.start + iv[0]
                    abs_e[off + i] = ctx.start + iv[1]

    a_start, a_end = ls.copy(), le.copy()
    if edge_mode_eff == 'loose':
        a_start = np.where(has_edge, ls - gl, ls)
        a_end = np.where(has_edge, le + gr, le)
    vis_lo = np.where(has_edge & (edge_mode_eff == 'soft'), ls - gl, a_start)
    vis_hi = np.where(has_edge & (edge_mode_eff == 'soft'), le + gr, a_end)

    # Family models (Cart auto-families): fill geometry for mode 'family'.
    if has_meta.any():
        fam_ids = np.flatnonzero(has_meta)
        for i in fam_ids:
            disp_geo = rc.family_display(all_groups, ctx.panel.dataset_id, int(meta['fid'][i]), abs_s[i], abs_e[i],
                                         name, float(meta['conf'][i]), meta['ann'][i] or None)
            if disp_geo is None:
                if name == 'tf_cross_consensus':
                    keep[i] = False
                continue
            _, mode, fs, fe_ = disp_geo
            rs, re_ = fs - ctx.start, fe_ - ctx.start
            if mode == 'family':
                a_start[i], a_end[i] = rs, re_
                vis_lo[i], vis_hi[i] = (rs, re_) if not (has_edge[i] and edge_mode_eff == 'soft') else (vis_lo[i], vis_hi[i])
            elif mode == 'both':
                vis_lo[i], vis_hi[i] = min(vis_lo[i], rs), max(vis_hi[i], re_)
    keep &= ~((vis_hi < 0) | (vis_lo > p.region))

    cart_hit, cart_cols = rc.cart_match(groups, abs_s, abs_e, size, name, meta, active=keep)
    fill = np.broadcast_to(rc.rgb(base_color), (n, 3)).copy()
    if is_sr:
        kinds = _flat_strings(flat, 'refinement_kinds')
        anns = _flat_strings(flat, 'annotation_names')
        baseline = layer_colors.get('nuc' if name == 'nuc_sr' else 'tf') or rc.layer_color('nuc' if name == 'nuc_sr' else 'tf')
        for i in range(n):
            act = rc.rescue_action(kinds[i] if kinds is not None else None, anns[i] if anns is not None else None)
            fill[i] = rc.rgb(rc.rescue_color(name, act, baseline))
    if has_meta.any():
        for i in np.flatnonzero(has_meta):
            fill[i] = rc.rgb(rc.tf_family_color(int(meta['fid'][i]), meta['ann'][i] or None))
    fill[cart_hit] = cart_cols[cart_hit]
    if consensus_fam:
        vo = np.ones(n, np.float32)
    elif meta is not None:
        vo = np.where(np.array([k == 'assignment' for k in meta['kind']]) & has_meta,
                      0.4 + 0.6 * meta['conf'], 1.0).astype(np.float32)
    else:
        vo = np.ones(n, np.float32)
    matched = cart_hit.copy()
    targeted = has_targeted(name)
    if is_tf or targeted:
        anns = _flat_strings(flat, 'annotation_names')
        m, cols, ops = rc.match_rules(
            rules, rctx, ls, le, size, name, quals if quals else None, anns,
            eligible=None if is_tf else (lambda rule: bool(rule.get('targetLayers')) and rc.rule_targets_layer(rule, name)),
            active=keep & ~cart_hit)
        fill[m] = cols[m]
        vo[m] = ops[m]
        matched |= m
    if targeted:
        vo = np.where(matched, vo, p.layer_bg_opacity(disp)).astype(np.float32)
    keep &= vo > 0
    alpha = np.round(255 * vo * (min_op + (max_op - min_op) * (q / 255))) / 255

    x0, x1 = p.span(np.maximum(0, a_start), np.minimum(p.region, a_end))
    soft = has_edge & (edge_mode_eff == 'soft')
    sx0, sx1 = p.span(ls, le)
    body_x = np.where(soft, sx0, x0)
    body_w = np.where(soft, sx1 - sx0, x1 - x0)
    gvl = (gr if p.rev else gl) * p.scale
    gvr = (gl if p.rev else gr) * p.scale
    k = keep
    p.raster.phase()
    # Soft rendering falls back to the plain (clamped) rect when it can't feather.
    can_soft = soft & (p.fh >= 4) & ((gvl >= 0.5) | (gvr >= 0.5))
    bx = np.where(can_soft, body_x, x0)
    bw = np.where(can_soft, body_w, x1 - x0)
    p.soft_rect(rows[k], bx[k], bw[k], fill[k], alpha[k], gvl[k], gvr[k], can_soft[k])
    stage = {'tf_cross_consensus': '#db2777', 'tf_consensus': '#0891b2'}.get(name)
    border = fill if stage is None else np.broadcast_to(rc.rgb(stage), (n, 3))
    p.raster.phase()
    p.add(p.border_band, rows[k], x0[k], x1[k], border[k], (np.round(0x90 * vo) / 255)[k])

    if is_sr:
        # Exact-edge ticks for refined calls (q1/q2 confidence).
        kinds = _flat_strings(flat, 'refinement_kinds')
        anns = _flat_strings(flat, 'annotation_names')
        changed = np.array([rc.rescue_action(kinds[i] if kinds is not None else None,
                                             anns[i] if anns is not None else None) != 'unchanged'
                            for i in range(n)], bool) & k
        ql, qr = quals.get('q1'), quals.get('q2')
        p.raster.phase()
        for pos, conf in ((ls, ql), (le, qr)):
            if conf is None:
                continue
            c = np.nan_to_num(conf, nan=0.0)
            m = changed & (c > 0)
            if not m.any():
                continue
            xs = np.round(p.x(pos[m])) - 1
            p.add((0.0, max(1.0, p.fh)), rows[m], xs, xs + 2, fill[m], np.clip(c[m] / 255, 0.08, 1))


def _vector_decorations(surface, p: _Painter, reads: list, st: dict, top: float, stride: float):
    fe = p.fe
    n = len(reads)
    width, sidebar = p.width, p.sidebar
    # Selected reads (shift+click): cyan outline + 4 px bar.
    for i, read in enumerate(reads):
        if read['id'] not in st['selected'] or not read.get('intervals'):
            continue
        lo = min(iv[0] for iv in read['intervals'])
        hi = max(iv[1] for iv in read['intervals'])
        x0, x1 = p.span(np.array([lo]), np.array([hi]))
        y = top + i * stride
        surface.save()
        surface.clip_rect(sidebar, top, width - sidebar, n * stride)
        surface.rect(float(x0[0]) - 1, y - 1, float(x1[0] - x0[0]) + 2, p.fh + 2, stroke='#06b6d4', stroke_width=2)
        surface.rect(sidebar, y, 4, p.fh, fill='#06b6d4')
        surface.restore()
    # Cluster separators.
    if st['has_cluster']:
        bounds: dict[int, list] = {}
        for i, read in enumerate(reads):
            c = cluster_for(st['assignments'], read['id'])
            if c is None:
                continue
            y = i * stride
            if c not in bounds:
                bounds[c] = [y, y + p.rh]
            else:
                bounds[c][1] = y + p.rh
        if len(bounds) > 1:
            ordered = [c for c in st['order'] if c in bounds] if st['order'] else sorted(bounds)
            height = n * stride
            for j, c in enumerate(ordered[:-1]):
                end_y = bounds[c][1]
                if 0 < end_y < height:
                    surface.line(sidebar, top + end_y, width, top + end_y, 'rgba(0,0,0,0.4)', 1)
    # Read boundary lines for few, tall rows.
    mode = fe.get('readSeparatorMode') or 'auto'
    if n <= 50 and p.rh >= 6 and mode != 'off':
        for i in range(n + 1):
            y = top + i * stride
            surface.line(sidebar, y, width, y, 'rgba(200,200,200,0.5)', 0.5)


def _draw_histogram(surface, p: _Painter, reads: list, height: float = HISTOGRAM_HEIGHT):
    track_w = p.width - p.sidebar
    bins = max(1, int(min(track_w, 500)))
    bin_size = p.region / bins
    diff = np.zeros(bins + 1)
    for read in reads:
        for s, e, _ in read.get('intervals') or []:
            b0 = max(0, math.floor(s / bin_size))
            b1 = min(bins, math.ceil(e / bin_size))
            if b1 > b0:
                diff[b0] += 1
                diff[b1] -= 1
    cov = np.cumsum(diff[:bins])
    max_cov = max(1, int(cov.max()) if len(cov) else 1)
    top, h = 1, max(1, height - 3)
    bar_w = track_w / bins
    surface.rect(p.sidebar, top, track_w, h, fill='#f8f8f8')
    for b in np.flatnonzero(cov):
        bh = cov[b] / max_cov * h
        bx = p.sidebar + ((bins - 1 - b) if p.rev else b) * bar_w
        surface.rect(bx, top + h - bh, max(1, bar_w), bh, fill='rgba(100,140,200,0.5)')
    surface.text(p.sidebar + track_w - 2, top + 9, str(max_cov), size=9, color='#999999', anchor='end')
    surface.line(p.sidebar, height - 1, p.width, height - 1, '#e0e0e0', 1)


def _draw_zoomed_out(surface, ctx: TrackContext, height: float):
    region = ctx.end - ctx.start
    label = f"{region / 1e6:.1f} Mb" if region >= 1e6 else f"{region / 1e3:.0f} kb"
    cov = None
    from services.read_auxiliary_endpoint import get_coverage_payload
    bins = int(max(100, min(ctx.width, 2000)))
    try:
        include_duplicates = bool(ctx.fe.get('showDuplicateReads'))
        cov = ctx.data.get(('coverage', ctx.panel.dataset_id, bins, include_duplicates) + ctx.region,
                           lambda: get_coverage_payload(
            ctx.state, chrom=ctx.chrom, start=ctx.start, end=ctx.end, bins=bins, dataset_id=ctx.panel.dataset_id,
            include_duplicates=include_duplicates))
    except Exception:
        cov = None
    values = (cov or {}).get('coverage') or []
    cmax = (cov or {}).get('max') or 0
    if values and cmax > 0:
        surface.rect(0, 0, ctx.width, height, fill='#fafafa')
        plot_h, plot_top = height - 20, 10
        bar_w = ctx.width / len(values)
        for b, v in enumerate(values):
            if not v:
                continue
            bh = v / cmax * plot_h
            surface.rect(b * bar_w, plot_top + plot_h - bh, max(1, bar_w), bh, fill='rgba(100,140,200,0.5)')
        surface.text(ctx.width - 4, 10, f"max {cmax}", size=9, color='#999999', anchor='end')
        surface.text(ctx.width / 2, 10, f"Coverage · {label}", size=10, color='#aaaaaa', anchor='middle')
    # Without coverage the browser shows a 'zoom in' hint; a figure stays blank.


def draw(surface, ctx: TrackContext, track, height: float) -> None:
    view = _display(ctx)
    fe = ctx.fe
    cmap = fe.get('activeColormap') or {}
    bg = rc.normalize_hex(cmap.get('noReadBackgroundColor', cmap.get('backgroundColor')), '#ffffff')
    surface.rect(0, 0, ctx.width, height, fill=bg)
    if view['zoomed_out']:
        _draw_zoomed_out(surface, ctx, height)
        return
    reads = view['reads']
    geo = _geometry(ctx)
    if not reads:
        surface.text(ctx.width / 2, geo['hist'] + (height - geo['hist']) / 2, 'No reads', size=12,
                     color='#999999', anchor='middle', baseline='middle')
        return
    scale = float(getattr(surface, 'scale', 2.0) or 2.0)
    painter = _Painter(ctx, geo, len(reads), scale)
    if geo['sv_band']:
        sv.draw_band(surface, painter, geo['sv_summary'], 0, geo['sv_band'], ctx.start)
    if geo['cov']:
        surface.save()
        surface.translate(0, geo['sv_band'])
        _draw_histogram(surface, painter, reads, geo['cov'])
        surface.restore()
    _paint_reads(painter, reads, view['state'], _all_peaks(ctx), _genes(ctx), ctx.panel.dataset)
    image = painter.raster.render()
    smoothing = cmap.get('displaySmoothing') or {}
    if smoothing.get('enabled') and (_num(smoothing.get('sigmaX'), 0) > 0 or _num(smoothing.get('sigmaY'), 0) > 0):
        left = int(round(painter.sidebar * painter.raster.sx))
        image[:, left:] = gaussian_blur(image[:, left:], min(10, _num(smoothing.get('sigmaX'), 0)) * painter.raster.sx,
                                        min(10, _num(smoothing.get('sigmaY'), 0)) * painter.raster.sy)
    rows_h = len(reads) * geo['stride']
    surface.image(0, geo['hist'], ctx.width, rows_h, image)
    _vector_decorations(surface, painter, reads, view['state'], geo['hist'], geo['stride'])
    on, min_len, _collapsed = sv.settings(fe)
    if on and ctx.panel.dataset.get('data_type') == 'bam':
        sv.draw_read_marks(surface, painter, reads, geo['hist'], geo['stride'], ctx.start, ctx.end, min_len)


register("reads", measure, draw)


# --------------------------------------------------------------------------
# the SV and coverage rows (their own tracks in the browser since fb-n11-tracks)
# --------------------------------------------------------------------------
class _Axis:
    """The reads' x mapping for a row drawn from them (sidebar, reverse)."""

    def __init__(self, ctx: TrackContext):
        self.width = ctx.width
        self.sidebar = SIDEBAR_WIDTH if _has_any_clusters(ctx.fe) else 0
        self.region = ctx.end - ctx.start
        self.scale = (self.width - self.sidebar) / max(1, self.region)
        self.rev = bool(ctx.fe.get('isReversed'))

    def x(self, rel):
        rel = np.asarray(rel, dtype=np.float64)
        return self.sidebar + (self.region - rel) * self.scale if self.rev else self.sidebar + rel * self.scale


def _sv_summary(ctx: TrackContext) -> Optional[dict]:
    view = _display(ctx)
    if view['zoomed_out'] or ctx.panel.dataset.get('data_type') != 'bam':
        return None
    return sv.visible_summary(view.get('payload') or {}, ctx.fe)


def measure_sv(ctx: TrackContext, track) -> float:
    return float(sv.band_height(_sv_summary(ctx), ctx.fe, track.height))


def draw_sv(surface, ctx: TrackContext, track, height: float) -> None:
    summary = _sv_summary(ctx)
    if not summary or height <= 0:
        return
    surface.rect(0, 0, ctx.width, height, fill='#fafafa')
    sv.draw_band(surface, _Axis(ctx), summary, 0, height, ctx.start)


def measure_coverage(ctx: TrackContext, track) -> float:
    view = _display(ctx)
    if view['zoomed_out'] or not view['reads']:
        return 0.0
    return float(_coverage_height(ctx.fe, track))


def draw_coverage(surface, ctx: TrackContext, track, height: float) -> None:
    view = _display(ctx)
    if view['zoomed_out'] or not view['reads'] or height <= 0:
        return
    _draw_histogram(surface, _Axis(ctx), view['reads'], height)


register("sv", measure_sv, draw_sv)
register("coverage", measure_coverage, draw_coverage)
