"""Peak scanning, clustering, and working set endpoints.

Extracted from server.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Depends, HTTPException, Request
from typing import Optional

from state.dependencies import get_state
from models.requests import (
    AssignToClustersRequest,
    AutoCullRequest,
    ClusterAllRequest,
    ClusterExpandRequest,
    ClusterRequest,
    DissolveClusterRequest,
    MatchedClusterRequest,
    ProjectionRequest,
    ScanPeaksRequest,
)
from services.clustering_inputs import (
    active_peak_regions as _active_peak_regions,
    prefix_compact_read as _prefix_compact_read,
    split_prefixed_read_id as _split_prefixed_read_id,
)

import asyncio
import threading

router = APIRouter(tags=["clustering"])

# Clustering routes load the working set (BAM reads) and cluster it: seconds
# on deep data. They ran on the event loop (k-means stalled every other
# request for 0.6-1.2 s per run on Hia5), so they run in worker threads.
# The ones that change a dataset's cluster assignments take their workspace's
# lock: within one workspace they stay one at a time, as they were on the
# loop; other workspaces (sessions, sandboxes) don't wait for them.
_LOCKS_GUARD = threading.Lock()


def _cluster_state_lock(state) -> threading.Lock:
    root = getattr(state, "_genome_base", None) or state  # a panel-genome view shares its workspace's
    lock = root.__dict__.get("_cluster_state_lock")
    if lock is None:
        with _LOCKS_GUARD:
            lock = root.__dict__.setdefault("_cluster_state_lock", threading.Lock())
    return lock


def _locked(fn, /, **kwargs):
    from services.background_work import configure_worker_threads
    configure_worker_threads()
    from services.background_work import checkpoint
    lock = _cluster_state_lock(kwargs["state"])
    while not lock.acquire(timeout=0.05):
        checkpoint()
    try:
        checkpoint()
        return fn(**kwargs)
    finally:
        lock.release()


async def _cluster_state_change(fn, /, request=None, **kwargs):
    """``fn(**kwargs)`` in a worker thread, one cluster-state change at a time per workspace."""
    if request is None:
        return await asyncio.to_thread(_locked, fn, **kwargs)
    from services.background_work import Cancelled, cancelled_response, run_background
    try:
        # Stateful fits are never deduplicated; each retains its own cancellation.
        return await run_background(request, object(), _locked, fn, **kwargs)
    except Cancelled:
        return cancelled_response()
CLUSTER_DIAGNOSTICS_ENV = "FIBERBROWSER_CLUSTER_DIAGNOSTICS"


def _clustering_endpoint():
    from services import clustering_endpoint

    return clustering_endpoint


def clustering_diagnostics_enabled() -> bool:
    return _clustering_endpoint().clustering_diagnostics_enabled()


def log_clustering_diagnostic(message: str) -> None:
    _clustering_endpoint().log_clustering_diagnostic(message)


def cluster_compact_reads(*args, **kwargs):
    from services.cluster_assignment import cluster_compact_reads as _cluster_compact_reads

    return _cluster_compact_reads(*args, **kwargs)


def _pick_vplot_intervals(read: dict, target_layer: str | None):
    """Resolve V-plot interval source, keeping FIRE user-facing."""
    if target_layer:
        layers = read.get('layers') or {}
        layer_data = layers.get(target_layer)
        if not layer_data and target_layer == "fire":
            layer_data = layers.get("msp")
        elif not layer_data and target_layer == "msp":
            layer_data = layers.get("fire")
        if layer_data:
            return layer_data.get('intervals') or []
        if target_layer in {"fire", "msp"}:
            return read.get("fire") or []
        return []
    return read.get('intervals') or []


@router.post("/api/scan_peaks")
async def scan_peaks(
    req: ScanPeaksRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    dataset_id: Optional[str] = Query(None),
    spanning: bool = Query(False),  # Default False for DAF-C compatibility
    request: Request = None,
    state=Depends(get_state)):
    """
    Fast multi-threshold peak scanning with progressive masking.
    Uses WORKING SET for analysis. Runs on the background pool
    (services/background_work.py): after the view's reads, one scan per
    identical request in flight, stopped when its client goes away.
    """
    import hashlib
    from services.background_work import Cancelled, cancelled_response, run_background
    from services.background_work import dataset_identity
    from services.read_quality_filters import active_quality_filters
    from services.remote_access import current_request_is_remote
    from services.working_sets import read_load_token
    body = req.model_dump_json() if hasattr(req, "model_dump_json") else req.json()
    scan_ids = list(req.dataset_ids or ([dataset_id] if dataset_id else getattr(state, "dataset_order", []) or []))
    # Shared only by a request for the same data (files, generation) under the same settings.
    key = ("scan_peaks", id(state), chrom, start, end, dataset_id, spanning,
           hashlib.sha1(body.encode()).hexdigest(), dataset_identity(state, scan_ids),
           repr(read_load_token(state, state.translate_chrom(chrom))),
           bool(getattr(state, "infer_legacy_layers", True)), int(getattr(state, "legacy_nuc_min_size", 90) or 90),
           repr(active_quality_filters(state)),
           # save_plot writes the owner's diagnostic PNG only for the owner's own requests: never share across scopes.
           current_request_is_remote())
    try:
        return await run_background(
            request, key,
            _clustering_endpoint().run_scan_peaks_endpoint,
            state=state,
            req=req,
            chrom=chrom,
            start=start,
            end=end,
            dataset_id=dataset_id,
            spanning=spanning,
        )
    except Cancelled:
        return cancelled_response()
    except ValueError as error:
        # An unsupported signal source or a missing track.
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/cluster_all")
async def do_cluster_all(
    req: ClusterAllRequest, 
    chrom: str = Query(...), 
    start: int = Query(...), 
    end: int = Query(...), 
    spanning: bool = Query(False),
    request: Request = None,
    state=Depends(get_state)):
    """Cluster reads from multiple datasets together for comparable assignments.
    
    Uses DataFrame format to preserve full per-base footprint patterns.
    If read_ids is provided, only those reads are clustered (for consistency with display).
    If max_reads is provided, reproducibly sample to that count per dataset.
    """
    try:
        # Off the event loop (the neighbourhood graph also waits for any t-SNE
        # map being computed: services/read_projection.py runs them one at a time).
        return await _cluster_state_change(
            _clustering_endpoint().run_cluster_all_endpoint,
            request=request, state=state, req=req, chrom=chrom, start=start, end=end, spanning=spanning,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/cluster_matched_views")
async def cluster_matched_views(req: MatchedClusterRequest, state=Depends(get_state)):
    """Cluster two comparison views (e.g. haplotypes) on matched feature domains.

    Feature i of one view is matched with feature i of the other; each is
    resampled to the same width. mode="joint" fits one model to both views
    (comparable states); mode="separate" fits each view on its own.
    """
    from services.matched_view_clustering import run_matched_views_endpoint

    try:
        return await asyncio.to_thread(run_matched_views_endpoint, state=state, req=req)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/dissolve_cluster")
async def do_dissolve_cluster(
    req: DissolveClusterRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """Dissolve a cluster by reassigning its reads to the nearest remaining cluster centroid."""
    return await _cluster_state_change(
        _clustering_endpoint().run_dissolve_cluster_endpoint,
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.post("/api/auto_cull_clusters")
async def do_auto_cull_clusters(
    req: AutoCullRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """Auto-cull low-abundance and highly similar clusters by iterative dissolution."""
    return await _cluster_state_change(
        _clustering_endpoint().run_auto_cull_clusters_endpoint,
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.post("/api/cluster_projection")
async def do_cluster_projection(
    req: ProjectionRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """Compute a 2D projection (t-SNE by default; PCA / UMAP) of cluster reads.

    Joint feature matrix across datasets (same pipeline as cluster_all and
    auto_cull), so points from different datasets live in the same coordinate
    space. Optionally simulates autocull to produce a "before/after" label
    pair without mutating dataset.cluster_assignments.

    Response (parallel arrays, one entry per read):
        coords_x, coords_y: projection coordinates
        read_ids: per-read original ID (prefixed with dataset_id for uniqueness)
        dataset_ids: per-read source dataset
        labels_before: cluster label from dataset.cluster_assignments
        labels_after: cluster label after simulated autocull (None if not simulated)
        cluster_centroids_before: {cluster_id: [x, y]} in projected space
        cluster_centroids_after: same after autocull (None if not simulated)
        dissolved: [{cluster, count, reason, merged_into, dominant_target}, ...]
        method: projection method actually used (may fall back from umap to pca)
        variance_explained: per-component PC variance ratio (PCA only; None otherwise)
        feature_dim, n_reads: sanity counts
        strands, alignment_strands: per-read DAF strand (CT/GA) and alignment (+/-)
        embedded: t-SNE only, False for reads placed by their nearest embedded
            reads (more reads than the cap)
        projection_params: method, seed, perplexity, neighbours, feature digest,
            cap: everything that defines the map, for exports
    """
    # t-SNE takes seconds on thousands of reads: off the event loop.
    return await asyncio.to_thread(
        _clustering_endpoint().run_cluster_projection_endpoint,
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.post("/api/assign_to_clusters")
async def do_assign_to_clusters(
    req: AssignToClustersRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),
    state=Depends(get_state)):
    """Assign reads to existing clusters based on stored patterns (for dynamic clustering).

    This is used when panning/zooming with dynamic clustering enabled. Instead of
    re-clustering from scratch, we compute each read's binary pattern at the stored
    peak locations and match it to the existing cluster patterns.
    """
    return await _cluster_state_change(
        _clustering_endpoint().run_assign_to_clusters_endpoint,
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.post("/api/cluster")
async def do_cluster(
    req: ClusterRequest, 
    chrom: str = Query(...), 
    start: int = Query(...), 
    end: int = Query(...), 
    spanning: bool = Query(False),
    dataset_id: Optional[str] = Query(None),
    min_footprints: int = Query(0, description="Min number of footprints per read"),
    sample_seed: Optional[str] = Query(None),
    state=Depends(get_state)):
    """Cluster a single dataset (for backwards compatibility).
    
    Uses WORKING SET for fast clustering on all spanning reads.
    """
    return await _cluster_state_change(
        _clustering_endpoint().run_cluster_endpoint,
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        dataset_id=dataset_id,
        min_footprints=min_footprints,
        sample_seed=sample_seed,
        cluster_compact_reads_impl=cluster_compact_reads,
    )


@router.post("/api/cluster_expand")
async def cluster_expand(
    req: ClusterExpandRequest,
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    spanning: bool = Query(False),  # Default False for DAF-C compatibility,
    state=Depends(get_state)):
    """
    Get reads from specific clusters for detailed analysis.
    
    Use this when you want to focus on particular clusters
    (e.g., clicking cluster colorbar to expand).
    """
    return await asyncio.to_thread(
        _clustering_endpoint().run_cluster_expand_endpoint,
        state=state,
        req=req,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
    )


@router.get("/api/working_set_info")
async def get_working_set_info(
    chrom: str = Query(...),
    start: int = Query(...),
    end: int = Query(...),
    dataset_id: Optional[str] = Query(None),
    spanning: bool = Query(False),  # Default False for DAF-C compatibility,
    sample_seed: Optional[str] = Query(None),
    state=Depends(get_state)):
    """
    Get info about the working set for a region.
    
    Returns stats about the analysis dataset.
    """
    return await asyncio.to_thread(
        _clustering_endpoint().get_working_set_info_payload,
        state=state,
        chrom=chrom,
        start=start,
        end=end,
        dataset_id=dataset_id,
        spanning=spanning,
        sample_seed=sample_seed,
    )


from services.correspondence_clustering import RegionClusterRequest


@router.post('/api/cluster-regions')
async def cluster_regions(req: RegionClusterRequest, state=Depends(get_state)):
    from services.correspondence_clustering import run
    try:
        return await _cluster_state_change(lambda *, state, req: run(state, req), state=state, req=req)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


from services.correspondence_scanning import CorrespondenceScanRequest


@router.post('/api/scan-correspondence')
async def scan_correspondence(req: CorrespondenceScanRequest, request: Request, state=Depends(get_state)):
    from services.correspondence_scanning import run
    from services.background_work import run_background, Cancelled, cancelled_response, dataset_identity
    from services.read_quality_filters import active_quality_filters
    key = ('scan-correspondence', id(state), req.model_dump_json(),
           dataset_identity(state, [v.dataset_id for v in req.viewports]), repr(active_quality_filters(state)),
           bool(getattr(state, 'infer_legacy_layers', True)), getattr(state, 'legacy_nuc_min_size', 90))
    try:
        return await run_background(request, key, lambda: run(state, req))
    except Cancelled:
        return cancelled_response()
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error
