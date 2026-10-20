"""retained_size: the per-sample seen sets of large sequences are layered on
their ancestors' sets instead of copied (copying made a cache insertion
quadratic in the objects already walked); the estimate must not change."""
import random
import sys

import numpy as np

from services.byte_cache import _ATOMIC_TYPES, retained_size


def _reference(value, seen=None):
    """The estimate as it was defined with copied seen sets."""
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return 0
    seen.add(identity)
    if type(value) in _ATOMIC_TYPES:
        return sys.getsizeof(value)
    if hasattr(value, 'retained_bytes'):
        return int(value.retained_bytes)
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        items = (item for pair in value.items() for item in pair)
    elif isinstance(value, (list, tuple, set, frozenset)):
        if isinstance(value, (list, tuple)) and len(value) > 64:
            total = 0
            for i in range(64):
                item = value[i * (len(value) - 1) // 63]
                if type(item) in _ATOMIC_TYPES:
                    if id(item) not in seen:
                        total += sys.getsizeof(item)
                else:
                    total += _reference(item, seen.copy())
            return size + int(total * len(value) / 64)
        items = value
    else:
        if hasattr(value, 'nbytes'):
            size += _reference(value.base, seen) if getattr(value, 'base', None) is not None else 0
        elif hasattr(value, '__dict__'):
            size += _reference(vars(value), seen)
        return size
    for item in items:
        if type(item) in _ATOMIC_TYPES:
            identity = id(item)
            if identity not in seen:
                seen.add(identity)
                size += sys.getsizeof(item)
        else:
            size += _reference(item, seen)
    return size


class _Sized:
    retained_bytes = 4096


class _Plain:
    def __init__(self, payload):
        self.payload = payload


def _structures():
    rng = random.Random(7)
    shared = [rng.random() for _ in range(300)]
    base = np.arange(1000)
    reads = [{'id': f'r{i}', 'intervals': [[rng.randrange(10**6), rng.randrange(500), 255] for _ in range(rng.randrange(0, 150))],
              'shared': shared, 'view': base[i:], 'obj': _Plain([shared, i]), 'sized': _Sized(),
              'nested': [[shared, [rng.random() for _ in range(rng.randrange(0, 90))]] for _ in range(rng.randrange(0, 80))]}
             for i in range(200)]
    yield reads
    yield {'a': reads, 'b': (reads[:10], reads[5:150]), 'c': reads}
    yield [reads[i % 7] for i in range(500)]
    yield (shared, [shared] * 100, {'x': [shared] * 65})
    yield [list(range(n)) for n in range(130)]


def test_estimate_unchanged():
    for value in _structures():
        assert retained_size(value) == _reference(value)


def test_ancestor_sets_are_not_copied():
    # A sample's walk must never copy the parent's set (the quadratic cost).
    copies = []
    real_set = set

    class _Spy(real_set):
        def copy(self):
            copies.append(len(self))
            return real_set.copy(self)

    big = [[[j, float(j)] for j in range(100)] for _ in range(100)]
    retained_size(big, _Spy())
    assert copies == []
