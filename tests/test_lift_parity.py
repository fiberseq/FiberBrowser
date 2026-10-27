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


def test_strand_status():
    assert lp.strand_status(place(0, 1), place(0, 1)) == "absent"
    assert lp.strand_status(dict(place(0, 1), strand="CT"), dict(place(0, 1), strand="CT")) == "same"
    assert lp.strand_status(dict(place(0, 1), strand="CT", minus_chain=True),
                            dict(place(0, 1), strand="GA")) == "frame_flip"
    assert lp.strand_status(dict(place(0, 1), strand="CT"), dict(place(0, 1), strand="GA")) == "differs"
    assert lp.strand_status(dict(place(0, 1), strand="CT", strand_inferred=True), place(0, 1)) == "inferred"


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


def test_deam_read_from_md_stays_out_of_the_verdict():
    rec = {"key": ("q", "c", 1), "live": [place(0, 10, points={"deam": [3]})], "native": [place(0, 10)]}
    res = lp.summarize([rec], deam_from_md=True)
    assert res["points"]["deam"]["records_deam_from_md"] == 1
    assert res["counts"]["records_identical_points"] == 1
    strict = lp.summarize([rec], deam_from_md=False)
    assert strict["counts"]["records_identical_points"] == 0


def test_differing_m6a_fails():
    rec = {"key": ("q", "c", 1), "live": [place(0, 10, points={"methyl_m6a": [3, 4]})],
           "native": [place(0, 10, points={"methyl_m6a": [3]})]}
    res = _result([rec])
    assert res["points"]["methyl_m6a"]["live_only"] == 1
    assert "points differ" in lp.verdict(res)
