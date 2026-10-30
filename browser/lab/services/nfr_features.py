"""Per-read states of NFRs and NFR variants of an Accessibility (preview) run, for the read panel's Cluster, Sort and
Filter on selected features (``/api/features/states``; registered with ``PackAPI.feature_states``).

- NFR variants: the run's element states (P(variant in the read's configuration) >= the run's open threshold, the
  states the combination split and the co-accessibility tests use); for a run whose elements are whole NFRs, the same
  rule from each callable read's variant probabilities.
- NFRs: open when the read has an opening in the NFR (the whole-NFR element), on callable reads.

Each read name gets '1' (the variant's opening, the NFR open), '0' (evaluated, not a member) or '.' (not callable at
the NFR, another dataset, or a name whose molecules disagree).
"""
from __future__ import annotations

from services.feature_states import _collapse as collapse


def nfr_states(state, job_id, feature):
    """{(dataset, name): '0'|'1'|'.'} for an NFR or an NFR variant of an Accessibility run, its datasets and label."""
    from lab.services.accessibility_workflow import _complete, _names
    result = _complete(state, job_id)['result']
    fid = feature['id']
    nfr_id, _, name = fid.partition(':')
    nfr = next((n for n in result.get('nfrs') or () if n['id'] == nfr_id), None)
    if nfr is None:
        raise ValueError(f'No NFR {nfr_id!r} in run {job_id[:8]}')
    if feature['kind'] == 'nfr-variant':
        if not name or not any(v['name'] == name for v in nfr.get('variants') or ()):
            raise ValueError(f'No variant {fid!r} in run {job_id[:8]}')
        element_id, label = fid, f'{nfr_id} {name}'
    else:
        element_id, label = f'{nfr_id}:open', nfr_id
    try:
        from fiberhmm.inference.accessibility.workflow import decode_element_states
        element = (decode_element_states(result) or {}).get(element_id)
    except (ImportError, ValueError):
        element = None
    threshold = float((result.get('parameters') or {}).get('open_threshold') or 0.5)
    per_name = {}
    for uid, m in result['molecules'].items():
        if element is not None:
            s = element['state'].get(uid)
            value = '.' if s is None else str(int(s))
        else:
            rec = (m.get('nfr') or {}).get(nfr_id)
            if not rec or rec.get('status') != 'callable':
                value = '.'
            elif feature['kind'] == 'nfr':
                value = '1' if rec.get('gaps') else '0'
            else:
                p = (rec.get('p') or {}).get(name)
                value = '.' if p is None else ('1' if p >= threshold else '0')
        ds = (getattr(state, 'datasets', None) or {}).get(m['dataset'])
        if getattr(ds, 'data_type', None) == 'bam_livelift':
            from services.scan.states import _Keyer
            keyer = _Keyer(state, m['dataset'], dict(enumerate(ds.paths)))
            records = m.get('source_members') or [m]
            for rec in records:
                key = rec.get('record_key')
                if not key and rec.get('record_sha256') and rec.get('read_name'):
                    record = str(rec['record_sha256']) + ':' + str(rec.get('alignment_occurrence', 0))
                    index = next((i for i, p in enumerate(ds.paths) if p == rec.get('source_path')), int(rec.get('input_index', 0)))
                    key = keyer.key(index, rec['read_name'], record)
                if key:
                    per_name.setdefault((m['dataset'], key), set()).add(value)
        else:
            for read in _names(m):
                per_name.setdefault((m['dataset'], read), set()).add(value)
    datasets = [d['dataset_id'] for d in result.get('datasets') or ()] or sorted({m['dataset'] for m in result['molecules'].values()})
    if feature['kind'] == 'nfr-variant':
        v = next(v for v in nfr['variants'] if v['name'] == name)
        span = v.get('L', v.get('start')), v.get('R', v.get('end'))
    else:
        span = nfr.get('start'), nfr.get('end')
    return collapse(per_name), datasets, label, span


