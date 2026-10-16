"""The read display's sample of a view does not depend on which layer sets were loaded before (3.0.0 audit LOW-2).

A broad load cached for more layers (nuc, tf + FIRE/MSPs) is reused for a request with fewer. Its reads were
measured with every layer's geometry (FIRE calls past the footprints), so the coverage-ranked display sample of the
same request differed with the cache entry it came from: test_playwright_render.py::test_sample_seed_reproducible
rendered one of two images. Only the geometry the request shows counts now.
"""
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.packed_reads import ReadDisplayIndex, compact_read_bounds

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


def _read(i, intervals, fire=(), layers=None):
    return {"id": f"r{i}", "intervals": [list(iv) for iv in intervals], "fire": [list(iv) for iv in fire],
            "layers": {name: {"intervals": [list(iv) for iv in ivs]} for name, ivs in (layers or {}).items()}}




def test_bounds_count_only_the_shown_groups():
    read = _read(0, [(100, 200, 50)], fire=[(40, 320, 1)], layers={"msp": [(30, 330)], "nuc": [(110, 190)]})
    assert compact_read_bounds(read) == (30, 330)
    assert compact_read_bounds(read, include=lambda n: n not in ("fire", "msp")) == (100, 200)
    assert compact_read_bounds(read, 0, 1000, include=lambda n: n == "intervals") == (100, 200)


def test_display_index_extents_per_shown_groups():
    reads = [
        _read(0, [(100, 200, 50)], fire=[(40, 320, 1)]),
        _read(1, [(500, 600, 50)], layers={"msp": [(590, 700)], "nuc": [(600, 650)]}),  # nuc touches: one run
        _read(2, [], fire=[(900, 950, 1)]),  # FIRE only: nothing to show without it
    ]
    index = ReadDisplayIndex(reads)
    every = {i: (lo, hi) for i, _meta, lo, hi in index.overlapping(0, 2000)}
    assert every == {0: (40, 320), 1: (500, 700), 2: (900, 950)}
    shown = {i: (lo, hi) for i, _meta, lo, hi in index.overlapping(0, 2000, include=lambda n: n in ("intervals", "nuc"))}
    assert shown == {0: (100, 200), 1: (500, 650)}
    # Groups split by an empty stretch stay apart: a view between them sees nothing of read 1.
    assert list(index.overlapping(660, 690, include=lambda n: n in ("intervals", "nuc"))) == []
    # Combined indexes (worker blocks) keep the groups.
    combined = ReadDisplayIndex.combine([ReadDisplayIndex(reads[:1]), ReadDisplayIndex(reads[1:])])
    assert {i: (lo, hi) for i, _m, lo, hi in combined.overlapping(0, 2000, include=lambda n: n in ("intervals", "nuc"))} == shown


@pytest.mark.skipif(not DEMO.exists(), reason="demo BAM not present")
def test_the_same_request_draws_the_same_sample_after_a_fire_load():
    from routers.reads import router
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    state = BrowserState(None)
    state.add_dataset("napa", str(DEMO))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    params = {"dataset_id": "napa", "chrom": "chr19", "start": 47514000, "end": 47526000, "include_layers": "true",
              "layer_names": "nuc,tf", "max_reads": 1000, "min_footprints": 5, "sample_seed": "abc-123", "spanning": "false"}

    def ids(**extra):
        body = client.get("/api/reads/compact", params={**params, **extra}).json()
        return [read["id"] for read in body["reads"]]

    first = ids()
    assert len(first) == 1000
    ids(layer_names="nuc,tf,fire")  # caches a second broad load with FIRE/MSP geometry
    for _ in range(4):
        assert ids() == first
