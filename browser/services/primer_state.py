"""Primer design progress and latest-result state helpers."""
from __future__ import annotations

import threading
from typing import Any, Optional


_DEFAULT_PROGRESS = {
    "active": False,
    "stage": "",
    "progress": 0,
    "message": "",
}

_primer_design_progress: dict[str, Any] = dict(_DEFAULT_PROGRESS)
_progress_lock = threading.Lock()


def get_primer_progress() -> dict:
    """Return a copy of the latest primer-design progress payload."""
    with _progress_lock:
        return dict(_primer_design_progress)


def set_primer_progress_payload(payload: dict) -> None:
    """Replace primer progress with a normalized payload."""
    global _primer_design_progress
    progress = payload.get("progress", 0)
    try:
        progress = int(progress)
    except (TypeError, ValueError):
        progress = 0
    normalized = {
        "active": bool(payload.get("active", False)),
        "stage": str(payload.get("stage", "")),
        "progress": max(0, min(100, progress)),
        "message": str(payload.get("message", "")),
    }
    if payload.get("details") is not None:
        normalized["details"] = payload["details"]
    with _progress_lock:
        _primer_design_progress = normalized


def set_primer_progress(stage: str, progress: int, message: str, **details) -> None:
    """Update active primer progress with optional structured details."""
    payload = {
        "active": True,
        "stage": stage,
        "progress": progress,
        "message": message,
    }
    if details:
        payload["details"] = details
    set_primer_progress_payload(payload)


def set_primer_inactive(stage: str, progress: int = 0, message: str = "") -> None:
    set_primer_progress_payload({
        "active": False,
        "stage": stage,
        "progress": progress,
        "message": message,
    })


def get_primer_result(state) -> Optional[dict]:
    result = getattr(state, 'designed_primers', None)
    if result:
        return result
    return None


def set_primer_result(state, result: dict) -> None:
    state.designed_primers = result


def clear_primer_result(state) -> None:
    if hasattr(state, 'designed_primers'):
        state.designed_primers = None
