"""Actual BAM/map/HTTP consumer gates for authoritative differences evidence."""
from dataclasses import replace
from types import SimpleNamespace

import pytest

from live_lift_fixtures import MAT, TARGET, make_record, write_bam
from test_live_lift_differences import evidence  # noqa: F401
from test_live_lift_endpoints import lift_env, _add, _compact  # noqa: F401
from services.differences.projected_service import projected_analysis
from services.differences.projection import ProjectionPolicy
from services.lift.capability import LiveLiftUnsupported


def insertion():
    return dict(target_id="frozen-insertion", target_type="geometry", chrom=TARGET,
                ref_start=6010, ref_end=6010, alt_bp=100)


def test_composed_summary_split_count_and_cold_warm_direct_parity(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, _ = evidence
    kwargs = dict(chrom=TARGET, start=5900, end=6500)
    summary = projected_analysis(state, ds, feature="summary", **kwargs)
    entry = next(e for e in summary["targets"] if e["target"]["ref_start"] == 6010)
    split = projected_analysis(state, ds, feature="split", target=entry["target"], **kwargs)
    assert entry["counts"] == split["targets"][0]["counts"] == [3, 0, 1]
    for direct in (False, True):
        again = projected_analysis(state, ds, feature="split", target=entry["target"], use_cache=not direct, **kwargs)
        assert again == split
    assert all(c["call"]["assignment"] == "unknown" for c in split["targets"][0]["calls_by_molecule"].values() if c["call"]["level"] is None)
    assert split["scope"]["sequence_enriched"] is False


def test_exact_split_is_lazy_preserves_geometry_and_never_uses_expected_map_sequence(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, _ = evidence
    t = {**insertion(), "target_type": "exact", "candidates": {"frozen-insertion": "A"*100, "reference": ""}, "competition_complete": True}
    kwargs = dict(chrom=TARGET, start=5900, end=6500, feature="split", target=t)
    unknown = projected_analysis(state, ds, contexts={n: {"chemistry": "unknown", "provenance": "unavailable"} for n in ("hg", "ref", "private")}, **kwargs)
    assert unknown["targets"][0]["counts"] == [0, 0, 4]
    assert unknown["targets"][0]["geometry_counts"] == [3, 0, 1]
    known = projected_analysis(state, ds, contexts={n: {"chemistry": "none", "provenance": "synthetic"} for n in ("hg", "ref", "private")}, **kwargs)
    assert known["targets"][0]["counts"] == [3, 0, 1]
    for c in known["targets"][0]["calls_by_molecule"].values():
        for h in c["lifted"]["diagnostics"]:
            for d in h["records"]:
                assert d["read_bases"] is None or len(d["read_bases"]) <= 60
                for e in d["projection"]["edits"]:
                    assert "observed" not in e
                    assert e["read_bases"] is None or len(e["read_bases"]) <= 60


def test_independent_libraries_and_record_cap_never_fabricate_empty_reference(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    duplicate_library = directory / "other.bam"
    from shutil import copyfile
    copyfile(ds.paths[0], duplicate_library)
    copyfile(ds.paths[0]+".bai", str(duplicate_library)+".bai")
    ds.paths = [*ds.paths, str(duplicate_library)]
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500, target=insertion())
    assert result["targets"][0]["counts"] == [6, 0, 2]
    assert not result["membership"]["legacy_aliases"][ds.id]
    capped = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500,
        target=insertion(), policy=ProjectionPolicy(max_records=1))
    assert capped["scope"]["search_complete"] is False
    assert "projection_records_cap" in capped["scope"]["reasons"]
    assert capped["targets"][0]["counts"] == [1, 0, 0]
    refused = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500,
        target=insertion(), policy=ProjectionPolicy(max_response_bytes=1))
    assert refused["status"] == "budget_exceeded" and refused["targets"] == []


def test_combined_requires_provenance_and_reconciles_before_counting(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    native_path = write_bam(directory / "native.bam", lambda h: [make_record(h, "hg", TARGET, 5900, "500M")], contigs=((TARGET, 20_000),))
    native = SimpleNamespace(id="native", data_type="bam", paths=[native_path], molecule_groups=[])
    state.datasets["native"] = native
    state.get_dataset = state.datasets.get
    state.dataset_order = ["native", "lift"]
    kwargs = dict(feature="split", chrom=TARGET, start=5900, end=6500, target=insertion(),
                  analysis_scope="combined", native_dataset_id="native")
    separate = projected_analysis(state, ds, **kwargs)
    assert separate["targets"][0]["counts"] == [3, 1, 1]
    ds.live_lift.settings = replace(ds.live_lift.settings, molecule_groups=((ds.paths[0], "shared"),))
    native.molecule_groups = [(native_path, "shared")]
    combined = projected_analysis(state, ds, **kwargs)
    assert combined["targets"][0]["counts"] == [2, 0, 2]
    hg = combined["membership"]["legacy_aliases"][ds.id]["hg"]
    call = combined["targets"][0]["calls_by_molecule"][hg]
    assert call["call"]["assignment"] == "ambiguous"
    assert "cross_representation_disagreement" in call["call"]["reasons"]
    assert combined["targets"][0]["row_assignments"]["native"]["hg"]["assignment"] == "ambiguous"
    assert combined["targets"][0]["row_assignments"][ds.id]["hg"]["assignment"] == "ambiguous"


def test_http_summary_split_highlight_membership_and_legacy_gates(lift_env):
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)["dataset"]["id"]
    body = dict(dataset_id=did, chrom=TARGET, start=5900, end=6500)
    summary = client.post("/api/lift/analysis/summary", json=body)
    assert summary.status_code == 200, summary.text
    summary = summary.json()
    t = next(o["target"] for o in summary["targets"] if o["target"]["ref_start"] == 6010)
    split = client.post("/api/lift/analysis/split", json={**body, "target": t})
    assert split.status_code == 200, split.text
    split = split.json()
    assert split["targets"][0]["counts"] == [1, 0, 0]
    rows = _compact(client, did, start=5900, end=6500)["reads"]
    membership = split["membership"]["rows"][did]
    assert rows and all(r["analysis_id"] in membership for r in rows)
    assert all(split["targets"][0]["row_assignments"][did][r["analysis_id"]]["assignment"] == "target" for r in rows)
    # JSON/FBR1/packed/crop are display paths and must keep stripping source
    # authoritative fields. Their independent v2 calls use the same membership.
    assert all(not any(r.get(k) for k in ("aligned_blocks", "sv_segments", "sv_alignments", "sequence_span")) for r in rows)
    # The legacy HTTP finalizer may mirror glyphs into sv_evidence. Those
    # entries are explicitly display-only and never enter this producer.
    assert all(e.get("display_only") for r in rows for e in r.get("sv_evidence", []))
    assert client.post("/api/sv/split", json={**body, "t": "I", "ref": 6010, "len": 100}).status_code == 409
    assert client.post("/api/variants/svs", json=body).status_code == 409
    assert client.get("/api/insertions/lens", params={**body, "pos": 6010}).status_code == 409
    assert client.post("/api/lift/analysis/split", json={**body, "target": {**t, "alt_bp": -1}}).status_code == 422
    assert client.post("/api/lift/analysis/split", json={**body, "target": t, "projection_policy": {"search": {"max_hypotheses": 0}}}).status_code == 422
    state.datasets[did].data_type = "bam"
    assert client.post("/api/lift/analysis/split", json={**body, "target": t}).status_code == 409


def test_projection_feature_flags_are_independent(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    from services.lift import capability
    state, ds, _ = evidence
    monkeypatch.setattr(capability, "SUPPORTED", capability.SUPPORTED - {"difference_split"})
    with pytest.raises(LiveLiftUnsupported):
        projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500, target=insertion())
    assert projected_analysis(state, ds, feature="summary", chrom=TARGET, start=5900, end=6500)["targets"]


def test_reciprocal_off_window_primary_is_fetched_and_source_witnesses_resolve(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    bam = write_bam(directory / "reciprocal.bam", lambda h: [
        make_record(h, "joint", MAT, 2000, "500M600S", tags=[("st", "GA"), ("SA", f"{MAT},4901,+,500S600M,60,0;")]),
        make_record(h, "joint", MAT, 4900, "500S600M", flag=2048, tags=[("st", "CT"), ("SA", f"{MAT},2001,+,500M600S,60,0;")]),
    ])
    ds.paths = [bam]
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500, target=insertion())
    assert result["scope"]["records"] == 2
    assert result["targets"][0]["counts"] == [1, 0, 0]
    only, = result["targets"][0]["calls_by_molecule"].values()
    assert only["lifted"]["unprojectable_witnesses"] == []
    assert len(only["lifted"]["hypotheses"][0]["record_scope"]) == 2


def test_map_observation_ids_survive_byte_identical_relocation_and_touch(evidence, monkeypatch):
    import os
    from shutil import copytree
    from services.differences.projected_service import map_paths
    from services.lift.dataset import LiveLiftConfig
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    _, ds, directory = evidence
    first, _, _ = map_paths(ds.live_lift, TARGET, 5900, 6500, policy=ProjectionPolicy())
    copytree(directory / "map", directory / "relocated")
    for p in (directory / "relocated").iterdir():
        os.utime(p, (1, 1))
    moved = LiveLiftConfig(str(directory / "relocated" / "toy.graphlift.json"), [])
    second, _, _ = map_paths(moved, TARGET, 5900, 6500, policy=ProjectionPolicy())
    assert ds.live_lift.handle.fingerprint != moved.handle.fingerprint
    assert [p.path_id for p in first] == [p.path_id for p in second]
    assert [[g.observation_id for g in p.gaps] for p in first] == [[g.observation_id for g in p.gaps] for p in second]


def test_partial_molecule_cap_blocks_confirmation_but_completed_molecules_survive(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "same-molecule.bam", lambda h: [
        make_record(h, "m", MAT, 4800, "600M"), make_record(h, "m", MAT, 4800, "600M", flag=2048)])]
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500,
        target=insertion(), policy=ProjectionPolicy(max_records=1))
    assert result["targets"][0]["counts"] == [0, 0, 1]
    assert result["targets"][0]["geometry_counts"] == [0, 0, 1]
    only, = result["targets"][0]["calls_by_molecule"].values()
    assert "incomplete_representation_scope" in only["call"]["reasons"]


def test_projection_preflight_and_running_cancellation_release_shared_reservation(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    from services.background_work import Cancelled
    from services.reconstruction_budget import RESERVATIONS, ResourceResult
    from services.differences import projected_service
    state, ds, _ = evidence
    before = RESERVATIONS.bytes, RESERVATIONS.large, RESERVATIONS.queued
    with pytest.raises(ResourceResult, match="projection_request_bytes"):
        projected_analysis(state, ds, feature="summary", chrom=TARGET, start=5900, end=6500,
                           policy=ProjectionPolicy(max_runs=1_000_000))
    def cancelled(*a, **k):
        assert RESERVATIONS.bytes > before[0]
        raise Cancelled()
        yield  # iterator protocol
    monkeypatch.setattr(projected_service, "_source_records", cancelled)
    with pytest.raises(Cancelled):
        projected_analysis(state, ds, feature="summary", chrom=TARGET, start=5900, end=6500)
    assert (RESERVATIONS.bytes, RESERVATIONS.large, RESERVATIONS.queued) == before


def test_missing_map_preserves_the_independent_native_call(evidence, monkeypatch):
    from pathlib import Path
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    native_path = write_bam(directory / "native-only.bam", lambda h: [make_record(h, "m", TARGET, 5900, "110M100I390M")], contigs=((TARGET, 20_000),))
    native = SimpleNamespace(id="native", data_type="bam", paths=[native_path], molecule_groups=[])
    state.datasets["native"] = native
    state.get_dataset = state.datasets.get
    Path(ds.live_lift.manifest).unlink()
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500,
        target=insertion(), analysis_scope="combined", native_dataset_id="native")
    assert result["targets"][0]["counts"] == [1, 0, 0]
    assert result["scope"]["reasons"] == ["map_unavailable"]
    only, = result["targets"][0]["calls_by_molecule"].values()
    assert only["call"]["level"] == "confirmed" and only["complete"] is False


def test_off_window_rejected_primary_cannot_be_resurrected_by_supplementary(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "duplicate-primary.bam", lambda h: [
        make_record(h, "joint", MAT, 2000, "500M600S", flag=1024, tags=[("SA", f"{MAT},4901,+,500S600M,60,0;")]),
        make_record(h, "joint", MAT, 4900, "500S600M", flag=2048, tags=[("SA", f"{MAT},2001,+,500M600S,60,0;")])])]
    kwargs = dict(feature="split", chrom=TARGET, start=5900, end=6500, target=insertion())
    assert projected_analysis(state, ds, **kwargs)["targets"][0]["counts"] == [0, 0, 0]
    assert projected_analysis(state, ds, include_duplicates=True, **kwargs)["targets"][0]["counts"] == [1, 0, 0]


def test_sequence_free_scans_do_not_charge_unrequested_full_read_bases(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, _ = evidence
    policy = ProjectionPolicy(max_input_bases=1)
    kwargs = dict(feature="split", chrom=TARGET, start=5900, end=6500, policy=policy)
    geometry = projected_analysis(state, ds, target=insertion(), **kwargs)
    assert geometry["targets"][0]["counts"] == [3, 0, 1]
    exact = {**insertion(), "target_type": "exact", "candidates": {"frozen-insertion": "A"*100, "reference": ""}, "competition_complete": True}
    refused = projected_analysis(state, ds, target=exact, **kwargs)
    assert "projection_bases_cap" in refused["scope"]["reasons"]
    assert refused["scope"]["sequence_enrichment_complete"] is False


def test_chemistry_override_aliases_cannot_cross_independent_libraries(evidence, monkeypatch):
    from shutil import copyfile
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    other = str(directory / "independent.bam")
    copyfile(ds.paths[0], other)
    copyfile(ds.paths[0]+".bai", other+".bai")
    ds.paths = [*ds.paths, other]
    t = {**insertion(), "target_type": "exact", "candidates": {"frozen-insertion": "A"*100, "reference": ""}, "competition_complete": True}
    kwargs = dict(feature="split", chrom=TARGET, start=5900, end=6500, target=t)
    result = projected_analysis(state, ds, contexts={"hg": {"chemistry": "none", "provenance": "explicit"}}, **kwargs)
    assert result["scope"]["ambiguous_context_alias_count"] == 1
    hg = [key for key, m in result["membership"]["molecules"].items() if m["raw_name"] == "hg"]
    assert len(hg) == 2
    assert all(result["targets"][0]["calls_by_molecule"][key]["call"]["level"] == "putative" for key in hg)
    qualified = projected_analysis(state, ds, contexts={hg[0]: {"chemistry": "none", "provenance": "explicit"}}, **kwargs)
    assert qualified["targets"][0]["calls_by_molecule"][hg[0]]["call"]["level"] == "confirmed"
    assert qualified["targets"][0]["calls_by_molecule"][hg[1]]["call"]["level"] == "putative"


def test_raw_source_spool_cap_is_explicit_before_retaining_any_cohort(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, _ = evidence
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500,
        target=insertion(), policy=ProjectionPolicy(max_spool_bytes=1))
    assert result["scope"]["records"] == 0 and result["scope"]["search_complete"] is False
    assert "projection_spool_bytes_cap" in result["scope"]["reasons"]
    assert result["targets"][0]["counts"] == [0, 0, 0]


def test_display_alternatives_and_run_splitting_do_not_change_analysis_cohort(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    import pysam
    with pysam.AlignmentFile(ds.paths[0], "rb") as bam:
        reads = list(bam.fetch())
    ds.paths = [write_bam(directory / "alternatives.bam", lambda h: [*reads, make_record(h, "secondary-only", MAT, 9650, "100M")])]
    kwargs = dict(feature="split", chrom=TARGET, start=1000, end=7000, target=insertion())
    baseline = projected_analysis(state, ds, **kwargs)
    ds.live_lift.settings = replace(ds.live_lift.settings, alternatives=True, g_split=1_000_000, window_merge=0)
    changed = projected_analysis(state, ds, **kwargs)
    assert baseline["targets"][0]["counts"] == changed["targets"][0]["counts"]
    assert baseline["targets"][0]["calls_by_molecule"] == changed["targets"][0]["calls_by_molecule"]
    assert baseline["scope"] == changed["scope"]


def test_supplementary_follow_display_is_an_explicit_cohort_policy(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "supplementary.bam", lambda h: [
        make_record(h, "supplementary", MAT, 4800, "600M", flag=2048)])]
    ds.live_lift.settings = replace(ds.live_lift.settings, supplementary_display="hide", cohort_supplementaries="all_records")
    kwargs = dict(feature="split", chrom=TARGET, start=5900, end=6500, target=insertion())
    assert projected_analysis(state, ds, **kwargs)["targets"][0]["counts"] == [1, 0, 0]
    ds.live_lift.settings = replace(ds.live_lift.settings, cohort_supplementaries="follow_display")
    assert projected_analysis(state, ds, **kwargs)["targets"][0]["counts"] == [0, 0, 0]


def test_discovery_keeps_unassessed_raw_edits_instead_of_complete_empty_results(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "unresolved-edit.bam", lambda h: [
        make_record(h, "large-deletion", MAT, 0, "50M7000D50M")])]
    result = projected_analysis(state, ds, feature="summary", chrom=TARGET, start=2000, end=2100)
    assert result["targets"] == []
    assert result["scope"]["search_complete"] is False
    assert result["scope"]["reasons"] == ["unassessed_projection"]
    assert result["unassessed_projections"]
    assert "raw_edit_missing_projected_flanks" in result["unassessed_projections"][0]["reasons"]


def test_source_witness_count_refuses_before_materializing_large_sa_sets(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "many-source-witnesses.bam", lambda h: [
        make_record(h, "m", MAT, 4800, "600M", tags=[("SA", "elsewhere,1,+,100M,60,0;"*5)])])]
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500,
        target=insertion(), policy=ProjectionPolicy(max_runs=1))
    assert result["scope"]["records"] == 0
    assert "projection_source_witnesses" in result["scope"]["reasons"]


def test_cancelled_map_insertion_is_complete_reference_discovery(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "cancelled-insertion.bam", lambda h: [
        make_record(h, "reference", MAT, 0, "5000M100D1000M")])]
    result = projected_analysis(state, ds, feature="summary", chrom=TARGET, start=5900, end=6500)
    assert result["targets"] == [] and result["unassessed_projections"] == []
    assert result["scope"]["search_complete"] is True


def test_projection_deadline_includes_later_sequence_scoring(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    from services.differences import projected_service
    state, ds, _ = evidence
    original = projected_service.call_molecule
    observed = []
    def checked(*a, **kwargs):
        assert kwargs["likelihood_budget"].deadline <= kwargs["budget"].deadline
        observed.append(True)
        return original(*a, **kwargs)
    monkeypatch.setattr(projected_service, "call_molecule", checked)
    target = {**insertion(), "target_type": "exact", "candidates": {"frozen-insertion": "A"*100, "reference": ""}, "competition_complete": True}
    projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500, target=target)
    assert observed


def test_unresolved_map_gap_on_off_locus_primary_does_not_veto_target(evidence, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    state, ds, directory = evidence
    ds.paths = [write_bam(directory / "off-locus-partial-gap.bam", lambda h: [
        make_record(h, "m", MAT, 2990, "5M20N5M590S", tags=[("SA", f"{MAT},4801,+,100S500M,60,0;")]),
        make_record(h, "m", MAT, 4800, "100S500M", flag=2048, tags=[("SA", f"{MAT},2991,+,5M20N5M590S,60,0;")])])]
    result = projected_analysis(state, ds, feature="split", chrom=TARGET, start=5900, end=6500, target=insertion())
    assert result["scope"]["records"] == 2
    assert result["targets"][0]["counts"] == [1, 0, 0]
    only, = result["targets"][0]["calls_by_molecule"].values()
    assert only["call"]["level"] == "confirmed"
    assert any(r["projection"]["partial_gaps"] for h in only["lifted"]["diagnostics"] for r in h["records"])
