"""Hub Cluster through the real route on the tracked demo BAM (nothing patched).

test_clustering_endpoint.py patches cluster_compact_reads and compute_cluster_projection; the
only unpatched route runs were integration-gated. This scans the demo view for peaks, clusters
on them through /api/cluster_all, and projects the result through /api/cluster_projection.
"""
from __future__ import annotations

import pytest

from realpath_helpers import DEMO_BAM, state_client

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing")
Q = "chrom=chr19&start=47514500&end=47518500"


def test_cluster_all_on_the_demo_bam_assigns_every_analysed_read(standalone_app):
    with state_client(standalone_app, {"demo": str(DEMO_BAM)}) as (client, state):
        peaks = client.post(f"/api/scan_peaks?{Q}&dataset_id=demo", json={}).json()["peaks"]
        strong = [p for p in peaks if p["layer"] <= 1][:4]
        assert len(strong) >= 2, peaks
        regions = [{"start": p["start"], "end": p["end"], "mode": "accessibility"} for p in strong]
        response = client.post(f"/api/cluster_all?{Q}", json={
            "dataset_ids": ["demo"], "peak_regions": regions, "k": 3, "max_reads": 300, "sample_seed": "t"})
        assert response.status_code == 200, response.text
        body = response.json()
        result = body["results"]["demo"]
        assignments = result["assignments"]
        assert assignments and set(assignments) == set(result["filtered_read_ids"])
        assert result["analysis_read_count"] == len(assignments) <= 300
        assert len(set(assignments.values())) >= 2  # real clusters, not one bucket
        assert sum(result["cluster_counts"].values()) == len(assignments)
        assert {int(k) for k in result["cluster_counts"]} == set(assignments.values())
        # The clusters are kept on the dataset for the next steps (sort, projection, export).
        assert state.datasets["demo"].cluster_assignments == assignments
        # Every analysed read is a demo read in this window.
        ws = state.build_working_set("demo", "chr19", 47514500, 47518500)
        assert set(assignments) <= {r["id"] for r in ws.reads}

        projection = client.post(f"/api/cluster_projection?{Q}", json={
            "dataset_ids": ["demo"], "peak_regions": regions, "sample_seed": "t"})
        assert projection.status_code == 200, projection.text
        proj = projection.json()
        ids = [r.split("::", 1)[-1] for r in proj["read_ids"]]
        assert len(ids) == len(proj["coords_x"]) == len(proj["coords_y"]) == len(assignments)
        assert set(ids) == set(assignments)
        # The map is coloured by the clusters just computed.
        assert [assignments[r] for r in ids] == [int(x) for x in proj["labels_before"]]
