"""Live-lift datasets through the HTTP display paths (DESIGN_LIVE_LIFT.md P2a):
flag, adding and validating, compact reads (cold, warm broad cache, direct),
haplotype panels, coverage with correspondence, capability refusals, settings
and sessions."""
import array

import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll


def _u32(values):
    return array.array("I", values)


def _records(h):
    return [
        make_record(h, "plus", MAT, 2500, "3300M", tags=[("ns", _u32([400, 2450, 3000])),
                                                         ("nl", _u32([200, 200, 200])), ("st", "CT")]),
        make_record(h, "minus", MAT, 7200, "250M", tags=[("ns", _u32([10])), ("nl", _u32([120])), ("st", "GA")]),
        make_record(h, "pat", PAT, 500, "1000M", tags=[("ns", _u32([100, 700])), ("nl", _u32([200, 200]))]),
        # A MAT supplementary of a PAT molecule.
        make_record(h, "split", MAT, 2000, "20S100M", flag=2048, tags=[("ns", _u32([30])), ("nl", _u32([50])),
                                                                     ("SA", f"{PAT},2001,+,100M20S,60,0;")]),
        make_record(h, "split", PAT, 2000, "100M20S", tags=[("ns", _u32([30])), ("nl", _u32([50]))]),
    ]


@pytest.fixture
def lift_env(tmp_path, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient

    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    client = TestClient(srv.app, headers=auth_headers())
    manifest = write_toy_sidecar(tmp_path / "map")
    bam = write_bam(tmp_path / "src.bam", _records)
    try:
        yield client, srv.state, manifest, bam
    finally:
        srv.state = old
        init_context(old)


def _add(client, manifest, bam, **extra):
    body = {"paths": [bam], "manifest": manifest, **extra}
    return client.post("/api/lift/datasets", json=body).json()


def _compact(client, did, start=1000, end=9000, **params):
    q = dict(chrom=TARGET, start=start, end=end, dataset_id=did, max_reads=5000, include_layers="true",
             full_working_set="true")
    q.update(params)
    r = client.get("/api/reads/compact", params=q)
    assert r.status_code == 200, r.text
    return r.json()


def test_flag_off_hides_every_route(lift_env, monkeypatch):
    client, _state, manifest, bam = lift_env
    monkeypatch.delenv("FIBERBROWSER_LIVE_LIFT")
    assert client.post("/api/lift/datasets", json={"paths": [bam], "manifest": manifest}).status_code == 404
    assert client.get("/api/lift/inspect", params={"manifest": manifest}).status_code == 404
    assert client.get("/api/lift/enabled").json() == {"enabled": False}


def test_add_inspect_and_dataset_payload(lift_env):
    client, state, manifest, bam = lift_env
    info = client.get("/api/lift/inspect", params={"manifest": manifest}).json()
    assert [h["label"] for h in info["haplotypes"]] == ["MAT", "PAT"]
    out = _add(client, manifest, bam)
    assert out["success"], out
    ds = out["dataset"]
    assert ds["data_type"] == "bam_livelift"
    assert ds["live_lift"]["haplotype_labels"] == {"H#1": "MAT", "H#2": "PAT"}
    # The empty state's chromosomes come from the map's targets, never the source header.
    assert [c["name"] for c in client.get("/api/chroms").json()["chroms"]] == [TARGET]
    listed = client.get("/api/datasets").json()["datasets"]
    assert listed[0]["live_lift"]["key"] == ds["live_lift"]["key"]
    assert client.get("/api/lift/enabled").json() == {"enabled": True}


def test_validation_refuses_a_wrong_bam(lift_env, tmp_path):
    client, _state, manifest, _bam = lift_env
    other = write_bam(tmp_path / "other.bam", lambda h: [make_record(h, "x", "chrZ", 10, "50M")],
                      contigs=(("chrZ", 1000),))
    out = _add(client, manifest, other)
    assert not out["success"] and "none of its" in out["error"]


def test_compact_reads_cold_warm_and_direct(lift_env):
    client, _state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    cold = _compact(client, did)
    reads = {r["id"]: r for r in cold["reads"]}
    assert {"plus", "split"} <= set(reads) and "minus" not in reads   # 'minus' lies at chrT:13,550 (out of view)
    plus = reads["plus"]
    assert plus["live_lift"]["segments"] == [[2500, 5710, 0, "+", True]]
    assert plus["live_lift"]["connectors"] == [[3000, 3010]]
    assert "sv_summary" not in cold or not cold["sv_summary"]
    # A narrower view served from the broad cache equals a fresh load of it.
    warm = _compact(client, did, start=3000, end=6000, strand="")
    fresh_state_rows = {r["id"]: r for r in warm["reads"]}
    from services.lift.reads import lifted_reads_for_region
    import server as srv
    direct = {r["id"]: r for r in lifted_reads_for_region(srv.state.datasets[did], TARGET, 3000, 6000,
                                                          {"include_layers": True})}
    for rid in ("plus",):
        assert fresh_state_rows[rid]["live_lift"]["segments"] == direct[rid]["live_lift"]["segments"]
        assert fresh_state_rows[rid]["live_lift"]["calls"]["intervals"] == direct[rid]["live_lift"]["calls"]["intervals"]
        assert fresh_state_rows[rid]["intervals"] == direct[rid]["intervals"]
    # The direct path (terminal gaps shown) lifts too.
    shown = _compact(client, did, hide_terminal_gaps="false")
    assert any(r.get("live_lift") for r in shown["reads"])


def test_haplotype_panels_filter_by_rule(lift_env):
    client, _state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    mat = _compact(client, did, start=1000, end=19_000, lift_hap="MAT")
    pat = _compact(client, did, start=1000, end=19_000, lift_hap="PAT")
    assert {r["live_lift"]["hap_label"] for r in mat["reads"]} == {"MAT"}
    assert {r["live_lift"]["hap_label"] for r in pat["reads"]} == {"PAT"}
    # The MAT supplementary of a PAT molecule is a PAT row (its primary's haplotype).
    assert "split" in {r["id"] for r in pat["reads"]} and "split" not in {r["id"] for r in mat["reads"]}


def test_coverage_counts_rows_and_reports_correspondence(lift_env):
    client, _state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    cov = client.get("/api/coverage", params=dict(chrom=TARGET, start=0, end=20_000, bins=20,
                                                  dataset_id=did)).json()
    lift = cov["live_lift"]
    assert set(lift["haplotypes"]) == {"MAT", "PAT"}
    corr = lift["pooled"]["correspondence"]
    assert all(0 <= c <= 1 for c in corr)
    assert corr[0] == 0 and lift["pooled"]["depth"][0] is None      # no correspondence: hatched
    assert corr[2] == 1.0                                          # [2000, 3000): chain 0 covers it
    assert cov["coverage"][3] >= 1
    mat = client.get("/api/coverage", params=dict(chrom=TARGET, start=0, end=20_000, bins=20, dataset_id=did,
                                                  lift_hap="MAT")).json()
    assert set(mat["live_lift"]["haplotypes"]) == {"MAT"}


def test_unsupported_analysis_is_refused(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    from services.lift.capability import LiveLiftUnsupported
    with pytest.raises(LiveLiftUnsupported):
        state.datasets[did].get_reads(TARGET, 0, 1000)
    # An analysis naming the dataset: 409 with the notice (default-deny in AnalysisReadQuery).
    r = client.get("/api/coacc/metadata", params=dict(chrom=TARGET, start=1000, end=9000, dataset_ids=did))
    assert r.status_code == 409 and "live-lift" in r.json()["notice"]
    from services.analysis_query import AnalysisReadQuery
    with pytest.raises(LiveLiftUnsupported):
        AnalysisReadQuery.from_request(state, chrom=TARGET, start=0, end=100, dataset_id=did)
    # Over "every dataset" the lifted one is left out, not refused.
    query = AnalysisReadQuery.from_request(state, chrom=TARGET, start=0, end=100)
    assert did not in query.dataset_ids
    # Display paths are allowed.
    assert AnalysisReadQuery.from_request(state, chrom=TARGET, start=0, end=100, dataset_id=did,
                                          capability="compact_reads").dataset_ids == [did]


def test_settings_change_the_key_and_the_rows(lift_env):
    client, _state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    key0 = client.get("/api/datasets").json()["datasets"][0]["live_lift"]["key"]
    out = client.post(f"/api/lift/datasets/{did}/settings", json={"settings": {"rejoin_bp": 0}}).json()
    assert out["success"] and out["dataset"]["live_lift"]["key"] != key0
    bad = client.post(f"/api/lift/datasets/{did}/settings", json={"settings": {"g_split": 5}}).json()
    assert not bad["success"]


def test_session_round_trip_and_flag_off_notice(lift_env, monkeypatch):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam, settings={"g_split": 20_000}, haplotypes=["MAT"])["dataset"]["id"]
    from models.requests import SessionExportRequest
    from services.sessions_endpoint import build_session_export_for_request
    exported = build_session_export_for_request(state, SessionExportRequest(chrom=TARGET, start=0, end=20_000))["session"]
    entry = next(d for d in exported["datasets"] if d["id"] == did)
    assert entry["live_lift"]["settings"]["g_split"] == 20_000 and entry["live_lift"]["haplotypes"] == ["H#1"]
    from services.lift.registration import restore_from_session
    state.remove_dataset(did)
    restored = restore_from_session(state, entry)
    ds = state.datasets[restored["dataset"]["id"]]
    assert ds.data_type == "bam_livelift" and ds.live_lift.settings.g_split == 20_000
    monkeypatch.delenv("FIBERBROWSER_LIVE_LIFT")
    with pytest.raises(Exception, match="FIBERBROWSER_LIVE_LIFT=1"):
        restore_from_session(state, entry)


def test_locate_projects_hits_onto_the_main_genome(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    from services.read_locate import locate_reads
    out = locate_reads(state, ["plus", "minus"], scope="chrom", chrom=TARGET, dataset_ids=[did])
    hits = {h["name"]: h for h in out["found"]}
    assert hits["plus"]["chrom"] == TARGET and hits["plus"]["source_contig"] == MAT
    assert (hits["plus"]["start"], hits["plus"]["end"]) == (3500, 6710)
    assert (hits["minus"]["start"], hits["minus"]["end"]) == (13550, 13800)


def test_display_settings_hide_supplementary_rows(lift_env):
    client, _state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    shown = _compact(client, did)
    assert any(r["live_lift"]["source"]["supplementary"] for r in shown["reads"])
    client.post(f"/api/lift/datasets/{did}/settings", json={"settings": {"supplementary_display": "hide"}})
    hidden = _compact(client, did)
    assert hidden["reads"] and not any(r["live_lift"]["source"]["supplementary"] for r in hidden["reads"])


def test_binary_transport_keeps_live_lift_and_reuse_is_off(lift_env):
    client, _state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    from services.read_binary import MEDIA_TYPE
    from test_read_binary import decode
    params = dict(chrom=TARGET, start=1000, end=9000, dataset_id=did, max_reads=5000, include_layers="true",
                  full_working_set="true", hide_terminal_gaps="false", terminal_gap_threshold=0)
    r = client.get("/api/reads/compact", params=params, headers={"accept": MEDIA_TYPE})
    assert r.headers["content-type"].startswith(MEDIA_TYPE)
    data = decode(r.content)
    reads = {x["id"]: x for x in data["reads"]}
    assert reads["plus"]["live_lift"]["segments"] == [[2500, 5710, 0, "+", True]]
    assert reads["plus"]["live_lift"]["connectors"] == [[3000, 3010]]
    assert data.get("_region_reuse_safe") is False
