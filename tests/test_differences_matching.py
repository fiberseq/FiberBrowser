"""Independent edited-string oracles, including held-out candidate controls."""
from dataclasses import replace
import random

import pytest

from services.differences.matching import (ComparisonScope, Edit, MatchingPolicy, ReferenceWindow,
    candidate_relation, canonicalize, match_edits, novelty, phase_relation, reconstruct)
from services.differences.model import Phase
from services.reconstruction_budget import ResourceResult


def edit(identity, start, end, alt=None, *, length=None, source="reads", **options):
    return Edit(identity, "reference-content", "chrT", start, end, len(alt) if alt is not None else length,
                source, alt, sequence_complete=alt is not None, **options)


def test_compound_keeps_bridge_and_equals_whole_replacement_with_same_hash():
    reference = "G" + "A" * 50 + "CGTACGTACGTACGT" + "T" * 50 + "C"
    window = ReferenceWindow("reference-content", "chrT", 0, reference, len(reference))
    members = [edit("left", 1, 51, "", path_id="one"), edit("right", 66, 116, "", path_id="one")]
    whole = edit("whole", 1, 116, reference[51:66], source="assembly")
    expected = "GCGTACGTACGTACGTC"  # independently authored resulting haplotype
    assert reconstruct(members, window)[0] == expected
    assert reconstruct([whole], window)[0] == expected
    result = match_edits(members, [whole], window_provider=lambda *args: window)
    exact = [link for link in result["links"] if link["relation"] == "exact"]
    assert len(exact) == 1
    assert exact[0]["endpoints"] == (("left", "right"), ("whole",))
    assert exact[0]["recipe"]["left_allele_id"] == exact[0]["recipe"]["right_allele_id"]
    assert exact[0]["member_roles"]["left"] == "component"
    compound, = result['compounds']
    assert compound['observation_ids'] == ('left', 'right')
    assert compound['retained_bridges'] == ({'contig': 'chrT', 'start': 51, 'end': 66},)
    wrong = replace(whole, alt="A" * 15)
    assert not any(l["relation"] == "exact" for l in match_edits(members, [wrong], window_provider=lambda *args: window)["links"])


def test_many_to_many_keeps_distinct_strings_and_both_phase_occurrences():
    window = ReferenceWindow("reference-content", "chrT", 0, "G" * 100 + "T" * 100, 200)
    left = [edit("read-a", 100, 100, "A" * 100), edit("read-c", 100, 100, "C" * 100)]
    right = [edit("assembly-a", 100, 100, "A" * 100, source="assembly", phase=Phase("sample", "set", "1")),
             edit("assembly-c", 100, 100, "C" * 100, source="assembly", phase=Phase("sample", "set", "2"))]
    result = match_edits(left, right, window_provider=lambda *args: window)
    assert len(result["links"]) == 4
    assert sum(l["relation"] == "exact" for l in result["links"]) == 2
    assert {l["phase_relation"] for l in result["links"]} == {"unphased_union"}
    assert all("carriers" not in l for l in result["links"])


@pytest.mark.parametrize("left,right", [
    ((100, 0, 786), (104, 4, 792)), ((100, 0, 786), (104, 4, 788)),
    ((100, 88, 0), (107, 90, 2)), ((100, 52, 0), (122, 48, 0)),
    ((100, 0, 795), (161, 0, 739)), ((100, 1500, 0), (100, 1500, 0)),
    ((100, 1733, 1), (100, 1733, 1)),
])
def test_measured_shapes_are_candidates_only(left, right):
    p, r, a = left
    q, s, b = right
    l, rr = edit("read", p, p + r, length=a), edit("assembly", q, q + s, length=b, source="assembly")
    result = match_edits([l], [rr])
    assert len(result["links"]) == 1
    assert result["links"][0]["relation"] == "candidate"
    assert candidate_relation(l, rr)


def test_both_endpoints_and_spans_reject_net_sum_shortcuts():
    assert candidate_relation(edit("a", 100, 100, length=100), edit("b", 100, 300, length=300)) is None
    assert candidate_relation(edit("a", 100, 200, ""), edit("b", 500, 600, "")) is None


def test_repeat_rotation_is_proven_before_search_and_incomplete_halos_refuse_hash():
    sequence = "C" + "AT" * 300 + "G"
    window = ReferenceWindow("reference-content", "chrT", 0, sequence, len(sequence))
    a, b = edit("a", 1, 1, "AT"), edit("b", 502, 502, "TA", source="assembly")
    assert candidate_relation(a, b) is None
    result = match_edits([a], [b], window_provider=lambda *args: window)
    link, = result["links"]
    assert link["relation"] == "exact"
    assert link["recipe"]["left_allele_id"] == link["recipe"]["right_allele_id"]
    normalized = reconstruct([a], window)[1]
    assert normalized.equivalent_anchors == (1, 601)
    partial = ReferenceWindow("reference-content", "chrT", 11, "AT" * 100)
    normalized = reconstruct([edit("partial", 11, 11, "AT")], partial)[1]
    assert normalized.exact_allele_id is None and not normalized.normalization_complete
    wrong = replace(b, alt="AA")
    assert not any(l["relation"] == "exact" for l in match_edits([a], [wrong], window_provider=lambda *args: window)["links"])


def test_general_replacement_padding_and_local_inversion_have_same_canonical_allele():
    window = ReferenceWindow("reference-content", "chrT", 0, "AACCGGTT", 8)
    # This authored operation is an exact inversion recipe. A map marker with
    # unavailable source bases cannot make that sequence claim automatically.
    a = edit("inv", 1, 5, length=4, kind="inversion", inversion_exact=True)  # ACCG -> CGGT
    b = edit("replacement", 1, 5, "CGGT", source="assembly")
    assert reconstruct([a], window)[0] == "ACGGTGTT"
    result = match_edits([a], [b], window_provider=lambda *args: window)
    assert result["links"][0]["relation"] == "exact"
    unresolved = match_edits([replace(a, inversion_exact=False)], [b], window_provider=lambda *args: window)
    assert not any(link['relation'] == 'exact' for link in unresolved['links'])
    assert 'sequence_unavailable' in unresolved['reasons']
    assert canonicalize(window, "ACGGTGTT").exact_allele_id == reconstruct([b], window)[1].exact_allele_id
    padded = edit("padded", 0, 6, "ACGGTG")
    assert reconstruct([padded], window)[1].exact_allele_id == reconstruct([b], window)[1].exact_allele_id


@pytest.mark.parametrize("change", [dict(path_id="different"), dict(hypothesis_id="exclusive"),
                                      dict(phase=Phase("sample", "phase", "1"))])
def test_compounds_cannot_cross_paths_hypotheses_or_phase(change):
    a, b = edit("a", 1, 3, "", path_id="one"), edit("b", 5, 7, "", path_id="one", **{})
    with pytest.raises(ValueError, match="incompatible"):
        reconstruct([a, replace(b, **change)], ReferenceWindow("reference-content", "chrT", 0, "ACGTACGT"))


def test_known_incompatible_phase_blocks_links_but_unrelated_labels_do_not_infer_phase():
    p, q = Phase("sample", "set", "1"), Phase("sample", "set", "2")
    assert phase_relation(p, q) == "incompatible"
    assert phase_relation(p, Phase("different", "set", "1")) == "incomparable"
    assert not match_edits([edit("a", 1, 1, "A", phase=p)], [edit("b", 1, 1, "A", phase=q)])["links"]


def test_caps_missing_sequence_and_unsupported_topology_are_explicit():
    a, b = edit("a", 100, 100, length=100), edit("b", 100, 100, length=100)
    window = ReferenceWindow("reference-content", "chrT", 0, "G" * 100 + "T" * 100)
    result = match_edits([a], [b], window_provider=lambda *args: window)
    assert result["links"][0]["relation"] == "candidate"
    assert "sequence_unavailable" in result["reasons"]
    result = match_edits([a], [b, replace(b, observation_id="c")], policy=MatchingPolicy(max_links=1))
    assert not result["search_complete"] and "links_cap" in result["reasons"]
    assert not match_edits([a], [b], policy=MatchingPolicy(max_observations=1))["search_complete"]
    result = match_edits([replace(a, kind="breakend")], [b], window_provider=lambda *args: window)
    assert not result["search_complete"] and "unassessed_representation" in result["reasons"]
    with pytest.raises(ResourceResult, match="reference_bases"):
        reconstruct([a], window, MatchingPolicy(max_sequence_bp=10))


def test_explicit_raw_order_and_bounded_path_caps():
    window = ReferenceWindow('reference-content', 'chrT', 0, 'GT', 2)
    a, b = edit('a', 1, 1, 'A', path_id='one'), edit('b', 1, 1, 'C', path_id='one')
    with pytest.raises(ValueError, match='ambiguous edit order'):
        reconstruct([a, b], window)
    assert reconstruct([replace(a, operation_order=1), replace(b, operation_order=0)], window)[0] == 'GCAT'
    for policy, reason in [(MatchingPolicy(max_representations=1), 'representations_cap'),
                           (MatchingPolicy(max_pairs=1), 'pairs_cap'), (MatchingPolicy(max_response_bytes=100), 'response_bytes_cap')]:
        result = match_edits([a], [replace(b, source='assembly'), replace(b, observation_id='c', source='assembly')], policy=policy)
        assert not result['search_complete'] and reason in result['reasons']


def test_shared_difference_adapter_never_uses_preview_as_full_sequence():
    from services.differences.matching import edit_from_difference
    from services.differences.model import Difference, Geometry, Sequence, Span
    payload = Difference('difference', 1, 'assembly', 'reference-content',
        Geometry(Span('chrT', 1, 1), 100, 'insertion'), Sequence('partial', 100, 'A' * 60), ('observation',)).payload()
    adapted = edit_from_difference(payload)
    assert adapted.alt is None and not adapted.sequence_complete
    assert edit_from_difference(payload, full_alternate='A' * 100).sequence_complete


def test_legacy_candidate_adapter_indexes_distant_clusters(monkeypatch):
    import services.differences.matching as matching
    from services.lift.differences import annotate_read_evidence
    original, calls = matching.candidate_relation, []
    def counted(*args):
        calls.append(1)
        return original(*args)
    monkeypatch.setattr(matching, 'candidate_relation', counted)
    items = [dict(id=f'assembly-{i}', kind='insertion', t_start=i * 10000, t_end=i * 10000, ref_bp=0, alt_bp=100) for i in range(200)]
    clusters = [dict(t='I', ref=i * 10000, len=100) for i in range(200)]
    assert annotate_read_evidence(items, clusters) == []
    assert len(calls) == 200  # independent operation-count oracle, not timing
    assert all(item['equivalence_links'][0]['relation'] == 'candidate' for item in items)


def test_novelty_requires_every_comparison_gate_and_candidate_resolution():
    complete = ComparisonScope(("assembly",), ("1", "2"), True, True, True, True, True, True)
    assert novelty([], complete)["status"] == "novel_relative_to_assembly"
    assert novelty([], ComparisonScope())["status"] == "reads_only"
    for field in ("discovery_complete", "correspondence_complete", "sequence_complete", "representations_complete", "search_complete", "bubbles_resolved"):
        assert novelty([], replace(complete, **{field: False}))["status"] == "unassessed"
    assert novelty([{"relation": "candidate"}], complete)["status"] == "unassessed"
    assert novelty([{"relation": "exact"}], complete)["status"] == "assembly_equivalent"
    assert novelty([{"relation": "approximate"}], complete)["status"] == "assembly_supported_approximate"


def test_held_out_candidate_controls_separate_geometry_yield_from_exact_precision():
    # Seed and cases are disjoint from the measured-shape examples above. Direct
    # strings provide truth; equal geometry negatives deliberately all nominate.
    rng = random.Random(74193)
    exact, distinct, nominated = 0, 0, 0
    for _ in range(30):
        repeat = "".join(rng.choice("AT") for _ in range(rng.randint(2, 8)))
        reference = "C" + repeat * 40 + "G"
        window = ReferenceWindow("reference-content", "chrT", 0, reference, len(reference))
        a = edit("read", 1, 1, repeat)
        shift = len(repeat) * rng.randint(10, 30)
        b = edit("assembly", 1 + shift, 1 + shift, repeat, source="assembly")
        positive = match_edits([a], [b], window_provider=lambda *args: window)
        exact += sum(l["relation"] == "exact" for l in positive["links"])
        nominated += bool(positive["links"])
        negative = replace(b, start=1, end=1, alt="G" * len(repeat))
        control = match_edits([a], [negative], window_provider=lambda *args: window)
        assert control["links"]  # same-size geometry is deliberately permissive
        distinct += sum(l["relation"] == "exact" for l in control["links"])
    assert (exact, distinct, nominated) == (30, 0, 30)


@pytest.mark.parametrize("policy", [MatchingPolicy(anchor_bp=100), MatchingPolicy(anchor_fraction=1.2),
                                    MatchingPolicy(broad_anchor_bp=150), MatchingPolicy(broad_anchor_fraction=1.5)])
def test_indexes_cover_exhaustive_candidate_policy_oracle(policy):
    from services.lift.differences import annotate_read_evidence
    left = edit("left", 200, 200, length=100)
    right = [edit(f"right-{i}", i, i, length=100, source="assembly") for i in range(0, 401, 25)]
    expected = {r.observation_id for r in right if candidate_relation(left, r, policy)}
    result = match_edits([left], right, policy=policy)
    assert {link["endpoints"][1][0] for link in result["links"]} == expected
    items = [dict(id="assembly", kind="insertion", t_start=200, t_end=200, ref_bp=0, alt_bp=100)]
    clusters = [dict(t="I", ref=r.start, len=100) for r in right]
    annotate_read_evidence(items, clusters, matching_policy=policy)
    assert {right[link["cluster"]].observation_id for link in items[0]["read_candidates"]} == expected


def test_singletons_from_both_sides_survive_compound_representation_cap():
    left = [edit(f"left-{i}", i * 10 + 1, i * 10 + 1, length=100, path_id="path") for i in range(20)]
    right = [edit("right", 1, 1, length=100, source="assembly")]
    result = match_edits(left, right, policy=MatchingPolicy(max_representations=25))
    assert any(link["endpoints"] == (("left-0",), ("right",)) for link in result["links"])
    assert not result["search_complete"] and "representations_cap" in result["reasons"]


def test_distant_variants_are_outside_compound_scope_not_a_truncated_search():
    left = [edit("a", 1000, 1000, length=100, path_id="path"),
            edit("b", 11001, 11001, length=100, path_id="path")]
    result = match_edits(left, [])
    assert result["search_complete"] and result["reasons"] == []
    scope = ComparisonScope(("assembly",), ("1",), True, True, True, True, result["search_complete"], True)
    assert novelty(result["links"], scope)["status"] == "novel_relative_to_assembly"


def test_large_reference_halo_does_not_spend_compound_span_budget():
    window = ReferenceWindow("reference-content", "chrT", 0, "G" + "A" * 14998 + "T", 15000)
    a = edit("a", 100, 100, "C", path_id="path")
    assert reconstruct([a], window)[0] == window.sequence[:100] + "C" + window.sequence[100:]
    b = edit("b", 200, 200, "C", path_id="path")
    assert reconstruct([a, b], window)[0].count("C") == 2
    with pytest.raises(ResourceResult, match="compound_window"):
        reconstruct([a, replace(b, start=14000, end=14000)], window)


@pytest.mark.parametrize("with_reference", [False, True])
def test_unordered_coincident_insertions_never_emit_compounds(with_reference):
    members = [edit("a", 1, 1, "A" * 50, path_id="path"), edit("b", 1, 1, "C" * 50, path_id="path")]
    whole = edit("whole", 1, 1, "A" * 50 + "C" * 50, source="assembly")
    window = ReferenceWindow("reference-content", "chrT", 0, "GT", 2)
    result = match_edits(members, [whole], window_provider=(lambda *args: window) if with_reference else None)
    assert result["compounds"] == []
    assert not result["links"]
    assert not result["search_complete"]
    ordered = [replace(e, operation_order=i) for i, e in enumerate(members)]
    valid = match_edits(ordered, [whole], window_provider=(lambda *args: window) if with_reference else None)
    assert valid["compounds"] and valid["links"]


def test_retained_bridge_does_not_hide_compound_insertion_candidate():
    reference = "G" + "A" * 399 + "T"
    window = ReferenceWindow("reference-content", "chrT", 0, reference, len(reference))
    members = [edit("a", 100, 100, "A" * 150, path_id="path"), edit("b", 200, 200, "A" * 150, path_id="path")]
    whole = edit("whole", 100, 100, "A" * 300, source="assembly")
    # Independently constructed haplotypes retain the 100-base reference bridge.
    assert reference[:100] + "A" * 150 + reference[100:200] + "A" * 150 + reference[200:] == reference[:100] + "A" * 300 + reference[100:]
    candidate = match_edits(members, [whole])
    assert any(link["endpoints"][0] == ("a", "b") for link in candidate["links"])
    exact = match_edits(members, [whole], window_provider=lambda *args: window)
    assert any(link["relation"] == "exact" and link["endpoints"][0] == ("a", "b") for link in exact["links"])


def test_normalization_obeys_deadline_before_pair_enumeration(monkeypatch):
    import services.differences.matching as matching
    ticks = [0.]
    monkeypatch.setattr(matching.time, "monotonic", lambda: ticks[0])
    reference = "G" + "A" * 9998 + "T"
    window = ReferenceWindow("reference-content", "chrT", 0, reference, len(reference))
    calls = []
    def provider(*args):
        calls.append(args)
        ticks[0] += .02
        return window
    result = match_edits([edit("left", 100, 100, "A")],
                         [edit(f"right-{i}", 100 + i, 100 + i, "A") for i in range(80)],
                         window_provider=provider, policy=MatchingPolicy(deadline_s=.01))
    assert not result["search_complete"] and "deadline" in result["reasons"]
    assert len(calls) == 1


def test_normalization_checks_deadline_inside_repeat_walk(monkeypatch):
    import services.differences.matching as matching
    ticks = [0.]
    monkeypatch.setattr(matching.time, "monotonic", lambda: ticks[0])
    def checkpoint():
        ticks[0] += .001
    monkeypatch.setattr(matching, "checkpoint", checkpoint)
    window = ReferenceWindow("reference-content", "chrT", 0, "G" + "A" * 9998 + "T", 10000)
    result = match_edits([edit("left", 100, 100, "A")], [edit("right", 200, 200, "A")],
                         window_provider=lambda *args: window, policy=MatchingPolicy(deadline_s=.01))
    assert not result["search_complete"] and "deadline" in result["reasons"]
    assert result["explored"]["pairs"] == 0


def test_invalid_common_reconstruction_window_never_emits_a_link():
    window = ReferenceWindow("reference-content", "chrT", 0, "G" * 100 + "T" * 100, 200)
    calls = []
    def provider(*args):
        calls.append(args)
        # Individual normalizations succeed; the common comparison is invalid.
        return window if len(calls) <= 2 else ReferenceWindow("reference-content", "chrT", 150, "T" * 50, 200)
    result = match_edits([edit("a", 100, 100, "A" * 100)], [edit("b", 100, 100, "A" * 100)], window_provider=provider)
    assert result["links"] == [] and not result["search_complete"]
    assert "unassessed_representation: overlap or missing reference halo" in result["reasons"]
