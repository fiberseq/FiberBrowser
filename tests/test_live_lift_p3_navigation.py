"""Linked lift panels (DESIGN_LIVE_LIFT.md P3, §5.1-§5.2): the served map
summary, outlines, exact tiles and ribbon pieces, all scoped by the dataset's
haplotypes; rows carry their library index for molecule identity."""
import array

import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll
from services.lift import navigation as nav


def _records(h):
    u32 = lambda v: array.array("I", v)  # noqa: E731
    return [make_record(h, "plus", MAT, 2500, "3300M", tags=[("ns", u32([400, 2450, 3000])), ("nl", u32([200, 200, 200])), ("st", "CT")]),
            make_record(h, "pat", PAT, 500, "1000M", tags=[("ns", u32([100])), ("nl", u32([200]))])]


@pytest.fixture
def env(tmp_path, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient

    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    nav.clear_served_caches()
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    client = TestClient(srv.app, headers=auth_headers())
    manifest = write_toy_sidecar(tmp_path / "map")
    bam = write_bam(tmp_path / "src.bam", _records)
    try:
        yield client, manifest, bam
    finally:
        srv.state = old
        init_context(old)


def _add(client, manifest, bam, **extra):
    out = client.post("/api/lift/datasets", json={"paths": [bam], "manifest": manifest, **extra}).json()
    assert out["success"], out
    return out["dataset"]["id"]


def test_summary_flags_selected_haplotypes(env):
    client, manifest, bam = env
    did = _add(client, manifest, bam, haplotypes=["MAT"])
    s = client.get("/api/lift/summary", params={"dataset_id": did}).json()
    assert len(s["chains"]) == 5 and s["chains"][1][:4] == [TARGET, 12000, 14000, MAT]
    assert s["selected"] == [True, True, False, True, True]
    assert s["sources"] == {MAT: "H#1"}
    assert s["labels"] == {"H#1": "MAT"} and s["tile_bp"] == nav.TILE_BP


def test_outline_by_target_and_by_source_never_crosses_haplotypes(env):
    client, manifest, bam = env
    mat = _add(client, manifest, bam, haplotypes=["MAT"])
    rows = client.get("/api/lift/outline", params={"dataset_id": mat, "chrom": TARGET}).json()["rows"]
    assert {r[5] for r in rows} == {0, 1, 3}                     # no PAT chain 2, no alternative chain 4
    assert [r for r in rows if r[5] == 0] == [[1000, 7900, 0, 6990, "+", 0, 90]]
    src = client.get("/api/lift/outline", params={"dataset_id": mat, "source": MAT}).json()["rows"]
    assert all(r[7] == TARGET for r in src) and [r[2] for r in src] == sorted(r[2] for r in src)
    assert client.get("/api/lift/outline", params={"dataset_id": mat, "source": PAT}).status_code == 404
    assert client.get("/api/lift/outline", params={"dataset_id": mat}).status_code == 422
    assert client.get("/api/lift/outline", params={"dataset_id": mat, "chrom": "chrNope"}).status_code == 404


def test_tiles_round_trip_and_scope(env):
    client, manifest, bam = env
    both = _add(client, manifest, bam)
    mat = _add(client, manifest, bam, haplotypes=["MAT"])
    get = lambda did, **p: client.get("/api/lift/tiles", params={"dataset_id": did, **p})  # noqa: E731
    r = get(both, side="target", contig=TARGET, tile=0)
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    tile = nav.decode_tile(r.content)
    assert nav.tile_lookup(tile, 12_000) == [(1, 8999)]
    assert nav.tile_lookup(tile, 15_100) == [(2, 100)]
    assert nav.tile_lookup(nav.decode_tile(get(mat, side="target", contig=TARGET, tile=0).content), 15_100) == []
    src = nav.decode_tile(get(mat, side="source", contig=MAT, tile=0).content)
    assert nav.tile_lookup(src, 8999) == [(1, 12_000)]
    assert get(mat, side="source", contig=PAT, tile=0).status_code == 404
    assert get(mat, side="sideways", contig=MAT, tile=0).status_code == 422


def test_ribbon_pieces_gaps_alternatives_and_coarsening(env):
    client, manifest, bam = env
    did = _add(client, manifest, bam, haplotypes=["MAT"])
    q = {"dataset_id": did, "chrom": TARGET, "start": 0, "end": 20_000}
    out = client.get("/api/lift/pieces", params=q).json()
    c0 = [p for p in out["pieces"] if p[5] == 0]
    assert [p[:5] for p in c0] == [[1000, 4000, 0, 3000, "+"], [4010, 6010, 3000, 5000, "+"], [6010, 7900, 5100, 6990, "+"]]
    assert all(p[6] is False and p[7] == MAT and p[8] == "H#1" for p in out["pieces"])
    minus = [p for p in out["pieces"] if p[5] == 1]
    assert minus == [[12000, 14000, 7000, 9000, "-", 1, False, MAT, "H#1"]]
    reasons = {(g[0], g[1], g[2], g[3], g[4]): g[5] for g in out["gaps"]}
    assert reasons[(0, 4000, 4010, 3000, 3000)] == "target_insertion"
    assert reasons[(0, 6010, 6010, 5000, 5100)] == "source_insertion"
    assert not any(p[6] for p in out["pieces"]) and out["alternatives"] is False
    alt = client.get("/api/lift/pieces", params={**q, "alternatives": "true"}).json()
    assert [p[:7] for p in alt["pieces"] if p[6]] == [[1500, 1800, 9600, 9900, "+", 4, True]]
    coarse = client.get("/api/lift/pieces", params={**q, "min_bp": 200}).json()
    assert [p[:4] for p in coarse["pieces"] if p[5] == 0] == [[1000, 7900, 0, 6990]]
    assert not [g for g in coarse["gaps"] if g[0] == 0]      # sub-pixel gaps are absorbed
    assert client.get("/api/lift/pieces", params={**q, "hap": "PAT"}).status_code == 404
    assert client.get("/api/lift/pieces", params={**q, "start": 5, "end": 5}).status_code == 422


def test_navigation_routes_need_the_flag_and_a_lifted_dataset(env, monkeypatch):
    client, manifest, bam = env
    did = _add(client, manifest, bam)
    native = client.post("/api/datasets/add", json={"path": bam}).json()
    if native.get("success"):
        nid = native["dataset"]["id"]
        assert client.get("/api/lift/summary", params={"dataset_id": nid}).status_code == 409
    assert client.get("/api/lift/summary", params={"dataset_id": "missing"}).status_code == 404
    monkeypatch.delenv("FIBERBROWSER_LIVE_LIFT")
    for path, extra in (("summary", {}), ("outline", {"chrom": TARGET}), ("tiles", {"side": "target", "contig": TARGET, "tile": 0}),
                        ("pieces", {"chrom": TARGET, "start": 0, "end": 10})):
        assert client.get(f"/api/lift/{path}", params={"dataset_id": did, **extra}).status_code == 404


def test_rows_carry_their_library_index(env, tmp_path):
    client, manifest, bam = env
    second = write_bam(tmp_path / "second.bam", _records)
    out = client.post("/api/lift/datasets", json={"paths": [bam, second], "manifest": manifest}).json()
    assert out["success"], out
    r = client.get("/api/reads/compact", params=dict(chrom=TARGET, start=1000, end=9000, dataset_id=out["dataset"]["id"],
                                                     max_reads=5000, include_layers="true",
                                                     full_working_set="true")).json()
    libs = {(read["live_lift"]["library"], read["live_lift"]["molecule"].split("|")[0]) for read in r["reads"]}
    assert {lib for lib, _ in libs} == {0, 1}
    assert len({group for _, group in libs}) == 2


def test_requests_name_their_lift_key_and_stale_ones_are_refused(env):
    client, manifest, bam = env
    did = _add(client, manifest, bam)
    key = client.get("/api/lift/summary", params={"dataset_id": did}).json()["key"]
    ok = client.get("/api/lift/tiles", params={"dataset_id": did, "side": "target", "contig": TARGET, "tile": 0, "key": key})
    assert ok.status_code == 200 and "immutable" in ok.headers["cache-control"]
    assert "no-cache" in client.get("/api/lift/tiles", params={"dataset_id": did, "side": "target", "contig": TARGET, "tile": 0}).headers["cache-control"]
    client.post(f"/api/lift/datasets/{did}/settings", json={"haplotypes": ["MAT"]})
    for path, extra in (("summary", {}), ("outline", {"chrom": TARGET}), ("tiles", {"side": "target", "contig": TARGET, "tile": 0}),
                        ("pieces", {"chrom": TARGET, "start": 0, "end": 10})):
        assert client.get(f"/api/lift/{path}", params={"dataset_id": did, "key": key, **extra}).status_code == 409


def test_ribbon_coarsening_terminates_when_pieces_cannot_merge(env, monkeypatch):
    client, manifest, bam = env
    did = _add(client, manifest, bam, haplotypes=["MAT"])
    monkeypatch.setattr(nav, "MAX_RIBBON_PIECES", 1)       # three MAT chains: merging never gets to one
    out = client.get("/api/lift/pieces", params={"dataset_id": did, "chrom": TARGET, "start": 0, "end": 20_000}).json()
    assert out["truncated"] is True and len(out["pieces"]) == 1
    assert out["pieces"][0][5] == 0                            # the longest stretch is kept


def test_multi_file_rows_keep_their_file_when_one_file_fills_the_view(env, tmp_path):
    """A linked source panel matches molecules by file: rows keep library_id whenever the dataset has several files."""
    client, manifest, bam = env
    u32 = lambda v: array.array("I", v)  # noqa: E731
    far = write_bam(tmp_path / "far.bam", lambda h: [make_record(h, "far", MAT, 9000, "500M",
                                                                   tags=[("ns", u32([10, 200, 300])), ("nl", u32([50, 50, 50]))])])
    out = client.post("/api/datasets/add", json={"paths": [bam, far]}).json()
    assert out.get("success"), out
    did = out["dataset"]["id"]
    r = client.get("/api/reads/compact", params=dict(chrom=MAT, start=2000, end=6000, dataset_id=did, max_reads=5000,
                                                     include_layers="true", full_working_set="true")).json()
    assert r["reads"] and all(read.get("library_id") for read in r["reads"])
    assert {read["library_id"].rsplit("/", 1)[-1] for read in r["reads"]} == {"src.bam"}


def test_map_suggestions_next_to_a_bam_say_whether_its_contigs_match(env, tmp_path, monkeypatch):
    client, manifest, bam = env
    import shutil, os
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "library.json"))
    here = tmp_path / "data"
    here.mkdir()
    shutil.copytree(os.path.dirname(manifest), here / "map")
    local = str(here / "map" / os.path.basename(manifest))
    near_map = here / ("toy" + ".graphlift.json")
    shutil.copy(local, near_map)
    for f in os.listdir(here / "map"):
        if f != os.path.basename(manifest):
            shutil.copy(here / "map" / f, here / f)
    moved = write_bam(here / "s.bam", _records)
    out = client.get("/api/lift/maps", params={"near": moved}).json()
    first = out["maps"][0]
    assert first["where"] == "next to the BAM" and first["matches_bam"] is True and first["haplotypes"] == ["MAT", "PAT"]
    other = write_bam(here / "other.bam", lambda h: [], contigs=(("chrZ", 1000),))
    assert client.get("/api/lift/maps", params={"near": other}).json()["maps"][0]["matches_bam"] is False
    assert "graphlift map" in out["help"]
    monkeypatch.delenv("FIBERBROWSER_LIVE_LIFT")
    assert client.get("/api/lift/maps", params={"near": moved}).status_code == 404
