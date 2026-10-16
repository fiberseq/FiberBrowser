"""Read-name sets registered for read requests: a read panel whose reads are a subset larger than a query string can
carry (a split panel, a large filter) registers the names once and asks for reads with `filter_set=<id>`.

Per session, content-addressed (the same names give the same id), the last MAX_SETS kept."""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict

MAX_SETS = 64
MAX_IDS = 500_000
_LOCK = threading.Lock()


def _registry(state) -> "OrderedDict[str, frozenset[str]]":
    with _LOCK:
        if 'read_sets' not in state.__dict__:
            state.__dict__['read_sets'] = OrderedDict()
        return state.__dict__['read_sets']


def register(state, ids) -> dict:
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise ValueError('ids must be a list of read names')
    if len(ids) > MAX_IDS:
        raise ValueError(f'At most {MAX_IDS:,} read names in a set')
    names = frozenset(i for i in ids if i)
    set_id = hashlib.sha1('\n'.join(sorted(names)).encode()).hexdigest()[:20]
    registry = _registry(state)
    with _LOCK:
        registry[set_id] = names
        registry.move_to_end(set_id)
        while len(registry) > MAX_SETS:
            registry.popitem(last=False)
    return dict(set_id=set_id, size=len(names))


def resolve(state, set_id: str) -> frozenset[str] | None:
    registry = _registry(state)
    with _LOCK:
        return registry.get(set_id)


def combine_filter(state, filter_ids: str | None, filter_set: str | None) -> str | list[str] | None:
    """filter_ids (comma-separated) narrowed to a registered set, as the exact names (a list: a name may hold a
    comma); KeyError if the set is unknown."""
    if not filter_set:
        return filter_ids
    names = resolve(state, filter_set)
    if names is None:
        raise KeyError(filter_set)
    if filter_ids:
        names = names & {i for i in filter_ids.split(',') if i}
    # A set that matches nothing still filters (to nothing), never to everything.
    return sorted(names) if names else [NO_READS]


NO_READS = '\u0000no-reads'
