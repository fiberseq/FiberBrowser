"""3.1.0 audit fix: with a FiberHMM lacking fiberhmm.scan, the nucleosome panel's settings resolution (and so
/api/nuc/status) reports the panel unavailable, naming the FiberHMM version it needs, instead of raising."""
from __future__ import annotations

import sys

import pytest


@pytest.fixture
def no_scan_package(monkeypatch):
    from services.nuc import engine
    from services.scan import planning
    for name in [m for m in sys.modules if m == 'fiberhmm.scan' or m.startswith('fiberhmm.scan.')]:
        monkeypatch.delitem(sys.modules, name)
    for name in ('fiberhmm.scan', 'fiberhmm.scan.identity', 'fiberhmm.scan.modules', 'fiberhmm.scan.modules.nuc'):
        monkeypatch.setitem(sys.modules, name, None)     # import raises ModuleNotFoundError
    monkeypatch.setattr(engine, '_module', None)
    monkeypatch.setattr('services.fiberhmm_runtime.configure_fiberhmm_runtime', lambda strict=True: None)
    return engine


def test_resolve_settings_reports_unavailable_without_fiberhmm_scan(no_scan_package):
    engine = no_scan_package
    with pytest.raises(engine.NucUnavailable, match='3.2.2'):
        engine.resolve_settings(None)
    assert engine.available()['available'] is False


def test_status_route_answers_unavailable_without_fiberhmm_scan(no_scan_package):
    import asyncio
    from routers import nuc as nuc_router
    from state.browser_state import BrowserState
    out = asyncio.run(nuc_router.nuc_status({'datasets': ['ds0']}, state=BrowserState(None)))
    assert out['available'] is False and '3.2.2' in out['reason'] and out['datasets'] == []
