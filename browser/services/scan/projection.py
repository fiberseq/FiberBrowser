"""A source-frame scan's hits in the browser's view (feature hub G1; DESIGN §4.3, §5.4).

A scan of a live-lift dataset's own BAM (``frame.kind = 'source'``, ``registry.OpenScan.update_frame``) is in that
assembly's coordinates. For a target view, each bound live-lift dataset's map gives the source windows the view's
primary chains reach (``lift.source_windows``, insertions between chains included); the scan's hits in those windows
are lifted with ``liftbed`` (``lift.lift_hits``) and kept when their lifted interval, or the junction of a hit inside
an insertion, meets the view.

Each hit keeps its source coordinates (``chrom start end`` stay the scan's) and gains:

- ``frame``: ``{kind: 'source', contig, hap, hapLabel, datasetId}`` (the haplotype from the map's chains);
- ``lift``: the status (exact / split / partial / unmapped), the kept target placement, the placement count, the
  junction of a hit inside an insertion, and the lifted anchor;
- ``target``: where the hit is drawn in this genome (``chrom`` in the caller's naming, ``start end anchor``;
  ``insertion: true`` for a junction), or absent when it can't be placed;
- per-haplotype comparison columns: each scan dataset column ``<id>`` becomes ``<id>:<hap label>`` (a dataset's
  haplotype group), so a MAT hit fills its dataset's MAT column.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from .lift import LiftUnavailable, lift_hits, overlaps_target, source_windows
from .serve import MAX_HITS, PAD, hits_for_view


def _same(a: str, b: str) -> bool:
    from utils.chrom import normalize_chrom_name
    return a == b or normalize_chrom_name(str(a)) == normalize_chrom_name(str(b))


def _target_name(config, chrom: str) -> str:
    """The map's name for a view contig (itself, or the alias the map uses)."""
    targets = getattr(config.handle.map, 'targets', {}) or {}
    if chrom in targets:
        return chrom
    return next((t for t in targets if _same(t, chrom)), chrom)


def lifted_datasets(state, scan) -> List[str]:
    """The bound live-lift datasets a source-frame scan's hits can be lifted through."""
    out = []
    for _sid, bid, _via, _files in scan.bound_pairs():
        ds = (getattr(state, 'datasets', None) or {}).get(bid)
        if getattr(ds, 'data_type', None) == 'bam_livelift' and getattr(ds, 'live_lift', None) is not None:
            out.append(bid)
    return list(dict.fromkeys(out))


def source_hits_for_view(state, scan, module: str, chrom: str, start: int, end: int, *, type_id: Optional[str] = None,
                         limit: int = MAX_HITS) -> dict:
    """Hits of a source-frame scan overlapping target view ``[start, end)``, lifted, with source coordinates kept."""
    out_hits: List[dict] = []
    notes: List[str] = []
    truncated = False
    datasets = lifted_datasets(state, scan)
    if not datasets:
        notes.append('scanned in another assembly, and no live-lift dataset of that BAM is loaded: its hits cannot '
                     'be placed on this genome')
    seen = set()
    counts: Dict[str, int] = {}
    scan_ids = tuple(d.get('dataset_id') for d in scan.manifest.get('datasets') or ())
    for ds_id in datasets:
        config = state.datasets[ds_id].live_lift
        handle = config.handle
        labels = dict(getattr(handle, 'haplotype_labels', {}) or {})
        name = _target_name(config, chrom)
        # liftbed joins a hit's bases across target gaps below the split gap, so a placement over the view can have
        # its nearest projected base up to g_split away: the windows are found that far out (then filtered by lift).
        pad = max(PAD, int(getattr(config.settings, 'g_split', 10_000)))
        try:
            windows = source_windows(config, name, max(0, start - pad), end + pad)
        except Exception as exc:   # noqa: BLE001 - a map without this target
            notes.append(f'{ds_id}: {exc}')
            continue
        rows: List[dict] = []
        for contig, (lo, hi) in sorted(windows.items()):
            res = hits_for_view(scan, module, contig, lo, hi, type_id=type_id, limit=limit)
            truncated = truncated or res['truncated']
            rows.extend(h for h in res['hits'] if h['hitId'] not in seen)
        if not rows:
            continue
        # The hit's interval, then its anchor as a point: the anchor is lifted on its own (a point feature's distance
        # to another frame's anchor is what matching compares).
        lift_rows = [dict(chrom=h['chrom'], start=h['start'], end=h['end']) for h in rows] + \
                    [dict(chrom=h['chrom'], start=h['anchor'], end=h['anchor'] + 1) for h in rows]
        try:
            lifts = lift_hits(config, lift_rows)
        except LiftUnavailable as exc:
            notes.append(str(exc))
            for h in rows:
                seen.add(h['hitId'])
                out_hits.append(_annotate(h, ds_id, handle, labels, None, None, chrom, note=str(exc), scan_datasets=scan_ids))
            continue
        n = len(rows)
        for i, h in enumerate(rows):
            lift, at = lifts.get(i), lifts.get(n + i)
            if lift is None or not overlaps_target(lift, lambda c: _same(c, chrom), start, end):
                continue
            seen.add(h['hitId'])
            counts[lift.status] = counts.get(lift.status, 0) + 1
            out_hits.append(_annotate(h, ds_id, handle, labels, lift, at, chrom, scan_datasets=scan_ids))
    out_hits.sort(key=lambda h: ((h.get('target') or {}).get('start', 0), h['hitId']))
    return dict(hits=out_hits[:limit], truncated=truncated or len(out_hits) > limit, chrom=chrom, start=start, end=end,
                module=module, frame='source', liftStatus=counts, note='; '.join(dict.fromkeys(notes)) or None)


def _annotate(h: dict, ds_id: str, handle, labels: dict, lift, at, chrom: str, note: Optional[str] = None,
              scan_datasets: tuple = ()) -> dict:
    contig = h['chrom']
    hap = getattr(handle, 'source_haplotype', {}).get(contig)
    hap_label = labels.get(hap, hap) if hap else None
    h = dict(h)
    h['frame'] = dict(kind='source', contig=contig, hap=hap, hapLabel=hap_label, datasetId=ds_id)
    h['source'] = dict(chrom=contig, start=h['start'], end=h['end'], anchor=h['anchor'])
    if hap_label:
        # The scan's dataset columns become that dataset's haplotype columns (the pool stays 'all'). A one-dataset scan
        # whose values are pooled only ('all', as peaks write them) fills its dataset's haplotype column with the pool.
        cols = {(k if k == 'all' or ':' in k else f'{k}:{hap_label}'): v for k, v in h['columns'].items()}
        if len(scan_datasets) == 1 and 'all' in cols and not any(k.startswith(f'{scan_datasets[0]}:') for k in cols):
            cols[f'{scan_datasets[0]}:{hap_label}'] = cols['all']
        h['columns'] = cols
    if lift is None:
        h['lift'] = dict(status='unmapped', reason=note or 'not lifted')
        return h
    pub = lift.public()
    if at is not None and at.chrom is not None and at.chrom == lift.chrom:
        pub['anchor'] = int(at.start)
    h['lift'] = pub
    if lift.chrom is not None:
        a, b = int(lift.start), int(lift.end)
        anchor = pub.get('anchor', (a + b) // 2)
        h['target'] = dict(chrom=chrom, start=a, end=b, anchor=min(max(anchor, a), max(a, b - 1)) if b > a else a)
    elif lift.junction is not None:
        lo, hi = lift.junction
        h['target'] = dict(chrom=chrom, start=int(lo), end=int(hi), anchor=int(lo), insertion=True)
    if h.get('strand') in ('+', '-') and lift.flipped:
        h['targetStrand'] = '-' if h['strand'] == '+' else '+'
    return h
