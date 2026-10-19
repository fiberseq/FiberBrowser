"""Independent molecule-count controls for whole-compound support."""
from dataclasses import replace

from services.differences.calls import Call
from services.differences.carriers import JointPathEvidence, joint_call, phase_union, whole_target_calls


def proof(molecule="m1", *, components=("A", "B"), hypothesis="h1", representation="native", equivalent="compound", **options):
    good = Call("target", "confirmed", "whole-target", "structural_path", witness_ids=("physical-junction",))
    return JointPathEvidence(molecule, representation, "native", hypothesis, "path:" + hypothesis, equivalent,
                             ("A", "B"), tuple((identity, good) for identity in components), good,
                             True, True, True, **options)


def confirmed(calls):
    return sum(c["call"]["assignment"] == "target" and c["call"]["level"] == "confirmed" for c in calls.values())


def test_disjoint_members_give_zero_joint_path_gives_one_and_full_encoding_still_one():
    assert confirmed(whole_target_calls([proof("m1", components=("A",)), proof("m2", components=("B",))], target_id="whole-target")) == 0
    assert confirmed(whole_target_calls([proof()], target_id="whole-target")) == 1
    good = Call("target", "confirmed", "whole-target", "exact_sequence")
    replacement = replace(proof(), equivalent_representation_id="full-replacement",
                          required_components=("whole",), component_calls=(("whole", good),))
    result = whole_target_calls([proof(), replacement, replacement], target_id="whole-target")
    assert confirmed(result) == 1 and len(result) == 1
    assert len(result["m1"]["call"]["witness_ids"]) == 1


def test_member_intersection_on_exclusive_hypotheses_is_zero():
    result = whole_target_calls([proof(components=("A",), hypothesis="h1"),
                                proof(components=("B",), hypothesis="h2")], target_id="whole-target")
    assert confirmed(result) == 0


def test_bridge_coverage_and_diagnostics_cannot_be_inherited_from_assembly():
    for bad in [replace(proof(), bridge_and_flank_call=Call()), replace(proof(), query_collinear=False),
                replace(proof(), compatible_path=False), replace(proof(), complete=False),
                replace(proof(), component_calls=(("A", Call("target", "confirmed", "member", "exact_sequence")),))]:
        assert joint_call(bad, "whole-target").assignment == "unknown"
    bad_recipe = replace(proof(components=('A',)), required_components=('A',))
    assert confirmed(whole_target_calls([bad_recipe], target_id='whole-target',
                     required_by_representation={'compound': ('A', 'B')})) == 0


def test_equivalent_full_path_rescues_partial_members_but_not_unresolved_coequal_placement():
    partial = proof(components=("A",))
    assert confirmed(whole_target_calls([partial, proof()], target_id="whole-target")) == 1
    result = whole_target_calls([proof(), proof(components=("A",), hypothesis="alternative")], target_id="whole-target")
    assert confirmed(result) == 0
    assert result["m1"]["call"]["assignment"] == "ambiguous"


def test_incomplete_search_and_independent_representation_dissent_precede_vote():
    result = whole_target_calls([proof()], target_id="whole-target",
        search_by_representation={"native": {"search_complete": False, "unexplored": [{"ownership": "coequal"}]}})
    assert confirmed(result) == 0
    lifted = replace(proof(components=("A",)), source="lifted", representation_id="lifted")
    result = whole_target_calls([proof(), lifted], target_id="whole-target", scope="combined")
    assert confirmed(result) == 0
    assert result["m1"]["call"]["assignment"] == "ambiguous"
    assert confirmed(whole_target_calls([proof(), lifted], target_id="whole-target", scope="native_only")) == 1


def test_unphased_occurrence_union_keeps_one_vote_and_no_inferred_phase():
    call = Call("target", "confirmed", "whole-target", "exact_sequence")
    result = phase_union({"maternal": {"m1": call}, "paternal": {"m1": call}})
    assert sum(c["carrier_vote"] for c in result.values()) == 1
    assert result["m1"]["inferred_phase"] is None
    assert set(result["m1"]["occurrences"]) == {"maternal", "paternal"}
    different = phase_union({'maternal': {'m1': call}, 'paternal': {'m1': replace(call, allele_id='different')}})
    assert different['m1']['carrier_vote'] == 0


def test_whole_target_reduction_retains_component_bridge_and_flank_coverage():
    entry = proof()
    a = Call("target", "confirmed", "whole-target", "structural_path", coverage=({"ref_start": 1, "ref_end": 2},))
    b = replace(a, coverage=({"ref_start": 3, "ref_end": 4},))
    bridge = replace(a, coverage=({"ref_start": 2, "ref_end": 3},))
    entry = replace(entry, component_calls=(("A", a), ("B", b)), bridge_and_flank_call=bridge)
    result = whole_target_calls([entry], target_id="whole-target")
    assert result["m1"]["call"]["coverage"] == a.coverage + b.coverage + bridge.coverage
