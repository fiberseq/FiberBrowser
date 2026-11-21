"""/api/cluster-regions prerequisites (DESIGN_GRAPH_PRIMARY §9, G0): the clustering capability, the window's
haplotype rule and strand in its working set, qualified id scopes, results keyed by the cohort identity, and the
joint cohort resolved before any row is indexed."""
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from models.domain import WorkingSet
from models.requests import PeakRegion
from services import correspondence_clustering as fc
from services.lift.cohort import _encode_identity, record_key
from state.browser_state import BrowserState


def aid(qname, record="r:0", row=0, group="lib"):
    return _encode_identity([f"{group}|{qname}", qname, record, row, "primary"])


def window(key, dataset="d", **kw):
    return fc.RegionViewport(dataset_id=dataset, result_key=key, chrom="chr1", start=100, end=300,
                             blocks=[fc.FrameBlock(frame=(0, 100), genomic=(100, 200))], **kw)


def request(views, method="combinatorial", **kw):
    return fc.RegionClusterRequest(viewports=views, peak_regions=[PeakRegion(start=0, end=100)], method=method, k=2, **kw)


@pytest.fixture
def state(monkeypatch):
    base = BrowserState(None)
    base.datasets = {"d": SimpleNamespace(data_type="bam"), "e": SimpleNamespace(data_type="bam")}
    base.dataset_order = ["d", "e"]
    calls = []

    def working(self, dataset_id, chrom, start, end, spanning=False, min_footprints=0, **kwargs):
        from services.lift.cohort import _scope
        calls.append(dict(dataset=dataset_id, scope=_scope.get(), read_ids=kwargs.get("read_ids")))
        reads = [dict(id=f"q{i}", analysis_id=aid(f"q{i}"), intervals=[[0, end - start, 0 if i % 2 else 147]],
                      source_path="/p/a.bam") for i in range(6)]
        return WorkingSet(reads, total_overlapping=6, total_spanning=6, chrom=chrom, start=start, end=end)

    monkeypatch.setattr(BrowserState, "build_working_set", working)
    return base, calls


def test_lift_hap_and_strand_reach_the_working_set_scope(state):
    base, calls = state
    fc.run(base, request([window("MAT", lift_hap="MAT"), window("PAT", lift_hap="PAT")]))
    assert [c["scope"][1] for c in calls] == ["MAT", "PAT"]
    assert all(c["scope"][0] == "analysis" for c in calls)


def test_results_are_keyed_by_the_cohort_identity(state):
    base, _ = state
    out = fc.run(base, request([window("a")]))
    assert set(out["results"]["a"]["assignments"]) == {aid(f"q{i}") for i in range(6)}
    assert out["results"]["a"]["analysis_read_count"] == 6


def test_qualified_id_scopes_select_by_cohort_identity_or_record_key(state):
    base, _ = state
    by_aid, by_record, by_name = window("a"), window("b"), window("c")
    by_aid.read_ids = [aid("q1")]
    by_record.read_ids = [record_key(aid("q2", row=1))]   # another row of the same record (a graph row's key)
    by_name.read_ids = ["q3"]
    out = fc.run(base, request([by_aid, by_record, by_name]))
    assert set(out["results"]["a"]["assignments"]) == {aid("q1")}
    assert set(out["results"]["b"]["assignments"]) == {aid("q2")}
    assert set(out["results"]["c"]["assignments"]) == {aid("q3")}


def test_shared_molecules_are_resolved_before_rows_are_indexed(state, monkeypatch):
    base, _ = state
    for d in base.datasets.values():
        d.molecule_groups = [["/p/a.bam", "shared"]]
        d.joint_dedup = "by_molecule"
    # Native rows share the provenance group: molecule identity is group + QNAME.
    seen = {}
    original = fc.cluster_compact_reads

    def cluster(reads, *args, **kwargs):
        seen["groups"] = [r["_cluster_group"] for r in reads]
        seen["fit"] = kwargs["fit_rows"]
        return original(reads, *args, **kwargs)

    monkeypatch.setattr(fc, "cluster_compact_reads", cluster)
    out = fc.run(base, request([window("first", dataset="e"), window("second", dataset="d")], method="kmeans"))
    # Every molecule is in both datasets: one row each survives (the winner by dataset id: d), in window order.
    assert out["joint_cohort"]["policy"] == "by_molecule" and out["joint_cohort"]["removed_rows"] == 6
    assert out["results"]["first"]["analysis_read_count"] == 0 and out["results"]["first"]["assignments"] == {}
    assert len(out["results"]["second"]["assignments"]) == 6
    assert seen["groups"] == ["second"] * 6
    assert max(seen["fit"]) < 6   # fit indices address the kept rows only


# ── Gate G0 on the AluY demo data (skipped without it) ─────────────────────────────────────────────────────────

PEAKS = [(128655000, 128655100), (128656200, 128656300), (128658000, 128658100), (128659000, 128659100)]


@pytest.fixture(scope="module")
def alu_state():
    bam, manifest = os.environ.get("FIBERBROWSER_TEST_LIFT_BAM", ""), os.environ.get("FIBERBROWSER_TEST_LIFT_MAP", "")
    if not (bam and manifest and Path(bam).is_file() and Path(manifest).is_file()):
        pytest.skip("Set FIBERBROWSER_TEST_LIFT_BAM and FIBERBROWSER_TEST_LIFT_MAP for the AluY gate")
    os.environ.setdefault("FIBERBROWSER_LIVE_LIFT", "1")
    from plugins import init_context
    from services.lift.registration import add_live_lift_dataset
    st = BrowserState(None, None, None, None)
    init_context(st)
    st.max_working_reads = 10000
    added = add_live_lift_dataset(st, paths=[bam], manifest=manifest, dataset_id="lifted")
    assert added["success"], added
    return st


@pytest.mark.parametrize("dedup", ["off", "by_molecule"])
def test_lifted_windows_cluster_through_cluster_regions_as_cluster_all(alu_state, dedup):
    from dataclasses import replace
    from models.requests import ClusterAllRequest
    from services.clustering_endpoint import run_cluster_all_endpoint
    st = alu_state
    cfg = st.datasets["lifted"].live_lift
    cfg.settings = replace(cfg.settings, joint_dedup=dedup)
    view = dict(chrom="chr3", start=128650000, end=128670000)
    regions = [dict(start=a, end=b, mode="accessibility") for a, b in PEAKS]
    windows = [dict(dataset_id="lifted", result_key=hap, lift_hap=hap, **view) for hap in ("MAT", "PAT")]
    linear = run_cluster_all_endpoint(state=st, req=ClusterAllRequest(dataset_ids=["lifted"], viewports=windows,
                                      peak_regions=regions, method="combinatorial", k=16), spanning=False, **view)
    # The same windows as identity-block region windows: one 100 bp feature per peak.
    req = fc.RegionClusterRequest(
        viewports=[fc.RegionViewport(**w, blocks=[fc.FrameBlock(feature=i, frame=(0, b - a), genomic=(a, b))
                                                   for i, (a, b) in enumerate(PEAKS)]) for w in windows],
        peak_regions=[PeakRegion(start=0, end=b - a, mode="accessibility") for a, b in PEAKS],
        method="combinatorial", k=16)
    regional = fc.run(st, req)
    for hap in ("MAT", "PAT"):
        a, b = linear["results"][hap]["assignments"], regional["results"][hap]["assignments"]
        assert a and set(a) == set(b), hap
        assert all(k.startswith("lift-cohort:v1 ") for k in b)
        # Combinatorial labels are the same partition (pattern numbering may differ between the endpoints).
        pairs = {(a[k], b[k]) for k in a}
        assert len(pairs) == len({x for x, _ in pairs}) == len({y for _, y in pairs}), hap
