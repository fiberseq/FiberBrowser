"""Per-record state adapters for browser hits. Descriptors travel in hub refs/session selections.

No geometry-only match is promoted to allele sequence identity. Unmeasured and
unresolved records retain '.', including partial graph paths.
"""
from __future__ import annotations


def record_states(reads, evaluate):
    from services.lift.cohort import record_key
    per = {}
    for read in reads:
        key = record_key(read.get('analysis_id')) or read.get('analysis_id') or read.get('id')
        if key:
            per.setdefault(key, set()).add(evaluate(read))
    return {key: next(iter(v)) if len(v) == 1 else '.' for key, v in per.items()}


def browser_feature_states(state, source, feature):
    hit = feature.get('hub_hit')
    if not isinstance(hit, dict) or hit.get('setId') != source:
        raise ValueError('Restore this browser hit in the hub before using its states')
    chrom, start, end = hit['chrom'], int(hit['start']), int(hit['end'])
    spec = hit.get('stateSpec') or {}
    datasets = [d for d in hit.get('datasets', []) if d in state.datasets]
    if not datasets:
        raise ValueError('No loaded dataset supplies this browser hit')
    out = {}
    for ds in datasets:
        dataset = state.datasets[ds]
        kind = spec.get('kind', 'region')
        if kind == 'difference' or (kind == 'sv' and getattr(dataset, 'data_type', None) == 'bam_livelift'):
            target = spec.get('target')
            if kind == 'sv':
                target = dict(target_id=hit['hitId'], revision=1, target_type='geometry', chrom=chrom, ref_start=start, ref_end=end, alt_bp=int(spec['length']) if spec['t'] == 'I' else 0)
            if target:
                from services.differences.workspace import inspect
                from services.lift.cohort import record_key
                result = inspect(state, dataset, chrom=chrom, start=max(0, start - 100), end=max(end, start + 1) + 100, target=target)
                calls = (result.get('targets') or [{}])[0].get('calls_by_molecule') or {}
                per = {}
                for row, molecule in (result.get('membership', {}).get('rows', {}).get(ds) or {}).items():
                    c = calls.get(molecule, {}).get('call') or {}
                    v = '1' if c.get('assignment') == 'target' and c.get('level') == 'confirmed' else '0' if c.get('assignment') == 'reference' else '.'
                    per.setdefault(record_key(row) or row, set()).add(v)
                out.update({(ds, k): next(iter(v)) if len(v) == 1 else '.' for k, v in per.items()})
                continue
        if kind == 'snp':
            import pysam
            import hashlib
            from services.snp_scan import read_alleles, BASES, MISSING, HAS_EVENT, NO_EVENT, N
            from services.scan.states import _Keyer
            from utils.chrom import resolve_reference_name
            keyer = _Keyer(state, ds, dict(enumerate(dataset.paths)))
            for i, path in enumerate(dataset.paths):
                with pysam.AlignmentFile(path, 'rb') as bam:
                    name = resolve_reference_name(chrom, bam.references)
                    if name is None:
                        continue
                    occurrences = {}
                    for read in bam.fetch(name, max(0, start - 1), max(end, start + 1) + 1):
                        digest = hashlib.sha256(read.to_string().encode()).hexdigest()
                        occ = occurrences.get(digest, 0)
                        occurrences[digest] = occ + 1
                        key = keyer.key(i, read.query_name, f'{digest}:{occ}')
                        decoded = read
                        if read.is_supplementary:
                            # The SNP caller samples primaries for discovery. This adapter answers an already
                            # chosen site for each record, so decode its supplementary without changing the BAM.
                            decoded = pysam.AlignedSegment.fromstring(read.to_string(), bam.header)
                            decoded.flag &= ~0x800
                        matrix = read_alleles([decoded], name, max(0, start - 1), max(end, start + 1) + 1,
                            [dict(id=feature['id'], pos=start, kind=spec.get('variantKind', 'snv'), length=spec.get('length', 1))])
                        code = int(matrix.codes[0, 0]) if len(matrix.names) else MISSING
                        if code in (MISSING, N):
                            value = '.'
                        elif spec.get('variantKind') == 'snv':
                            alt = [spec['alt']] if spec.get('alt') else (spec.get('alleles') or [])[-1:]
                            value = '1' if alt and BASES[code] == alt[0] else '0'
                        else:
                            value = '1' if code == HAS_EVENT else '0' if code == NO_EVENT else '.'
                        previous = out.get((ds, key))
                        out[(ds, key)] = value if previous in (None, value) else '.'
            continue
        pad = 100
        lo, hi = max(0, start - pad), max(end, start + 1) + pad
        ws = state.build_working_set(ds, chrom, lo, hi, include_methylation=False, include_layers=True)
        def evaluate(read):
            from services.sv_events import read_spans, classify_allele
            covered = read_spans(read, start, max(end, start + 1))
            if not covered:
                return '.'
            if kind == 'sv':
                code = classify_allele(read, spec['t'], start, int(spec['length']))
                return {0: '1', 1: '0'}.get(code, '.')
            if kind == 'graph':
                hap = (read.get('live_lift') or {}).get('hap_label') or (read.get('live_lift') or {}).get('hap') or read.get('hap') or read.get('hp')
                paths = spec.get('paths') or {}
                candidates = [p for p in paths.values() if ds in p.get('datasets', []) and (not p.get('hap') or p.get('hap') == hap)]
                statuses = {p.get('state') for p in candidates}
                return next(iter(statuses)) if len(statuses) == 1 else '.'
            if kind == 'difference':
                return '.'
            # Peak-open: an explicit MSP spanning the anchor, measured outside it = 0.
            if kind == 'open':
                layer = (read.get('layers') or {}).get('msp')
                if layer is None:
                    return '.'
                intervals = layer.get('intervals', []) if isinstance(layer, dict) else layer
                anchor = int(hit.get('anchor', start)) - lo
                return '1' if any(iv[0] <= anchor < iv[1] for iv in intervals) else '0'
            return '.'
        out.update({(ds, k): v for k, v in record_states(ws.reads, evaluate).items()})
    return out, datasets, hit.get('label'), (start, end)
