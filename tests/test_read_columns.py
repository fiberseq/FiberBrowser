"""Read row format 2: ``IntColumn`` fields read as the lists they stand for,
and every consumer that knows the type (the binary wire, JSON responses, the
cache sizer, read bounds, the display index) gives exactly what it gives for
the lists."""
import copy
import pickle
import random

import numpy as np
import pytest

from services.read_columns import IntColumn, as_list, has_columns, plain, wrap


def _col(values, width=None):
    a = np.asarray(values, dtype=np.int64)
    if width is not None:
        a = a.reshape(-1, width)
    return IntColumn(a)


def test_list_behaviour():
    ivs = [[1, 5, 4], [7, 9, -2], [9, 30, 21]]
    c = _col(ivs, 3)
    assert len(c) == 3 and bool(c) and not _col([], 3) and not _col([])
    assert list(c) == ivs and c.tolist() == ivs and c == ivs and ivs == c and c != ivs[:2]
    assert c != tuple(ivs) and c != "x"
    assert c[0] == [1, 5, 4] and c[-1] == [9, 30, 21] and c[1:] == ivs[1:] and type(c[1:]) is list
    assert type(c[0][0]) is int and all(type(v) is int for iv in c for v in iv)
    assert c + [[0, 1, 1]] == ivs + [[0, 1, 1]] and [[0, 1, 1]] + c == [[0, 1, 1]] + ivs
    assert c + c == ivs + ivs
    assert [1, 5, 4] in c and c.index([7, 9, -2]) == 1 and c.count([9, 30, 21]) == 1
    assert sorted(c, key=lambda iv: -iv[0])[0] == [9, 30, 21]
    assert repr(c) == repr(ivs)
    with pytest.raises(TypeError):
        hash(c)
    with pytest.raises(TypeError):
        c[0] = [0, 0, 0]
    with pytest.raises(AttributeError):
        c.append([0, 0, 0])
    # Values read are fresh: changing one never changes the column.
    first = c[0]
    first[0] = 99
    assert c[0][0] == 1
    marks = _col([3, 8, 12])
    assert marks == [3, 8, 12] and marks[1] == 8 and type(marks[1]) is int and sum(marks) == 23
    assert np.asarray(marks).dtype == np.int64 and np.asarray(c, dtype=float).shape == (3, 3)
    assert _col([], 3) == [] and _col([]) == _col([], 3)
    with pytest.raises(TypeError):
        IntColumn(np.array([1.5]))
    with pytest.raises(ValueError):
        c.array[0, 0] = 5  # read-only


def test_pickle_copy_and_helpers():
    window = np.arange(30, dtype=np.int64).reshape(10, 3)
    window.flags.writeable = False
    c = wrap(window[2:5])
    back = pickle.loads(pickle.dumps(c, protocol=5))
    assert type(back) is IntColumn and back == c and back.array.base is None or back.array.base is not window
    assert copy.deepcopy(c) is c and copy.copy(c) is c
    row = {"intervals": c, "layers": {"nuc": {"intervals": c, "qualities": [[1, 2, 3]]}}, "methyl": _col([4, 5])}
    flat = plain(row)
    assert flat == {"intervals": c.tolist(), "layers": {"nuc": {"intervals": c.tolist(), "qualities": [[1, 2, 3]]}},
                    "methyl": [4, 5]}
    assert has_columns(row) and not has_columns(flat) and as_list(c) == c.tolist() and as_list(flat) is flat


def test_json_responses():
    from fastapi.encoders import jsonable_encoder
    from utils.responses import ORJSONResponse
    import json

    payload = {"reads": [{"intervals": _col([[1, 2, 1]], 3), "methyl": _col([5])}]}
    want = {"reads": [{"intervals": [[1, 2, 1]], "methyl": [5]}]}
    assert json.loads(ORJSONResponse(payload).body) == want
    assert jsonable_encoder(payload) == want


def _random_payload(rng):
    """A compact-read payload (lists) with every shape a field can take."""
    def ivs(n, w=3):
        return [[rng.randrange(-3, 70000) for _ in range(w)] for _ in range(n)]

    reads = []
    for i in range(rng.randrange(0, 9)):
        r = {"id": f"r{i}", "reference_start": rng.randrange(0, 100), "reference_end": rng.randrange(100, 300)}
        if rng.random() < 0.9:
            r["intervals"] = ivs(rng.choice([0, 1, 3, 40]))
        if rng.random() < 0.6:
            r["fire"] = ivs(rng.choice([0, 2, 5]))
        if rng.random() < 0.2:
            r["fire"] = None
        if rng.random() < 0.7:
            r["methyl"] = [rng.randrange(0, 1 << rng.choice([7, 15, 31, 33])) for _ in range(rng.choice([0, 1, 9]))]
        if rng.random() < 0.1:
            r["methyl"] = [1.5, 2.0]
        if rng.random() < 0.1:
            r["intervals"] = [[1, 2], [3, 4, 5]]  # ragged lists stay lists
        layers = {}
        for name in rng.sample(["nuc", "msp", "tf"], rng.randrange(0, 3)):
            layers[name] = {"intervals": ivs(rng.choice([0, 2, 7])), "quality_names": ["nq"],
                            "qualities": [[rng.randrange(0, 255) for _ in range(3)]]}
        if layers or rng.random() < 0.3:
            r["layers"] = layers
        if rng.random() < 0.4:
            r["live_lift"] = {"v": 1, "insertions": {f"ins{j}": {
                "intervals": ivs(rng.choice([0, 4])), "methyl_m6a": [rng.randrange(0, 50)], "pos": 3}
                for j in range(rng.randrange(0, 3))}}
        reads.append(r)
    return {"dataset_id": "d", "reads": reads, "_read_bounds": [[0, 1]] * len(reads)}


_INT_FIELDS = {"intervals": 3, "fire": 3, "methyl": None, "methyl_m6a": None}


def _with_columns(value, rng, key=None):
    """``value`` with most int fields turned into IntColumns (as dict values only)."""
    if isinstance(value, dict):
        return {k: _with_columns(v, rng, k) for k, v in value.items()}
    if key in _INT_FIELDS and isinstance(value, list) and rng.random() < 0.8:
        try:
            exact = np.asarray(value)
        except ValueError:  # ragged
            return value
        if value and exact.dtype != np.int64:
            return value
        return _col(value, _INT_FIELDS[key])
    if isinstance(value, list):
        return [_with_columns(v, rng) for v in value]
    return value


def test_binary_wire_is_identical_for_columns_and_lists():
    from services.read_binary import encode_reads

    for seed in range(600):
        rng = random.Random(seed)
        lists = _random_payload(rng)
        with_cols = _with_columns(lists, rng)
        assert plain(with_cols) == lists
        assert encode_reads(with_cols) == encode_reads(lists), seed
        other = _random_payload(rng)
        multi = {"datasets": {"a": with_cols, "b": _with_columns(other, rng)}}
        assert encode_reads(multi) == encode_reads({"datasets": {"a": lists, "b": other}}), seed
    assert seen_columns(600) > 1000


def seen_columns(n):
    count = 0
    for seed in range(n):
        rng = random.Random(seed)
        count += sum(1 for _ in _iter_columns(_with_columns(_random_payload(rng), rng)))
    return count


def _iter_columns(value):
    if type(value) is IntColumn:
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _iter_columns(v)
    elif isinstance(value, list):
        for v in value:
            yield from _iter_columns(v)


def test_read_bounds_and_display_index():
    from services.packed_reads import ReadDisplayIndex, compact_read_bounds

    rng = random.Random(3)
    for _ in range(200):
        lists = []
        for _ in range(rng.randrange(1, 6)):
            r = {"id": "x", "intervals": [[a, a + rng.randrange(-2, 50), 1] for a in
                                          (rng.randrange(0, 500) for _ in range(rng.randrange(0, 12)))]}
            if rng.random() < 0.5:
                r["fire"] = [[a, a + 5, 5] for a in (rng.randrange(0, 900) for _ in range(rng.randrange(0, 4)))]
            if rng.random() < 0.5:
                r["layers"] = {"nuc": {"intervals": [[a, a + 147, 147] for a in (rng.randrange(0, 900) for _ in range(3))]}}
            lists.append(r)
        cols = [{k: (_col(v, 3) if k in ("intervals", "fire") else
                     {n: dict(l, intervals=_col(l["intervals"], 3)) for n, l in v.items()} if k == "layers" else v)
                 for k, v in r.items()} for r in lists]
        for a, b in zip(cols, lists):
            assert compact_read_bounds(a) == compact_read_bounds(b)
            vs = rng.randrange(0, 600)
            assert compact_read_bounds(a, vs, vs + 100) == compact_read_bounds(b, vs, vs + 100)
        ia, ib = ReadDisplayIndex(cols), ReadDisplayIndex(lists)
        assert np.array_equal(ia.segments, ib.segments) and np.array_equal(ia.bounds, ib.bounds)
        assert np.array_equal(ia.group_segments, ib.group_segments) and ia.group_names == ib.group_names


def test_retained_size_counts_the_array():
    from services.byte_cache import retained_size

    c = _col(list(range(3000)), 3)
    assert retained_size(c) == c.array.nbytes + 112
