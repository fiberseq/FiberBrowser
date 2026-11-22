"""Quantify a window, headless: a window relative to the meta-locus site gives the same bounds as the same window in
genome bp on the meta contig (meta_locus_numbers._bounds, the twin of spec.ts effectiveBounds with the site anchor at
x = flank, '+'), and a gene-relative window is refused rather than read as genome positions."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from services import window_quant as wq
from services.meta_locus_numbers import NumbersError, _bounds


VIEW = {"chrom": "meta:p1", "start": 0, "end": 4000}


def test_relative_window_equals_genome_window_on_the_meta_contig():
    spec = wq.normalize_spec({"bounds": "window"})
    meta = SimpleNamespace(flank=2000)
    rel = _bounds(spec, [-100, 200], VIEW, meta, True)
    raw = _bounds(spec, [1900, 2200], VIEW, meta, False)
    assert rel == raw == {"from": 1900, "to": 2200, "kind": "window", "windowMissing": False}


def test_relative_window_is_clipped_to_the_view_like_the_browser():
    spec = wq.normalize_spec({"bounds": "window"})
    meta = SimpleNamespace(flank=2000)
    assert _bounds(spec, [-2500, -1900], VIEW, meta, True) == {"from": 0, "to": 100, "kind": "window", "windowMissing": False}
    # Entirely outside: the whole view, said as a missing window (as effectiveBounds).
    assert _bounds(spec, [2100, 2500], VIEW, meta, True)["windowMissing"] is True


def test_relative_window_without_a_meta_locus_is_refused():
    spec = wq.normalize_spec({"bounds": "window"})
    with pytest.raises(NumbersError):
        _bounds(spec, [-100, 200], {"chrom": "chr19", "start": 0, "end": 4000}, None, True)
