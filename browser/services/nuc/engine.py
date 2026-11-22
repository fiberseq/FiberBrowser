"""FiberHMM's ``nuc`` scan module as the browser uses it: availability, settings, settings hash.

The browser resolves nuc settings exactly as ``fiberhmm-scan`` does (``NucModule.resolve``), so a calibration or
a record's outputs computed here carry the scan's ``settings_hash`` and match a scan made with the same settings.
"""
from __future__ import annotations

import copy
import threading
from typing import Optional, Tuple

MODULE = 'nuc'
_lock = threading.Lock()
_module = None


#: what the panel needs (FiberHMM's nuc scan module and its live-panel API)
REQUIRES = ('The nucleosome panel needs FiberHMM 3.2.2 or later (the nuc scan module, '
            'fiberhmm.scan.modules.nuc)')


class NucUnavailable(ValueError):
    """FiberHMM (or its nuc module) is not importable here."""


def nuc_module():
    """FiberHMM's ``NucModule`` (configured the way inference is), or ``NucUnavailable``.

    Only its declarations, ``resolve`` and ``calibrate`` are used: per-record outputs are computed by
    ``services.nuc.live`` with decode contexts of its own (the module caches contexts by dataset label)."""
    global _module
    from services.scan.planning import ScanPlanError, scan_engine
    try:
        scan_engine()
    except ScanPlanError as error:
        # no fiberhmm.scan at all: name the version the panel needs; a runtime problem keeps its own message
        raise NucUnavailable(REQUIRES if 'fiberhmm.scan' in str(error) else str(error)) from None
    with _lock:
        if _module is None:
            try:
                from fiberhmm.scan.modules.nuc import NucModule
            except ImportError:
                raise NucUnavailable(REQUIRES) from None
            _module = NucModule()
        return _module


def module_version() -> str:
    return str(nuc_module().version)


def resolve_settings(params: Optional[dict] = None) -> Tuple[dict, str]:
    """(settings, settings_hash) for nuc parameters (``fiberhmm-scan --parameters``' ``nuc`` group)."""
    mod = nuc_module()          # the availability guard first: an older FiberHMM has no fiberhmm.scan at all
    try:
        from fiberhmm.scan.identity import settings_hash
    except ImportError:
        raise NucUnavailable(REQUIRES) from None
    params = copy.deepcopy(params or {})
    # The regularity layer's parameters are the panel's own (services/nuc/regularity.py), as are the patch and
    # geometry parameters (services/nuc/nucgeo.py): they never enter the settings hash or the calibration, so a
    # change of them recomputes only the tiles or patches.
    if isinstance(params, dict):
        for key in ('nucreg', 'nucpatch', 'nucgeo'):
            params.pop(key, None)
    try:
        settings = mod.resolve(params)
    except ValueError as error:
        raise NucUnavailable(f'nuc settings: {error}') from None
    return settings, settings_hash(settings)


def nuc_params(settings: dict):
    from fiberhmm.nuc.params import NucParams
    return NucParams.from_dict(settings.get('params') or {})


def available() -> dict:
    try:
        mod = nuc_module()
    except NucUnavailable as error:
        return dict(available=False, reason=str(error))
    import fiberhmm
    settings, sh = resolve_settings({})
    return dict(available=True, fiberhmm=getattr(fiberhmm, '__version__', None), version=str(mod.version),
                experimental=bool(mod.experimental), settingsHash=sh,
                types=[t.type_id for t in mod.feature_types()],
                defaults={k: settings[k] for k in ('calibration', 'groups', 'enrich_fdr', 'phase_window_bp')})
