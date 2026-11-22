"""Re-clustering a session for scripted figures: deterministic, balanced, stored in the session, drawn as stored."""
from __future__ import annotations

import copy

import pytest

import headless_figure_data as hfd
from test_headless_figure_options import by_dataset, paths, render, state  # noqa: F401  (fixtures)


def recluster(state, session, **fields):
    from models.requests import RenderClusterRequest
    from services.figure.recluster import recluster_request
    return recluster_request(RenderClusterRequest(session=copy.deepcopy(session), **fields), state, None)


def _assignments(reply):
    return {r["state_key"]: r["assignments"] for r in reply["results"]}


def test_same_seed_same_assignments(state, paths):
    first = recluster(state, hfd.session(paths), method="kmeans", k=3, seed="fig-seed")
    again = recluster(state, hfd.session(paths), method="kmeans", k=3, seed="fig-seed")
    assert _assignments(first) == _assignments(again)
    assert first["session"]["frontend"]["clusterAssignments"] == again["session"]["frontend"]["clusterAssignments"]
    for r in first["results"]:
        assert set(r["cluster_counts"]) <= {"0", "1", "2"} and r["clustered_read_count"] > 0
    # Canonical labels: 0 is the largest cluster over all panels.
    totals = {}
    for r in first["results"]:
        for c, n in r["cluster_counts"].items():
            totals[c] = totals.get(c, 0) + n
    assert totals["0"] == max(totals.values())


def test_balanced_fit_over_panels(state, paths):
    reply = recluster(state, hfd.session(paths), method="kmeans", k=2, seed="s")
    record = reply["cluster"]
    covering = [r["covering_read_count"] for r in reply["results"]]
    assert record["balanced"] is True and record["balanced_fit_reads"] == min(covering)
    assert reply["session"]["headless_cluster"]["seed"] == "s"


def test_features_from_a_bed_interval_separate_open_and_closed_reads(state, paths):
    reply = recluster(state, hfd.session(paths), method="kmeans", k=2, seed="s", features=[list(hfd.OPEN_LOCUS)])
    for r in reply["results"]:
        seed = dict((d[0], d[3]) for d in hfd.DATASETS)[r["dataset_id"]]
        names = hfd.read_names(seed)
        closed = {names[k] for k in range(60) if hfd.OPEN_WIDTHS[k % len(hfd.OPEN_WIDTHS)] == 0}
        groups = {}
        for rid, c in r["assignments"].items():
            groups.setdefault(c, set()).add(rid)
        assert sorted(map(len, groups.values())) == sorted([len(closed), len(r["assignments"]) - len(closed)])
        assert closed in groups.values()


def test_the_figure_draws_the_new_clusters(state, paths):
    session = hfd.session(paths)
    session["frontend"]["readSortOrder"] = {"ds-a": ["stale-read"]}
    session["frontend"]["clusterTreeNodes"] = {"n1": {"parentId": "root"}}
    session["frontend"]["activeClusterTreeNodeId"] = "n1"
    reply = recluster(state, session, method="kmeans", k=3, seed="s")
    fe = reply["session"]["frontend"]
    assert "ds-a" not in fe["readSortOrder"] and fe["clusterTreeNodes"] == {} and fe["activeClusterTreeNodeId"] is None
    _pdf, manifest = render(state, reply["session"])
    for r in reply["results"]:
        panel = by_dataset(manifest)[r["dataset_id"]]
        assert panel["reads_drawn"] == r["clustered_read_count"]
        assert "unclustered" not in panel["clusters"]
        assert {k: v for k, v in panel["clusters"].items()} == r["cluster_counts"]


def test_tsv_files(tmp_path, state, paths):
    from browser_client import BrowserClient
    reply = recluster(state, hfd.session(paths), method="kmeans", k=2, seed="s")
    a, c = BrowserClient.write_cluster_tsv(reply["results"], str(tmp_path / "clusters.tsv"))
    rows = (tmp_path / "clusters.tsv").read_text().splitlines()
    assert rows[0] == "panel\tdataset_id\tdataset_label\tread_id\tcluster"
    assert len(rows) - 1 == sum(r["clustered_read_count"] for r in reply["results"])
    counts = (tmp_path / "clusters.counts.tsv").read_text().splitlines()
    assert counts[0].startswith("panel\tdataset_id") and len(counts) > 2


def test_bad_inputs(state, paths):
    with pytest.raises(ValueError, match="outside"):
        recluster(state, hfd.session(paths), features=[[100, 200]])
    with pytest.raises(ValueError):
        recluster(state, hfd.session(paths), method="nope")


def test_a_panel_with_no_read_covering_the_features_draws_none(state, paths, monkeypatch):
    """Release audit 3.1.1: with no read covering every feature, the panel was stored with no assignments and no
    filter, so the figure drew its unclustered reads; it draws none now (an empty read filter)."""
    import services.correspondence_clustering as cc
    monkeypatch.setattr(cc, "run", lambda state, req: {"results": {}, "matched": {}})
    reply = recluster(state, hfd.session(paths), method="kmeans", k=2, seed="s")
    for r in reply["results"]:
        assert r["clustered_read_count"] == 0
        assert reply["session"]["frontend"]["filteredReadIds"][r["state_key"]] == []
    _pdf, manifest = render(state, reply["session"])
    for r in reply["results"]:
        assert by_dataset(manifest)[r["dataset_id"]]["reads_drawn"] == 0


def test_a_region_reclustering_saves_its_viewport(state, paths):
    """Release audit 3.1.1: recluster_session(region=...) clustered the region but left the session at its old view."""
    session = hfd.session(paths)
    vp = session.get("viewport") or {"chrom": session["frontend"]["chrom"], "start": session["frontend"]["start"], "end": session["frontend"]["end"]}
    region = f"{vp['chrom']}:{vp['start'] + 100}-{vp['end'] - 100}"
    reply = recluster(state, session, method="kmeans", k=2, seed="s", region=region)
    got = reply["session"]["viewport"]
    assert (got["chrom"], got["start"], got["end"]) == (vp["chrom"], vp["start"] + 100, vp["end"] - 100)
    assert reply["session"]["frontend"]["start"] == vp["start"] + 100


def test_every_reclustered_panel_is_limited_to_its_clustered_reads(state, paths):
    """Release audit 3.1.1: only empty panels had an explicit read filter; a large cohort (over the request filter's
    size) drew unassigned reads too. Every panel's filter is its assignments now."""
    reply = recluster(state, hfd.session(paths), method="kmeans", k=2, seed="s")
    fe = reply["session"]["frontend"]
    for r in reply["results"]:
        assert fe["filteredReadIds"][r["state_key"]] == sorted(r["assignments"])


def test_a_region_reclustering_keeps_saved_peaks_on_their_chromosome(state, paths):
    session = hfd.session(paths)
    fe0 = session["frontend"]
    vp = session.get("viewport") or {"chrom": fe0["chrom"], "start": fe0["start"], "end": fe0["end"]}
    fe0["peaksByRule"] = {"r1": [{"start": vp["start"] + 10, "end": vp["start"] + 20}]}
    reply = recluster(state, session, method="kmeans", k=2, seed="s", region=f"{vp['chrom']}:{vp['start'] + 100}-{vp['end'] - 100}")
    assert reply["session"]["frontend"]["peaksByRule"]["r1"][0]["chrom"] == vp["chrom"]
