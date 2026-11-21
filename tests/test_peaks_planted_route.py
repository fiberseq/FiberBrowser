"""Peaks through the real route on planted loci, then Cluster and Sort with no conditional skip.

The e2e peak specs skip when a view has no peaks, and "produces peaks" only checks that a list
came back. Here a synthetic BAM has one planted open locus (open in 70% of reads) and one
locus closed in every read: /api/scan_peaks must call exactly one peak, over the open locus;
/api/cluster_all on that peak must split the reads into the planted open and closed groups;
/api/sort_reads must keep each cluster together. Nothing is patched.
"""
from __future__ import annotations

from realpath_helpers import CLOSED_LOCUS, OPEN_LOCUS, READ_END, READ_START, planted_bam, state_client

Q = f"chrom=chrP&start={READ_START}&end={READ_END}"


def test_planted_peak_then_cluster_then_sort(standalone_app, tmp_path):
    bam, open_reads = planted_bam(tmp_path / "planted.bam")
    with state_client(standalone_app, {"p": bam}) as (client, _state):
        scan = client.post(f"/api/scan_peaks?{Q}&dataset_id=p", json={})
        assert scan.status_code == 200, scan.text
        body = scan.json()
        assert body["n_reads"] == 40
        peaks = body["peaks"]
        assert len(peaks) == 1, peaks  # the planted locus, and nothing from the packed background
        (peak,) = peaks
        assert peak["start"] < OPEN_LOCUS[1] and peak["end"] > OPEN_LOCUS[0]
        assert peak["layer"] == 0  # 70% open: a Strong peak
        assert not (peak["start"] < CLOSED_LOCUS[1] and peak["end"] > CLOSED_LOCUS[0])
        assert body["broad_peaks"] == []

        regions = [{"start": peak["start"], "end": peak["end"], "mode": "accessibility"}]
        cluster = client.post(f"/api/cluster_all?{Q}", json={"dataset_ids": ["p"], "peak_regions": regions, "k": 2})
        assert cluster.status_code == 200, cluster.text
        result = cluster.json()["results"]["p"]
        assignments = result["assignments"]
        assert set(assignments) == set(result["filtered_read_ids"]) and len(assignments) == 40
        groups = {}
        for read, cluster_id in assignments.items():
            groups.setdefault(cluster_id, set()).add(read)
        assert sorted(map(frozenset, groups.values()), key=len) == sorted(
            [frozenset(open_reads), frozenset(set(assignments) - open_reads)], key=len)
        patterns = cluster.json()["cluster_patterns"]
        open_cluster = assignments[next(iter(open_reads))]
        assert patterns[str(open_cluster)] == [1]  # the open group's pattern: accessible at the peak

        sort = client.post(f"/api/sort_reads?{Q}", json={
            "dataset_ids": ["p"], "sort_by": "accessibility", "cluster_assignments": {"p": assignments},
            "peak_regions": [[peak["start"], peak["end"]]]})
        assert sort.status_code == 200, sort.text
        ordered = sort.json()["results"]["p"]["read_sort_order"]
        assert sorted(ordered) == sorted(assignments)
        # Reads of one cluster stay together, in the returned cluster order.
        runs = [assignments[r] for r in ordered]
        assert runs == sorted(runs, key=sort.json()["results"]["p"]["cluster_order"].index)
