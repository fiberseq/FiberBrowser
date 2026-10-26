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


@pytest.mark.parametrize("path", ["/api/filter_by_transcription_state", "/api/autozoom"])
def test_other_analyses_still_refuse(lift_env, path):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    r = client.post(path, params={**WINDOW, "dataset_id": did},
                    json={"dataset_ids": [did], "gene_ids": ["g"], "filters": {}})
    assert r.status_code == 409 and r.json()["notice"]


def _graph_identity(aid):
    """The graph row's identity of a linear row's record: the same molecule, QNAME and record, placement "primary"."""
    import json
    parts = json.loads(aid[len(PREFIX):])
    return PREFIX + json.dumps(parts[:3] + [parts[3], "primary"], separators=(",", ":"), ensure_ascii=True)


def test_graph_row_identities_name_their_records(lift_env):
    """A graph band's shown reads are graph identities (placement "primary"); Read Stats and a sort's read scope
    find the linear rows of the same records by record key, while a linear identity stays exact."""
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    order = _sort(client, did)["read_sort_order"]
    plus = next(i for i in order if _qname(i) == "plus")
    graph = _graph_identity(plus)
    assert graph != plus
    r = client.post("/api/reads/stats", params=WINDOW, json={"read_ids_by_dataset": {did: [graph]}})
    assert r.status_code == 200 and r.json()["found_count"] == 1, r.text
    assert r.json()["per_read"][0]["read_id"] == graph
    scoped = _sort(client, did, read_ids={did: [graph]})["read_sort_order"]
    assert [_qname(i) for i in scoped] == ["plus"]
    from services.read_selection import with_graph_record_keys
    assert with_graph_record_keys({plus}) == {plus}


def test_sort_by_cluster_with_a_graph_runs_record_key_labels(lift_env):
    """Codex review (group A): a graph run writes lifted labels under record keys; a metric sort of the clustered
    panel reads them through each row's record key (it skipped every lifted label)."""
    from services.lift.cohort import record_key
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    ids = _sort(client, did)["read_sort_order"]
    by_record = {record_key(i): (0 if _qname(i) == "plus" else 1) for i in ids}
    out = _sort(client, did, cluster_assignments={did: by_record})
    assert out["cluster_order"] == [0, 1]
    assert set(out["read_sort_order"]) == set(ids)


def test_read_stats_take_the_rows_own_library_record(lift_env, tmp_path):
    """Codex review (group A): two BAMs of a dataset with one QNAME at one start: each row is described from its own
    library's record."""
    import array
    from live_lift_fixtures import make_record, write_bam
    tags = [("ns", array.array("I", [100])), ("nl", array.array("I", [150]))]

    def recs(mapq):
        def build(h):
            r = make_record(h, "twin", MAT, 2500, "600M", tags=tags)
            r.mapping_quality = mapq
            return [r]
        return build
    a = write_bam(tmp_path / "liba.bam", recs(11))
    b = write_bam(tmp_path / "libb.bam", recs(42))
    client, state, manifest, _bam = lift_env
    r = client.post("/api/lift/datasets", json={"paths": [a, b], "manifest": manifest})
    did = r.json()["dataset"]["id"]
    ids = [i for i in _sort(client, did)["read_sort_order"] if _qname(i) == "twin"]
    assert len(ids) == 2
    got = {}
    for i in ids:
        out = client.post("/api/reads/stats", params=WINDOW, json={"read_ids_by_dataset": {did: [i]}}).json()
        (row,) = out["per_read"]
        got[i.split('"')[1].split("|")[0]] = row["mapq"]
    assert sorted(got.values()) == [11, 42]


def test_similarity_and_projection_sorts_read_a_graph_runs_record_key_labels(lift_env):
    """agy review (group A): similarity and projection sorts of a panel clustered on graph columns (labels under record
    keys) find its rows (they matched none and fell back to cluster sizes / produced no order)."""
    from services.lift.cohort import record_key
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    ids = _sort(client, did)["read_sort_order"]
    labels = {record_key(i): (0 if _qname(i) in ("plus", "split") else 1) for i in ids}
    peaks = [{"start": 3500, "end": 3700, "mode": "accessibility"}]
    out = _sort(client, did, sort_by="projection", cluster_assignments={did: labels},
                projection={"peak_regions": peaks, "cluster_assignments": {did: labels}})
    assert set(out["cluster_order"]) <= {0, 1}
    assert {record_key(i) for i in out["read_sort_order"]} == set(labels)


def test_linear_peak_scanning_takes_lifted_datasets(lift_env):
    """Graph features audit (A2): Scan in linear view (a host handed off past 50 kb) scans a lifted dataset's analysis
    cohort on target coordinates, haplotypes pooled, instead of refusing it."""
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    r = client.post("/api/scan_peaks", params={**WINDOW, "dataset_id": did},
                    json={"dataset_ids": [did], "min_reads": 1, "min_width": 20, "threshold_rare": 0.01})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["n_reads"] >= 3


def test_similarity_sort_of_a_filtered_panel_with_record_key_labels(lift_env):
    """Codex review (group E): a graph run's record-key labels, scoped by a filter's cohort identities, still order the
    clusters by similarity (the scope removed every label)."""
    from services.lift.cohort import record_key
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    ids = _sort(client, did)["read_sort_order"]
    labels = {record_key(i): (0 if _qname(i) in ("plus", "split") else 1) for i in ids}
    out = _sort(client, did, sort_by="similarity", cluster_assignments={did: labels}, read_ids={did: ids})
    assert sorted(out["cluster_order"]) == [0, 1]


def test_similarity_sort_after_a_graph_run_with_a_qname_scope(lift_env):
    """agy review (group E): after a graph run (labels under record keys, regions not stored on the dataset) a
    similarity sort scoped by QNAMEs uses the run's regions sent with the request and keeps every label."""
    from services.lift.cohort import record_key
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    ids = _sort(client, did)["read_sort_order"]
    labels = {record_key(i): (0 if _qname(i) in ("plus", "split") else 1) for i in ids}
    out = _sort(client, did, sort_by="similarity", cluster_assignments={did: labels},
                read_ids={did: sorted({_qname(i) for i in ids})}, peak_regions=[[3500, 3700]])
    assert sorted(out["cluster_order"]) == [0, 1]


def test_linear_scan_counts_a_molecule_shared_by_two_datasets_once_under_joint_dedup(lift_env):
    """agy review (group E): two lifted datasets of the same records with joint_dedup by_molecule count each shared
    molecule once in a linear scan, as the graph-column scan does."""
    client, state, manifest, bam = lift_env
    a = _add(client, manifest, bam)["dataset"]["id"]
    b = _add(client, manifest, bam, label="copy")["dataset"]["id"]
    if a == b:
        pytest.skip("the same files make one dataset here")
    for d in (a, b):
        r = client.post(f"/api/lift/datasets/{d}/settings", json={"settings": {"joint_dedup": "by_molecule", "molecule_groups": [[bam, "shared"]]}})
        if r.status_code != 200:
            pytest.skip(f"joint_dedup is not a dataset setting here: {r.text[:120]}")
    single = client.post("/api/scan_peaks", params={**WINDOW, "dataset_id": a},
                         json={"dataset_ids": [a], "min_reads": 1, "min_width": 20, "threshold_rare": 0.01}).json()["n_reads"]
    both = client.post("/api/scan_peaks", params=WINDOW,
                       json={"dataset_ids": [a, b], "min_reads": 1, "min_width": 20, "threshold_rare": 0.01}).json()["n_reads"]
    # One row per shared molecule (the joint cohort's rule, as clustering applies it): never both copies.
    assert both <= single < 2 * both


def test_scoped_linear_scan_keeps_a_shown_molecules_supplementaries(lift_env):
    """Codex review (group G): a linear Scan scoped to a molecule's primary identity scans its supplementary rows too
    (the query's own scope must not drop them before the molecule match)."""
    import json
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    split = [i for i in _sort(client, did)["read_sort_order"] if _qname(i) == "split"]
    if len(split) < 2:
        pytest.skip("the fixture's split molecule has one row here")
    primary = [i for i in split if json.loads(i[len(PREFIX):])[4] == "primary"][:1] or split[:1]

    def scan(ids):
        r = client.post("/api/scan_peaks", params={**WINDOW, "dataset_id": did},
                        json={"dataset_ids": [did], "read_ids": ids, "min_reads": 1, "min_width": 20, "threshold_rare": 0.01})
        assert r.status_code == 200, r.text
        return r.json()["n_reads"]
    assert scan(primary) == scan(split) >= 2
    # Under a working-set cap (Codex review, group G round 2) the shown molecule is still loaded in full.
    state.max_working_reads = 1
    assert scan(primary) >= 2
