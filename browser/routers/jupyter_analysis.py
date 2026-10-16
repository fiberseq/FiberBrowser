"""Jupyter analysis, reproducibility, sequence, and motif endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from models.requests import (
    CustomMotifFileRequest,
    CustomMotifRequest,
    ImportPeaksRequest,
    JupyterBrowserSettingsRequest,
    JupyterBrowserSettingsSnapshotRequest,
    JupyterPeakRulesRequest,
    MotifSearchRequest,
    SequenceRequest,
    SyncPeaksRequest,
)
from services.jupyter_collections import (
    queue_peak_import_for_request,
    queue_peak_rules_update_for_request,
)
from services.jupyter_endpoint import (
    get_analysis_state_payload,
    get_browser_settings_payload,
    get_peaks_payload,
    get_session_manifest_payload,
    get_sequences_for_request,
    queue_browser_settings_update,
    search_motifs_for_request,
    sync_browser_settings_for_request,
    sync_peaks_for_request,
)
from services.jupyter_motifs import (
    delete_custom_motif,
    list_available_jaspar_motifs,
    list_custom_motifs,
    load_custom_motif_file,
    register_custom_motif,
)
from state.dependencies import get_jupyter_state, get_state

router = APIRouter(tags=["jupyter-analysis"])


@router.get("/api/jupyter/peaks")
async def jupyter_get_peaks(
    selected_only: bool = Query(False),
    jupyter_state=Depends(get_jupyter_state),
):
    """Get browser-synced peaks for Jupyter access."""
    return get_peaks_payload(jupyter_state, selected_only=selected_only)


@router.post("/api/jupyter/sync_peaks")
async def jupyter_sync_peaks(
    req: SyncPeaksRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Sync peaks from the frontend into the Jupyter bridge."""
    return sync_peaks_for_request(jupyter_state, req)


@router.post("/api/jupyter/import_peaks")
async def jupyter_import_peaks(
    req: ImportPeaksRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Queue peaks for browser import and locking."""
    return queue_peak_import_for_request(jupyter_state, req)


@router.post("/api/jupyter/peak_rules")
async def jupyter_update_peak_rules(
    req: JupyterPeakRulesRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Queue peak-rule settings for browser import."""
    return queue_peak_rules_update_for_request(jupyter_state, req)


@router.post("/api/jupyter/settings")
async def jupyter_update_browser_settings(
    req: JupyterBrowserSettingsRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Queue browser setting updates from notebooks."""
    return queue_browser_settings_update(jupyter_state, req)


@router.get("/api/jupyter/settings")
async def jupyter_get_browser_settings(jupyter_state=Depends(get_jupyter_state)):
    """Return the latest browser-side settings snapshot synced by the UI."""
    return get_browser_settings_payload(jupyter_state)


@router.get("/api/jupyter/session_manifest")
async def jupyter_get_session_manifest(jupyter_state=Depends(get_jupyter_state)):
    """Return the latest browser-synced reproducibility/session manifest."""
    return get_session_manifest_payload(jupyter_state)


@router.get("/api/jupyter/analysis_state")
async def jupyter_get_analysis_state(jupyter_state=Depends(get_jupyter_state)):
    """Return browser-synced reproducibility state used by notebooks."""
    return get_analysis_state_payload(jupyter_state)


@router.post("/api/jupyter/settings/sync")
async def jupyter_sync_browser_settings(
    req: JupyterBrowserSettingsSnapshotRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Store current browser settings for Python/Jupyter reproducibility capture."""
    return sync_browser_settings_for_request(jupyter_state, req)


@router.post("/api/jupyter/sequences")
async def jupyter_get_sequences(
    req: SequenceRequest,
    state=Depends(get_state),
    jupyter_state=Depends(get_jupyter_state),
):
    """Extract DNA sequences for requested genomic regions."""
    return get_sequences_for_request(state, req)


@router.get("/api/jupyter/motifs/list")
async def jupyter_list_motifs(
    species: Optional[int] = Query(None, description="NCBI taxonomy ID (e.g., 7227 for Drosophila)"),
    tax_group: Optional[str] = Query(None, description="Taxonomic group (e.g., 'insects', 'vertebrates')"),
    tf_family: Optional[str] = Query(None, description="TF family (e.g., 'C2H2 zinc finger factors')"),
    name_contains: Optional[str] = Query(None, description="Filter by TF name substring"),
    jupyter_state=Depends(get_jupyter_state),
):
    """List available JASPAR motifs with optional filtering."""
    return list_available_jaspar_motifs(
        species=species,
        tax_group=tax_group,
        tf_family=tf_family,
        name_contains=name_contains,
    )


@router.post("/api/jupyter/motifs/search")
async def jupyter_search_motifs(
    req: MotifSearchRequest,
    state=Depends(get_state),
    jupyter_state=Depends(get_jupyter_state),
):
    """Search for TF motifs in provided regions or browser-synced peaks."""
    return search_motifs_for_request(state, jupyter_state, req)


@router.post("/api/jupyter/motifs/custom")
async def jupyter_add_custom_motif(
    req: CustomMotifRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Register a custom PWM for motif searching."""
    return register_custom_motif(jupyter_state, req.name, req.counts)


@router.delete("/api/jupyter/motifs/custom/{name}")
async def jupyter_delete_custom_motif(
    name: str,
    jupyter_state=Depends(get_jupyter_state),
):
    """Remove a custom motif."""
    return delete_custom_motif(jupyter_state, name)


@router.get("/api/jupyter/motifs/custom")
async def jupyter_list_custom_motifs(jupyter_state=Depends(get_jupyter_state)):
    """List all registered custom motifs."""
    return list_custom_motifs(jupyter_state.custom_motifs)


@router.post("/api/jupyter/motifs/load_file")
async def jupyter_load_motifs_file(
    req: CustomMotifFileRequest,
    jupyter_state=Depends(get_jupyter_state),
):
    """Load motifs from a JASPAR or MEME file."""
    return load_custom_motif_file(jupyter_state, req.file_path, req.format)
