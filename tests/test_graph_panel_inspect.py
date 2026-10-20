"""Graph-panel inspection (Gate F; services/graph_panel/differences.py, ``/api/graph/differences``): a graph
allele reuses a live-lift dataset's canonical difference only when the dataset's map is the package's map for the
pair (manifest digest) and the difference has the same target boundary and source placement; a mismatched map or
placement is rejected with its reason, and stale package revisions are refused."""
from __future__ import annotations

import pytest

from services.graph_panel.differences import file_sha256
from test_graph_panel_reads import _add_lifted, env  # noqa: F401  (fixture)


def _items(env, did):
    from services.lift.differences import assembly_items_for_region
    ds = env.state.datasets[did]
    contig = next(iter(ds.live_lift.handle.map.targets))
    return contig, [i for i in assembly_items_for_region(ds.live_lift, contig, 0, 1 << 30)
                    if (i.get("src") or {}).get("start") is not None]


def _ask(env, item, path="mat", **extra):
    src = item["src"]
    body = {"registration_id": "g1", "revisions": env.reg.revisions, "target": "target", "path": path,
            "target_span": {"start": item["t_start"], "end": item["t_end"]},
            "source_span": {"start": src["start"], "end": src["end"]}, **extra}
    return env.client.post("/api/graph/differences", json=body)


@pytest.fixture
def lifted(env):  # noqa: F811
    did = _add_lifted(env)
    contig, items = _items(env, did)
    mat = [i for i in items if i.get("hap_label") == "MAT"] or items
    if not mat:
        pytest.skip("the toy map has no assembly difference with a source placement")
    return did, mat[0]


def _with_map_digest(env, digest):
    for m in env.reg.maps:
        m["manifest_sha256"] = digest


def test_same_map_same_placement_reuses_the_canonical_difference(env, lifted):  # noqa: F811
    did, item = lifted
    _with_map_digest(env, file_sha256(env.manifest))
    out = _ask(env, item).json()
    assert [m["id"] for m in out["matches"]] == [item["id"]]
    assert out["matches"][0]["dataset_id"] == did and out["matches"][0]["revision"]


def test_another_map_is_rejected_never_reused(env, lifted):  # noqa: F811
    _did, item = lifted
    _with_map_digest(env, "0" * 64)
    out = _ask(env, item).json()
    assert out["matches"] == [] and [r["reason"] for r in out["rejected"]] == ["map_differs"]


def test_another_placement_is_listed_not_reused(env, lifted):  # noqa: F811
    _did, item = lifted
    _with_map_digest(env, file_sha256(env.manifest))
    moved = {**item, "src": {**item["src"], "start": item["src"]["start"] + 7, "end": item["src"]["end"] + 7}}
    out = _ask(env, moved).json()
    assert out["matches"] == [] and any(r["reason"] == "other_placement" and r["id"] == item["id"] for r in out["rejected"])


def test_stale_revisions_and_bad_bodies_are_refused(env, lifted):  # noqa: F811
    _did, item = lifted
    assert _ask(env, item, revisions={**env.reg.revisions, "maps": "other"}).status_code == 409
    assert _ask(env, item, path="nope").status_code == 422
    assert env.client.post("/api/graph/differences", json=[1]).status_code == 422


def test_a_missing_bam_binds_to_nothing_and_says_why(env):  # noqa: F811
    """Missing BAM (Gate F): its dataset binds to no path, with the reason; a reads request naming it is refused."""
    import os
    import shutil
    from services.bam_handles import close_all_bam_handles
    bam = env.tmp / "gone.bam"
    shutil.copy(env.bam, bam)
    shutil.copy(str(env.bam) + ".bai", str(bam) + ".bai")
    did = _add_lifted(env, paths=[str(bam)], dataset_id="gone")
    os.remove(bam)
    os.remove(str(bam) + ".bai")
    close_all_bam_handles()
    rows = env.client.get("/api/graph/read_bindings", params={"registration_id": "g1"}).json()["bindings"]
    gone = next(b for b in rows if b["dataset_id"] == did)
    assert gone["paths"] == {} and gone["problems"]
    out = env.client.post("/api/graph/reads", json={"registration_id": "g1", "revisions": env.reg.revisions,
                                                     "request_id": "r", "panel_id": "p", "generation": 1,
                                                     "datasets": [{"dataset_id": did}],
                                                     "paths": [{"binding": "mat", "windows": [{"start": 0, "end": 1000}]}]})
    assert out.status_code == 404 and out.json()["error"]["code"] == "unknown_dataset"
