"""Joint clustering in oriented, gap-free coordinates, with a reference per window."""
from collections import Counter
import json
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
from services.read_selection import read_matches_id_filter


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
    chosen = req.sample_positions
    if chosen is not None:
        # Graph primary §2.5: a carrier-only feature samples its parent's 10 bp grid, continued across the boundary.
        if len(chosen) != len(lengths) or any(any(not 0 <= u < n for u in ps) or list(ps) != sorted(set(ps))
                                              for ps, n in zip(chosen, lengths)):
            raise ValueError('Sample positions must be sorted, distinct frame positions of each feature')
    candidates = [list(chosen[i]) if chosen is not None else range(0, length, 10) for i, length in enumerate(lengths)]
    positions = [[u for u in candidates[i]
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


def settings_snapshot(req) -> dict:
    """The extraction settings that determine feature values (graph primary §3.5): a durable model is assigned with
    these, never with the current settings."""
    return dict(subnucleosomal_threshold=req.subnucleosomal_threshold, accessibility_threshold=req.accessibility_threshold,
                peak_modes=[p.mode or 'accessibility' for p in req.peak_regions],
                cluster_feature_rules=req.cluster_feature_rules or [], method=req.method)


def pattern_bits(X, widths, modes, rules, accessibility_threshold, missing=None):
    """Combinatorial pattern bits of feature rows, as cluster_compact_reads computes them: -1 for a feature the
    row's window lacks (``missing``: one set of feature indices per row)."""
    from services.clustering_features import class_aware_pattern_slices
    slices = class_aware_pattern_slices(widths, modes, rules)
    out = []
    for i, row in enumerate(X):
        bits = []
        lacks = missing[i] if missing else ()
        for p_idx, offset, pw, is_class in slices:
            if p_idx in lacks:
                bits.append(-1)
            elif pw > 0:
                bits.append(1 if row[offset:offset + pw].mean() > (0.5 if is_class else accessibility_threshold) else 0)
            else:
                bits.append(0)
        out.append(tuple(bits))
    return out


def assign_with_model(X, read_ids, widths, modes, model, snapshot, missing=None, weights=None):
    """Labels of feature rows under a fitted model: combinatorial patterns (exact, else the nearest kept pattern by
    the fit's own rule: weighted by how much of each feature the read covers, ``weights`` per row), or the nearest
    fitted centre."""
    if model.get('cluster_patterns'):
        from services.dynamic_clustering import match_pattern_to_cluster
        table = {tuple(int(b) for b in bits): int(label) for label, bits in model['cluster_patterns'].items()}
        bits = pattern_bits(X, widths, modes, snapshot.get('cluster_feature_rules') or [],
                            snapshot['accessibility_threshold'], missing)
        return {rid: (table[b] if b in table else match_pattern_to_cluster(b, table, weights[i] if weights else None))
                for i, (rid, b) in enumerate(zip(read_ids, bits))}
    centres = model.get('centroids') or {}
    if not centres:
        return {}
    keys = sorted(centres, key=int)
    C = np.array([centres[k] for k in keys], dtype=np.float64)
    if C.shape[1] != X.shape[1]:
        raise ValueError('settings or geometry changed: cluster again')
    d = ((X.astype(np.float64)[:, None, :] - C[None, :, :]) ** 2).sum(axis=2)
    return {rid: int(keys[int(i)]) for rid, i in zip(read_ids, np.argmin(d, axis=1))}


def run(state, req, *, sources=None, model=None, row_cache=None):
    """``sources``: graph-source windows by result key (graph primary §2.6; ``services/graph_panel/analysis.py``),
    whose rows are on a package path's own coordinates, not the window's reference. ``model``: assign every
    eligible row with a fitted model (dynamic assignment, §3.5) instead of fitting."""
    sources = sources or {}
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
    groups, stats, ids, metadata = {}, {}, {}, {}
    pending, loaded = [], []
    feature_spans: list = []   # per loaded window: its feature blocks, relative to its start (folded-molecule arbitration)
    from services.lift.capability import require_for_ids
    require_for_ids(base, [v.dataset_id for v in req.viewports], "clustering")
    if sources and rule_modes:
        raise ValueError('Rule terms (gene, region, footprint class) are not available on graph paths yet: '
                         'their call locations are not mapped through graph columns')
    for v in req.viewports:
        started = time.perf_counter()
        if v.dataset_id not in base.datasets:
            raise ValueError('The region dataset is no longer loaded')
        source = sources.get(v.result_key)
        if source is not None:
            # A graph-source window (§2.6): rows on the path's own coordinates, decoded without display filtering and
            # prepared as the dataset's analysis cohort; the window's blocks were built from verified columns.
            from services.graph_panel.analysis import graph_window_rows
            wstate = base
            own, cohort = graph_window_rows(base, source, v.start, v.end, cache=row_cache)
            working = type('W', (), {'lift_cohort': cohort})()
            query = None
            chrom = source.contig
        else:
            if v.genome != dataset_genome(base, v.dataset_id):
                raise ValueError('The window reference differs from its dataset reference')
            wstate = genome_view(base, v.genome)
            # G0 (DESIGN_GRAPH_PRIMARY §9): the clustering capability (lifted datasets are allowed), the window's
            # haplotype rule and strand in its working set, as cluster_all and matched views load them.
            query = AnalysisReadQuery.from_request(wstate, capability='clustering', chrom=v.chrom, start=v.start, end=v.end,
                dataset_ids=[v.dataset_id], max_reads=req.max_reads, sample_seed=seed,
                include_methylation=cluster_modes_need_methylation(modes) or bool(v.strand),
                include_layers=cluster_modes_need_layers(modes), requested_layers=layers,
                include_layer_qualities=rule_modes)
            working = query.build_working_set(wstate, v.dataset_id, read_ids=v.read_ids, broad_prefetch_multiplier=1,
                                              lift_hap=v.lift_hap, strand=v.strand)
            own = working.reads
            chrom = query.chrom
        if v.read_ids is not None:
            # Qualified scopes: QNAMEs, cohort identities and record keys all name their rows (read_id_keys).
            allowed = set(v.read_ids)
            own = [r for r in own if read_matches_id_filter(r, allowed)]
        if v.strand:
            from services.read_strand import filter_reads_by_strand, strand_calls
            own = filter_reads_by_strand(own, v.strand, strand_calls(wstate, v.dataset_id))
        eligible = len(own)
        spans = [(b.genomic[0]-v.start, b.genomic[1]-v.start) for b in v.blocks if modes[b.feature] != 'off']
        if v.wraps_origin:
            # Blocks across a circular origin (an explicit flag, G0: block order is no evidence, since a window's
            # blocks may mix orientations): reads must cover each feature's whole hull.
            for feature in range(len(lengths)):
                blocks = [b for b in v.blocks if b.feature == feature]
                if modes[feature] != 'off' and blocks:
                    spans.append((min(b.genomic[0] for b in blocks)-v.start, max(b.genomic[1] for b in blocks)-v.start))
        own = filter_reads_covering_regions(own, spans)
        covering = len(own)
        timings.add('working_sets', started)
        hulls = [(min((b.genomic[0] for b in v.blocks if b.feature == i), default=v.start)-v.start,
                  max((b.genomic[1] for b in v.blocks if b.feature == i), default=v.start+1)-v.start) for i in range(len(lengths))]
        mapped = genomic_positions(v, positions)
        context = build_cluster_rule_context(wstate, chrom, v.start, v.end) if source is None else {}
        groups[v.result_key] = (hulls, v.start, context, mapped)
        stats[v.result_key] = dict(eligible_read_count=eligible, peak_covering_read_count=covering, analysis_read_count=len(own))
        loaded.append((v, own, query, chrom))
        feature_spans.append(spans)
        metadata[v.result_key] = dict(genome=v.genome, chrom=chrom, reverse=v.reverse,
            blocks=[b.model_dump() for b in v.blocks], columns=mapped,
            **({'cohort': working.lift_cohort} if getattr(working, 'lift_cohort', None) else {}))
    # One row per folded molecule within a dataset (§3.4 item 8): under fold_molecule a molecule with records on two
    # paths (windows) of one dataset has one analysis_id in both; among its rows that cover the regions (a row that
    # cannot be fitted never displaces one that can) the primary record's is kept, then the one overlapping more of
    # its window's feature blocks, then more body bases, then the first window; before any sampling or fit.
    from services.lift.cohort import folded_identity
    by_identity: dict = {}
    for wi, (v, own, _q, _c) in enumerate(loaded):
        for r in own:
            if folded_identity(r.get('analysis_id')):
                by_identity.setdefault((v.dataset_id, r['analysis_id']), []).append((wi, r))
    dropped_rows, arbitrated, echoes = set(), 0, []
    for hits in by_identity.values():
        if len({wi for wi, _r in hits}) < 2:
            continue
        def rank(hit):
            wi, r = hit
            sup = bool(((r.get('live_lift') or {}).get('source') or {}).get('supplementary'))
            from services.read_selection import read_body_spans
            body = read_body_spans(r)
            overlap = sum(max(0, min(b, fb) - max(a, fa)) for a, b in body for fa, fb in feature_spans[wi])
            return (sup, -overlap, -sum(b - a for a, b in body), wi)
        keep = min(hits, key=rank)
        for hit in hits:
            if hit is not keep:
                dropped_rows.add(id(hit[1]))
                # Its path shows the molecule's one label too (fitted once, on the kept row).
                echoes.append((loaded[hit[0]][0].result_key, loaded[keep[0]][0].result_key, keep[1].get('analysis_id')))
        arbitrated += 1
    for v, own, query, chrom in loaded:
        own = [r for r in own if id(r) not in dropped_rows]
        if query is not None:
            own = query.cap_reads(own, namespace='cluster_regions', label=v.result_key)
        elif req.max_reads and len(own) > req.max_reads:
            from services.read_metrics import sample_stable_by_id
            own = sample_stable_by_id(own, req.max_reads, seed=f"{seed}:cluster_regions:{v.result_key}")
        stats[v.result_key]['analysis_read_count'] = len(own)
        # Prefixed by window; the cohort identity (analysis_id) when the row has one, else its id.
        pending.append((v, [prefix_compact_read({**r, '_cluster_group': v.result_key,
                        '_consensus_dataset_id': v.dataset_id, '_consensus_chrom': chrom}, v.result_key) for r in own]))
    # Shared molecules first (G0, §3.4 item 7): the joint cohort removes and re-sorts rows, so the fit indices,
    # window rows, result ids, counts and metrics are all derived from the rows it keeps, regrouped in window order.
    from services.lift.joint import prepare_joint_cohort
    joint_rows, joint_report = prepare_joint_cohort(base, [r for _v, rows in pending for r in rows],
                                                    {v.dataset_id for v in req.viewports})
    if arbitrated:
        joint_report = {**(joint_report or {}), 'shared_molecules_within_dataset': arbitrated}
    retained = {id(r): i for i, r in enumerate(joint_rows)}
    reads, rows_by_window, row_windows, row_genomes = [], [], [], []
    for v, rows in pending:
        kept = sorted((r for r in rows if id(r) in retained), key=lambda r: retained[id(r)])
        ids[v.result_key] = [r['_original_id'] for r in kept]
        stats[v.result_key]['analysis_read_count'] = len(kept)
        rows_by_window.append(list(range(len(reads), len(reads)+len(kept))))
        reads.extend(kept)
        row_windows.extend([v.result_key]*len(kept))
        row_genomes.extend([v.genome or 'main']*len(kept))
    balanced = req.balance_windows and req.method in ('kmeans', 'minibatch')
    fit = None
    if req.method in ('kmeans', 'minibatch'):
        fit = _balanced_indices(rows_by_window, np.random.default_rng(random_state)) if balanced else np.arange(len(reads))
    started = time.perf_counter()
    snapshot = settings_snapshot(req)
    features, centres = {}, {}
    if model is not None:
        # Dynamic assignment (§3.5): the persisted model on the persisted geometry, with the run's settings snapshot.
        # A model whose samples, feature lengths or extraction settings differ is refused, never reinterpreted.
        from services.clustering_features import extract_features_grouped
        assignments, patterns = {}, None
        same = (model.get('samples') == positions and model.get('lengths') == lengths
                and json.dumps(model.get('settings'), sort_keys=True) == json.dumps(snapshot, sort_keys=True))
        if not same:
            raise ValueError('settings or geometry changed: cluster again')
        if reads:
            X, rids, widths, used = extract_features_grouped(
                reads, [(0, n) for n in lengths], 0, groups, step=10,
                subnucleosomal_threshold=req.subnucleosomal_threshold, peak_modes=modes,
                cluster_feature_rules=req.cluster_feature_rules)
            if model.get('peak_widths') is not None and list(widths) != list(model['peak_widths']):
                raise ValueError('settings or geometry changed: cluster again')
            if len(rids):
                lacks = {v.result_key: {i for i in req.member_specific_features if not any(b.feature == i for b in v.blocks)}
                         for v in req.viewports}
                group_of = {r['id']: r.get('_cluster_group') for r in reads}
                missing = [lacks.get(group_of.get(rid), set()) for rid in rids]
                # The fit's weights for rarer patterns (cluster_compact_reads): each feature's overlap with the read,
                # in its own window's coordinates, one per pattern bit.
                from services.clustering_features import class_aware_pattern_slices
                from services.dynamic_clustering import read_peak_overlap_weights
                slices = class_aware_pattern_slices(widths, used, req.cluster_feature_rules)
                by_id = {r['id']: r for r in reads}
                weights = []
                for rid in rids:
                    r = by_id.get(rid)
                    own_peaks = groups[r['_cluster_group']][0] if r is not None and r.get('_cluster_group') in groups else [(0, n) for n in lengths]
                    w = read_peak_overlap_weights(r, own_peaks) if r is not None else None
                    weights.append(tuple(w[p] for p, _o, _w, _c in slices) if w is not None else None)
                assignments = assign_with_model(np.asarray(X), rids, widths, used, model, snapshot, missing, weights)
    else:
        assignments, _, _, patterns = cluster_compact_reads(reads, [(0, n) for n in lengths], 0, req.k,
            method=req.method, peak_modes=modes, random_state=random_state, cluster_feature_rules=req.cluster_feature_rules,
            subnucleosomal_threshold=req.subnucleosomal_threshold, accessibility_threshold=req.accessibility_threshold,
            window_groups=groups, fit_rows=fit, resolution=req.resolution,
            missing_feature_groups={v.result_key: [i for i in req.member_specific_features if not any(b.feature == i for b in v.blocks)] for v in req.viewports},
            features_out=features, centers_out=centres)
    timings.add('fit', started)
    fitted = None
    if model is None:
        # The model as fitted (G0, §3.5): k-means centres from the fit rows under the returned labels; patterns for
        # combinatorial; other methods (no centres of their own) the mean of each label's rows, all of them fitted.
        if not centres and not (patterns or {}).get('cluster_patterns') and features.get('features') is not None \
                and getattr(features['features'], 'size', 0):
            X = np.asarray(features['features'], dtype=np.float64)
            by: dict = {}
            for i, rid in enumerate(features['read_ids']):
                label = assignments.get(rid)
                if label is not None and label >= 0:
                    by.setdefault(int(label), []).append(i)
            centres = {label: X[rows].mean(axis=0).tolist() for label, rows in by.items()}
        fitted = dict(method=req.method, centroids={int(k): v for k, v in centres.items()} or None,
                      cluster_patterns=(patterns or {}).get('cluster_patterns'),
                      peak_widths=list(features.get('peak_widths') or []), samples=positions, lengths=lengths,
                      settings=snapshot, balanced=bool(balanced), schema=1)
    results = {}
    for key, original in ids.items():
        a = {rid: assignments[f'{key}::{rid}'] for rid in original if f'{key}::{rid}' in assignments}
        results[key] = dict(assignments=a, cluster_counts=dict(Counter(a.values())), **stats[key])
    for to_key, from_key, aid in echoes:
        label = results.get(from_key, {}).get('assignments', {}).get(aid)
        if label is not None and to_key in results:
            results[to_key]['assignments'][aid] = label
            results[to_key]['cluster_counts'] = dict(Counter(results[to_key]['assignments'].values()))
            results[to_key].setdefault('echoed', {})[aid] = from_key
    assigned = [i for i, r in enumerate(reads) if r['id'] in assignments]
    labels = [assignments[reads[i]['id']] for i in assigned]
    return timings.attach(dict(results=results, frame_id=req.frame_id, digest=req.digest, joint_cohort=joint_report,
        member_specific_features=req.member_specific_features,
        excluded_features=excluded,
        matched=dict(windows=metadata, lengths=lengths, columns=positions,
                     balanced_fit_reads=min((len(g) for g in rows_by_window if g), default=0) if balanced else 0,
                     balanced=balanced, fit_reads=len(fit) if balanced else len(reads)),
        window_separation_nmi=_nmi([row_windows[i] for i in assigned], labels),
        reference_separation_nmi=_nmi([row_genomes[i] for i in assigned], labels) if len(set(row_genomes)) > 1 else None,
        cluster_patterns=(patterns or {}).get('cluster_patterns'), sample_seed=seed, model=fitted))
