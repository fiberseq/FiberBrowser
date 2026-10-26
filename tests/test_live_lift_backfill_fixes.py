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


def test_anchor_check_skips_contigs_and_bases_a_fasta_lacks(tmp_path):
    """A source FASTA of some contigs, or N-masked outside a window, is not an anchor mismatch."""
    import pysam
    from services.lift.validate import validate_live_lift
    from test_differences_comparison import build, CHROM
    state, ds, files = build(tmp_path)
    mat, pat = files["mat"], files["pat"]

    def fasta(name, entries):
        path = tmp_path / name
        path.write_text("".join(f">{n}\n{s}\n" for n, s in entries))
        pysam.faidx(str(path))
        return str(path)
    mat_only = fasta("mat_only.fa", [("chrC_MATERNAL", mat)])
    masked = fasta("masked.fa", [("chrC_MATERNAL", "N" * len(mat)), ("chrC_PATERNAL", "N" * len(pat))])
    wrong = fasta("wrong.fa", [("chrC_MATERNAL", mat[::-1]), ("chrC_PATERNAL", pat[::-1])])
    handle = ds.live_lift.handle
    for path, status in ((mat_only, "consistent"), (masked, "not checked")):
        result = validate_live_lift(handle, ds.paths, ds.live_lift.haplotypes, target_fasta=state.fasta, source_fasta=path)
        assert result.ok and result.anchors["status"] == status, result.anchors
    result = validate_live_lift(handle, ds.paths, ds.live_lift.haplotypes, target_fasta=state.fasta, source_fasta=wrong)
    assert not result.ok and result.anchors["status"] == "mismatch"


def test_anchor_check_samples_every_haplotype(tmp_path):
    """Codex r2 HIGH 1: a wrong second haplotype is refused even when the first matches everywhere."""
    import pysam
    from services.lift.validate import validate_live_lift
    from test_differences_comparison import build
    state, ds, files = build(tmp_path)
    path = tmp_path / "pat_wrong.fa"
    path.write_text(f">chrC_MATERNAL\n{files['mat']}\n>chrC_PATERNAL\n{files['pat'][::-1]}\n")
    pysam.faidx(str(path))
    result = validate_live_lift(ds.live_lift.handle, ds.paths, ds.live_lift.haplotypes, target_fasta=state.fasta, source_fasta=str(path))
    assert not result.ok and result.anchors["status"] == "mismatch" and "chrC_PATERNAL" in result.anchors["message"]


def test_anchor_check_budget_is_per_bucket_and_reports_unchecked_haplotypes(tmp_path, monkeypatch):
    """Codex r3 HIGH: masked anchors of one haplotype cannot use up the next haplotype's checks."""
    import pysam
    from services.lift import validate
    from test_differences_comparison import build
    state, ds, files = build(tmp_path)

    def fasta(name, mat, pat):
        path = tmp_path / name
        path.write_text(f">chrC_MATERNAL\n{mat}\n>chrC_PATERNAL\n{pat}\n")
        pysam.faidx(str(path))
        return str(path)
    handle, haps = ds.live_lift.handle, ds.live_lift.haplotypes
    masked_mat_wrong_pat = fasta("a.fa", "N" * len(files["mat"]), files["pat"][::-1])
    result = validate.validate_live_lift(handle, ds.paths, haps, target_fasta=state.fasta, source_fasta=masked_mat_wrong_pat)
    assert not result.ok and result.anchors["status"] == "mismatch"
    ok_mat_masked_pat = fasta("b.fa", files["mat"], "N" * len(files["pat"]))
    result = validate.validate_live_lift(handle, ds.paths, haps, target_fasta=state.fasta, source_fasta=ok_mat_masked_pat)
    assert result.ok and result.anchors["unchecked_haplotypes"] == ["H#2"]
    assert any("not checked for haplotype" in w for w in result.warnings)
