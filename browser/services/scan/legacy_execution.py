"""Single-region legacy facades over the scan runner.

The browser owns evidence selection, reuse and curation. These adapters feed that
immutable population to the package modules instead of sampling the BAM again.
The registry is per invocation, and one unit runs in process (never in a pool).
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import tempfile


def native_inputs(state, request):
    """Return native BAM sources, or a reason the legacy adapter is still needed."""
    import pysam
    from services.lift.capability import is_lifted
    datasets = []
    has_records = False
    reference = None
    for dsid in request['dataset_ids']:
        ds = state.get_dataset(dsid)
        if getattr(ds, 'data_type', None) != 'bam' or is_lifted(ds):
            return None, 'Scan execution requires native BAM evidence'
        paths = getattr(ds, 'paths', None) or ds.path
        paths = [paths] if isinstance(paths, str) else list(paths)
        for path in paths:
            if '://' in str(path):
                return None, 'Remote evidence retains the browser loader'
            with pysam.AlignmentFile(path, 'rb') as bam:
                current = list(zip(bam.references, bam.lengths))
                if reference is not None and current != reference:
                    return None, 'Different BAM reference headers retain the browser loader'
                reference = current
                if request['chrom'] not in bam.references:
                    return None, 'Aliased coordinates retain the browser loader'
                sq = bam.header.to_dict().get('SQ', [])
                if any(s['SN'] == request['chrom'] and str(s.get('TP', '')).lower() == 'circular' for s in sq):
                    return None, 'Circular evidence retains the browser loader'
                has_records |= next(bam.fetch(request['chrom'], request['start'], request['end']), None) is not None
        datasets.append(dict(dataset_id=dsid, paths=paths,
                             chemistry=(request.get('chemistry_overrides') or {}).get(dsid)))
    if not has_records:
        return None, 'Prepared evidence has no corresponding BAM records'
    return datasets, None


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def _run(datasets, region, module, settings, adapter, out, progress, cancel=None):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.types import ScanUnit
    chrom, start, end = (region[k] for k in ('chrom', 'start', 'end'))
    unit = ScanUnit(f'{chrom}:{start}-{end}', chrom, start, end, start, end, 'bed', 0)
    # The module consumes the prepared population, whose digest and selection
    # receipt are part of settings. No scan-wide resampling is applied to it.
    try:
        return run_units(datasets, [unit], modules=[module], params={module: settings},
                         registry={module: lambda: adapter}, out=out, annotate=False,
                         units_info=dict(mode='bed', regions=[[chrom, start, end]]),
                         cores=1, window_jobs=1, progress=progress, cancel=cancel)
    except KeyboardInterrupt:
        if cancel is not None and cancel.is_set() and progress is not None:
            # Legacy progress callbacks raise their own job cancellation type.
            progress.report('cancelled', 'Cancelled')
        raise


def run_prepared(module, datasets, payload, parameters, out, progress, *, runner,
                 loader_parameters=None, classes=None, inputs=None, cancel=None):
    """Keep the legacy result/exports, and publish genuine module tables beside them."""
    from fiberhmm.scan.modules.fp import FpModule
    from fiberhmm.scan.modules.nfr import NfrModule
    from fiberhmm.inference.accessibility.workflow import NFROptions
    out = Path(out)
    captured = {}
    # Frozen reused populations stay immutable. A fresh SampledPayload retains
    # its package-owned top-up hook, which may load more records during fitting.
    payload = copy.deepcopy(payload)
    parameters = copy.deepcopy(parameters or {})
    receipt = dict(parameters=parameters, loader_parameters=loader_parameters,
                   evidence_sha256=_digest(payload), classes_sha256=_digest(classes), inputs=inputs)

    class PreparedFp(FpModule):
        def load_policy(self, settings):
            return dict(super().load_policy(settings), loader='browser.prepared_consensus_evidence',
                        evidence_sha256=receipt['evidence_sha256'])

        def resolve(self, params):
            resolved = super().resolve(params['parameters'])
            resolved['browser_population'] = receipt
            return resolved

        def run_unit(self, unit, scan_inputs, settings, calibration, upstream, work, sink):
            result = runner(payload, parameters, out, progress)
            captured['result'] = result
            return self.unit_result(unit, scan_inputs, payload, result, out)

    class PreparedNfr(NfrModule):
        # The original BAM may contain records excluded from this population.
        # Publish the engine's hit-bound states only; do not independently
        # manufacture whole-record scalar rows from those excluded records.
        wants_molecules = False

        def ma_groups(self):
            return [g for g in super().ma_groups() if g.kind != 'scalar']

        def load_policy(self, settings):
            return dict(super().load_policy(settings), loader='browser.prepared_nfr_evidence',
                        evidence_sha256=receipt['evidence_sha256'])

        # Supplied regions and class co-accessibility are legacy panel inputs.
        # NfrModule.unit_result still writes its variants and exact state calls.
        def resolve(self, params):
            return dict(nfr=NFROptions.from_params(parameters).as_dict(),
                        loader=loader_parameters or {}, use_fp_classes=False,
                        browser_population=receipt)

        def run_unit(self, unit, scan_inputs, settings, calibration, upstream, work, sink):
            result = runner(payload, parameters, out, progress, classes=classes, inputs=inputs)
            captured['result'] = result
            opt = NFROptions.from_params(parameters)
            return self.unit_result(unit, scan_inputs, payload, result, opt, out)

    adapter = PreparedFp() if module == 'fp' else PreparedNfr()
    scan_dir = out / 'execution-scan'
    _run(datasets, payload['region'], module, receipt, adapter, scan_dir, progress, cancel)
    if 'result' not in captured:
        raise ValueError('Scan found no source records for the prepared evidence')
    return captured['result'], str(scan_dir)


def run_peak_counts(datasets, region, numerator, total, n_reads, params, *, population=None):
    """Use PeaksModule's stitcher with the browser's filtered, sampled cohort.

    BED/view execution keeps the browser's row selection. Grid scans elsewhere
    use the package's records rule, per the owner decision.
    """
    import numpy as np
    from fiberhmm.scan.modules.peaks import PeaksModule
    from fiberhmm.scan.peaks_core import build_peak_thresholds, scan_signal_from_counts, smooth_scan_signal
    from fiberhmm.scan.types import UnitResult
    captured = {}

    class PreparedPeaks(PeaksModule):
        def load_policy(self, settings):
            return dict(super().load_policy(settings), loader='browser.prepared_peak_counts',
                        population=settings['browser_population'])

        def resolve(self, settings):
            resolved = super().resolve({k: v for k, v in settings.items() if k != 'browser_population'})
            resolved['browser_population'] = settings['browser_population']
            return resolved

        def run_unit(self, unit, inputs, settings, calibration, upstream, work, progress):
            ordinal = inputs.datasets[0].ordinal
            tracks = {f'num.{ordinal}': numerator, f'den.{ordinal}': total}
            if settings['tier_rule'] == 'window':
                tracks['nreads'] = np.full(len(total), n_reads, dtype=np.int64)
            return UnitResult(tracks=tracks, extra=dict(n_reads=n_reads))

        def stitch(self, *args, **kwargs):
            result = super().stitch(*args, **kwargs)
            captured['hits'] = result.hits
            return result

    settings = dict(params, row_rule='view', browser_population=dict(
        counts_sha256=hashlib.sha256(np.asarray([numerator, total]).tobytes()).hexdigest(),
        n_reads=n_reads, selection=population))
    with tempfile.TemporaryDirectory(prefix='fiberbrowser-peaks-scan-') as directory:
        _run(datasets, region, 'peaks', settings, PreparedPeaks(), directory, None)
    if 'hits' not in captured:
        raise ValueError('Scan found no source records for the prepared peak counts')
    hits = captured['hits']
    peaks, broad = [], []
    for hit in hits:
        row = dict(start=hit.start-region['start'], end=hit.end-region['start'],
                   layer=hit.columns['tier'], score=hit.score, threshold=hit.columns['threshold'])
        (peaks if hit.type == 'peaks.peak' else broad).append(row)
    thresholds = build_peak_thresholds(*(params[k] for k in (
        'threshold_strong', 'threshold_medium', 'threshold_weak', 'threshold_rare', 'min_reads')),
        n_reads, rule=params['tier_rule'])
    layer_info = [dict(layer=layer, threshold=threshold, label=label,
                       n_peaks=sum(p['layer'] == layer for p in peaks),
                       n_broad=sum(p['layer'] == layer for p in broad)) for layer, threshold, label in thresholds]
    signal = scan_signal_from_counts(numerator, total)
    return dict(peaks=peaks, broad=broad, layer_info=layer_info, thresholds=thresholds,
                smoothed=smooth_scan_signal(signal, params['smooth_width']))
