"""scripts/lift_parity.py: the pure comparison and classification functions on
synthetic placements (no BAMs, no graphlift binaries)."""
import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "lift_parity", Path(__file__).resolve().parents[1] / "scripts" / "lift_parity.py")
lp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(lp)


def place(start, end, calls=None, points=None, *, contig="chr3", orientation="forward", **extra):
    return {"contig": contig, "start": start, "end": end, "orientation": orientation, "strand": None,
            "calls": calls or {}, "points": points or {}, **extra}


# ── parsing ──────────────────────────────────────────────────────────────────

def test_parse_region_is_one_based_inclusive_with_commas():
    assert lp.parse_region("chr3:128,590,001-128,770,000") == ("chr3", 128590000, 128770000)
    with pytest.raises(ValueError):
        lp.parse_region("chr3")


def test_parse_yp_gives_zero_based_start_and_strand():
    assert lp.parse_yp("chr3_MATERNAL:131136541:-") == ("chr3_MATERNAL", 131136540, "-")
    assert lp.parse_yp("chrUn:x:y:10:+") == ("chrUn:x:y", 9, "+")
    assert lp.parse_yp(None) is None


# ── spans ────────────────────────────────────────────────────────────────────

def test_merge_spans_joins_touching_and_drops_zero_width():
    assert lp.merge_spans([[5, 9], [0, 5], [12, 12], [10, 11]]) == [[0, 9], [10, 11]]


def test_subtract_spans():
    assert lp.subtract_spans([[0, 10]], [[2, 3], [5, 7]]) == [[0, 2], [3, 5], [7, 10]]
    assert lp.subtract_spans([[0, 10]], [[0, 10]]) == []


# ── classify_call ────────────────────────────────────────────────────────────

def test_identical_call():
    assert lp.classify_call([[10, 50]], [[10, 50]]) == {"raw": "identical", "bucket": "identical",
                                                       "cause": None, "bp": 0}


def test_parts_touching_at_an_insertion_badge_have_the_same_bases():
    res = lp.classify_call([[10, 30], [30, 50]], [[10, 50]], insertions=[30])
    assert (res["raw"], res["bucket"], res["cause"]) == ("same_bases", "identical", "insertion_split")


def test_connector_hole_is_within_10bp_when_small_and_different_when_large():
    small = lp.classify_call([[10, 30], [31, 50]], [[10, 50]], connectors=[[30, 31]])
    assert (small["bucket"], small["cause"], small["bp"], small["holes"]) == ("within_10bp", "connector_hole", 1, [1])
    large = lp.classify_call([[10, 30], [48, 70]], [[10, 70]], connectors=[[30, 48]])
    assert (large["bucket"], large["cause"], large["holes"]) == ("different", "connector_hole", [18])


def test_missing_bases_outside_connectors_are_not_a_connector_hole():
    res = lp.classify_call([[10, 30], [31, 50]], [[10, 50]], connectors=[])
    assert res["cause"] == "other"


def test_call_ending_inside_a_target_insertion_gets_one_base_more_on_the_lifted_record():
    res = lp.classify_call([[100, 184]], [[100, 185]], insertions=[184])
    assert (res["bucket"], res["cause"], res["bp"]) == ("within_10bp", "insertion_end_base", 1)


def test_call_inside_a_target_insertion_is_a_one_base_stub_on_the_lifted_record():
    res = lp.classify_call([], [[390, 391]], insertions=[390])
    assert (res["bucket"], res["cause"]) == ("different", "insertion_stub")
    elsewhere = lp.classify_call([], [[500, 501]], insertions=[390])
    assert elsewhere["cause"] == "native_only"


def test_lifted_record_cut_inside_a_call_is_a_native_hole():
    res = lp.classify_call([[100, 200]], [[100, 150], [151, 200]])
    assert (res["bucket"], res["cause"], res["bp"]) == ("within_10bp", "native_hole", 1)


def test_one_side_only_calls_and_markers():
    assert lp.classify_call([[5, 9]], [])["cause"] == "live_only"
    assert lp.classify_call([], [[5, 90]])["cause"] == "native_only"
    assert lp.classify_call([[7, 7]], [])["cause"] == "insertion_marker"
    assert lp.classify_call([[7, 7]], [[7, 7]])["bucket"] == "identical"


def test_within_10bp_needs_close_ends_and_a_small_difference():
    assert lp.classify_call([[100, 200]], [[103, 205]])["bucket"] == "within_10bp"
    assert lp.classify_call([[100, 200]], [[100, 215]])["bucket"] == "different"


# ── placements ───────────────────────────────────────────────────────────────

def test_pair_placements_in_order_or_by_overlap():
    live = [place(500, 900), place(0, 100)]
    native = [place(0, 100), place(500, 900)]
    assert lp.pair_placements(live, native) == [(1, 0), (0, 1)]
    pairs = lp.pair_placements([place(0, 900)], [place(0, 100), place(500, 900)])
    assert (0, 1) in pairs and (None, 0) in pairs


def test_split_blocks_cuts_a_row_at_a_g_split_target_gap():
    p = place(0, 50_000, {"layer:nuc": {"MA0:1": [[100, 200]], "MA0:2": [[40_100, 40_200]]}},
              {"methyl_m6a": [150, 40_150]}, segments=[[0, 1_000], [40_000, 50_000]],
              connectors=[[1_000, 40_000]], insertions=[], minus_chain=False)
    a, b = lp.split_blocks(p, 10_000)
    assert (a["start"], a["end"], b["start"], b["end"]) == (0, 1_000, 40_000, 50_000)
    assert a["calls"] == {"layer:nuc": {"MA0:1": [[100, 200]]}}
    assert b["points"] == {"methyl_m6a": [40_150]}
    assert lp.split_blocks(dict(p, segments=[[0, 1_000], [5_000, 50_000]]), 10_000) == [
        dict(p, segments=[[0, 1_000], [5_000, 50_000]])]


def test_union_placements_compares_a_call_cut_by_a_split_whole():
    live = [place(0, 100, {"fire": {"as:1": [[50, 100]]}}), place(200, 300, {"fire": {"as:1": [[200, 220]]}})]
    native = [place(0, 100, {"fire": {"as:1": [[50, 100], [200, 220]]}})]
    res = lp.compare_calls(lp.union_placements(live), lp.union_placements(native))
    assert [(c["call"], c["bucket"]) for c in res] == [("as:1", "identical")]


def test_strand_status_compares_the_molecule_frame():
    assert lp.strand_status(place(0, 1), place(0, 1)) == "absent"
    assert lp.strand_status(dict(place(0, 1), strand="CT"), dict(place(0, 1), strand="CT")) == "same"
    assert lp.strand_status(dict(place(0, 1), strand="CT"), dict(place(0, 1), strand="GA")) == "differs"
    assert lp.strand_status(dict(place(0, 1), strand="CT", strand_inferred=True), place(0, 1)) == "inferred"


def test_correct_st_swap_on_a_minus_chain_is_the_same_strand():
    # fiberhmm-lift swapped st to GA on the reversed record; the loader reads it back as CT (molecule frame).
    rec = {"key": ("q", "c", 1), "live": [dict(place(0, 10), strand="CT", minus_chain=True)],
           "native": [dict(place(0, 10), strand="CT")]}
    res = _result([rec])
    assert res["strand"]["same"] == 1
    assert lp.verdict(res) == "PASS"


def test_missing_st_swap_on_a_minus_chain_is_a_difference():
    # st left CT on the reversed record: the loader's molecule frame gives GA.
    rec = {"key": ("q", "c", 1), "live": [dict(place(0, 10), strand="CT", minus_chain=True)],
           "native": [dict(place(0, 10), strand="GA")]}
    res = _result([rec])
    assert res["strand"]["differs_on_minus_chain"] == 1
    assert "st differs on 1 placements" in lp.verdict(res)


# ── call pairing ─────────────────────────────────────────────────────────────

def test_pair_calls_by_greatest_overlap_not_by_id():
    live = {"MA0:0": [[1100, 1200]], "MA0:1": [[1700, 1800]], "MA0:2": [[3000, 3010]]}
    native = {"MA0:1": [[1100, 1150], [1151, 1200]], "MA0:0": [[1700, 1801]], "x": [[5000, 5001]]}
    assert lp.pair_calls(live, native) == [("MA0:0", "MA0:1"), ("MA0:1", "MA0:0"), ("MA0:2", None), (None, "x")]


def test_pair_calls_takes_a_marker_as_its_next_base_and_breaks_ties_by_order():
    assert lp.pair_calls({"a": [[390, 390]]}, {"b": [[390, 391]]}) == [("a", "b")]
    # One live call overlapping two native calls equally: the first in target order wins.
    assert lp.pair_calls({"a": [[0, 20]]}, {"n1": [[0, 10]], "n2": [[10, 20]]}) == [("a", "n1"), (None, "n2")]


def test_reverse_legacy_record_with_swapped_ids_and_identical_intervals_passes():
    # A frame conversion re-sorted a reverse record's legacy MA calls: the ids swap, the intervals don't.
    rec = {"key": ("q", "chr3_MATERNAL", 10),
           "live": [place(1000, 2000, {"layer:nuc": {"MA0:0": [[1100, 1200]], "MA0:1": [[1700, 1800]]}},
                          orientation="reverse", connectors=[], insertions=[])],
           "native": [place(1000, 2000, {"layer:nuc": {"MA0:1": [[1100, 1200]], "MA0:0": [[1700, 1800]]}},
                            orientation="reverse")]}
    res = _result([rec])
    assert res["record_calls"]["layer:nuc"] == {"identical": 2}
    assert res["calls"]["layer:nuc"]["paired_ids_differ"] == 2
    assert lp.verdict(res) == "PASS"


# ── join ─────────────────────────────────────────────────────────────────────

def test_ambiguous_source_keys_are_never_compared():
    # Two distinct records share QNAME, contig and start; the lifted side swapped their calls. Unioned per key they
    # would compare identical and pass.
    key = ("q", "chr3_MATERNAL", 10)
    live_by = {key: [place(1000, 2000, {"intervals": {"ns:0": [[1100, 1200]]}}),
                     place(1000, 2000, {"intervals": {"ns:0": [[1500, 1600]]}})]}
    native_by = {key: [place(1000, 2000, {"intervals": {"ns:0": [[1500, 1600]]}}),
                       place(1000, 2000, {"intervals": {"ns:0": [[1100, 1200]]}})]}
    unsafe, _one, _edge, _amb = lp.join_records(live_by, native_by)
    assert lp.verdict(_result(unsafe)) == "PASS"  # the hazard: what an unguarded join would report
    ambiguous = lp.find_ambiguous({key: {"sha1:0", "sha2:0"}}, {})
    assert ambiguous == {key}
    assert lp.find_ambiguous({key: {"sha1:0"}}, {key: 2}) == {key}
    assert lp.find_ambiguous({key: {"sha1:0"}}, {key: 1}) == set()
    records, one_side, n_edge, n_ambiguous = lp.join_records(live_by, native_by, ambiguous=ambiguous)
    assert (records, one_side, n_edge, n_ambiguous) == ([], [], 0, 1)
    res = _result(records)
    res["join"]["ambiguous_source_keys"] = n_ambiguous
    assert "1 ambiguous source keys" in lp.verdict(res)


def test_join_records_counts_edges_and_one_side_keys():
    a, b, c = ("a", "c", 1), ("b", "c", 2), ("e", "c", 3)
    records, one_side, n_edge, n_ambiguous = lp.join_records(
        {a: [place(0, 1)], b: [place(0, 1)], c: [place(0, 1)]}, {a: [place(0, 1)], c: [place(0, 1)]}, edge={c})
    assert [r["key"] for r in records] == [a]
    assert one_side == [(b, "live_only")] and (n_edge, n_ambiguous) == (1, 0)


# ── summarize and verdict ────────────────────────────────────────────────────

def _result(records, one_side=()):
    out = lp.summarize(records)
    out["join"] = {"one_side_only": list(one_side)}
    return out


def test_identical_records_pass():
    rec = {"key": ("q", "chr3_MATERNAL", 10),
           "live": [place(0, 100, {"layer:nuc": {"MA0:0": [[0, 40], [40, 90]]}}, {"methyl_m6a": [5, 60]},
                          connectors=[], insertions=[40])],
           "native": [place(0, 100, {"layer:nuc": {"MA0:0": [[0, 90]]}}, {"methyl_m6a": [5, 60]})]}
    res = _result([rec])
    assert res["counts"]["records_identical"] == 1
    assert res["calls"]["layer:nuc"]["raw_same_bases"] == 1
    assert lp.verdict(res) == "PASS"


def test_connector_hole_fails_and_one_side_records_fail():
    rec = {"key": ("q", "chr3_MATERNAL", 10),
           "live": [place(0, 100, {"layer:nuc": {"MA0:0": [[0, 40], [41, 90]]}}, connectors=[[40, 41]])],
           "native": [place(0, 100, {"layer:nuc": {"MA0:0": [[0, 90]]}})]}
    res = _result([rec])
    assert res["counts"]["records_identical_calls"] == 0
    assert res["connector_holes"]["layer:nuc"]["holes_1bp"] == 1
    assert lp.verdict(res).startswith("FAIL: call bases differ on 1 of 1 records")
    ok = {"key": ("q", "c", 1), "live": [place(0, 10)], "native": [place(0, 10)]}
    assert "on one side only" in lp.verdict(_result([ok], [{"side": "native_only", "cause": "x", "n": 2}]))


def test_a_truncated_live_load_fails():
    ok = {"key": ("q", "c", 1), "live": [place(0, 10)], "native": [place(0, 10)]}
    res = _result([ok])
    res["live"] = {"load_counts": {"truncated": True}}
    assert "truncated" in lp.verdict(res)


def test_deam_read_from_reference_mismatches_stays_out_of_the_verdict():
    rec = {"key": ("q", "c", 1), "live": [place(0, 10, points={"deam": [(3, 1)]}, deam_source="mismatch")],
           "native": [place(0, 10)]}
    res = lp.summarize([rec])
    assert res["points"]["deam"]["records_deam_from_md"] == 1
    assert res["counts"]["records_identical_points"] == 1
    unknown = {"key": ("q", "c", 1), "live": [place(0, 10, points={"deam": [(3, 1)]})], "native": [place(0, 10)]}
    assert lp.summarize([unknown])["counts"]["records_identical_points"] == 0


def test_daf_deam_from_iupac_or_mm_is_always_compared():
    # DAF records carry no m6A/5mC and the lifted BAM has no MD: a Y at 10 vs 11 is still a real difference.
    for source in ("iupac", "mm"):
        rec = {"key": ("q", "c", 1), "live": [place(0, 100, points={"deam": [(10, 1)]}, deam_source=source)],
               "native": [place(0, 100, points={"deam": [(11, 1)]}, deam_source=source)]}
        res = _result([rec])
        assert res["points"]["deam"]["records_differs"] == 1
        assert "points differ" in lp.verdict(res)
    mixed = {"key": ("q", "c", 1), "live": [place(0, 100, points={"deam": [(10, 1)]}, deam_source="mismatch")],
             "native": [place(0, 100, points={"deam": [(11, 1)]}, deam_source="iupac")]}
    assert not lp.deam_exempt(mixed["live"], mixed["native"])


def _live_row(deam, minus=False):
    return {"id": "q", "reference_start": 0, "reference_end": 100, "alignment_orientation": "forward",
            "intervals": [], "deam": deam,
            "live_lift": {"calls": {}, "connectors": [], "badges": [],
                          "segments": [[0, 100, 1, "-" if minus else "+", True]]}}


def _native_row(deam, flipped=False, layers=None, fire=None, calls=None):
    # Yp names the source strand; the record is forward here, so a '-' source means the lift reversed it.
    return {"id": "q", "reference_start": 0, "reference_end": 100, "alignment_orientation": "forward",
            "lift": {"from": "c:2:-" if flipped else "c:2:+"}, "intervals": [], "deam": deam,
            "layers": layers or {}, "fire": fire or [], "_fiberbrowser_calls": calls or {}}


def test_deam_channel_is_compared_on_a_plus_chain():
    live = lp.placement(_live_row([[10, 1]]), 0, True, "c")
    native = lp.placement(_native_row([[10, 0]]), 0, False, "c")
    assert live["points"]["deam"] == [(10, 1)] and native["points"]["deam"] == [(10, 0)]
    res = _result([{"key": ("q", "c", 1), "live": [dict(live, deam_source="iupac")],
                    "native": [dict(native, deam_source="iupac")]}])
    assert "points differ" in lp.verdict(res)


def test_deam_channel_on_a_minus_chain_compares_in_the_molecule_frame():
    # The reversed lifted record decodes C->T (Y, 1) as G->A (R, 0) in the target frame: equal once swapped back.
    live = lp.placement(_live_row([[10, 1]], minus=True), 0, True, "c")
    swapped = lp.placement(_native_row([[10, 0]], flipped=True), 0, False, "c")
    assert swapped["lift_flipped"] and swapped["points"]["deam"] == [(10, 1)]
    ok = _result([{"key": ("q", "c", 1), "live": [dict(live, deam_source="iupac")],
                   "native": [dict(swapped, deam_source="iupac")]}])
    assert lp.verdict(ok) == "PASS"
    # A channel that did not follow the reversed SEQ is a difference.
    unswapped = lp.placement(_native_row([[10, 1]], flipped=True), 0, False, "c")
    bad = _result([{"key": ("q", "c", 1), "live": [dict(live, deam_source="iupac")],
                    "native": [dict(unswapped, deam_source="iupac")]}])
    assert "points differ" in lp.verdict(bad)


def test_same_geometry_with_a_different_state_byte_is_a_payload_difference():
    # nfrvar: state byte 1 = open, 2 = closed (same interval, same annotation name).
    def live_row(state):
        row = _live_row([])
        row["layers"] = {"nfrvar": {"intervals": [[10, 60, 50]], "quality_names": ["state", "q"],
                                    "qualities": [[state], [255]], "annotation_names": ["nfr"]}}
        row["live_lift"]["calls"] = {"layer:nfrvar": ["MA3:0"]}
        return row
    native = _native_row([], layers={"nfrvar": {"intervals": [[10, 60, 50]], "quality_names": ["state", "q"],
                                                "qualities": [[2], [255]], "annotation_names": ["nfr"],
                                                "_fiberbrowser_calls": [["MA3:0", 0, 50]]}})
    nat = lp.placement(native, 0, False, "c")
    res = _result([{"key": ("q", "c", 1), "live": [lp.placement(live_row(1), 0, True, "c")], "native": [nat]}])
    assert res["record_calls"]["layer:nfrvar"] == {"different": 1, "payload_differs": 1}
    assert [(x["cause"], x["n"]) for x in res["causes"]] == [("payload", 1)]
    assert "call bases differ" in lp.verdict(res)
    same = _result([{"key": ("q", "c", 1), "live": [lp.placement(live_row(2), 0, True, "c")], "native": [nat]}])
    assert lp.verdict(same) == "PASS"


def test_a_different_fire_score_or_annotation_is_a_payload_difference():
    live = _live_row([])
    live["fire"] = [[10, 40, 128]]
    live["live_lift"]["calls"] = {"fire": ["as:0"]}
    native = _native_row([], fire=[[10, 40, 200]], calls={"fire": [["as:0", 0, 30]]})
    res = _result([{"key": ("q", "c", 1), "live": [lp.placement(live, 0, True, "c")],
                    "native": [lp.placement(native, 0, False, "c")]}])
    assert res["calls"]["fire"]["payload_differs"] == 1 and lp.verdict(res) != "PASS"
    a = place(0, 100, {"layer:x": {"c": [[1, 5]]}}, payloads={"layer:x": {"c": {((4,), (), "CTCF")}}})
    b = place(0, 100, {"layer:x": {"c": [[1, 5]]}}, payloads={"layer:x": {"c": {((4,), (), "YY1")}}})
    assert lp.compare_calls(a, b)[0]["cause"] == "payload"


def test_differing_m6a_fails():
    rec = {"key": ("q", "c", 1), "live": [place(0, 10, points={"methyl_m6a": [3, 4]})],
           "native": [place(0, 10, points={"methyl_m6a": [3]})]}
    res = _result([rec])
    assert res["points"]["methyl_m6a"]["live_only"] == 1
    assert "points differ" in lp.verdict(res)


# ── measured tiling and annotation names (review round 3) ────────────────────

def test_a_gap_across_a_connector_that_live_lift_drops_is_a_difference():
    # Source [0,40) -> target [0,40), source [40,80) -> target [60,100): footprints at [0,10) and [90,100) agree,
    # but only the lifted record holds the accessible gap [10,90), which a scan counts (0/0 vs 1/1 at base 50).
    live = _live_row([])
    live["intervals"] = [[0, 10, 10], [90, 100, 10]]
    live["live_lift"].update(calls={"intervals": ["ns:0", "ns:1"]}, connectors=[[40, 60]])
    native = _native_row([], calls={"intervals": [["ns:0", 0, 10], None, ["ns:1", 70, 80]]})
    native["intervals"] = [[0, 10, 10], [10, 90, -80], [90, 100, 10]]
    res = _result([{"key": ("q", "c", 1), "live": [lp.placement(live, 0, True, "c")],
                    "native": [lp.placement(native, 0, False, "c")]}])
    assert res["record_calls"]["intervals"] == {"identical": 2}
    assert res["record_calls"]["intervals~gap"] == {"different": 1}
    assert [(x["group"], x["cause"]) for x in res["causes"]] == [("intervals~gap", "gap_dropped_at_connector")]
    assert "call bases differ" in lp.verdict(res)


def test_gap_parts_a_connector_separates_compare_as_one_gap():
    live = _live_row([])
    live["intervals"] = [[0, 10, 10], [10, 40, -80], [60, 90, -80], [90, 100, 10]]
    live["live_lift"].update(calls={"intervals": ["ns:0", None, None, "ns:1"]}, connectors=[[40, 60]])
    p = lp.placement(live, 0, True, "c")
    assert p["calls"]["intervals~gap"] == {"<tile>": [[10, 40], [60, 90]]}
    assert lp.tiling_units([[10, 40], [60, 90]], [[10, 90]], [[40, 60]]) == [([[10, 40], [60, 90]], [[10, 90]])]
    # A lifted record's row cut by its own hole still compares as one unit against live lift's row.
    assert lp.tiling_units([[0, 50]], [[0, 20], [21, 50]]) == [([[0, 50]], [[0, 20], [21, 50]])]
    native = _native_row([], calls={"intervals": [["ns:0", 0, 10], None, ["ns:1", 70, 80]]})
    native["intervals"] = [[0, 10, 10], [10, 90, -80], [90, 100, 10]]
    res = lp.compare_calls(p, lp.placement(native, 0, False, "c"))
    gap = [c for c in res if c["group"] == "intervals~gap"]
    assert [(c["cause"], c["bp"]) for c in gap] == [("connector_hole", 20)]


def test_neutral_rows_are_compared_too():
    def neutral(row, span):
        return dict(row, intervals=[[span[0], span[1], 0]])
    same = lp.compare_calls(lp.placement(neutral(_live_row([]), (5, 20)), 0, True, "c"),
                            lp.placement(neutral(_native_row([]), (5, 20)), 0, False, "c"))
    assert [(c["group"], c["bucket"]) for c in same] == [("intervals~neutral", "identical")]
    moved = lp.compare_calls(lp.placement(neutral(_live_row([]), (5, 20)), 0, True, "c"),
                             lp.placement(neutral(_native_row([]), (5, 60)), 0, False, "c"))
    assert [(c["group"], c["bucket"]) for c in moved] == [("intervals~neutral", "different")]


def test_missing_and_empty_annotation_names_are_the_same_payload():
    # MA=100;x.:11-20,71-20 with AN=.,named, split between the calls: the live part keeps the blank entry of a named
    # layer, the lifted record's parser drops an all-blank array.
    live = _live_row([])
    live["layers"] = {"x": {"intervals": [[11, 31, 20]], "annotation_names": [""]}}
    live["live_lift"]["calls"] = {"layer:x": ["MA0:0"]}
    native = _native_row([], layers={"x": {"intervals": [[11, 31, 20]], "_fiberbrowser_calls": [["MA0:0", 11, 31]]}})
    res = _result([{"key": ("q", "c", 1), "live": [lp.placement(live, 0, True, "c")],
                    "native": [lp.placement(native, 0, False, "c")]}])
    assert lp.verdict(res) == "PASS"


def test_a_gap_live_lift_drops_next_to_an_insertion_is_named():
    live = _live_row([])
    live["intervals"] = [[0, 10, 10], [90, 100, 10]]
    live["live_lift"].update(calls={"intervals": ["ns:0", "ns:1"]}, badges=[[50, "source_insertion", 12, 12, "I"]])
    native = _native_row([], calls={"intervals": [["ns:0", 0, 10], None, ["ns:1", 90, 100]]})
    native["intervals"] = [[0, 10, 10], [10, 90, -80], [90, 100, 10]]
    res = lp.compare_calls(lp.placement(live, 0, True, "c"), lp.placement(native, 0, False, "c"))
    assert [(c["group"], c["cause"]) for c in res if c["bucket"] != "identical"] == [
        ("intervals~gap", "gap_dropped_at_insertion")]


def test_a_leading_gap_only_the_lifted_record_holds_is_a_terminal_gap_extent():
    # The decoder ends a hidden terminal gap at the record's first call of any kind (an MSP at [0,10)); live lift
    # rebuilds gaps between footprints only.
    live = _live_row([])
    live["intervals"] = [[40, 60, 20]]
    live["live_lift"]["calls"] = {"intervals": ["ns:0"]}
    native = _native_row([], calls={"intervals": [None, ["ns:0", 40, 60]]})
    native["intervals"] = [[10, 40, -30], [40, 60, 20]]
    res = lp.compare_calls(lp.placement(live, 0, True, "c"), lp.placement(native, 0, False, "c"))
    assert [(c["group"], c["cause"]) for c in res if c["bucket"] != "identical"] == [
        ("intervals~gap", "terminal_gap_extent")]



# ── known categories (lift parity) ───────────────────────────────────────────

def _cut_record(live_badges, events, connectors=()):
    """A call the lifted record cuts at [40, 41) (its event: ``events``) while live lift runs it across."""
    return {"key": ("q", "chr3_MATERNAL", 10),
            "live": [place(0, 100, {"layer:nuc": {"MA0:0": [[0, 90]]}}, connectors=list(connectors),
                           badges=live_badges)],
            "native": [place(0, 100, {"layer:nuc": {"MA0:0": [[0, 40], [41, 90]]}}, sv_events=events)]}


def test_a_cut_at_an_event_mixing_a_map_insertion_and_a_read_deletion_is_a_known_artifact():
    # A 60 bp map insertion at 40 (a live badge) and the read's 1 bp deletion next to it: one event of 60 bp on
    # the lifted CIGAR (I60 D1), so the decoder cuts the D; live lift groups map pieces only.
    rec = _cut_record([[40, 60]], [[("I", 40, 60), ("D", 40, 1)]])
    res = _result([rec])
    assert res["counts"]["records_identical_calls"] == 0
    assert res["counts"]["records_identical_calls_or_known"] == 1
    assert res["known_differences"] == {"decoder_cut_artifact": 1}
    assert lp.verdict(res) == "PASS (known: 1 decoder_cut_artifact)"


def test_a_cut_at_a_map_only_or_read_only_event_is_not_an_artifact():
    # All map pieces (the D is a live connector): live lift should have cut it too.
    rec = _cut_record([], [[("D", 40, 1)]], connectors=[[40, 41]])
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == []
    assert lp.verdict(_result([rec])).startswith("FAIL")
    # All read pieces (no live junction there): live lift's source decode cuts it in its own frame.
    rec = _cut_record([], [[("I", 30, 60), ("D", 40, 1)]])
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == []
    assert lp.verdict(_result([rec])).startswith("FAIL")


def test_a_read_deletion_merged_into_a_map_gap_or_its_insertion_moved_by_one_is_an_artifact():
    # liftbam wrote the read's deleted base into the junction's D (D2 where the connector is 1 bp).
    rec = _cut_record([], [[("D", 40, 2), ("I", 42, 60)]], connectors=[[41, 42]])
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == [[40, 42]]
    # The badge is at 41 (the fragment's end), the lifted I at 40 (the aligned block's end) then D1.
    rec = _cut_record([[41, 60]], [[("I", 40, 60), ("D", 40, 1)]])
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == [[40, 41]]


def test_orphan_supplementaries_are_listed_not_failed():
    ok = {"key": ("q", "c", 1), "live": [place(0, 10)], "native": [place(0, 10)]}
    one_side = [{"side": "live_only", "cause": "orphan_supplementary_dropped", "n": 2}]
    assert lp.verdict(_result([ok], one_side)) == "PASS (known: 2 live_only orphan_supplementary_dropped)"
    assert "on one side only" in lp.verdict(_result([ok], one_side + [{"side": "native_only", "cause": "x", "n": 1}]))


def test_native_options_keep_the_native_terminal_gap_filter():
    # Live lift's source decode skips the filter (compose applies it per lifted record); a native decode of
    # the lifted BAM keeps the caller's threshold.
    lp.scratch_env()
    assert lp.native_options({})["terminal_gap_threshold"] == 500
    assert lp.native_options({"terminal_gap_threshold": 0})["terminal_gap_threshold"] == 0


def test_identical_call_groups_take_the_shortcut_with_the_same_counts():
    calls = {"layer:nuc": {"MA0:0": [[0, 40]], "MA0:1": [[50, 90]]}}
    rec = {"key": ("q", "c", 1), "live": [place(0, 100, calls)], "native": [place(0, 100, calls)]}
    res = _result([rec])
    assert res["calls"]["layer:nuc"] == {"identical": 2, "raw_identical": 2}
    assert res["record_calls"]["layer:nuc"] == {"identical": 2}


def test_a_known_cut_never_excuses_a_payload_difference():
    # Codex review (group B, round 1): the same call cut at a mixed event and carrying another state byte fails.
    rec = _cut_record([[40, 60]], [[("I", 40, 60), ("D", 40, 1)]])
    rec["live"][0]["payloads"] = {"layer:nuc": {"MA0:0": {((), (("state", 1),), None)}}}
    rec["native"][0]["payloads"] = {"layer:nuc": {"MA0:0": {((), (("state", 2),), None)}}}
    assert lp.verdict(_result([rec])).startswith("FAIL")


def test_a_map_deletion_that_cuts_on_its_own_is_not_excused_by_a_read_piece():
    # Codex review (group B, round 1): a 60 bp connector cuts by itself; a 1 bp read insertion in its event
    # excuses nothing, so a live call running across it fails.
    rec = {"key": ("q", "chr3_MATERNAL", 10),
           "live": [place(0, 250, {"layer:nuc": {"MA0:0": [[0, 250]]}}, connectors=[[40, 100]], badges=[])],
           "native": [place(0, 250, {"layer:nuc": {"MA0:0": [[0, 40], [100, 250]]}},
                            sv_events=[[("D", 40, 60), ("I", 105, 1)]])]}
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == []
    assert lp.verdict(_result([rec])).startswith("FAIL")
    # The read's own deleted bases in such an event stay excused (the map cut is live lift's own).
    rec["native"][0]["sv_events"] = [[("D", 40, 60), ("D", 102, 2)]]
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == [[102, 104]]


def test_only_a_verified_orphan_supplementary_is_listed_as_known():
    # Codex review (group B, round 1): a live-only primary with an unrelated unlifted record of its name fails.
    unlifted = {("q", "c2", 20): ("no_projection", True)}
    sup = [place(0, 10, supplementary=True)]
    assert lp.is_orphan_supplementary(("q", "c", 10), sup, unlifted, set())
    assert not lp.is_orphan_supplementary(("q", "c", 10), [place(0, 10, supplementary=False)], unlifted, set())
    assert not lp.is_orphan_supplementary(("q", "c", 10), sup, {("q", "c2", 20): ("no_projection", False)}, set())
    assert not lp.is_orphan_supplementary(("q", "c", 10), sup, unlifted, {"q"})


def test_a_cut_the_source_decode_makes_is_never_excused():
    # Codex review (group B, round 2): the read's own 60 bp deletion (cut in the source frame, so on live lift
    # too) beside a map insertion: an uncut live call fails.
    rec = {"key": ("q", "chr3_MATERNAL", 10),
           "live": [place(0, 300, {"layer:nuc": {"MA0:0": [[10, 200]]}}, connectors=[], badges=[[40, 60]])],
           "native": [place(0, 300, {"layer:nuc": {"MA0:0": [[10, 40], [100, 200]]}},
                            sv_events=[[("I", 40, 60), ("D", 40, 60)]], required_cuts=[[40, 100]])]}
    assert lp.artifact_spans(rec["live"][0], rec["native"][0]) == []
    assert lp.verdict(_result([rec])).startswith("FAIL")


def test_each_connector_of_a_merged_deletion_counts_on_its_own():
    # Codex review (group B, round 2): 40M81D160M where the D is a 60 bp connector, a fully deleted 20 bp
    # fragment and a 1 bp connector. Live lift cuts the 60 bp one only: the rest is the decoder's merging.
    live = place(0, 300, {"layer:nuc": {"MA0:0": [[10, 40], [100, 221]]}},
                 connectors=[[40, 100], [120, 121]], badges=[])
    native = place(0, 300, {"layer:nuc": {"MA0:0": [[10, 40], [121, 221]]}},
                   sv_events=[[("M", 0, 40), ("D", 40, 81), ("M", 121, 160)]])
    assert lp.artifact_spans(live, native) == [[100, 121]]
    rec = {"key": ("q", "c", 1), "live": [live], "native": [native]}
    assert lp.verdict(_result([rec])) == "PASS (known: 1 decoder_cut_artifact)"


def test_required_source_cut_survives_an_unprojected_flank(tmp_path):
    from threading import RLock
    from types import SimpleNamespace
    from live_lift_fixtures import make_record, write_bam
    from services.lift import live_lift as ll

    path = write_bam(tmp_path / 'source.bam',
                     lambda h: [make_record(h, 'q', 'src', 0, '100M60D160M')],
                     contigs=(('src', 1000),))
    pieces = [ll.LiftPiece(0, 0, 40, 0, 40, '+', True, 'H#1', 'src'),
              ll.LiftPiece(0, 40, 260, 100, 320, '+', True, 'H#1', 'src')]
    handle = SimpleNamespace(lock=RLock(), map=SimpleNamespace(
        source_to_target=lambda c, a, b: [p for p in pieces if p.q_start < b and p.q_end > a]))
    rec = {'key': ('q', 'src', 0),
           'live': [place(0, 260, {'layer:nuc': {'MA0:0': [[10, 200]]}}, chains=[0],
                          connectors=[], badges=[[40, 60]])],
           'native': [place(0, 260, {'layer:nuc': {'MA0:0': [[10, 40], [100, 200]]}},
                            sv_events=[[('I', 40, 60), ('D', 40, 60)]])]}
    lp.attach_required_cuts([rec], path, handle, 50)
    assert rec['native'][0]['required_cuts'] == [[40, 100]]
    assert lp.verdict(_result([rec])).startswith('FAIL')
    rec['live'][0]['calls']['layer:nuc']['MA0:0'] = [[10, 40], [100, 200]]
    assert lp.verdict(_result([rec])) == 'PASS'


def test_short_target_gap_does_not_join_records_with_a_large_read_gap():
    p = place(100, 600, {'layer:nuc': {'ns:0': [[150, 250]], 'ns:1': [[450, 550]]}},
              segments=[[100, 300, 0], [400, 600, 1]],
              molecular=[[100, 300, 0, 1], [400, 600, 10200, 1]], connectors=[], insertions=[])
    a, b = lp.split_blocks(p, 10000)
    assert (a['start'], a['end'], b['start'], b['end']) == (100, 300, 400, 600)
    rec = {'key': ('q', 'src', 0), 'live': [a, b],
           'native': [place(100, 300, a['calls']), place(400, 600, b['calls'])]}
    assert lp.verdict(_result([rec])) == 'PASS'


def test_normalization_preserves_modern_record_boundaries_across_chains():
    # Target-sorted segments can be close even when their source order runs backwards on the target.
    p = place(100, 600, segments=[[100, 300, 1], [400, 600, 0]],
              molecular=[[100, 300, 200, 1], [400, 600, 0, 1]])
    assert [(x['start'], x['end']) for x in lp.split_blocks(p, 10000)] == [(100, 300), (400, 600)]


def test_tagged_orphans_join_and_compare_as_records(tmp_path):
    from live_lift_fixtures import make_record, write_bam
    from services.compact_read_loader import build_compact_reads_from_bam

    path = write_bam(tmp_path / 'lifted.bam', lambda h: [
        make_record(h, 'orphan', 'chrT', 100, '100M', flag=2048,
                    tags=[('Yp', 'chrS:11:+'), ('Yo', 1)])], contigs=(('chrT', 1000),))
    (row,) = build_compact_reads_from_bam(path, 'chrT', 0, 1000, include_supplementary=True, spanning_only=False,
                                         hide_terminal_gaps=False)
    assert row['lift']['orphan'] is True
    native = lp.placement(row, 0, False, 'chrT')
    assert native['orphan'] is True
    key = ('orphan', 'chrS', 10)
    live = dict(native, supplementary=True)
    records, one_side, edges, ambiguous = lp.join_records({key: [live]}, {key: [native]})
    assert len(records) == 1 and not one_side and not edges and not ambiguous
    assert not lp.is_orphan_supplementary(key, [live], {('orphan', 'other', 30): ('no_projection', True)}, {'orphan'})
    assert lp.verdict(_result(records)) == 'PASS'
    # Kept orphans are real comparisons: changing their marks fails parity.
    records[0]['native'][0] = dict(native, points={'methyl_m6a': [120]})
    assert lp.verdict(_result(records)).startswith('FAIL')
