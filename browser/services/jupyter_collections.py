"""Small state mutations for Jupyter-driven browser collections."""
from __future__ import annotations

import uuid
from typing import Any, MutableMapping, Optional


def short_id() -> str:
    """Return the compact IDs used by the existing Jupyter API payloads."""
    return str(uuid.uuid4())[:8]


def list_collection(collection: MutableMapping[str, dict]) -> list:
    """Return collection values in insertion order for API responses."""
    return list(collection.values())


def add_highlight(jupyter_state: Any, req: Any) -> str:
    highlight_id = short_id()
    highlight = {
        "id": highlight_id,
        "type": req.type,
        "color": req.color,
        "label": req.label,
        "dataset_id": req.dataset_id,
    }
    if req.type == "read" and req.read_ids:
        highlight["read_ids"] = req.read_ids
    elif req.type == "footprint" and req.footprints:
        highlight["footprints"] = req.footprints

    jupyter_state.highlights[highlight_id] = highlight
    jupyter_state.version += 1
    return highlight_id


def add_marker_group(jupyter_state: Any, req: Any) -> str:
    marker_id = short_id()
    jupyter_state.markers[marker_id] = {
        "id": marker_id,
        "group": req.group,
        "markers": req.markers,
    }
    jupyter_state.version += 1
    return marker_id


def add_footprint_color_group(jupyter_state: Any, req: Any) -> str:
    color_id = short_id()
    jupyter_state.footprint_colors[color_id] = {
        "id": color_id,
        "group": req.group,
        "footprint_colors": req.footprint_colors,
    }
    jupyter_state.version += 1
    return color_id


def remove_collection_item(jupyter_state: Any, collection_name: str, item_id: str) -> None:
    getattr(jupyter_state, collection_name).pop(item_id, None)
    jupyter_state.version += 1


def clear_collection(jupyter_state: Any, collection_name: str, group: Optional[str] = None) -> None:
    collection = getattr(jupyter_state, collection_name)
    if group:
        to_remove = [key for key, value in collection.items() if value.get("group") == group]
        for key in to_remove:
            collection.pop(key, None)
    else:
        collection.clear()
    jupyter_state.version += 1


def queue_peak_import(jupyter_state: Any, req: Any) -> str:
    peak_import_id = short_id()
    jupyter_state.pending_peak_import = {
        "id": peak_import_id,
        "peaks": req.peaks,
        "chrom": req.chrom,
        "label": req.label,
        "lock": req.lock,
        "select": req.select,
        "replace_existing": req.replace_existing,
    }
    jupyter_state.version += 1
    return peak_import_id


def queue_peak_rules_update(jupyter_state: Any, req: Any) -> str:
    update_id = short_id()
    jupyter_state.pending_peak_rules_update = {
        "id": update_id,
        "rules": req.rules,
        "lock": req.lock,
        "clear_peaks": req.clear_peaks,
        "rescan": req.rescan,
    }
    jupyter_state.version += 1
    return update_id


def get_highlights_payload(jupyter_state: Any) -> dict:
    return {"highlights": list_collection(jupyter_state.highlights)}


def add_highlight_for_request(jupyter_state: Any, req: Any) -> dict:
    highlight_id = add_highlight(jupyter_state, req)
    return {"success": True, "highlight_id": highlight_id}


def remove_highlight_for_request(jupyter_state: Any, highlight_id: str) -> dict:
    remove_collection_item(jupyter_state, "highlights", highlight_id)
    return {"success": True}


def clear_highlights_for_request(jupyter_state: Any) -> dict:
    clear_collection(jupyter_state, "highlights")
    return {"success": True}


def get_markers_payload(jupyter_state: Any) -> dict:
    return {"markers": list_collection(jupyter_state.markers)}


def add_markers_for_request(jupyter_state: Any, req: Any) -> dict:
    marker_id = add_marker_group(jupyter_state, req)
    return {"success": True, "marker_id": marker_id}


def remove_marker_for_request(jupyter_state: Any, marker_id: str) -> dict:
    remove_collection_item(jupyter_state, "markers", marker_id)
    return {"success": True}


def clear_markers_for_request(jupyter_state: Any, group: Optional[str] = None) -> dict:
    clear_collection(jupyter_state, "markers", group)
    return {"success": True}


def get_footprint_colors_payload(jupyter_state: Any) -> dict:
    return {"footprint_colors": list_collection(jupyter_state.footprint_colors)}


def add_footprint_colors_for_request(jupyter_state: Any, req: Any) -> dict:
    color_id = add_footprint_color_group(jupyter_state, req)
    return {"success": True, "color_id": color_id}


def remove_footprint_colors_for_request(jupyter_state: Any, color_id: str) -> dict:
    remove_collection_item(jupyter_state, "footprint_colors", color_id)
    return {"success": True}


def clear_footprint_colors_for_request(jupyter_state: Any, group: Optional[str] = None) -> dict:
    clear_collection(jupyter_state, "footprint_colors", group)
    return {"success": True}


def queue_peak_import_for_request(jupyter_state: Any, req: Any) -> dict:
    peak_import_id = queue_peak_import(jupyter_state, req)
    return {
        "success": True,
        "count": len(req.peaks),
        "import_id": peak_import_id,
    }


def queue_peak_rules_update_for_request(jupyter_state: Any, req: Any) -> dict:
    update_id = queue_peak_rules_update(jupyter_state, req)
    return {
        "success": True,
        "count": len(req.rules),
        "update_id": update_id,
    }
