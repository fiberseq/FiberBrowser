"""Router registration for the FiberBrowser API."""
from __future__ import annotations

from fastapi import FastAPI

from routers.annotations import router as annotations_router
from routers.app_info import router as app_info_router
from routers.catalog import router as catalog_router, set_catalog
from routers.clustering import router as clustering_router
from routers.clustering_visualization import router as clustering_visualization_router
from routers.coaccessibility import router as coaccessibility_router
from routers.dafc import router as dafc_router
from routers.datasets import router as datasets_router
from routers.derived_layers import router as derived_layers_router
from routers.external_tracks import router as external_tracks_router
from routers.features import router as features_router
from routers.files import router as files_router
from routers.filtering import router as filtering_router
from routers.footprint import router as footprint_router
from routers.footprint_rules import router as footprint_rules_router
from routers.genome import router as genome_router
from routers.insertions import router as insertions_router
from routers.jupyter import router as jupyter_router
from routers.library import router as library_router
from routers.lab import router as lab_router
from routers.linked_sessions import router as linked_sessions_router
from routers.microc import router as microc_router
from routers.natural_language import router as natural_language_router
from routers.pipeline import router as pipeline_router
from routers.plugins import router as plugins_router
from routers.preferences import router as preferences_router
from routers.primers import router as primers_router
from routers.read_auxiliary import router as read_auxiliary_router
from routers.read_stats import router as read_stats_router
from routers.reads import router as reads_router
from routers.regions import router as regions_router
from routers.remote import router as remote_router
from routers.render import router as render_router
from routers.sandbox import router as sandbox_router
from routers.session_links import router as session_links_router
from routers.sessions import router as sessions_router
from routers.sv import router as sv_router
from routers.variants import router as variants_router
from routers.tracks import router as tracks_router
from routers.utility import router as utility_router
from routers.version import router as version_router
from routers.workspaces import router as workspaces_router
from routers.lift import router as lift_router
from routers.differences import router as differences_router
from routers.graph_panel import router as graph_panel_router

API_ROUTERS = (
    jupyter_router,
    dafc_router,
    linked_sessions_router,
    microc_router,
    primers_router,
    external_tracks_router,
    sessions_router,
    genome_router,
    datasets_router,
    reads_router,
    sv_router,
    variants_router,
    regions_router,
    read_auxiliary_router,
    insertions_router,
    clustering_router,
    clustering_visualization_router,
    filtering_router,
    tracks_router,
    files_router,
    footprint_router,
    footprint_rules_router,
    natural_language_router,
    derived_layers_router,
    utility_router,
    read_stats_router,
    render_router,
    coaccessibility_router,
    preferences_router,
    features_router,
    annotations_router,
    catalog_router,
    plugins_router,
    version_router,
    app_info_router,
    sandbox_router,
    workspaces_router,
    pipeline_router,
    library_router,
    lab_router,
    remote_router,
    session_links_router,
    lift_router,
    differences_router,
    graph_panel_router,
)


def register_api_routers(app: FastAPI) -> None:
    """Attach all built-in API routers to the FastAPI app, then the plugin packs' (plugins/packs.py)."""
    for router in API_ROUTERS:
        app.include_router(router)
    from plugins.packs import hooks
    for router in hooks().routers:
        app.include_router(router)
