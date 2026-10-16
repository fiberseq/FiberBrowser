"""Registers the lab pack with the server (plugins/packs.py): the NFR Accessibility (preview) router, its session
parts (Accessibility runs), its feature kinds and its analysis preference (the ChIP-Atlas choice).

Everything heavy is imported lazily, inside the hooks.
"""
from __future__ import annotations

from plugins.packs import PackAPI


def _export_runs(state, frontend_state, session):
    # Accessibility (preview) runs: frozen into the session like the footprint-class runs.
    from lab.services.accessibility_workflow import export_session_runs
    runs = export_session_runs(state, frontend_state or {})
    if runs:
        session["accessibility_runs"] = runs


def _import_begin(state, session):
    from lab.services.accessibility_workflow import dispose_session, session_run_ids
    dispose_session(state, keep_job_ids=session_run_ids(session))


def _import_end(state, session, results):
    from lab.services.accessibility_workflow import restore_session_runs
    restored, problems = restore_session_runs(state, session)
    results["accessibility_runs_restored"] = len(restored)
    results["accessibility_runs_failed"] = problems


def _dispose(state):
    from lab.services.accessibility_workflow import dispose_session
    dispose_session(state)


def _nfr_states(state, job_id, feature):
    from lab.services.nfr_features import nfr_states
    return nfr_states(state, job_id, feature)


MAX_CELL_TYPE_NAMES = 200


def _chipatlas_selection(value):
    """One genome's ChIP-Atlas experiment choice for the NFR peak check: {cellTypeClasses, cellTypes}."""
    from services.analysis_preferences import unique_names
    if not isinstance(value, dict):
        return None
    return {'cellTypeClasses': unique_names(value.get('cellTypeClasses'), MAX_CELL_TYPE_NAMES),
            'cellTypes': unique_names(value.get('cellTypes'), MAX_CELL_TYPE_NAMES)}


def register(api: PackAPI) -> None:
    from lab.routers.accessibility import router as accessibility_router
    # Every Accessibility route is refused on a public server and to remote viewers (no allowlist entries).
    api.add_router(accessibility_router)
    from lab.routers.region_sync import router as region_sync_router
    from lab.services.region_sync import dispose as dispose_sync
    api.add_router(region_sync_router)
    api.on_session_dispose(dispose_sync)
    api.on_session_import_begin(lambda state, session: dispose_sync(state))

    api.on_session_export(_export_runs)
    api.on_session_import_begin(_import_begin)
    api.on_session_import_end(_import_end)
    api.on_session_dispose(_dispose)

    # NFRs and NFR variants as selectable features (Cluster / Sort / Filter on them).
    api.feature_states("nfr-variant", _nfr_states)
    api.feature_states("nfr", _nfr_states)

    # The ChIP-Atlas experiments the NFR peak check takes, per genome (kept on this computer).
    api.preference_map("chipatlas_selection", _chipatlas_selection)
