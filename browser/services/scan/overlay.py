"""Scan per-molecule states as read-track layers of the working set (tables-mode scans).

A grid scan's annotated BAMs carry the per-molecule results as MA groups (``fpcls``, ``nfrvar``...), which parse
as ordinary layers when the annotated BAM is opened (and follow reads through live lift). A tables-mode scan (BED
scopes, the browser's live-scan cache) keeps them in ``<module>/states.tsv.bgz`` instead; this overlay puts them
on the reads of the bound native datasets under the same layer names, so a layer reads the same whichever way the
scan stored it:

- state groups (``states.tsv.bgz``): one interval per (hit, record) with a state, the mark's span (a member's own
  call edges, else the hit span); quality ``q0`` = the MA state byte (1 member / open, 2 non-member / closed,
  3 abstain), as the MA group's first byte; annotation name = the hit id;
- mark groups (``marks.tsv.bgz``: ``nucsz``, ``nucseg``): one interval per mark, its reference envelope, with the
  mark's bytes as ``q0..qN`` and its AN name, as the annotated BAM's group reads.

Native reads join by read name (a record's row is the one whose alignment holds the mark). Live-lift datasets
read scan layers from annotated BAMs (MA groups follow the read through live lift); a tables-mode overlay on
lifted rows needs hit projection (G1).

Hooked where the consensus overlay is (``BrowserState.build_working_set``, ``read_endpoint``'s display paths);
idempotent: layers it wrote carry ``scan_overlay`` and are replaced.
"""
from __future__ import annotations

from typing import Dict, List

STATE_BYTE = {'1': 1, '0': 2, '.': 3}
LAYER_META = {
    'fpcls': ('Footprint classes (scan)', '#7c3aed', 'tf'),
    'nfrvar': ('NFR variants (scan)', '#0f766e', 'msp'),
    'nucsz': ('Nucleosome sizes (scan)', '#16a34a', 'nuc'),
    'nucseg': ('Array segments (scan)', '#15803d', 'nuc'),
}


def _state_groups(scan) -> Dict[str, str]:
    """module -> state group name, for modules whose states table this scan wrote."""
    out = {}
    for module, block in (scan.manifest.get('modules') or {}).items():
        if not scan.tables.has(f'{module}/states.tsv.bgz'):
            continue
        for g in block.get('ma_groups') or []:
            if g.get('kind') == 'state' and g.get('group'):
                out[module] = g['group']
                break
    return out


def _mark_groups(scan) -> Dict[str, List[str]]:
    """module -> its mark group names (nucsz, nucseg), for modules whose marks table this scan wrote."""
    out = {}
    for module, block in (scan.manifest.get('modules') or {}).items():
        if not scan.tables.has(f'{module}/marks.tsv.bgz'):
            continue
        names = [g['group'] for g in block.get('ma_groups') or [] if g.get('kind') == 'mark' and g.get('group')]
        if names:
            out[module] = names
    return out


def overlay_scans(state, dataset_id: str):
    """(scan, scan dataset id, {module: group}) of the open tables-mode scans bound to a native dataset."""
    if not state.__dict__.get('scan_registry'):
        return []
    ds = (getattr(state, 'datasets', None) or {}).get(dataset_id)
    if ds is None or getattr(ds, 'data_type', None) != 'bam':
        return []
    from .registry import list_scans
    out = []
    for scan in list_scans(state):
        sid = scan.dataset_of_browser(dataset_id)
        if not sid:
            continue
        groups = _state_groups(scan)
        marks = _mark_groups(scan)
        if groups or marks:
            out.append((scan, sid, dict(groups, **{f'{m}#marks': ','.join(names) for m, names in marks.items()})))
    return out


def _group_names(groups: Dict[str, str]):
    """(module, table, group) of an overlay entry: state groups read states.tsv, '<module>#marks' entries marks.tsv."""
    for key, value in groups.items():
        if key.endswith('#marks'):
            module = key[:-len('#marks')]
            for name in value.split(','):
                yield module, 'marks', name
        else:
            yield key, 'states', value


def refresh_dataset_layers(state) -> None:
    """Declare the overlay layers on bound datasets (available_layers + derived_layers kind 'scan-overlay')."""
    for ds_id, ds in (getattr(state, 'datasets', None) or {}).items():
        derived = getattr(ds, 'derived_layers', None)
        available = getattr(ds, 'available_layers', None)
        if derived is None or available is None:
            continue
        for name in [n for n, meta in derived.items() if isinstance(meta, dict) and meta.get('kind') == 'scan-overlay']:
            derived.pop(name, None)
            available.pop(name, None)   # declared by this overlay (a dataset's own MA group never gets an entry)
        for _scan, _sid, groups in overlay_scans(state, ds_id):
            for _module, _table, group in _group_names(groups):
                if available.get(group) and group not in derived:
                    continue   # the dataset's own MA group (an annotated BAM): no overlay needed
                label, colour, source = LAYER_META.get(group, (f'{group} (scan)', '#64748b', 'tf'))
                available[group] = True
                derived[group] = dict(id=group, label=label, color=colour, kind='scan-overlay', source_layer=source)


def apply_scan_overlays(state, dataset_id: str, chrom: str, start: int, end: int, reads: List[dict]) -> List[dict]:
    scans = overlay_scans(state, dataset_id)
    if not scans or not reads:
        return reads
    ds = state.datasets.get(dataset_id)
    derived = getattr(ds, 'derived_layers', None) or {}
    marks: Dict[str, Dict[str, list]] = {}
    for scan, sid, groups in scans:
        by_table: Dict[tuple, list] = {}
        for module, table, group in _group_names(groups):
            if (derived.get(group) or {}).get('kind') != 'scan-overlay':
                continue   # the dataset carries this group itself
            by_table.setdefault((module, table), []).append(group)
        for (module, table), wanted in by_table.items():
            for r in scan.tables.fetch(f'{module}/{table}.tsv.bgz', chrom, start, end):
                if r.get('dataset_id') != sid:
                    continue
                group = wanted[0] if table == 'states' else r.get('group')
                if group not in wanted:
                    continue
                marks.setdefault(r.get('qname', ''), {}).setdefault(group, []).append(r)
    if not marks:
        return reads
    out = []
    for read in reads:
        mine = marks.get(str(read.get('id', '')))
        layers = {k: v for k, v in (read.get('layers') or {}).items() if not (isinstance(v, dict) and v.get('scan_overlay'))}
        if mine:
            r_start = read.get('start')
            r_end = read.get('end')
            for group, rows in mine.items():
                ivs, srcs, names, q0 = [], [], [], []
                for row in sorted(rows, key=lambda x: (int(x['start']), int(x['end']), x.get('hit_id', ''))):
                    a, b = int(row['start']), int(row['end'])
                    if r_start is not None and r_end is not None and not (a < int(r_end) and int(r_start) < b):
                        continue   # another record (a supplementary) of this read name holds it
                    lo, hi = max(a, start), min(b, end)
                    if hi <= lo:
                        continue
                    ivs.append([lo - start, hi - start, b - a])
                    srcs.append([a - start, b - start, b - a])
                    if 'hit_id' in row:
                        names.append(row.get('hit_id', ''))
                        q0.append([STATE_BYTE.get(str(row.get('state')), 3)])
                    else:   # a molecule-wide mark: its own bytes (the MA group's qualities) and AN name
                        names.append(row.get('name', '') if row.get('name') not in (None, '.') else '')
                        q0.append([int(x) for x in str(row.get('q') or '').split(',') if x != ''])
                if ivs:
                    width = max((len(q) for q in q0), default=0)
                    layers[group] = dict(intervals=ivs, source_intervals=srcs, annotation_names=names,
                                         quality_names=[f'q{i}' for i in range(width)],
                                         qualities=[[q[i] if i < len(q) else 0 for q in q0] for i in range(width)],
                                         scan_overlay=True, source_layer=LAYER_META.get(group, ('', '', 'tf'))[2],
                                         draw_style='fill')
        if mine or len(layers) != len(read.get('layers') or {}):
            read = dict(read)
            read['layers'] = layers
        out.append(read)
    return out


def apply_to_working_set(state, dataset_id, chrom, start, end, working_set):
    """``working_set`` with the scan overlay on its reads (the same object when nothing applies)."""
    if not state.__dict__.get('scan_registry'):
        return working_set
    reads = apply_scan_overlays(state, dataset_id, chrom, start, end, working_set.reads)
    if reads is working_set.reads:
        return working_set
    from models.domain import WorkingSet
    out = WorkingSet(reads, working_set.total_overlapping, working_set.total_spanning, working_set.chrom,
                     working_set.start, working_set.end, profile_metaprofile=working_set.profile_metaprofile,
                     profile_read_count=working_set.profile_read_count)
    receipt = getattr(working_set, '_consensus_overlay_receipt', None)
    if receipt is not None:
        out._consensus_overlay_receipt = receipt
    return out
