"""Find classes on a meta-locus: fiberhmm-consensus's pooled oriented-BED run over the view, through the ordinary
job route, displayed on the virtual contig (services/meta_locus_consensus)."""
from __future__ import annotations

import time

import pysam
import pytest

from realpath_helpers import DEMO_BAM, state_client

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing")
FLANK = 150
SITES = [("+", 47515150), ("-", 47516150)]


def _subset(path, n=300):
    with pysam.AlignmentFile(str(DEMO_BAM)) as src, pysam.AlignmentFile(str(path), "wb", template=src) as out:
        k = 0
        for read in src.fetch("chr19", 47516000, 47516001):
            if read.reference_start <= 47515000 and k < n:
                read.query_name = f"synthetic-{k:04d}"
                out.write(read)
                k += 1
    pysam.index(str(path))
    return str(path)


def _wait(client, url, done, timeout_s=300):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        body = client.get(url).json()
        if done(body):
            return body
        time.sleep(0.3)
    raise AssertionError(f"{url} did not finish in {timeout_s} s")


def test_find_classes_on_a_meta_locus(standalone_app, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "cache"))
    from services import meta_locus_jobs as mj
    mj._pools.clear()
    bam = _subset(tmp_path / "subset.bam")
    bed = tmp_path / "two_sites.bed"
    bed.write_text("".join(f"chr19\t{a}\t{a + 1}\ts{i}\t0\t{strand}\n" for i, (strand, a) in enumerate(SITES)))
    with state_client(standalone_app, {"d": bam}) as (client, _state):
        pool = client.post("/api/meta_locus/pools", json={"bed_path": str(bed), "flank_bp": FLANK, "count": 600,
                                                          "dataset_ids": ["d"]}).json()
        pid, chrom, width = pool["pool_id"], pool["chrom"], pool["width"]
        _wait(client, f"/api/meta_locus/pools/{pid}", lambda b: b["status"] != "building")
        submitted = client.post("/api/footprint/consensus/jobs", json={
            "dataset_ids": ["d"], "chrom": chrom, "start": 0, "end": width,
            "parameters": {"compute": {"cores": 2}, "recaller": {"learned_spots": False}}})
        assert submitted.status_code == 200, submitted.text
        job = _wait(client, f"/api/footprint/consensus/jobs/{submitted.json()['job_id']}",
                    lambda b: b["status"] in ("complete", "failed", "cancelled", "error"))
        assert job["status"] == "complete", job.get("message")
        req = job["request"]
        assert req["region_source"] == "meta_locus" and req["meta_pool"] == pid and req["end"] == width
        assert req["meta_sites"] == len(SITES)

        catalog = client.get(f"/api/footprint/consensus/jobs/{job['job_id']}/catalog").json()
        assert catalog["region"] == {"chrom": "oriented_BED", "start": 0, "end": width}

        # The classes show on the virtual contig, on the view's rows, at the pooled-frame positions.
        reads = client.get("/api/reads/compact", params=dict(chrom=chrom, start=0, end=width, dataset_id="d",
                                                             spanning=False, include_layers=True)).json()["reads"]
        matched = [r for r in reads if (r.get("consensus_projection") or {}).get("status") == "matched"]
        records = [rec for r in matched for rec in ((r.get("layers") or {}).get("tf_cr") or {}).get("consensus_records", [])]
        assert matched and records
        assert all(rec["interval"][0] < width and rec["interval"][1] > 0 for rec in records)
        # A class call sits at its family's pooled-frame position: the frame is the virtual contig, on both strands.
        frame = {c["family"]: (c["consensus_start"] + c["consensus_end"]) / 2
                 for body in catalog["datasets"].values() for c in body["catalog"]}
        by_family = {}
        for rec in records:
            if rec.get("family"):
                assert -10 <= rec["interval"][0] < rec["interval"][1] <= width + 10, rec
                by_family.setdefault(rec["family"], []).append(sum(rec["interval"]) / 2)
        assert by_family
        import statistics
        for family, centers in by_family.items():
            assert abs(statistics.median(centers) - frame[family]) <= 25, (family, frame[family], centers)

        # ... and at a real site through the existing projection of pooled runs.
        a = SITES[0][1]
        real = client.get("/api/reads/compact", params=dict(chrom="chr19", start=a - FLANK, end=a + FLANK, dataset_id="d",
                                                            spanning=False, include_layers=True)).json()["reads"]
        assert any(((r.get("layers") or {}).get("tf_cr") or {}).get("consensus_records") for r in real)
