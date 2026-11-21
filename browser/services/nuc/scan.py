"""Reuse the panel's live outputs in the ordinary nuc scan, through FiberHMM's module registry.

The scan still runs its own units, tracks, exact tests, stitching and table writer. Only calibration and
molecule-wide outputs can be reused, and only with identical files, chemistry, read filters and settings.
"""
from __future__ import annotations

import copy
from collections import OrderedDict


def live_registry(state, plan, module):
    """A scan-local module factory, or None when the live outputs do not match this native scan.

    The factory shares a bounded record cache across units and their molecule-table passes. It runs in the
    browser process (window_jobs=1), where the decoded results already live; no giant molecule snapshots are
    copied into worker processes. This is an execution choice only, not a change to the scan plan.
    """
    if module['name'] != 'nuc' or plan['scope'] != 'view' or any(d.get('live_lift') for d in plan['datasets']):
        return None
    from fiberhmm.scan.modules.nuc import NucModule
    from fiberhmm.scan.reads import resolve_read_policy
    from .calibration import _from_cache
    from .inputs import nuc_source, real
    from .jobs import active_config
    from .store import MAX_RESULTS, STORE
    # The optimized unit adapter is equivalent to this module version; newer engines keep their own code.
    if str(NucModule.version) not in ('2.2', '2.3', '2.4'):
        return None

    settings = module['settings']
    if settings.get('calibration_scope') != 'data':
        return None
    if any(settings.get(k) is not None for k in ('nucpatch', 'nucgeo')):
        return None   # the live adapter writes regularity tiles but no patches or geometries
    filters = resolve_read_policy(plan['raw_read_policy'])['filters']
    sources, configs, calibrations, paths = {}, {}, {}, {}
    for d in plan['datasets']:
        source = nuc_source(state, d['browser_id'])
        if list(source.content_ids) != d['content_ids'] or source.chemistry != d['chemistry']:
            return None
        cfg = active_config(state, source.browser_id)
        from .calibration import calibration_filters
        if cfg is None or cfg.settings != settings or calibration_filters(cfg.policy['filters']) != calibration_filters(filters):
            return None
        # Only the data-scope cache identifies this exact set of input files. A bound scan's per-file
        # calibration may have been fitted to a larger pooled dataset and cannot replace this scan's fit.
        ref = _from_cache(source, module['settings_hash'], str(module['version']), filters)
        if ref is None:
            return None
        if any(cfg.config_for(p) != (ref.settings_hash, ref.digest) for p in source.paths):
            return None
        sid = d['dataset_id']
        sources[sid], configs[sid], calibrations[sid] = source, cfg, ref
        paths[sid] = tuple(real(p) for p in d['paths'])
    records = OrderedDict()
    by_path = {p: source for source in sources.values() for p in source.paths}

    class LiveNucModule(NucModule):
        from .scan_unit import run_unit

        def __init__(self):
            super().__init__()
            self._matching = {}

        def _iter_records(self, bam, chrom, start, end, filters):
            from .live import iter_view_records
            path = real(bam.filename.decode() if isinstance(bam.filename, bytes) else bam.filename)
            return iter_view_records(by_path[path], bam, chrom, start, end, {'filters': filters})

        def calibrate(self, inputs, units, settings, work, progress):
            if any(tuple(d.content_ids) != sources[d.dataset_id].content_ids or
                   tuple(real(p) for p in d.paths) != paths[d.dataset_id] or
                   d.chemistry != sources[d.dataset_id].chemistry for d in inputs.datasets):
                return super().calibrate(inputs, units, settings, work, progress)
            # Dataset labels name records; they do not enter population sampling or fitting. Relabel exactly
            # as NucModule.calibrate does when the same BAM is dataset_2 rather than the panel's dataset_1.
            first = next(iter(calibrations.values()))
            wrapper = {k: copy.deepcopy(v) for k, v in first.wrapper.items() if k not in ('datasets', 'regions')}
            wrapper.update(datasets={}, regions={})
            for sid, ref in calibrations.items():
                wrapper['datasets'][sid] = {**copy.deepcopy(ref.record), 'label': sid}
                wrapper['regions'][sid] = copy.deepcopy(ref.wrapper['regions'][ref.label])
            return wrapper

        def _record_outputs(self, read, record, settings, calibration):
            from fiberhmm.scan.types import Mark, MoleculeResult
            sid = record.dataset_id
            scope = (id(settings), id(calibration), sid)
            if scope not in self._matching:
                ref = calibrations.get(sid)
                self._matching[scope] = ref is not None and settings == module['settings'] and \
                    calibration.get('datasets', {}).get(sid) == {**ref.record, 'label': sid}
            if not self._matching[scope]:
                return super()._record_outputs(read, record, settings, calibration)
            key = (sid, record.input_index, record.record)
            if key in records:
                records.move_to_end(key)
                return records[key]
            path = paths[sid][record.input_index]
            sha, occ = record.record.rsplit(':', 1)
            cfg = configs[sid].config_for(path)
            hit = STORE.get_result(path, sha, int(occ), cfg)
            row = STORE.get(path, sha, int(occ)) if STORE.config_of(path) == cfg else None
            if hit is not None and row is not None:
                marks = [Mark(record, group, record.chrom, a, b, q, name, (ms, ml))
                         for group, rows in row.groups.items() for ms, ml, a, b, q, name in rows]
                # The scan writes nucreg (unless off); a live row has none (regularity is computed on demand), so
                # its tiles come from the regularity cache with the scan's parameters.
                reg = self._regularity(settings) if hasattr(self, '_regularity') else None
                if reg is not None and not row.groups.get('nucreg'):
                    from .regularity import tiles_for_row
                    marks += [Mark(record, 'nucreg', record.chrom, a, b, q, name, (ms, ml))
                              for ms, ml, a, b, q, name in tiles_for_row(path, sha, int(occ), row, reg, compute=True) or ()]
                value = (*hit, MoleculeResult(record, dict(row.scalars), marks))
            elif STORE.config_of(path) == cfg and STORE.failed(path, sha, int(occ)) is not None:
                value = (None, None, None)
            else:
                value = super()._record_outputs(read, record, settings, calibration)
            records[key] = value
            while len(records) > MAX_RESULTS:
                records.popitem(last=False)
            return value

    return {'nuc': LiveNucModule}
