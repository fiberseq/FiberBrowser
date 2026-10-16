"""Revisioned manual display overlays on an immutable consensus result.

No native family, likelihood, source interval, or source BAM is edited. Splits
partition original call memberships; they never subdivide a physical interval.
Reset is itself undoable. A new edit after undo replaces the redo branch.
"""
from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
import hashlib
import json
import math

SHARED_SCOPE='__shared_families__'


class CurationConflict(ValueError):
    """The client revision or frozen catalog no longer matches."""


class CurationUnavailable(ValueError):
    """Only completed immutable jobs support manual overlays."""


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def _interval(value):
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float))
                   or not math.isfinite(v) or int(v) != v for v in value)
            or value[1] <= value[0]):
        raise ValueError('An unambiguous original half-open call interval is required')
    return [int(value[0]), int(value[1])]


def _members(dataset_id, row, proposal):
    """Return source identities, without guessing identity from displayed edges."""
    unit_id = str(row['unit_id'])
    explicit = proposal.get('source_call_id')
    if explicit is not None:
        if not isinstance(explicit, str) or not explicit:
            raise ValueError('source_call_id must be a nonempty string')
        # New native records represent exactly one immutable original call.
        extent = proposal.get('source_interval') or proposal.get('raw')
        if extent is None:
            intervals = proposal.get('source_intervals')
            if intervals:
                if len(intervals) != 1:
                    raise ValueError('One source_call_id cannot identify multiple source intervals')
                extent = intervals[0]
            else:
                extent = proposal.get('interval')
        return [(explicit, unit_id, _interval(extent))]
    ordinals = proposal.get('source_ordinals')
    if ordinals is None and proposal.get('source_ordinal') is not None:
        ordinals = [proposal['source_ordinal']]
    intervals = proposal.get('source_intervals')
    if not ordinals:
        raise ValueError('Legacy proposal has no immutable source-call ordinal')
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in ordinals):
        raise ValueError('Source-call ordinals must be nonnegative integers')
    if len(set(ordinals)) != len(ordinals):
        raise ValueError('Repeated source-call ordinals are ambiguous')
    if intervals is None:
        source = row.get('source_calls')
        if not isinstance(source, list) or any(i >= len(source) for i in ordinals):
            raise ValueError('Legacy source intervals are unavailable; displayed edges are not identities')
        intervals = [source[i] for i in ordinals]
    if len(intervals) != len(ordinals):
        raise ValueError('Legacy source ordinals and intervals do not correspond')
    return [(f'{dataset_id}:{unit_id}:{ordinal}', unit_id, _interval(extent))
            for ordinal, extent in zip(ordinals, intervals)]


def _build_index(result):
    datasets = {}
    digest_rows = []
    for dataset_id, ds in result.get('datasets', {}).items():
        catalog = ds.get('cr', {}).get('catalog', [])
        families = {str(f['family']): f for f in catalog}
        if len(families) != len(catalog):
            raise ValueError('Automatic family IDs must be unique within a dataset')
        members = defaultdict(set)
        calls = {}
        unavailable = []
        for row in ds.get('cr', {}).get('records', []):
            for position, proposal in enumerate(row.get('proposals', [])):
                family = str(proposal.get('family', ''))
                unclassified = proposal.get('classification_status') == 'provisional_unresolved'
                if family not in families and not unclassified:
                    unavailable.append(dict(unit_id=row.get('unit_id'), proposal_index=position,
                                            reason='Unknown automatic family', family=family))
                    continue
                try:
                    identities = _members(dataset_id, row, proposal)
                except (KeyError, TypeError, ValueError) as error:
                    unavailable.append(dict(unit_id=row.get('unit_id'), proposal_index=position,
                                            reason=str(error), family=family))
                    continue
                for call_id, unit_id, extent in identities:
                    call = calls.setdefault(call_id, dict(call_id=call_id, unit_id=unit_id,
                        interval=extent, source_family_ids=set(),primary_family_ids=set()))
                    if family in families:call['primary_family_ids'].add(family)
                    if call['unit_id'] != unit_id or call['interval'] != extent:
                        raise ValueError('Conflicting original intervals or units for one source_call_id')
                    compatible=[family]+[a if isinstance(a,str) else a.get('family','')
                                          for a in proposal.get('compatible_alternatives',[])]
                    for fid in compatible:
                        if fid in families:
                            call['source_family_ids'].add(fid)
                            members[fid].add(call_id)
        for call in calls.values():
            call['source_family_ids'] = sorted(call['source_family_ids'])
            call['primary_family_ids'] = sorted(call['primary_family_ids'])
        by_unit = defaultdict(list)
        for call_id, call in calls.items():
            by_unit[call['unit_id']].append(call_id)
        datasets[dataset_id] = dict(families=families, members=dict(members), calls=calls,
                                   by_unit=dict(by_unit), unavailable=unavailable)
        digest_rows.append(dict(dataset_id=dataset_id, catalog=catalog,
                                calls=sorted(calls.values(), key=lambda r: r['call_id']),
                                unavailable=unavailable))
    if result.get('cr_mode')=='staged_native_families' and result.get('manifest',{}).get('mode')=='XCR':
        if SHARED_SCOPE in datasets:raise ValueError('Reserved shared-family scope used as dataset ID')
        families={};members=defaultdict(set);calls={};by_unit=defaultdict(list);unavailable=[]
        for index in datasets.values():
            for fid,family in index['families'].items():
                previous=families.get(fid)
                if previous and any(previous[k]!=family[k] for k in ('consensus_start','consensus_end')):
                    raise ValueError('Shared family has conflicting geometry across datasets')
                families[fid]=family
            for fid,ids in index['members'].items():members[fid].update(ids)
            if set(calls)&set(index['calls']):raise ValueError('Shared curation requires globally unique original-call IDs')
            calls.update(index['calls'])
            for uid,ids in index['by_unit'].items():by_unit[uid].extend(ids)
            unavailable.extend(index['unavailable'])
        datasets[SHARED_SCOPE]=dict(families=families,members=dict(members),calls=calls,by_unit=dict(by_unit),unavailable=unavailable)
    return datasets, _digest(digest_rows)


def _store(job):
    if job.get('status') != 'complete' or 'result' not in job:
        raise CurationUnavailable('Only completed frozen results can be curated')
    current = job.get('_curation')
    if current is None:
        projected=job.get('_assignment_views',{}).get(job['result'].get('final_stage'))
        index, digest = _build_index(dict(job['result'],**projected) if projected else job['result'])
        current = dict(revision=0, catalog_digest=digest, index=index,
                       result_identity=id(job['result']), cursor=0, history=[],
                       snapshots=[dict(manual_groups=[], ignored_families={})])
        job['_curation'] = current
    if current['result_identity'] != id(job['result']):
        raise CurationConflict('Frozen result was replaced; create a new curation job')
    return current


def _view(store):
    snapshot = store['snapshots'][store['cursor']]
    return deepcopy(dict(revision=store['revision'], catalog_digest=store['catalog_digest'],
        can_undo=store['cursor'] > 0, can_redo=store['cursor'] < len(store['history']),
        operations=store['history'][:store['cursor']], **snapshot,
        unavailable_memberships={ds: index['unavailable'] for ds, index in store['index'].items()
                                 if index['unavailable']},
        semantics='Manual display overlay only; automatic families, native evidence and original intervals are immutable.'))


def curation_for_job(job):
    """Caller holds the session lock; useful for catalog transport."""
    return _view(_store(job))


def get_curation(state, job_id):
    from services.consensus_workflow import _session
    jobs, lock = _session(state)
    with lock:
        return curation_for_job(jobs[job_id])


def export_history(job):
    store=_store(job)
    return deepcopy(dict(schema='fiberbrowser.family_curation.v1',catalog_digest=store['catalog_digest'],
        revision=store['revision'],cursor=store['cursor'],history=store['history']))


def restore_history(job,receipt):
    """Validate by replay on an isolated job; install only after all edits pass."""
    from types import SimpleNamespace
    import threading
    if not isinstance(receipt,dict) or receipt.get('schema')!='fiberbrowser.family_curation.v1':
        raise ValueError('Unsupported manual curation history')
    trial=dict(job);trial.pop('_curation',None);trial.pop('view_stage',None)
    store=_store(trial)
    if receipt.get('catalog_digest')!=store['catalog_digest']:raise CurationConflict('Curation catalog digest does not match')
    history=receipt.get('history');cursor=receipt.get('cursor');revision=receipt.get('revision')
    if (not isinstance(history,list) or type(cursor) is not int or not 0<=cursor<=len(history)
        or type(revision) is not int or revision<0):raise ValueError('Invalid manual history counters')
    state=SimpleNamespace(consensus_workflow_jobs={'restore':trial},consensus_workflow_lock=threading.RLock())
    previous=0
    for action in history:
        if not isinstance(action,dict):raise ValueError('Invalid manual history action')
        created=action.get('applied_at_revision')
        if type(created) is not int or not previous<created<=revision:raise ValueError('Invalid manual action revision')
        store['revision']=created-1
        request={k:v for k,v in action.items() if k!='applied_at_revision'}
        if request.get('operation') in ('undo','redo'):raise ValueError('History must contain edits, not cursor movements')
        update_curation(state,'restore',dict(request,expected_revision=created-1))
        previous=created
    store.update(cursor=cursor,revision=revision)
    store.pop('_lookup_revision',None);store.pop('_lookup',None)
    job['_curation']=store


def _selection(store, snapshot, request):
    dataset_id = request.get('dataset_id')
    if SHARED_SCOPE in store['index'] and dataset_id != SHARED_SCOPE:
        raise ValueError('This XCR catalog uses shared-family curation across datasets')
    if not isinstance(dataset_id, str) or dataset_id not in store['index']:
        raise ValueError('Select exactly one dataset from this frozen job')
    ids = request.get('family_ids')
    if not isinstance(ids, list) or not ids or any(not isinstance(v, str) or not v for v in ids):
        raise ValueError('family_ids must be a nonempty array of family or manual-group IDs')
    if len(set(ids)) != len(ids):
        raise ValueError('family_ids must be unique')
    index = store['index'][dataset_id]
    groups = {g['group_id']: g for g in snapshot['manual_groups'] if g['dataset_id'] == dataset_id}
    unknown = set(ids) - set(index['families']) - set(groups)
    if unknown:
        raise ValueError('Unknown family in selected dataset; cross-dataset manual merges are forbidden')
    return dataset_id, ids, index, groups


def _effective_members(index, groups, family_id):
    if family_id in groups:
        return set(groups[family_id]['call_ids'])
    claimed = {c for group in groups.values() if family_id in group.get('replaces_family_ids',index['families']) for c in group['call_ids']}
    return set(index['members'].get(family_id, ())) - claimed


def _new_group(store, dataset_id, label, operation, calls, index, **metadata):
    source_ids = sorted({f for call_id in calls for f in index['calls'][call_id]['source_family_ids']})
    if operation == 'merge':source_ids = list(metadata.get('replaces_family_ids',source_ids))
    key = dict(revision=store['revision'] + 1, dataset_id=dataset_id, operation=operation,
               call_ids=sorted(calls), metadata=metadata)
    group_id = 'manual:' + _digest(key)[:24]
    display_start=metadata.get('model_start',min(index['calls'][c]['interval'][0] for c in calls))
    display_end=metadata.get('model_end',max(index['calls'][c]['interval'][1] for c in calls))
    return dict(group_id=group_id, family=group_id, dataset_id=dataset_id,
                label=label, operation=operation, source_family_ids=source_ids,
                call_ids=sorted(calls), effective_call_ids=sorted(calls), manual=True,
                display_start=display_start, display_end=display_end,
                display_summary_only=True, **metadata)


def subclass_candidates(job, dataset_id, family_id, include_call_ids=False):
    """Return earlier fitted parent states that consolidation combined.

    Candidates come only from the frozen ``parents`` stage and retain that
    stage's fitted geometry.  This is deliberately not a coordinate clustering
    heuristic: the relationship must be recorded by consolidation provenance
    or by shared native children.
    """
    if job.get('result',{}).get('cr_mode') != 'staged_native_families':
        return []
    store=_store(job)
    if dataset_id not in store['index'] or family_id not in store['index'][dataset_id]['families']:
        return []
    selected=store['index'][dataset_id]['families'][family_id]
    hypothesis=selected.get('hypothesis') or {}
    children=set(hypothesis.get('children') or ())
    replaced=set(hypothesis.get('replaces_parents') or ())
    if not children and not replaced:return []
    stage=job['result'].get('stage_results',{}).get('parents',{})
    stage_datasets=stage.get('datasets',{})
    names=list(stage_datasets) if dataset_id==SHARED_SCOPE else [dataset_id]
    candidate_models={}
    for name in names:
        for candidate in stage_datasets.get(name,{}).get('cr',{}).get('catalog',[]):
            cid=str(candidate.get('family',''));ch=set((candidate.get('hypothesis') or {}).get('children') or ())
            if (candidate.get('hypothesis') or {}).get('kind')!='bounded_parent':continue
            if cid not in replaced and not children.intersection(ch):continue
            previous=candidate_models.get(cid)
            if previous and (previous.get('consensus_start'),previous.get('consensus_end'))!=(candidate.get('consensus_start'),candidate.get('consensus_end')):
                continue
            candidate_models[cid]=candidate
    memberships=defaultdict(set)
    for name in names:
        for row in stage_datasets.get(name,{}).get('cr',{}).get('records',[]):
            for proposal in row.get('proposals',[]):
                labels=[proposal.get('family')]+[v if isinstance(v,str) else v.get('family') for v in proposal.get('compatible_alternatives',[]) if isinstance(v,(str,dict))]
                wanted=set(labels)&candidate_models.keys()
                if not wanted:continue
                try:ids={call_id for call_id,_,_ in _members(name,row,proposal)}
                except (KeyError,TypeError,ValueError):continue
                for cid in wanted:memberships[cid].update(ids)
    selected_calls=set(store['index'][dataset_id]['members'].get(family_id,()))
    output=[]
    for cid,candidate in candidate_models.items():
        calls=memberships[cid]&selected_calls
        if not calls:continue
        counts=candidate.get('classification_counts') or {}
        item=dict(family=cid,consensus_start=candidate['consensus_start'],consensus_end=candidate['consensus_end'],
            primary_calls=sum(int(v.get('primary_calls',0)) for v in counts.values()),
            compatible_calls=sum(int(v.get('compatible_calls',0)) for v in counts.values()),
            member_calls=len(calls),direct_parent=cid in replaced)
        if include_call_ids:item['call_ids']=sorted(calls)
        output.append(item)
    return sorted(output,key=lambda v:(v['consensus_start'],v['consensus_end'],v['family']))


def update_curation(state, job_id, request):
    """Apply one atomic, revision-guarded display action; never refit inference."""
    from services.consensus_workflow import _session
    jobs, lock = _session(state)
    with lock:
        from services.consensus_workflow import viewing_final, _cr_mode, RECALLER_MODE
        if 'result' in jobs[job_id] and _cr_mode(jobs[job_id]['result']) == RECALLER_MODE:
            # Group/ignore edit labelled native calls (tf_cr); a recaller run's classes are its own per-molecule calls
            # (tf_rc), so an edit would be recorded and change nothing that is drawn, filtered or counted.
            raise CurationUnavailable('Manual class edits are not available for lattice recaller runs: they edit the staged '
                                      "engine's labelled native calls, not the recaller's own class calls")
        if not viewing_final(jobs[job_id]):
            raise CurationUnavailable('Earlier stages are read-only; select the final stage to curate')
        store = _store(jobs[job_id])
        if not isinstance(request, dict):
            raise ValueError('Curation request must be an object')
        allowed = {'expected_revision', 'catalog_digest', 'operation', 'dataset_id',
                   'family_ids', 'label', 'split', 'subclass_ids'}
        if set(request) - allowed:
            raise ValueError('Unknown curation parameter')
        revision = request.get('expected_revision')
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValueError('expected_revision must be a nonnegative integer')
        if revision != store['revision']:
            raise CurationConflict(f'Stale curation revision: expected {store["revision"]}, received {revision}')
        if request.get('catalog_digest', store['catalog_digest']) != store['catalog_digest']:
            raise CurationConflict('Frozen catalog digest does not match')
        operation = request.get('operation')
        if operation not in ('merge', 'split', 'restore_subclasses', 'ignore', 'unignore', 'undo', 'redo', 'reset'):
            raise ValueError('Unknown curation operation')
        if operation in ('undo', 'redo'):
            delta = -1 if operation == 'undo' else 1
            if not 0 <= store['cursor'] + delta <= len(store['history']):
                raise ValueError(f'Nothing to {operation}')
            store['cursor'] += delta
            store['revision'] += 1
            return _view(store)
        snapshot = deepcopy(store['snapshots'][store['cursor']])
        if operation == 'reset':
            snapshot = dict(manual_groups=[], ignored_families={})
        else:
            dataset_id, ids, index, groups = _selection(store, snapshot, request)
            if operation in ('ignore', 'unignore'):
                ignored = set(snapshot['ignored_families'].get(dataset_id, ()))
                if operation == 'ignore':
                    ignored.update(ids)
                else:
                    ignored.difference_update(ids)
                snapshot['ignored_families'][dataset_id] = sorted(ignored)
            else:
                unsupported = {r['family'] for r in index['unavailable']}
                if unsupported.intersection(ids):
                    raise ValueError('Selected family contains calls without unambiguous source identity; no partial curation was applied')
                memberships = [_effective_members(index, groups, family_id) for family_id in ids]
                if operation == 'merge':
                    memberships = [calls if fid in groups else {c for c in calls
                        if fid in index['calls'][c]['primary_family_ids']}
                        for fid,calls in zip(ids,memberships)]
                if operation == 'merge' and not any(memberships):
                    # A merge takes the calls whose best-fit class is one of those
                    # merged; calls that only also fit them stay with their own.
                    raise ValueError('None of these classes is the best fit for any call here, so there is nothing to merge')
                if operation != 'merge' and any(not calls for calls in memberships):
                    raise ValueError('A selected class has no calls of its own here')
                calls = set().union(*memberships)
                replaces=sorted({f for fid in ids for f in (groups[fid].get('replaces_family_ids',groups[fid]['source_family_ids']) if fid in groups else [fid])})
                label = request.get('label')
                if label is not None and (not isinstance(label, str) or not label.strip() or len(label) > 200):
                    raise ValueError('Manual label must contain 1–200 characters')
                label = label.strip() if label is not None else ('Grouped states' if operation == 'merge' else 'Subclass' if operation == 'restore_subclasses' else 'Split state')
                if operation == 'merge':
                    if len(ids) < 2:
                        raise ValueError('Merge requires at least two families in one dataset')
                    bounds=[(groups[f]['display_start'],groups[f]['display_end']) if f in groups
                            else (index['families'][f]['consensus_start'],index['families'][f]['consensus_end']) for f in ids]
                    additions = [_new_group(store, dataset_id, label, operation, calls, index,replaces_family_ids=replaces,suppress_source_state=True,
                        model_start=min(a for a,b in bounds),model_end=max(b for a,b in bounds),
                        geometry_semantics='union_of_selected_state_summaries_not_member_call_envelope')]
                elif operation == 'restore_subclasses':
                    if len(ids)!=1 or ids[0] not in index['families']:
                        raise ValueError('Subclass recovery requires exactly one automatic population state')
                    requested=request.get('subclass_ids')
                    if not isinstance(requested,list) or len(requested)<2 or len(set(requested))!=len(requested) or any(not isinstance(v,str) for v in requested):
                        raise ValueError('Choose at least two distinct fitted subclasses')
                    candidates={v['family']:v for v in subclass_candidates(jobs[job_id],dataset_id,ids[0],True)}
                    if set(requested)-candidates.keys():
                        raise ValueError('Subclass selection is not present in the frozen parent-stage fits')
                    additions=[]
                    for number,cid in enumerate(requested,1):
                        candidate=candidates[cid];part=set(candidate['call_ids'])
                        additions.append(_new_group(store,dataset_id,f'{label} {number}',operation,part,index,
                            replaces_family_ids=replaces,suppress_source_state=True,
                            model_start=candidate['consensus_start'],model_end=candidate['consensus_end'],
                            model_family_id=cid,restored_state_id=ids[0],restored_from_stage='parents'))
                else:
                    split = request.get('split')
                    if not isinstance(split, dict):
                        raise ValueError('A split criterion is required')
                    by = split.get('by')
                    if by == 'call_ids':
                        selected = split.get('call_ids')
                        if set(split) != {'by', 'call_ids'} or not isinstance(selected, list) or any(not isinstance(c, str) for c in selected):
                            raise ValueError('call_ids split requires an explicit array of original-call IDs')
                        first = set(selected)
                        if len(first) != len(selected) or first - calls:
                            raise ValueError('Split call IDs must be unique members of the selected display families')
                        suffixes = ['selected', 'remaining']
                    elif by in ('length', 'start', 'end'):
                        threshold = split.get('threshold')
                        if (set(split) != {'by', 'threshold'} or isinstance(threshold, bool)
                                or not isinstance(threshold, (int, float)) or not math.isfinite(threshold)):
                            raise ValueError('Split threshold must be finite')
                        def value(call_id):
                            left, right = index['calls'][call_id]['interval']
                            return right - left if by == 'length' else left if by == 'start' else right
                        first = {call_id for call_id in calls if value(call_id) <= threshold}
                        suffixes = [f'{by} ≤ {threshold:g}', f'{by} > {threshold:g}']
                    else:
                        raise ValueError('Split by length, start, end, or call_ids')
                    second = calls - first
                    if not first or not second:
                        raise ValueError('Split must produce two nonempty original-call partitions')
                    additions = [_new_group(store, dataset_id, f'{label} · {suffix}', operation,
                        part, index, split=deepcopy(split), partition=i,replaces_family_ids=replaces)
                        for i, (part, suffix) in enumerate(zip((first, second), suffixes))]
                remaining = []
                for group in snapshot['manual_groups']:
                    # Distinct, unselected hypotheses can share calls. Editing
                    # one must not silently repartition another manual family.
                    if group['dataset_id'] == dataset_id and (group['group_id'] in ids
                        or jobs[job_id]['result'].get('cr_mode') != 'staged_native_families'):
                        kept = set(group['call_ids']) - calls
                        if not kept:
                            continue
                        group['call_ids'] = group['effective_call_ids'] = sorted(kept)
                        group['display_start'] = min(index['calls'][c]['interval'][0] for c in kept)
                        group['display_end'] = max(index['calls'][c]['interval'][1] for c in kept)
                    remaining.append(group)
                snapshot['manual_groups'] = remaining + additions
        action = deepcopy({k: v for k, v in request.items() if k not in ('expected_revision', 'catalog_digest')})
        action['applied_at_revision'] = store['revision'] + 1
        store['history'] = store['history'][:store['cursor']] + [action]
        store['snapshots'] = store['snapshots'][:store['cursor'] + 1] + [snapshot]
        store['cursor'] += 1
        store['revision'] += 1
        return _view(store)


def _groups_for_dataset(store,snapshot,dataset_id):
    """One shared manual decision, projected by exact original-call IDs."""
    calls=store['index'][dataset_id]['calls'];groups={}
    for original in snapshot['manual_groups']:
        if original['dataset_id'] not in (dataset_id,SHARED_SCOPE):continue
        selected=sorted(set(original['call_ids'])&calls.keys())
        if not selected:continue
        group=dict(original,call_ids=selected,effective_call_ids=selected,
            display_start=original.get('model_start',min(calls[c]['interval'][0] for c in selected)),
            display_end=original.get('model_end',max(calls[c]['interval'][1] for c in selected)))
        groups[group['group_id']]=group
    return groups


def curated_display_families(job, dataset_id):
    """Separate display catalog, with no fabricated merged consensus interval."""
    store = _store(job)
    index = store['index'][dataset_id]
    snapshot = store['snapshots'][store['cursor']]
    groups = _groups_for_dataset(store,snapshot,dataset_id)
    ignored = set(snapshot['ignored_families'].get(dataset_id, ()))|set(snapshot['ignored_families'].get(SHARED_SCOPE,()))
    suppressed = {family_id for group in groups.values() if group.get('suppress_source_state')
                  for family_id in group.get('replaces_family_ids', ())}
    display = []
    for family_id, automatic in index['families'].items():
        calls = sorted(_effective_members(index, groups, family_id))
        unavailable = sum(r['family'] == family_id for r in index['unavailable'])
        display.append(dict(deepcopy(automatic), display_family_id=family_id, manual=False,
            source_family_ids=[family_id], effective_call_ids=calls,
            unavailable_membership_count=unavailable,
            ignored=family_id in ignored, superseded_by_manual=family_id in suppressed
                or (bool(index['members'].get(family_id)) and not calls and not unavailable)))
    for group in groups.values():
        display.append(dict(deepcopy(group), display_family_id=group['group_id'],
                            ignored=group['group_id'] in ignored))
    return display


def _manual_lookup(job, dataset_id):
    store = _store(job)
    if store.get('_lookup_revision') != store['revision']:
        store['_lookup_revision'] = store['revision']
        store['_lookup'] = {}
    if dataset_id not in store['_lookup']:
        snapshot = store['snapshots'][store['cursor']]
        groups = {call_id: group for group in _groups_for_dataset(store,snapshot,dataset_id).values()
                  for call_id in group['call_ids']}
        store['_lookup'][dataset_id] = (groups, set(snapshot['ignored_families'].get(dataset_id, ()))|set(snapshot['ignored_families'].get(SHARED_SCOPE,())))
    groups, ignored = store['_lookup'][dataset_id]
    return store['index'][dataset_id], groups, ignored


def annotate_record(job, dataset_id, unit_id, record):
    """Copy an automatic record and add manual provenance, never replace it.

    The copy is shallow: only top-level keys are set on it (new values), so the
    automatic record's nested evidence is shared, read-only, as every other
    displayed consensus record's is. A deep copy per record per request made
    projecting a class run onto the reads several times slower.
    """
    index, groups, ignored = _manual_lookup(job, dataset_id)
    result = dict(record)
    try:
        identities = _members(dataset_id, dict(unit_id=unit_id), record)
        if any(c not in index['calls'] or index['calls'][c]['interval'] != extent
               or index['calls'][c]['unit_id'] != str(unit_id) for c, _, extent in identities):
            raise ValueError('Record is not an exact original-call catalog member')
    except (KeyError, TypeError, ValueError) as error:
        result['manual_curation'] = dict(status='identity_unavailable', reason=str(error))
        return result
    call_ids = [c for c, _, _ in identities]
    if job['result'].get('cr_mode') == 'staged_native_families':
        projected = _staged_curated_records(job, dataset_id, unit_id, [record])[0]
        result['curation_call_ids'] = call_ids
        result['manual_curation'] = dict(status='manual' if projected.get('manual') else 'automatic',
            group_ids=projected.get('manual_group_ids', []), ignored=projected.get('manual_ignored', False),
            revision=_store(job)['revision'])
        return result
    selected = {groups[c]['group_id']: groups[c] for c in call_ids if c in groups}
    result['curation_call_ids'] = call_ids
    result['manual_curation'] = dict(status='manual' if selected else 'automatic',
        group_ids=sorted(selected), ignored=record.get('family') in ignored,
        revision=_store(job)['revision'])
    if len(selected) == 1 and all(c in groups for c in call_ids):
        group = next(iter(selected.values()))
        result.update(manual_group_id=group['group_id'], manual_label=group['label'],
                      automatic_family=record.get('family'), source_family_ids=group['source_family_ids'])
        result['manual_curation']['ignored'] |= group['group_id'] in ignored
    return result


def manual_records_for_unit(job, dataset_id, unit_id):
    """Independent tf_cr_manual records at original, unsplit physical extents."""
    index, groups, ignored = _manual_lookup(job, dataset_id)
    records = []
    for call_id in index['by_unit'].get(str(unit_id), ()):
        call = index['calls'][call_id]
        if call_id not in groups:
            continue
        group = groups[call_id]
        if group['group_id'] in ignored or set(call['source_family_ids']) & ignored:
            continue
        records.append(dict(interval=list(call['interval']), kind='manual_curation', manual=True,
            family=group['group_id'],
            source_call_id=call_id, manual_group_id=group['group_id'], manual_label=group['label'],
            automatic_family=call['source_family_ids'][0] if len(call['source_family_ids']) == 1 else None,
            automatic_families=list(call['source_family_ids']), source_family_ids=list(group['source_family_ids']),
            curation_revision=_store(job)['revision']))
    return sorted(records, key=lambda r: (r['interval'], r['source_call_id']))


def _staged_curated_records(job, dataset_id, unit_id, automatic_records):
    """Project all manual and surviving automatic memberships independently."""
    store = _store(job)
    if store.get('_staged_lookup_revision') != store['revision']:
        store['_staged_lookup_revision'] = store['revision']
        store['_staged_lookup'] = {}
    if dataset_id not in store['_staged_lookup']:
        snapshot = store['snapshots'][store['cursor']]
        by_call = defaultdict(list)
        for group in _groups_for_dataset(store, snapshot, dataset_id).values():
            for call_id in group['call_ids']: by_call[call_id].append(group)
        ignored = set(snapshot['ignored_families'].get(dataset_id, ())) | set(snapshot['ignored_families'].get(SHARED_SCOPE, ()))
        suppressed = {family_id for group in _groups_for_dataset(store, snapshot, dataset_id).values()
                      if group.get('suppress_source_state')
                      for family_id in group.get('replaces_family_ids', ())}
        store['_staged_lookup'][dataset_id] = (by_call, ignored, suppressed)
    by_call, ignored, suppressed = store['_staged_lookup'][dataset_id]
    index = store['index'][dataset_id]; output = []
    for record in automatic_records:
        item = dict(record)   # top-level keys only are changed (see annotate_record)
        try:
            identities = _members(dataset_id, dict(unit_id=unit_id), record)
            if len(identities) != 1: raise ValueError('Staged records require one original call')
            call_id, uid, extent = identities[0]
            call = index['calls'][call_id]
            if call['unit_id'] != uid or call['interval'] != extent: raise ValueError('Source identity mismatch')
        except (KeyError, TypeError, ValueError):
            output.append(item); continue
        groups = by_call.get(call_id, [])
        original = set(call['source_family_ids'])
        replaced = {f for group in groups for f in group['replaces_family_ids']}
        active_groups = sorted(group['group_id'] for group in groups if group['group_id'] not in ignored)
        # Surviving automatic labels keep their automatic order: the primary
        # stays primary unless it is the one removed.
        keep = original - replaced - ignored - suppressed
        alternatives = [v if isinstance(v, str) else v.get('family')
                        for v in record.get('compatible_alternatives') or [] if isinstance(v, (str, dict))]
        automatic_order = [record.get('family'), *alternatives, *call['source_family_ids'], *sorted(original)]
        surviving = list(dict.fromkeys(f for f in automatic_order if f in keep))
        labels = active_groups + surviving
        changed = bool(groups or original & (ignored | suppressed))
        item.update(manual=changed, curation_revision=store['revision'])
        if changed:
            item.update(kind='manual_curation', automatic_family=record.get('family'),
                automatic_compatible_alternatives=deepcopy(record.get('compatible_alternatives', [])),
                automatic_primary_evidence=deepcopy(record.get('primary_evidence')), primary_evidence=None,
                automatic_classification_status=record.get('classification_status'),
                family=labels[0] if labels else None, compatible_alternatives=labels[1:], compatible_families=labels,
                manual_group_ids=active_groups, unclassified=not labels,
                manual_ignored=not labels, classification_status='manual_group' if active_groups else 'manual_filtered' if labels else 'manual_ignored',
                evidence_scope='Manual labels; original automatic evidence is retained without refitting.')
            if len(active_groups) == 1:
                group = next(g for g in groups if g['group_id'] == active_groups[0])
                item.update(manual_group_id=group['group_id'], manual_label=group['label'])
            if labels: item.pop('display_color', None)
            else: item['display_color'] = '#94a3b8'
        output.append(item)
    return output


def curated_records_for_unit(job, dataset_id, unit_id, automatic_records):
    """Complete manual view: untouched copies, manual labels, ignored-as-gray.

    The input is the current display-filtered automatic CR row, not a new
    inference run. Original-call IDs anchor manual memberships across reference
    changes. A legacy merged proposal with differently curated source calls is
    expanded into those original calls, never cut into invented intervals.
    """
    if job['result'].get('cr_mode') == 'staged_native_families':
        return _staged_curated_records(job, dataset_id, unit_id, automatic_records)
    index, groups, ignored = _manual_lookup(job, dataset_id)
    output = []
    emitted = set()

    def decorate(record, group=None, call_id=None, extent=None):
        item = dict(record)   # top-level keys only are changed (see annotate_record)
        item['manual'] = False
        item['curation_revision'] = _store(job)['revision']
        if call_id is not None:
            item['source_call_id'] = call_id
            item['interval'] = list(extent)
            item['source_intervals'] = [list(extent)]
        ignored_call = (record.get('family') in ignored
            or (call_id is not None and bool(set(index['calls'][call_id]['source_family_ids']) & ignored))
            or (group is not None and group['group_id'] in ignored))
        if group is not None or ignored_call:
            item.update(manual=True, kind='manual_curation',
                automatic_family=record.get('family'),
                automatic_classification_status=record.get('classification_status'),
                automatic_primary_evidence=deepcopy(record.get('primary_evidence')),
                automatic_compatible_alternatives=list(record.get('compatible_alternatives', [])),
                primary_evidence=None, compatible_alternatives=[],
                evidence_scope='Manual display decision; native evidence is retained only as automatic_primary_evidence.')
        if group is not None:
            alternatives={record.get('family')}|{a if isinstance(a,str) else a.get('family') for a in record.get('compatible_alternatives',[])}
            alternatives-=set(group.get('replaces_family_ids',group['source_family_ids']))|{None}
            item.update(family=group['group_id'], manual_group_id=group['group_id'],
                manual_label=group['label'], source_family_ids=list(group['source_family_ids']),
                classification_status='manual_group', unclassified=False,compatible_alternatives=sorted(alternatives))
            item.pop('display_color', None)
        if ignored_call:
            item.update(manual_ignored=True, unclassified=True, display_color='#94a3b8',
                        classification_status='manual_ignored')
        return item

    for record in automatic_records:
        try:
            identities = _members(dataset_id, dict(unit_id=unit_id), record)
            if any(c not in index['calls'] or index['calls'][c]['interval'] != extent
                   or index['calls'][c]['unit_id'] != str(unit_id) for c, _, extent in identities):
                raise ValueError('Source identity does not match the immutable call index')
        except (KeyError, TypeError, ValueError):
            output.append(decorate(record))
            continue
        if not any(c in groups for c, _, _ in identities):
            output.append(decorate(record))
            continue
        for position, (call_id, _, extent) in enumerate(identities):
            if call_id in emitted:
                continue
            emitted.add(call_id)
            item = decorate(record, groups.get(call_id), call_id, extent)
            ordinals = record.get('source_ordinals')
            if ordinals and len(ordinals) == len(identities):
                item['source_ordinals'] = [ordinals[position]]
                item['source_ordinal'] = ordinals[position]
            output.append(item)
    return sorted(output, key=lambda r: (r['interval'], r.get('source_call_id', ''), r.get('family', '')))
