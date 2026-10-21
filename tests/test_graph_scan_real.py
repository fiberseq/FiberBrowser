"""Peak scanning on graph node columns with the real graph helper (graph features, item 3).

The HG002 AluY demo (skipped without FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE,
FIBERBROWSER_TEST_LIFT_BAM and FIBERBROWSER_TEST_LIFT_MAP): the two haplotypes' reads pooled per column give the peaks
a scan of the same reads on target coordinates gives (the lifted analysis cohort), where the target walks each node
once; the Alu insertion both haplotypes carry is scanned on its own frame; the peaks are valid Cluster regions.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import numpy as np
import pytest

from services.graph_panel import analysis, scan, service
from services.graph_panel.worker import LIVE_PIDS

HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
HPRC = os.environ.get("FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE", "").strip()
pytestmark = pytest.mark.skipif(not (HELPER and os.path.isfile(HELPER)), reason="set FIBERBROWSER_TEST_GRAPH_HELPER")

WINDOW = (128653000, 128661000)
MAT = dict(id="obs-MAT", dataset_id="lifted", kind="graph", binding="mat_chr3")
PAT = dict(id="obs-PAT", dataset_id="lifted", kind="graph", binding="pat_chr3")
LIN = dict(id="obs-lin", dataset_id="lifted", kind="linear", chrom="chr3")
NAT = dict(id="obs-native", dataset_id="native", kind="linear", chrom="chr3")


@pytest.fixture(scope="module")
def helper_env(tmp_path_factory):
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("FIBERBROWSER_GRAPH_HELPER", HELPER)
        mp.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path_factory.mktemp("graph") / "registry.json"))
        mp.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
        service.reset_for_tests()
        analysis.clear_caches()
        yield
        service.reset_for_tests()
        analysis.clear_caches()


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


_REG: dict = {}


def _scan(st, obs, window=WINDOW, **settings):
    async def go():
        try:
            await service.ensure_ready()
            reg = _REG.get("r")
            if reg is None or reg.id not in {r["id"] for r in service.registry().list()}:
                reg = _REG["r"] = await asyncio.to_thread(service.registry().register, service.helper_status().path, HPRC)
            body = dict(target="grch38_chr3", window=dict(start=window[0], end=window[1]), observations=obs,
                        scan={"signal_source": "accessibility", **settings})
            return await scan.handle(st, reg, body)
        finally:
            await service.shutdown()
    out = asyncio.run(go())
    assert not LIVE_PIDS
    return out


def _mask(peaks, start, end):
    m = np.zeros(end - start, dtype=bool)
    for p in peaks:
        m[max(0, p["start"] - start):max(0, p["end"] - start)] = True
    return m


def test_graph_scan_pools_both_haplotypes_like_a_target_scan_of_the_same_reads(helper_env, alu_state):
    graph = _scan(alu_state, [MAT, PAT])
    linear = _scan(alu_state, [LIN])           # the lifted analysis cohort on target coordinates
    assert graph["mode"] == "Graph columns" and graph["n_reads"] > 50
    assert graph["peaks"] and linear["peaks"]
    g, lin = _mask(graph["peaks"], *WINDOW), _mask(linear["peaks"], *WINDOW)
    jaccard = (g & lin).sum() / max(1, (g | lin).sum())
    assert jaccard >= 0.8, (jaccard, graph["peaks"], linear["peaks"])
    # Both haplotypes counted, each on its own path.
    assert graph["columns"]["observations"]["obs-MAT"] > 0 and graph["columns"]["observations"]["obs-PAT"] > 0
    # Valid Cluster regions: sorted, disjoint target spans in the window.
    spans = [(p["start"], p["end"]) for p in graph["peaks"]]
    assert spans == sorted(spans) and all(a < b <= c for (a, b), (c, _d) in zip(spans, spans[1:]))
    assert all(WINDOW[0] <= a < b <= WINDOW[1] for a, b in spans)


def test_graph_scan_is_independent_of_observation_order(helper_env, alu_state):
    a = _scan(alu_state, [MAT, PAT])
    b = _scan(alu_state, [PAT, MAT])
    strip = lambda out: [(p["start"], p["end"], p["layer"]) for p in out["peaks"]]
    assert strip(a) == strip(b)


def test_the_alu_insertion_is_scanned_on_its_own_frame(helper_env, alu_state):
    out = _scan(alu_state, [MAT, PAT], window=(128656800, 128658000), threshold_rare=0.01, min_reads=1)
    ins = out["columns"]["insertions"]
    assert sum(f["length"] for f in ins) > 2000          # the AluY both haplotypes carry
    assert all(f["anchor"] for f in ins)
    # Any peak inside it is a target span holding the insertion's anchor.
    for p in out["peaks"]:
        if p["graph"]["kind"] in ("insertion", "target+insertion"):
            assert any(p["start"] <= f["anchor"][0] and f["anchor"][1] <= p["end"] for f in ins)


def test_a_native_panel_joins_the_scan_on_the_target(helper_env, alu_state):
    if "native" not in alu_state.datasets:
        pytest.skip("Set FIBERBROWSER_TEST_LIFT_NATIVE")
    both = _scan(alu_state, [MAT, PAT, NAT])
    assert both["columns"]["observations"]["obs-native"] > 0
    assert both["n_reads"] > _scan(alu_state, [MAT, PAT])["n_reads"]
