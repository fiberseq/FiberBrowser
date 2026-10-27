"""Nucleosome rows read from an opened scan (CONTRACTS §7, §11.3), in the store's shape.

- Tables mode (BED scans, ``--no-annotate``, the browser's scan cache): ``nuc/marks.tsv.bgz`` (one row per
  ``nucsz``/``nucseg`` mark: reference envelope, molecular start and length, bytes, AN name) and
  ``nuc/molecules.tsv.bgz`` (exact scalars), keyed by (dataset_id, input_index, record).
- Annotated BAMs carry the groups on the records themselves: ``read_nuc_groups`` decodes them, with the staleness
  rule (calls digest) and group versions.

Rows join a loaded dataset's records through the scan's binding (its scan dataset and input file per browser
file), never by read name alone.
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

from .inputs import real
from .store import RecordOutputs

MARK_GROUPS = ('nucsz', 'nucseg')


def _float(value) -> Optional[float]:
    if value in (None, ''):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def scan_rows(scan, browser_id: str, chrom: str, start: int, end: int) -> Dict[Tuple[str, str, int], RecordOutputs]:
    """``{(file, sha, occ): RecordOutputs}`` of a tables-mode scan's nuc rows for a bound browser dataset, over
    records whose alignment overlaps ``[start, end)`` (molecules) and their marks."""
    files: Dict[Tuple[str, int], str] = {}
    for sid, bid, _via, by_index in scan.bound_pairs():
        if bid == browser_id:
            for i, path in by_index.items():
                files[(sid, int(i))] = real(path)
    if not files or not scan.tables.has('nuc/molecules.tsv.bgz'):
        return {}
    out: Dict[Tuple[str, str, int], RecordOutputs] = {}
    for row in scan.tables.fetch('nuc/molecules.tsv.bgz', chrom, start, end):
        path = files.get((row.get('dataset_id'), int(row.get('input_index') or 0)))
        if path is None or ':' not in str(row.get('record') or ''):
            continue
        sha, occ = str(row['record']).rsplit(':', 1)
        scalars = {k: _float(v) for k, v in row.items()
                   if k not in ('chrom', 'start', 'end', 'idx_start', 'idx_end', 'dataset_id', 'input_index', 'qname',
                                'record', 'molecule')}
        flags = int(scalars.get('flags') or 0)
        out[(path, sha, int(occ))] = RecordOutputs(
            qname=str(row.get('qname') or ''), input_index=int(row.get('input_index') or 0), chrom=str(row['chrom']),
            ref_start=int(row['start']), ref_end=int(row['end']), reverse=False, supplementary=False, hp=None,
            groups={g: [] for g in MARK_GROUPS}, nucmol=[], scalars=scalars, source=f'scan:{scan.scan_id}',
            low_information=bool(flags & 16))
    if not out or not scan.tables.has('nuc/marks.tsv.bgz'):
        return out
    lo = min(r.ref_start for r in out.values())
    hi = max(r.ref_end for r in out.values())
    for row in scan.tables.fetch('nuc/marks.tsv.bgz', chrom, lo, max(hi, lo + 1)):
        path = files.get((row.get('dataset_id'), int(row.get('input_index') or 0)))
        if path is None or ':' not in str(row.get('record') or ''):
            continue
        sha, occ = str(row['record']).rsplit(':', 1)
        rec = out.get((path, sha, int(occ)))
        if rec is None or row.get('group') not in MARK_GROUPS:
            continue
        q = tuple(int(x) for x in str(row.get('q') or '').split(',') if x != '')
        name = row.get('name') if row.get('name') not in (None, '.') else ''
        rec.groups[row['group']].append((int(row['mol_start']), int(row['mol_len']), int(row['start']), int(row['end']),
                                         q, str(name)))
    for rec in out.values():
        for g in MARK_GROUPS:
            rec.groups[g].sort(key=lambda m: (m[0], m[1], m[4][:1]))
    return out


def annotated_rows(read) -> Optional[dict]:
    """A record's own nuc groups (an annotated BAM), decoded with the staleness rule: ``{group: {...}}``
    (``fiberhmm.nuc.tags.read_nuc_groups``), or None when it has none."""
    from fiberhmm.nuc.tags import read_nuc_groups
    groups = read_nuc_groups(read)
    return groups or None
