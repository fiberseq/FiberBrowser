"""Re-cluster a session's panels on the data it now points at, reproducibly, and store the result in the session.

Saved sessions keep cluster assignments keyed by read name, which no longer match after a data swap
(re-called files, deduplicated BAMs). ``recluster_session`` clusters the same region again with a fixed
method, k and seed, through the browser's joint region clustering (``/api/cluster-regions``,
services/correspondence_clustering.py) with ``balance_windows``: one pooled fit over every panel, each
panel contributing the same number of reads to the fit (k-means/minibatch), then every read assigned.

What is clustered
    Each dataset panel the figure draws (its own region when it has one, else the view's). The features
    are ``features`` (absolute [start, end) intervals inside the region, e.g. from a BED) or, by default,
    the whole region as one feature, sampled every 10 bp in ``feature_mode`` (default "accessibility").
    Only reads covering every feature are clustered (the browser's rule), so a re-clustered panel shows
    only those reads. The session's saved quality and signal filters apply, as in its figures.

Determinism
    For a fixed seed, data and options the assignments are identical run to run. Labels are renumbered
    canonically: 0 is the cluster with the most reads over all panels, ties broken by the smallest read id.

What changes in the session
    frontend.clusterAssignments[panel] and clusterOrder[panel] (0..k-1) for each clustered panel; the read
    order, cluster focus, read filter and selection stored for those panels (keyed by old read names) and
    the cluster tree are cleared. ``session["headless_cluster"]`` records the parameters and counts.
"""
from __future__ import annotations

import copy
from collections import Counter
from typing import Optional

from services.cluster_assignment import CLUSTER_METHODS as METHODS  # noqa: E402


def _panels_to_cluster(spec, dataset_ids: Optional[list]) -> list:
    out, seen = [], set()
    for panel in spec.panels:
        if dataset_ids and panel.dataset_id not in dataset_ids and panel.id not in dataset_ids \
                and panel.label not in dataset_ids:
            continue
        if panel.state_key in seen:
            continue
        seen.add(panel.state_key)
        out.append(panel)
    if not out:
        raise ValueError("No dataset panels to cluster" + (f" among {', '.join(dataset_ids)}" if dataset_ids else ""))
    return out


def _canonical(results: dict) -> dict:
    """{old label: new label}: by total size (descending), then smallest read id."""
    sizes, first = Counter(), {}
    for res in results.values():
        for rid, label in res["assignments"].items():
            sizes[label] += 1
            first[label] = min(first.get(label, rid), rid)
    order = sorted(sizes, key=lambda c: (-sizes[c], first[c]))
    return {old: new for new, old in enumerate(order)}


def recluster_session(state, session: dict, *, method: str = "kmeans", k: int = 5, seed: str = "fiberbrowser-analysis",
                      features: Optional[list] = None, feature_mode: str = "accessibility",
                      balance_windows: bool = True, max_reads: Optional[int] = None,
                      dataset_ids: Optional[list] = None, region: Optional[tuple] = None,
                      subnucleosomal_threshold: int = 90, accessibility_threshold: float = 0.5) -> dict:
    """Cluster ``session``'s panels (loaded in ``state``) and return {session, results, ...}; see the module doc."""
    from models.requests import FrameBlock, RegionClusterRequest, RegionViewport
    from services.correspondence_clustering import run
    from services.figure.compose import view_filters
    from services.figure.options import resolve as resolve_options
    from services.figure.spec import resolve_spec
    from services.panel_genomes import dataset_genome

    if method not in METHODS:
        raise ValueError(f"method must be one of {', '.join(METHODS)}")
    if int(k) < 1:
        raise ValueError("k must be at least 1")
    chrom, start, end = region if region else (None, None, None)
    spec = resolve_spec(state, chrom=chrom, start=start, end=end, source="session", session=session,
                        options=resolve_options(None, session))
    panels = _panels_to_cluster(spec, dataset_ids)

    viewports, feature_list = [], None
    for panel in panels:
        p_chrom, p_start, p_end = panel.region or (spec.chrom, spec.start, spec.end)
        feats = [(int(a), int(b)) for a, b in (features or [(p_start, p_end)])]
        for a, b in feats:
            if not (p_start <= a < b <= p_end):
                raise ValueError(f"feature {a}-{b} is outside the panel region {p_chrom}:{p_start}-{p_end}")
        lengths = [b - a for a, b in feats]
        if feature_list is None:
            feature_list = feats
        elif [b - a for a, b in feature_list] != lengths:
            raise ValueError("every panel needs features of the same lengths (panels at other loci)")
        viewports.append(RegionViewport(
            dataset_id=panel.dataset_id, result_key=panel.state_key, chrom=p_chrom, start=p_start, end=p_end,
            strand=panel.strand, genome=dataset_genome(state, panel.dataset_id), reverse=False,
            region_label=panel.label,
            blocks=[FrameBlock(feature=i, frame=(0, b - a), genomic=(a, b)) for i, (a, b) in enumerate(feats)]))
    req = RegionClusterRequest(
        viewports=viewports, peak_regions=[{"start": 0, "end": b - a, "mode": feature_mode} for a, b in feature_list],
        k=int(k), method=method, dataset_ids=sorted({p.dataset_id for p in panels}), max_reads=max_reads,
        sample_seed=str(seed), balance_windows=bool(balance_windows), feature_geometry="crop",
        frame_id="headless-recluster", digest=None,
        subnucleosomal_threshold=int(subnucleosomal_threshold), accessibility_threshold=float(accessibility_threshold))
    with view_filters(spec, state):
        response = run(state, req)

    raw = response["results"]
    relabel = _canonical(raw)
    out_session = copy.deepcopy(session)
    fe = out_session.setdefault("frontend", {})
    results = []
    for panel in panels:
        res = raw.get(panel.state_key) or {"assignments": {}}
        assignments = {rid: relabel[label] for rid, label in sorted(res["assignments"].items())}
        counts = Counter(assignments.values())
        key = panel.state_key
        fe.setdefault("clusterAssignments", {})[key] = assignments
        fe.setdefault("clusterOrder", {})[key] = sorted(counts)
        for stale in ("readSortOrder", "clusterFocus", "filteredReadIds", "selectedReadIds", "selectedClusters"):
            if isinstance(fe.get(stale), dict):
                fe[stale].pop(key, None)
        # The panel shows exactly its clustered reads (none when no read covers every feature): an explicit read
        # filter, since without one a panel with no assignments, or too many for the request filter, draws every read.
        fe.setdefault("filteredReadIds", {})[key] = sorted(assignments)
        results.append({
            "panel_id": panel.id, "state_key": key, "dataset_id": panel.dataset_id, "label": panel.label,
            "assignments": assignments, "cluster_counts": {str(c): counts[c] for c in sorted(counts)},
            "eligible_read_count": res.get("eligible_read_count"),
            "covering_read_count": res.get("peak_covering_read_count"),
            "clustered_read_count": len(assignments),
        })
    # The cluster tree and its active branch were built on the old reads (an active branch filters reads).
    for key, empty in (("clusterTreeNodes", {}), ("clusterTreeRootIds", []), ("activeClusterTreeNodeId", None)):
        if key in fe:
            fe[key] = copy.deepcopy(empty)
    matched = response.get("matched") or {}
    record = {
        "method": method, "k": int(k), "seed": str(seed), "balance_windows": bool(balance_windows),
        "balanced": bool(matched.get("balanced")), "balanced_fit_reads": matched.get("balanced_fit_reads"),
        "fit_reads": matched.get("fit_reads"), "feature_mode": feature_mode, "max_reads": max_reads,
        "region": {"chrom": spec.chrom, "start": spec.start, "end": spec.end},
        "features": [list(f) for f in feature_list],
        "labels": "0 = most reads over all panels; ties by smallest read id",
        "panels": [{k2: v for k2, v in r.items() if k2 != "assignments"} for r in results],
    }
    try:
        from version import __version__ as fb_version
        record["fiberbrowser_version"] = fb_version
    except Exception:
        pass
    out_session["headless_cluster"] = record
    if region:
        # The session now shows the region it was clustered in, so a render of it draws those reads at that locus.
        # Saved peaks keep the chromosome they were scanned on (as a render with a region override reads them).
        old_chrom = (out_session.get("viewport") or {}).get("chrom") or fe.get("chrom")
        if old_chrom and isinstance(fe.get("peaksByRule"), dict):
            fe["peaksByRule"] = {rid: ([{**p, "chrom": p.get("chrom") or old_chrom} if isinstance(p, dict) else p for p in peaks]
                                       if isinstance(peaks, list) else peaks) for rid, peaks in fe["peaksByRule"].items()}
        out_session["viewport"] = {**(out_session.get("viewport") or {}), "chrom": spec.chrom, "start": spec.start, "end": spec.end}
        fe.update({"chrom": spec.chrom, "start": spec.start, "end": spec.end})
    return {"session": out_session, "results": results, "cluster": record,
            "window_separation_nmi": response.get("window_separation_nmi")}


def recluster_request(request, state, dafc_state=None) -> dict:
    """/api/render/cluster: load the session's datasets (``load_session``) and re-cluster it. A meta-locus view (the
    request's ``meta_locus``, or a session saved on a meta:<pool> view) re-clusters its working set: see
    ``recluster_meta_locus``."""
    from services.figure_render import FigureError, _session_source, parse_region, read_session_path
    session = request.session
    if session is None and request.session_path:
        session = read_session_path(request.session_path)
    meta_spec = getattr(request, "meta_locus", None)
    if not isinstance(session, dict) and meta_spec is None:
        raise ValueError("Pass session (JSON) or session_path, or meta_locus")
    if isinstance(session, dict):
        request.session = session
        _session_source(request, state, dafc_state)
    from services.figure.meta_locus import MetaLocusError, resolve as resolve_meta
    region = parse_region(request.region) if request.region else None  # before the pool's view clone is leased
    try:
        meta = resolve_meta(state, meta_spec, session if isinstance(session, dict) else None)
    except MetaLocusError as exc:
        raise FigureError(str(exc), status=exc.status) from None
    try:
        kwargs = dict(method=request.method, k=request.k, seed=request.seed, feature_mode=request.feature_mode,
                      balance_windows=request.balance_windows, max_reads=request.max_reads,
                      dataset_ids=request.dataset_ids, subnucleosomal_threshold=request.subnucleosomal_threshold,
                      accessibility_threshold=request.accessibility_threshold)
        if meta is not None:
            return recluster_meta_locus(state, meta, session if isinstance(session, dict) else None, region=region,
                                        features=request.features, features_relative=request.features_relative,
                                        anchor_window=request.anchor_window, **kwargs)
        return recluster_session(state, session, features=request.features, region=region, **kwargs)
    finally:
        if meta is not None:
            meta.release()


def recluster_meta_locus(state, meta, session: Optional[dict], *, region: Optional[tuple] = None,
                         features: Optional[list] = None, features_relative: Optional[list] = None,
                         anchor_window: int = 500, **kwargs) -> dict:
    """Re-cluster a meta-locus view's working set (the read-site pairs of the pool's seeded view) and save it.

    Features: absolute contig intervals ``features``, else ``features_relative`` ([from, to] bp from the anchor), else
    the anchor +- ``anchor_window`` (a whole +-flank window would keep only reads spanning all of it). Assignments are
    keyed by the read ids the browser's panels use (``name``, or ``name#site<N>`` for a read in several windows); each
    result also lists every read's site (``sites``: read-site key, name, site, site name, real contig and strand).
    The session that comes back sits on the real pool's contig with its meta-locus block (seed, count, added reads),
    so the browser reopens it with these clusters."""
    from services.figure.meta_locus import rename_meta_chroms, session_region, synthesize_session
    if session is None or meta.source != "session":
        session = synthesize_session(state, meta, session)
    else:
        session = meta.session
    if region is None:
        region = session_region(meta, session) or meta.region(meta.spec.get("window"))
    _c, r_start, r_end = region
    if features is None:
        rel = features_relative or [[-int(anchor_window), int(anchor_window)]]
        features = []
        for a, b in rel:
            lo, hi = max(r_start, int(a) + meta.flank), min(r_end, int(b) + meta.flank)
            if hi <= lo:
                raise ValueError(f"feature {a}..{b} (bp from the anchor) is outside the view")
            features.append((lo, hi))
    out = recluster_session(state, session, region=region, features=features, **kwargs)
    from services.figure.meta_locus import read_sites
    wanted: dict = {}
    for r in out["results"]:  # every panel of a dataset (strand panels hold different reads)
        wanted.setdefault(r["dataset_id"], set()).update(r["assignments"])
    sites = read_sites(meta, {d: sorted(ids) for d, ids in wanted.items()})
    for res in out["results"]:
        table = sites.get(res["dataset_id"], {})
        res["sites"] = {rid: table.get(rid) for rid in res["assignments"]}
    # The browser reopens the real pool: the clone's contig back to the pool's, the meta-locus block refreshed.
    saved = rename_meta_chroms(out["session"], meta.pool.chrom, {meta.chrom})
    fe = saved.setdefault("frontend", {})
    fe["metaLocus"] = meta_session_payload(meta, (fe.get("metaLocus") or {}).get("lastRealLocus"))
    saved["headless_cluster"]["meta_locus"] = meta.record()
    saved["headless_cluster"]["features_relative"] = [[a - meta.flank, b - meta.flank] for a, b in features]
    out["session"] = saved
    out["cluster"] = saved["headless_cluster"]
    return out


def meta_session_payload(meta, last_real=None) -> dict:
    """metaLocusSessionPayload (metaLocusStore.ts) for this view: what the browser saves and reopens."""
    view, pool = meta.view, meta.pool
    extra = []
    for d, e in view.view_extra:
        ix = pool.index_for(d)
        if ix is not None:
            extra.append([d, ix.names[int(ix.mol[e])], int(ix.site[e])])
    return {"bed_path": meta.bed_path or pool.spec.get("bed_path"), "name": pool.name, "anchor": meta.anchor,
            "flank_bp": meta.flank, "policy": pool.spec.get("policy"), "count_unit": meta.spec.get("count_unit"),
            "dataset_ids": list(pool.order), "seed": int(view.view_seed), "count": int(view.view_count),
            "extra_entries": extra, "lastRealLocus": last_real, "pool_id": pool.pool_id}
