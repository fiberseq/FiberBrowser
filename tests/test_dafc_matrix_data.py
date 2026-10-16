import asyncio
from types import SimpleNamespace

import numpy as np

from routers import dafc


def test_dafc_matrix_data_exports_off_diagonal_numeric_input(monkeypatch):
    clr = SimpleNamespace(chromsizes={"chr2L": 10_000})
    state = SimpleNamespace(
        clr=clr,
        current_resolution=10,
        resolutions=[10],
        cool_file="contacts.cool",
        chrom_expected_cache={},
    )
    calls = []

    monkeypatch.setattr(dafc, "_load_cooler_modules", lambda: (object(), object()))
    monkeypatch.setattr(dafc, "cooler_at_resolution", lambda state, *_args: (state, 10))
    monkeypatch.setattr(dafc, "_resolve_cooler_chrom", lambda _state, chrom: chrom)

    def fake_fetch(_clr, row_region, column_region, *, balance=False):
        calls.append((row_region, column_region, balance))
        return np.array([[1.0, 2.0], [3.0, 4.0]])

    monkeypatch.setattr(dafc, "fetch_cooler_matrix", fake_fetch)

    result = asyncio.run(dafc.dafc_matrix_data(
        chrom="chr2L", start=100, end=320, resolution=10,
        x_start=100, x_end=120, y_start=300, y_end=320,
        normalization="none", dafc_state=state,
    ))

    assert calls == [("chr2L:300-320", "chr2L:100-120", False)]
    assert result["matrix"] == [[1.0, 2.0], [3.0, 4.0]]
    assert result["n_rows"] == 2
    assert result["n_columns"] == 2
    assert result["x_start"] == 100
    assert result["y_start"] == 300
    assert result["resolution"] == 10
