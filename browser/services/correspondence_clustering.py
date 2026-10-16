"""Joint clustering in oriented, gap-free coordinates, with a reference per window."""
from collections import Counter
import time

import numpy as np
from models.requests import FrameBlock, RegionViewport, RegionClusterRequest
from services.analysis_query import AnalysisReadQuery
from services.cluster_assignment import check_cluster_method, cluster_compact_reads
from services.clustering_endpoint import build_cluster_rule_context, EndpointTimings
from services.clustering_inputs import (prefix_compact_read, cluster_modes_need_layers,
    cluster_modes_need_methylation, cluster_modes_requested_layers, METHYLATION_CLUSTER_MODES)
from services.matched_view_clustering import _balanced_indices, _nmi
from services.panel_genomes import genome_view, dataset_genome
from services.read_metrics import filter_reads_covering_regions, normalize_sample_seed, random_state_from_seed


def common_geometry(req):
    """Validate maps before fetching reads; return shared positions in feature order."""
    views, peaks = req.viewports, req.peak_regions
    if not views or not peaks or len({v.result_key for v in views}) != len(views):
        raise ValueError('Choose regions with distinct window keys')
    lengths = [p.end - p.start for p in peaks]
    if any(p.start != 0 or n <= 0 for p, n in zip(peaks, lengths)):
        raise ValueError('Region features must start at zero and have positive length')
    if any(i < 0 or i >= len(peaks) for i in req.member_specific_features):
        raise ValueError('Invalid member-specific feature')
    for v in views:
        if v.end <= v.start or not v.blocks:
            raise ValueError('Invalid region window')
        for b in v.blocks:
            u0, u1 = b.frame
            g0, g1 = b.genomic
            if b.feature >= len(lengths) or not (0 <= u0 < u1 <= lengths[b.feature]) or not (v.start <= g0 < g1 <= v.end) or u1-u0 != g1-g0:
                raise ValueError('Invalid region block')
        for feature in range(len(peaks)):
            own = [b for b in v.blocks if b.feature == feature]
            if not own and feature not in req.member_specific_features:
                raise ValueError('Every window needs every selected region feature')
            for axis in ('frame', 'genomic'):
                ordered = sorted(getattr(b, axis) for b in own)
                if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
                    raise ValueError('Region blocks must not overlap')
    positions = [[u for u in range(0, length, 10)
                  if all(any(b.feature == i and b.frame[0] <= u < b.frame[1] for b in v.blocks) for v in views if i not in req.member_specific_features or any(b.feature == i for b in v.blocks))
                  and any(b.feature == i for v in views for b in v.blocks)]
                 for i, length in enumerate(lengths)]
    if any(not ps for ps in positions):
        raise ValueError('The regions have no common positions to cluster')
    return lengths, positions


def genomic_positions(view, positions):
    result = []
    for i, ps in enumerate(positions):
        mapped = []
        for u in ps:
            b = next((b for b in view.blocks if b.feature == i and b.frame[0] <= u < b.frame[1]), None)
            if b is None:
                mapped.append(-1)
                continue
            reverse = view.reverse if b.reverse is None else b.reverse
            mapped.append(b.genomic[1] - 1 - (u - b.frame[0]) if reverse else b.genomic[0] + u - b.frame[0])
        result.append(mapped)
    return result


def run(state, req):
    timings = EndpointTimings()
    check_cluster_method(req.method)
    lengths, positions = common_geometry(req)
    base = getattr(state, '_genome_base', state)
    seed = normalize_sample_seed(req.sample_seed)
    random_state = random_state_from_seed(seed, 'cluster_regions', req.method)
    modes = [p.mode or 'accessibility' for p in req.peak_regions]
    excluded = req.member_specific_features if req.method not in ('binary', 'combinatorial') else []
    modes = ['off' if i in excluded else mode for i, mode in enumerate(modes)]
    if not any(m != 'off' for m in modes):
        raise ValueError('Choose at least one shared feature for the pooled fit')
    rule_modes = any(m.startswith('cluster_rule:') for m in modes)
    layers = cluster_modes_requested_layers(modes)
    if not rule_modes:
        aliases = {'accessibility': 'msp', 'fire': 'msp', 'tf_layer': 'tf', 'tf_density': 'tf', 'nuc_layer': 'nuc'}
        layers = sorted({aliases.get(m, m) for m in modes if m != 'off' and m not in METHYLATION_CLUSTER_MODES})
    reads, groups, stats, ids, metadata = [], {}, {}, {}, {}
    rows_by_window, row_windows, row_genomes = [], [], []
    for v in req.viewports:
        started = time.perf_counter()
        if v.dataset_id not in base.datasets:
            raise ValueError('The region dataset is no longer loaded')
        if v.genome != dataset_genome(base, v.dataset_id):
            raise ValueError('The window reference differs from its dataset reference')
        wstate = genome_view(base, v.genome)
        query = AnalysisReadQuery.from_request(wstate, chrom=v.chrom, start=v.start, end=v.end,
            dataset_ids=[v.dataset_id], max_reads=req.max_reads, sample_seed=seed,
            include_methylation=cluster_modes_need_methylation(modes) or bool(v.strand),
            include_layers=cluster_modes_need_layers(modes), requested_layers=layers,
            include_layer_qualities=rule_modes)
        working = query.build_working_set(wstate, v.dataset_id, read_ids=v.read_ids, broad_prefetch_multiplier=1)
        own = working.reads
        if v.read_ids is not None:
            allowed = set(v.read_ids)
            own = [r for r in own if r['id'] in allowed]
        if v.strand:
            from services.read_strand import filter_reads_by_strand, strand_calls
            own = filter_reads_by_strand(own, v.strand, strand_calls(wstate, v.dataset_id))
        eligible = len(own)
        spans = [(b.genomic[0]-v.start, b.genomic[1]-v.start) for b in v.blocks if modes[b.feature] != 'off']
        for feature in range(len(lengths)):
            if modes[feature] == 'off':
                continue
            blocks = sorted((b for b in v.blocks if b.feature == feature), key=lambda b: b.frame[0])
            if not blocks:
                continue
            reverse = v.reverse if blocks[0].reverse is None else blocks[0].reverse
            wraps = any((a.genomic[0] < b.genomic[0] if reverse else a.genomic[0] > b.genomic[0])
                        for a, b in zip(blocks, blocks[1:]))
            if wraps:
                spans.append((min(b.genomic[0] for b in blocks)-v.start, max(b.genomic[1] for b in blocks)-v.start))
        own = filter_reads_covering_regions(own, spans)
        covering = len(own)
        own = query.cap_reads(own, namespace='cluster_regions', label=v.result_key)
        timings.add('working_sets', started)
        hulls = [(min((b.genomic[0] for b in v.blocks if b.feature == i), default=v.start)-v.start,
                  max((b.genomic[1] for b in v.blocks if b.feature == i), default=v.start+1)-v.start) for i in range(len(lengths))]
        mapped = genomic_positions(v, positions)
        groups[v.result_key] = (hulls, v.start, build_cluster_rule_context(wstate, query.chrom, v.start, v.end), mapped)
        ids[v.result_key] = [r['id'] for r in own]
        stats[v.result_key] = dict(eligible_read_count=eligible, peak_covering_read_count=covering, analysis_read_count=len(own))
        rows_by_window.append(list(range(len(reads), len(reads)+len(own))))
        reads.extend(prefix_compact_read({**r, '_cluster_group': v.result_key,
                     '_consensus_dataset_id': v.dataset_id, '_consensus_chrom': query.chrom}, v.result_key) for r in own)
        row_windows.extend([v.result_key]*len(own))
        row_genomes.extend([v.genome or 'main']*len(own))
        metadata[v.result_key] = dict(genome=v.genome, chrom=query.chrom, reverse=v.reverse,
            blocks=[b.model_dump() for b in v.blocks], columns=mapped)
    balanced = req.balance_windows and req.method in ('kmeans', 'minibatch')
    fit = None
    if req.method in ('kmeans', 'minibatch'):
        fit = _balanced_indices(rows_by_window, np.random.default_rng(random_state)) if balanced else np.arange(len(reads))
    started = time.perf_counter()
    assignments, _, _, patterns = cluster_compact_reads(reads, [(0, n) for n in lengths], 0, req.k,
        method=req.method, peak_modes=modes, random_state=random_state, cluster_feature_rules=req.cluster_feature_rules,
        subnucleosomal_threshold=req.subnucleosomal_threshold, accessibility_threshold=req.accessibility_threshold,
        window_groups=groups, fit_rows=fit, resolution=req.resolution,
        missing_feature_groups={v.result_key: [i for i in req.member_specific_features if not any(b.feature == i for b in v.blocks)] for v in req.viewports})
    timings.add('fit', started)
    results = {}
    for key, original in ids.items():
        a = {rid: assignments[f'{key}::{rid}'] for rid in original if f'{key}::{rid}' in assignments}
        results[key] = dict(assignments=a, cluster_counts=dict(Counter(a.values())), **stats[key])
    assigned = [i for i, r in enumerate(reads) if r['id'] in assignments]
    labels = [assignments[reads[i]['id']] for i in assigned]
    return timings.attach(dict(results=results, frame_id=req.frame_id, digest=req.digest,
        member_specific_features=req.member_specific_features,
        excluded_features=excluded,
        matched=dict(windows=metadata, lengths=lengths, columns=positions,
                     balanced_fit_reads=min((len(g) for g in rows_by_window if g), default=0) if balanced else 0,
                     balanced=balanced, fit_reads=len(fit) if balanced else len(reads)),
        window_separation_nmi=_nmi([row_windows[i] for i in assigned], labels),
        reference_separation_nmi=_nmi([row_genomes[i] for i in assigned], labels) if len(set(row_genomes)) > 1 else None,
        cluster_patterns=(patterns or {}).get('cluster_patterns'), sample_seed=seed))
