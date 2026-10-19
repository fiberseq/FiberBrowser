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
    a = edit("inv", 1, 5, length=4, kind="inversion")  # ACCG -> CGGT
    b = edit("replacement", 1, 5, "CGGT", source="assembly")
    assert reconstruct([a], window)[0] == "ACGGTGTT"
    result = match_edits([a], [b], window_provider=lambda *args: window)
    assert result["links"][0]["relation"] == "exact"
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
    with pytest.raises(ResourceResult, match="compound_window"):
        reconstruct([a], window, MatchingPolicy(max_window_bp=10))


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
