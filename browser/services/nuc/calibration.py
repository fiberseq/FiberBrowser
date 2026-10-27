"""The calibration record a dataset's nucleosome outputs are computed with (NUC §4, §5.2).

Order of preference for a browser dataset and nuc settings:

1. **A bound open scan's record** (``<scan>/nuc/extra/calibration.json``, the scan dataset bound to the browser
   dataset) when the scan's nuc module has the same version and settings hash and the same read filters. Live
   outputs then equal that scan's rows record for record.
2. **The browser's calibration cache** (``<scan cache>/nuc_calibration/<key>.json``), keyed by the dataset's file
   content ids, chemistry, read filters, nuc version and settings hash.
3. **Computed** by ``NucModule.calibrate`` with ``calibration_scope = 'data'`` (the default), the call
   ``fiberhmm-scan`` makes: the population is drawn from fixed 50 kb windows of the dataset's own data in a stable
   hash order, so it never depends on the view, the plan or the tiling. The record is stored in the cache, with
   its content (not an id), so a session restored elsewhere recomputes the same record.

A record is ``{'schema': 'fiberhmm.nuc.scan_calibration.v1', 'source', 'scope', 'regions', 'datasets': {label:
NucCalibration dict}}``; the browser computes it for one dataset labelled ``dataset_1`` (a label only names the
record; per-dataset numbers do not depend on it).
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .inputs import NucSource

CAL_SCHEMA = 'fiberhmm.nuc.scan_calibration.v1'
LABEL = 'dataset_1'
_compute_lock = threading.Lock()


@dataclass
class CalibrationRef:
    wrapper: dict                    # the scan-calibration record
    label: str                       # the dataset's key in ``wrapper['datasets']``
    source: str                      # 'scan' | 'cache' | 'computed'
    settings_hash: str
    version: str
    scan_id: Optional[str] = None
    path: Optional[str] = None
    _cal: object = field(default=None, repr=False, compare=False)

    @property
    def record(self) -> dict:
        return self.wrapper['datasets'][self.label]

    @property
    def calibration(self):
        """The dataset's ``NucCalibration`` (parsed once)."""
        if self._cal is None:
            from fiberhmm.nuc.calibration import NucCalibration
            self._cal = NucCalibration.from_dict(self.record)
        return self._cal

    @property
    def digest(self) -> str:
        return hashlib.sha256(json.dumps(self.record, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def summary(self) -> dict:
        rec = self.record
        return dict(source=self.source, scanId=self.scan_id, scope=self.wrapper.get('scope'),
                    method=self.wrapper.get('source'), digest=self.digest[:16], settingsHash=self.settings_hash,
                    version=self.version, nrlPooled=rec.get('nrl_pooled'), lambdaFloor=rec.get('lambda_floor'),
                    supported=rec.get('supported'), absolute=bool(rec.get('absolute')),
                    regions=len((self.wrapper.get('regions') or {}).get(self.label) or []))


def cache_dir() -> Path:
    from services.scan.planning import cache_root
    return cache_root() / 'nuc_calibration'


def cache_key(source: NucSource, filters: dict, settings_hash: str, version: str) -> str:
    raw = json.dumps(dict(content_ids=list(source.content_ids), chemistry=source.chemistry, filters=filters,
                          version=version, settings=settings_hash, scope='data'), sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _from_scan(state, source: NucSource, settings_hash: str, version: str, filters: dict) -> Optional[CalibrationRef]:
    from services.scan.registry import _inside, list_scans
    scans = sorted(list_scans(state), key=lambda s: (s.source != 'opened', s.opened_at))
    for scan in scans:
        block = scan.module('nuc')
        if not block or block.get('settings_hash') != settings_hash or str(block.get('version')) != version:
            continue
        if ((scan.manifest.get('read_policy') or {}).get('filters') or {}) != filters:
            continue
        sids = scan.datasets_of_browser(source.browser_id)
        if not sids:
            continue
        rel = (block.get('calibration') or {}).get('path') if isinstance(block.get('calibration'), dict) else None
        p = _inside(scan.path, rel or 'nuc/extra/calibration.json')
        if p is None or not p.is_file():
            continue
        try:
            wrapper = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if wrapper.get('schema') != CAL_SCHEMA:
            continue
        for sid in sids:
            if sid in (wrapper.get('datasets') or {}):
                return CalibrationRef(wrapper, sid, 'scan', settings_hash, version, scan_id=scan.scan_id, path=str(p))
    return None


def _from_cache(source: NucSource, settings_hash: str, version: str, filters: dict) -> Optional[CalibrationRef]:
    p = cache_dir() / f'{cache_key(source, filters, settings_hash, version)}.json'
    if not p.is_file():
        return None
    try:
        wrapper = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    if wrapper.get('schema') != CAL_SCHEMA or LABEL not in (wrapper.get('datasets') or {}):
        return None
    return CalibrationRef(wrapper, LABEL, 'cache', settings_hash, version, path=str(p))


def find_calibration(state, source: NucSource, settings_hash: str, version: str, filters: dict) -> Optional[CalibrationRef]:
    """A stored record for the dataset (a bound scan's, else the cache's), or None."""
    return _from_scan(state, source, settings_hash, version, filters) or \
        _from_cache(source, settings_hash, version, filters)


def compute_calibration(source: NucSource, settings: dict, settings_hash: str, version: str, policy: dict, *,
                        cores: int = 1, progress=None, cancel=None) -> CalibrationRef:
    """``NucModule.calibrate`` for one dataset (scope 'data'), stored in the cache. ``policy``: the resolved read
    policy (its filters select the population, as a scan's)."""
    from fiberhmm.scan.types import Dataset, ScanInputs
    from .engine import nuc_module
    from .inputs import reference_of
    mod = nuc_module()
    if settings.get('calibration_scope', 'data') != 'data':
        raise ValueError("The browser calibrates nuc with calibration_scope 'data' (independent of the view)")
    reference = reference_of(source.paths)
    ds = Dataset(LABEL, 0, source.chemistry, tuple(source.paths), tuple(source.content_ids))
    inputs = ScanInputs(datasets=(ds,), read_policy=policy, reference=reference, plan=(), cores=max(1, int(cores)))

    class _P:
        def report(self, stage, message, **work):
            if cancel is not None and cancel.is_set():
                raise InterruptedError('cancelled')
            if progress is not None:
                progress(str(message))

    with _compute_lock, tempfile.TemporaryDirectory(prefix='fiberbrowser-nuc-cal-') as work:
        wrapper = mod.calibrate(inputs, (), settings, Path(work), _P())
    if wrapper is None:
        raise ValueError('The nuc module returned no calibration')
    out = cache_dir()
    out.mkdir(parents=True, exist_ok=True)
    path = out / f'{cache_key(source, policy.get("filters") or {}, settings_hash, version)}.json'
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(wrapper, sort_keys=True, separators=(',', ':')))
    os.replace(tmp, path)
    return CalibrationRef(wrapper, LABEL, 'computed', settings_hash, version, path=str(path))
