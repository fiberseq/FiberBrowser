"""Drift test, Python side: what the headless meta-locus and Quantify paths say they handle, they really read.

The frontend half (browser/frontend/src/features/metaLocus/headlessCoverage.test.ts) fails when the browser saves a
meta-locus or Quantify field that the Python tables neither handle nor list as not drawn. This half fails when a
field listed as handled is no longer read, so the tables cannot claim coverage the code does not give.
"""
from __future__ import annotations

import inspect

from services import meta_locus_numbers as numbers
from services import window_quant as wq
from services.figure import meta_locus as ml
from services.figure import recluster


def test_every_handled_meta_locus_session_field_reaches_the_pool_or_the_view():
    saved = {"bed_path": "/x/sites.bed", "name": "sites", "anchor": "end", "flank_bp": 1234, "policy": "nearest",
             "count_unit": "molecule", "dataset_ids": ["a", "b"], "seed": 7, "count": 321,
             "extra_entries": [["a", "r1", 2]], "pool_id": "abc", "lastRealLocus": {"chrom": "chr1", "start": 1, "end": 2}}
    assert set(saved) == set(ml.SESSION_FIELDS_HANDLED) | set(ml.SESSION_FIELDS_NOT_DRAWN)
    spec = ml.spec_from_session(saved)
    assert spec == {"bed": "/x/sites.bed", "name": "sites", "anchor": "end", "flank_bp": 1234, "policy": "nearest",
                    "count_unit": "molecule", "dataset_ids": ["a", "b"], "seed": 7, "count": 321,
                    "extra_entries": [["a", "r1", 2]]}
    # pool_id: the saved contig, renamed everywhere the session names it.
    assert 'saved.get("pool_id")' in inspect.getsource(ml._session_meta_chroms)
    assert "_session_meta_chroms(session)" in inspect.getsource(ml.resolve)
    # The payload the re-clustered session saves has every field the browser saves.
    payload_keys = set(inspect.getsource(recluster.meta_session_payload).split("return {", 1)[1].split("}", 1)[0]
                       .replace('"', " ").split()) & set(saved)
    assert payload_keys == set(saved)


def test_every_handled_quantify_session_field_is_read():
    src = inspect.getsource(numbers.quant_inputs) + inspect.getsource(numbers._quant_inputs) + inspect.getsource(numbers._saved_quant)
    for field in numbers.WINDOW_QUANT_SESSION_HANDLED:
        assert f'saved.get("{field}")' in src or f'saved["{field}"]' in src, field


def test_every_quantspec_field_is_normalized_by_the_twin():
    assert set(wq.normalize_spec({})) == set(wq.DEFAULT_SPEC)
    assert set(numbers.QUANT_SPEC_NOT_COMPUTED) <= set(wq.DEFAULT_SPEC)
    computed = set(wq.DEFAULT_SPEC) - set(numbers.QUANT_SPEC_NOT_COMPUTED)
    engine = inspect.getsource(numbers) + inspect.getsource(wq)
    for field in computed - {"measures"}:
        assert f'"{field}"' in engine.split("DEFAULT_SPEC = {", 1)[1].split("}", 1)[1], field


def test_meta_hidden_rows_match_the_browser_list():
    for kind in ("sequence", "gene", "primer", "microc", "sv", "capture", "ortho-x"):
        assert ml.meta_hidden_track(kind)
    for kind in ("axis", "fire", "reads", "coverage", "consensus", "coacc"):
        assert not ml.meta_hidden_track(kind)
    assert ml.meta_hidden_track("composite-motifs") and not ml.meta_hidden_track("composite-x", True)
