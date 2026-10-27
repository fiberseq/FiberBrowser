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


def annotated_record_outputs(read, input_index: int, ctx) -> Optional[RecordOutputs]:
    """A record's own nuc groups (an annotated BAM) as the store's row, or None when it has none or they are stale
    (``fiberhmm.nuc.tags.read_nuc_groups``: the calls digest no longer matches, or another group version). Marks get
    their reference envelopes through the record's alignment, as the scan writes them (``_ref_envelope``)."""
    from fiberhmm.nuc.records import decode_record
    from fiberhmm.nuc.tags import read_nuc_groups
    from fiberhmm.scan.modules.nuc import _ref_envelope
    if not read.has_tag('MA'):
        return None
    mol, _why = decode_record(read, ctx)
    groups = read_nuc_groups(read, mol=mol) if mol is not None else read_nuc_groups(read)
    if not groups or any(g.get('stale') for g in groups.values()) or 'nucmol' not in groups:
        return None
    out_groups: Dict[str, list] = {g: [] for g in MARK_GROUPS}
    for g in MARK_GROUPS:
        info = groups.get(g)
        if not info:
            continue
        names = [f'{g}@{info.get("digest")}_{k}' for k in range(len(info['intervals']))] if info.get('digest') else \
            [''] * len(info['intervals'])
        for (s, n), q, name in zip(info['intervals'], info['q'], names):
            if mol is not None:
                a, b = _ref_envelope(mol, int(s), int(s) + int(n))
            else:
                a = b = int(read.reference_start)
            out_groups[g].append((int(s), int(n), int(a), int(b), tuple(int(x) for x in q), name))
    scalars = dict(groups['nucmol'].get('scalars') or {})
    flags = groups['nucmol'].get('flags') or {}
    from fiberhmm.nuc.tags import FLAG_BITS
    scalars['flags'] = float(sum(1 << i for i, k in enumerate(FLAG_BITS) if flags.get(k)))
    return RecordOutputs(
        qname=str(read.query_name), input_index=int(input_index), chrom=str(read.reference_name),
        ref_start=int(read.reference_start), ref_end=int(read.reference_end or read.reference_start),
        reverse=bool(read.is_reverse), supplementary=bool(read.is_supplementary),
        hp=int(read.get_tag('HP')) if read.has_tag('HP') else None, groups=out_groups,
        nucmol=[int(x) for x in (groups['nucmol']['q'][0] if groups['nucmol'].get('q') else [])], scalars=scalars,
        source='annotated', low_information=bool(flags.get('low_information')))


def loaded_rows(state, source, windows, keys) -> Dict[Tuple[str, str, int], RecordOutputs]:
    """Rows for ``keys`` ((file, sha, occ)) from what is loaded: the bound tables-mode scans' nuc rows, and the
    records' own groups when the dataset's files are annotated BAMs. Live outputs are not consulted here."""
    from services.scan.registry import list_scans
    want = {(real(p), s, int(o)) for p, s, o in keys}
    out: Dict[Tuple[str, str, int], RecordOutputs] = {}
    for scan in list_scans(state):
        if 'nuc' not in (scan.manifest.get('modules') or {}) or not scan.datasets_of_browser(source.browser_id):
            continue
        for chrom, a, b in windows:
            for key, row in scan_rows(scan, source.browser_id, chrom, a, b).items():
                if key in want and key not in out:
                    out[key] = row
    left = want - set(out)
    if left:
        out.update(_annotated(source, windows, left))
    return out


def _annotated(source, windows, keys) -> Dict[Tuple[str, str, int], RecordOutputs]:
    import pysam
    from fiberhmm.nuc.params import NucParams
    from fiberhmm.nuc.records import DecodeContext
    from fiberhmm.scan.reads import iter_records, resolve_read_policy
    filters = resolve_read_policy({})['filters']
    out: Dict[Tuple[str, str, int], RecordOutputs] = {}
    for i, path in enumerate(source.paths):
        if not any(k[0] == path for k in keys):
            continue
        with pysam.AlignmentFile(path, 'rb') as bam:
            if not any(line.startswith('FIBERHMM-SCAN-MA:v1:') and '"nucsz"' in line
                       for line in bam.header.to_dict().get('CO', [])):
                continue          # not an annotated BAM with nuc groups
            ctx = DecodeContext(bam.header, NucParams())
            from .live import bam_chrom
            refs = list(bam.references)
            for chrom, a, b in windows:
                chrom = bam_chrom(refs, chrom)
                if chrom is None:
                    continue
                for read, sha, occ in iter_records(bam, chrom, int(a), int(b), {**filters, 'duplicates': 'include'}):
                    key = (path, sha, int(occ))
                    if key in keys and key not in out:
                        row = annotated_record_outputs(read, i, ctx)
                        if row is not None:
                            out[key] = row
    return out
