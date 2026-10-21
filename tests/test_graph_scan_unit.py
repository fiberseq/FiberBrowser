"""Graph peak scanning without the helper (graph features, item 3; Codex review, group B): a folded molecule with
records on two paths of one dataset counts once, as graph clustering fits it once."""
from __future__ import annotations

import types

from services.graph_panel import columns as gc
from services.graph_panel import scan as gscan
from services.lift.cohort import _encode_identity


def test_a_folded_molecule_counts_once_in_a_graph_scan(monkeypatch):
    width = 300
    carried = {u: (1000 + u, False) for u in range(width)}
    cols = types.SimpleNamespace(features=[], carried={"A": dict(carried), "B": dict(carried)}, walk=[True] * width, report={})
    monkeypatch.setattr(gscan.gc, "region_columns", lambda *a, **k: cols)
    monkeypatch.setattr(gscan.gc, "merge_occurrences", lambda *a, **k: {})
    folded = _encode_identity(["lib|m1", "m1", None, None, "primary"])
    body = [[0, width, 0, "+", True]]

    def rows(state, source, a, b, cache=None):
        sup = source.binding == "pat"
        # The primary's row (path A) is accessible over the window, the supplementary's (path B) a nucleosome.
        return ([dict(id="m1", analysis_id=folded, intervals=[[0, b - a, 147 if sup else 40]],
                      live_lift={"source": {"supplementary": sup}, "segments": body})], {})
    monkeypatch.setattr(gscan, "graph_window_rows", rows)
    spec = {"target": "t", "regions": [{"start": 0, "end": width}], "binding_order": ["t", "mat", "pat"],
            "observations": [dict(id="A", dataset_id="d", kind="graph", binding="mat", contig="cM", read_ids=None, strand=None),
                             dict(id="B", dataset_id="d", kind="graph", binding="pat", contig="cP", read_ids=None, strand=None)]}
    out = gscan.scan(types.SimpleNamespace(), None, {"scan": {"signal_source": "accessibility", "min_reads": 1,
                                                              "threshold_rare": 0.01}}, {}, spec)
    assert out["n_reads"] == 1
    assert out["columns"]["observations"] == {"A": 1, "B": 0}
    assert out["peaks"] and out["peaks"][0]["score"] > 0.9   # the primary's open row alone, not half of it
