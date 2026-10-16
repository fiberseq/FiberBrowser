"""Runtime singleton registry for FastAPI dependency providers."""
from __future__ import annotations

import sys
from typing import Any

_state: Any = None
_dafc_state: Any = None
_jupyter_state: Any = None
_session_manager: Any = None


def _server_attr(name: str):
    """Compatibility fallback for tests/scripts that still assign server globals."""
    module = sys.modules.get("server")
    return getattr(module, name, None) if module is not None else None


def set_browser_state(value) -> None:
    global _state
    _state = value


def get_browser_state():
    return _state if _state is not None else _server_attr("state")


def set_dafc_state(value) -> None:
    global _dafc_state
    _dafc_state = value


def get_dafc_runtime_state():
    return _dafc_state if _dafc_state is not None else _server_attr("dafc_state")


def set_jupyter_state(value) -> None:
    global _jupyter_state
    _jupyter_state = value


def get_jupyter_runtime_state():
    return _jupyter_state if _jupyter_state is not None else _server_attr("jupyter_state")


def set_session_manager(value) -> None:
    global _session_manager
    _session_manager = value


def get_session_manager():
    return _session_manager if _session_manager is not None else _server_attr("session_manager")
