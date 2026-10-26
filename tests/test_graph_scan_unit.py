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


def _setup(monkeypatch, width=300):
    carried = {u: (1000 + u, False) for u in range(width)}
    cols = types.SimpleNamespace(features=[], carried={"A": dict(carried), "B": dict(carried)}, walk=[True] * width, report={})
    monkeypatch.setattr(gscan.gc, "region_columns", lambda *a, **k: cols)
    monkeypatch.setattr(gscan.gc, "merge_occurrences", lambda *a, **k: {})


def test_a_folded_primary_outside_the_usable_columns_never_displaces_its_supplementary(monkeypatch):
    """Codex review (group B round 2): the primary record's row lies outside its path's usable columns (an excluded
    repeat): the supplementary, which covers the target columns, is the molecule's row."""
    width = 300
    _setup(monkeypatch, width)
    folded = _encode_identity(["lib|m1", "m1", None, None, "primary"])

    def rows(state, source, a, b, cache=None):
        sup = source.binding == "pat"
        body = [[0, width, 0, "+", True]] if sup else [[width + 100, width + 200, 0, "+", True]]
        return ([dict(id="m1", analysis_id=folded, intervals=[[body[0][0], body[0][1], 40 if sup else 147]],
                      live_lift={"source": {"supplementary": sup}, "segments": body})], {})
    monkeypatch.setattr(gscan, "graph_window_rows", rows)
    spec = {"target": "t", "regions": [{"start": 0, "end": width}], "binding_order": ["t", "mat", "pat"],
            "observations": [dict(id="A", dataset_id="d", kind="graph", binding="mat", contig="cM", read_ids=None, strand=None),
                             dict(id="B", dataset_id="d", kind="graph", binding="pat", contig="cP", read_ids=None, strand=None)]}
    out = gscan.scan(types.SimpleNamespace(), None, {"scan": {"signal_source": "accessibility", "min_reads": 1, "threshold_rare": 0.01}}, {}, spec)
    assert out["columns"]["observations"] == {"A": 0, "B": 1}
    assert out["peaks"] and out["peaks"][0]["score"] > 0.9


def test_a_molecule_shared_by_two_datasets_follows_their_joint_policy(monkeypatch):
    """Codex review (group B round 2): with joint_dedup by_molecule on both datasets, a molecule in both counts once."""
    width = 300
    _setup(monkeypatch, width)
    body = [[0, width, 0, "+", True]]

    def rows(state, source, a, b, cache=None):
        aid = _encode_identity(["grp|m1", "m1", "r", 0, "primary"])
        return ([dict(id="m1", analysis_id=aid, intervals=[[0, width, 40]],
                      live_lift={"molecule": "grp|m1", "source": {"supplementary": False}, "segments": body})], {})
    monkeypatch.setattr(gscan, "graph_window_rows", rows)
    settings = types.SimpleNamespace(molecule_groups=[["x.bam", "grp"]], joint_dedup="by_molecule")
    ds = {k: types.SimpleNamespace(id=k, data_type="bam_livelift", live_lift=types.SimpleNamespace(settings=settings)) for k in ("d1", "d2")}
    state = types.SimpleNamespace(get_dataset=ds.get, datasets=ds)
    spec = {"target": "t", "regions": [{"start": 0, "end": width}], "binding_order": ["t", "mat"],
            "observations": [dict(id="A", dataset_id="d1", kind="graph", binding="mat", contig="cM", read_ids=None, strand=None),
                             dict(id="B", dataset_id="d2", kind="graph", binding="mat", contig="cM", read_ids=None, strand=None)]}
    out = gscan.scan(state, None, {"scan": {"signal_source": "accessibility", "min_reads": 1, "threshold_rare": 0.01}}, {}, spec)
    assert out["n_reads"] == 1


def test_a_repeated_or_unresolved_lack_is_never_not_a_carrier():
    """Codex review (group B round 3): -2 needs proven absence; repeated, unresolved or target-unresolved columns in
    the region leave the path out instead."""
    from services.graph_panel import analysis
    spec = {"target": "t", "regions": [{"start": 0, "end": 50}],
            "observations": [dict(id="P", dataset_id="d", kind="graph", binding="pat", contig="cP", read_ids=None, strand=None)]}
    for report in ({"absent": {"P": 30}, "repeats": {"P": 20}}, {"absent": {"P": 30}, "unresolved": {"P": 5}},
                   {"absent": {"P": 30}, "target_unresolved": 3}, {"repeats": {"P": 50}}):
        rc = types.SimpleNamespace(carried={}, report=report)
        assert analysis._absent_path_labels(None, spec, {}, [rc], "P", {}) == {}


def test_rows_of_one_dataset_in_two_observations_count_once(monkeypatch):
    """agy review (group B round 2): a pooled panel and a strand panel of one dataset are two observations over the
    same rows: each row counts once."""
    width = 300
    _setup(monkeypatch, width)
    body = [[0, width, 0, "+", True]]
    monkeypatch.setattr(gscan, "graph_window_rows", lambda state, source, a, b, cache=None: (
        [dict(id="r1", analysis_id=_encode_identity(["g|r1", "r1", "x", 0, "primary"]), intervals=[[0, b - a, 40]],
              live_lift={"source": {"supplementary": False}, "segments": body})], {}))
    spec = {"target": "t", "regions": [{"start": 0, "end": width}], "binding_order": ["t", "mat"],
            "observations": [dict(id="A", dataset_id="d", kind="graph", binding="mat", contig="cM", read_ids=None, strand=None),
                             dict(id="B", dataset_id="d", kind="graph", binding="mat", contig="cM", read_ids=None, strand=None)]}
    out = gscan.scan(types.SimpleNamespace(), None, {"scan": {"signal_source": "accessibility", "min_reads": 1, "threshold_rare": 0.01}}, {}, spec)
    assert out["n_reads"] == 1


def test_native_records_sharing_a_qname_both_count_and_count_once_across_observations(monkeypatch):
    """Codex review (group G): two native records with one QNAME (two libraries) covering opposite halves of the
    window are two records; a second observation of the same dataset adds nothing."""
    width = 1000
    carried = {u: (u, False) for u in range(width)}
    cols = types.SimpleNamespace(features=[], carried={"N": dict(carried), "M": dict(carried)}, walk=[True] * width, report={})
    monkeypatch.setattr(gscan.gc, "region_columns", lambda *a, **k: cols)
    monkeypatch.setattr(gscan.gc, "merge_occurrences", lambda *a, **k: {})

    def rec(lib, a, b):
        return dict(id="q1", library_id=lib, record_sha256=f"sha{lib}", alignment_occurrence=0, reference_start=a,
                    reference_end=b, alignment_orientation="forward", start=a, end=b, intervals=[[a, b, 40]])

    class Query:
        @classmethod
        def from_request(cls, *a, **k):
            return cls()

        def build_working_set(self, state, dataset_id):
            return types.SimpleNamespace(reads=[rec(0, 0, 500), rec(1, 500, 1000)])
    import services.analysis_query as aq
    monkeypatch.setattr(aq, "AnalysisReadQuery", Query)
    spec = {"target": "t", "regions": [{"start": 0, "end": width}], "binding_order": ["t"],
            "observations": [dict(id="N", dataset_id="n", kind="linear", binding="t", chrom="chr", read_ids=None, strand=None),
                             dict(id="M", dataset_id="n", kind="linear", binding="t", chrom="chr", read_ids=None, strand=None)]}
    out = gscan.scan(types.SimpleNamespace(), None, {"start": 0, "end": width, "scan": {"signal_source": "accessibility",
                     "min_reads": 1, "threshold_rare": 0.01}}, {}, spec)
    assert out["n_reads"] == 2
    assert out["columns"]["observations"] == {"N": 2, "M": 0}


def test_joint_dedup_datasets_names_the_datasets_whose_rows_the_joint_policy_drops():
    """Codex review (group G): a native dataset sharing a provenance group with a lifted one under joint_dedup
    by_molecule is scanned row by row (its cached counts would bypass the deduplication); otherwise none are."""
    from services.lift.joint import joint_dedup_datasets
    lifted = types.SimpleNamespace(settings=types.SimpleNamespace(molecule_groups=[["x.bam", "grp"]], joint_dedup="by_molecule"))
    ds = {"lift": types.SimpleNamespace(live_lift=lifted),
          "nat": types.SimpleNamespace(live_lift=None, molecule_groups=[["x.bam", "grp"]], joint_dedup="by_molecule"),
          "other": types.SimpleNamespace(live_lift=None, molecule_groups=[["y.bam", "g2"]], joint_dedup="by_molecule"),
          "off": types.SimpleNamespace(live_lift=None, molecule_groups=[["x.bam", "grp"]], joint_dedup="off")}
    state = types.SimpleNamespace(get_dataset=ds.get)
    assert joint_dedup_datasets(state, ["lift", "nat", "other"]) == {"lift", "nat"}
    assert joint_dedup_datasets(state, ["lift", "off"]) == set()
    assert joint_dedup_datasets(state, ["nat", "other"]) == set()
