"""BrowserClient's 3.1 surfaces against the real server app (API parity, 3.1.1), not a request recorder.

tests/test_browser_client_parity311.py checks the requests each method sends with no server; here the same client
talks to the FastAPI app (server.app) through Starlette's TestClient, on the tracked NAPA demo BAM (real FiberHMM
output) and a small FASTA: the meta-locus pool lifecycle (start, wait, probe, list, view, reads, cancel, delete),
the sequence search status before and after a genome, recent and pinned genomes (list, pin, reorder, remove, clear)
and the default layer colours.
"""
from __future__ import annotations

from pathlib import Path

import pysam
import pytest
from fastapi.testclient import TestClient

from browser_client import BrowserClient

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


class AppClient(BrowserClient):
    """BrowserClient whose HTTP session is a TestClient on the real app."""

    def __init__(self, http: TestClient):
        self.url = ""
        self.token = None
        self._session = _Session(http)


class _Session:
    def __init__(self, http):
        self.http = http
        self.headers = {}

    def _call(self, method, url, **kw):
        kw.pop("timeout", None)
        r = getattr(self.http, method)(url, **kw)
        return r

    def get(self, url, **kw):
        return self._call("get", url, **kw)

    def post(self, url, **kw):
        return self._call("post", url, **kw)

    def put(self, url, **kw):
        return self._call("put", url, **kw)

    def delete(self, url, **kw):
        return self._call("delete", url, **kw)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("FIBERBROWSER_RECENT_GENOMES", str(tmp_path / "recent_genomes.json"))
    monkeypatch.setenv("FIBERBROWSER_PREFERENCES", str(tmp_path / "analysis_preferences.json"))
    import server as srv
    from plugins import init_context
    from services import meta_locus_jobs as mj
    from services.local_auth import auth_headers
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    mj._pools.clear()
    http = TestClient(srv.app, headers=auth_headers())
    c = AppClient(http)
    added = http.post("/api/datasets/add", json={"path": str(DEMO), "label": "demo"}).json()
    did = added.get("id") or added.get("dataset_id") or (added.get("dataset") or {}).get("id")
    assert did, added
    yield c, did, tmp_path
    for p in list(mj._pools.values()):
        p.cancel.set()
    mj._pools.clear()
    srv.state = old


def _demo_sites(tmp_path, n=6):
    with pysam.AlignmentFile(str(DEMO)) as f:
        starts = sorted(r.reference_start for r in f.fetch("chr19"))
    lo, hi = starts[len(starts) // 4], starts[3 * len(starts) // 4]
    step = max(1, (hi - lo) // n)
    bed = tmp_path / "sites.bed"
    bed.write_text("".join(f"chr19\t{lo + i * step}\t{lo + i * step + 50}\tsite{i}\t0\t{'+-'[i % 2]}\n" for i in range(n)))
    return bed, n


def test_meta_locus_pool_lifecycle_through_the_client(client):
    c, did, tmp_path = client
    bed, n = _demo_sites(tmp_path)
    assert c.probe_meta_locus_pool(bed_path=str(bed), dataset_ids=[did], flank_bp=500)["cached"] is False
    status = c.start_meta_locus_pool(bed_path=str(bed), dataset_ids=[did], flank_bp=500, name="sites", wait=True,
                                     timeout=300, poll_interval=0.2)
    assert status["status"] == "ready", status
    pid = status["pool_id"]
    assert status["sites"] == n and status["width"] == 1000 and status["axis_offset"] == -500
    assert status["chrom"] == f"meta:{pid}"
    assert c.probe_meta_locus_pool(bed_path=str(bed), dataset_ids=[did], flank_bp=500) == {
        "success": True, "cached": True, "pool_id": pid, "sites": n}
    assert [p["pool_id"] for p in c.list_meta_locus_pools()] == [pid]
    view = c.get_meta_locus_view(pid)
    assert view["success"] and view["chrom"] == f"meta:{pid}" and view["width"] == 1000

    first = c.get_meta_locus_reads(pid, seed=3, count=40)
    again = c.get_meta_locus_reads(pid, seed=3, count=40)
    assert first["reads"] and [r["id"] for r in first["reads"]] == [r["id"] for r in again["reads"]]   # seeded
    sites = {r["meta"]["site"] if isinstance(r.get("meta"), dict) and "site" in r["meta"] else None for r in first["reads"]}
    assert sites and None not in sites
    with pytest.raises(ValueError, match="Not a meta-locus read filter"):
        c.get_meta_locus_reads(pid, include_qcfail=True)

    assert c.cancel_meta_locus_pool(pid)["status"] in ("ready", "cancelled")
    assert c.delete_meta_locus_pool(pid)["success"] is True
    assert c.list_meta_locus_pools() == []


def test_sequence_search_status_follows_the_loaded_genome(client):
    c, _did, tmp_path = client
    before = c.get_sequence_search_status()
    assert before["searchable"] is False
    fa = tmp_path / "small.fa"
    fa.write_text(">chrA\n" + "ACGTTGCA" * 500 + "\n")
    pysam.faidx(str(fa))
    assert c.load_fasta(str(fa)).get("success")
    after = c.get_sequence_search_status()
    assert after["searchable"] is True and "defaults" in after


def test_recent_genomes_list_pin_reorder_remove_clear(client):
    c, _did, tmp_path = client
    keys = []
    for name in ("one", "two"):
        fa = tmp_path / f"{name}.fa"
        fa.write_text(f">chr{name}\n" + "ACGT" * 300 + "\n")
        pysam.faidx(str(fa))
        assert c.load_fasta(str(fa)).get("success")
        keys.append(str(fa))
    listing = c.get_recent_genomes()
    assert [e["key"] for e in listing["recent"]][:2] == keys[::-1]      # most recent first
    c.pin_genome(keys[0])
    c.pin_genome(keys[1])
    assert [e["key"] for e in c.get_recent_genomes()["pinned"]] == keys
    c.reorder_pinned_genomes(keys[::-1])
    assert [e["key"] for e in c.get_recent_genomes()["pinned"]] == keys[::-1]
    c.pin_genome(keys[0], pinned=False)
    c.clear_recent_genomes()                                            # recent go, pinned stay
    listing = c.get_recent_genomes()
    assert [e["key"] for e in listing["pinned"]] == [keys[1]] and listing["recent"] == []
    c.remove_recent_genome(keys[1])
    assert c.get_recent_genomes()["pinned"] == []


def test_default_layer_colours_round_trip(client):
    c, _did, _tmp = client
    saved = c.set_default_layer_colors(nuc="#FFD400", tf=None)
    assert saved.get("nuc") == "#ffd400"
    colors = c.get_layer_colors()
    assert colors["saved_defaults"].get("nuc") == "#ffd400" and colors["effective"].get("nuc") == "#ffd400"
    # Save as my default colours: the effective colours become the saved ones (no change here)
    assert c.save_layer_colors_as_default().get("nuc") == "#ffd400"
    assert c.set_default_layer_colors(nuc=None).get("nuc") is None
    with pytest.raises(ValueError):
        c.set_default_layer_colors()
