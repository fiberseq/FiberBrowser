"""Independent edited-string, coordinate and molecule-count projection oracles."""
from dataclasses import replace

import pytest

from services.differences.alleles import DafContext
from services.differences.calls import Call, MoleculeId, Representation, reconcile_representations
from services.differences.policy import SearchPolicy
from services.differences.projection import (MapGap, MapPath, ProjectionBudget, ProjectionPolicy,
    SourceAlignment, call_molecule, classify_projection, compose_alignment, revcomp)
from services.lift.live_lift import LiftPiece
from services.reconstruction_budget import ResourceResult


MOLECULE = MoleculeId("synthetic", "library", "molecule")


def path(dt=20, dq=0, minus=False, *, ownership="primary", identity="path"):
    # The independently authored target is G*50 + C*dt + T*50;
    # source is G*50 + A*dq + T*50 in target orientation.
    if minus:
        pieces = (LiftPiece(0, 1000, 1050, 150+dq, 200+dq, "-", True, "H#1", "source"),
                  LiftPiece(0, 1050+dt, 1100+dt, 100, 150, "-", True, "H#1", "source"))
    else:
        pieces = (LiftPiece(0, 1000, 1050, 100, 150, "+", True, "H#1", "source"),
                  LiftPiece(0, 1050+dt, 1100+dt, 150+dq, 200+dq, "+", True, "H#1", "source"))
    return MapPath(identity, "target", "source", pieces,
        (MapGap("map-edit", 150, 150+dq, 1050, 1050+dt, "raw_gap"),), ownership,
        "synthetic-content", ownership_validated=ownership == "primary")


def alignment(dq=0, *, minus=False, reverse=False, cigar=None, sequence=True):
    bases = "G"*50 + "A"*dq + "T"*50
    bases = revcomp(bases) if minus else bases
    return SourceAlignment("record", MOLECULE, "source", 100,
        cigar or ((0, len(bases)),), reverse=reverse, sequence=bases if sequence else None)


def target(dt=20, dq=0, exact=False):
    return dict(target_id="allele", target_type="exact" if exact else "geometry", chrom="target",
        ref_start=1050, ref_end=1050+dt, alt_bp=dq,
        candidates={"allele": "A"*dq, "reference": "C"*dt}, competition_complete=True)


@pytest.mark.parametrize("dt,dq", [(0, 30), (20, 0), (20, 3), (4, 792), (4, 788), (199, 0), (200, 0), (201, 1)])
@pytest.mark.parametrize("minus", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
def test_source_perfect_read_composes_every_map_gap(dt, dq, minus, reverse):
    a, p = alignment(dq, minus=minus, reverse=reverse), path(dt, dq, minus)
    projected = compose_alignment(a, p)
    edit, = projected["edits"]
    assert (projected["ref_start"], projected["ref_end"]) == (1000, 1100+dt)
    assert (edit["ref_start"], edit["ref_end"], edit["alt_bp"], edit["observed"]) == (1050, 1050+dt, dq, "A"*dq)
    # Reconstruct directly from the hand-authored string, not production edits.
    expected = "G"*50 + "A"*dq + "T"*50
    assert expected == (revcomp(a.sequence) if minus else a.sequence)
    assert projected["alignment_orientation"] == ("reverse" if minus != reverse else "forward")
    assert projected["base_blocks"][0]["seq_q"] == ([50+dq, 100+dq] if minus else [0, 50])
    detail = classify_projection(a, projected, target(dt, dq, True), context=DafContext("none", "oracle"))
    assert detail["call"]["assignment"] == "target"
    assert detail["call"]["level"] == "confirmed"
    assert detail["read_bases"] == ("A"*dq)[:60]
    assert detail["read_bases_length"] == dq


@pytest.mark.parametrize("minus", [False, True])
def test_source_deletion_cancels_map_insertion_and_retains_reference(minus):
    a = alignment(30, minus=minus, cigar=((0, 50), (2, 30), (0, 50)))
    a = replace(a, sequence="G"*50+"T"*50 if not minus else revcomp("G"*50+"T"*50))
    projected = compose_alignment(a, path(0, 30, minus))
    assert projected["edits"] == []
    assert projected["partial_gaps"] == []
    assert classify_projection(a, projected, target(0, 30))["call"]["assignment"] == "reference"
    assert classify_projection(a, projected, target(0, 30, True), context=DafContext("none", "oracle"))["call"]["assignment"] == "reference"


def test_read_insertion_cancels_map_deletion_by_observed_target_string():
    p = path(20, 0)
    a = replace(alignment(), cigar=((0, 50), (1, 20), (0, 50)), sequence="G"*50+"C"*20+"T"*50)
    projected = compose_alignment(a, p)
    assert projected["edits"][0]["observed"] == "C"*20
    assert classify_projection(a, projected, target(20, 0, True), context=DafContext("none", "oracle"))["call"]["assignment"] == "reference"
    # Replacement with the same geometry but another string is another allele.
    t = target(20, 20, True)
    t["candidates"]["other"] = "C"*20
    t["candidates"]["reference"] = "G"*20
    result = classify_projection(a, projected, t, context=DafContext("none", "oracle"))
    assert result["call"]["assignment"] == "other_allele"
    assert result["call"]["allele_id"] == "other"


@pytest.mark.parametrize("minus,reverse", [(False, False), (True, False), (False, True), (True, True)])
def test_hard_clips_full_molecule_seq_slices_and_clip_origin(minus, reverse):
    p = path(20, 3, minus)
    raw = alignment(3, minus=minus, reverse=reverse)
    a = replace(raw, cigar=((5, 5), (4, 10), (0, 103), (5, 7)), sequence="N"*10+raw.sequence)
    projected = compose_alignment(a, p)
    first = projected["base_blocks"][0]
    assert projected["query_length"] == 125
    assert projected["sequence_span"] == ([7, 120] if minus else [5, 118])
    assert first["q_start"] == (7 if minus else 15)
    assert first["seq_q"] == ([63, 113] if minus else [10, 60])
    assert first["original_query"] == ([7, 57] if reverse else [68, 118]) if minus else first["original_query"] == ([60, 110] if reverse else [15, 65])
    clip = next(c for c in projected["clips"] if not c["hard"])
    assert clip["side"] == ("R" if minus else "L")
    assert clip["ref"] == (1120 if minus else 1000)
    assert clip["source_anchor"] == 100 and clip["origin_record_id"] == "record"
    assert projected["edits"][0]["seq_q"] == [60, 63]


def test_skip_missing_map_cut_and_negative_query_gap_never_form_junction():
    p = path(20, 30)
    a = replace(alignment(30), cigar=((0, 50), (3, 30), (0, 50)), sequence="G"*50+"T"*50)
    for altered, record in ((p, a), (replace(p, gaps=()), alignment(30))):
        projected = compose_alignment(record, altered)
        assert projected["edits"] == [] and len(projected["components"]) == 2
        assert classify_projection(record, projected, target(20, 30))["call"]["assignment"] == "unknown"
    # Mutually exclusive same-source blocks cannot be one monotone query path.
    with pytest.raises(ValueError, match="noncollinear"):
        replace(p, pieces=(p.pieces[0], p.pieces[1]._replace(q_start=120, q_end=170)), gaps=())


def test_missing_flank_insertion_only_missing_seq_and_unprojectable_sa():
    p = path(20, 30)
    a = replace(alignment(30), ref_start=150, cigar=((0, 30),), sequence="A"*30,
                witnesses=({"reason": "source_witness_not_projected", "chrom": "unmapped-source"},))
    result = call_molecule([a], [p], target(20, 30, True))
    assert result["call"]["assignment"] == "unknown"
    assert result["available"] and result["unprojectable_witnesses"]
    full = alignment(30, sequence=False)
    detail = classify_projection(full, compose_alignment(full, p), target(20, 30, True))
    assert detail["geometry_evidence"]["assignment"] == "target"
    assert detail["call"]["assignment"] == "unknown"
    # Empty deletion is structural; absent SEQ is not an empty insertion.
    deletion = alignment(sequence=False)
    assert classify_projection(deletion, compose_alignment(deletion, path()), target(exact=True))["call"]["assignment"] == "target"


@pytest.mark.parametrize("retained", ["target", "reference"])
@pytest.mark.parametrize("cap", ["hypotheses", "path_states", "transitions"])
def test_real_search_forced_exhaustion_cannot_hide_primary_dissent(retained, cap):
    a = alignment(30)
    carrier = path(0, 30, identity="a")
    reference = MapPath("b", "target", "source", (LiftPiece(1, 1000, 1130, 100, 230, "+", True, "H#1", "source"),), ownership="primary", ownership_validated=True)
    ps = [carrier, reference] if retained == "target" else [replace(reference, path_id="a"), replace(carrier, path_id="b")]
    kwargs = {"max_"+cap: 1 if cap != "transitions" else 2}
    policy = ProjectionPolicy(search=SearchPolicy(**kwargs))
    result = call_molecule([a], ps, target(0, 30), policy=policy)
    assert result["call"]["assignment"] in {"unknown", "ambiguous"}
    assert "incomplete_hypothesis_search" in result["call"]["reasons"]
    assert result["search"]["pruned"][cap] > 0


def test_primary_dissenting_secondary_caps_and_independent_exclusion():
    a = alignment(30)
    primary = path(0, 30, identity="primary")
    alt = MapPath("secondary", "target", "source", (LiftPiece(1, 1000, 1130, 100, 230, "+", False, "H#1", "source"),), ownership="secondary")
    policy = ProjectionPolicy(cohort_alternatives="include")
    result = call_molecule([a], [primary, alt], target(0, 30), policy=policy)
    assert result["call"]["assignment"] == "target"
    assert result["alternative_status"] == "alt_chain_conflict"
    capped = call_molecule([a], [primary, alt], target(0, 30), policy=replace(policy, search=SearchPolicy(max_hypotheses=1)))
    assert capped["call"]["assignment"] == "target" and capped["primary_complete"]
    assert not capped["search"]["search_complete"]
    # Source-disjoint alternatives are excluded from placement before caps,
    # independently of which allele their sequence would support.
    disjoint = replace(alt, source="elsewhere", pieces=tuple(p._replace(source="elsewhere") for p in alt.pieces))
    safe = call_molecule([a], [primary, disjoint], target(0, 30), policy=replace(policy, search=SearchPolicy(max_hypotheses=1)))
    assert safe["search"]["search_complete"] and safe["call"]["assignment"] == "target"
    assert call_molecule([a], [alt], target(0, 30), policy=policy)["primary_complete"] is False


def test_independent_copies_reconcile_before_one_vote():
    a, p, t = alignment(30), path(0, 30), target(0, 30)
    lifted = call_molecule([a, a], [p], t)
    call = Call(**lifted["call"])
    result = reconcile_representations([Representation("native", "native", Call("reference", "confirmed", "reference")),
        Representation("lifted", "lifted", call)], scope="combined")
    assert result["call"]["assignment"] == "ambiguous"
    assert len(lifted["hypotheses"][0]["record_scope"]) == 1
    assert len(call.witness_ids) == 1


def test_budgets_fail_before_reconstruction_and_check_deadline(monkeypatch):
    a, p = alignment(30), path(0, 30)
    with pytest.raises(ResourceResult, match="projection_runs_cap"):
        compose_alignment(a, p, budget=ProjectionBudget(ProjectionPolicy(max_runs=1)))
    with pytest.raises(ResourceResult, match="projection_sequence_cap"):
        compose_alignment(a, p, budget=ProjectionBudget(ProjectionPolicy(max_sequence_bp=10)))
    b = ProjectionBudget()
    b.deadline = 0
    with pytest.raises(ResourceResult, match="projection_deadline"):
        compose_alignment(a, p, budget=b)


def test_composed_compound_keeps_observed_bridge_and_matches_full_replacement():
    pieces = (LiftPiece(0, 1000, 1050, 100, 150, "+", True, "H#1", "source"),
              LiftPiece(0, 1070, 1085, 150, 165, "+", True, "H#1", "source"),
              LiftPiece(0, 1115, 1165, 165, 215, "+", True, "H#1", "source"))
    p = MapPath("compound", "target", "source", pieces,
        (MapGap("first", 150, 150, 1050, 1070, "D"), MapGap("second", 165, 165, 1085, 1115, "D")),
        ownership="primary", ownership_validated=True)
    a = replace(alignment(), cigar=((0, 115),), sequence="G"*50+"T"*15+"A"*50)
    projected = compose_alignment(a, p)
    assert [(e["ref_start"], e["ref_end"], e["alt_bp"]) for e in projected["edits"]] == [(1050, 1070, 0), (1085, 1115, 0)]
    t = dict(target_id="compound", target_type="exact", ref_start=1050, ref_end=1115, alt_bp=15,
        candidates={"compound": "T"*15, "reference": "C"*20+"T"*15+"G"*30, "other": "A"*15}, competition_complete=True)
    result = classify_projection(a, projected, t, context=DafContext("none", "oracle"))
    assert result["read_bases"] == "T"*15 and result["call"]["assignment"] == "target"
    assert result["call"]["level"] == "confirmed"


@pytest.mark.parametrize("right_clip,expected", [(50, "target"), (49, "unknown"), (51, "unknown")])
def test_actual_supplementary_junction_uses_target_endpoints_and_one_query_frame(right_clip, expected):
    p = path(200, 0)
    left = replace(alignment(), record_id="left", cigar=((0, 50), (4, 50)), sequence="G"*50+"N"*50)
    right = replace(alignment(), record_id="right", supplementary=True, ref_start=150,
        cigar=((4, right_clip), (0, 100-right_clip)), sequence="N"*right_clip+"T"*(100-right_clip))
    result = call_molecule([left, right], [p], target(200, 0, True))
    assert result["call"]["assignment"] == expected
    if expected == "target":
        assert result["call"]["alignment_ids"] == ("left", "right")
        assert len(result["call"]["witness_ids"]) == 1
    # The same two apparent flanks in exclusive paths never create a junction.
    alternatives = [replace(p, path_id="left-choice", pieces=(p.pieces[0],), gaps=()),
                    replace(p, path_id="right-choice", pieces=(p.pieces[1],), gaps=())]
    exclusive = call_molecule([left, right], alternatives, target(200, 0, True))
    assert exclusive["call"]["assignment"] != "target"


def test_real_compatible_query_conflict_requires_quality_overlap_and_placement():
    p = path(0, 1000)
    p = replace(p, pieces=(*p.pieces, LiftPiece(0, 200000, 201000, 5000, 6000, "+", True, "H#1", "source")))
    supporting = alignment(1000)
    elsewhere = replace(supporting, record_id="supplementary", ref_start=5000, supplementary=True,
        cigar=((4, 50), (0, 1000), (4, 50)), sequence="N"*1100)
    result = call_molecule([supporting, elsewhere], [p], target(0, 1000))
    assert result["call"]["level"] == "conflicting"
    assert "compatible_query_elsewhere" in result["call"]["reasons"]
    safe = call_molecule([supporting, replace(elsewhere, mapq=0)], [p], target(0, 1000))
    assert safe["call"]["level"] == "confirmed"
    unprojectable = replace(elsewhere, contig="unmapped-source")
    assert call_molecule([supporting, unprojectable], [p], target(0, 1000))["call"]["level"] == "confirmed"


def test_shifted_repeat_requires_common_window_before_reference_exclusion():
    p = MapPath("affine", "target", "source", (LiftPiece(0, 1000, 1400, 0, 400, "+", True, "H#1", "source"),), ownership="primary", ownership_validated=True)
    a = replace(alignment(), ref_start=0, cigar=((0, 100), (1, 100), (0, 300)), sequence="A"*500)
    t = dict(target_id="repeat", target_type="exact", ref_start=1200, ref_end=1200, alt_bp=100,
        candidates={"repeat": "A"*100, "reference": ""}, competition_complete=True)
    projected = compose_alignment(a, p)
    narrow = classify_projection(a, projected, t, context=DafContext("none", "oracle"))
    assert narrow["call"]["assignment"] == "ambiguous"
    assert narrow["call"]["reasons"] == ("diagnostic_window_misses_geometry",)
    common = {**t, "diagnostic_start": 1050, "diagnostic_end": 1250,
              "candidates": {"repeat": "A"*300, "reference": "A"*200}}
    wide = classify_projection(a, projected, common, context=DafContext("none", "oracle"))
    assert wide["call"]["assignment"] == "target" and wide["read_bases_length"] == 300


def test_independent_conflicting_net_claim_is_unexplored_even_if_selected_winner_agrees():
    p = replace(path(0, 30), ownership_witnesses=({"start": 1040, "end": 1060, "chain": 7},))
    result = call_molecule([alignment(30)], [p], target(0, 30))
    assert result["call"]["assignment"] == "ambiguous" and result["primary_complete"] is False
    assert result["search"]["unexplored"][0]["reason"] == "conflicting_primary_ownership"


def test_unmapped_source_tails_remain_query_witnesses_without_invented_conflicts():
    a = replace(alignment(), ref_start=0, cigar=((0, 300),), sequence="A"*300)
    p = path(20, 0)
    projected = compose_alignment(a, p)
    witnesses = [w for w in projected["unresolved_witnesses"] if w["reason"] == "source_path_outside_selected_map"]
    assert [(w["source_start"], w["source_end"], w["original_query"]) for w in witnesses] == [(0, 100, [0, 100]), (200, 300, [200, 300])]
    detail = classify_projection(a, projected, target(20, 0))
    assert detail["call"]["assignment"] == "target" and detail["call"]["level"] == "confirmed"
    assert "unresolved_source_witness" in detail["call"]["reasons"]


def test_geometry_tolerance_is_saved_policy_and_cannot_promote_a_deletion_allele():
    p = path(0, 100)
    a = replace(alignment(100), cigar=((0, 50), (2, 1), (0, 149)), sequence="G"*50+"A"*99+"T"*50)
    projected = compose_alignment(a, p)
    assert classify_projection(a, projected, target(0, 100))["call"]["assignment"] == "target"
    strict = ProjectionPolicy(geometry_anchor_bp=0, geometry_anchor_fraction=0, geometry_span_bp=0, geometry_span_fraction=0)
    assert classify_projection(a, projected, target(0, 100), geometry_policy=strict)["call"]["assignment"] == "unknown"
    # A one-base replacement may share deletion geometry. Missing SEQ cannot
    # use that tolerance as structural proof of the empty exact alternate.
    p = path(200, 1)
    a = alignment(1, sequence=False)
    detail = classify_projection(a, compose_alignment(a, p), target(200, 0, True))
    assert detail["geometry_evidence"]["assignment"] == "target"
    assert detail["call"]["assignment"] == "unknown"


def test_joint_deletion_cannot_erase_another_viable_source_placement():
    p = path(200, 0)
    left = replace(alignment(), record_id="left", cigar=((0, 50), (4, 50)), sequence="G"*50+"N"*50)
    right = replace(alignment(), record_id="right", supplementary=True, ref_start=150,
        cigar=((4, 50), (0, 50)), sequence="N"*50+"T"*50)
    alternative = replace(left, record_id="other-placement", ref_start=130,
        cigar=((4, 20), (0, 20), (4, 60)), sequence="N"*100)
    assert call_molecule([left, right], [p], target(200, 0, True))["call"]["assignment"] == "target"
    result = call_molecule([left, right, alternative], [p], target(200, 0, True))
    assert result["call"]["assignment"] == "ambiguous"
    assert result["geometry_call"]["assignment"] == "ambiguous"
    assert "unresolved_representation" in result["call"]["reasons"]


def test_unmapped_query_witnesses_share_the_geometry_storage_budget():
    a = replace(alignment(), ref_start=0, cigar=((0, 1),)*100, sequence="A"*100)
    p = MapPath("outside", "target", "source", (LiftPiece(0, 1000, 1100, 1000, 1100, "+", True, "H#1", "source"),))
    with pytest.raises(ResourceResult, match="projection_runs_cap"):
        compose_alignment(a, p, budget=ProjectionBudget(ProjectionPolicy(max_runs=10)))
