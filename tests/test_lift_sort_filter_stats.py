"""Toolbar Sort, Filter and Read Stats on live-lift datasets (graph features, item 2).

The routes take lifted datasets now: rows come from the dataset's analysis cohort on target coordinates, results
name lifted rows by their cohort identity (``analysis_id``; one record's rows share a QNAME), a split panel's
haplotype narrows the rows, and Read Stats takes alignment fields from each row's own source record. Every other
analysis stays default-deny (the refusal matrix in test_live_lift_refusals.py).
"""
import pytest

from live_lift_fixtures import MAT, PAT, TARGET
from test_live_lift_endpoints import _add, lift_env  # noqa: F401 - fixture

WINDOW = dict(chrom=TARGET, start=1000, end=19000)
PREFIX = "lift-cohort:v1 "


def _qname(aid):
    import json
    return json.loads(aid[len(PREFIX):])[1]


def _sort(client, did, **body):
    r = client.post("/api/sort_reads", params=WINDOW, json={"dataset_ids": [did], "sort_by": "fp_count", **body})
    assert r.status_code == 200, r.text
    return r.json()["results"][did]


def test_sort_names_lifted_rows_by_cohort_identity(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    out = _sort(client, did)
    order = out["read_sort_order"]
    assert order and all(i.startswith(PREFIX) for i in order)
    assert len(order) == len(set(order))
    assert {"plus", "minus", "pat"} <= {_qname(i) for i in order}
    # fp_count descending: "plus" (three footprints) comes first.
    assert _qname(order[0]) == "plus"


def test_sort_follows_a_split_panels_haplotype(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    mat = {_qname(i) for i in _sort(client, did, lift_hap_by_dataset={did: "MAT"})["read_sort_order"]}
    pat = {_qname(i) for i in _sort(client, did, lift_hap_by_dataset={did: "PAT"})["read_sort_order"]}
    assert "plus" in mat and "pat" not in mat
    assert "pat" in pat and "plus" not in pat


def test_sort_by_cluster_uses_lifted_assignments(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    ids = _sort(client, did)["read_sort_order"]
    assignments = {i: (0 if _qname(i) == "plus" else 1) for i in ids}
    out = _sort(client, did, cluster_assignments={did: assignments})
    # Cluster 0 (one read, three footprints) has the larger mean.
    assert out["cluster_order"] == [0, 1]
    assert set(out["read_sort_order"]) == set(ids)


def test_filters_return_cohort_identities(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    r = client.post("/api/filter_by_analysis_rule", params=WINDOW,
                    json={"dataset_ids": [did], "metric": "count", "operator": "gte", "threshold": 2,
                          "rule": {"size_min": 1, "size_max": None, "conditions": []}})
    assert r.status_code == 200, r.text
    res = r.json()["results"][did]
    assert res["read_ids"] and all(i.startswith(PREFIX) for i in res["read_ids"])
    assert {_qname(i) for i in res["read_ids"]} == {"plus", "pat"}
    assert res["total"] >= 3
    r = client.post("/api/filter", params={**WINDOW, "dataset_id": did}, json={"peak_regions": [], "filter_mode": "either"})
    assert r.status_code == 200, r.text
    assert all(i.startswith(PREFIX) for i in r.json()["read_ids"])


def test_read_stats_describe_lifted_reads_from_their_source_records(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    r = client.post("/api/reads/stats", params=WINDOW, json={"read_ids_by_dataset": {did: ["plus", "pat", "nope"]}})
    assert r.status_code == 200, r.text
    out = r.json()
    rows = {e["read_id"]: e for e in out["per_read"]}
    assert set(rows) == {"plus", "pat"}
    assert out["found_count"] == 2 and out["requested_count"] == 3
    assert out["missing_read_ids_by_dataset"] == {did: ["nope"]}
    plus = rows["plus"]
    assert plus["coordinates"] == "source" and plus["ref_contig"] == MAT and plus["ref_start"] == 2500
    assert plus["aligned_span"] == 3300 and plus["mapq"] is not None
    assert plus["footprint_count"] >= 2
    assert rows["pat"]["ref_contig"] == PAT
    assert out["is_bam"] is True


def test_read_stats_one_read_has_its_source_cigar(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    sort = _sort(client, did)["read_sort_order"]
    aid = next(i for i in sort if _qname(i) == "plus")
    r = client.post("/api/reads/stats", params=WINDOW, json={"read_ids_by_dataset": {did: [aid]}})
    assert r.status_code == 200, r.text
    (row,) = r.json()["per_read"]
    assert row["read_id"] == aid and row["cigar_string"] == "3300M"


def test_read_stats_mixed_native_and_lifted(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    native = state.add_dataset("native", bam).id
    # The native BAM is on the source contigs; at the target window it has no reads, so its id is missing.
    r = client.post("/api/reads/stats", params=WINDOW,
                    json={"read_ids_by_dataset": {did: ["plus"], native: ["plus"]}})
    assert r.status_code == 200, r.text
    assert [e["dataset_id"] for e in r.json()["per_read"]] == [did]


@pytest.mark.parametrize("path", ["/api/filter_by_transcription_state", "/api/scan_peaks"])
def test_other_analyses_still_refuse(lift_env, path):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    r = client.post(path, params={**WINDOW, "dataset_id": did},
                    json={"dataset_ids": [did], "gene_ids": ["g"], "filters": {}})
    assert r.status_code == 409 and r.json()["notice"]
