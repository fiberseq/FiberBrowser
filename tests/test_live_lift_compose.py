"""lift_compact_reads through load_lifted_rows on the toy map (DESIGN_LIVE_LIFT.md
§3.4-§3.7): span/point/boundary formulas on both strands, connectors, badges,
the v3.1 rejoin rule, insertion-only calls, edge-quality swaps, MSPs per
segment, SV events, identity components and primary metadata."""
import array

import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll


def _u32(values):
    return array.array("I", values)


def _u8(values):
    return array.array("B", values)


def _records(h):
    a = "A"
    return [
        make_record(h, "plus", MAT, 2500, "3300M", seq=a * 3300,
                    tags=[("ns", _u32([400, 2450, 3000])), ("nl", _u32([200, 200, 200])),
                          ("nq", _u8([10, 20, 30])), ("lq", _u8([1, 2, 3])), ("rq", _u8([4, 5, 6])),
                          ("MM", "A+a,0;"), ("ML", _u8([255])), ("st", "CT")]),
        make_record(h, "minus", MAT, 7200, "150M5I100M", seq=a * 150 + "ACGTA" + a * 100,
                    tags=[("ns", _u32([10, 151, 152])), ("nl", _u32([120, 3, 3])), ("nq", _u8([5, 6, 7])),
                          ("lq", _u8([11, 0, 0])), ("rq", _u8([22, 0, 0])), ("MM", "A+a,4;"), ("ML", _u8([255])),
                          ("st", "GA")]),
        make_record(h, "minus_del", MAT, 7500, "100M60D100M", tags=[("ns", _u32([10])), ("nl", _u32([100]))]),
        make_record(h, "rejoin", MAT, 9150, "300M", tags=[("ns", _u32([100])), ("nl", _u32([100]))]),
        make_record(h, "elsewhere", MAT, 9400, "500M", tags=[("ns", _u32([10])), ("nl", _u32([50]))]),
        make_record(h, "del", MAT, 1000, "500M100D500M", tags=[("ns", _u32([100, 700])), ("nl", _u32([200, 200]))]),
        # A supplementary on MAT whose primary is on PAT (st differs on purpose).
        make_record(h, "split", MAT, 2000, "20S100M", flag=2048,
                    tags=[("ns", _u32([30])), ("nl", _u32([50])), ("st", "CT"), ("SA", f"{PAT},501,+,100M20S,60,0;")]),
        make_record(h, "split", PAT, 500, "100M20S", tags=[("ns", _u32([30])), ("nl", _u32([50])), ("st", "GA"),
                                                         ("SA", f"{MAT},2001,+,20S100M,60,0;")]),
    ]


@pytest.fixture
def toy(tmp_path):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / "map"))
    bam = write_bam(tmp_path / "src.bam", _records)
    return handle, bam


OPTS = dict(include_methylation=True, include_cigar=True, sv_min_len=50, include_sv_seq=True)


def _load(toy, settings=None, haps=None, start=1000, end=9000):
    handle, bam = toy
    return ll.load_lifted_rows(handle, [bam], TARGET, start, end, haplotypes=haps or handle.haplotypes,
                               settings=settings or ll.LiftSettings(), dataset_id="ds", loader_options=dict(OPTS))


def _rows(load, name):
    return [r for r in load.rows if r["id"] == name]


def test_plus_row_connector_badge_and_disconnected_parts(toy):
    load = _load(toy)
    assert load.region_start == 0 and load.region_end == 20_000
    (r,) = _rows(load, "plus")
    ll_ = r["live_lift"]
    assert ll_["segments"] == [[3500, 6710, 0, "+", True]]
    assert ll_["connectors"] == [[4000, 4010]]
    assert ll_["badges"] == [[6010, "source_insertion", 100, 100, "I"]]
    assert r["intervals"] == [[3900, 4000, 200], [4010, 4110, 200], [4110, 5960, -1850], [5960, 6010, 200],
                              [6010, 6060, 200], [6060, 6410, -350], [6410, 6610, 200]]
    # Call ids are immutable; the parts across the 10 bp connector and the 100 bp badge
    # are separate logical groups (call_parts: [part, group] molecular keys).
    assert ll_["calls"]["intervals"] == ["ns:0", "ns:0", None, "ns:1", "ns:1", None, "ns:2"]
    assert ll_["call_parts"]["intervals"] == [[400, 400], [500, 500], None, [2450, 2450], [2600, 2600], None,
                                             [3000, 3000]]
    assert r["qualities"] == [10, 10, 20, 20, 30]
    assert r["methyl_m6a"] == [3500]
    assert (r["reference_start"], r["reference_end"]) == (3500, 6710)
    assert r["alignment_spans"] == [[3500, 4000], [4010, 6710]]
    assert r["alignment_orientation"] == "forward" and r["strand"] == "CT"
    # MSPs inferred per continuous span: never across the connector or the badge.
    msp = r["layers"]["msp"]["intervals"]
    assert [iv[:2] for iv in msp] == [[4110, 5960], [6060, 6410]]
    assert not any(not iv[0] >= 4010 and iv[1] > 4000 for iv in msp)
    nuc = r["layers"]["nuc"]
    assert nuc["quality_names"] == ["nq", "lq", "rq"]
    assert nuc["qualities"] == [[10, 10, 20, 20, 30], [1, 1, 2, 2, 3], [4, 4, 5, 5, 6]]


def test_minus_row_formulas_insertions_and_edge_swaps(toy):
    (r,) = _rows(_load(toy), "minus")
    ll_ = r["live_lift"]
    assert ll_["segments"] == [[13550, 13800, 1, "-", True]]
    assert r["alignment_orientation"] == "reverse"
    assert r["strand"] == "GA"  # the molecule's st: never changed by the flip
    pos = [(iv, cid) for iv, cid in zip(r["intervals"], ll_["calls"]["intervals"]) if iv[2] > 0]
    # Span [7210, 7330) on '-': [T(7329), T(7210)+1) = [13670, 13790).
    # The two insertion-only calls: zero-width markers at B(7350) = 13650, ids kept apart.
    assert pos == [([13650, 13650, 3], "ns:1"), ([13650, 13650, 3], "ns:2"), ([13670, 13790, 120], "ns:0")]
    assert r["qualities"] == [6, 7, 5]
    assert r["cigar"] == [{"type": "I", "pos": 13650, "len": 5, "seq": "TACGT", "source": "reads"}]
    assert r["methyl_m6a"] == [13795]  # T(7204) = 13999 - 204
    nuc = r["layers"]["nuc"]
    assert nuc["intervals"] == [[13670, 13790, 120]]
    assert nuc["qualities"] == [[5], [22], [11]]  # lq/rq swapped on the '-' row


def test_minus_deletion_span_and_sv(toy):
    (r,) = _rows(_load(toy), "minus_del")
    # [7600, 7660) on '-': [T(7659), T(7600)+1) = [13340, 13400).
    assert [e for e in r["sv"] if e["t"] == "D"][0]["ref"] == 13340
    assert [e for e in r["sv"] if e["t"] == "D"][0]["len"] == 60
    assert {"type": "D", "pos": 13340, "len": 60, "source": "reads"} in r["cigar"]


def test_rejoined_call_shares_id_but_never_spans_the_connector(toy):
    (r,) = _rows(_load(toy), "rejoin")
    assert r["live_lift"]["connectors"] == [[8200, 8203]]
    ll_ = r["live_lift"]
    pos = [(iv[:2], cid, part) for iv, cid, part in
           zip(r["intervals"], ll_["calls"]["intervals"], ll_["call_parts"]["intervals"]) if iv[2] > 0]
    # One logical call (same id, same group) drawn as two disconnected parts.
    assert pos == [([8150, 8200], "ns:0", [100, 100]), ([8203, 8253], "ns:0", [150, 100])]
    assert not any(iv[0] < 8203 and iv[1] > 8200 for iv in r["intervals"])
    no_rejoin = _rows(_load(toy, ll.LiftSettings(rejoin_bp=0)), "rejoin")[0]
    assert [c for c in no_rejoin["live_lift"]["calls"]["intervals"] if c] == ["ns:0", "ns:0"]
    assert [p[1] for p in no_rejoin["live_lift"]["call_parts"]["intervals"] if p] == [100, 150]


def test_elsewhere_badge_and_alternative_rows(toy):
    (r,) = _rows(_load(toy), "elsewhere")
    assert r["live_lift"]["badges"] == [[8403, "elsewhere", 400, 400, "R", [TARGET, 1500, 1800]]]
    rows = _rows(_load(toy, ll.LiftSettings(alternatives=True)), "elsewhere")
    assert [(x["live_lift"]["alt"], x["live_lift"]["placement"]) for x in rows] == [(False, "3"), (True, "alt4")]
    assert rows[1]["live_lift"]["segments"] == [[1500, 1800, 4, "+", False]]
    # cohort_alternatives alone also selects them (union rule).
    assert len(_rows(_load(toy, ll.LiftSettings(cohort_alternatives="include")), "elsewhere")) == 2


def test_sv_deletion_on_plus_and_no_connectors_in_sv(toy):
    load = _load(toy)
    (r,) = _rows(load, "del")
    assert [(e["t"], e["ref"], e["len"]) for e in r["sv"]] == [("D", 2500, 100)]
    for row in load.rows:
        assert all(e["t"] in ("D", "I", "S") for e in row.get("sv", ()))
    (plus,) = _rows(load, "plus")
    # Both map gap shapes have display markers at the fixed evidence floor;
    # neither supplies authoritative CIGAR read evidence.
    assert [(e["t"], e["ref"], e["len"], e["source"]) for e in plus["sv"]] == [
        ("D", 4000, 10, "assembly"), ("I", 6010, 100, "assembly")]
    assert all(e["display_only"] and e["method"] == "assembly_projection" for e in plus["sv"])
    assert plus["sv"][1]["ins_id"] == f"MAT:{MAT}:5000-5100:insertion"


def test_identity_components(toy):
    load = _load(toy)
    (r,) = _rows(load, "plus")
    ll_ = r["live_lift"]
    assert ll_["molecule"] == "ds#0|plus"
    assert ll_["record"] == f"{r['record_sha256']}:{r['alignment_occurrence']}"
    assert (ll_["row_index"], ll_["row_count"], ll_["placement"]) == (0, 1, "0")
    assert "analysis_id" not in r  # assigned per fold mode in P2
    grouped = _load(toy, ll.LiftSettings(molecule_groups={toy[1]: "sample"}))
    assert _rows(grouped, "plus")[0]["live_lift"]["molecule"] == "sample|plus"
    assert not any(k.startswith("_fiberbrowser_") for row in load.rows for k in row)


def test_primary_metadata_fetched_lookup_and_record_fallback(toy):
    handle, _bam = toy
    both = [r for r in _rows(_load(toy), "split") if r["live_lift"]["source"]["supplementary"]]
    assert [(r["live_lift"]["hap"], r["live_lift"]["hap_source"], r["strand"]) for r in both] == [("H#2", "primary", "GA")]
    # Only MAT selected: the PAT primary is not fetched; the SA lookup finds it.
    load = _load(toy, haps=["H#1"])
    (r,) = _rows(load, "split")
    assert (r["live_lift"]["hap"], r["live_lift"]["hap_label"], r["live_lift"]["hap_source"], r["strand"]) == \
        ("H#2", "PAT", "primary", "GA")
    assert load.counts["primary_found_by_lookup"] == 1
    ll.clear_primary_cache()
    off = _load(toy, ll.LiftSettings(primary_lookup=False), haps=["H#1"])
    (r,) = _rows(off, "split")
    assert (r["live_lift"]["hap"], r["live_lift"]["hap_source"], r["strand"]) == ("H#1", "record", "CT")
    assert off.counts["hap_from_record"] == 1


def test_supplementary_rows_follow_union_rule(toy):
    def supp(settings):
        return [r for r in _load(toy, settings).rows if r["live_lift"]["source"]["supplementary"]]
    assert supp(ll.LiftSettings(supplementary_display="hide"))  # the cohort still needs them
    assert not supp(ll.LiftSettings(supplementary_display="hide", cohort_supplementaries="primary_only"))


def test_load_is_unfiltered_by_display_settings(toy):
    def strip(load):
        out = []
        for r in load.rows:
            r = dict(r, live_lift=dict(r["live_lift"], key=None))
            out.append(r)
        return out
    base = strip(_load(toy))
    for settings in (ll.LiftSettings(haplotype_mode="pooled"), ll.LiftSettings(fold_molecule=True),
                     ll.LiftSettings(fold_orientation_rows=True), ll.LiftSettings(joint_dedup="by_molecule")):
        assert strip(_load(toy, settings)) == base
    # A narrow view gets the same rows (selection margin): nothing is filtered by spanning.
    assert {r["id"] for r in _load(toy, start=3900, end=3950).rows} == {r["id"] for r in _load(toy).rows}


def test_bin_cache_and_fresh_selection_give_identical_rows(toy):
    handle, bam = toy
    a = _load(toy)
    ll.clear_selection_cache()
    b = ll.load_lifted_rows(handle, [bam], TARGET, 1000, 9000, haplotypes=handle.haplotypes,
                            settings=ll.LiftSettings(), dataset_id="ds", loader_options=dict(OPTS), use_cache=False)
    assert a.rows == b.rows


def test_nothing_streamed_during_the_source_decode(toy):
    from services.read_stream import decoded_read_sink
    sink = []
    token = decoded_read_sink.set(sink)
    try:
        load = _load(toy)
    finally:
        decoded_read_sink.reset(token)
    assert load.rows and sink == []


def test_record_budget_truncates(toy):
    handle, bam = toy
    load = ll.load_lifted_rows(handle, [bam], TARGET, 1000, 9000, haplotypes=handle.haplotypes,
                               settings=ll.LiftSettings(), dataset_id="ds", loader_options=dict(OPTS),
                               budget=ll.LoadBudget(max_records=2))
    assert load.truncated and load.counts["truncated"] is True


def test_minus_ma_layers_swap_edges_and_map_source_intervals(tmp_path):
    ll.clear_selection_cache()
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / "map"))

    def records(h):
        # SEQ-frame MA: tf [20, 50) with tq/el/er; a consensus call [100, 160) whose fi byte keeps
        # unclipped source bounds.
        return [make_record(h, "ma", MAT, 7200, "200M", tags=[
            ("MA", "200;tf+QQQ:21-30;tf_consensus+QQQQ:101-60"),
            ("AQ", _u8([200, 7, 9, 150, 1, 2, 3]))])]

    bam = write_bam(tmp_path / "ma.bam", records)
    load = ll.load_lifted_rows(handle, [bam], TARGET, 12_000, 14_000, haplotypes=["H#1"],
                               settings=ll.LiftSettings(), dataset_id="ds",
                               loader_options=dict(requested_layers=["tf", "tf_consensus"]))
    (r,) = load.rows
    tf = r["layers"]["tf"]
    # [7220, 7250) on '-': [13750, 13780); el/er swapped.
    assert tf["intervals"] == [[13750, 13780, 30]]
    assert tf["quality_names"] == ["tq", "el", "er"] and tf["qualities"] == [[200], [9], [7]]
    cons = r["layers"]["tf_consensus"]
    assert cons["intervals"] == [[13640, 13700, 60]]
    assert cons["source_intervals"] == [[13640, 13700, 60]]
    assert r["live_lift"]["calls"]["layer:tf"] == ["MA0:0"]


def test_terminal_gaps_mapped_in_binary_context(toy):
    from services.read_binary import binary_read_context
    handle, bam = toy
    token = binary_read_context.set(True)
    try:
        load = ll.load_lifted_rows(handle, [bam], TARGET, 1000, 9000, haplotypes=handle.haplotypes,
                                   settings=ll.LiftSettings(), dataset_id="ds",
                                   loader_options=dict(OPTS, hide_terminal_gaps=False))
    finally:
        binary_read_context.reset(token)
    (r,) = _rows(load, "minus")
    # Source terminal gaps [7200, 7210) and [7351, 7450) (the loader ends the calls at the
    # insertion-only markers' base) on '-': [13790, 13800) and [13550, 13649).
    assert r["_fiberbrowser_terminal_gaps"] == [[13550, 13649], [13790, 13800]]
    (p,) = _rows(load, "plus")
    assert p["intervals"][0] == [3500, 3900, -400]  # leading gap shown inside the first body span
