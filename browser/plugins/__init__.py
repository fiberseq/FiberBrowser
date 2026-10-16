from typing import Dict, Optional
from fastapi import APIRouter
from .context import AnalysisContext

_plugins: Dict[str, APIRouter] = {}
_context: Optional[AnalysisContext] = None


def register_plugin(name: str, router: APIRouter) -> None:
    """Register a plugin's API router."""
    _plugins[name] = router


def get_registered_plugins() -> Dict[str, APIRouter]:
    """Return all registered plugin routers."""
    return dict(_plugins)


def init_context(browser_state) -> None:
    """Initialize the shared AnalysisContext from BrowserState."""
    global _context
    _context = AnalysisContext(browser_state)


def get_context() -> AnalysisContext:
    """Get the shared AnalysisContext. Raises if not yet initialized."""
    if _context is None:
        raise RuntimeError("AnalysisContext not initialized — call init_context() first")
    return _context
