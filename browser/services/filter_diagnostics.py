"""Opt-in diagnostics for read filtering and quality-filter state changes."""
from __future__ import annotations

from services.diagnostics import env_flag_enabled, log_if_enabled


FILTER_DIAGNOSTICS_ENV = "FIBERBROWSER_FILTER_DIAGNOSTICS"


def filtering_diagnostics_enabled() -> bool:
    return env_flag_enabled(FILTER_DIAGNOSTICS_ENV)


def log_filtering_diagnostic(message: str) -> None:
    log_if_enabled(FILTER_DIAGNOSTICS_ENV, message)
