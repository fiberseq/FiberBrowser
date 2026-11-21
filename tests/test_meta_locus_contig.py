"""Meta-locus phase 3: the virtual contig meta:<pool> through the ordinary routes (reads, cluster, filter, sort,
coverage), the view (More reads, Resample, session restore of refill reads), refill and find more."""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "cache"))
    import server as srv
    from plugins import init_context
    from services import meta_locus_jobs as mj
    from services.local_auth import auth_headers
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    mj._pools.clear()
    client = TestClient(srv.app, headers=auth_headers())
    added = client.post("/api/datasets/add", json={"path": str(DEMO), "label": "demo"})
    assert added.status_code == 200, added.text
    body = added.json()
    did = body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")
    yield client, did, tmp_path
    for p in list(mj._pools.values()):
        p.cancel.set()
    mj._pools.clear()
    srv.state = old


def _bed(tmp_path, n=8, flank_hint=0):
    import pysam
    with pysam.AlignmentFile(str(DEMO)) as f:
        spans = [(r.reference_start, r.reference_end) for r in f.fetch("chr19")]
    lo, hi = min(a for a, _ in spans), max(b for _, b in spans)
    path = tmp_path / "demo_sites.bed"
    path.write_text("".join(f"chr19\t{lo + (hi - lo) * (i + 1) // (n + 1)}\t{lo + (hi - lo) * (i + 1) // (n + 1) + 1}\ts{i}\t0\t{'+-'[i % 2]}\n"
                            for i in range(n)))
    return path


def _ready(client, pid, timeout=60):
    t = time.monotonic()
    while True:
        st = client.get(f"/api/meta_locus/pools/{pid}").json()
        if st["status"] != "building" or time.monotonic() - t > timeout:
            return st
        time.sleep(0.05)


def test_virtual_contig_through_the_ordinary_routes(app_client):
    client, did, tmp = app_client
    started = client.post("/api/meta_locus/pools", json={"bed_path": str(_bed(tmp)), "flank_bp": 1500, "count": 300}).json()
    assert started["label"] == "demo_sites · centre ± 1.5 kb" and started["width"] == 3000 and started["axis_offset"] == -1500
    st = _ready(client, started["pool_id"])
    assert st["status"] == "ready" and st["view"]["count"] == 300
    chrom, width = st["chrom"], st["width"]

    reads = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()
    rows = reads["reads"]
    assert 0 < len(rows) <= 300
    r = rows[0]
    assert {"site", "site_name", "window", "real", "identity", "shared"} <= set(r["meta"])
    assert all(0 <= iv[0] <= iv[1] <= width for row in rows for iv in row["intervals"])
    # absolute geometry is on the virtual contig too (reads extend past the window; the real span is in meta.real)
    assert all(-20000 < row["aligned_blocks"][0][0] < width + 20000 for row in rows if row.get("aligned_blocks"))
    assert all(row["meta"]["real"]["chrom"] == "chr19" for row in rows)

    # a sub-view of the virtual contig, like any view
    part = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=1000, end=2000)).json()["reads"]
    assert part and all(0 <= iv[0] <= iv[1] <= 1000 for row in part for iv in row["intervals"])

    # clustering, filters, sort and coverage work unchanged on the virtual contig
    cl = client.post("/api/cluster_all", params=dict(chrom=chrom, start=0, end=width),
                     json={"peak_regions": [{"start": 1300, "end": 1700, "mode": "nuc"}], "k": 2, "method": "kmeans",
                           "dataset_ids": [did]})
    assert cl.status_code == 200, cl.text
    assigned = cl.json()
    assert assigned.get("success", True)
    srt = client.post("/api/sort_reads", params=dict(chrom=chrom, start=0, end=width, dataset_id=did),
                      json={"sort_by": "coverage", "region_start": 1300, "region_end": 1700})
    assert srt.status_code in (200, 422), srt.text
    cov = client.get("/api/coverage", params=dict(chrom=chrom, start=0, end=width, dataset_id=did))
    assert cov.status_code in (200, 404, 422), cov.text

    # More reads / Resample change the generation and the reads
    v1 = client.post(f"/api/meta_locus/pools/{st['pool_id']}/view", json={"more": 200}).json()
    assert v1["count"] == 500 and v1["generation"] > st["view"]["generation"]
    more = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]
    assert len(more) > len(rows) and {x["id"] for x in rows} <= {x["id"] for x in more}
    v2 = client.post(f"/api/meta_locus/pools/{st['pool_id']}/view", json={"resample": True, "count": 300}).json()
    assert v2["seed"] == 2
    other = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]
    assert {x["id"] for x in other} != {x["id"] for x in rows}


def test_find_more_refill_and_session_restore(app_client):
    client, did, tmp = app_client
    started = client.post("/api/meta_locus/pools", json={"bed_path": str(_bed(tmp)), "flank_bp": 800, "count": 120}).json()
    pid = started["pool_id"]
    st = _ready(client, pid)
    chrom, width = st["chrom"], st["width"]
    rows = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]
    covering = [r for r in rows if min(iv[0] for iv in r["intervals"]) <= 100 and max(iv[1] for iv in r["intervals"]) >= width - 100]
    assert len(covering) >= 5
    fm = client.post(f"/api/meta_locus/pools/{pid}/find_more",
                     json={"read_ids": {did: [r["id"] for r in covering[:5]]}, "k": 30, "max_scan": 3000})
    assert fm.status_code == 200, fm.text
    out = fm.json()
    assert out["unit"] == "read-site observations" and out["scanned"] > 0
    assert 0 <= out["wilson"][0] <= (out["freq"] or 0) <= out["wilson"][1] <= 1
    assert out["added"] == out["found"] and out["view"]["enriched"] == (out["added"] > 0)
    shown = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]
    assert len(shown) >= len(rows) + out["added"] * 0.9  # added reads are shown (a few may be filtered)

    # refill with the client's cluster labels (any clusterer)
    labels = {r["id"]: i % 2 for i, r in enumerate(rows)}
    rf = client.post(f"/api/meta_locus/pools/{pid}/refill",
                     json={"assignments": {did: labels}, "target_per_cluster": 80, "max_scan": 3000})
    assert rf.status_code == 200, rf.text
    per = rf.json()["per_cluster"]
    assert {p["cluster"] for p in per} == {0, 1} and all(p["scanned"] == rf.json()["assignable"] for p in per)
    # the added reads come with their cluster labels, under the ids the display shows
    new = rf.json()["assignments"].get(did, {})
    assert len(new) == sum(p["added"] for p in per)
    shown_ids = {r["id"] for r in client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]}
    assert set(new) <= shown_ids

    # a session saves seed, count and the added reads; a new server restores the same view
    view = client.get(f"/api/meta_locus/pools/{pid}/view").json()
    saved = {"bed_path": str(tmp / "demo_sites.bed"), "flank_bp": 800, "seed": view["seed"], "count": view["count"],
             "extra_entries": view["extra_entries"]}
    before = {r["id"] for r in client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]}
    from services import meta_locus_jobs as mj
    mj._pools.clear()
    again = client.post("/api/meta_locus/pools", json={"bed_path": saved["bed_path"], "flank_bp": 800}).json()
    assert again["pool_id"] == pid and _ready(client, pid)["status"] == "ready"
    restored = client.post(f"/api/meta_locus/pools/{pid}/view", json={"seed": saved["seed"], "count": saved["count"],
                                                                      "extra_entries": saved["extra_entries"]}).json()
    assert restored["extra_count"] == len(saved["extra_entries"])
    after = {r["id"] for r in client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]}
    assert after == before
