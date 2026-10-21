"""Graph mode beyond HG002 (graph primary G8, DESIGN_GRAPH_PRIMARY §8) with the real helper on two neutral packages:

- ``strain``: a fly-style two-path package, ``dm6#0#chr2L`` (target) and ``strainA#0#chr2L``;
- ``generic``: ``refA#0#chrT`` and two haplotypes of one sample, ``sampleB#1#chrT`` / ``sampleB#2#chrT``.

Both are renamed copies of the toy graphs (graphlift ``gbz-rename``), prepared with ``fiberbrowser-graph prepare``.
They register and verify; bindings are path identities (sample, haplotype, contig), never MAT/PAT names; a native
BAM on the target binds the target path only, its reads load on it, and a graph cluster run on the strain package
works. A source check keeps MAT/PAT names out of graph logic.

Needs FIBERBROWSER_TEST_GRAPH_HELPER and FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES (the two package folders,
``os.pathsep``-separated, named strain and generic).
"""
from __future__ import annotations

import ast
import asyncio
import os
import types
from pathlib import Path

import pytest

from live_lift_fixtures import make_record, write_bam
from services.graph_panel import analysis, service
from services.graph_panel import reads as gr
from services.graph_panel.worker import LIVE_PIDS

HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
PACKAGES = [p for p in os.environ.get("FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES", "").split(os.pathsep) if p.strip()]
GRAPH_PANEL = Path(__file__).resolve().parents[1] / "browser" / "services" / "graph_panel"


def _package(name):
    found = [p for p in PACKAGES if os.path.basename(os.path.normpath(p)) == name]
    if not (HELPER and os.path.isfile(HELPER)) or not found:
        pytest.skip("set FIBERBROWSER_TEST_GRAPH_HELPER and FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES")
    return found[0]


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


def arun(fn):
    async def main():
        try:
            return await fn()
        finally:
            await service.shutdown()
    before = set(LIVE_PIDS)
    out = asyncio.run(main())
    assert not (set(LIVE_PIDS) - before)
    return out


async def _register(path):
    await service.ensure_ready()
    return await asyncio.to_thread(service.registry().register, service.helper_status().path, path)


def _u32(values):
    import array
    return array.array("I", values)


def test_neutral_packages_register_with_path_identities(helper_env):
    regs = arun(lambda: asyncio.gather(_register(_package("strain")), _register(_package("generic"))))
    strain, generic = regs
    names = lambda reg: sorted(gr.path_name(b) for b in reg.bindings)
    assert names(strain) == ["dm6#0#chr2L", "strainA#0#chr2L"]
    assert names(generic) == ["refA#0#chrT", "sampleB#1#chrT", "sampleB#2#chrT"]
    assert {(m["target"], m["source"]) for m in strain.maps} == {("dm6", "strainA")}
    assert {(m["target"], m["source"]) for m in generic.maps} == {("ref", "h1"), ("ref", "h2")}


def _native_state(tmp_path, reg, n=40, start=None):
    """A native BAM on the strain package's target (dm6#0#chr2L) and a main reference with that contig."""
    from plugins import init_context
    from state.browser_state import BrowserState
    target = next(b for b in reg.bindings if b["key"] == "dm6")
    size = int(target["size"])
    bam = write_bam(tmp_path / "fly.bam", lambda h: [
        make_record(h, f"fly{i:03d}", "chr2L", start(i) if start else 200 + (i * 37) % max(1, size - 900), "600M",
                    tags=[("ns", _u32([100, 400])), ("nl", _u32([150, 150]))]) for i in range(n)],
        contigs=(("chr2L", size),))
    st = BrowserState(None, None, None, None)
    init_context(st)
    st.max_working_reads = 10000
    st.chroms = [types.SimpleNamespace(name="chr2L", size=size)]
    st.add_dataset("fly", str(bam), "fly")
    return st, size


def test_a_native_dataset_binds_the_target_only_and_its_reads_load(helper_env, tmp_path):
    reg = arun(lambda: _register(_package("strain")))
    st, size = _native_state(tmp_path, reg)
    [bound] = [b for b in gr.read_bindings(st, reg) if b["dataset_id"] == "fly"]
    assert bound["kind"] == "native" and bound["paths"] == {"dm6": "chr2L"}
    out = gr.load(st, reg, {"datasets": [{"dataset_id": "fly"}],
                            "paths": [{"binding": "dm6", "windows": [{"start": 0, "end": min(size, 6000)}]}]})
    assert out["reads"] and {r["b"] for r in out["reads"]} == {"dm6"}
    assert {b["binding"] for b in out["report"]["bands"]} == {"dm6"}
    # No haplotype on native rows: nothing named MAT or PAT anywhere in them.
    assert all(r.get("hap") is None for r in out["reads"])


def test_a_graph_cluster_run_on_the_strain_package(helper_env, tmp_path):
    reg = arun(lambda: _register(_package("strain")))
    st, size = _native_state(tmp_path, reg, n=60, start=lambda i: 700 + (i % 30) * 5)
    regions = [(1000, 1100), (1200, 1300)]
    body = dict(target="dm6", regions=[dict(start=a, end=b, mode="accessibility") for a, b in regions],
                observations=[dict(id="obs-fly", dataset_id="fly", kind="linear", chrom="chr2L")], method="combinatorial", k=3)
    out = arun(lambda: analysis.handle(st, reg, body))
    labels = out["results"]["obs-fly"]["assignments"]
    assert len(labels) > 10, out["results"]["obs-fly"]
    assert out["columns"]["shared"] and out["target"] == "dm6"


def _string_constants_in_logic(path: Path) -> list:
    """String constants of a module outside docstrings."""
    tree = ast.parse(path.read_text())
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant):
                docstrings.add(id(first.value))
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings]


def test_no_mat_or_pat_names_in_graph_logic():
    """§8: haplotypes are path identities and the map's own labels; no logic tests for MAT or PAT."""
    found = {}
    for path in sorted(GRAPH_PANEL.glob("*.py")):
        hits = [s for s in _string_constants_in_logic(path) if s.strip().upper() in ("MAT", "PAT", "MATERNAL", "PATERNAL")]
        if hits:
            found[path.name] = hits
    assert not found, found
