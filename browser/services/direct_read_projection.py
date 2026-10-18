"""Contained projections of a complete direct-load cohort."""
from __future__ import annotations


_POSITION_FIELDS = ('methyl', 'methyl_m6a', 'methyl_m5c', 'possible_deam_ct', 'possible_deam_ga')


def direct_scan_counts(state, query, dataset_id, signal_source):
    """Reuse primary interval counts without expanding the cached marks/layers."""
    if (getattr(state, 'performance', {}).get('effective') == 'low'
            and getattr(state, 'max_working_reads', 0)
            and query.read_ids_for_dataset(dataset_id) is not None):
        return None  # Match the working set's selection before decoding.
    if (not getattr(state, '_methylation_cache', None)
            or signal_source not in {'accessibility', 'tf_density'} or query.min_footprints or query.strand_by_dataset):
        return None
    from services.read_quality_filters import active_quality_filters
    # FIRE-only gates cannot change primary intervals or their read membership.
    if any(f.get('layer') not in {'fire', 'msp'} for f in active_quality_filters(state)
           if f.get('min_value', 0) > 0):
        return None
    from services.working_sets import _broad_cache_sync, read_load_token
    from services.circular_genome import circular_chrom_size
    from services.consensus_workflow import active
    if circular_chrom_size(state, query.chrom) or active(state, dataset_id, query.chrom, query.start, query.end):
        return None
    token = read_load_token(state, query.chrom)
    lock, _ = _broad_cache_sync(state)
    with lock:
        candidates = list(getattr(state, '_methylation_cache', {}).items())
    for key, (reads, _) in candidates:
        if (len(key) not in (20, 25) or (len(key) == 25 and key[21]) or key[:2] != (dataset_id, query.chrom)
                or not key[2] <= query.start < query.end <= key[3]
                or key[7] or key[8] or key[11] or key[12] or key[15] or key[16] or key[17] != token):
            continue
        offset, width = query.start - key[2], query.end - query.start
        ids = query.read_ids_for_dataset(dataset_id)
        wanted = set(ids) if ids is not None else None
        selected = []
        from services.packed_reads import select_read_ids
        for read in select_read_ids(reads, wanted):
            iv = read.get('intervals') or []
            if not iv or iv[-1][1] <= offset or iv[0][0] >= offset + width:
                continue
            if wanted is not None and read.get('id') not in wanted:
                continue
            if query.spanning and (iv[0][0] > offset or iv[-1][1] < offset + width):
                continue
            selected.append(read)
        cap = int(getattr(state, 'max_working_reads', 0) or 0)
        if wanted is None and cap > 0 and len(selected) > cap:
            continue
        from services.peak_scanning import compute_scan_counts
        numerator, total = compute_scan_counts(selected, signal_source, width, coordinate_offset=offset)
        return numerator, total, len(selected)
    return None


def project_direct_reads(reads, loaded_start, start, end, *, include_marks=True):
    """Keep alignment identity and aligned metadata while clipping a linear view.

    Missing terminal-call provenance and circular/CIGAR geometry fail closed.
    The source dictionaries and their dense evidence remain owned by the cache.
    """
    offset, width = start - loaded_start, end - start
    result = []
    for read in reads:
        if ('_fiberbrowser_terminal_gaps' not in read or read.get('alignment_spans')
                or read.get('cigar') or read.get('circular_ids')):
            return None
        intervals = read.get('intervals') or []
        if not intervals:
            return None
        if intervals[-1][1] <= offset or intervals[0][0] >= offset + width:
            continue

        def clip(values):
            return [(i, [max(0, s - offset), min(width, e - offset), n])
                    for i, (s, e, n) in enumerate(values)
                    if e > offset and s < offset + width]

        primary = clip(intervals)
        if not primary:
            return None
        projected = {key: value for key, value in read.items() if not key.startswith('_fiberbrowser_')}
        projected['_fiberbrowser_terminal_gaps'] = read['_fiberbrowser_terminal_gaps']
        projected['intervals'] = [iv for _, iv in primary]
        for i, iv in primary:
            s, e, n = intervals[i]
            if n < 0:
                gap = next(((lo, hi) for lo, hi in read['_fiberbrowser_terminal_gaps']
                            if lo <= s + loaded_start and e + loaded_start <= hi), None)
                if gap is not None:
                    iv[2] = -(min(end, gap[1]) - max(start, gap[0]))
        if 'qualities' in read:
            quality_indices = {}
            q = 0
            for i, iv in enumerate(intervals):
                if iv[2] > 0:
                    quality_indices[i] = q
                    q += 1
            projected['qualities'] = [read['qualities'][quality_indices[i]] for i, iv in primary
                                      if iv[2] > 0 and quality_indices[i] < len(read['qualities'])]
            if not projected['qualities']:
                del projected['qualities']
        for key in ('annotation_names', 'circular_ids'):
            if len(read.get(key) or []) == len(intervals):
                projected[key] = [read[key][i] for i, _ in primary]
        for key in _POSITION_FIELDS:
            if key in read:
                projected[key] = [p - offset for p in read[key] if offset <= p < offset + width] if include_marks else []
                if not projected[key]:
                    projected.pop(key)
        if 'deam' in read:
            projected['deam'] = [[p - offset, k] for p, k in read['deam'] if offset <= p < offset + width] if include_marks else []
            if not projected['deam']:
                projected.pop('deam')
        if include_marks:
            # The BAM loader chooses IUPAC/mismatch fallbacks from marks in
            # the requested view. If its last primary marks disappear, the
            # cached row cannot reconstruct evidence that was suppressed at
            # load time. Let the caller reload that view instead.
            lost_modifications = ((read.get('methyl_m6a') or read.get('methyl_m5c'))
                                  and not (projected.get('methyl_m6a') or projected.get('methyl_m5c')))
            lost_deamination = read.get('deam') and not projected.get('deam')
            if lost_deamination or (lost_modifications and not projected.get('deam')):
                return None
            if any(key in read for key in ('methyl_m6a', 'methyl_m5c', 'deam')):
                projected.pop('methyl', None)
                if projected.get('methyl_m6a'):
                    projected['methyl'] = projected['methyl_m6a']
                elif projected.get('methyl_m5c'):
                    projected['methyl'] = projected['methyl_m5c']
                elif projected.get('deam'):
                    projected['methyl'] = [p for p, _ in projected['deam']]
        if 'fire' in read:
            projected['fire'] = [iv for _, iv in clip(read['fire'])]
        if 'layers' in read:
            layers = {}
            for name, layer in read['layers'].items():
                kept = clip(layer.get('intervals') or [])
                if not kept:
                    continue
                new_layer = {k: v for k, v in layer.items() if not k.startswith('_fiberbrowser_')}
                new_layer['intervals'] = [iv for _, iv in kept]
                if layer.get('qualities') is not None:
                    new_layer['qualities'] = [[track[i] if i < len(track) else 0 for i, _ in kept] for track in layer['qualities']]
                for key in ('annotation_names', 'circular_ids', 'refinement_kinds'):
                    if key in layer:
                        new_layer[key] = [layer[key][i] if i < len(layer[key]) else '' for i, _ in kept]
                for key in ('source_intervals', 'family_intervals'):
                    if key in layer:
                        new_layer[key] = [[s - offset, e - offset, n] for i, _ in kept
                                          for s, e, n in [layer[key][i]]]
                layers[name] = new_layer
            projected['layers'] = layers
        result.append(projected)
    return result
