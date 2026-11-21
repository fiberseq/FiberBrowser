"""Regularity tiles or patches computed for a view drop only the cached rows that carry them (nucreg, nucpatch, or
every layer): the panels' ordinary rows stay warm, so the next read request is not a cold decode."""
from __future__ import annotations

from services.dataset_generation import dataset_generation
from services.working_sets import make_working_cache_key


def _state():
    from state.browser_state import BrowserState
    st = BrowserState(None)
    st._broad_cache = {}
    st._working_set_cache = {}
    return st


def _broad(ds, layers):
    # Broad-cache keys carry the layer key in their sixth field (working_sets.broad_cache_layer_key).
    return (ds, 'chr1', 0, 1000, True, layers)


def _working(ds, layers):
    return make_working_cache_key(ds, 'chr1', 0, 1000, False, 0, 0, False, layers, [])


def test_layer_scoped_invalidation_keeps_rows_without_those_layers():
    from services.dataset_registration import invalidate_dataset_layer_caches
    st = _state()
    keep = [_broad('a', ('nuc', 'tf')), _broad('a', ()), _broad('b', None), _broad('b', ('nucreg',))]
    drop = [_broad('a', None), _broad('a', ('nuc', 'nucreg', 'tf')), _broad('a', ('nucpatch',))]
    for k in keep + drop:
        st._broad_cache[k] = ([], 0)
    wkeep = [_working('a', ('nuc', 'nucseg', 'nucsz', 'tf')), _working('a', ()), _working('b', ('nucreg',))]
    wdrop = [_working('a', None), _working('a', ('nuc', 'nucreg')), _working('a', ('nucpatch', 'tf'))]
    for k in wkeep + wdrop:
        st._working_set_cache[k] = ([], 0)
    generation = dataset_generation(st, 'a')
    assert invalidate_dataset_layer_caches(st, 'a', ('nucreg', 'nucpatch')) == len(drop) + len(wdrop)
    assert sorted(map(repr, st._broad_cache)) == sorted(map(repr, keep))
    assert sorted(map(repr, st._working_set_cache)) == sorted(map(repr, wkeep))
    assert dataset_generation(st, 'a') == generation
    assert invalidate_dataset_layer_caches(st, 'a', ()) == 0


def test_refresh_after_regularity_keeps_ordinary_rows_and_calls_drop_everything(monkeypatch):
    from services.nuc import inputs, jobs, layers
    st = _state()
    monkeypatch.setattr(inputs, 'datasets_using', lambda _state, _path: ['a'])
    monkeypatch.setattr(layers, 'declare_layers', lambda *_a, **_k: None)
    ordinary, regular = _working('a', ('nuc', 'tf')), _working('a', ('nuc', 'nucreg', 'tf'))
    st._working_set_cache.update({ordinary: ([], 0), regular: ([], 0)})
    assert jobs.refresh_after(st, ['/x.bam'], jobs.REGULARITY_LAYERS) == ['a']
    assert list(st._working_set_cache) == [ordinary]
    # Nucleosome calls computed (an Analyse): every cached row goes, as before.
    assert jobs.refresh_after(st, ['/x.bam']) == ['a']
    assert st._working_set_cache == {}
