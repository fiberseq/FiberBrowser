"""Accessibility (preview): NFR variants and element co-accessibility, run by FiberHMM (EXPERIMENTAL).

The engine is FiberHMM's ``fiberhmm.inference.accessibility`` (the code behind ``fiberhmm-nfr``), called in-process
on the same evidence units Find classes uses (``consensus_workflow.load_payload`` with the lattice recaller's loader
options), so NFR variants and footprint classes of the same datasets join by unit_id. This module is the job
runner: submit / poll / cancel / list, one running job per session, read groups for the read panel, TSV exports,
and session freeze/restore. Source BAMs are never changed.
"""
from __future__ import annotations

import base64
import gzip
import json
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

from services.consensus_progress import finish_progress, update_progress

from services.scan.jobs import _EXECUTOR  # shared scan worker; legacy routes keep their job identities
_INIT_LOCK = threading.Lock()
SESSION_RUNS_SCHEMA = 'fiberbrowser.accessibility_runs.v1'
EXPORT_FILES = ('variants.tsv', 'configurations.tsv', 'molecules.tsv.gz', 'coaccess.tsv', 'combos.tsv', 'manifest.json', 'result.json')
MAX_SESSION_RUNS = 6
# Engine parameters the panel may set (FiberHMM NFROptions fields); anything else is refused.
PANEL_PARAMETERS = {
    'max_discovery_molecules': int, 'max_quantification_molecules': int, 'sample_seed': int,
    'stringency': float, 'mode': str, 'elements': str, 'internal_footprint_labels': bool, 'nfr_regions': list,
    'pairs': str, 'within_clusters': int, 'robust': int, 'min_gap_bp': int, 'support_nats': float, 'min_reads': float,
    'bootstrap': int, 'combo_elements': list, 'openness_pad_bp': int, 'detect_threshold': float, 'shift_bp': int,
    'open_threshold': float, 'clip_gaps_to_region': bool,
    # NFR region detection (FiberHMM's depth-aware enrichment rule; detect_threshold is the fixed rule's)
    'detect_method': str, 'min_fraction': float, 'detect_q': float, 'min_fold': float, 'min_open_reads': int,
}
# Panel parameters an older FiberHMM may not have, with the words the panel uses for them.
NEWER_PARAMETERS = {'clip_gaps_to_region': 'Count each gap toward one region only', 'detect_method': 'NFR detection method', 'min_fraction': 'Rarest NFR', 'detect_q': 'Detection q',
                    'min_fold': 'Fold over background', 'min_open_reads': 'Minimum open reads'}
NOT_AVAILABLE = ('The Accessibility preview needs FiberHMM with the experimental fiberhmm.inference.accessibility '
                 'engine (fiberhmm-nfr; the exp/fh-nfr preview build).')


class AccessibilityCancelled(Exception):
    pass


def _session(state):
    with _INIT_LOCK:
        if 'accessibility_jobs' not in state.__dict__:
            state.accessibility_jobs = {}
            state.accessibility_lock = threading.RLock()
    return state.accessibility_jobs, state.accessibility_lock


def _runtime():
    from services.fiberhmm_runtime import configure_fiberhmm_runtime, fiberhmm_install_help
    configured = configure_fiberhmm_runtime(strict=True)
    try:
        from fiberhmm.inference import accessibility
    except ImportError as error:
        raise ValueError(f'{NOT_AVAILABLE} ({error}). ' + fiberhmm_install_help(configured)) from error
    return accessibility


def schema():
    acc = _runtime()
    import dataclasses
    defaults = {f.name: (list(f.default) if isinstance(f.default, tuple) else f.default)
                for f in dataclasses.fields(acc.NFROptions)}
    return dict(schema=acc.SCHEMA, experimental=True, defaults=defaults, panel_parameters=sorted(PANEL_PARAMETERS),
                note=getattr(acc.workflow, 'EXPERIMENTAL_NOTE', '') if hasattr(acc, 'workflow') else '')


def engine_options(acc, params):
    """FiberHMM's NFROptions for the panel's parameters; a setting this FiberHMM does not have is said plainly."""
    import dataclasses
    known = {f.name for f in dataclasses.fields(acc.NFROptions)}
    missing = [n for n in params if n not in known]
    if missing:
        words = ', '.join(NEWER_PARAMETERS.get(n, n) for n in missing)
        raise ValueError(f'The FiberHMM this browser uses does not have the setting {words}: it finds NFRs with its older fixed '
                         'rule. Update FiberHMM (Settings > FiberHMM), or put the setting back to its default.')
    return acc.NFROptions.from_params(params)


def clean_parameters(params):
    """The panel's engine parameters, type-checked; unknown names are refused (no silent defaults)."""
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError('parameters must be an object')
    out = {}
    for name, value in params.items():
        kind = PANEL_PARAMETERS.get(name)
        if kind is None:
            raise ValueError(f'Unknown Accessibility parameter: {name}')
        if kind is bool:
            if not isinstance(value, bool):
                raise ValueError(f'{name} must be true or false')
        elif kind in (int, float):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f'{name} must be a number')
            if name in ('max_discovery_molecules', 'max_quantification_molecules', 'sample_seed') and (value < 0 or int(value) != value):
                raise ValueError(f'{name} must be a non-negative integer')
            value = kind(value)
        elif kind is str:
            if not isinstance(value, str):
                raise ValueError(f'{name} must be text')
        elif kind is list:
            if not isinstance(value, list):
                raise ValueError(f'{name} must be a list')
            if name == 'nfr_regions':
                value = [[int(a), int(b)] for a, b in (r if isinstance(r, (list, tuple)) else (r['start'], r['end']) for r in value)]
            else:
                value = [str(v) for v in value]
        out[name] = value
    return out


def _loader_options(request):
    """The options Find classes would load with (lattice recaller defaults, plus the panel's input settings)."""
    from fiberhmm.inference.consensus import parameters
    from fiberhmm.inference.consensus.regions import automatic_parameters
    from services.chemistry_metadata import dataset_consensus_chemistry
    loader = dict(request.get('loader_parameters') or {})
    allowed = {k: v for k, v in loader.items() if k in ('input', 'compute') and isinstance(v, dict)}
    strata = [dict(dataset_id=d, chemistry=request['chemistry_overrides'].get(d)) for d in request['dataset_ids']]
    automatic = automatic_parameters(allowed, strata)
    return parameters.parse_options(automatic), automatic


def _region_of(job):
    r = job.get('request') or {}
    return r.get('chrom'), r.get('start'), r.get('end')


def _class_job_mismatch(job, request, snapshot, loader_input, exact, recaller_mode, cr_mode, same_sources):
    """Why a Find classes run's molecules are not this run's ('' when they are): the first failing requirement."""
    req = job.get('request') or {}
    from services.signal_evidence import normalize_filters
    if normalize_filters(req.get('signal_filters')) != normalize_filters(request.get('signal_filters')):
        return 'other signal filters'
    if list(req.get('dataset_ids') or []) != list(request['dataset_ids']):
        return 'other datasets (or another order)'
    if cr_mode(job['result']) != recaller_mode:
        return 'another engine (the lattice recaller is needed)'
    chemistry = req.get('chemistry_overrides') or {}
    if any(chemistry.get(d) != (request.get('chemistry_overrides') or {}).get(d) for d in request['dataset_ids']):
        return 'another datatype'
    # Find classes stores its parameters after automatic_parameters, as _loader_options returns ours.
    if ((req.get('parameters') or {}).get('input') or {}) != (loader_input or {}):
        return 'other input settings'
    if exact:
        from services.read_depth import NAMES, depth_parameters
        previous = depth_parameters((req.get('parameters') or {}).get('recaller'), True)
        current = depth_parameters(request.get('parameters'), True)
        if any(previous.get(n) != current.get(n) for n in NAMES):
            return 'other read caps or sample seed'
        if job['result'].get('manifest', {}).get('loader_sampling'):
            return 'sampled input evidence'
    chrom, start, end = _region_of(job)
    if chrom != request['chrom'] or start is None:
        return 'another chromosome'
    if exact and not (start == request['start'] and end == request['end']):
        return 'another region'
    if not exact and not (start < request['end'] and end > request['start']):
        return 'a region that does not overlap'
    if not job.get('_snapshot') or not same_sources(job['_snapshot'], snapshot):
        return 'changed files'
    return ''


def _matching_class_job(state, request, snapshot, loader_input, *, exact, reasons=None):
    """The newest complete lattice-recaller Find classes run whose molecules are this run's: the same datasets in the
    same order (unit_id carries the dataset ordinal), the same chemistry, the same loader input settings and unchanged
    files; its region equal to the requested one (exact=True: its evidence is then this run's) or overlapping it.
    ``reasons`` (a list): filled with why each complete run does not match."""
    try:
        from services.consensus_workflow import _session as cons_session, _same_sources, RECALLER_MODE, _cr_mode
    except Exception:
        return None
    if 'consensus_workflow_jobs' not in state.__dict__:
        return None
    jobs, lock = cons_session(state)
    with lock:
        candidates = [j for j in jobs.values() if j.get('status') == 'complete' and j.get('result')]
        active = getattr(state, 'consensus_workflow_active', None)
    best = None
    for job in candidates:
        why = _class_job_mismatch(job, request, snapshot, loader_input, exact, RECALLER_MODE, _cr_mode, _same_sources)
        if why:
            if reasons is not None:
                reasons.append(why)
            continue
        rank = (job.get('job_id') == active, job.get('finished_at') or 0)
        if best is None or rank > best[0]:
            best = (rank, job)
    return best[1] if best else None


def _reused_payload(state, request, snapshot, loader_input):
    """The saved evidence of a Find classes run on exactly this region and these molecules: the same load, so it is
    reused as it is (a larger region would load different observations and duplicate groups, so it is not narrowed)."""
    job = _matching_class_job(state, request, snapshot, loader_input, exact=True)
    if job is None:
        return None, None
    path = Path(job.get('artifact_dir') or '') / 'evidence.json.gz'
    if not path.is_file():
        return None, None
    from fiberhmm.inference.consensus.artifacts import read_json
    payload = read_json(path)
    payload.pop('browser_sources', None)
    return payload, job['job_id']


def _class_elements(state, request, snapshot, loader_input, acc, preferred=None):
    """Footprint classes of a compatible Find classes run (the one whose evidence was reused, if any)."""
    job = None
    if preferred:
        from services.consensus_workflow import _session as cons_session
        jobs, lock = cons_session(state)
        with lock:
            job = jobs.get(preferred)
    job = job or _matching_class_job(state, request, snapshot, loader_input, exact=False)
    if job is None:
        return None, None
    directory = Path(job.get('artifact_dir') or '')
    if not (directory / 'classes.tsv').is_file() or not (directory / 'molecules.tsv.gz').is_file():
        return None, None
    return acc.load_recaller_classes(directory), job['job_id']


def submit(state, request):
    from services.signal_evidence import active_signal_filters
    request = {**request, "signal_filters": active_signal_filters()}
    acc = _runtime()
    from services.runtime import get_host_public_mode
    if get_host_public_mode():
        raise ValueError('The Accessibility preview is not available on public servers.')
    if not isinstance(request, dict):
        raise ValueError('Request must be an object')
    ids = request.get('dataset_ids') or []
    if not isinstance(ids, list) or not ids or len(set(ids)) != len(ids):
        raise ValueError('Select one or more distinct datasets')
    from services.panel_genomes import mixed_references
    if mixed_references(state, ids):
        raise ValueError('These datasets are on different references. An Accessibility run covers one region of one reference: '
                         'run the datasets of each reference separately.')
    for dsid in ids:
        ds = state.get_dataset(dsid)
        if ds is None:
            raise ValueError(f'Dataset {dsid!r} is no longer open')
        if getattr(ds, 'data_type', 'bam') != 'bam':
            raise ValueError(f'{ds.label}: the Accessibility preview reads nucleosome calls and modifications from the BAM '
                             '(MM/ML and MA tags) through FiberHMM; BigBed datasets are not supported. Open the BAM.')
    if not isinstance(request.get('chrom'), str) or not request['chrom']:
        raise ValueError('Chromosome is required')
    if any(not isinstance(request.get(k), int) or isinstance(request[k], bool) for k in ('start', 'end')):
        raise ValueError('Integer half-open region required')
    params = clean_parameters(request.get('parameters'))
    import dataclasses
    from services.read_depth import NAMES, depth_parameters, machine_depth_parameters
    params = depth_parameters(machine_depth_parameters(state, params), set(NAMES) <= {f.name for f in dataclasses.fields(acc.NFROptions)})
    opt = engine_options(acc, params)              # validates values before anything runs
    from services.chemistry_metadata import dataset_consensus_chemistry
    request = {**request, 'parameters': params, 'dataset_ids': list(ids),
               'chemistry_overrides': {d: (request.get('chemistry_overrides') or {}).get(d) or
                                       dataset_consensus_chemistry(state.get_dataset(d)) for d in ids}}
    missing = [state.get_dataset(d).label for d in ids if request['chemistry_overrides'][d] not in ('ddda', 'dddb', 'hia5-pacbio', 'hia5-nanopore')]
    if missing:
        raise ValueError(f'{", ".join(missing)}: set the assay type first (the dataset setup card in the NFRs or Footprints panel); FiberHMM needs it to read the BAM.')
    options, loader_input = _loader_options(request)
    if getattr(state, 'performance', {}).get('effective') == 'low':
        values = {k: params[k] for k in NAMES if k in params}
        options['recaller'] = dataclasses.replace(options['recaller'], **values)
        loader_input['recaller'] = {**loader_input.get('recaller', {}), **values}
    if request['start'] < 0 or request['end'] <= request['start'] or request['end'] - request['start'] > options['compute'].maximum_region_bp:
        raise ValueError(f"Invalid region or longer than the {options['compute'].maximum_region_bp:,} bp analysis limit")
    given = params.get('nfr_regions') or []
    if given and not any(a < request['end'] and b > request['start'] for a, b in given):
        # A region carried over from another locus would find nothing, silently: say so instead.
        shown = ', '.join(f'{a:,}–{b:,}' for a, b in given)
        raise ValueError(f"The given NFR region ({shown}) is outside the view {request['chrom']}:{request['start']:,}–{request['end']:,}: "
                         'clear it (NFRs, beside Find) to detect NFRs here, or go to it.')
    from services.consensus_workflow import _snapshot
    snapshot = _snapshot(state, ids)
    jobs, lock = _session(state)
    with lock:
        if any(j['status'] in ('queued', 'running', 'cancelling') for j in jobs.values()):
            raise ValueError('An Accessibility run is already running in this session; cancel it or wait')
        job_id = uuid.uuid4().hex
        out = Path(tempfile.mkdtemp(prefix='fiberbrowser-accessibility-'))
        job = dict(job_id=job_id, status='queued', stage='queued', message='Waiting for the Accessibility worker', created_at=time.time(),
                   request=request, artifact_dir=str(out), _cancel=threading.Event(), _snapshot=snapshot, experimental=True,
                   parameters=opt.as_dict())
        jobs[job_id] = job

    def worker():
        from services.background_work import configure_worker_threads
        configure_worker_threads()
        try:
            def progress(stage, message=None, **work):
                if job['_cancel'].is_set():
                    raise AccessibilityCancelled('Cancelled')
                with lock:
                    job.setdefault('started_at', time.time())
                    if job['status'] != 'cancelling':
                        job['status'] = 'running'
                    update_progress(job, stage, message, **work)
            progress.report = progress
            progress('loading', 'Loading molecules through FiberHMM')
            payload, reused = _reused_payload(state, request, snapshot, loader_input.get('input'))
            if payload is None:
                from services.consensus_workflow import load_payload
                payload = load_payload(state, request, options, progress)
                payload.pop('browser_warnings', None)
            with lock:
                job['payload_source'] = f'reused from Find classes run {reused[:8]}' if reused else 'loaded'
            if not any(s['units'] for s in payload['strata']):
                raise ValueError('No molecules in this region. Check the chromosome, coordinates and datatype.')
            classes, class_job = _class_elements(state, request, snapshot, loader_input.get('input'), acc, preferred=reused)
            if class_job:
                with lock:
                    job['class_job_id'] = class_job
            progress('nfr', 'Finding NFR variants')
            inputs = dict(browser_sources=snapshot, loader_parameters=loader_input, payload_source=job.get('payload_source'),
                          class_job=class_job)
            from services.scan.legacy_execution import native_inputs, run_prepared
            scan_inputs, reason = native_inputs(state, request)
            if scan_inputs:
                result, execution_scan = run_prepared('nfr', scan_inputs, payload, params, out, progress,
                    runner=acc.run_accessibility, loader_parameters=loader_input, classes=classes,
                    inputs=inputs, cancel=job['_cancel'])
                with lock:
                    job.update(execution_engine='scan:nfr', execution_scan=execution_scan)
            else:
                with lock:
                    job.update(execution_engine='legacy', execution_note=reason)
                result = acc.run_accessibility(payload, params, out, progress, classes=classes, inputs=inputs)
            with lock:
                if job['_cancel'].is_set():
                    raise AccessibilityCancelled('Cancelled before the result was installed')
                from services.consensus_workflow import _same_sources
                if not _same_sources(job['_snapshot'], _snapshot(state, ids)):
                    raise ValueError('Input datasets changed during the run; the result was not installed')
                job['result'] = result
                job.update(status='complete', stage='complete', message='NFR variants ready', finished_at=time.time())
                finish_progress(job)
        except AccessibilityCancelled as exc:
            with lock:
                job.update(status='cancelled', message=str(exc), finished_at=time.time())
        except Exception as exc:
            import traceback
            traceback.print_exc()
            with lock:
                job.update(status='error', message=str(exc), error_type=type(exc).__name__, finished_at=time.time())
    import contextvars
    job['_future'] = _EXECUTOR.submit(contextvars.copy_context().run, worker)
    return _summary(job)


def _summary(job, *, with_result=True):
    out = {k: v for k, v in job.items() if not k.startswith('_') and k not in ('result',)}
    if with_result and job.get('result') is not None:
        out['result'] = {k: v for k, v in job['result'].items() if k not in ('molecules', 'element_states')}
    return out


def get_job(state, job_id):
    jobs, lock = _session(state)
    with lock:
        if job_id not in jobs:
            raise KeyError(job_id)
        return _summary(jobs[job_id])


def run_name(state, job_id):
    """The run's one short name, as the browser says it: "NFR run 2 · 6 Oct 14:02" (its order in this session by start
    time, and the start time); the id stays out of the visible text."""
    jobs, lock = _session(state)
    with lock:
        ordered = sorted(jobs.values(), key=lambda j: j.get('created_at') or 0)
        n = next((i + 1 for i, j in enumerate(ordered) if j.get('job_id') == job_id), None)
        created = (jobs.get(job_id) or {}).get('created_at')
    if n is None:
        return f"NFR run {str(job_id)[:4]}…"
    if not created:
        return f"NFR run {n}"
    t = time.localtime(created)
    return f"NFR run {n} · {t.tm_mday} {time.strftime('%b %H:%M', t)}"


def list_jobs(state):
    jobs, lock = _session(state)
    with lock:
        return dict(jobs=[_summary(j, with_result=False) for j in sorted(jobs.values(), key=lambda j: j.get('created_at') or 0)])


def cancel(state, job_id):
    jobs, lock = _session(state)
    with lock:
        job = jobs[job_id]
        if job['status'] in ('queued', 'running', 'cancelling'):
            job['_cancel'].set()
            job.update(status='cancelling', message='Cancelling at the next checkpoint', updated_at=time.time())
        return _summary(job, with_result=False)


def _complete(state, job_id):
    jobs, lock = _session(state)
    with lock:
        job = jobs[job_id]
        if job.get('status') != 'complete' or not job.get('result'):
            raise ValueError('Only a completed Accessibility run has results')
        return job


def _names(record):
    names = [record.get('read_name')] + list(record.get('members') or [])
    return [n for n in dict.fromkeys(names) if n]


def read_groups(state, job_id, nfr_id):
    """Reads of one NFR grouped by their most likely configuration (closed, V1, V1+V3, other...), per dataset, for
    the read panel's "Group reads by NFR variant". Edge-censored reads are not grouped."""
    job = _complete(state, job_id)
    result = job['result']
    nfr = next((n for n in result['nfrs'] if n['id'] == nfr_id), None)
    if nfr is None:
        raise ValueError(f'No NFR {nfr_id!r} in this run')
    labels = [c['label'] for c in nfr.get('configurations') or []]
    names_of = {}          # (dataset, read name) -> configurations of the molecules carrying that name
    for _uid, m in sorted(result['molecules'].items()):
        rec = (m.get('nfr') or {}).get(nfr_id)
        if not rec or rec.get('status') != 'callable' or not rec.get('map'):
            continue
        for name in _names(m):
            names_of.setdefault((m['dataset'], name), set()).add(rec['map'])
    # A name whose molecules (the same QNAME in two merged BAMs, repeated alignments) disagree is left out and
    # reported, as Find classes does: the read panel groups by name.
    by_dataset, counts, ambiguous = {}, {}, {}
    for (dataset, name), found in sorted(names_of.items()):
        if len(found) > 1:
            ambiguous[dataset] = ambiguous.get(dataset, 0) + 1
            continue
        label = next(iter(found))
        if label not in labels:
            labels.append(label)
        counts[label] = counts.get(label, 0) + 1
        by_dataset.setdefault(dataset, {})[name] = label
    present = [l for l in labels if counts.get(l)]
    # A single-variant configuration (V2) is cluster 1 (the k-th variant: k - 1), so its reads take the variant's
    # colour in the read panels (the panel draws variant k in cluster colour k - 1); the rest follow.
    names = [v['name'] for v in nfr.get('variants') or []]
    index = {l: names.index(l) for l in present if l in names}
    for l in present:
        if l not in index:
            index[l] = max(list(index.values()) + [len(names) - 1]) + 1
    display = {c['label']: c.get('display_label') or c['label'] for c in nfr.get('configurations') or []}
    variants = [dict(name=v['name'], start=v['L'], end=v['R']) for v in nfr.get('variants') or []]
    return dict(job_id=job_id, nfr=nfr_id, variants=variants,
                groups=[dict(id=index[l], label=l, display_label=display.get(l, l), count=counts[l],
                             pattern=[int(v['name'] in l.split('+')) for v in variants]) for l in present],
                by_dataset={d: {n: index[l] for n, l in names.items()} for d, names in by_dataset.items()},
                ambiguous_reads=ambiguous, counts='read names (duplicate members included)')


def element_reads(state, job_id, element_id, minimum=0.5):
    """Read names (per dataset) open for one NFR element: P(variant in configuration) >= minimum."""
    job = _complete(state, job_id)
    nfr_id, _, name = str(element_id).partition(':')
    verdict = {}
    for _uid, m in job['result']['molecules'].items():
        rec = (m.get('nfr') or {}).get(nfr_id)
        if not rec or rec.get('status') != 'callable':
            continue
        p = (rec.get('p') or {}).get(name)
        if p is None and name == 'open':
            p = 1.0 if rec.get('gaps') else 0.0
        if p is None:
            continue
        for read in _names(m):
            verdict.setdefault((m['dataset'], read), set()).add(p >= minimum)
    out, ambiguous = {}, {}
    for (dataset, read), found in verdict.items():
        if found == {True}:
            out.setdefault(dataset, []).append(read)
        elif len(found) > 1:
            ambiguous[dataset] = ambiguous.get(dataset, 0) + 1
    return dict(job_id=job_id, element=element_id, minimum=minimum, by_dataset={d: sorted(v) for d, v in out.items()},
                ambiguous_reads=ambiguous)


def export_path(state, job_id, name):
    if name not in EXPORT_FILES:
        raise ValueError(f'Unknown export {name!r}')
    job = _complete(state, job_id)
    path = Path(job['artifact_dir']) / name
    if not path.is_file():
        _rewrite_outputs(job)
    if not path.is_file():
        raise ValueError(f'{name} is not available for this run')
    return path


def _rewrite_outputs(job):
    """Restored runs carry the result, not the files: write them again with the engine's own writer."""
    try:
        from fiberhmm.inference.accessibility.workflow import write_outputs
    except ImportError:
        return
    out = Path(job.get('artifact_dir') or tempfile.mkdtemp(prefix='fiberbrowser-accessibility-'))
    job['artifact_dir'] = str(out)
    write_outputs(job['result'], out, None, dict(restored_from_session=True))
    # The writer is deterministic, so the data files are the original run's; its manifest (inputs, loader, version)
    # comes back as it was saved.
    if job.get('_manifest'):
        (out / 'manifest.json').write_text(job['_manifest'])


# ------------------------------------------------------------------ sessions
def export_session_runs(state, frontend=None):
    if 'accessibility_jobs' not in state.__dict__:
        return None
    jobs, lock = _session(state)
    runs = []
    with lock:
        done = sorted((j for j in jobs.values() if j.get('status') == 'complete' and j.get('result')),
                      key=lambda j: j.get('finished_at') or 0)[-MAX_SESSION_RUNS:]
        for job in done:
            try:
                manifest = job.get('_manifest')
                if manifest is None and job.get('artifact_dir') and (Path(job['artifact_dir']) / 'manifest.json').is_file():
                    manifest = (Path(job['artifact_dir']) / 'manifest.json').read_text()
                blob = gzip.compress(json.dumps(dict(result=job['result'], request=job.get('request'), message=job.get('message'),
                                                     payload_source=job.get('payload_source'), class_job_id=job.get('class_job_id'),
                                                     finished_at=job.get('finished_at'), manifest=manifest),
                                                separators=(',', ':')).encode(), compresslevel=6)
            except Exception:
                import traceback
                traceback.print_exc()
                continue
            runs.append(dict(job_id=job['job_id'], sources=job.get('_snapshot'), payload_gz_b64=base64.b64encode(blob).decode('ascii')))
    return dict(schema=SESSION_RUNS_SCHEMA, runs=runs) if runs else None


def session_run_ids(session):
    block = (session or {}).get('accessibility_runs')
    if not isinstance(block, dict) or block.get('schema') != SESSION_RUNS_SCHEMA:
        return set()
    return {str(r.get('job_id')) for r in block.get('runs') or [] if isinstance(r, dict) and r.get('job_id')}


def dispose_session(state, keep_job_ids=()):
    if 'accessibility_jobs' not in state.__dict__:
        return
    from lab.services.accessibility_analysis import dispose_transfers
    dispose_transfers(state)
    jobs, lock = _session(state)
    with lock:
        keep = {j for j in keep_job_ids if jobs.get(j, {}).get('status') == 'complete'}
        dropped = [j for k, j in jobs.items() if k not in keep]
        for j in dropped:
            if j.get('_cancel') is not None:
                j['_cancel'].set()
        for k in [k for k in jobs if k not in keep]:
            jobs.pop(k)
    dirs = [j.get('artifact_dir') for j in dropped if j.get('artifact_dir')]
    futures = [j.get('_future') for j in dropped if j.get('_future') is not None]

    def cleanup():
        for fut in futures:
            try:
                fut.result(timeout=3600)
            except Exception:
                pass
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)
    threading.Thread(target=cleanup, name='accessibility-session-cleanup', daemon=True).start()


MAX_RUN_COMPRESSED = 64*1024**2
MAX_RUN_EXPANDED = 512*1024**2


def _decode_run(run):
    """A saved run's payload, with bounded base64 and gzip sizes (a session file is untrusted input)."""
    text = run.get('payload_gz_b64')
    if not isinstance(text, str) or len(text) > MAX_RUN_COMPRESSED*4//3 + 16:
        raise ValueError('the saved run is missing or too large')
    raw = base64.b64decode(text, validate=True)
    import io
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as fh:
        data = fh.read(MAX_RUN_EXPANDED + 1)
    if len(data) > MAX_RUN_EXPANDED:
        raise ValueError('the saved run expands beyond the size limit')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('the saved run is not an object')
    return value


def restore_session_runs(state, session):
    """Bring back the session's Accessibility runs under their own ids once its datasets are open again."""
    block = (session or {}).get('accessibility_runs')
    if not isinstance(block, dict) or block.get('schema') != SESSION_RUNS_SCHEMA:
        return [], []
    from services.consensus_workflow import _same_session_sources, _snapshot
    jobs, lock = _session(state)
    restored, problems = [], []
    runs = [r for r in block.get('runs') or [] if isinstance(r, dict)]
    if len(runs) > MAX_SESSION_RUNS:
        problems.append(f'{len(runs) - MAX_SESSION_RUNS} Accessibility runs beyond the {MAX_SESSION_RUNS} a session keeps were skipped')
        runs = runs[-MAX_SESSION_RUNS:]
    for run in runs:
        job_id = str(run.get('job_id') or '')
        if not job_id:
            continue
        with lock:
            present = jobs.get(job_id)
        if present is not None and present.get('status') == 'complete':
            # Kept through the import (the same session reopened): still only if its files are the open ones.
            try:
                ids = list((present.get('request') or {}).get('dataset_ids') or [])
                if _same_session_sources(run.get('sources'), _snapshot(state, ids)):
                    restored.append(job_id); continue
            except Exception:
                pass
            with lock:
                jobs.pop(job_id, None)
        try:
            saved = _decode_run(run)
            request = saved.get('request') or {}
            ids = list(request.get('dataset_ids') or [])
            if not ids or not isinstance(saved.get('result'), dict) or not isinstance(saved['result'].get('molecules'), dict):
                raise ValueError('the saved run is incomplete')
            current = _snapshot(state, ids)
            if not _same_session_sources(run.get('sources'), current):
                raise ValueError('its source files changed or are not open')
            job = dict(job_id=job_id, status='complete', stage='complete', message=saved.get('message') or 'Restored with the session',
                       request=request, result=saved['result'], _snapshot=current, experimental=True,
                       parameters=saved['result'].get('parameters'), payload_source=saved.get('payload_source'),
                       class_job_id=saved.get('class_job_id'), finished_at=saved.get('finished_at'), restored=True,
                       _manifest=saved.get('manifest') if isinstance(saved.get('manifest'), str) else None,
                       artifact_dir=tempfile.mkdtemp(prefix='fiberbrowser-accessibility-'))
            finish_progress(job)
            with lock:
                jobs[job_id] = job
            restored.append(job_id)
        except Exception as error:
            problems.append(f'Accessibility run {job_id[:8]}: {error}')
    return restored, problems
