"""Live lift selection, bin cache, fetch plan, budgets and lift_key
(DESIGN_LIVE_LIFT.md §2.5, §3.2)."""
import dataclasses
import os
import pwd
import random

import pytest

from live_lift_fixtures import MAT, PAT, TARGET, write_toy_sidecar
from services.lift import live_lift as ll

V4 = os.path.join(os.environ.get("PGLIFT_WORK", os.path.join(pwd.getpwuid(os.getuid()).pw_dir, "pglift_work")), "pglift_20261017/native/graphlift/scratch/v4")


@pytest.fixture
def toy(tmp_path):
    ll.clear_selection_cache()
    return ll.open_lift_map(write_toy_sidecar(tmp_path / "map"))


def _select(handle, start, end, settings=None, haps=None, cache=True):
    settings = settings or ll.LiftSettings()
    haps = handle.haplotypes if haps is None else haps
    return ll.select_pieces(handle, TARGET, start, end, haplotypes=haps, settings=settings,
                            key=ll.lift_key(handle, haps, settings), use_cache=cache)


def test_haplotype_labels_and_sources(toy):
    assert toy.haplotype_labels == {"H#1": "MAT", "H#2": "PAT"}
    assert toy.source_haplotype == {MAT: "H#1", PAT: "H#2"}


def test_margin_is_view_20kb_or_g_split():
    s = ll.LiftSettings(g_split=50_000)
    assert ll.margin_for(1_000, ll.LiftSettings()) == 20_000
    assert ll.margin_for(30_000, ll.LiftSettings()) == 30_000
    assert ll.margin_for(1_000, s) == 50_000


@pytest.mark.parametrize("strand", ["+", "-"])
def test_clip_piece_adjusts_source_on_both_strands(strand):
    p = ll.LiftPiece(0, 100, 200, 1000, 1100, strand, True, "h", "s")
    c = ll.clip_piece(p, 120, 190)
    assert (c.t_start, c.t_end) == (120, 190)
    assert (c.q_start, c.q_end) == ((1020, 1090) if strand == "+" else (1010, 1080))
    assert ll.clip_piece(p, 200, 300) is None


def test_selection_haplotypes_and_primary(toy):
    sel = _select(toy, 2000, 3000)  # margin 20 kb: the whole toy target
    assert {p.hap for p in sel.pieces} == {"H#1", "H#2"}
    assert all(p.primary for p in sel.pieces)
    assert [p for p in _select(toy, 2000, 3000, haps=["H#2"]).pieces] == [p for p in sel.pieces if p.hap == "H#2"]


def test_bin_cache_equals_fresh_selection_toy(toy):
    for start, end in [(0, 20_000), (3990, 4020), (12_500, 13_000)]:
        assert _select(toy, start, end).pieces == _select(toy, start, end, cache=False).pieces


@pytest.mark.skipif(not os.path.exists(os.path.join(V4, "hprc.GRCh38.HG002.chain.graphlift.json")),
                    reason="graphlift v4 sidecars not present")
def test_bin_cache_equals_fresh_selection_hprc_chr1():
    ll.clear_selection_cache()
    h = ll.open_lift_map(os.path.join(V4, "hprc.GRCh38.HG002.chain.graphlift.json"))
    rng = random.Random(3)
    for _ in range(25):
        s = rng.randrange(0, 248_000_000)
        e = s + rng.choice([1_000, 50_000, 300_000, 1_500_000])
        for alternatives in (False, True):
            st = ll.LiftSettings(alternatives=alternatives)
            key = ll.lift_key(h, h.haplotypes, st)
            a = ll.select_pieces(h, "chr1", s, e, haplotypes=h.haplotypes, settings=st, key=key)
            b = ll.select_pieces(h, "chr1", s, e, haplotypes=h.haplotypes, settings=st, key=key, use_cache=False)
            assert a.pieces == b.pieces


def test_every_setting_changes_lift_key(toy):
    base = ll.LiftSettings()
    k0 = ll.lift_key(toy, toy.haplotypes, base)
    changed = dict(haplotype_mode="pooled", g_split=20_000, window_merge=10_000, rejoin_bp=0, alternatives=True,
                   cohort_alternatives="include", supplementary_display="hide",
                   cohort_supplementaries="primary_only", fold_molecule=True, fold_orientation_rows=True,
                   joint_dedup="by_molecule", coverage_hatching=False, pooled_depth="correspondence_normalised",
                   primary_lookup=False, molecule_groups={"a.bam": "SAMPLE_A"})
    assert set(changed) == {f.name for f in dataclasses.fields(ll.LiftSettings)}
    keys = {ll.lift_key(toy, toy.haplotypes, dataclasses.replace(base, **{name: value}))
            for name, value in changed.items()}
    assert len(keys) == len(changed) and k0 not in keys
    assert ll.lift_key(toy, ["H#1"], base) != k0


def test_settings_validation():
    with pytest.raises(ll.LiftSettingsError):
        ll.LiftSettings(g_split=10)
    with pytest.raises(ll.LiftSettingsError):
        ll.LiftSettings(supplementary_display="fold")
    with pytest.raises(ll.LiftSettingsError):
        ll.LiftSettings.from_dict({"nonsense": 1})
    assert ll.LiftSettings.from_dict(ll.LiftSettings().as_dict()) == ll.LiftSettings()


def test_union_rule_for_supplementaries_and_alternatives():
    s = ll.LiftSettings
    assert s().load_supplementaries and not s().select_alternatives
    assert s(supplementary_display="hide").load_supplementaries  # the cohort still needs them
    assert not s(supplementary_display="hide", cohort_supplementaries="primary_only").load_supplementaries
    assert s(cohort_alternatives="include").select_alternatives


def test_plan_merges_windows_and_records_target_extents(toy):
    plan = ll.plan_fetch(_select(toy, 2000, 3000), ll.LiftSettings())
    by = {c.contig: c for c in plan.contigs}
    # MAT: chain 0 [0,3000)+[3000,5000)+[5100,6990) merge (same chain), chain 1 [7000,9000)
    # and chain 3 [9100,9500) are within window_merge: one window.
    assert by[MAT].windows == [(0, 9500)]
    assert by[PAT].windows == [(0, 4000)]
    assert by[MAT].target_extents(2900, 3100) == [(3900, 4110)]
    assert by[MAT].target_extents(7000, 7010) == [(13990, 14000)]
    tight = ll.plan_fetch(_select(toy, 2000, 3000), ll.LiftSettings(window_merge=0))
    assert {c.contig: c.windows for c in tight.contigs}[MAT] == [(0, 6990), (7000, 9000), (9100, 9500)]


def test_budget_refusals_never_drop_flanks(toy, monkeypatch):
    sel = _select(toy, 2000, 3000)
    monkeypatch.setattr(ll, "MIN_SOURCE_BP_BUDGET", 1_000)
    with pytest.raises(ll.LiftRefused) as err:
        ll.plan_fetch(sel, ll.LiftSettings())
    assert err.value.status == 413
    monkeypatch.setattr(ll, "MIN_SOURCE_BP_BUDGET", 400_000)
    monkeypatch.setattr(ll, "MAX_WINDOWS", 2)
    with pytest.raises(ll.LiftRefused):
        ll.plan_fetch(sel, ll.LiftSettings(window_merge=0))


def test_alternatives_flagged_and_capped(toy, monkeypatch):
    assert all(p.primary for p in _select(toy, 2000, 3000).pieces)
    for settings in (ll.LiftSettings(alternatives=True), ll.LiftSettings(cohort_alternatives="include")):
        sel = _select(toy, 2000, 3000, settings=settings)
        assert [(p.chain, p.t_start, p.t_end) for p in sel.pieces if not p.primary] == [(4, 1500, 1800)]
    monkeypatch.setattr(ll, "MAX_ALTERNATIVE_CHAINS", 0)
    sel = _select(toy, 2000, 3000, settings=ll.LiftSettings(alternatives=True))
    assert sel.alternatives_capped == 1 and all(p.primary for p in sel.pieces)
