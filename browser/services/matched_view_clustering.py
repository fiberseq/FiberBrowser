"""Two-view comparison clustering on matched feature domains.

A haplotype (or any two-locus) comparison has two views, each a locus with
one or more dataset panels and its own list of features (peaks). Feature i of
one view is matched with feature i of the other (genomic order, or reversed
for an inverted view). Each feature is resampled to the same number of columns
(``resample_feature_blocks``), so views whose features differ in width and
absolute position fill one shared feature space.

Two modes:

* ``joint``: one model over both views. States are shared, so a state's share
  can be compared between the views. With ``balance_views`` the model is fitted
  on an equal number of reads from every panel (so a deeper view or dataset
  does not define the states alone) and then assigns every read.
* ``separate``: one model per view. Each view gets its own states (numbered
  apart, so they are never mistaken for the other view's), except with
  combinatorial patterns, which are called per read and so are the same states
  in both modes.

The response reports how strongly the joint states separate the two views and
the individual panels (normalized mutual information); a high value means the
states may reflect a technical difference between the samples rather than
biology.
"""
from __future__ import annotations

import time
from typing import Any, Dict

import numpy as np

from services.analysis_query import AnalysisReadQuery
from services.read_selection import read_matches_id_filter
from services.clustering_features import extract_features_from_compact, resample_feature_blocks
from services.clustering_inputs import (
    active_peak_regions,
    cluster_modes_need_layers,
    cluster_modes_need_methylation,
    cluster_modes_requested_layers,
    prefix_compact_read,
)
from services.read_metrics import filter_reads_covering_regions, normalize_sample_seed, random_state_from_seed

MATCHED_VIEW_METHODS = ("combinatorial", "binary", "kmeans", "minibatch")
MAX_PATTERNS = 50
FEATURE_STEP = 10


def _view_features(view, combinatorial: bool) -> tuple[list[list[int]], list[str]]:
    peaks, modes = active_peak_regions(view.peak_regions, view.start)
    order = sorted(range(len(peaks)), key=lambda i: (peaks[i][0], peaks[i][1]))
    peaks = [peaks[i] for i in order]
    modes = [modes[i] for i in order]
    if combinatorial:
        modes = ["accessibility" if mode == "tf" else mode for mode in modes]
    return peaks, modes


def _feature_bits(raw: np.ndarray, widths: list[int], threshold: float, reverse: bool) -> np.ndarray:
    """Open (1) / closed (0) per feature: the feature's mean signal above threshold."""
    bits = np.zeros((raw.shape[0], len(widths)), dtype=np.int8)
    offset = 0
    for index, width in enumerate(widths):
        width = max(0, int(width))
        if width:
            bits[:, index] = raw[:, offset:offset + width].mean(axis=1) > threshold
        offset += width
    return bits[:, ::-1] if reverse else bits


def _balanced_indices(groups: list[list[int]], rng: np.random.Generator) -> np.ndarray:
    nonempty = [g for g in groups if g]
    if not nonempty:
        return np.array([], dtype=np.int64)
    target = min(len(g) for g in nonempty)
    return np.sort(np.concatenate([rng.choice(np.asarray(g), size=target, replace=False) for g in nonempty]))


def _fit_predict(X: np.ndarray, fit_rows: np.ndarray, k: int, method: str, random_state: int) -> np.ndarray:
    """K-means fitted on fit_rows, assigning every row; labels ordered by size (0 = largest)."""
    if X.shape[0] == 0:
        return np.zeros(0, dtype=np.int32)
    n_clusters = max(1, min(int(k), len(fit_rows)))
    if n_clusters == 1 or len(fit_rows) < 2:
        return np.zeros(X.shape[0], dtype=np.int32)
    from sklearn.cluster import KMeans, MiniBatchKMeans

    if method == "minibatch":
        model = MiniBatchKMeans(n_clusters=n_clusters, random_state=random_state,
                                batch_size=min(1000, max(32, len(fit_rows))), n_init=3)
    else:
        model = KMeans(n_clusters=n_clusters, random_state=random_state, n_init=10)
    model.fit(X[fit_rows])
    labels = model.predict(X).astype(np.int32)
    sizes = np.bincount(labels, minlength=n_clusters)
    rank = {int(old): new for new, old in enumerate(sorted(range(n_clusters), key=lambda c: (-sizes[c], c)))}
    return np.array([rank[int(label)] for label in labels], dtype=np.int32)


def _pattern_labels(bits: np.ndarray) -> tuple[np.ndarray, dict[int, list[int]]]:
    """Label each read by its open/closed pattern; labels by frequency (0 = commonest)."""
    if bits.shape[0] == 0:
        return np.zeros(0, dtype=np.int32), {}
    patterns = [tuple(int(b) for b in row) for row in bits]
    counts: dict[tuple, int] = {}
    for pattern in patterns:
        counts[pattern] = counts.get(pattern, 0) + 1
    ranked = sorted(counts, key=lambda p: (-counts[p], p))
    kept = ranked[:MAX_PATTERNS]
    label_of = {pattern: index for index, pattern in enumerate(kept)}
    kept_arr = np.array(kept, dtype=np.int8)
    labels = np.empty(len(patterns), dtype=np.int32)
    for i, pattern in enumerate(patterns):
        if pattern in label_of:
            labels[i] = label_of[pattern]
        else:
            # A rare pattern joins the nearest kept one (ties: the commoner).
            distance = np.abs(kept_arr - np.array(pattern, dtype=np.int8)).sum(axis=1)
            labels[i] = int(np.argmin(distance))
    return labels, {index: list(pattern) for index, pattern in enumerate(kept)}


def _nmi(groups: list[str], labels: np.ndarray) -> float | None:
    if len(groups) == 0:
        return None
    try:
        from sklearn.metrics import normalized_mutual_info_score
    except Exception:  # pragma: no cover - sklearn is a hard dependency
        return None
    codes = {name: index for index, name in enumerate(dict.fromkeys(groups))}
    return float(normalized_mutual_info_score([codes[g] for g in groups], labels))


def run_matched_views_endpoint(*, state, req) -> Dict[str, Any]:
    """Cluster the reads of two comparison views on their matched features."""
    from services.clustering_endpoint import EndpointTimings

    timings = EndpointTimings()
    method = req.method
    if method not in MATCHED_VIEW_METHODS:
        raise ValueError(
            f"Matched-domain comparison supports {', '.join(MATCHED_VIEW_METHODS)} clustering, not {method!r}"
        )
    if len(req.views) != 2:
        raise ValueError("Exactly two comparison views are required")
    if len({view.id for view in req.views}) != 2:
        raise ValueError("The two comparison views need different ids")
    result_keys = [panel.result_key for view in req.views for panel in view.panels]
    if len(set(result_keys)) != len(result_keys):
        raise ValueError("Duplicate comparison panel keys")
    for view in req.views:
        if view.end <= view.start or not view.panels:
            raise ValueError(f"Comparison view {view.id!r} needs a region and at least one dataset")

    combinatorial = method in ("binary", "combinatorial")
    from services.lift.capability import require_for_ids
    require_for_ids(state, [p.dataset_id for view in req.views for p in view.panels], "clustering")  # P2b
    features = [_view_features(view, combinatorial) for view in req.views]
    feature_count = len(features[0][0])
    if feature_count == 0 or any(len(peaks) != feature_count for peaks, _ in features):
        raise ValueError("Select the same, non-zero number of features in both views (feature i of each view is matched)")
    matched_modes = [modes[::-1] if view.reverse else modes for view, (_, modes) in zip(req.views, features)]
    if matched_modes[0] != matched_modes[1]:
        raise ValueError("Matched features must use the same feature type in both views")

    sample_seed = normalize_sample_seed(req.sample_seed)
    random_state = random_state_from_seed(sample_seed, "matched_views", method, req.mode)
    bins = int(req.bins_per_feature)

    rows: list[np.ndarray] = []
    bit_rows: list[np.ndarray] = []
    row_read_ids: list[str] = []
    row_keys: list[str] = []
    row_views: list[str] = []
    metadata: dict[str, dict[str, Any]] = {}

    pending = []
    phase_start = time.perf_counter()
    for view, (peaks, modes) in zip(req.views, features):
        strands = {p.dataset_id: p.strand for p in view.panels if p.strand}
        query = AnalysisReadQuery.from_request(
            state,
            capability="clustering",
            chrom=view.chrom,
            start=view.start,
            end=view.end,
            dataset_ids=list(dict.fromkeys(p.dataset_id for p in view.panels)),
            max_reads=req.max_reads,
            sample_seed=sample_seed,
            include_methylation=cluster_modes_need_methylation(modes) or bool(strands),
            include_layers=cluster_modes_need_layers(modes),
            requested_layers=cluster_modes_requested_layers(modes),
        )
        for panel in view.panels:
            working_set = query.build_working_set(state, panel.dataset_id, read_ids=panel.read_ids, lift_hap=panel.lift_hap, strand=panel.strand)
            reads = list(working_set.reads or [])
            if panel.read_ids is not None:
                allowed = set(panel.read_ids)
                reads = [read for read in reads if read_matches_id_filter(read, allowed)]
            if panel.strand:
                from services.read_strand import filter_reads_by_strand, strand_calls
                reads = filter_reads_by_strand(reads, panel.strand, strand_calls(state, panel.dataset_id))
            eligible = len(reads)
            reads = filter_reads_covering_regions(reads, peaks)
            covering = len(reads)
            reads = query.cap_reads(reads, namespace="matched_views", label=panel.result_key)
            prefixed = [prefix_compact_read({**read, "_consensus_dataset_id": panel.dataset_id,
                                                "_cluster_group": panel.result_key}, panel.result_key) for read in reads]
            pending.append((view, panel, peaks, modes, prefixed))
            metadata[panel.result_key] = {
                "view_id": view.id,
                "dataset_id": panel.dataset_id,
                "chrom": view.chrom,
                "eligible_read_count": eligible,
                "peak_covering_read_count": covering,
                "analysis_read_count": len(reads),
                **({"cohort": working_set.lift_cohort} if getattr(working_set, "lift_cohort", None) else {}),
            }
    from services.lift.joint import prepare_joint_cohort
    joint_rows, joint_report = prepare_joint_cohort(state, [r for *_, cohort in pending for r in cohort])
    retained = {id(r) for r in joint_rows}
    for view, panel, peaks, modes, cohort in pending:
        prefixed = [r for r in cohort if id(r) in retained]
        ids = []
        if prefixed:
            raw, prefixed_ids, widths, _ = extract_features_from_compact(
                prefixed, peaks, view.start, step=FEATURE_STEP,
                subnucleosomal_threshold=req.subnucleosomal_threshold, peak_modes=modes)
            if len(prefixed_ids) and raw.ndim == 2 and raw.shape[1] > 0:
                rows.append(resample_feature_blocks(raw, widths, bins, reverse=view.reverse))
                bit_rows.append(_feature_bits(raw, widths, req.accessibility_threshold, view.reverse))
                ids = [read["_original_id"] for read in prefixed]
        row_read_ids.extend(ids)
        row_keys.extend([panel.result_key] * len(ids))
        row_views.extend([view.id] * len(ids))
        metadata[panel.result_key]["analysis_read_count"] = len(ids)
    timings.add("feature_extraction", phase_start)

    response: Dict[str, Any] = {
        "mode": req.mode,
        "method": "combinatorial" if combinatorial else method,
        "feature_count": feature_count,
        "bins_per_feature": bins,
        "sample_seed": sample_seed,
        "cluster_random_state": random_state,
        "total_reads": len(row_read_ids),
        "joint_cohort": joint_report,
    }
    if not row_read_ids:
        results = {key: {**meta, "assignments": {}, "cluster_counts": {}} for key, meta in metadata.items()}
        return timings.attach({**response, "results": results, "label_space": "shared",
                               "balanced_fit_reads": 0, "view_separation_nmi": None,
                               "dataset_separation_nmi": None})

    phase_start = time.perf_counter()
    X = np.vstack(rows).astype(np.float32, copy=False)
    rng = np.random.default_rng(random_state)
    cluster_patterns = None
    label_space = "shared"

    def fit_rows_for(indices: list[int]) -> np.ndarray:
        if not req.balance_views:
            return np.asarray(indices, dtype=np.int64)
        by_key: dict[str, list[int]] = {}
        for index in indices:
            by_key.setdefault(row_keys[index], []).append(index)
        return _balanced_indices(list(by_key.values()), rng)

    if combinatorial:
        labels, cluster_patterns = _pattern_labels(np.vstack(bit_rows))
        fitted = len(row_read_ids)
    elif req.mode == "joint":
        fit_rows = fit_rows_for(list(range(len(row_read_ids))))
        labels = _fit_predict(X, fit_rows, req.k, method, random_state)
        fitted = len(fit_rows)
    else:
        label_space = "per_view"
        labels = np.zeros(len(row_read_ids), dtype=np.int32)
        fitted = 0
        offset = 0
        for view in req.views:
            indices = [i for i, view_id in enumerate(row_views) if view_id == view.id]
            if not indices:
                continue
            fit_rows = fit_rows_for(indices)
            view_labels = _fit_predict(X[indices], np.searchsorted(indices, fit_rows), req.k, method, random_state)
            labels[indices] = view_labels + offset
            offset += int(view_labels.max()) + 1
            fitted += len(fit_rows)
    timings.add("clustering", phase_start)

    results: dict[str, dict[str, Any]] = {}
    for key, meta in metadata.items():
        assignments = {read_id: int(labels[i]) for i, read_id in enumerate(row_read_ids) if row_keys[i] == key}
        counts: dict[int, int] = {}
        for label in assignments.values():
            counts[label] = counts.get(label, 0) + 1
        results[key] = {**meta, "assignments": assignments, "cluster_counts": dict(sorted(counts.items()))}

    shared = label_space == "shared"
    return timings.attach({
        **response,
        "results": results,
        "label_space": label_space,
        "cluster_patterns": cluster_patterns,
        "balanced_fit_reads": int(fitted),
        # Separation is only meaningful for states shared by both views.
        "view_separation_nmi": _nmi(row_views, labels) if shared else None,
        "dataset_separation_nmi": _nmi(row_keys, labels) if shared else None,
    })
