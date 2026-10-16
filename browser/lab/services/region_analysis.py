"""Matched rigid windows as pooled consensus input."""
from copy import deepcopy


def windows(state, request):
    from services.panel_genomes import dataset_genome
    rows = request.get('region_windows')
    if not isinstance(rows, list) or not rows or len(rows) > 100:
        raise ValueError('Select one matched group (at most 100 region/dataset windows).')
    names = set(); widths = set(); out = []
    for raw in rows:
        r = dict(raw)
        if r.get('blocks'):
            raise ValueError('Gapped regions need a shared block. Use the longest shared block in Footprints.')
        if not isinstance(r.get('name'), str) or not r['name'] or r['name'] in names:
            raise ValueError('Region names must be distinct.')
        if not isinstance(r.get('chrom'), str) or not r['chrom'] or r.get('strand') not in ('+', '-'):
            raise ValueError('Each region needs a chromosome and explicit orientation.')
        if any(type(r.get(k)) is not int for k in ('start', 'end')) or r['start'] < 0 or r['end'] <= r['start']:
            raise ValueError('Regions must use integer half-open coordinates.')
        ds = r.get('dataset_id')
        if ds not in request.get('dataset_ids', []) or state.get_dataset(ds) is None:
            raise ValueError('Every region needs an open selected dataset.')
        if dataset_genome(state, ds) != r.get('genome'):
            raise ValueError('The region and its dataset are on different references.')
        names.add(r['name']); widths.add(r['end'] - r['start']); out.append(r)
    if len(widths) != 1:
        raise ValueError('Selected matched regions must have equal widths; select one group.')
    if {r['dataset_id'] for r in out} != set(request['dataset_ids']):
        raise ValueError('Some selected datasets have no matched region. Untick them or show a region there.')
    return out


def _alias_payload(payload, alias):
    # Refinement predicates see the same window alias as discovery and scoring.
    body = deepcopy(dict(payload))
    for source in body['strata']: source['dataset_id'] = alias
    for entry in body.get('input_files', []): entry['dataset_id'] = alias
    if hasattr(payload, 'refine'):
        from fiberhmm.inference.consensus.loader_sampling import SampledPayload
        def refine(requirements):
            mapped = []
            for span, predicate in requirements:
                def accepts(source, unit, predicate=predicate):
                    return predicate(dict(source, dataset_id=alias), unit)
                mapped.append((span, accepts))
            payload.refine(mapped)
            return _alias_payload(payload, alias)
        return SampledPayload(body, refine)
    return body


def load(state, request, options, progress):
    from services.consensus_workflow import load_payload
    from services.panel_genomes import genome_view
    from fiberhmm.inference.consensus.regions import pool_payloads
    rows = windows(state, request); payloads = []; mapping = {}; files = []
    for row in rows:
        if row['end'] - row['start'] > options['compute'].maximum_region_bp:
            raise ValueError('Matched region exceeds the maximum analysis span.')
        ds = row['dataset_id']; alias = ds + '@' + row['name']; mapping[alias] = ds
        view = genome_view(getattr(state, '_genome_base', state), row.get('genome'))
        req = {**request, **row, 'dataset_ids': [ds]}
        payload = load_payload(view, req, options, progress)
        payload = _alias_payload(payload, alias)
        files.extend(payload.get('input_files', []))
        payloads.append(payload)
    payload = pool_payloads(payloads, rows)
    def decorate(body):
        return dict(body, region_datasets=mapping, input_files=files)
    if hasattr(payload, 'refine'):
        from fiberhmm.inference.consensus.loader_sampling import SampledPayload
        def refine(requirements):
            payload.refine(requirements)
            return decorate(payload)
        return SampledPayload(decorate(payload), refine)
    return decorate(payload)


def submit(state, request):
    from services.consensus_workflow import submit as start
    rows = windows(state, request)
    request = {**request, 'region_windows': rows, 'chrom': 'oriented_BED', 'start': 0,
               'end': rows[0]['end'] - rows[0]['start'], 'region_source': 'matched'}
    runner = None
    if request.get('frozen_job_id'):
        from services.consensus_workflow import _session, _same_sources, _snapshot
        jobs, lock = _session(state)
        with lock:
            source = jobs.get(request['frozen_job_id'])
            if not source or source['status'] != 'complete' or source['result'].get('cr_mode') != 'lattice_recaller':
                raise ValueError('Choose a completed Find classes run to transfer.')
            if not _same_sources(source['_snapshot'], _snapshot(state, source['request']['dataset_ids'])):
                raise ValueError('The frozen run’s source files changed. Find classes again first.')
            source_dir = source['artifact_dir']
        def runner(payload, parameters, out, progress):
            from fiberhmm.inference.consensus.lattice_recaller.frozen import freeze_run, apply_catalog, shift_payload
            catalog = freeze_run(source_dir, out/'frozen-catalog.json')
            frame = catalog['frame']['region']
            if frame['end'] - frame['start'] != payload['region']['end'] - payload['region']['start']:
                raise ValueError('Selected regions must have the frozen run’s width.')
            target = shift_payload(payload, frame['start'], frame)
            from services.read_depth import NAMES
            overrides = {k:v for k,v in parameters.items() if k in ('input','compute')}
            from services.consensus_workflow import _runtime
            _, parameter_module = _runtime()
            controls = {c['name'] for c in parameter_module.parameter_schema().get('recaller', [])}
            if set(NAMES) <= controls:
                # Normalization drops inactive budgets; explicit zeros must clear catalog caps.
                selected = request.get('parameters', {}).get('recaller', {})
                overrides['recaller'] = {k: selected.get(k, parameters.get('recaller', {}).get(k, 1 if k == 'sample_seed' else 0)) for k in NAMES}
            result, analysed = apply_catalog(catalog, target, out, parameters=overrides, progress=progress)
            # Includes training exclusions and the catalog frame origin for genomic projection.
            from services.oriented_regions import retain_provenance
            retain_provenance(result, analysed)
            return result
    return start(state, request, payload_loader=load, analysis_runner=runner)
