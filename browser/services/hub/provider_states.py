"""Per-record state adapters for browser hits. Descriptors travel in hub refs/session selections.

No geometry-only match is promoted to allele sequence identity. Unmeasured and
unresolved records retain '.', including partial graph paths.
"""
from __future__ import annotations

import contextvars
from contextlib import contextmanager

#: Peak-open hits of one hub run read one working set per dataset and window cluster (see shared_windows).
_SHARED = contextvars.ContextVar('hub_shared_windows', default=None)
#: the layers a peak-open state reads (both routes ask for exactly these)
OPEN_LAYERS = ['msp']
SHARED_SPAN = 60_000


def record_states(reads, evaluate, read_of=None):
    from services.lift.cohort import record_key
    per = {}
    for item in reads:
        read = item if read_of is None else read_of(item)
        key = record_key(read.get('analysis_id')) or read.get('analysis_id') or read.get('id')
        if key:
            per.setdefault(key, set()).add(evaluate(item))
    return {key: next(iter(v)) if len(v) == 1 else '.' for key, v in per.items()}


def _open_window(hit):
    spec = hit.get('stateSpec') or {}
    if spec.get('kind', 'region') != 'open':
        return None
    start, end = int(hit['start']), int(hit['end'])
    return str(hit['chrom']), max(0, start - 100), max(end, start + 1) + 100


@contextmanager
def shared_windows(state, hits):
    """Within this block, peak-open hits ('open' stateSpec) on native BAM datasets read one working set per
    dataset over a cluster of their windows (at most ``SHARED_SPAN`` bp) instead of one per hit: every read is
    projected once, not once per peak it crosses. The states equal the per-hit working sets' exactly: every record
    a per-hit working set holds (alignment overlapping the hit's padded window) is evaluated, a record not covering
    the hit as '.', so a read with one covering and one partial record stays '.' (``record_states``). Both routes
    load only the MSP layer (``OPEN_LAYERS``: the loader keeps or drops a read by the layers asked for). Off when the
    server caps working sets (a wider window would sample differently), when quality filters are active (they are
    applied per window), on circular contigs (origin-wrapping alignments), and for datasets whose MSPs are inferred
    from legacy nucleosome gaps (``_infers_msps``)."""
    from services.read_quality_filters import active_quality_filters
    if getattr(state, 'max_working_reads', 0) or active_quality_filters(state):
        yield
        return
    from services.circular_genome import is_circular_chrom
    by_chrom = {}
    for h in hits:
        w = _open_window(h) if isinstance(h, dict) else None
        if w and is_circular_chrom(state, w[0]):
            continue
        if w:
            by_chrom.setdefault(w[0], []).append(w[1:])
    windows = {}
    for chrom, spans in by_chrom.items():
        out = []
        for lo, hi in sorted(spans):
            if out and hi - out[-1][0] <= SHARED_SPAN and lo <= out[-1][1] + SHARED_SPAN:
                out[-1] = (out[-1][0], max(out[-1][1], hi))
            else:
                out.append((lo, hi))
        windows[chrom] = out
    token = _SHARED.set(dict(windows=windows, cache={}))
    try:
        yield
    finally:
        _SHARED.reset(token)


def _msp_index(read):
    """(starts, ends, intervals, sorted and disjoint) of a read's MSP layer, or None without one."""
    layer = (read.get('layers') or {}).get('msp')
    if layer is None:
        return None
    ivs = layer.get('intervals', []) if isinstance(layer, dict) else layer
    starts = [iv[0] for iv in ivs]
    ends = [iv[1] for iv in ivs]
    ok = all(starts[i] < ends[i] for i in range(len(ivs))) and \
        all(ends[i] <= starts[i + 1] for i in range(len(ivs) - 1))
    return starts, ends, ivs, ok


def _msp_open(index, a0, a1, anchor):
    """The peak-open state of one read in a shared window: '.' when no MSP reaches into [a0, a1) (a per-hit
    working set would hold no MSP layer), 1 when an MSP spans the anchor, else 0. Bisection over sorted,
    disjoint MSPs; any other layout is scanned."""
    from bisect import bisect_left, bisect_right
    if index is None:
        return '.'
    starts, ends, ivs, ok = index
    if ok:
        j = bisect_left(starts, a1) - 1          # the last MSP starting before a1 ends latest among them
        if j < 0 or ends[j] <= a0:
            return '.'
        j = bisect_right(starts, anchor) - 1
        return '1' if j >= 0 and anchor < ends[j] else '0'
    if not any(min(iv[1], a1) > max(iv[0], a0) for iv in ivs):
        return '.'
    return '1' if any(iv[0] <= anchor < iv[1] for iv in ivs) else '0'


def _infers_msps(dataset) -> bool:
    """Whether the dataset's MSPs are inferred from legacy nucleosome footprints (ns/nl, no MSP or FIRE calls): the
    loader takes the gaps between the nucleosomes inside the loaded window, so a wider shared window could open
    a gap a per-hit window leaves without an MSP. Those datasets read per hit."""
    layers = getattr(dataset, 'available_layers', None) or {}
    return bool(layers.get('footprint')) and not layers.get('msp') and not layers.get('fire')


def _shared_reads(state, ds, chrom, lo, hi):
    """(reads covering [lo, hi) candidates, window start) from the run's shared working set, or None."""
    shared = _SHARED.get()
    if not shared:
        return None
    dataset = state.datasets.get(ds)
    if getattr(dataset, 'data_type', None) != 'bam' or _infers_msps(dataset):
        return None
    for wlo, whi in shared['windows'].get(chrom, ()):
        if wlo <= lo and hi <= whi:
            key = (ds, chrom, wlo, whi)
            if key not in shared['cache']:
                # only the MSP layer is read here (each layer is projected on its own, so it is the same)
                ws = state.build_working_set(ds, chrom, wlo, whi, include_methylation=False, include_layers=True,
                                             requested_layers=list(OPEN_LAYERS))
                shared['cache'][key] = [(r, _msp_index(r)) for r in ws.reads]
            return shared['cache'][key], wlo
    return None


def browser_feature_states(state, source, feature):
    hit = feature.get('hub_hit')
    if not isinstance(hit, dict) or hit.get('setId') != source:
        raise ValueError('Restore this browser hit in the hub before using its states')
    chrom, start, end = hit['chrom'], int(hit['start']), int(hit['end'])
    spec = hit.get('stateSpec') or {}
    if spec.get('kind') == 'nuc-geometry':
        # A nucleosome panel's shared geometry: the panel's own analysis (cached), the scan's state mapping.
        from services.nuc.nucgeo import geometry_record_states
        kind = 'low' if str(hit.get('hitId') or '').startswith('geometry-low:') or 'low' in (hit.get('flags') or []) else 'high'
        states, found = geometry_record_states(state, spec.get('request') or {}, str(spec.get('geometryId') or ''),
                                               span=(start, end), kind=kind)
        wanted = [d for d in hit.get('datasets', []) if d in state.datasets] or found
        return ({k: v for k, v in states.items() if k[0] in wanted}, wanted, hit.get('label'),
                (int(hit['start']), int(hit['end'])))
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
            if getattr(dataset, 'data_type', None) not in ('bam', 'bam_livelift'):
                # A bigBed (FiberHMM var layer) dataset has no records to read alleles from.
                continue
            import pysam
            import hashlib
            from services.snp_scan import read_alleles, BASES, MISSING, HAS_EVENT, NO_EVENT, N
            from services.scan.states import _Keyer
            from services.signal_evidence import record_keeps_signal, signal_header
            from services.graph_lift import lift_hidden_predicate
            from utils.chrom import resolve_reference_name
            keyer = _Keyer(state, ds, dict(enumerate(dataset.paths)))
            for i, path in enumerate(dataset.paths):
                with pysam.AlignmentFile(path, 'rb') as bam:
                    name = resolve_reference_name(chrom, bam.references)
                    if name is None:
                        continue
                    provenance = signal_header(bam.header)
                    hidden = lift_hidden_predicate(bam.header)
                    occurrences = {}
                    for read in bam.fetch(name, max(0, start - 1), max(end, start + 1) + 1):
                        digest = hashlib.sha256(read.to_string().encode()).hexdigest()
                        occ = occurrences.get(digest, 0)
                        occurrences[digest] = occ + 1
                        # The records the read loader keeps by default (as the other kinds' working sets): no
                        # secondary, duplicate or QC-fail record, no lift-hidden one, the signal filters applied.
                        if (read.is_unmapped or read.is_secondary or read.is_duplicate or read.is_qcfail
                                or (hidden is not None and hidden(read)) or not record_keeps_signal(read, provenance)):
                            continue
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
        got = _shared_reads(state, ds, chrom, lo, hi) if kind == 'open' else None
        if got is not None:
            # the records a per-hit working set would hold: alignment overlapping [lo, hi), as its fetch selects them.
            # A record not covering the hit is '.' and still counts towards its read's state (a read with a
            # covering and a partial record is '.', as per hit).
            from services.sv_events import read_spans
            b = max(end, start + 1)
            a0, a1, anchor = lo - got[1], hi - got[1], int(hit.get('anchor', start)) - got[1]
            reads = [(r, ix) for r, ix in got[0] if isinstance(r.get('reference_start'), int)
                     and isinstance(r.get('reference_end'), int) and r['reference_start'] < hi and r['reference_end'] > lo]
            out.update({(ds, k): v for k, v in record_states(
                reads, lambda item: _msp_open(item[1], a0, a1, anchor) if read_spans(item[0], start, b) else '.',
                read_of=lambda item: item[0]).items()})
            continue
        reads = state.build_working_set(ds, chrom, lo, hi, include_methylation=False, include_layers=True,
                                        **({'requested_layers': list(OPEN_LAYERS)} if kind == 'open' else {})).reads
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
        out.update({(ds, k): v for k, v in record_states(reads, evaluate).items()})
    return out, datasets, hit.get('label'), (start, end)
