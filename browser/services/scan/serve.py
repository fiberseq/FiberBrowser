"""Rows of an open scan for a view: hits with per-group values (comparison columns), units, callable runs.

A view needs every hit that overlaps it, including hits owned by a zone outside it, so queries fetch
``[start - PAD, end + PAD)`` and keep rows overlapping ``[start, end)`` (a zero-width hit at ``p`` overlaps when
``start <= p < end``).

Comparison columns. A scan's values are long-format rows per (hit, group, value): groups ``all``, a dataset id,
or a channel ``<dataset id>::<channel>``. The hub shows, per hit and per column (``all`` and each scan dataset),
the type's score roles (contract §7): ``fp.class`` prevalence = the largest channel ``prevalence`` (per dataset:
its channels'), strength = ``support_gain_nats``; ``nfr.variant`` prevalence = ``prevalence_em`` (per dataset:
the molecule-weighted mean of its channels' ``em``); ``peaks.*`` strength = ``score``. Other types show their
pooled scores. Raw values are kept for the row's expansion.
"""
from __future__ import annotations

from typing import Dict, List, Optional

PAD = 5_000
MAX_HITS = 20_000

HIT_FIXED = ('chrom', 'start', 'end', 'idx_start', 'idx_end', 'hit_id', 'type', 'anchor', 'strand', 'unit_id', 'score',
             'label', 'flags', 'parent_id')


def _num(text) -> Optional[float]:
    if text is None or text == '':
        return None
    try:
        v = float(text)
    except (TypeError, ValueError):
        return None
    return None if v != v else v


def _overlaps(row: dict, start: int, end: int) -> bool:
    a, b = int(row['start']), int(row['end'])
    if b <= a:
        return start <= a < end
    return a < end and start < b


def _value_cell(row: dict) -> dict:
    return dict(v=_num(row.get('value')), lo=_num(row.get('lo')), hi=_num(row.get('hi')),
                n=_num(row.get('n_molecules')), nCallable=_num(row.get('n_callable')))


def _dataset_of_group(group: str, kind: str) -> Optional[str]:
    if kind == 'dataset':
        return group
    if kind == 'channel' and '::' in group:
        return group.split('::', 1)[0]
    return None


def role_columns(type_id: str, raw: Dict[str, Dict[str, dict]], kinds: Dict[str, str], scan_datasets: List[str]) -> Dict[str, Dict[str, dict]]:
    """Per column ('all' and each scan dataset): {'prevalence': cell, 'strength': cell} from the raw values."""
    out: Dict[str, Dict[str, dict]] = {}

    def put(col, role, cell):
        if cell is not None:
            out.setdefault(col, {})[role] = cell

    def best(cells):
        cells = [c for c in cells if c and c.get('v') is not None]
        return max(cells, key=lambda c: c['v']) if cells else None

    def weighted(cells):
        cells = [c for c in cells if c and c.get('v') is not None]
        if not cells:
            return None
        w = [max(1.0, c.get('n') or 0.0) for c in cells]
        v = sum(c['v'] * wi for c, wi in zip(cells, w)) / sum(w)
        return dict(v=v, n=sum(c.get('n') or 0 for c in cells) or None)

    channels_of = {ds: [g for g, k in kinds.items() if k == 'channel' and _dataset_of_group(g, k) == ds] for ds in scan_datasets}
    all_channels = [g for g, k in kinds.items() if k == 'channel']
    if type_id == 'fp.class':
        put('all', 'prevalence', best([raw.get(g, {}).get('prevalence') for g in all_channels]))
        put('all', 'strength', best([raw.get(g, {}).get('support_gain_nats') for g in all_channels]))
        for ds in scan_datasets:
            put(ds, 'prevalence', best([raw.get(g, {}).get('prevalence') for g in channels_of[ds]]))
            put(ds, 'strength', best([raw.get(g, {}).get('support_gain_nats') for g in channels_of[ds]]))
    elif type_id == 'nfr.variant':
        put('all', 'prevalence', raw.get('all', {}).get('prevalence_em'))
        for ds in scan_datasets:
            put(ds, 'prevalence', weighted([raw.get(g, {}).get('em') for g in channels_of[ds]]))
    elif type_id.startswith('peaks.'):
        put('all', 'strength', raw.get('all', {}).get('score'))
        for ds in scan_datasets:
            put(ds, 'strength', raw.get(ds, {}).get('score'))
    else:
        for ds in scan_datasets:
            cells = raw.get(ds) or {}
            if 'prevalence' in cells:
                put(ds, 'prevalence', cells['prevalence'])
        if 'prevalence' in (raw.get('all') or {}):
            put('all', 'prevalence', raw['all']['prevalence'])
    return out


def hits_for_view(scan, module: str, chrom: str, start: int, end: int, *, type_id: Optional[str] = None,
                  limit: int = MAX_HITS) -> dict:
    """Hits of one module (optionally one type) overlapping ``[start, end)``, with role columns per dataset."""
    rel = f'{module}/hits.tsv.bgz'
    rows = [r for r in scan.tables.fetch(rel, chrom, max(0, start - PAD), end + PAD)
            if _overlaps(r, start, end) and (type_id is None or r.get('type') == type_id)]
    truncated = len(rows) > limit
    rows = rows[:limit]
    values: Dict[str, list] = {}
    if rows and scan.tables.has(f'{module}/values.tsv.bgz'):
        lo = min(int(r['start']) for r in rows)
        hi = max(max(int(r['end']), int(r['start']) + 1) for r in rows)
        wanted = {r['hit_id'] for r in rows}
        for v in scan.tables.fetch(f'{module}/values.tsv.bgz', chrom, lo, hi):
            if v.get('hit_id') in wanted:
                values.setdefault(v['hit_id'], []).append(v)
    scan_datasets = [d.get('dataset_id') for d in scan.manifest.get('datasets') or []]
    hits = []
    for r in rows:
        raw: Dict[str, Dict[str, dict]] = {}
        kinds: Dict[str, str] = {}
        for v in values.get(r['hit_id'], ()):
            raw.setdefault(v['group'], {})[v['value_name']] = _value_cell(v)
            kinds[v['group']] = v.get('group_kind', '')
        columns = role_columns(r.get('type', ''), raw, kinds, scan_datasets)
        module_cols = {k: v for k, v in r.items() if k not in HIT_FIXED}
        flags = [f for f in str(r.get('flags') or '').split(',') if f]
        a, b = int(r['start']), int(r['end'])
        hits.append(dict(
            hitId=r['hit_id'], typeId=r.get('type'), chrom=r['chrom'], start=a, end=b,
            anchor=int(r['anchor']) if r.get('anchor') not in (None, '') else (a + b) // 2,
            strand=r.get('strand') if r.get('strand') in ('+', '-') else None,
            label=r.get('label') or '', score=_num(r.get('score')), unitId=r.get('unit_id'),
            parentId=r.get('parent_id') or None, flags=flags, zeroWidth=b <= a or 'zero_width' in flags,
            columns=columns, raw=raw, groupKinds=kinds, module=module_cols,
        ))
    return dict(hits=hits, truncated=truncated, chrom=chrom, start=start, end=end, module=module)


def units_for_view(scan, chrom: str, start: int, end: int) -> List[dict]:
    return [dict(unitId=u.get('unit_id'), start=u['start'], end=u['end'], zoneStart=u.get('zone_start'),
                 zoneEnd=u.get('zone_end'), status=u.get('status'), records=u.get('records'))
            for u in scan.tables.fetch('units.tsv.bgz', chrom, start, end)]


def find_hit(scan, module: str, hit_id: str) -> Optional[dict]:
    """A hit's row, located from its id (``<module>:<type>:<chrom>:<anchor>:<digest>``)."""
    parts = hit_id.split(':')
    if len(parts) < 5:
        return None
    try:
        anchor = int(parts[-2])
    except ValueError:
        return None
    chrom = ':'.join(parts[2:-2])
    for r in scan.tables.fetch(f'{module}/hits.tsv.bgz', chrom, max(0, anchor - 1), anchor + 1):
        if r.get('hit_id') == hit_id:
            return r
    # A hit whose envelope doesn't hold its anchor (never written so, but be safe): a padded search.
    for r in scan.tables.fetch(f'{module}/hits.tsv.bgz', chrom, max(0, anchor - PAD), anchor + PAD):
        if r.get('hit_id') == hit_id:
            return r
    return None
