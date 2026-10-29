"""Full target-frame record evidence reconstructed from live-lift compact rows.

The provider includes all source records for data-scope calibration. It never
uses viewport sampling or reuses the source BAM's content ID for lifted bytes.
The scan dialog remains gated separately by scan-table parity.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib


class EvidenceError(ValueError):
    pass



class ScanCancellation:
    """Bridge evidence's cancel() and the runner's event.is_set() interface."""
    def __init__(self, callback):
        self.callback = callback

    def is_set(self):
        return bool(self.callback())

    __call__ = is_set


def target_header(source_header, handle):
    import pysam
    from fiberhmm.io.graph_lift import RepairStats, lift_pg_record
    header = source_header.to_dict()
    header['SQ'] = [{'SN': t['name'], 'LN': int(t['size'])} for t in handle.map.m['targets']]
    header.setdefault('PG', []).append(dict(ID='fiberbrowser-live-lift', **lift_pg_record(
        repair=RepairStats(), calmd=False, engine='native', command='FiberBrowser live-lift evidence')))
    return pysam.AlignmentHeader.from_dict(header)


def row_record(row, source, header, origin):
    """One compact placement -> a full target SAM record, with molecular calls.

    Molecular spans supply aligned query bases; gaps between them supply I/D
    operations. Original sequence, qualities and annotation payloads come from
    the complete source record, never from clipped display intervals.
    """
    import pysam
    from fiberhmm.io.frame_carry import carry_to_molecular
    from fiberhmm.io.graph_lift import RepairStats, repair_record, revcomp
    ll = row['live_lift']
    spans = sorted(ll.get('molecular_spans') or [])
    if not spans:
        raise EvidenceError('A live-lift row has no molecular alignment spans')
    if any(op == 5 for op, _n in source.cigartuples or []):
        raise EvidenceError('Compact scan evidence needs full sequence for hard-clipped records')
    copy = pysam.AlignedSegment.fromstring(source.to_string(), source.header)
    carry_to_molecular(copy)
    reverse = row.get('alignment_orientation') == 'reverse'
    flipped = reverse != source.is_reverse
    length = len(copy.query_sequence or '')
    if not length:
        raise EvidenceError('Compact scan evidence needs the complete source sequence')
    cigar = []
    def add(op, n):
        if n < 0:
            raise EvidenceError('A live-lift placement reverses or overlaps molecular spans')
        if n:
            if cigar and cigar[-1][0] == op:
                cigar[-1] = (op, cigar[-1][1] + n)
            else:
                cigar.append((op, n))
    qpos, rpos = 0, int(spans[0][0])
    for start, end, mol, step, primary in spans:
        if not primary or int(step) != (-1 if reverse else 1):
            raise EvidenceError('Compact scan evidence requires one primary colinear placement')
        q = length - 1 - int(mol) if reverse else int(mol)
        add(4 if not cigar else 1, q - qpos)
        add(2, int(start) - rpos)
        add(0, int(end) - int(start))
        qpos, rpos = q + int(end) - int(start), int(end)
    add(4, length - qpos)
    result = pysam.AlignedSegment(header)
    result.query_name = copy.query_name
    result.flag = (copy.flag & ~16) | (16 if reverse else 0)
    result.reference_id = header.get_tid(row.get('chrom') or row.get('contig') or ll.get('target', ''))
    if result.reference_id < 0:
        # A provider sets chrom explicitly; reject ambiguous reference identities.
        raise EvidenceError('A live-lift row has no target contig in the supplied header')
    result.reference_start = int(origin) + int(spans[0][0])
    result.mapping_quality = copy.mapping_quality
    result.query_sequence = revcomp(copy.query_sequence) if flipped else copy.query_sequence
    qualities = copy.query_qualities
    if qualities is not None:
        result.query_qualities = qualities[::-1] if flipped else qualities
    result.cigartuples = cigar
    result.set_tags([(tag, value) if kind == 'B' else (tag, value, kind)
                     for tag, value, kind in copy.get_tags(with_value_type=True)])
    result.set_tag('Yf', source.flag)
    result.set_tag('Yq', source.mapping_quality)
    result.set_tag('Yp', f'{source.reference_name}:{source.reference_start + 1}:{"-" if source.is_reverse else "+"}')
    repair_record(result, RepairStats())
    if ll.get('source', {}).get('supplementary'):
        result.is_supplementary = True
    if ll.get('orphan'):
        result.set_tag('Yo', 'no_lifted_primary')
    return result


def lifted_input(dataset, *, dataset_id, cancel=None):
    """Return (scan dataset specification, one-pass evidence callback).

    Source extents determine all target windows before loading; a truncated or
    incomplete compact load refuses the scan rather than biasing calibration.
    """
    import pysam
    from services.lift.live_lift import load_lifted_rows
    from services.lift.cohort import prepare_lift_cohort
    from services.hub.assoc_inputs import merge_regions
    config = dataset.live_lift
    handle = config.handle
    paths = list(dataset.paths)
    if config.settings.fold_molecule or config.settings.fold_orientation_rows:
        raise EvidenceError('Compact scan evidence requires record-scoped rows')
    source_records, headers, extents = {}, [], {}
    for i, path in enumerate(paths):
        occurrences = defaultdict(int)
        with pysam.AlignmentFile(path, 'rb') as bam:
            headers.append(target_header(bam.header, handle))
            for read in bam:
                if cancel is not None and cancel():
                    raise InterruptedError('cancelled')
                if read.is_unmapped or read.is_secondary:
                    continue
                sha = hashlib.sha256(read.to_string().encode()).hexdigest()
                occurrence = occurrences[sha]
                occurrences[sha] += 1
                source_records[(i, f'{sha}:{occurrence}')] = read
                c = read.reference_name
                a, b = extents.get(c, (read.reference_start, read.reference_end))
                extents[c] = min(a, read.reference_start), max(b, read.reference_end)
    windows = merge_regions((handle.map.m['targets'][handle.map.chains[p.chain]['target']]['name'], p.t_start, p.t_end) for c, (a, b) in extents.items()
                            for p in handle.map.source_to_target(c, a, b) if p.primary)
    # Merge extents per target: every record is composed over its complete placement.
    hulls = {}
    for c, a, b in windows:
        lo, hi = hulls.get(c, (a, b))
        hulls[c] = min(lo, a), max(hi, b)

    source_entries = []
    def evidence():
        seen = set()
        source_entries.clear()
        occurrences = defaultdict(int)
        for chrom, (a, b) in sorted(hulls.items()):
            if cancel is not None and cancel():
                raise InterruptedError('cancelled')
            loaded = load_lifted_rows(handle, paths, chrom, a, b,
                haplotypes=handle.resolve_haplotypes(config.haplotypes or handle.haplotypes), settings=config.settings,
                dataset_id=dataset.id, use_cache=False,
                loader_options=dict(include_methylation=True, include_layers=True, include_duplicates=True, hide_terminal_gaps=False))
            if loaded.truncated:
                raise EvidenceError('Live-lift evidence was truncated; the scan cannot use a partial population')
            prepared = prepare_lift_cohort(loaded.rows, 'analysis', config.settings)
            for row in prepared.rows:
                ll = row['live_lift']
                key = (int(ll['library']), ll['record'])
                identity = (chrom, key, ll.get('placement'), ll.get('row_index'))
                if identity in seen:
                    continue
                seen.add(identity)
                source = source_records.get(key)
                if source is None:
                    raise EvidenceError('A compact row cannot be joined to its complete source record')
                row = dict(row, chrom=chrom)
                spans = sorted(ll.get('molecular_spans') or [])
                groups = []
                for span in spans:
                    if not groups or span[0] - groups[-1][-1][1] >= config.settings.g_split:
                        groups.append([])
                    groups[-1].append(span)
                primary = max(range(len(groups)), key=lambda i: sum(s[1] - s[0] for s in groups[i])) if groups else 0
                for i, part in enumerate(groups):
                    split = dict(row, live_lift=dict(ll, molecular_spans=part))
                    record = row_record(split, source, headers[key[0]], loaded.region_start)
                    record.is_supplementary = source.is_supplementary or i != primary
                    sha = hashlib.sha256(record.to_string().encode()).hexdigest()
                    occurrence = occurrences[(key[0], sha)]
                    occurrences[(key[0], sha)] += 1
                    source_entries.append(dict(dataset_id=dataset_id, input_index=key[0],
                        record=f'{sha}:{occurrence}', source_record=key[1]))
                    yield dataset_id, key[0], record
    evidence.source_records = source_entries
    return dict(dataset_id=dataset_id, headers=headers), evidence


# Lift this only after the demo scan-table gates pass, including calibration.
LIVE_LIFT_SCAN_PARITY = True


def input_ids(dataset):
    """Immutable evidence IDs in the browser registry, distinct from source IDs."""
    import json
    from services.scan.identity import content_id
    from services.lift.live_lift import lift_key
    config = dataset.live_lift
    key = lift_key(config.handle, config.handle.resolve_haplotypes(config.haplotypes or config.handle.haplotypes), config.settings)
    source_ids = [content_id(p) for p in dataset.paths]
    return ['cid:v1:' + hashlib.sha256(json.dumps(['compact-evidence-v1', source_ids, key, i],
            sort_keys=True, separators=(',', ':')).encode()).hexdigest() for i in range(len(source_ids))]


def run_live_units(state, datasets, units, *, runner, **kwargs):
    """The browser scan job's mixed native/live-lift evidence route."""
    import json
    import pysam
    from pathlib import Path
    specs, providers = [], []
    cancel_event = kwargs.get('cancel')
    cancel = cancel_event.is_set if cancel_event is not None else None
    for item in datasets:
        if item.get('live_lift'):
            dataset = state.datasets[item['browser_id']]
            spec, provider = lifted_input(dataset, dataset_id=item['dataset_id'], cancel=cancel)
            spec.update(paths=item['paths'], chemistry=item['chemistry'], content_ids=item['content_ids'])
        else:
            spec = {k: item[k] for k in ('dataset_id', 'paths', 'chemistry')}
            def provider(spec=spec):
                for i, path in enumerate(spec['paths']):
                    with pysam.AlignmentFile(path, 'rb') as bam:
                        for record in bam:
                            if cancel and cancel():
                                raise InterruptedError('cancelled')
                            yield spec['dataset_id'], i, record
        specs.append(spec)
        providers.append(provider)
    def evidence():
        for provider in providers:
            yield from provider()
    if cancel is not None:
        kwargs['cancel'] = ScanCancellation(cancel)
    from services.background_work import cancel_scope
    with cancel_scope(cancel_event):
        result = runner(specs, units, evidence=evidence, **kwargs)
    record_map = [entry for provider in providers for entry in getattr(provider, 'source_records', [])]
    folder = Path(kwargs['out']) / 'work'
    folder.mkdir(exist_ok=True)
    (folder / 'live_lift_records.json').write_text(json.dumps(record_map, sort_keys=True))
    return result


def source_record_map(scan):
    import json
    from pathlib import Path
    root = getattr(scan, 'path', None)
    if root is None:
        return {}
    path = Path(root) / 'work' / 'live_lift_records.json'
    if not path.is_file():
        return {}
    return {(r['dataset_id'], int(r['input_index']), r['record']): r['source_record']
            for r in json.loads(path.read_text())}
