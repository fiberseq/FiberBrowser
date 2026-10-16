"""Jupyter integration endpoints for live browser control.

Extracted from server.py.
"""
from __future__ import annotations

from typing import List, Optional
from fastapi import APIRouter, Query, Depends

from state.dependencies import get_state, get_jupyter_state
from models.requests import (
    BrowserActionsRequest, GotoRequest, GotoGeneRequest, PushReadsRequest, PushReadsReplaceRequest,
    ReadOrderRequest, HighlightRequest, MarkerRequest, FootprintColorRequest,
    JupyterFilterRequest,
)
from services.jupyter_endpoint import (
    clear_all_jupyter_state,
    clear_pushed_reads,
    clear_read_filter,
    clear_read_order,
    get_browser_order_payload,
    get_clusters_payload,
    get_current_region_payload,
    get_custom_reads_payload,
    get_reads_payload,
    get_read_filter_payload,
    get_read_order_payload,
    get_selection_payload,
    goto_gene_for_request,
    goto_region_for_request,
    push_reads_for_request,
    push_reads_replace_for_request,
    queue_browser_actions_for_request,
    request_refresh,
    set_read_filter_for_request,
    set_read_order_for_request,
    set_selection,
    sync_browser_order_for_request,
)
from services.jupyter_collections import (
    add_footprint_colors_for_request,
    add_highlight_for_request,
    add_markers_for_request,
    clear_footprint_colors_for_request,
    clear_highlights_for_request,
    clear_markers_for_request,
    get_footprint_colors_payload,
    get_highlights_payload,
    get_markers_payload,
    remove_footprint_colors_for_request,
    remove_highlight_for_request,
    remove_marker_for_request,
)
from services.jupyter_payloads import build_jupyter_poll_state
from routers.jupyter_analysis import router as jupyter_analysis_router

router = APIRouter(tags=["jupyter"])
router.include_router(jupyter_analysis_router)


# ── Region & Navigation ────────────────────────────────────────────────────

@router.get("/api/jupyter/region")
async def jupyter_get_region(state=Depends(get_state)):
    """Get current viewport region."""
    return get_current_region_payload(state)


@router.post("/api/jupyter/goto")
async def jupyter_goto(req: GotoRequest, state=Depends(get_state),
                       jupyter_state=Depends(get_jupyter_state)):
    """Set target region for browser to navigate to."""
    return goto_region_for_request(state, jupyter_state, req)


@router.post("/api/jupyter/goto_gene")
async def jupyter_goto_gene(req: GotoGeneRequest, state=Depends(get_state),
                            jupyter_state=Depends(get_jupyter_state)):
    """Navigate to a gene by name."""
    return goto_gene_for_request(state, jupyter_state, req)


@router.post("/api/jupyter/actions")
async def jupyter_queue_browser_actions(req: BrowserActionsRequest,
                                        state=Depends(get_state),
                                        jupyter_state=Depends(get_jupyter_state)):
    """Queue UI-equivalent browser actions for the active frontend to execute."""
    return queue_browser_actions_for_request(state, jupyter_state, req)


# ── Clusters ────────────────────────────────────────────────────────────────

@router.get("/api/jupyter/clusters")
async def jupyter_get_clusters(dataset_id: Optional[str] = Query(None),
                               state=Depends(get_state)):
    """Get cluster assignments for reads."""
    return get_clusters_payload(state, dataset_id)


# ── Reads ───────────────────────────────────────────────────────────────────

@router.get("/api/jupyter/reads")
async def jupyter_get_reads(
    dataset_id: Optional[str] = Query(None),
    chrom: str = Query(None),
    start: int = Query(None),
    end: int = Query(None),
    spanning: bool = Query(True),
    min_footprints: int = Query(0),
    sample_seed: Optional[str] = Query(None),
    state=Depends(get_state),
):
    """Get reads for analysis in Jupyter (from the working set)."""
    return get_reads_payload(
        state,
        dataset_id=dataset_id,
        chrom=chrom,
        start=start,
        end=end,
        spanning=spanning,
        min_footprints=min_footprints,
        sample_seed=sample_seed,
    )


@router.post("/api/jupyter/reads")
async def jupyter_push_reads(req: PushReadsRequest,
                             jupyter_state=Depends(get_jupyter_state)):
    """Push custom reads from Jupyter to display in browser."""
    return push_reads_for_request(jupyter_state, req)


@router.post("/api/jupyter/push_reads")
async def jupyter_push_reads_replace(req: PushReadsReplaceRequest,
                                     jupyter_state=Depends(get_jupyter_state)):
    """Push custom reads to replace the primary display."""
    return push_reads_replace_for_request(jupyter_state, req)


@router.delete("/api/jupyter/push_reads")
async def jupyter_clear_pushed_reads(jupyter_state=Depends(get_jupyter_state)):
    return clear_pushed_reads(jupyter_state)


# ── Read Order ──────────────────────────────────────────────────────────────

@router.get("/api/jupyter/order")
async def jupyter_get_order(dataset_id: Optional[str] = Query(None),
                            state=Depends(get_state),
                            jupyter_state=Depends(get_jupyter_state)):
    return get_read_order_payload(state, jupyter_state, dataset_id)


@router.post("/api/jupyter/order")
async def jupyter_set_order(req: ReadOrderRequest,
                            state=Depends(get_state),
                            jupyter_state=Depends(get_jupyter_state)):
    return set_read_order_for_request(state, jupyter_state, req)


@router.delete("/api/jupyter/order")
async def jupyter_clear_order(dataset_id: str = Query(None),
                              state=Depends(get_state),
                              jupyter_state=Depends(get_jupyter_state)):
    return clear_read_order(state, jupyter_state, dataset_id)


# ── Browser Read Order ──────────────────────────────────────────────────────

@router.get("/api/jupyter/browser_order")
async def jupyter_get_browser_order(dataset_id: Optional[str] = Query(None),
                                    state=Depends(get_state),
                                    jupyter_state=Depends(get_jupyter_state)):
    """Get the latest top-to-bottom read order reported by the browser."""
    return get_browser_order_payload(state, jupyter_state, dataset_id)


@router.post("/api/jupyter/browser_order")
async def jupyter_sync_browser_order(req: ReadOrderRequest,
                                     state=Depends(get_state),
                                     jupyter_state=Depends(get_jupyter_state)):
    """Sync browser-computed visible read order for notebook reproducibility.

    This is intentionally separate from /api/jupyter/order, which is a
    notebook-to-browser command channel. Updating browser_read_order should not
    trigger browser polling or override notebook-controlled sorting.
    """
    return sync_browser_order_for_request(state, jupyter_state, req)


# ── Read Filter ─────────────────────────────────────────────────────────────

@router.get("/api/jupyter/filter")
async def jupyter_get_filter(dataset_id: Optional[str] = Query(None),
                             state=Depends(get_state),
                             jupyter_state=Depends(get_jupyter_state)):
    return get_read_filter_payload(state, jupyter_state, dataset_id)


@router.post("/api/jupyter/filter")
async def jupyter_set_filter(req: JupyterFilterRequest,
                             state=Depends(get_state),
                             jupyter_state=Depends(get_jupyter_state)):
    return set_read_filter_for_request(state, jupyter_state, req)


@router.delete("/api/jupyter/filter")
async def jupyter_clear_filter(dataset_id: str = Query(None),
                               state=Depends(get_state),
                               jupyter_state=Depends(get_jupyter_state)):
    return clear_read_filter(state, jupyter_state, dataset_id)


# ── Highlights ──────────────────────────────────────────────────────────────

@router.get("/api/jupyter/highlights")
async def jupyter_get_highlights(jupyter_state=Depends(get_jupyter_state)):
    return get_highlights_payload(jupyter_state)


@router.post("/api/jupyter/highlights")
async def jupyter_add_highlight(req: HighlightRequest,
                                jupyter_state=Depends(get_jupyter_state)):
    return add_highlight_for_request(jupyter_state, req)


@router.delete("/api/jupyter/highlights/{highlight_id}")
async def jupyter_remove_highlight(highlight_id: str,
                                   jupyter_state=Depends(get_jupyter_state)):
    return remove_highlight_for_request(jupyter_state, highlight_id)


@router.delete("/api/jupyter/highlights")
async def jupyter_clear_highlights(jupyter_state=Depends(get_jupyter_state)):
    return clear_highlights_for_request(jupyter_state)


# ── Selection ───────────────────────────────────────────────────────────────

@router.get("/api/jupyter/selection")
async def jupyter_get_selection(dataset_id: Optional[str] = Query(None),
                                state=Depends(get_state),
                                jupyter_state=Depends(get_jupyter_state)):
    return get_selection_payload(state, jupyter_state, dataset_id)


@router.post("/api/jupyter/selection")
async def jupyter_set_selection(read_ids: List[str],
                                dataset_id: Optional[str] = Query(None),
                                state=Depends(get_state),
                                jupyter_state=Depends(get_jupyter_state)):
    return set_selection(state, jupyter_state, read_ids, dataset_id)


# ── Refresh ─────────────────────────────────────────────────────────────────

@router.post("/api/jupyter/refresh")
async def jupyter_refresh(jupyter_state=Depends(get_jupyter_state)):
    return request_refresh(jupyter_state)


# ── Full State (polling endpoint) ──────────────────────────────────────────

@router.get("/api/jupyter/state")
async def jupyter_get_state(jupyter_state=Depends(get_jupyter_state)):
    """Get full Jupyter integration state (for browser polling)."""
    return build_jupyter_poll_state(jupyter_state)


# ── Custom Reads ────────────────────────────────────────────────────────────

@router.get("/api/jupyter/custom_reads/{dataset_id}")
async def jupyter_get_custom_reads(dataset_id: str,
                                   jupyter_state=Depends(get_jupyter_state)):
    return get_custom_reads_payload(jupyter_state, dataset_id)


# ── Markers ─────────────────────────────────────────────────────────────────

@router.get("/api/jupyter/markers")
async def jupyter_get_markers(jupyter_state=Depends(get_jupyter_state)):
    return get_markers_payload(jupyter_state)


@router.post("/api/jupyter/markers")
async def jupyter_add_markers(req: MarkerRequest,
                              jupyter_state=Depends(get_jupyter_state)):
    return add_markers_for_request(jupyter_state, req)


@router.delete("/api/jupyter/markers/{marker_id}")
async def jupyter_remove_marker(marker_id: str,
                                jupyter_state=Depends(get_jupyter_state)):
    return remove_marker_for_request(jupyter_state, marker_id)


@router.delete("/api/jupyter/markers")
async def jupyter_clear_markers(group: str = Query(None),
                                jupyter_state=Depends(get_jupyter_state)):
    return clear_markers_for_request(jupyter_state, group)


# ── Footprint Colors ───────────────────────────────────────────────────────

@router.get("/api/jupyter/footprint_colors")
async def jupyter_get_footprint_colors(jupyter_state=Depends(get_jupyter_state)):
    return get_footprint_colors_payload(jupyter_state)


@router.post("/api/jupyter/footprint_colors")
async def jupyter_add_footprint_colors(req: FootprintColorRequest,
                                       jupyter_state=Depends(get_jupyter_state)):
    return add_footprint_colors_for_request(jupyter_state, req)


@router.delete("/api/jupyter/footprint_colors/{color_id}")
async def jupyter_remove_footprint_colors(color_id: str,
                                          jupyter_state=Depends(get_jupyter_state)):
    return remove_footprint_colors_for_request(jupyter_state, color_id)


@router.delete("/api/jupyter/footprint_colors")
async def jupyter_clear_footprint_colors(group: str = Query(None),
                                         jupyter_state=Depends(get_jupyter_state)):
    return clear_footprint_colors_for_request(jupyter_state, group)


# ── Clear All ───────────────────────────────────────────────────────────────

@router.delete("/api/jupyter/clear")
async def jupyter_clear_all(jupyter_state=Depends(get_jupyter_state)):
    return clear_all_jupyter_state(jupyter_state)
