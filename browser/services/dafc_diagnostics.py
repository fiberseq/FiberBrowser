"""Shared opt-in diagnostics for DAF-C, Micro-C, and split-view helpers."""
from __future__ import annotations

from services.diagnostics import env_flag_enabled, log_if_enabled

DAFC_DIAGNOSTICS_ENV = "FIBERBROWSER_DAFC_DIAGNOSTICS"


def dafc_diagnostics_enabled() -> bool:
    """Return True when verbose DAF-C diagnostics are explicitly enabled."""
    return env_flag_enabled(DAFC_DIAGNOSTICS_ENV)


def log_dafc_diagnostic(message: str) -> None:
    """Print a DAF-C diagnostic message only when explicitly enabled."""
    log_if_enabled(DAFC_DIAGNOSTICS_ENV, message)
