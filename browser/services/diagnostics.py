"""Shared opt-in diagnostic logging helpers."""
from __future__ import annotations

import os

TRUE_ENV_VALUES = {"1", "true", "yes", "on"}


def env_flag_enabled(name: str) -> bool:
    """Return True when an environment flag uses a common truthy value."""
    return os.environ.get(name, "").strip().lower() in TRUE_ENV_VALUES


def log_if_enabled(env_name: str, message: str) -> None:
    """Print a diagnostic message only when the matching env flag is enabled."""
    if env_flag_enabled(env_name):
        print(message)
