"""Canonical split-view semantics shared by DAF-C, Micro-C, and future multiview modes."""
from __future__ import annotations

from copy import deepcopy
from typing import Dict, Optional


UNASSIGNED = "unassigned"
MOLECULE_LINKED = "molecule_linked"
REGION_INDEPENDENT = "region_independent"
COORDINATE_SYNCED = "coordinate_synced"


MODE_ALIASES = {
    "linked_molecule": MOLECULE_LINKED,
    "independent_regions": REGION_INDEPENDENT,
    "haplotype_sync": COORDINATE_SYNCED,
    "haplotype_synced": COORDINATE_SYNCED,
    "syncable_independent": COORDINATE_SYNCED,
}


SPLIT_VIEW_MODES: Dict[str, Dict] = {
    UNASSIGNED: {
        "mode": UNASSIGNED,
        "label": "Unassigned split view",
        "row_coupling": "none",
        "read_source": "none",
        "analysis_scope": "pending",
        "co_cluster_scope": "none",
        "supports_background_reads": False,
        "description": "Session exists but no region pair has been attached yet.",
    },
    MOLECULE_LINKED: {
        "mode": MOLECULE_LINKED,
        "label": "Molecule-linked",
        "row_coupling": "molecule",
        "read_source": "linked_segments",
        "analysis_scope": "molecule_pair",
        "co_cluster_scope": "molecule",
        "supports_background_reads": True,
        "description": "Same molecule/read is shown across regions; rows must stay paired.",
    },
    REGION_INDEPENDENT: {
        "mode": REGION_INDEPENDENT,
        "label": "Region-independent",
        "row_coupling": "none",
        "read_source": "per_region_query",
        "analysis_scope": "viewport",
        "co_cluster_scope": "independent_panel",
        "supports_background_reads": False,
        "description": "Each viewport fetches its own reads; rows are not paired.",
    },
    COORDINATE_SYNCED: {
        "mode": COORDINATE_SYNCED,
        "label": "Coordinate-synced",
        "row_coupling": "syncable_independent",
        "read_source": "per_region_query",
        "analysis_scope": "mapped_viewports",
        "co_cluster_scope": "synced_viewports",
        "supports_background_reads": False,
        "description": "Viewports are navigated through a coordinate mapping, but reads remain independent.",
    },
}


CONTACT_MODE_TO_SPLIT_VIEW_MODE = {
    "dafc": MOLECULE_LINKED,
    "microc": REGION_INDEPENDENT,
}


def normalize_split_view_mode(mode: Optional[str], contact_mode: Optional[str] = None) -> str:
    """Resolve requested split-view mode with legacy contact-mode fallback."""
    if mode:
        normalized = str(mode).strip().lower().replace("-", "_")
        normalized = MODE_ALIASES.get(normalized, normalized)
        if normalized in SPLIT_VIEW_MODES:
            return normalized

    legacy_mode = str(contact_mode or "").strip().lower()
    return CONTACT_MODE_TO_SPLIT_VIEW_MODE.get(legacy_mode, UNASSIGNED)


def split_view_semantics(mode: Optional[str], contact_mode: Optional[str] = None) -> Dict:
    """Return a copy of the canonical semantics payload for a mode."""
    resolved = normalize_split_view_mode(mode, contact_mode)
    return deepcopy(SPLIT_VIEW_MODES[resolved])


def split_view_session_payload(session: Dict) -> Dict:
    """Return the mode fields exposed on linked-session API responses."""
    contact_mode = session.get("contact_mode")
    mode = normalize_split_view_mode(session.get("split_view_mode"), contact_mode)
    return {
        "split_view_mode": mode,
        "split_view_semantics": split_view_semantics(mode, contact_mode),
    }


def split_view_contact_mode(mode: Optional[str], contact_mode: Optional[str] = None) -> Optional[str]:
    """Return the legacy contact-mode value matching a semantic split mode."""
    resolved = normalize_split_view_mode(mode, contact_mode)
    if resolved == UNASSIGNED:
        return None
    return "dafc" if resolved == MOLECULE_LINKED else "microc"


def split_view_session_summary(session: Dict, session_id: Optional[str] = None) -> Dict:
    """Return a compact, stable linked-session payload for API responses."""
    reads = session.get("reads") or []
    regions = session.get("regions")
    mode_payload = split_view_session_payload(session)
    contact_mode = split_view_contact_mode(
        mode_payload["split_view_mode"],
        session.get("contact_mode"),
    )
    return {
        "id": session_id or session.get("id"),
        "created_at": session.get("created_at"),
        "version": session.get("version", 0),
        "has_regions": regions is not None,
        "has_reads": len(reads) > 0,
        "n_reads": len(reads),
        "regions": regions,
        "contact_mode": contact_mode,
        **mode_payload,
    }


def is_molecule_linked_mode(mode: Optional[str], contact_mode: Optional[str] = None) -> bool:
    semantics = split_view_semantics(mode, contact_mode)
    return semantics.get("row_coupling") == "molecule"
