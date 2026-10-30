"""Per-read states of features for the read panel's Cluster, Sort and Filter on selected features.

A feature is a footprint class of a Find classes run, a feature of a kind a plugin pack provides
(``PackAPI.feature_states``), or a hit of a feature-hub set (``source`` = ``hub:<16 hex>``: a fiberhmm-scan set,
``services/scan/states.py``). Each read gets one state per feature: '1' (a member: the class's footprint),
'0' (evaluated and not a member) or '.' (not evaluated: outside the class's scoring population, another dataset,
or a name whose molecules disagree).

Reads are keyed by read name for native datasets. A provider may key a lifted dataset's reads by record key
(``lift-record:v1 ...``, ``services/lift/cohort.py``), so split rows of one record share their record's state
instead of collapsing into '.'; the front end matches those keys through ``idSetHas`` (``utils/recordKeys.ts``).

The states are the engines' own, on their own layers:
- Footprint classes: exact primary class membership with the Cart co-occupancy semantics
  (``services.consensus_occupancy.class_occupancy``): eligible reads are the ones the class was scored on.
- Hub sets: the scan's per (hit, record) states (``states.tsv.bgz``, or the MA state group of its annotated BAMs).

Which provider answers a feature is decided by the provider table (``_provider``), never by kind strings in the
callers: a kind is either core (``CORE_PROVIDERS``), a pack's (``hooks().feature_states``), or any kind whose
``source`` names a hub set.
"""
from __future__ import annotations

MAX_FEATURES = 16


def _class_provider(state, source, feature):
    return _class_states(state, source, feature)


# kind -> (provider, needs a dataset_id)
CORE_PROVIDERS = {'fp-class': (_class_provider, True)}
CORE_KINDS = tuple(CORE_PROVIDERS)


def _kinds():
    from plugins.packs import hooks
    return CORE_KINDS + tuple(k for k in hooks().feature_states if k not in CORE_KINDS)


def _is_hub(source) -> bool:
    return isinstance(source, str) and source.startswith('hub:')


def _provider(kind, source):
    """(provider, needs dataset) for a feature: a hub set's provider for hub sources, else the kind's."""
    if isinstance(source, str) and source.startswith('browser:'):
        from services.hub.provider_states import browser_feature_states
        return browser_feature_states, False
    if _is_hub(source):
        from services.scan.states import hub_feature_states
        return hub_feature_states, False
    if kind in CORE_PROVIDERS:
        return CORE_PROVIDERS[kind]
    from plugins.packs import hooks
    fn = hooks().feature_states.get(kind)
    return (fn, False) if fn else (None, False)


def _clean(features):
    if not isinstance(features, list) or not features:
        raise ValueError('Give a list of features')
    if len(features) > MAX_FEATURES:
        raise ValueError(f'At most {MAX_FEATURES} features at a time')
    out = []
    for f in features:
        if not isinstance(f, dict):
            raise ValueError('Each feature is an object')
        kind, source, fid = f.get('kind'), f.get('source'), f.get('id')
        if not isinstance(kind, str) or not isinstance(source, str) or not source or not isinstance(fid, str) or not fid:
            raise ValueError(f"Each feature needs kind ({', '.join(_kinds())}, or a hub set's), source and id")
        provider, needs_dataset = _provider(kind, source)
        if provider is None:
            raise ValueError(f"Each feature needs kind ({', '.join(_kinds())}, or a hub set's), source and id")
        dataset = f.get('dataset_id') or None
        if needs_dataset and not dataset:
            raise ValueError('A footprint class needs its dataset_id')
        out.append(dict(kind=kind, source=source, id=fid, dataset_id=dataset, **({'hub_hit': f['hub_hit']} if isinstance(f.get('hub_hit'), dict) else {})))
    return out


def _collapse(per_name):
    """{(dataset, name): set of states} -> {(dataset, name): state}; disagreeing molecules give '.'."""
    out = {}
    for key, found in per_name.items():
        out[key] = next(iter(found)) if len(found) == 1 else '.'
    return out


def _class_states(state, job_id, feature):
    """{(dataset, name): state} for one footprint class of a Find classes run in its dataset."""
    from services.consensus_workflow import _session, recaller_tier, stage_index
    from services.consensus_occupancy import class_occupancy
    dataset, family = feature['dataset_id'], feature['id']
    jobs, lock = _session(state)
    with lock:
        job = jobs.get(job_id)
        if not job or job.get('status') != 'complete':
            raise ValueError('The Find classes run of this class is not available; rerun or restore it')
        index = stage_index(job, dataset)
        if index is None:
            raise ValueError(f'Class {family!r} is not from dataset {dataset!r}')
        names = sorted(index.get('by_name') or index.get('per_unit') or {})
        chrom = job['result']['manifest']['region']['chrom']
        tier = recaller_tier(job, family)
    group = dict(consensusStateId=family, consensusJobId=job_id, sourceDatasetId=dataset, consensusTier=tier)
    ds = (getattr(state, 'datasets', None) or {}).get(dataset)
    if getattr(ds, 'data_type', None) == 'bam_livelift' and hasattr(state, 'build_working_set'):
        from services.hub.provider_states import record_states
        region = job['result']['manifest']['region']
        lo, hi = int(region.get('start', 0)), int(region.get('end', 0))
        if hi <= lo:
            return {}, [dataset], None, None
        reads = state.build_working_set(dataset, chrom, lo, hi, include_layers=False, include_methylation=False).reads
        def evaluate(read):
            members, eligible = class_occupancy(state, dataset, chrom, [read], [group])
            rid = str(read['id'])
            return '1' if rid in members.get(0, ()) else '0' if rid in eligible.get(0, ()) else '.'
        per = {(dataset, key): value for key, value in record_states(reads, evaluate).items()}
        return per, [dataset], None, None
    members, eligible = class_occupancy(state, dataset, chrom, [{'id': n} for n in names], [group])
    per = {}
    for n in names:
        per[(dataset, n)] = '1' if n in members.get(0, ()) else '0' if n in eligible.get(0, ()) else '.'
    return per, [dataset], None, None


def feature_states(state, features):
    """States of up to MAX_FEATURES features per read (name, or record key for lifted datasets) and dataset.

    Returns ``{features: [{kind, source, id, dataset_id, datasets, label, members, evaluated}],
    by_dataset: {dataset: {read: '10.'}}}``; a read is listed for every dataset where some feature knows it.
    """
    feats = _clean(features)
    columns, info = [], []
    for f in feats:
        provider, needs_dataset = _provider(f['kind'], f['source'])
        states, datasets, label, span = provider(state, f['source'], f)
        columns.append(states)
        members, evaluated = {}, {}
        for (dataset, _name), s in states.items():
            if s != '.':
                evaluated[dataset] = evaluated.get(dataset, 0) + 1
            if s == '1':
                members[dataset] = members.get(dataset, 0) + 1
        public = {k: v for k, v in f.items() if k != 'hub_hit'}
        if not needs_dataset and not _is_hub(f['source']):
            public['dataset_id'] = None   # as before: only per-dataset kinds echo their dataset
        info.append(dict(public, datasets=datasets, label=label or f['id'], span=list(span) if span and span[0] is not None else None,
                         members=members, evaluated=evaluated))
    keys = sorted({key for states in columns for key in states})
    by_dataset = {}
    for dataset, name in keys:
        by_dataset.setdefault(dataset, {})[name] = ''.join(states.get((dataset, name), '.') for states in columns)
    return dict(features=info, by_dataset=by_dataset,
                semantics="1 member, 0 evaluated and not a member, '.' not evaluated (or a read name whose molecules disagree)")
