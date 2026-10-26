"""Backfill review fixes: B6 (resolved provenance paths), B7 (portable groups on restore),
B11 (unambiguous molecule keys), F3 (source budget scales with haplotypes)."""
import os
from types import SimpleNamespace

import pytest

from live_lift_fixtures import MAT, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll
from services.lift.joint import group_for, molecule_identity, molecule_key


def test_molecule_keys_never_collide():
    assert molecule_key("a|b", "c") != molecule_key("a", "b|c")
    assert molecule_key("a\\", "|c") != molecule_key("a\\|", "c")
    assert molecule_key("lib", "read1") == "lib|read1"          # ordinary names keep their key


def test_groups_match_symlinked_and_relative_paths(tmp_path, monkeypatch):
    real = tmp_path / "data" / "native.bam"
    real.parent.mkdir()
    real.write_bytes(b"x")
    link = tmp_path / "link.bam"
    link.symlink_to(real)
    assert group_for({str(link): "g"}, None, str(real.resolve())) == "g"
    monkeypatch.chdir(tmp_path)
    assert group_for({"data/native.bam": "g"}, None, str(real.resolve())) == "g"
    ds = SimpleNamespace(molecule_groups=[[str(link), "g"]])
    assert molecule_identity(ds, {"id": "r1", "library_id": str(real.resolve())}) == "g|r1"


def test_relative_registration_and_restore_keep_cohort_groups(tmp_path, monkeypatch):
    import server as srv
    from services.lift.registration import add_live_lift_dataset, restore_from_session, session_entry
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    work = tmp_path / "work"
    work.mkdir()
    manifest = write_toy_sidecar(work / "map")
    bam = write_bam(work / "src.bam", lambda h: [make_record(h, "r", MAT, 2500, "300M")])
    state = srv.BrowserState(None, None, None, None)
    monkeypatch.chdir(work)
    added = add_live_lift_dataset(state, paths=["src.bam"], manifest="map/toy.graphlift.json",
                                  settings={"molecule_groups": [["src.bam", "shared"]]})
    assert added["success"], added
    ds = state.datasets[added["dataset"]["id"]]
    assert dict(ds.live_lift.settings.molecule_groups) == {os.path.abspath(bam): "shared"}
    entry = {**session_entry(ds), "paths": list(ds.paths), "id": "restored", "label": "x"}
    # Relocated session: the BAM moved; its provenance key follows it.
    moved = tmp_path / "moved"
    os.rename(work, moved)
    monkeypatch.chdir(tmp_path)
    ll.clear_selection_cache()
    state2 = srv.BrowserState(None, None, None, None)
    restored = restore_from_session(state2, entry, path_mapping={str(work / 'src.bam'): str(moved / 'src.bam'),
        str(work / 'map' / 'toy.graphlift.json'): str(moved / 'map' / 'toy.graphlift.json')})
    groups = dict(state2.datasets[restored["dataset"]["id"]].live_lift.settings.molecule_groups)
    assert groups == {str(moved / "src.bam"): "shared"}


def _piece(hap, source, q0, q1):
    return ll.LiftPiece(0, 1000, 2000, q0, q1, "+", True, hap, source)


@pytest.mark.parametrize("haps,bp,ok", [(2, 250_000, False), (1, 390_000, True), (4, 150_000, True), (4, 250_000, False)])
def test_source_budget_scales_with_haplotypes(haps, bp, ok):
    pieces = [_piece(f"H#{i}", f"src{i}", 0, bp) for i in range(haps)]
    selection = SimpleNamespace(pieces=pieces, gap_flanks=[], view_start=1000, view_end=11_000)
    if ok:
        plan = ll.plan_fetch(selection, ll.LiftSettings())
        assert plan.source_bp == haps * bp
    else:
        with pytest.raises(ll.LiftRefused):
            ll.plan_fetch(selection, ll.LiftSettings())
