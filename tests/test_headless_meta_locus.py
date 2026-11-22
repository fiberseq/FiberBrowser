"""Headless meta-locus (pooled loci) figures: the pool from a spec, a pool id or a saved session; the drawn read set equals
the browser's working set for the same pool, seed and count; the open tab's view is never changed; rows that need a real
genome position are left out; the axis is relative to the anchor; the manifest carries the pool record."""
from __future__ import annotations

import base64
import json
import shutil
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "cache"))
    import server as srv
    from plugins import init_context
    from services import meta_locus_jobs as mj
    from services.local_auth import auth_headers
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    mj._pools.clear()
    mj._view_pools.clear()
    client = TestClient(srv.app, headers=auth_headers())

    def add(path, label):
        r = client.post("/api/datasets/add", json={"path": str(path), "label": label})
        assert r.status_code == 200, r.text
        body = r.json()
        return body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")

    yield client, add, tmp_path
    for p in list(mj._pools.values()):
        p.cancel.set()
    mj._pools.clear()
    mj._view_pools.clear()
    srv.state = old


def bed_file(tmp_path, n=8, name="demo_sites.bed"):
    import pysam
    with pysam.AlignmentFile(str(DEMO)) as f:
        spans = [(r.reference_start, r.reference_end) for r in f.fetch("chr19")]
    lo, hi = min(a for a, _ in spans), max(b for _, b in spans)
    path = tmp_path / name
    path.write_text("".join(
        f"chr19\t{lo + (hi - lo) * (i + 1) // (n + 1)}\t{lo + (hi - lo) * (i + 1) // (n + 1) + 1}\ts{i}\t0\t{'+-'[i % 2]}\n"
        for i in range(n)))
    return path


def ready(client, pid, timeout=90):
    t = time.monotonic()
    while True:
        st = client.get(f"/api/meta_locus/pools/{pid}").json()
        if st["status"] != "building" or time.monotonic() - t > timeout:
            return st
        time.sleep(0.05)


def render(client, **body):
    body = {"engine": "headless", "format": "svg", "manifest": True, "manifest_read_ids": True, **body}
    r = client.post("/api/render", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    return base64.b64decode(out["figure_b64"]).decode("utf-8", "replace"), out["manifest"]


# The read track's own request parameters with the browser's default settings (useReadTrackData.ts): the read filters
# decide which reads the view tops up with, so a comparison must send the same ones.
READ_TRACK_PARAMS = dict(hide_terminal_gaps="true", terminal_gap_threshold=500, include_duplicates="false",
                         include_qcfail="false", min_footprints=5, min_fp_quality=0)


def browser_ids(client, pool, did, seed, count, extra=None, start=0, end=None):
    """What the open tab shows for this pool, seed and count: the pool's own view, then the read route it fetches."""
    body = {"seed": seed, "count": count}
    if extra is not None:
        body["extra_entries"] = extra
    v = client.post(f"/api/meta_locus/pools/{pool['pool_id']}/view", json=body)
    assert v.status_code == 200, v.text
    rows = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=pool["chrom"], start=start,
                                                        end=end or pool["width"], max_reads=200_000,
                                                        **READ_TRACK_PARAMS)).json()["reads"]
    return [r["id"] for r in rows]


def start_pool(client, bed, **kw):
    st = client.post("/api/meta_locus/pools", json={"bed_path": str(bed), "flank_bp": 1500, **kw}).json()
    st = ready(client, st["pool_id"])
    assert st["status"] == "ready", st
    return st


def test_figure_by_spec_draws_the_browser_working_set_and_leaves_the_tab_view_alone(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    bed = bed_file(tmp)
    pool = start_pool(client, bed, anchor="start")
    before = client.get(f"/api/meta_locus/pools/{pool['pool_id']}/view").json()

    svg, man = render(client, source="defaults",
                      meta_locus={"bed": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 7, "count": 250})
    after = client.get(f"/api/meta_locus/pools/{pool['pool_id']}/view").json()
    assert (after["seed"], after["count"], after["generation"]) == (before["seed"], before["count"], before["generation"])

    drawn = man["panels"][0]["read_ids"]
    assert len(drawn) == 250
    assert sorted(drawn) == sorted(browser_ids(client, pool, did, 7, 250))
    ml = man["meta_locus"]
    assert ml["pool_id"] == pool["pool_id"] and ml["seed"] == 7 and ml["count"] == 250
    assert ml["anchor"] == "start" and ml["flank_bp"] == 1500 and ml["sites"] == 8 and ml["read_site_pairs"] > 250
    assert len(ml["bed_sha256"]) == 64 and len(ml["spec_hash"]) == 64 and ml["unit"] == "read-site pair"
    assert man["region"]["chrom"].startswith(f"meta:{pool['pool_id']}.v")
    # rows that need a real genome position are left out (metaHiddenTrack); the metaprofile stays
    tracks = man["panels"][0]["tracks"]
    assert not {"gene", "sequence", "sv", "primer", "microc", "capture"} & set(tracks)
    assert "composite-__default_metaprofile__" in tracks and "reads" in tracks
    # the axis: the pool's label and the anchor word at 0 (TSS for anchor start)
    assert "demo_sites · TSS ± 1.5 kb" in svg and ">TSS<" in svg


def test_parity_beyond_the_display_cap_with_two_datasets_and_added_reads(app, tmp_path):
    client, add, tmp = app
    copy = tmp_path / "demo_copy.bam"
    shutil.copy(DEMO, copy)
    shutil.copy(str(DEMO) + ".bai", str(copy) + ".bai")
    a, b = add(DEMO, "A"), add(copy, "B")
    bed = bed_file(tmp, n=12)
    pool = start_pool(client, bed, anchor="centre")
    total = pool["view"]["pool_total"]
    count = min(3000, total - 10)
    assert count > 2000, f"the demo pool is too small for the cap test ({total})"
    _svg, man = render(client, source="defaults",
                       meta_locus={"pool_id": pool["pool_id"], "seed": 3, "count": count})
    drawn = {p["dataset_id"]: p["read_ids"] for p in man["panels"]}
    assert sum(len(v) for v in drawn.values()) == count
    for did in (a, b):
        assert sorted(drawn[did]) == sorted(browser_ids(client, pool, did, 3, count)), did

    # a session's added reads (Find more / Keep workspace full) are drawn too
    view = client.post(f"/api/meta_locus/pools/{pool['pool_id']}/view", json={"seed": 3, "count": 50}).json()
    rows = client.get("/api/reads/compact", params=dict(dataset_id=a, chrom=pool["chrom"], start=0, end=pool["width"])).json()["reads"]
    shown = {r["id"] for r in rows}
    big = client.post(f"/api/meta_locus/pools/{pool['pool_id']}/view", json={"seed": 3, "count": 400}).json()
    rows400 = client.get("/api/reads/compact", params=dict(dataset_id=a, chrom=pool["chrom"], start=0, end=pool["width"])).json()["reads"]
    extra_rows = [r for r in rows400 if r["id"] not in shown][:5]
    some = [[a, r["meta"]["identity"]["name"], r["meta"]["identity"]["site"]] for r in extra_rows]
    assert view["count"] == 50 and big["count"] == 400 and len(some) == 5
    _svg, man2 = render(client, source="defaults", dataset_ids=[a],
                        meta_locus={"pool_id": pool["pool_id"], "seed": 3, "count": 50, "extra_entries": some})
    ids2 = man2["panels"][0]["read_ids"]
    assert {r["id"] for r in extra_rows} <= set(ids2)
    assert sorted(ids2) == sorted(browser_ids(client, pool, a, 3, 50, extra=some))


def test_session_on_a_meta_view_rebuilds_its_pool_and_renames_the_contig(app, tmp_path):
    client, add, tmp = app
    did = add(DEMO, "demo")
    bed = bed_file(tmp)
    old_chrom = "meta:0123456789abcdef"  # saved on another computer: another pool id
    session = {
        "version": "2.0", "datasets": [{"id": did, "path": str(DEMO), "label": "demo"}],
        "viewport": {"chrom": old_chrom, "start": 500, "end": 2500},
        "frontend": {"chrom": old_chrom, "start": 500, "end": 2500,
                     "metaLocus": {"bed_path": str(bed), "name": "demo_sites", "anchor": "end", "flank_bp": 1500,
                                   "seed": 5, "count": 120, "extra_entries": [], "lastRealLocus": None,
                                   "pool_id": old_chrom[5:]},
                     "clusterAssignments": {did: {}}, "readSortOrder": {old_chrom: []}},
    }
    svg, man = render(client, session=session)
    pool = client.get("/api/meta_locus/pools").json()["pools"][0]
    assert man["region"]["start"] == 500 and man["region"]["end"] == 2500
    assert man["region"]["chrom"].startswith(f"meta:{pool['pool_id']}.v")
    assert man["meta_locus"]["source"] == "session" and man["meta_locus"]["anchor"] == "end"
    assert sorted(man["panels"][0]["read_ids"]) == sorted(browser_ids(client, pool, did, 5, 120, start=500, end=2500))
    assert ">end<" in svg

    gone = json.loads(json.dumps(session))
    gone["frontend"]["metaLocus"]["bed_path"] = str(tmp / "moved" / "demo_sites.bed")
    r = client.post("/api/render", json={"engine": "headless", "format": "svg", "session": gone})
    assert r.status_code == 404
    msg = r.json()["error"]
    assert "meta-locus BED is missing" in msg and "remap_session" in msg and "--remap" in msg


def test_rest_working_set_equals_the_view_when_filters_remove_reads_unevenly(app, tmp_path):
    """get_meta_locus_reads (POST .../reads) and the view (what the tab and figures read) top up filtered reads by
    different code; with the browser's default Min footprints they still give the same reads per dataset."""
    client, add, tmp = app
    copy = tmp_path / "demo_copy.bam"
    shutil.copy(DEMO, copy)
    shutil.copy(str(DEMO) + ".bai", str(copy) + ".bai")
    a, b = add(DEMO, "A"), add(copy, "B")
    pool = start_pool(client, bed_file(tmp, n=12), anchor="centre")
    ws = client.post(f"/api/meta_locus/pools/{pool['pool_id']}/reads",
                     json={"seed": 3, "count": 3000, "min_footprints": 5}).json()
    assert sum(ws["stats"][d]["filtered"] for d in (a, b)) > 0
    for d in (a, b):
        rest = {r["id"] for r in ws["reads"] if r["meta"]["dataset"] == d}
        assert rest == set(browser_ids(client, pool, d, 3, 3000)), d


def test_recluster_a_meta_locus_view_is_deterministic_and_saves_into_the_session(app, tmp_path):
    client, add, tmp = app
    did = add(DEMO, "demo")
    bed = bed_file(tmp)
    spec = {"bed": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 400}
    body = {"meta_locus": spec, "method": "kmeans", "k": 3, "seed": "fig-meta"}
    r1 = client.post("/api/render/cluster", json=body)
    assert r1.status_code == 200, r1.text
    r2 = client.post("/api/render/cluster", json=body)
    one, two = r1.json(), r2.json()
    res = one["results"][0]
    assert res["assignments"] == two["results"][0]["assignments"] and res["assignments"]
    assert set(res["cluster_counts"]) <= {"0", "1", "2"}
    # every assigned row is a read-site pair of the pool's seeded view (its site is known), keyed as panels key it
    assert all(res["sites"].get(rid) for rid in res["assignments"])
    some = next(iter(res["sites"].values()))
    assert {"key", "read_name", "site", "site_name", "chrom", "strand"} <= set(some) and "#site" in some["key"]
    # the default features: the anchor +- 500 bp
    rec = one["cluster"]
    assert rec["features_relative"] == [[-500, 500]] and rec["meta_locus"]["seed"] == 2
    # the saved session sits on the real pool's contig with its meta-locus block, and draws the clusters
    session = one["session"]
    pool = client.get("/api/meta_locus/pools").json()["pools"][0]
    assert session["viewport"]["chrom"] == f"meta:{pool['pool_id']}"
    ml = session["frontend"]["metaLocus"]
    assert (ml["seed"], ml["count"], ml["anchor"], ml["pool_id"]) == (2, 400, "start", pool["pool_id"])
    assert set(session["frontend"]["clusterAssignments"][did]) == set(res["assignments"])
    _svg, man = render(client, session=session)
    assert sum(man["panels"][0]["clusters"].values()) == man["panels"][0]["reads_drawn"]
    assert "unclustered" not in man["panels"][0]["clusters"]
    # another seed may give other labels, but the same seed always the same (two processes: test_headless_meta_locus_e2e)
    # the TSV: read-site keys and per-cluster counts
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from browser_client import BrowserClient
    tsv, counts = BrowserClient.write_cluster_tsv(one["results"], str(tmp / "meta.tsv"))
    head, *rows = Path(tsv).read_text().splitlines()
    assert head.split("\t") == ["panel", "dataset_id", "dataset_label", "read_id", "cluster", "read_site_key",
                                "read_name", "site", "site_name", "site_chrom", "site_strand"]
    assert len(rows) == len(res["assignments"]) and all(r.split("\t")[5].count("#site") == 1 for r in rows)
    assert sum(int(line.split("\t")[4]) for line in Path(counts).read_text().splitlines()[1:]) == len(rows)


def test_quantify_and_profile_a_pool_headlessly(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 400}
    q = client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "window": [-200, 50],
                                                      "spec": {"measures": ["layer:nuc", "layer:tf"]}})
    assert q.status_code == 200, q.text
    out = q.json()
    assert out["bounds"] == {"from": 1300, "to": 1550, "kind": "window", "windowMissing": False}
    assert out["comparison"] == "datasets"  # nothing clustered: per dataset, as the card does
    assert out["read_source"] == "fetch"    # one dataset, unclustered: the browser draws the server's metaprofile
    head = [line for line in out["tsv"].splitlines() if not line.startswith("#")][0].split("\t")
    assert head[:8] == ["measure", "source", "unit", "group", "n_reads", "members", "value", "lo95"]
    cells = out["result"]["cells"]
    assert len(cells) == 2 and all(c["lo"] <= c["value"] <= c["hi"] and c["method"] == "bootstrap" for c in cells)
    ml = out["meta_locus"]
    assert ml["seed"] == 2 and ml["count"] == 400 and len(ml["bed_sha256"]) == 64 and ml["sites"] == 8
    # the same seed gives the same table; another bootstrap seed other intervals, the same values
    again = client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "window": [-200, 50],
                                                          "spec": {"measures": ["layer:nuc", "layer:tf"]}}).json()
    assert again["tsv"] == out["tsv"]
    other = client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "window": [-200, 50],
                                                          "spec": {"measures": ["layer:nuc", "layer:tf"], "bootSeed": 9}}).json()
    assert [c["value"] for c in other["result"]["cells"]] == [c["value"] for c in cells]
    assert [c["lo"] for c in other["result"]["cells"]] != [c["lo"] for c in cells]
    # browser-only measures are refused with what to do instead
    bad = client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "spec": {"measures": ["fp:x"]}})
    assert bad.status_code == 400 and "quantify it in the browser" in bad.json()["error"]

    # clustered: curve units from the panels' profile pools; the profile export equals the drawn curve
    session = client.post("/api/render/cluster", json={"meta_locus": spec, "k": 3, "seed": "q"}).json()["session"]
    qc = client.post("/api/meta_locus/quantify", json={"session": session, "window": [-200, 50],
                                                       "spec": {"measures": ["layer:nuc"], "value": "enrichment"}}).json()
    assert qc["read_source"] == "panel" and qc["comparison"] == "clusters"
    assert {g["id"] for g in qc["result"]["groups"]} == {f"{did}|0", f"{did}|1", f"{did}|2"}  # one clustered panel (buildGroups)
    assert qc["result"]["measures"][0]["units"] == "curve" and qc["result"]["measures"][0]["baseline"] == "region"
    prof = client.post("/api/meta_locus/profile", json={"session": session, "channels": ["nuc", "tf"]}).json()
    assert set(prof["groups"]) == {"all", f"dataset:{did}", "cluster:0", "cluster:1", "cluster:2"}
    assert prof["bins"] == 500 and prof["axis_zero"] == 1500
    from services.figure.meta_locus import resolve
    from services.figure.spec import resolve_spec
    from services.figure.tracks import TrackContext
    from services.figure.data import DataCache
    from services.figure.tracks.composite import _local_profile
    import server as srv
    mv = resolve(srv.state, None, session)
    fs = resolve_spec(srv.state, source="session", session=mv.session)
    fs.fe["_metaLocus"] = mv.axis()
    from services.figure.meta_locus import draw_whole_working_set
    draw_whole_working_set(fs, mv, explicit_cap=False)
    ctx = TrackContext(srv.state, fs, fs.panels[0], DataCache(srv.state, fs), fs.width)
    drawn = _local_profile(ctx, did, {"nuc", "tf"})
    for ch in ("nuc", "tf"):
        assert prof["groups"][f"dataset:{did}"]["channels"][ch] == pytest.approx(drawn["layers"][ch], abs=1e-12)
    rows = [r.split("\t") for r in prof["tsv"].splitlines() if not r.startswith("#")]
    assert rows[0] == ["group", "channel", "bin", "rel_start", "rel_end", "value", "reads_covering"]
    assert float(rows[1][3]) == -1500.0 and len(rows) == 1 + 5 * 2 * 500


def test_a_meta_session_keeps_its_layer_colours_and_hidden_rows(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    bed = bed_file(tmp)
    session = {
        "version": "2.0", "datasets": [{"id": did, "path": str(DEMO), "label": "demo"}],
        "viewport": {"chrom": "meta:feedfacefeedface", "start": 0, "end": 3000},
        "frontend": {"chrom": "meta:feedfacefeedface", "start": 0, "end": 3000, "layerColorOverrides": {"nuc": "#13579b"},
                     "metaLocus": {"bed_path": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 1, "count": 150,
                                   "extra_entries": [], "pool_id": "feedfacefeedface"}},
    }
    svg, man = render(client, session=session, hide_tracks=["coverage"])
    assert "#13579b" in svg.lower()
    assert "coverage" not in man["panels"][0]["tracks"] and "gene" not in man["panels"][0]["tracks"]
    # a live tab's view of a pool (no meta-locus request): the axis comes from the contig's pool
    pool = client.get("/api/meta_locus/pools").json()["pools"][0]
    svg2, _ = render(client, source="defaults", chrom=pool["chrom"], start=0, end=3000)
    assert ">TSS<" in svg2 and "demo_sites · TSS ± 1.5 kb" in svg2


def test_a_session_quantify_block_is_used_when_the_call_gives_none(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200}
    session = client.post("/api/render/cluster", json={"meta_locus": spec, "k": 2, "seed": "w"}).json()["session"]
    session["frontend"]["windowQuant"] = {"version": 1, "window": {"chrom": "", "from": -150, "to": 60, "relative": True},
                                          "spec": {"measures": ["layer:tf"], "value": "enrichment"}, "openIn": "track",
                                          "axis": {"mode": "relative", "anchor": "site"}}
    out = client.post("/api/meta_locus/quantify", json={"session": session}).json()
    assert out["bounds"]["from"] == 1350 and out["bounds"]["to"] == 1560
    assert out["measures"] == ["layer:tf"] and out["spec"]["value"] == "enrichment"
    # the call's own fields win
    own = client.post("/api/meta_locus/quantify", json={"session": session, "window": [-10, 10],
                                                        "spec": {"value": "raw"}}).json()
    assert (own["bounds"]["from"], own["bounds"]["to"], own["spec"]["value"]) == (1490, 1510, "raw")
