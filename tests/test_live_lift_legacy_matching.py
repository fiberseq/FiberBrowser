"""Legacy migration links are many-to-many candidates, with no novelty claim."""
from services.lift.differences import annotate_read_evidence


def assembly(p=1000, r=0, a=100, hap="MAT", kind=None):
    return dict(id=f"{hap}:{p}:{r}:{a}", hap_label=hap, t_start=p, t_end=p + r,
                ref_bp=r, alt_bp=a, kind=kind or ("replacement" if r and a else "deletion" if r else "insertion"))


def test_all_clusters_link_to_each_compatible_phased_occurrence():
    # The supplemental review's greedy probe: cluster 1 used to become novel.
    items = [assembly(), assembly(hap="PAT")]
    clusters = [dict(t="I", ref=1000, len=100, members={"A", "B"}), dict(t="I", ref=1001, len=100, members={"A", "C"})]
    assert annotate_read_evidence(items, clusters) == []
    for item in items:
        assert [c["cluster"] for c in item["read_candidates"]] == [0, 1]
        assert all(c["relation"] == "candidate" and c["method"] == "geometry_only" and c["sequence_comparison"] == "unassessed" for c in item["read_candidates"])
        assert item["read_support"] == dict(cluster=0, carriers=2)  # legacy pointer, not a sum
    # Reusing an item cannot leave stale links/support behind.
    annotate_read_evidence(items, [])
    assert all("read_support" not in item and "read_candidates" not in item for item in items)


def test_replacement_candidates_preserve_both_spans_and_uncertainty():
    item = assembly(1000, 1733, 1)
    cluster = dict(t="D", ref=980, len=1732, ref_len=1732, alt_len=0, uncertainty=[980, 1000])
    assert annotate_read_evidence([item], [cluster]) == []
    link, = item["read_candidates"]
    assert link["assembly_span"] == dict(start=1000, end=2733, ref_bp=1733, alt_bp=1)
    assert link["read_span"] == dict(start=980, end=2712, ref_bp=1732, alt_bp=0)
    assert link["uncertainty"] == [980, 1000]
    assert annotate_read_evidence([assembly(1000, 90, 2)], [dict(t="D", ref=1007, len=88)]) == []


def test_independent_span_and_both_endpoint_negative_controls():
    # A matching net delta/maximum span cannot erase a substantial alternate.
    clusters = [dict(t="D", ref=1000, len=100)]
    assert len(annotate_read_evidence([assembly(1000, 100, 100)], clusters)) == 1
    assert len(annotate_read_evidence([assembly(1000, 200, 100)], clusters)) == 1
    assert len(annotate_read_evidence([assembly(1000, 1500, 0)], [dict(t="D", ref=1000, len=1200)])) == 1
    assert len(annotate_read_evidence([assembly(1000, 0, 100)], clusters)) == 1


def test_holes_and_bubbles_leave_unmatched_events_unassessed():
    items = [assembly(900, 400, 0, kind="no_correspondence"), assembly(900, 400, 400, kind="aligned_bubble")]
    unmatched, = annotate_read_evidence(items, [dict(t="D", ref=1000, len=100, members={"read"})])
    assert unmatched["source"] == "reads" and "members" not in unmatched
    assert unmatched["novelty"] == "unassessed"
    assert unmatched["novelty_reasons"] == ["aligned_bubble", "incomplete_assembly_comparison", "no_correspondence"]
    assert not any("read_candidates" in item for item in items)
    ordinary, = annotate_read_evidence([], [dict(t="I", ref=1000, len=100)])
    assert ordinary["novelty_reasons"] == ["incomplete_assembly_comparison"]


def test_compound_review_control_stays_unassessed_without_reconstruction():
    reference = "A" * 100 + "C" * 50 + "G" * 15 + "T" * 50 + "A" * 100
    assert reference[:100] + reference[150:165] + reference[215:] == reference[:100] + "G" * 15 + reference[215:]
    item = assembly(100, 115, 15)
    unmatched = annotate_read_evidence([item], [dict(t="D", ref=100, len=50), dict(t="D", ref=165, len=50)])
    assert len(unmatched) == 2 and all(c["novelty"] == "unassessed" for c in unmatched)
    assert "read_candidates" not in item
