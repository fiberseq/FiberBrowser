"""Per-read states of a scan hit, for Cluster, Sort and Filter (``/api/features/states``, hub sources).

A hub ref is ``{kind, source: <set id>, id: <hit id>, dataset_id?}``. Its states come from the scan, never
recomputed in the browser:

- **tables mode** (BED-scoped scans, the browser's scan cache): ``<module>/states.tsv.bgz``, one row per (owned
  hit, source record) with the record's ``qname`` and ``record`` (``<record_sha256>:<occurrence>``);
- **annotated mode** (grid scans): the module's MA state group (``fpcls``, ``nfrvar``) on the scan's annotated
  BAMs, read live over the hit: one interval per (hit, record), AN = the hit id, byte 0 the state code. This is
  the same per-molecule result the reads carry when the annotated BAM is opened as a dataset.

Keys. Native datasets are keyed by read name (a name whose records disagree gives '.'). Live-lift datasets are
keyed by record key (``lift-record:v1 [<group>|<QNAME>, <QNAME>, <record>]``, ``services/lift/cohort.py``), the
identity every lifted row of that record shares, so split rows get their record's state; under ``fold_molecule``
the record part is null and the molecule's records are combined (agreeing states, else '.').
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Dict, Optional, Tuple

STATE_FETCH_PAD = 2_000
CODE_TO_STATE = {1: '1', 2: '0', 3: '.'}


def _state_char(value) -> str:
    v = str(value)
    return v if v in ('1', '0', '.') else '.'


class _Keyer:
    """Builds a bound browser dataset's read keys (read name, or record key for live-lift datasets)."""

    def __init__(self, state, dataset_id: str, scan_paths: Dict[int, str]):
        self.dataset_id = dataset_id
        ds = (getattr(state, 'datasets', None) or {}).get(dataset_id)
        self.lifted = getattr(ds, 'data_type', None) == 'bam_livelift'
        config = getattr(ds, 'live_lift', None)
        settings = getattr(config, 'settings', None)
        self.fold = bool(getattr(settings, 'fold_molecule', False))
        self.groups = {}
        if self.lifted and settings is not None and hasattr(settings, 'molecule_group_map'):
            self.groups = settings.molecule_group_map(list(getattr(ds, 'paths', None) or []), dataset_id)
        self.scan_paths = scan_paths

    def key(self, input_index: int, qname: str, record: Optional[str], path: Optional[str] = None) -> str:
        if not self.lifted:
            return qname
        from services.lift.cohort import _encode_record
        from services.lift.joint import group_for, molecule_key
        source = path or self.scan_paths.get(int(input_index or 0))
        resolved = os.path.realpath(source) if source else None
        group = group_for(self.groups, source, resolved) or self.dataset_id
        return _encode_record([molecule_key(group, qname), qname, None if self.fold else (record or None)])


def _combine(found: Dict[Tuple[str, str], set]) -> Dict[Tuple[str, str], str]:
    out = {}
    for key, states in found.items():
        called = {s for s in states if s != '.'}
        out[key] = next(iter(called)) if len(called) == 1 else '.'
    return out


def _bindings(scan, want_dataset: Optional[str]):
    """{scan dataset id: (browser dataset id, via)} of the bound datasets (one, when a dataset is asked for)."""
    out = {}
    for sid, b in scan.bindings.items():
        if b.get('status') != 'bound':
            continue
        if want_dataset and b.get('dataset') != want_dataset:
            continue
        out[sid] = (b['dataset'], b.get('via'))
    return out


def _scan_input_paths(scan, scan_dataset: str) -> Dict[int, str]:
    for d in scan.manifest.get('datasets') or []:
        if d.get('dataset_id') == scan_dataset:
            return {int(f.get('input_index', i)): f.get('path') for i, f in enumerate(d.get('files') or [])}
    return {}


def states_from_table(state, scan, module: str, hit: dict, bound) -> Dict[Tuple[str, str], set]:
    found: Dict[Tuple[str, str], set] = {}
    a, b = int(hit['start']), max(int(hit['end']), int(hit['start']) + 1)
    rows = scan.tables.fetch(f'{module}/states.tsv.bgz', hit['chrom'], max(0, a - STATE_FETCH_PAD), b + STATE_FETCH_PAD)
    keyers = {sid: _Keyer(state, bid, _scan_input_paths(scan, sid)) for sid, (bid, _via) in bound.items()}
    for r in rows:
        if r.get('hit_id') != hit['hit_id']:
            continue
        sid = r.get('dataset_id')
        if sid not in bound:
            continue
        record = r.get('record') or None
        # The tables name the input BAM's records; input_index is in the record of the evidence map only, so the
        # dataset's first file stands for a single-file dataset (the common case) and the group falls back to it.
        key = keyers[sid].key(0, r.get('qname', ''), record)
        found.setdefault((bound[sid][0], key), set()).add(_state_char(r.get('state')))
    return found


def _record_identity(read) -> str:
    return hashlib.sha256(read.to_string().encode('utf-8')).hexdigest()


def _align_key(read) -> tuple:
    return (read.query_name, int(read.flag), int(read.reference_start), read.cigarstring or '')


def states_from_annotated(state, scan, module: str, type_id: str, hit: dict, bound) -> Dict[Tuple[str, str], set]:
    """States from the scan's annotated BAMs (the MA state group, AN = hit id), keyed for each bound dataset."""
    import pysam
    groups = (scan.module(module) or {}).get('ma_groups') or []
    state_groups = [g for g in groups if g.get('kind') == 'state']
    if not state_groups:
        return {}
    group = state_groups[0]
    name = group.get('group')
    codes = {int(k): v for k, v in (group.get('state_codes') or {}).items()} if group.get('state_codes') else {}
    to_state = {}
    for code, meaning in codes.items():
        m = str(meaning).lower()
        to_state[code] = '1' if m in ('member', 'open') else '0' if m in ('non_member', 'non-member', 'closed') else '.'
    to_state = to_state or CODE_TO_STATE
    contracts = None
    found: Dict[Tuple[str, str], set] = {}
    a, b = int(hit['start']), max(int(hit['end']), int(hit['start']) + 1)
    for out in (scan.manifest.get('outputs') or {}).get('annotated') or []:
        sid = out.get('dataset_id')
        if sid not in bound:
            continue
        bid, via = bound[sid]
        path = scan.path / out['path']
        per_align: Dict[tuple, str] = {}
        with pysam.AlignmentFile(str(path), 'rb') as bam:
            if hit['chrom'] not in bam.references:
                continue
            if contracts is None:
                contracts = _contracts(bam.header)
            for read in bam.fetch(hit['chrom'], a, b):
                for item in _state_items(read, name, contracts):
                    if item[0] == hit['hit_id']:
                        per_align[_align_key(read)] = to_state.get(int(item[1]), '.')
        if not per_align:
            continue
        keyer = _Keyer(state, bid, _scan_input_paths(scan, sid))
        if not keyer.lifted:
            for (qname, *_rest), s in per_align.items():
                found.setdefault((bid, qname), set()).add(s)
            continue
        # Record keys name the records of the file the dataset reads: the annotated BAM itself, or the input BAM.
        input_index = int(out.get('input_index', 0))
        source = str(path) if via == 'annotated' else _scan_input_paths(scan, sid).get(input_index)
        if not source or not Path(source).is_file():
            continue
        dataset_paths = list(getattr((getattr(state, 'datasets', None) or {}).get(bid), 'paths', None) or [])
        own = next((p for p in dataset_paths if os.path.realpath(p) == os.path.realpath(source)), source)
        occurrences: Dict[str, int] = {}
        with pysam.AlignmentFile(source, 'rb') as bam:
            for read in bam.fetch(hit['chrom'], a, b):
                sha = _record_identity(read)
                occ = occurrences.get(sha, 0)
                occurrences[sha] = occ + 1
                s = per_align.get(_align_key(read))
                if s is None:
                    continue
                found.setdefault((bid, keyer.key(input_index, read.query_name, f'{sha}:{occ}', own)), set()).add(s)
    return found


def _contracts(header) -> dict:
    """Scan MA contracts of a header: group -> contract (``@CO FIBERHMM-SCAN-MA:v1:<json>``)."""
    import json
    out = {}
    for comment in header.to_dict().get('CO', []) or []:
        text = str(comment)
        if text.startswith('FIBERHMM-SCAN-MA:v1:'):
            try:
                value = json.loads(text[len('FIBERHMM-SCAN-MA:v1:'):])
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get('group'), str):
                out[value['group']] = value
    return out


def _state_items(read, group: str, contracts: dict):
    """(AN name, state byte) of every interval of one MA group on a read."""
    if group not in contracts or not read.has_tag('MA'):
        return []
    ma = str(read.get_tag('MA'))
    aq = list(read.get_tag('AQ')) if read.has_tag('AQ') else []
    names = _parse_an(str(read.get_tag('AN'))) if read.has_tag('AN') else []
    out = []
    cursor_q = 0
    cursor_n = 0
    for section in ma.split(';')[1:]:
        head, _sep, body = section.partition(':')
        name, nq = _split_head(head)
        intervals = [x for x in body.split(',') if x] if body else []
        for _iv in intervals:
            if name == group and nq >= 1 and cursor_q < len(aq):
                out.append((names[cursor_n] if cursor_n < len(names) else '', aq[cursor_q]))
            cursor_q += nq
            cursor_n += 1
    return out


def _split_head(head: str):
    """MA section head 'name<strand><Q...>' -> (name, number of quality bytes)."""
    i = len(head)
    while i > 0 and head[i - 1] == 'Q':
        i -= 1
    nq = len(head) - i
    name = head[:i]
    if name and name[-1] in '+-.':
        name = name[:-1]
    return name, nq


def _parse_an(text: str):
    """AN:Z names, one per MA interval across sections, comma-separated; '.' is an unnamed interval."""
    return [tok if tok != '.' else '' for tok in text.split(',')] if text else []


def hub_feature_states(state, source: str, feature: dict):
    """``/api/features/states`` provider for hub refs: ``(states, datasets, label, span)``."""
    from .registry import find_set
    from .serve import find_hit
    found_set = find_set(state, source)
    if found_set is None:
        raise ValueError('The scan of this feature is not open in this session: open it in the Feature hub')
    scan, module, type_id = found_set
    decl = scan.type_decl(module, type_id) or {}
    if 'state' not in (decl.get('provides') or []):
        raise ValueError(f'{decl.get("plural") or type_id} have no per-read states')
    hit = find_hit(scan, module, feature['id'])
    if hit is None:
        raise ValueError(f'Hit {feature["id"]} is not in its scan')
    bound = _bindings(scan, feature.get('dataset_id'))
    if not bound:
        raise ValueError('No loaded dataset is bound to this scan (scan of other files): no per-read states')
    if scan.tables.has(f'{module}/states.tsv.bgz'):
        found = states_from_table(state, scan, module, hit, bound)
    else:
        found = states_from_annotated(state, scan, module, type_id, hit, bound)
    datasets = sorted({bid for bid, _via in bound.values()})
    label = hit.get('label') or feature['id']
    return _combine(found), datasets, f'{decl.get("label") or type_id} {label}'.strip(), (int(hit['start']), int(hit['end']))
