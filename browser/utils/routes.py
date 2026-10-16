"""Flatten a FastAPI app's routes the same way on every FastAPI version.

FastAPI < 0.142 stores each included route in ``app.routes`` with its full
(prefixed) ``path``. FastAPI 0.142 stores ``_IncludedRouter`` branches there
instead, which have no ``path``; the effective routes come from
``fastapi.routing.iter_route_contexts``. Code that enumerates routes (the
Copilot catalog, the dataset builder, route tests) uses ``app_routes`` so it
sees every route on both. The public-mode guard, which also matches requests,
has its own walker (services/public_mode_guard.iter_route_entries).
"""
from __future__ import annotations

from typing import Any


def app_routes(app: Any) -> list[Any]:
    """Route-like objects with ``path``, ``methods``, ``name``, ``endpoint``
    (and, for API routes, ``dependant``), including every included router's."""
    routes = list(getattr(app, "routes", None) or [])
    try:
        from fastapi.routing import iter_route_contexts  # FastAPI >= 0.142
    except ImportError:
        return routes
    return list(iter_route_contexts(routes))
