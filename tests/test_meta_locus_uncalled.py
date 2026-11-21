"""Meta-locus and the uncalled rule (FiberBrowser 3.0.6): reads without footprint calls are hidden by default and the
working set is refilled from the pool with called reads, as for any filtered read; "All reads, including uncalled"
(hide_uncalled=false) includes them. Pool building records which molecules are uncalled, so they are never decoded or
counted under the rule; refill and find-more scans follow the request's rule."""
from __future__ import annotations

import time
from array import array
from pathlib import Path

import pysam
import pytest
from starlette.testclient import TestClient

N_SITES, SPACING = 12, 5000


def _bam(path: Path) -> str:
    """Reads around sites on chrT: names c* carry ns/nl footprint calls, u* carry none (uncalled), q* carry none but
    are QC-fail (left to the QC-fail filter, not the uncalled rule)."""
    import random
    rng = random.Random(5)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": N_SITES * SPACING + 40_000}]}
    recs = []
    for i in range(N_SITES):
        a = 10_000 + i * SPACING
        for j in range(30):
            length = rng.randint(2500, 6000)
            s = max(1, rng.randint(a - length + 300, a - 300))
            kind = "u" if j % 3 == 0 else "q" if j == 1 else "c"
            recs.append((s, f"{kind}{i:02d}_{j:02d}", length, kind))
    recs.sort()
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for s, name, length, kind in recs:
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.reference_id, r.reference_start, r.mapping_quality = name, 0, s, 60
            r.flag = 512 if kind == "q" else 0
            r.query_sequence = "ACGT" * (length // 4) + "ACGT"[: length % 4]
            r.cigarstring = f"{length}M"
            if kind == "c":
                fps = list(range(40, length - 200, 190))
                r.set_tag("ns", array("I", fps))
                r.set_tag("nl", array("I", [147] * len(fps)))
            out.write(r)
    pysam.index(str(path))
    return str(path)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "cache"))
    import server as srv
    from plugins import init_context
    from services import meta_locus_jobs as mj
    from services.local_auth import auth_headers
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    mj._pools.clear()
    c = TestClient(srv.app, headers=auth_headers())
    bam = _bam(tmp_path / "u.bam")
    added = c.post("/api/datasets/add", json={"path": bam, "label": "u"})
    assert added.status_code == 200, added.text
    body = added.json()
    did = body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")
    bed = tmp_path / "sites.bed"
    bed.write_text("".join(f"chrT\t{10_000 + i * SPACING}\t{10_001 + i * SPACING}\ts{i}\t0\t{'+-'[i % 2]}\n" for i in range(N_SITES)))
    yield c, did, bed
    for p in list(mj._pools.values()):
        p.cancel.set()
    mj._pools.clear()
    srv.state = old


def _ready(c, pid, timeout=60):
    t = time.monotonic()
    while True:
        st = c.get(f"/api/meta_locus/pools/{pid}").json()
        if st["status"] != "building" or time.monotonic() - t > timeout:
            return st
        time.sleep(0.05)


def _names(reads):
    return [str((r.get("meta") or {}).get("identity", {}).get("name") or r["id"]).split("#")[0] for r in reads]


def test_pool_index_knows_uncalled_molecules(client):
    from services import meta_locus_jobs as mj
    c, did, bed = client
    st = c.post("/api/meta_locus/pools", json={"bed_path": str(bed), "flank_bp": 1000}).json()
    st = _ready(c, st["pool_id"])
    assert st["status"] == "ready"
    ix = mj.get_pool(st["pool_id"]).indexes[did]
    uncalled = {n for n, called in zip(ix.names, ix.called.tolist()) if not called}
    assert uncalled and all(n.startswith("u") for n in uncalled)            # QC-fail uncalled ones count as called here
    assert ix.n_entries(True) < ix.n_entries(False) == len(ix)
    # the sampling order under the rule holds no uncalled molecule, and is the full order with them taken out
    full, hidden = ix.ranked(1, False), ix.ranked(1, True)
    assert not any(ix.names[int(ix.mol[e])] in uncalled for e in hidden)
    assert [int(e) for e in full if ix.names[int(ix.mol[e])] not in uncalled] == [int(e) for e in hidden]


def test_view_hides_uncalled_by_default_and_refills_with_called_reads(client):
    c, did, bed = client
    st = c.post("/api/meta_locus/pools", json={"bed_path": str(bed), "flank_bp": 1000}).json()
    st = _ready(c, st["pool_id"])
    chrom, width = st["chrom"], st["width"]
    view = c.post(f"/api/meta_locus/pools/{st['pool_id']}/view", json={"seed": 1, "count": 120}).json()
    base = f"/api/reads/compact?chrom={chrom}&start=0&end={width}&dataset_id={did}&max_reads=0"

    shown = c.get(base).json()["reads"]
    names = _names(shown)
    assert names and not any(n.startswith("u") for n in names)
    # refilled: the view shows its count of called reads (the uncalled ones replaced from the pool)
    assert len(shown) == 120
    assert view["pool_observations"][did] < c.get(f"/api/meta_locus/pools/{st['pool_id']}/view?hide_uncalled=false").json()["pool_observations"][did]

    # "All reads, including uncalled": they are in the view
    everything = c.get(base + "&hide_uncalled=false").json()["reads"]
    assert any(n.startswith("u") for n in _names(everything))
    assert len(everything) == 120


def test_find_more_and_refill_never_add_uncalled_reads_by_default(client):
    c, did, bed = client
    st = c.post("/api/meta_locus/pools", json={"bed_path": str(bed), "flank_bp": 1000}).json()
    st = _ready(c, st["pool_id"])
    pid, chrom, width = st["pool_id"], st["chrom"], st["width"]
    c.post(f"/api/meta_locus/pools/{pid}/view", json={"seed": 1, "count": 60})
    reads = c.get(f"/api/reads/compact?chrom={chrom}&start=0&end={width}&dataset_id={did}&max_reads=0").json()["reads"]
    out = c.post(f"/api/meta_locus/pools/{pid}/find_more", json={"read_ids": {did: [r["id"] for r in reads[:5]]}, "k": 50}).json()
    assert out["success"] is not False
    view = c.get(f"/api/meta_locus/pools/{pid}/view").json()
    assert not any(str(name).startswith("u") for _d, name, _s in view["extra_entries"])
    # the honest frequency's denominator is read-site observations of called reads only (the rule's pool)
    assert out["scanned"] <= view["pool_observations"][did]
    assignments = {did: {r["id"]: i % 2 for i, r in enumerate(reads)}}
    filled = c.post(f"/api/meta_locus/pools/{pid}/refill", json={"assignments": assignments, "target_per_cluster": 60}).json()
    assert filled["success"] is not False
    view = c.get(f"/api/meta_locus/pools/{pid}/view").json()
    assert not any(str(name).startswith("u") for _d, name, _s in view["extra_entries"])
