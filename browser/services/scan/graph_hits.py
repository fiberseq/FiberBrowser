"""Hub hits on graph node columns (feature hub G1; DESIGN §5.4, DESIGN_GRAPH_PRIMARY §2.3–2.4).

A hit gets the columns ``(node, offset)`` it covers on a registered graph package, from the same fixed analysis tiles
graph clustering reads (``services/graph_panel/analysis.fetch_tiles``; offsets along the node's forward orientation),
so the columns never depend on the view, the layout or the selected paths:

- a hit on the target (a scan of a native dataset, in this genome's coordinates): the target walk over its span
  (target-aliased columns);
- a hit of a source-frame scan (a live-lift dataset's own assembly): its own path's walk over its source span, by
  the clip formulas (``Occ.offset``). A hit inside an insertion is placed at the insertion's target junction.

Per package path, the hit's columns are:

- **carried** when the path visits each column's node exactly once in the hit's tiles and the offset is inside that
  visit's clip (``partial`` when only some are);
- **absent** when the path visits none of them and its tile response proves it (``columns.complete_at``: complete
  topology and path, owned plan candidates over the hit's target span). The target is the tiles' own frame: it is
  absent from a column its complete response does not walk;
- **unresolved** otherwise (a repeat, a coverage gap, an open end, a plan summary).

A MAT/PAT hit inside an insertion is therefore **absent** on the paths that don't carry the insertion (the target,
and native datasets on it), never "not scanned".
"""
from __future__ import annotations

import asyncio
from typing import Dict, List, Optional, Tuple

from services.graph_panel import columns as gc

MAX_COLUMN_RUNS = 4_000
TILE_TIMEOUT_S = 20.0


def _runs(cols: List[Tuple[str, int]]) -> List[list]:
    """``[[node, o0, o1], ...]``: consecutive offsets of one node merged, in the given (walk) order."""
    out: List[list] = []
    for node, o in cols:
        if out and out[-1][0] == node and (o == out[-1][2] or o == out[-1][1] - 1):
            if o == out[-1][2]:
                out[-1][2] = o + 1
            else:
                out[-1][1] = o
            continue
        out.append([node, o, o + 1])
    return out


def own_columns(occs: Dict[str, gc.Occ], start: int, end: int) -> Tuple[List[Tuple[str, int]], int]:
    """The carried ``(node, offset)`` columns of path interval ``[start, end)`` in walk order, and how many bases sit
    in a node the path visits more than once here (a repeat: left out, unresolved)."""
    vis = gc.visits(occs)
    cols: List[Tuple[str, int]] = []
    repeats = 0
    for occ in sorted(occs.values(), key=lambda q: q.span):
        a, b = max(start, occ.span[0]), min(end, occ.span[1])
        if b <= a:
            continue
        for p in range(a, b):
            o = occ.offset(p)
            if not occ.carries(o):
                continue
            if len(vis[occ.node]) != 1:
                repeats += 1
                continue
            cols.append((occ.node, o))
    return cols, repeats


def point_base(pos: int, size: Optional[int]) -> Tuple[int, int]:
    """The base a boundary at ``pos`` stands for: the one after it, or, at the path's end, the one before it."""
    if size is not None and pos >= int(size) and pos > 0:
        return pos - 1, pos
    return pos, pos + 1


def carried_runs(cols: List[Tuple[str, int]], occs: Dict[str, gc.Occ]) -> List[list]:
    """The columns a path carries (visits the node once, offset in the clip), as runs."""
    vis = gc.visits(occs)
    return _runs([(n, o) for n, o in cols if len(vis.get(n) or ()) == 1 and vis[n][0].carries(o)])


def path_status(cols: List[Tuple[str, int]], occs: Dict[str, gc.Occ], complete: bool, total: Optional[int] = None) -> dict:
    """How one path covers a hit: carried / partial / absent / unresolved, with counts. ``total``: the hit's bases
    (default: its known columns). Bases without a known column (outside a clip, a repeat) are never carried and
    never prove absence, so a hit whose columns are incomplete is at most partial, or unresolved."""
    vis = gc.visits(occs)
    carried = unvisited = 0
    for node, o in cols:
        hits = vis.get(node) or []
        if len(hits) == 1 and hits[0].carries(o):
            carried += 1
        elif not hits:
            unvisited += 1
    total = len(cols) if total is None else int(total)
    known = len(cols)
    if total and carried == total:
        status = 'carried'
    elif carried:
        status = 'partial'
    elif total and known == total and unvisited == total and complete:
        status = 'absent'
    else:
        status = 'unresolved'
    return dict(status=status, carried=carried, total=total)


def _target_complete(res: Optional[dict], binding: str) -> bool:
    if res is None or not res.get('complete') or res.get('summaries'):
        return False
    p = next((x for x in res.get('paths') or () if x.get('binding') == binding), None)
    return bool(p and p.get('complete') and all(c.get('kind') == 'covered' for c in p.get('coverage') or ()))


def _complete_over(tiles: Dict[int, dict], binding: str, target: str, lo: int, hi: int) -> bool:
    """Whether every cell the target span ``[lo, hi)`` (a boundary when ``lo == hi``) meets proves absence for a
    path."""
    cells = gc.cells_for(lo, hi) if hi > lo else [lo // gc.CELL_BP]
    for cell in cells:
        res = tiles.get(cell)
        a, b = (max(lo, cell * gc.CELL_BP), min(hi, (cell + 1) * gc.CELL_BP)) if hi > lo else (lo, lo)
        ok = _target_complete(res, binding) if binding == target else gc.complete_at(res, binding, a, b)
        if not ok:
            return False
    return True


def package_bindings(state, reg) -> dict:
    """``{binding key: {label, datasets: [ids], contigs: {dataset id: BAM contig}, hap}}`` for a registration: the
    loaded datasets each path's reads come from (live-lift datasets on their source paths, native ones on the
    target)."""
    from services.graph_panel.reads import read_bindings
    out: dict = {}
    for b in reg.bindings:
        path = b.get('path') or {}
        out[b['key']] = dict(label=b.get('assembly') or path.get('sample') or b['key'], datasets=[], contigs={}, hap=None)
    try:
        bound = read_bindings(state, reg)
    except Exception:   # noqa: BLE001 - a dataset whose files went missing binds to nothing
        bound = []
    for entry in bound:
        haps = entry.get('haps') or {}
        for key, contig in (entry.get('paths') or {}).items():
            if key not in out:
                continue
            out[key]['datasets'].append(entry['dataset_id'])
            out[key]['contigs'][entry['dataset_id']] = contig
            if haps.get(key):
                out[key]['hap'] = haps[key]
    return out


def _target_key(reg, chrom: str) -> Optional[str]:
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(chrom)
    for m in reg.maps:
        b = reg.binding(m.get('target'))
        contig = ((b or {}).get('path') or {}).get('contig')
        if contig and normalize_chrom_name(str(contig)) == want:
            return m.get('target')
    return None


def _sources(reg, target: str) -> List[str]:
    return list(dict.fromkeys(m.get('source') for m in reg.maps if m.get('target') == target and m.get('source')))


_FETCH_LOCKS: Dict[int, tuple] = {}     # id(loop) -> (loop, lock); closed loops are dropped


async def _fetch(reg, target: str, sources: List[Optional[str]], cells: List[int]) -> dict:
    """``{source: {cell: topology}}``: graph clustering's tiles (the same requests, the same cache,
    ``analysis._TILES``), fetched under request ids of the hub's own. Graph runs give a tile a request id fixed by its
    key, and the pool refuses a second request with a pending id, so sharing those ids could fail a run's request
    (or the hub's). Hub requests run one at a time, so the view's modules and scans don't fetch one tile twice."""
    import uuid
    from services.graph_panel import analysis, service
    from services.graph_panel.pool import JobError
    loop = asyncio.get_running_loop()
    for key in [k for k, (lp, _l) in _FETCH_LOCKS.items() if lp.is_closed()]:
        _FETCH_LOCKS.pop(key, None)
    entry = _FETCH_LOCKS.get(id(loop))
    if entry is None or entry[0] is not loop:
        entry = _FETCH_LOCKS[id(loop)] = (loop, asyncio.Lock())
    tb = reg.binding(target)
    size = tb.get('size') if tb else None
    out: dict = {}
    async with entry[1]:
        for source in sources:
            got = out.setdefault(source, {})
            for cell in cells:
                key = analysis._tile_key(reg, target, source, cell)
                with analysis._TILES_LOCK:
                    hit = analysis._TILES.get(key)
                    if hit is not None:
                        analysis._TILES.move_to_end(key)
                if hit is None:
                    a, b = gc.tile_interval(cell, size)
                    # The request graph clustering makes for this tile (analysis.fetch_tiles), so either fills the
                    # shared cache with the same topology.
                    request = {'target': target, 'interval': {'start': a, 'end': b},
                               'selected': [target] + ([source] if source and source != target else []),
                               'context_bp': 0, 'snarls': 'none'}
                    rid = f'hub-cols-{uuid.uuid4().hex[:16]}'
                    try:
                        frame = await asyncio.wait_for(service.pool().submit(
                            reg, 'query', {'request': request}, request_id=rid, panel_id=rid, generation=0), TILE_TIMEOUT_S)
                    except JobError as exc:
                        raise RuntimeError(f'the graph tile {a:,}-{b:,} could not be read: {exc}') from None
                    hit = frame['result']
                    with analysis._TILES_LOCK:
                        analysis._TILES[key] = hit
                        while len(analysis._TILES) > analysis._TILES_MAX:
                            analysis._TILES.popitem(last=False)
                got[cell] = hit
    return out


def merged_occurrences(tiles: dict, target: str) -> dict:
    """``{binding: {occurrence id: Occ}}`` of every path in a set of tile responses (merged across cells)."""
    occs_of = {target: gc.merge_occurrences(list((tiles.get(None) or {}).values()), target)}
    for key in (k for k in tiles if k is not None):
        occs_of[key] = gc.merge_occurrences(list(tiles[key].values()), key)
    return occs_of


def alias_for(reg, target: str, bindings: dict, tiles: dict, *, own: Optional[str], start: int, end: int,
              anchor: Tuple[int, int], occs_of: Optional[dict] = None) -> dict:
    """A hit's graph alias from fetched tiles: its columns on its own path (``own``; None: the target walk over
    ``[start, end)``) and every path's status. ``anchor``: its target span (the junction for a hit in an insertion).
    ``occs_of``: the tiles' merged occurrences, when the caller already has them."""
    sources = [k for k in tiles if k is not None]
    own_key = own or target
    occs_of = occs_of if occs_of is not None else merged_occurrences(tiles, target)
    cols, repeats = own_columns(occs_of.get(own_key) or {}, start, end)
    total = max(1, int(end) - int(start))
    lo, hi = anchor
    paths = {}
    for key in [target, *sources]:
        tile_set = tiles.get(None if key == target else key) or {}
        st = path_status(cols, occs_of.get(key) or {}, _complete_over(tile_set, key, target, lo, hi), total)
        b = bindings.get(key) or {}
        # A path carrying only part of the hit says which columns (drawing places the hit there and nowhere else).
        extra = {'columns': carried_runs(cols, occs_of.get(key) or {})[:MAX_COLUMN_RUNS]} if st['status'] == 'partial' else {}
        paths[key] = dict(st, label=b.get('label') or key, datasets=list(b.get('datasets') or ()),
                          **({'hap': b['hap']} if b.get('hap') else {}), **extra)
    runs = _runs(cols)
    # ``size``: the hit's bases (the denominator of matching); ``known``: those with a column. A hit whose columns
    # are incomplete matches only through the columns it has, against its whole length.
    return dict(registration=reg.id, target=target, binding=own_key, anchor=[int(lo), int(hi)],
                columns=runs[:MAX_COLUMN_RUNS], truncated=len(runs) > MAX_COLUMN_RUNS, size=total, known=len(cols),
                repeats=repeats, paths=paths)


async def add_graph_aliases(state, hits: List[dict], view_chrom: str) -> Optional[str]:
    """Adds ``graph`` to each hit a registered package covers (in place). Returns a note when graph columns could
    not be read (no helper, a tile that failed), else None. Hits keep working without it."""
    if not hits:
        return None
    from services.graph_panel import service
    try:
        status = await service.ensure_ready()
    except Exception as exc:   # noqa: BLE001
        return f'graph columns unavailable: {exc}'
    if not status.available:
        return None
    regs = []
    for public in service.registry().list():
        try:
            regs.append(service.registry().get(public['id']))
        except Exception:   # noqa: BLE001 - unregistered meanwhile
            continue
    note = None
    for reg in regs:
        target = _target_key(reg, view_chrom)
        if target is None:
            continue
        bindings = package_bindings(state, reg)
        by_contig = {}
        for key, b in bindings.items():
            for ds, contig in b['contigs'].items():
                if key != target:
                    by_contig[(ds, contig)] = key
        sources = _sources(reg, target)
        merged: dict = {}
        for h in hits:
            if h.get('graph'):
                continue
            plan = _hit_plan(h, by_contig, target)
            if plan is None:
                continue
            own, start, end, anchor = plan
            if end - start > gc.MAX_FEATURE_BP or anchor[1] - anchor[0] > gc.MAX_FEATURE_BP:
                continue
            cells = gc.cells_for(anchor[0], anchor[1]) if anchor[1] > anchor[0] else [anchor[0] // gc.CELL_BP]
            try:
                tiles = await _fetch(reg, target, [None, *sources], cells)
            except Exception as exc:   # noqa: BLE001 - graph columns are an addition; the hit stays listed
                note = f'graph columns could not be read: {exc}'
                continue
            # Hits in the same cells share their merged occurrences (the view's hits mostly sit in one or two cells).
            occs_key = tuple(cells)
            if occs_key not in merged:
                merged[occs_key] = merged_occurrences(tiles, target)
            # A zero-width hit (a boundary) takes the base after it; at the path's end, the one before it (liftbed's
            # rule for points). Its anchor stays the boundary.
            if end <= start:
                start, end = point_base(start, (reg.binding(own or target) or {}).get('size'))
            h['graph'] = alias_for(reg, target, bindings, tiles, own=own, start=start, end=end, anchor=anchor,
                                   occs_of=merged[occs_key])
    return note


def _hit_plan(h: dict, by_contig: dict, target: str):
    """``(own path or None, start, end, target anchor)`` of a hit, else None (not on this package)."""
    frame = h.get('frame') or {}
    if h.get('typeId') == 'var.diff':
        detail = h.get('detail') or {}
        src = detail.get('src') or {}
        # Deleted bases belong to the target; other assembly alleles use their source sequence.
        if detail.get('source') == 'assembly' and detail.get('kind') != 'deletion':
            own = by_contig.get((detail.get('datasetId'), src.get('contig')))
            if own is None or src.get('start') is None or src.get('end') is None:
                return None
            return own, int(src['start']), int(src['end']), (int(h['start']), int(h['end']))
    if frame.get('kind') == 'source':
        own = by_contig.get((frame.get('datasetId'), frame.get('contig')))
        if own is None:
            return None
        lift = h.get('lift') or {}
        src = h.get('source') or {}
        if lift.get('chrom') is not None:
            anchor = (int(lift['start']), int(lift['end']))
        elif lift.get('junction'):
            anchor = (int(lift['junction'][0]), int(lift['junction'][1]))
        else:
            return None
        return own, int(src.get('start', h['start'])), int(src.get('end', h['end'])), anchor
    if h.get('end') is None or h.get('start') is None:
        return None
    a, b = int(h['start']), int(h['end'])
    return None, a, max(a, b), (a, max(a, b))
