"""Round 13 (partial reviews): Micro-C strip allocation is bounded before it happens."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


def _strip_state(monkeypatch, fetched):
    import routers.microc as microc

    def fake_fetch(clr, region, balance=False, **_kw):
        fetched.append(region)
        return np.ones((10, 10))

    state = SimpleNamespace(clr=object(), current_resolution=1000, resolutions=[1000])
    monkeypatch.setattr(microc, "_load_cooler_module", lambda: object())
    monkeypatch.setattr(microc, "_resolve_cooler_chrom", lambda st, c: c)
    monkeypatch.setattr(microc, "cooler_at_resolution", lambda st, r, m: (st, 1000))
    monkeypatch.setattr(microc, "fetch_cooler_matrix", fake_fetch)
    return microc, state


def _strip(microc, state, **kw):
    params = dict(chrom="chr1", start=0, end=10_000, max_distance=100_000, resolution=None,
                  width=100, height=20, scaling="log", colormap="fall", normalization="none",
                  focus_start=None, focus_end=None, dafc_state=state)
    params.update(kw)
    return asyncio.run(microc.get_matrix_strip(**params))


def test_strip_clamps_max_distance_to_the_region(monkeypatch):
    fetched = []
    microc, state = _strip_state(monkeypatch, fetched)
    allocations = []
    real_zeros = np.zeros

    def spy_zeros(shape, *a, **k):
        allocations.append(shape)
        return real_zeros(shape, *a, **k)

    monkeypatch.setattr(microc.np, "zeros", spy_zeros)
    # A billion-bp max_distance at 1 kb used to allocate a 1,000,000 x 10 strip.
    resp = _strip(microc, state, max_distance=1_000_000_000)
    assert resp.media_type == "image/png"
    assert allocations and max(a[0] for a in allocations) <= 10


def test_strip_refuses_an_oversized_region_before_allocating(monkeypatch):
    from fastapi import HTTPException

    fetched = []
    microc, state = _strip_state(monkeypatch, fetched)
    with pytest.raises(HTTPException) as exc:
        _strip(microc, state, start=0, end=10_000_000)  # 10,000 bins at 1 kb
    assert exc.value.status_code == 413
    assert fetched == []
