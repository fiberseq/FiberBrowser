"""Graph clustering with the real graph helper (graph primary G2/G4/G5, DESIGN_GRAPH_PRIMARY §2.3–2.6, §3.4–3.5).

Toy packages (skipped without FIBERBROWSER_TEST_GRAPH_HELPER / FIBERBROWSER_TEST_GRAPH_PACKAGES): columns from fixed
tiles on the ``flip`` inversion and the ``alu`` insertion. The HG002 AluY demo (skipped without
FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_BAM, FIBERBROWSER_TEST_LIFT_MAP and, for the mixed run,
FIBERBROWSER_TEST_LIFT_NATIVE): graph clustering of the two haplotypes against linear clustering of the same reads,
a native-only run against ``cluster_all``, permutation invariance, refinement within carriers, and the durable model.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from services.graph_panel import analysis, columns as gc, service
from services.graph_panel.worker import LIVE_PIDS

HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
PACKAGES = [p for p in os.environ.get("FIBERBROWSER_TEST_GRAPH_PACKAGES", "").split(os.pathsep) if p.strip()]
HPRC = os.environ.get("FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE", "").strip()
pytestmark = pytest.mark.skipif(not (HELPER and os.path.isfile(HELPER)), reason="set FIBERBROWSER_TEST_GRAPH_HELPER")


@pytest.fixture(scope="module")
def helper_env(tmp_path_factory):
    """One registry for the module (a package is verified once: the HPRC one takes ~20 s); every test runs its
    requests on its own loop and closes that loop's helper pool (``arun``)."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("FIBERBROWSER_GRAPH_HELPER", HELPER)
        mp.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path_factory.mktemp("graph") / "registry.json"))
        mp.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
        service.reset_for_tests()
        analysis.clear_caches()
        yield
        service.reset_for_tests()
        analysis.clear_caches()


def arun(fn):
    """Run ``fn()`` (a coroutine function) on a fresh loop, then close that loop's helper pool."""
    async def main():
        try:
            return await fn()
        finally:
            await service.shutdown()
    out = asyncio.run(main())
    assert not LIVE_PIDS
    return out


_REGISTERED: dict = {}


async def _register(path):
    await service.ensure_ready()
    reg = _REGISTERED.get(path)
    if reg is None or reg.id not in {r["id"] for r in service.registry().list()}:
        reg = _REGISTERED[path] = await asyncio.to_thread(service.registry().register, service.helper_status().path, path)
    return reg


def _package(name):
    found = [p for p in PACKAGES if os.path.basename(os.path.normpath(p)) == name]
    if not found:
        pytest.skip(f"no {name} package in FIBERBROWSER_TEST_GRAPH_PACKAGES")
    return found[0]


def _toy_columns(name, start, end, sources, observations):
    async def go():
        reg = await _register(_package(name))
        tiles = await analysis.fetch_tiles(reg, "target", sources, gc.cells_for(start, end))
        spec = {"target": "target", "regions": [{"start": start, "end": end, "mode": "accessibility"}],
                "observations": [{"id": i, "binding": b, "kind": "graph" if b else "linear"} for i, b in observations],
                "options": {"insertions": True, "carrier_features": "refine", "carrier_min_samples": 3}}
        return analysis.build_geometry(spec, tiles)
    return arun(go)


# ── Toy packages ─────────────────────────────────────────────────────────────

def test_flip_inversion_columns_map_base_for_base_reversed(helper_env):
    regions, plan = _toy_columns("flip", 40_000, 40_300, ["mat"], [("M", "mat")])
    [shared] = plan.shared
    assert shared.samples == list(range(0, 300, 10))
    [(u0, u1, g0, g1, rev)] = shared.blocks["M"]
    # The target is the reverse complement: target 40,000 is MAT 283,103 (the map's '-' block [282,804, 283,104)).
    assert (u0, u1, g0, g1, rev) == (0, 300, 282_804, 283_104, True)
    assert regions[0].carried["M"][0] == (283_103, True)


def test_alu_insertion_is_a_feature_carried_by_both_haplotypes(helper_env):
    regions, plan = _toy_columns("alu", 97_300, 97_500, ["mat", "pat"], [("M", "mat"), ("P", "pat")])
    # The Alu, in stretches both haplotypes walk (split where one has a private allele node).
    inserts = [f for f in regions[0].features if f.kind == "insertion" and f.carriers == ["M", "P"]]
    assert sum(f.length for f in inserts) > 2000
    # The boundary is target 97,395 (DESIGN_GRAPH_PANEL §4's regression).
    assert {f.anchor for f in inserts} == {(97_394, 97_395)}
    # Shared by every observation of this run: stage 1, beside the target walk.
    assert [f.kind for f in plan.shared][:1] == ["target"]
    assert sum(f.length for f in plan.shared if f.kind == "insertion") > 2000
    # With a linear observation it is carrier-only: refined within the haplotypes.
    _regions, mixed = _toy_columns("alu", 97_300, 97_500, ["mat", "pat"], [("L", None), ("M", "mat"), ("P", "pat")])
    assert any(cs["carriers"] == ["M", "P"] and sum(f.length for f in cs["features"] if f.kind == "insertion") > 2000
               for cs in mixed.carrier_sets)


def test_columns_are_the_same_whatever_the_path_selection_or_order(helper_env):
    _r1, one = _toy_columns("alu", 97_300, 97_500, ["mat", "pat"], [("M", "mat"), ("P", "pat")])
    _r2, two = _toy_columns("alu", 97_300, 97_500, ["pat", "mat"], [("P", "pat"), ("M", "mat")])
    _r3, alone = _toy_columns("alu", 97_300, 97_500, ["mat"], [("M", "mat")])
    assert one.shared[0].blocks["M"] == two.shared[0].blocks["M"] == alone.shared[0].blocks["M"]
    assert one.shared[0].blocks["P"] == two.shared[0].blocks["P"]


# ── The AluY demo ────────────────────────────────────────────────────────────

PEAKS = [(128655000, 128655100), (128656200, 128656300), (128658000, 128658100), (128659000, 128659100)]


@pytest.fixture(scope="module")
def alu_state():
    bam, manifest = os.environ.get("FIBERBROWSER_TEST_LIFT_BAM", ""), os.environ.get("FIBERBROWSER_TEST_LIFT_MAP", "")
    if not (HPRC and Path(HPRC).is_dir() and bam and manifest and Path(bam).is_file() and Path(manifest).is_file()):
        pytest.skip("Set FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_BAM and FIBERBROWSER_TEST_LIFT_MAP")
    os.environ.setdefault("FIBERBROWSER_LIVE_LIFT", "1")
    from plugins import init_context
    from services.lift.registration import add_live_lift_dataset
    from state.browser_state import BrowserState
    st = BrowserState(None, None, None, None)
    init_context(st)
    st.max_working_reads = 10000
    assert add_live_lift_dataset(st, paths=[bam], manifest=manifest, dataset_id="lifted")["success"]
    native = os.environ.get("FIBERBROWSER_TEST_LIFT_NATIVE", "")
    if native and Path(native).is_file():
        st.add_dataset("native", native, "native")
    return st


MAT = dict(id="obs-MAT", dataset_id="lifted", kind="graph", binding="mat_chr3")
PAT = dict(id="obs-PAT", dataset_id="lifted", kind="graph", binding="pat_chr3")
NAT = dict(id="obs-native", dataset_id="native", kind="linear", chrom="chr3")


def _body(obs, regions=PEAKS, method="combinatorial", **kw):
    return dict(target="grch38_chr3", regions=[dict(start=a, end=b, mode="accessibility") for a, b in regions],
                observations=obs, method=method, k=4, **kw)


def _graph(st, *bodies, mode="fit"):
    async def go():
        reg = await _register(HPRC)
        return [await analysis.handle(st, reg, b, mode=mode) for b in bodies]
    return arun(go)


def _need_native(st):
    if "native" not in st.datasets:
        pytest.skip("Set FIBERBROWSER_TEST_LIFT_NATIVE for the mixed run")


def _same_partition(a: dict, b: dict) -> bool:
    pairs = {(a[k], b[k]) for k in a}
    return len(pairs) == len({x for x, _ in pairs}) == len({y for _, y in pairs})


def test_graph_clustering_of_both_haplotypes_agrees_with_linear_clustering(helper_env, alu_state):
    """Where the target walks each node once (the four P2B peaks), graph and linear clustering give one partition of
    the reads they share, compared by record key (graph rows are the primary placement, linear rows their chain)."""
    from models.requests import ClusterAllRequest
    from services.clustering_endpoint import run_cluster_all_endpoint
    from services.lift.cohort import record_key
    [out] = _graph(alu_state, _body([MAT, PAT]))
    assert not out["columns"]["left_out"] and [f["kind"] for f in out["columns"]["shared"]] == ["target"] * 4
    view = dict(chrom="chr3", start=128650000, end=128670000)
    windows = [dict(dataset_id="lifted", result_key=h, lift_hap=h, **view) for h in ("MAT", "PAT")]
    linear = run_cluster_all_endpoint(state=alu_state, req=ClusterAllRequest(
        dataset_ids=["lifted"], viewports=windows, peak_regions=[dict(start=a, end=b, mode="accessibility") for a, b in PEAKS],
        method="combinatorial", k=4), spanning=False, **view)
    g = {record_key(a): c for r in out["results"].values() for a, c in r["assignments"].items()}
    lin = {record_key(a): c for h in ("MAT", "PAT") for a, c in linear["results"][h]["assignments"].items()}
    both = set(g) & set(lin)
    assert len(both) >= 40 and set(lin) <= set(g)
    assert _same_partition({k: g[k] for k in both}, {k: lin[k] for k in both})


def test_graph_rows_carry_the_wire_identity(helper_env, alu_state):
    """A graph analysis row's analysis_id is the graph wire's ``aid`` for the same record, so labels land on drawn
    rows (memberBands.clusterOf looks the aid up first)."""
    from services.graph_panel import reads as graph_reads
    from services.graph_panel.reads import read_bindings
    async def go():
        reg = await _register(HPRC)
        bound = {b["dataset_id"]: b for b in read_bindings(alu_state, reg)}["lifted"]
        wire = await asyncio.to_thread(graph_reads.load, alu_state, reg, {
            "datasets": [{"dataset_id": "lifted", "revision": bound["revision"]}],
            "paths": [{"binding": "mat_chr3", "windows": [{"start": 131192000, "end": 131194000}]}]}, max_molecules=5000)
        return wire
    wire = arun(go)
    rows, _desc = analysis.graph_window_rows(alu_state, analysis.GraphSource("lifted", "mat_chr3", "chr3_MATERNAL"),
                                             131191000, 131195000)
    ours = {r["analysis_id"] for r in rows}
    drawn = {r["aid"] for r in wire["reads"] if not r["sup"]}
    assert drawn and drawn <= ours


def test_native_only_graph_run_equals_cluster_all(helper_env, alu_state):
    _need_native(alu_state)
    from models.requests import ClusterAllRequest
    from services.clustering_endpoint import run_cluster_all_endpoint
    [out] = _graph(alu_state, _body([NAT]))
    view = dict(chrom="chr3", start=128650000, end=128670000)
    linear = run_cluster_all_endpoint(state=alu_state, req=ClusterAllRequest(
        dataset_ids=["native"], viewports=[dict(dataset_id="native", result_key="n", **view)],
        peak_regions=[dict(start=a, end=b, mode="accessibility") for a, b in PEAKS], method="combinatorial", k=4),
        spanning=False, **view)
    a, b = out["results"]["obs-native"]["assignments"], linear["results"]["n"]["assignments"]
    assert a and set(a) == set(b) and _same_partition(a, b)


def test_mixed_runs_are_permutation_invariant_and_the_model_reproduces_labels(helper_env, alu_state):
    _need_native(alu_state)
    one, two, three = _graph(alu_state, _body([MAT, PAT, NAT], method="kmeans", sample_seed="7"),
                             _body([NAT, PAT, MAT], method="kmeans", sample_seed="7"),
                             _body([PAT, MAT, NAT], regions=list(reversed(PEAKS)), method="kmeans", sample_seed="7"))
    assert one["results"] == two["results"] == three["results"]
    model = dict(stages=one["stages"], label_ids=one["label_ids"], settings=one["settings"], revisions=one["revisions"])
    [again] = _graph(alu_state, {**_body([MAT, PAT, NAT], method="kmeans"), "run": model}, mode="assign")
    for oid, res in one["results"].items():
        assert again["results"][oid]["assignments"] == res["assignments"]
    # A changed settings snapshot (or geometry) is refused, never silently reassigned.
    stale = dict(model, settings={**model["settings"], "subnucleosomal_threshold": 80})
    with pytest.raises(analysis.GraphRunError, match="cluster again"):
        _graph(alu_state, {**_body([MAT, PAT, NAT]), "run": stale}, mode="assign")
    # So is a changed cohort policy of an observation's dataset (review G5: rows and values depend on it).
    from dataclasses import replace
    cfg = alu_state.datasets["lifted"].live_lift
    before = cfg.settings
    cfg.settings = replace(before, cohort_supplementaries="primary_only" if before.cohort_supplementaries != "primary_only" else "all_records")
    try:
        with pytest.raises(analysis.GraphRunError, match="cluster again"):
            _graph(alu_state, {**_body([MAT, PAT, NAT], method="kmeans"), "run": model}, mode="assign")
    finally:
        cfg.settings = before


def test_refinement_within_carriers_keeps_non_carriers_labels(helper_env, alu_state):
    """The AluY insertion (both haplotypes carry it, the native GRCh38 rows cannot): stage 1 on the target walk,
    then the haplotypes' rows refined within each cluster on the insertion; native rows keep their stage-1 label."""
    _need_native(alu_state)
    [out] = _graph(alu_state, _body([MAT, PAT, NAT], regions=[(128657300, 128657500)]))
    sets = out["columns"]["carrier_sets"]
    assert sets and sets[0]["carriers"] == ["obs-MAT", "obs-PAT"]
    assert {f["kind"] for f in sets[0]["features"]} == {"insertion"} and sum(f["length"] for f in sets[0]["features"]) > 2000
    native = out["results"]["obs-native"]
    assert native["assignments"] == native["stage1"]
    names = {int(k): v for k, v in out["names"].items()}
    refined = [c for o in ("obs-MAT", "obs-PAT") for c in out["results"][o]["assignments"].values() if c in names]
    assert refined
    for o in ("obs-MAT", "obs-PAT"):
        for aid, c in out["results"][o]["assignments"].items():
            if c in names:   # C<parent>.<j>: refined within its own stage-1 cluster
                assert names[c].split(".")[0] == f"C{out['results'][o]['stage1'][aid]}"
    model = dict(stages=out["stages"], label_ids=out["label_ids"], settings=out["settings"], revisions=out["revisions"])
    [again] = _graph(alu_state, {**_body([MAT, PAT, NAT], regions=[(128657300, 128657500)]), "run": model}, mode="assign")
    for oid, res in out["results"].items():
        assert again["results"][oid]["assignments"] == res["assignments"]


def test_graph_rows_take_the_active_quality_gates(helper_env, alu_state):
    """Review round 3 (G4): graph-source rows are gated like every working set, so graph and native observations
    of the same evidence give the same values."""
    from services.read_quality_filters import quality_filters_for_request
    src = analysis.GraphSource("lifted", "mat_chr3", "chr3_MATERNAL")
    open_rows, _ = analysis.graph_window_rows(alu_state, src, 131192000, 131194000)
    calls = lambda rows: sum(len(((r.get("layers") or {}).get("nuc") or {}).get("intervals") or ()) for r in rows)
    assert calls(open_rows) > 0
    with quality_filters_for_request([{"layer": "nuc", "quality_name": "nq", "min_value": 256}]):
        gated, _ = analysis.graph_window_rows(alu_state, src, 131192000, 131194000)
    assert calls(gated) < calls(open_rows)
    again, _ = analysis.graph_window_rows(alu_state, src, 131192000, 131194000)
    assert calls(again) == calls(open_rows)   # the cache keeps the ungated rows


def test_a_run_with_no_shared_feature_says_who_is_not_a_carrier(helper_env, alu_state, monkeypatch):
    """G7 step 0: a run with no shared feature fits its first carrier set; every other participant is reported "not
    a carrier", not as having no covering reads. (Real tiles and rows; the plan's shared features are recast as a
    carrier set {MAT, native}, the shape two paths carrying different halves of a region give.)"""
    from dataclasses import replace
    _need_native(alu_state)
    real = analysis.build_geometry

    def no_shared(spec, tiles):
        regions, plan = real(spec, tiles)
        keep = ["obs-MAT", "obs-native"]
        feats = [replace(f, carriers=keep) for f in plan.shared]
        return regions, replace(plan, shared=[], carrier_sets=[{"carriers": keep, "features": feats}])
    monkeypatch.setattr(analysis, "build_geometry", no_shared)
    [out] = _graph(alu_state, _body([MAT, PAT, NAT], regions=PEAKS[:2]))
    assert out["results"]["obs-PAT"]["left_out"] == "not a carrier of the regions' sequence"
    assert out["results"]["obs-MAT"]["assignments"] and "left_out" not in out["results"]["obs-MAT"]
