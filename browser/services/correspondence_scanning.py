"""Pool read signal counts in accepted correspondence coordinates before calling peaks."""
import numpy as np
from models.requests import CorrespondenceScanRequest
from services.analysis_query import AnalysisReadQuery
from services.panel_genomes import genome_view, dataset_genome
from services.clustering_endpoint import _compute_scan_counts_from_broad_cache
from services.background_work import checkpoint
from services.peak_scanning import (compute_scan_counts, scan_signal_from_counts, smooth_scan_signal,
    build_peak_thresholds, detect_threshold_layers, format_peak_scan_results, scan_signal_needs_layers,
    scan_signal_needs_methylation, scan_signal_layer_name, is_read_signal_source, downsample_signal_for_response)


def shared_spans(views, length):
    """Validate before loading; gaps and block seams remain separate scan domains."""
    if len(views) < 2 or len({v.result_key for v in views}) != len(views):
        raise ValueError('Choose at least two distinct correspondence members')
    spans = [(0, length)]
    for v in views:
        if not v.blocks or v.end <= v.start:
            raise ValueError('Invalid correspondence window')
        for b in v.blocks:
            a, z = b.frame
            g, h = b.genomic
            if b.feature != 0 or not (0 <= a < z <= length and v.start <= g < h <= v.end) or z-a != h-g:
                raise ValueError('Invalid correspondence block')
        for axis in ('frame', 'genomic'):
            ordered = sorted(getattr(b, axis) for b in v.blocks)
            if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
                raise ValueError('Correspondence blocks overlap')
        spans = [(max(a, b.frame[0]), min(z, b.frame[1])) for a, z in spans for b in v.blocks
                 if min(z, b.frame[1]) > max(a, b.frame[0])]
    if not spans:
        raise ValueError('The correspondence has no shared positions')
    return sorted(spans)


def run(state, req):
    """Return pooled peaks and coverage-weighted profiles with member breakdowns."""
    spans = shared_spans(req.viewports, req.length)
    if not is_read_signal_source(req.signal_source):
        raise ValueError('Pooled scanning needs a read signal source')
    base = getattr(state, '_genome_base', state)
    numerator = np.zeros(req.length, dtype=np.int64)
    coverage = np.zeros(req.length, dtype=np.int64)
    members = {}
    n_reads = 0
    for v in req.viewports:
        checkpoint()
        if v.dataset_id not in base.datasets or v.genome != dataset_genome(base, v.dataset_id):
            raise ValueError('The correspondence dataset or reference changed')
        own_state = genome_view(base, v.genome)
        layer = scan_signal_layer_name(req.signal_source)
        query = AnalysisReadQuery.from_request(own_state, chrom=v.chrom, start=v.start, end=v.end,
            dataset_ids=[v.dataset_id], sample_seed=req.sample_seed, read_ids=v.read_ids,
            include_methylation=scan_signal_needs_methylation(req.signal_source) or bool(v.strand),
            include_layers=scan_signal_needs_layers(req.signal_source), requested_layers=[layer] if layer else None,
            include_layer_qualities=False)
        cached = None if v.strand else _compute_scan_counts_from_broad_cache(
            state=own_state, query=query, dataset_id=v.dataset_id, signal_source=req.signal_source,
            region_width=v.end-v.start)
        if cached is not None:
            num, cov, count = cached
        else:
            reads = query.build_working_set(own_state, v.dataset_id, broad_prefetch_multiplier=1).reads
            if v.read_ids is not None:
                allowed = set(v.read_ids)
                reads = [r for r in reads if r['id'] in allowed]
            if v.strand:
                from services.read_strand import filter_reads_by_strand, strand_calls
                reads = filter_reads_by_strand(reads, v.strand, strand_calls(own_state, v.dataset_id))
            num, cov = compute_scan_counts(reads, req.signal_source, v.end-v.start)
            count = len(reads)
        mapped_num = np.zeros(req.length, dtype=np.int64)
        mapped_cov = np.zeros(req.length, dtype=np.int64)
        for b in v.blocks:
            a, z = b.frame
            g, h = b.genomic[0]-v.start, b.genomic[1]-v.start
            reverse = v.reverse if b.reverse is None else b.reverse
            mapped_num[a:z] = num[g:h][::-1] if reverse else num[g:h]
            mapped_cov[a:z] = cov[g:h][::-1] if reverse else cov[g:h]
        numerator += mapped_num
        coverage += mapped_cov
        n_reads += count
        members[v.result_key] = dict(label=v.region_label or v.result_key, n_reads=count, signal=downsample_signal_for_response(
            scan_signal_from_counts(mapped_num, mapped_cov), req.signal_bins),
            coverage=downsample_signal_for_response(mapped_cov, req.signal_bins),
            profiles=[dict(start=a, end=z, signal=downsample_signal_for_response(
                scan_signal_from_counts(mapped_num[a:z], mapped_cov[a:z]), req.signal_bins),
                coverage=downsample_signal_for_response(mapped_cov[a:z], req.signal_bins)) for a, z in spans])
    peaks, infos, profiles = [], [], []
    thresholds = build_peak_thresholds(req.threshold_strong, req.threshold_medium, req.threshold_weak,
                                      req.threshold_rare, req.min_reads, n_reads)
    for a, z in spans:
        signal = scan_signal_from_counts(numerator[a:z], coverage[a:z])
        smooth = max(req.smooth_width, req.min_width)
        smoothed = smooth_scan_signal(signal, smooth)
        found, info = detect_threshold_layers(smoothed, coverage[a:z], thresholds, req.min_width,
                                              req.min_reads, smooth, max_width=req.max_peak_width)
        peaks.extend(format_peak_scan_results(found, a))
        infos.extend(info)
        profiles.append(dict(start=a, end=z, signal=downsample_signal_for_response(signal, req.signal_bins),
                             coverage=downsample_signal_for_response(coverage[a:z], req.signal_bins)))
    for i, p in enumerate(peaks):
        p['index'] = i
    return dict(peaks=peaks, layer_info=infos, n_reads=n_reads, mode='pooled', shared_blocks=spans,
                profiles=profiles, members=members)
