"""Matched-window Find through the real route: BAM loading, pooling, inference and projection.

The e2e specs (lab/matched-region-analysis, class-region) stop the POST at 422/400, and the
backend's joint-discovery test starts from planted payloads. Here two equal-width windows of
one DddA BAM (300 reads of the tracked demo, renamed), the second one reversed, go through
POST /api/lab/region-classes, the real consensus job, the catalog route and the compact-reads
route; the jointly found classes must be projected into both windows at the oriented position
(a reversed window maps frame position x to window end - x).
"""
from __future__ import annotations

import statistics
import time

import pysam
import pytest

from realpath_helpers import DEMO_BAM, state_client

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing")
W = 300
WINDOWS = {"a": ("+", 47515000), "b": ("-", 47516000)}


def _subset(path, n=300):
    with pysam.AlignmentFile(str(DEMO_BAM)) as src, pysam.AlignmentFile(str(path), "wb", template=src) as out:
        k = 0
        for read in src.fetch("chr19", 47516000, 47516001):
            if read.reference_start <= 47515000 and k < n:
                read.query_name = f"synthetic-{k:04d}"
                out.write(read)
                k += 1
    pysam.index(str(path))
    assert k == n
    return str(path)


def _wait(client, job_id, timeout_s=240):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        job = client.get(f"/api/footprint/consensus/jobs/{job_id}").json()
        if job["status"] in ("complete", "failed", "cancelled", "error"):
            return job
        time.sleep(0.3)
    raise AssertionError(f"matched-window job {job_id} did not finish in {timeout_s} s")


def test_two_matched_windows_one_reversed_find_classes_projected_into_both(standalone_app, tmp_path):
    bam = _subset(tmp_path / "subset.bam")
    rows = [dict(name=name, dataset_id="d", genome=None, chrom="chr19", start=start, end=start + W, strand=strand)
            for name, (strand, start) in WINDOWS.items()]
    with state_client(standalone_app, {"d": bam}) as (client, _state):
        submitted = client.post("/api/lab/region-classes", json={
            "dataset_ids": ["d"], "region_windows": rows,
            "parameters": {"compute": {"cores": 2}, "recaller": {"learned_spots": False}}})
        assert submitted.status_code == 200, submitted.text
        job = _wait(client, submitted.json()["job_id"])
        assert job["status"] == "complete", job.get("message")
        assert set(job["summary"]) == {"d@a", "d@b"}
        assert job["request"]["region_source"] == "matched" and job["request"]["end"] == W

        catalog = client.get(f"/api/footprint/consensus/jobs/{job['job_id']}/catalog").json()
        assert catalog["region"] == {"chrom": "oriented_BED", "start": 0, "end": W}
        families = {alias: {c["family"]: (c["consensus_start"] + c["consensus_end"]) / 2 for c in body["catalog"]}
                    for alias, body in catalog["datasets"].items()}
        assert families["d@a"] and families["d@a"].keys() == families["d@b"].keys()  # found jointly
        frame_center = families["d@a"]

        for name, (strand, start) in WINDOWS.items():
            end = start + W
            reads = client.get("/api/reads/compact", params=dict(
                chrom="chr19", start=start, end=end, dataset_id="d", spanning=False, include_layers=True)).json()["reads"]
            records = [rec for r in reads for rec in ((r.get("layers") or {}).get("tf_cr") or {}).get("consensus_records", [])]
            assert records, f"no class layer projected into window {name}"
            # Records in this window come from this window's units only.
            assert {rec["source_call_id"].split("::")[0] for rec in records} == {f"d@{name}"}
            by_family = {}
            for rec in records:
                # Unclassified records keep the molecule's own call, which may run past the window;
                # a class call lies inside it.
                assert rec["interval"][0] < end and rec["interval"][1] > start, rec["interval"]
                if rec.get("family"):
                    assert start - 10 <= rec["interval"][0] < rec["interval"][1] <= end + 10, rec
                    by_family.setdefault(rec["family"], []).append(sum(rec["interval"]) / 2)
            assert by_family, f"no class-assigned call projected into window {name}"
            for family, centers in by_family.items():
                x = frame_center[family]
                expected = start + x if strand == "+" else end - x
                assert abs(statistics.median(centers) - expected) <= 25, (name, family, expected, centers)
