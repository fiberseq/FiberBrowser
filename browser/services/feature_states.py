"""Per-read states of features for the read panel's Cluster, Sort and Filter on selected features.

A feature is a footprint class of a Find classes run, or a feature of a kind a plugin pack provides
(``PackAPI.feature_states``). Each read name gets one state per feature: '1' (a member: the class's footprint),
'0' (evaluated and not a member) or '.' (not evaluated: outside the class's scoring population, another dataset,
or a name whose molecules disagree).

The states are the engines' own, on their own layers:
- Footprint classes: exact primary class membership with the Cart co-occupancy semantics
  (``services.consensus_occupancy.class_occupancy``): eligible reads are the ones the class was scored on.
"""
from __future__ import annotations

MAX_FEATURES = 16
CORE_KINDS = ('fp-class',)


def _kinds():
    from plugins.packs import hooks
    return CORE_KINDS + tuple(k for k in hooks().feature_states if k not in CORE_KINDS)


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
        kinds = _kinds()
        if kind not in kinds or not isinstance(source, str) or not source or not isinstance(fid, str) or not fid:
            raise ValueError(f"Each feature needs kind ({', '.join(kinds)}), source and id")
        dataset = f.get('dataset_id') or None
        if kind == 'fp-class' and not dataset:
            raise ValueError('A footprint class needs its dataset_id')
        out.append(dict(kind=kind, source=source, id=fid, dataset_id=dataset if kind == 'fp-class' else None))
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
    members, eligible = class_occupancy(state, dataset, chrom, [{'id': n} for n in names], [group])
    per = {}
    for n in names:
        per[(dataset, n)] = '1' if n in members.get(0, ()) else '0' if n in eligible.get(0, ()) else '.'
    return per, [dataset], None, None


def feature_states(state, features):
    """States of up to MAX_FEATURES features per read name and dataset.

    Returns ``{features: [{kind, source, id, dataset_id, datasets, label, members, evaluated}],
    by_dataset: {dataset: {read name: '10.'}}}``; a read name is listed for every dataset where some feature knows it.
    """
    feats = _clean(features)
    columns, info = [], []
    for f in feats:
        if f['kind'] == 'fp-class':
            states, datasets, label, span = _class_states(state, f['source'], f)
        else:
            from plugins.packs import hooks
            states, datasets, label, span = hooks().feature_states[f['kind']](state, f['source'], f)
        columns.append(states)
        members, evaluated = {}, {}
        for (dataset, _name), s in states.items():
            if s != '.':
                evaluated[dataset] = evaluated.get(dataset, 0) + 1
            if s == '1':
                members[dataset] = members.get(dataset, 0) + 1
        info.append(dict(f, datasets=datasets, label=label or f['id'], span=list(span) if span and span[0] is not None else None,
                         members=members, evaluated=evaluated))
    keys = sorted({key for states in columns for key in states})
    by_dataset = {}
    for dataset, name in keys:
        by_dataset.setdefault(dataset, {})[name] = ''.join(states.get((dataset, name), '.') for states in columns)
    return dict(features=info, by_dataset=by_dataset,
                semantics="1 member, 0 evaluated and not a member, '.' not evaluated (or a read name whose molecules disagree)")
