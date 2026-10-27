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

Hooked where the consensus overlay is (``BrowserState.build_working_set``, ``read_endpoint``'s display paths)
and in the working set before quality filters (``working_sets._viewport_reads_from_broad``); idempotent. A row it
changed carries a receipt (``RECEIPT_KEY``: the dataset's scans, the pass's window and the groups it wrote) on the
row itself rather than on its layers, which quality filters rebuild: a later pass of the same scans over the same
window is a no-op, so a pass after the filters never brings a rejected mark back. A pass over another window (or of
other scans) replaces the groups the receipt names, filtered or not, and those its layers' ``scan_overlay`` names.
"""
from __future__ import annotations

import hashlib
from typing import Dict, List

STATE_BYTE = {'1': 1, '0': 2, '.': 3}
#: The row's overlay receipt (an internal field): (overlay token, chrom, start, end, groups written).
RECEIPT_KEY = '_fiberbrowser_scan_overlay'
NUC_GROUPS = frozenset({'nucsz', 'nucseg'})
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
    """(scan, [scan dataset ids], {module: group}) of the open tables-mode scans bound to a native dataset."""
    if not state.__dict__.get('scan_registry'):
        return []
    ds = (getattr(state, 'datasets', None) or {}).get(dataset_id)
    if ds is None or getattr(ds, 'data_type', None) != 'bam':
        return []
    from .registry import list_scans
    out = []
    for scan in list_scans(state):
        sids = scan.datasets_of_browser(dataset_id)
        if not sids:
            continue
        groups = _state_groups(scan)
        marks = _mark_groups(scan)
        scalars = _scalar_modules(scan)
        if groups or marks or scalars:
            out.append((scan, sids, dict(groups, **{f'{m}#marks': ','.join(names) for m, names in marks.items()},
                                         **{f'{m}#molecules': '1' for m in scalars})))
    return out


def _scalar_modules(scan) -> List[str]:
    """Modules with a per-molecule scalar group whose molecules table this scan wrote (nuc: nucmol, nfr: nfrmol)."""
    out = []
    for module, block in (scan.manifest.get('modules') or {}).items():
        if scan.tables.has(f'{module}/molecules.tsv.bgz') and \
                any(g.get('kind') == 'scalar' for g in block.get('ma_groups') or []):
            out.append(module)
    return out


def _group_names(groups: Dict[str, str]):
    """(module, table, group) of an overlay entry: state groups read states.tsv, '<module>#marks' entries marks.tsv."""
    for key, value in groups.items():
        if key.endswith('#molecules'):
            continue   # scalars: read by apply_scan_overlays itself
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


def overlay_signature(state, dataset_id: str) -> tuple:
    """What the overlay on a dataset's rows depends on (its tables-mode scans): part of a cached working set's key."""
    return tuple((sc.scan_id, sc.manifest_digest) for sc, _s, _g in overlay_scans(state, dataset_id))


def overlay_token(dataset_id: str, scans) -> str:
    """The receipt of a dataset's overlay by these scans (``overlay_signature``'s scans)."""
    return 'scan:' + hashlib.sha256(repr((dataset_id, tuple((sc.scan_id, sc.manifest_digest) for sc in scans)))
                                    .encode()).hexdigest()[:16]


def apply_scan_overlays(state, dataset_id: str, chrom: str, start: int, end: int, reads: List[dict]) -> List[dict]:
    """``reads`` with the overlay on them (the same object when no row changed)."""
    if not reads:
        return reads
    apply_one = prepare_scan_overlay(state, dataset_id, chrom, start, end)
    if apply_one is None:
        return reads
    out = [apply_one(read) for read in reads]
    if len(out) == len(reads) and all(a is b for a, b in zip(out, reads)):
        return reads
    return out


def prepare_scan_overlay(state, dataset_id: str, chrom: str, start: int, end: int):
    """A function putting the bound tables-mode scans' layers and scalars on one row of ``[start, end)`` (rows
    relative to ``start``), or None when nothing applies. The scans' rows are fetched once, here."""
    scans = overlay_scans(state, dataset_id)
    if not scans:
        return None
    ds = state.datasets.get(dataset_id)
    derived = getattr(ds, 'derived_layers', None) or {}
    from services.nuc.inputs import real
    # Each scan row's file: (scan dataset, input index) -> the loaded file holding it, so a row never joins an identical
    # record of another file (a merged dataset of several scan datasets).
    file_of: Dict[tuple, str] = {}
    for scan, _sids, _groups in scans:
        for sid, bid, _via, files in scan.bound_pairs():
            if bid == dataset_id:
                for i, path in files.items():
                    file_of[(scan.scan_id, sid, int(i))] = real(path)
    marks: Dict[str, Dict[str, list]] = {}
    for scan, sids, groups in scans:
        by_table: Dict[tuple, list] = {}
        for module, table, group in _group_names(groups):
            if (derived.get(group) or {}).get('kind') != 'scan-overlay':
                continue   # the dataset carries this group itself
            by_table.setdefault((module, table), []).append(group)
        for (module, table), wanted in by_table.items():
            for r in scan.tables.fetch(f'{module}/{table}.tsv.bgz', chrom, start, end):
                if r.get('dataset_id') not in sids:
                    continue
                group = wanted[0] if table == 'states' else r.get('group')
                if group not in wanted:
                    continue
                r = dict(r, _file=file_of.get((scan.scan_id, r.get('dataset_id'), int(r.get('input_index') or 0))))
                marks.setdefault(r.get('qname', ''), {}).setdefault(group, []).append(r)
    # Per-molecule scalars (molecules.tsv: exact values) for Filter/Sort terms, cluster columns and Read Stats.
    scalar_rows: Dict[str, list] = {}
    for scan, sids, groups in scans:
        for key in groups:
            if key.endswith('#molecules'):
                module = key[:-len('#molecules')]
                for r in scan.tables.fetch(f'{module}/molecules.tsv.bgz', chrom, start, end):
                    if r.get('dataset_id') in sids:
                        r = dict(r, _file=file_of.get((scan.scan_id, r.get('dataset_id'), int(r.get('input_index') or 0))))
                        scalar_rows.setdefault(r.get('qname', ''), []).append((module, r))
    if not marks and not scalar_rows:
        return None
    # Mark groups' byte names as their contract declares them (nucsz: coarse, named, posterior, z), so a tables-mode
    # overlay names its qualities as an annotated BAM's group parses (bam_tags known_qual_names).
    declared = {g.get('group'): list(g.get('quality_names') or []) for scan, _s, _g in scans
                for block in (scan.manifest.get('modules') or {}).values()
                for g in block.get('ma_groups') or [] if g.get('kind') == 'mark'}
    # The overlay's receipt: rows these scans already overlaid over this window (the receipt on the row) are
    # returned as they are, whatever quality filters did to their layers since, so a later pass never restores a
    # rejected mark and keeps the row objects (and the consensus projection's receipt over them).
    token = overlay_token(dataset_id, [sc for sc, _s, _g in scans])
    here = (token, str(chrom), int(start), int(end))

    def apply_one(read: dict) -> dict:
        prior = read.get(RECEIPT_KEY)
        if prior is not None and tuple(prior[:4]) == here:
            return read
        original = read.get('layers') or {}
        mine = marks.get(str(read.get('id', '')))
        # An earlier pass's groups (another window, other scans): those its receipt names, filtered or not, and any
        # layer still carrying its token.
        earlier = set(prior[4]) if prior is not None and len(prior) > 4 else set()
        layers = {k: v for k, v in original.items()
                  if k not in earlier and not (isinstance(v, dict) and v.get('scan_overlay'))}
        written = []
        if mine:
            # The row's own record: by its identity when the row carries it, else by where its alignment is.
            sha, occ = read.get('record_sha256'), read.get('alignment_occurrence')
            own = f'{sha}:{occ}' if sha and occ is not None else None
            own_file = real(read['library_id']) if read.get('library_id') else None
            r_start = read.get('reference_start', read.get('start'))
            r_end = read.get('reference_end', read.get('end'))
            for group, rows in mine.items():
                if group in NUC_GROUPS and (read.get('nuc_live') or
                                            (isinstance(layers.get(group), dict) and layers[group].get('nuc_live'))):
                    continue   # live nucleosome outputs (the dataset's last Compute) win over a scan's rows
                ivs, srcs, names, q0 = [], [], [], []
                for row in sorted(rows, key=lambda x: (int(x['start']), int(x['end']), x.get('hit_id', ''))):
                    a, b = int(row['start']), int(row['end'])
                    b = max(b, a + 1)   # a zero-width mark (an insertion boundary) is drawn as its base
                    if own_file is not None and row.get('_file') and row['_file'] != own_file:
                        continue   # another file's record (an identical record in another BAM)
                    if own is not None and row.get('record'):
                        if row['record'] != own:
                            continue   # another record (a supplementary, a copy) of this read name
                    elif isinstance(r_start, int) and isinstance(r_end, int) and not (a < r_end and r_start < max(b, a + 1)):
                        continue   # another record of this read name holds it
                    lo, hi = max(a, start), min(b, end)
                    if hi <= lo:
                        continue
                    # The size field is the mark's molecular length (as the MA group parses), not its reference span.
                    size = int(row['mol_len']) if isinstance(row.get('mol_len'), int) else b - a
                    ivs.append([lo - start, hi - start, size])
                    srcs.append([a - start, b - start, size])
                    if 'hit_id' in row:
                        names.append(row.get('hit_id', ''))
                        q0.append(_state_bytes(row))
                    else:   # a molecule-wide mark: its own bytes (the MA group's qualities) and AN name
                        names.append(row.get('name', '') if row.get('name') not in (None, '.') else '')
                        q0.append([int(x) for x in str(row.get('q') or '').split(',') if x != ''])
                if ivs:
                    width = max((len(q) for q in q0), default=0)
                    names_q = declared.get(group) or []
                    layers[group] = dict(intervals=ivs, source_intervals=srcs, annotation_names=names,
                                         quality_names=names_q if len(names_q) == width else [f'q{i}' for i in range(width)],
                                         qualities=[[q[i] if i < len(q) else 0 for q in q0] for i in range(width)],
                                         scan_overlay=token, source_layer=LAYER_META.get(group, ('', '', 'tf'))[2],
                                         draw_style='fill')
                    written.append(group)
        before = read
        if set(layers) != set(original) or any(layers[k] is not original.get(k) for k in layers):
            read = dict(read)
            read['layers'] = layers
        mol_rows = scalar_rows.get(str(read.get('id', '')))
        if mol_rows:
            read = _with_scalars(read, mol_rows)
        if read is not before:
            read[RECEIPT_KEY] = (*here, tuple(sorted(written)))    # a copy: the row this pass made
        return read
    return apply_one


_NOT_SCALARS = {'chrom', 'start', 'end', 'idx_start', 'idx_end', 'dataset_id', 'input_index', 'qname', 'record',
                'molecule', 'calls_digest_hi', 'calls_digest_lo', '_file'}


def _with_scalars(read: dict, rows) -> dict:
    """``read`` with its record's molecules-table scalars (values already on the row, live ones, win)."""
    from services.nuc.scalars import SCALARS_KEY, scalars_from_values
    from services.nuc.inputs import real
    sha, occ = read.get('record_sha256'), read.get('alignment_occurrence')
    own = f'{sha}:{occ}' if sha and occ is not None else None
    own_file = real(read['library_id']) if read.get('library_id') else None
    have = dict(read.get(SCALARS_KEY) or {})
    added = False
    for module, row in rows:
        if own_file is not None and row.get('_file') and row['_file'] != own_file:
            continue
        if own is not None and row.get('record') and row['record'] != own:
            continue
        values = {}
        for k, v in row.items():
            if k in _NOT_SCALARS:
                continue
            try:
                values[k] = None if v in (None, '') else float(v)
            except (TypeError, ValueError):
                continue
        for k, v in scalars_from_values(module, values).items():
            if k not in have:
                have[k] = v
                added = True
    if not added:
        return read
    read = dict(read)
    read[SCALARS_KEY] = have
    return read


TIER_BYTE = {'': 0, 'core': 1, 'edge': 2, 'loose': 3}


def _byte(value) -> int:
    try:
        return int(round(255 * min(1.0, max(0.0, float(value)))))
    except (TypeError, ValueError):
        return 0


def _state_bytes(row: dict) -> List[int]:
    """A state row's MA bytes, as the scan writes its state group: fpcls (state, posterior, tier); nfrvar (state, p)
    for variants, (state, 255 open / 0 closed) for regions."""
    state = STATE_BYTE.get(str(row.get('state')), 3)
    hit = str(row.get('hit_id', ''))
    if hit.startswith('fp:'):
        return [state, _byte(row.get('posterior')), TIER_BYTE.get(str(row.get('tier') or ''), 0)]
    if hit.startswith('nfr:variant:'):
        return [state, _byte(row.get('p'))]
    if hit.startswith('nfr:'):
        return [state, 255 if str(row.get('state')) == '1' else 0]
    return [state]


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
