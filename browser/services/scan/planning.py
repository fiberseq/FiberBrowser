"""What a live scan computes, and the fiberhmm-scan command that computes the same.

A live scan always reads **files** (never payloads the browser built) through ``fiberhmm.scan.run_units``, the
entry point the CLI uses, so a browser scan equals a CLI scan given the same inputs, read policy, settings and
units (DESIGN §4.2). This module fixes each of those the same way the CLI would:

- **Datasets** in canonical order (sorted by their files' content ids, FiberHMM's ordinal), labelled
  ``dataset_1``, ``dataset_2``... in that order: exactly what ``fiberhmm-scan --bam A --bam B`` labels them when
  the BAMs are listed in that order, which is the order the command line shows. Chemistry is left to FiberHMM
  (read from the BAM) unless the user chose one in this session (``--chemistry``).
- **Read policy**: FiberHMM's defaults (MAPQ filter off, secondary and duplicate records out, supplementaries in),
  duplicates in when the reads panel shows them, and the depth caps: the machine cap Find classes applies in
  Low-memory mode (``read_depth.machine_depth_parameters``) or explicit caps from the scan dialog.
- **Units**: scope ``view`` takes the genome grid's units (``plan(genome=True, contigs=[chrom])``: 50 kb units
  owning their central 25 kb) whose zones meet the view, plus one more on each side; ``bed`` a BED file;
  ``genes`` a BED of TSS +/- ``flank``; ``regions`` one unit per window (Find classes' window).
- **Settings**: each module's defaults (``fiberhmm-scan --schema``), or the dialog's JSON (``--parameters``).

Execution-only controls (workers) never change a row and are not part of any key.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Sequence

VIEW_NEIGHBOURS = 1
DEFAULT_GENE_FLANK = 5_000
MAX_VIEW_UNITS = 64
MODULE_ORDER = ('peaks', 'fp', 'nfr', 'nuc')


class ScanPlanError(ValueError):
    """A scan request that cannot be planned (no FiberHMM scan engine, unsupported datasets, bad scope)."""


def scan_engine():
    """FiberHMM's scan package, configured the way inference is (paired source first), or a clear error."""
    from services.fiberhmm_runtime import configure_fiberhmm_runtime
    try:
        configure_fiberhmm_runtime(strict=True)
    except ValueError as error:
        raise ScanPlanError(str(error)) from None
    try:
        import fiberhmm.scan as scan  # noqa: F401
        from fiberhmm.scan import runner, units, reads, identity  # noqa: F401
        from fiberhmm.scan.modules import available_modules  # noqa: F401
    except ImportError:
        raise ScanPlanError('Live scans need FiberHMM with fiberhmm-scan (fiberhmm.scan, FiberHMM 3.1 or later). '
                            'Opening scan directories works without it.') from None
    return scan


def available() -> dict:
    """Whether live scans can run here, and which modules exist."""
    try:
        scan_engine()
    except ScanPlanError as error:
        return dict(available=False, reason=str(error), modules=[])
    from fiberhmm.scan.modules import available_modules, load_module
    import fiberhmm
    mods = []
    for name in available_modules():
        try:
            m = load_module(name)
        except Exception:   # a module whose engine is missing in this FiberHMM
            continue
        mods.append(dict(name=name, version=m.version, experimental=bool(m.experimental),
                         types=[t.type_id for t in m.feature_types()]))
    return dict(available=True, fiberhmm=getattr(fiberhmm, '__version__', None), modules=mods)


# ------------------------------------------------------------------ datasets and read policy
def _dataset_inputs(state, dataset_ids: Sequence[str]) -> List[dict]:
    """The scan's datasets in canonical order with labels dataset_<n>; refuses what a scan cannot read."""
    from utils.validation import is_url
    from .identity import content_id
    if not dataset_ids:
        raise ScanPlanError('Choose at least one dataset to scan')
    items = []
    for ds_id in dict.fromkeys(dataset_ids):
        ds = (getattr(state, 'datasets', None) or {}).get(ds_id)
        if ds is None:
            raise ScanPlanError(f'Dataset {ds_id!r} is not loaded')
        label = getattr(ds, 'label', ds_id)
        if getattr(ds, 'data_type', None) == 'bam_livelift':
            raise ScanPlanError(f'{label}: a live-lift dataset is scanned in its own assembly. Run fiberhmm-scan on its '
                                'BAM and open the scan here (its per-read states join the lifted rows); lifting a '
                                "scan's hits onto this genome comes later (G1)")
        if getattr(ds, 'data_type', None) != 'bam':
            raise ScanPlanError(f'{label}: scans read FiberHMM-called BAMs')
        paths = list(getattr(ds, 'paths', None) or [ds.path])
        if any(is_url(p) or str(p).startswith('ssh://') for p in paths):
            raise ScanPlanError(f'{label}: a remote BAM; scans read local files')
        meta = getattr(ds, 'chemistry_metadata', None) or {}
        chemistry = getattr(ds, 'consensus_chemistry', None) if meta.get('source') == 'user-selection' else None
        items.append(dict(browser_id=ds_id, label=label, paths=[str(p) for p in paths], chemistry=chemistry,
                          content_ids=[content_id(p) for p in paths]))
    items.sort(key=lambda x: (tuple(x['content_ids']), x['browser_id']))
    for i, x in enumerate(items, 1):
        x['dataset_id'] = f'dataset_{i}'
    return items


def read_policy(state, *, caps: Optional[dict] = None, include_duplicates: bool = False) -> dict:
    """The browser's read policy as fiberhmm-scan settings (``read_policy``), before FiberHMM fills defaults."""
    from services.read_depth import machine_depth_parameters
    policy: dict = {}
    if include_duplicates:
        policy['filters'] = {'duplicates': 'include'}
    chosen = {k: int(v) for k, v in (caps or {}).items()
              if k in ('max_discovery_molecules', 'max_quantification_molecules', 'sample_seed') and v not in (None, '')}
    perf = getattr(state, 'performance', None) or {}
    if perf.get('effective') == 'low':
        # Find classes' Low-memory cap (consensus_workflow.submit): the working-set cap on both molecule budgets.
        capped = machine_depth_parameters(state, {k: v for k, v in chosen.items() if k != 'sample_seed'})
        chosen.update({k: int(v) for k, v in capped.items() if k in ('max_discovery_molecules', 'max_quantification_molecules') and v})
    if chosen:
        policy['caps'] = chosen
    return policy


# ------------------------------------------------------------------ units
def _reference_of(paths: Sequence[str]) -> Dict[str, int]:
    import pysam
    with pysam.AlignmentFile(paths[0], 'rb', check_sq=False) as bam:
        return {n: int(l) for n, l in zip(bam.references, bam.lengths)}


def _resolve_chrom(reference: Dict[str, int], chrom: str) -> str:
    if chrom in reference:
        return chrom
    from utils.chrom import normalize_chrom_name
    want = normalize_chrom_name(chrom)
    for name in reference:
        if normalize_chrom_name(name) == want:
            return name
    raise ScanPlanError(f'{chrom} is not in the BAM header')


def view_units(reference: Dict[str, int], chrom: str, start: int, end: int, neighbours: int = VIEW_NEIGHBOURS):
    """Genome-grid units whose zones meet [start, end), plus ``neighbours`` more on each side, and the grid's info."""
    from fiberhmm.scan.units import plan
    units, info = plan(reference, genome=True, contigs=[chrom])
    hit = [i for i, u in enumerate(units) if u.zone_start < end and start < u.zone_end]
    if not hit:
        raise ScanPlanError(f'No scan unit meets {chrom}:{start:,}-{end:,}')
    lo, hi = max(0, hit[0] - neighbours), min(len(units) - 1, hit[-1] + neighbours)
    chosen = units[lo:hi + 1]
    if len(chosen) > MAX_VIEW_UNITS:
        raise ScanPlanError(f'The view needs {len(chosen)} units; zoom in, or scan a BED file or the genome with fiberhmm-scan')
    return list(chosen), info


def union_units(previous: Sequence, new: Sequence):
    """The cumulative grid plan of a browser scan directory: earlier units plus new ones, in genome order."""
    by_id = {u.unit_id: u for u in previous}
    for u in new:
        by_id.setdefault(u.unit_id, u)
    return sorted(by_id.values(), key=lambda u: u.index)


def _gene_bed(state, genes: Sequence[str], flank: int, out_dir: Path) -> Path:
    from services.files_endpoint import search_gene_payload
    rows, missing = [], []
    for g in genes:
        g = str(g).strip()
        if not g:
            continue
        hit = search_gene_payload(state, g)
        if not hit.get('found'):
            missing.append(g)
            continue
        tss = int(hit['tss'])
        rows.append((hit['chrom'], max(0, tss - flank), tss + flank, hit.get('gene_name') or g))
    if missing:
        raise ScanPlanError(f'Not in the loaded gene annotation: {", ".join(missing[:8])}')
    if not rows:
        raise ScanPlanError('Give at least one gene name')
    out_dir.mkdir(parents=True, exist_ok=True)
    text = ''.join(f'{c}\t{a}\t{b}\t{n}\n' for c, a, b, n in sorted(rows))
    path = out_dir / f'genes_{hashlib.sha256(text.encode()).hexdigest()[:12]}.bed'
    if not path.exists():
        path.write_text(text)
    return path


# ------------------------------------------------------------------ the plan
def cache_root() -> Path:
    env = os.environ.get('FIBERBROWSER_SCAN_CACHE_DIR')
    return Path(env).expanduser() if env else Path.home() / '.fiberhmm' / 'scan_cache'


def _digest(value, n=16) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()[:n]


def build_plan(state, request: dict) -> dict:
    """Everything a live scan needs: datasets, read policy, modules and settings, units, cache directories,
    coverage by open scans, and the equivalent command line. ``request``: {datasets, scope, chrom/start/end |
    bed | genes (+flank) | regions, modules, parameters?, caps?, include_duplicates?, workers?}."""
    scan_engine()
    from fiberhmm.scan import identity as I
    from fiberhmm.scan.reads import resolve_read_policy
    from fiberhmm.scan.runner import base_key, resolve_modules
    from fiberhmm.scan.units import plan as fh_plan
    datasets = _dataset_inputs(state, request.get('datasets') or [])
    params = copy.deepcopy(request.get('parameters') or {})
    if not isinstance(params, dict):
        raise ScanPlanError('Settings must be a JSON object of module groups')
    # As fiberhmm-scan: the parameter file's read_policy, with the browser's own controls (the dialog's caps, shown
    # duplicates, the Low-memory cap) on top, as the CLI's cap flags override the file.
    file_policy = params.pop('read_policy', None) or {}
    if not isinstance(file_policy, dict):
        raise ScanPlanError('Settings: read_policy must be an object')
    # Explicit caps (the file's, then the dialog's on top) come first; the Low-memory machine cap is only a ceiling
    # over them (it never raises a smaller explicit cap).
    explicit_caps = {**(file_policy.get('caps') or {}),
                     **{k: v for k, v in (request.get('caps') or {}).items() if v not in (None, '')}}
    browser_policy = read_policy(state, caps=explicit_caps, include_duplicates=bool(request.get('include_duplicates')))
    raw_policy = copy.deepcopy(file_policy)
    raw_policy.pop('caps', None)
    for key, value in browser_policy.items():
        raw_policy[key] = {**(raw_policy.get(key) or {}), **value} if isinstance(value, dict) else value
    try:
        policy = resolve_read_policy(raw_policy)
    except ValueError as error:
        raise ScanPlanError(str(error)) from None
    modules = [m for m in MODULE_ORDER if m in set(request.get('modules') or [])] + \
        [m for m in (request.get('modules') or []) if m not in MODULE_ORDER]
    if not modules:
        raise ScanPlanError('Choose at least one module')
    scope = request.get('scope') or 'view'
    if 'peaks' in modules and scope != 'view':
        # Owner, 26 Oct (DESIGN §16): FiberBrowser uses the local Rare rule, which doesn't depend on the view, and
        # counts every record. Grid units (the view scope) get it from FiberHMM's 'auto'; BED-like units would get
        # the window rule, so it is set explicitly (and shown on the command line). The window rule stays reachable
        # for one release: {"peaks": {"tier_rule": "window", "row_rule": "view"}}.
        peaks = dict(params.get('peaks') or {})
        peaks.setdefault('tier_rule', 'local')
        peaks.setdefault('row_rule', 'records')
        params = {**params, 'peaks': peaks}
    try:
        resolved_mods = resolve_modules(modules, params, dict(raw_policy.get('caps') or {}))
    except ValueError as error:
        raise ScanPlanError(str(error)) from None
    # Each module scans into its own cache directory, so a module subset never rewrites another module's
    # results (module subsets give the same rows per module, S1).
    for name, mod, settings in resolved_mods:
        if mod.needs(settings):
            raise ScanPlanError(f'{name} with these settings uses {", ".join(sorted(mod.needs(settings)))} results: '
                                'run it with fiberhmm-scan and open the scan here')
    reference = _reference_of(datasets[0]['paths'])
    contigs = list(reference.items())
    gene_dir = cache_root() / 'inputs'
    if scope == 'view':
        chrom = _resolve_chrom(reference, str(request.get('chrom') or ''))
        start, end = int(request.get('start') or 0), int(request.get('end') or 0)
        if end <= start:
            raise ScanPlanError('The view is empty')
        units, info = view_units(reference, chrom, start, end)
        cli_where = ['--genome', '--contigs', chrom]
        where_label = f'{len(units)} grid units (the view\'s and one more each side)'
    else:
        try:
            if scope == 'bed':
                bed = Path(str(request.get('bed') or '')).expanduser()
                if not bed.is_file():
                    raise ScanPlanError(f'BED file not found: {bed}')
                units, info = fh_plan(reference, bed=str(bed))
                cli_where = ['--bed', str(bed)]
            elif scope == 'genes':
                flank = int(request.get('flank') or DEFAULT_GENE_FLANK)
                bed = _gene_bed(state, request.get('genes') or [], flank, gene_dir)
                units, info = fh_plan(reference, bed=str(bed))
                cli_where = ['--bed', str(bed)]
            elif scope == 'regions':
                regions = [(_resolve_chrom(reference, str(r[0])), int(r[1]), int(r[2])) for r in request.get('regions') or []]
                if not regions:
                    raise ScanPlanError('Give at least one region')
                units, info = fh_plan(reference, regions=regions)
                cli_where = [x for c, a, b in regions for x in ('--region', f'{c}:{a}-{b}')]
            else:
                raise ScanPlanError(f'Unknown scope {scope!r} (view, bed, genes or regions)')
        except ValueError as error:
            if isinstance(error, ScanPlanError):
                raise
            raise ScanPlanError(str(error)) from None
        units = list(units)
        where_label = f'{len(units)} {"BED" if info.get("mode") == "bed" else "grid"} unit{"s" if len(units) != 1 else ""}'
    base_datasets = [(i, d['dataset_id'], d['chemistry'], d['content_ids']) for i, d in enumerate(datasets)]
    contigs_sha = I.contigs_sha256(contigs)
    module_plans = []
    for name, mod, settings in resolved_mods:
        sh = I.settings_hash(settings)
        key = _digest(dict(contigs=contigs_sha, datasets=base_datasets, policy=policy, mode=info.get('mode'),
                           grid=[info.get('unit_bp'), info.get('stride_bp'), info.get('grid_offset')],
                           plan=None if scope == 'view' else _digest([u.to_json() for u in units], 32),
                           module=name, version=mod.version, settings=sh))
        module_plans.append(dict(name=name, version=mod.version, settings_hash=sh, experimental=bool(mod.experimental),
                                 cache_dir=str(cache_root() / key), settings=settings))
    plan = dict(
        scope=scope, datasets=datasets, read_policy=policy, raw_read_policy=raw_policy, modules=module_plans,
        module_names=[m['name'] for m in module_plans], parameters=params, units=[u.to_json() for u in units],
        units_info=info, where=where_label, contigs_sha256=contigs_sha,
        workers=max(1, min(int(request.get('workers') or default_workers()), os.cpu_count() or 1)),
    )
    plan['coverage'] = coverage(state, plan)
    plan['cli'] = command_line(plan, cli_where)
    plan['signal_filters_note'] = _signal_note(state)
    return plan


def default_workers() -> int:
    return max(1, min(4, (os.cpu_count() or 2) // 2))


def _signal_note(state) -> Optional[str]:
    try:
        from services.signal_evidence import active_signal_filters
        if any(active_signal_filters(state).values()):
            return 'Signal filters are not applied by scans: fiberhmm-scan reads the whole BAM files'
    except Exception:
        pass
    return None


def _home_short(path: str) -> str:
    home = str(Path.home())
    return '~' + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def command_line(plan: dict, where: List[str]) -> dict:
    """The fiberhmm-scan command computing the same units with the same inputs, policy and settings."""
    def q(text: str) -> str:
        text = _home_short(str(text))
        return text if all(c.isalnum() or c in '/._-:~,=+' for c in text) else "'" + text.replace("'", "'\\''") + "'"
    args = ['fiberhmm-scan']
    chems = {d['chemistry'] for d in plan['datasets'] if d['chemistry']}
    # A dataset of several BAMs (or datasets of different chosen chemistries) needs --datasets: repeated --bam flags
    # would make each BAM a dataset of its own.
    grouped = any(len(d['paths']) > 1 for d in plan['datasets']) or len(chems) > 1 or \
        (chems and any(not d['chemistry'] for d in plan['datasets']))
    datasets_json = None
    if grouped:
        datasets_json = [dict(dataset_id=d['dataset_id'], paths=[_home_short(p) for p in d['paths']],
                              **({'chemistry': d['chemistry']} if d['chemistry'] else {})) for d in plan['datasets']]
        args += ['--datasets', 'scan_datasets.json']
    else:
        for d in plan['datasets']:
            for p in d['paths']:
                args += ['--bam', q(p)]
        if chems:
            args += ['--chemistry', next(iter(chems))]
    args += [q(w) for w in where]
    args += ['--modules', ','.join(plan['module_names'])]
    caps = (plan['raw_read_policy'] or {}).get('caps') or {}
    for name, flag in (('max_discovery_molecules', '--max-discovery-molecules'),
                       ('max_quantification_molecules', '--max-quantification-molecules'), ('sample_seed', '--sample-seed')):
        if name in caps:
            args += [flag, str(caps[name])]
    extra = dict(plan['parameters'] or {})
    policy = {k: v for k, v in (plan['raw_read_policy'] or {}).items() if k != 'caps'}
    if policy:
        extra['read_policy'] = policy
    if extra:
        args += ['--parameters', 'scan_parameters.json']
    args += ['--no-annotate', '-o', 'scan_dir']
    notes = []
    if plan['scope'] == 'view':
        notes.append('--genome --contigs computes every unit of the contig; the browser computes the view\'s units. '
                     'Opening that scan makes these units precomputed.')
    if datasets_json:
        notes.append('scan_datasets.json lists the datasets (several BAMs in one dataset, or chosen chemistries)')
    notes.append('Drop --no-annotate to write per-molecule results into annotated BAMs (the default for genome scans). '
                 '--cores and --window-jobs never change a row.')
    return dict(args=args, text=' '.join(args), parameters=extra or None, datasets=datasets_json, notes=notes)


# ------------------------------------------------------------------ coverage by open scans
def _scan_matches(scan, plan: dict, module: dict) -> bool:
    m = scan.manifest
    if (m.get('reference') or {}).get('contigs_sha256') != plan['contigs_sha256']:
        return False
    theirs = [(d.get('ordinal'), d.get('dataset_id'), d.get('chemistry'), [f.get('content_id') for f in d.get('files') or []])
              for d in sorted(m.get('datasets') or [], key=lambda d: d.get('ordinal', 0))]
    ours = [(i, d['dataset_id'], d['chemistry'], d['content_ids']) for i, d in enumerate(plan['datasets'])]
    if theirs != ours or m.get('read_policy') != plan['read_policy']:
        return False
    block = (m.get('modules') or {}).get(module['name']) or {}
    if block.get('version') != module['version'] or block.get('settings_hash') != module['settings_hash']:
        return False
    info, units = m.get('units') or {}, plan['units_info']
    # The unit mode decides rules the settings leave on 'auto' (peaks: window rules for BED units, local for grid).
    if not all(info.get(k) == units.get(k) for k in ('mode', 'unit_bp', 'stride_bp', 'grid_offset')):
        return False
    if module['name'] == 'peaks' and _effective_peak_rules(module['settings'], plan['units']) != _scan_peak_rules(scan):
        # 'auto' rules resolve by the plan (window rules only when every unit is a lone BED unit).
        return False
    if block.get('calibration') and module['name'] != 'peaks':
        # A dataset-level calibration (nuc) is drawn from the scanned territory: only the same plan has the same one.
        same = {k: v for k, v in info.items() if k != 'count'} == {k: v for k, v in units.items() if k != 'count'}
        if not same or int(info.get('count') or -1) != len(plan['units']):
            return False
    return True


def _effective_peak_rules(settings: dict, units: List[dict]) -> tuple:
    """The peaks module's tier and row rules for a plan, as its calibrate() resolves 'auto'."""
    single = all(u.get('mode') == 'bed' and u.get('left') is None and u.get('right') is None for u in units)
    tier = settings.get('tier_rule', 'auto')
    rows = settings.get('row_rule', 'auto')
    return (('window' if single else 'local') if tier == 'auto' else tier,
            ('view' if single else 'records') if rows == 'auto' else rows)


def _scan_peak_rules(scan) -> Optional[tuple]:
    """The rules an open scan's peaks used (its peaks/extra/calibration.json), else None."""
    from .registry import _inside
    rel = ((scan.module('peaks') or {}).get('calibration') or {}).get('path') or 'peaks/extra/calibration.json'
    p = _inside(scan.path, rel)
    if p is None or not p.is_file():
        return None
    try:
        cal = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    return (cal.get('tier_rule'), cal.get('row_rule'))


def coverage(state, plan: dict) -> dict:
    """Per module: the planned units already computed by an open scan with the same key (precomputed: never
    recomputed) and by the browser's own cache directory (reused by run_units)."""
    from .registry import list_scans
    from .tables import iter_rows
    want = {u['unit_id']: u for u in plan['units']}
    out = {}
    for module in plan['module_names']:
        mplan = next(m for m in plan['modules'] if m['name'] == module)
        covered: Dict[str, str] = {}
        for scan in list_scans(state):
            if str(scan.path) == mplan['cache_dir'] or not _scan_matches(scan, plan, mplan):
                continue
            for chrom in {u['chrom'] for u in want.values()}:
                for row in scan.tables.fetch('units.tsv.bgz', chrom):
                    u = want.get(row.get('unit_id'))
                    if u and row.get('status') in ('done', 'empty') and int(row['start']) == u['start'] \
                            and int(row['end']) == u['end'] and int(row.get('zone_start', -1)) == u['zone_start'] \
                            and int(row.get('zone_end', -1)) == u['zone_end']:
                        covered.setdefault(u['unit_id'], scan.scan_id)
        cached = set()
        units_tsv = Path(mplan['cache_dir']) / 'units.tsv.bgz'
        if units_tsv.is_file():
            try:
                for row in iter_rows(units_tsv):
                    if row.get('unit_id') in want and row.get('status') in ('done', 'empty'):
                        cached.add(row['unit_id'])
            except (OSError, ValueError):
                pass
        out[module] = dict(total=len(want), precomputed=covered, cached=sorted(cached - set(covered)),
                           to_compute=sorted(set(want) - set(covered) - cached))
    return out
