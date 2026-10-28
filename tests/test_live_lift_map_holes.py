"""Calls and linkers across small map holes (graph follow-ups item 1; lift parity).

A map hole (a source base with no target, a badge; a target base with no
source, a connector) sits inside one chain run. fiberhmm-lift writes it into
the lifted record's CIGAR as ``I``/``D``, and the browser's decoder runs a call
or linker straight across it unless the hole is part of an indel event of at
least ``sv_min_len``. Live lift now does the same: a call or linker across a
hole that does not cut is one interval (it used to be cut at the hole, and a
linker across a hole wider than ``rejoin_bp`` was dropped). The columnar pass
and the per-row functions agree.
"""
import copy
import os

import pytest

from services.lift import compose
from services.lift import live_lift as ll
from services.read_metrics import read_covers_regions

from test_live_lift_columnar import _same

# source [0, 50) -> target [0, 50); source base 50 unmapped (badge at 50);
# source [51, 100) -> target [50, 99); target base 99 unmapped (connector [99, 100));
# source [100, 140) -> target [100, 140).
PIECES = [ll.LiftPiece(0, 0, 50, 0, 50, "+", True, "H#1", "src"),
          ll.LiftPiece(0, 50, 99, 51, 100, "+", True, "H#1", "src"),
          ll.LiftPiece(0, 100, 140, 100, 140, "+", True, "H#1", "src")]
IVS = [[5, 30, 25], [30, 70, -40], [70, 95, 25], [95, 120, -25], [120, 135, 15]]


def _read(**updates):
    read = {"id": "r", "reference_start": 0, "reference_end": 140, "intervals": copy.deepcopy(IVS),
            "qualities": [1, 2, 3], "alignment_orientation": "forward", "library_id": "lib", "source_path": "a.bam",
            "record_sha256": "s", "alignment_occurrence": 0, "_fiberbrowser_source_base": 0,
            "_fiberbrowser_aligned_runs": [[0, 0, 140]],
            "_fiberbrowser_lift_record": {"contig": "src", "reverse": False, "length": 140},
            "_fiberbrowser_primary": {"is_supplementary": False, "sa": None},
            "_fiberbrowser_calls": {"intervals": [["a", 5, 30], None, ["b", 70, 95], None, ["c", 120, 135]]},
            "layers": {}}
    read.update(updates)
    return read


def _compose(reads, pieces, rejoin_bp=5, **opts):
    sel = ll.PieceSelection("tgt", 0, 140, 0, 140, pieces)
    return compose.lift_compact_reads(copy.deepcopy(reads), ll.FetchPlan(sel, [], 0, 0), handle=None,
                                      region_start=0, region_end=140, key="k", dataset_id="d", molecules={},
                                      settings=ll.LiftSettings(rejoin_bp=rejoin_bp), loader_options=opts)


def _both(monkeypatch, reads, pieces=PIECES, **kw):
    columnar = _compose(reads, pieces, **kw)
    with monkeypatch.context() as m:
        m.setattr(compose, "precompute", lambda *a, **k: None)
        per_row = _compose(reads, pieces, **kw)
    _same(columnar, per_row)
    return columnar


def _ivs(row):
    return [list(iv) for iv in row["intervals"]]


def test_linkers_run_across_a_badge_and_a_connector(monkeypatch):
    """Was: the linkers were cut at the badge and at the connector, and the connector base stayed a hole.
    Now each linker is one gap across the hole, as the decoder reads the lifted record's CIGAR I/D."""
    (row,) = _both(monkeypatch, [_read()])
    assert _ivs(row) == [[5, 30, 25], [30, 69, -39], [69, 94, 25], [94, 120, -26], [120, 135, 15]]
    assert row["live_lift"]["connectors"] == [[99, 100]]
    assert [b[0] for b in row["live_lift"]["badges"]] == [50]
    assert row["live_lift"]["calls"]["intervals"] == ["a", None, "b", None, "c"]
    assert read_covers_regions(row, [(20, 80), (90, 99), (100, 130)])
    assert read_covers_regions(row, [(95, 105)])


def test_minus_strand_rows_keep_linkers_too(monkeypatch):
    pieces = [ll.LiftPiece(0, 140 - p.t_end, 140 - p.t_start, p.q_start, p.q_end, "-", True, "H#1", "src")
              for p in PIECES]
    (row,) = _both(monkeypatch, [_read()], pieces)
    assert _ivs(row) == [[5, 20, 15], [20, 46, -26], [46, 71, 25], [71, 110, -39], [110, 135, 25]]


def test_linkers_across_holes_do_not_depend_on_rejoin_bp(monkeypatch):
    """Was: with rejoin_bp 0 the linkers across the holes were dropped. rejoin_bp only groups call parts
    (call_parts); what crosses a hole is the decoder's rule (sv_min_len)."""
    (row,) = _both(monkeypatch, [_read()], rejoin_bp=0)
    assert _ivs(row) == [[5, 30, 25], [30, 69, -39], [69, 94, 25], [94, 120, -26], [120, 135, 15]]


def test_shown_terminal_gaps_reach_the_run_ends(monkeypatch):
    """Was: shown gaps were cut at each hole (span edges)."""
    for rejoin in (0, 5):
        (row,) = _both(monkeypatch, [_read()], rejoin_bp=rejoin, hide_terminal_gaps=False)
        assert _ivs(row) == [[0, 5, -5], [5, 30, 25], [30, 69, -39], [69, 94, 25], [94, 120, -26],
                             [120, 135, 15], [135, 140, -5]]


def test_a_span_with_no_call_between_two_holes_is_one_linker(monkeypatch):
    pieces = [ll.LiftPiece(0, 0, 40, 0, 40, "+", True, "H#1", "src"),
              ll.LiftPiece(0, 41, 60, 40, 59, "+", True, "H#1", "src"),
              ll.LiftPiece(0, 61, 140, 59, 138, "+", True, "H#1", "src")]
    read = _read(intervals=[[5, 30, 25], [30, 80, -50], [80, 100, 20]],
                 _fiberbrowser_calls={"intervals": [["a", 5, 30], None, ["b", 80, 100]]}, qualities=[])
    (row,) = _both(monkeypatch, [read], pieces)
    assert _ivs(row) == [[5, 30, 25], [30, 82, -52], [82, 102, 20]]


def test_inferred_msps_cross_holes_the_same_way(monkeypatch):
    """Inferred MSPs (gaps between legacy nucleosomes) cross the holes as linkers do."""
    read = _read(_fiberbrowser_legacy={"ma_names": [], "explicit_msp": False})
    (row,) = _both(monkeypatch, [read], legacy_nuc_min_size=10)
    assert [list(iv) for iv in row["layers"]["msp"]["intervals"]] == [[30, 69, 39], [94, 120, 26]]


def test_a_connector_that_cuts_is_a_hole(monkeypatch):
    """A 60 bp connector is an indel event of sv_min_len on the lifted record: the decoder cuts calls and
    linkers at its deleted bases, and the row's body breaks there (live_lift.holes); a view inside it is not
    spanned. A connector that cuts nothing is body (calls and linkers run across it)."""
    from services.lift.reads import body_spans_view
    pieces = [ll.LiftPiece(0, 0, 50, 0, 50, "+", True, "H#1", "src"),
              ll.LiftPiece(0, 110, 200, 50, 140, "+", True, "H#1", "src")]
    read = _read(intervals=[[5, 30, 25], [30, 70, -40], [70, 95, 25]], qualities=[1, 2],
                 _fiberbrowser_calls={"intervals": [["a", 5, 30], None, ["b", 70, 95]]})
    sel = ll.PieceSelection("tgt", 0, 200, 0, 200, pieces)
    kw = dict(handle=None, region_start=0, region_end=200, key="k", dataset_id="d", molecules={},
              settings=ll.LiftSettings(), loader_options={})
    rows = compose.lift_compact_reads(copy.deepcopy([read]), ll.FetchPlan(sel, [], 0, 0), **kw)
    with monkeypatch.context() as m:
        m.setattr(compose, "precompute", lambda *a, **k: None)
        _same(rows, compose.lift_compact_reads(copy.deepcopy([read]), ll.FetchPlan(sel, [], 0, 0), **kw))
    (row,) = rows
    assert row["live_lift"]["connectors"] == [[50, 110]] and row["live_lift"]["holes"] == [[50, 110]]
    assert _ivs(row) == [[5, 30, 25], [30, 50, -100], [110, 130, -100], [130, 155, 25]]
    assert row["alignment_spans"] == [[0, 50], [110, 200]]
    assert not body_spans_view(row["live_lift"], 60, 100) and body_spans_view(row["live_lift"], 10, 40)


@pytest.mark.skipif(not (os.environ.get("FIBERBROWSER_TEST_LIFT_BAM") and os.environ.get("FIBERBROWSER_TEST_LIFT_MAP")),
                    reason="needs the HG002 demo BAM and its lift map")
def test_lifted_rows_tile_the_aluy_peaks(tmp_path, monkeypatch):
    """Every lifted MAT/PAT row spanning the four AluY demo peaks tiles them (was 44 of 49: the linker
    across a 1-bp map hole was dropped)."""
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    from plugins import init_context
    from services.analysis_query import AnalysisReadQuery
    from services.lift.registration import add_live_lift_dataset
    from services.read_selection import read_body_spans
    from state.browser_state import BrowserState

    origin = 128_650_000
    peaks = [(5000, 5100), (6200, 6300), (8000, 8100), (9000, 9100)]
    st = BrowserState(None, None, None, None)
    init_context(st)
    st.max_working_reads = 10000
    add_live_lift_dataset(st, paths=[os.environ["FIBERBROWSER_TEST_LIFT_BAM"]],
                          manifest=os.environ["FIBERBROWSER_TEST_LIFT_MAP"], dataset_id="lifted")
    spanning = tiling = 0
    for hap in ("MAT", "PAT"):
        q = AnalysisReadQuery.from_request(st, capability="clustering", chrom="chr3", start=origin,
                                           end=origin + 20000, dataset_ids=["lifted"], max_reads=None)
        for row in q.build_working_set(st, "lifted", lift_hap=hap).reads:
            body = read_body_spans(row)
            if not body or body[0][0] > peaks[0][0] or body[-1][1] < peaks[-1][1]:
                continue
            spanning += 1
            tiling += read_covers_regions(row, peaks)
    assert spanning == 49
    assert tiling == 49


def _bam(tmp_path, records):
    import pysam
    from array import array
    path = str(tmp_path / "src.bam")
    header = {"HD": {"VN": "1.6"}, "SQ": [{"SN": "chrS", "LN": 1000}]}
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        for name, cigar, ns, nl in records:
            n = sum(length for op, length in cigar if op in (0, 1))
            a = pysam.AlignedSegment(out.header)
            a.query_name, a.query_sequence, a.flag, a.reference_id, a.reference_start = name, "A" * n, 0, 0, 0
            a.mapping_quality, a.cigartuples = 60, cigar
            a.query_qualities = pysam.qualitystring_to_array("I" * n)
            a.set_tag("ns", array("I", ns))
            a.set_tag("nl", array("I", nl))
            out.write(a)
    pysam.index(path)
    return path


def _lift_bam(monkeypatch, path, pieces, **options):
    sel = ll.PieceSelection("chrT", 0, 350, 0, 350, sorted(pieces, key=lambda p: (p.t_start, p.chain)))
    plan = ll.plan_fetch(sel, ll.LiftSettings())
    kw = dict(handle=None, region_start=0, region_end=350, settings=ll.LiftSettings(), key="k", dataset_id="d",
              loader_options=options or None)
    rows = compose.lift_compact_reads(ll.decode_source_records([path], plan, loader_options=options or None), plan, **kw)
    with monkeypatch.context() as m:
        m.setattr(compose, "precompute", lambda *a, **k: None)
        per_row = compose.lift_compact_reads(ll.decode_source_records([path], plan, loader_options=options or None),
                                             plan, **kw)
    _same(rows, per_row)
    return {r["id"]: r for r in rows}


def _src(qs, qe):
    return ll.LiftPiece(0, qs, qe, qs, qe, "+", True, "H#1", "chrS")


def test_deleted_bases_stay_cut_across_a_map_hole(tmp_path, monkeypatch):
    """agy review of group K. One nucleosome cut by a 60D65I replacement (the decoder's two pieces of one call) is
    whole again across a 1-bp map hole inside the deletion: no linker or inferred MSP inside it. Two nucleosomes
    flanking a replacement keep their linker cut at the deleted bases (the CIGAR's raw deletion pieces, as the native
    loader cuts), with or without a hole."""
    path = _bam(tmp_path, [("split", [(0, 40), (2, 60), (1, 65), (0, 140)], [10], [215]),
                           ("two", [(0, 110), (2, 60), (1, 65), (0, 130)], [5, 185], [95, 105])])
    plain = _lift_bam(monkeypatch, path, [_src(0, 350)])
    in_split = _lift_bam(monkeypatch, path, [_src(0, 70), _src(71, 350)])     # a hole inside the first deletion
    in_two = _lift_bam(monkeypatch, path, [_src(0, 140), _src(141, 350)])     # a hole inside the second one
    for rows in (plain, in_split):
        assert _ivs(rows["split"]) == [[10, 40, 215], [100, 220, 215]]
        assert not (rows["split"].get("layers") or {}).get("msp")
        assert not read_covers_regions(rows["split"], [(45, 65)])
    for rows in (plain, in_two):
        assert _ivs(rows["two"]) == [[5, 100, 95], [100, 110, -80], [170, 180, -80], [180, 285, 105]]
        assert [list(iv) for iv in rows["two"]["layers"]["msp"]["intervals"]] == [[100, 110, 80], [170, 180, 80]]
        assert not read_covers_regions(rows["two"], [(115, 135)])


def test_indels_shorter_than_sv_min_len_cut_nothing(tmp_path, monkeypatch):
    """agy review of group K, round 2: a record's events go down to the 10 bp evidence floor, but the native loader
    cuts calls only at events of at least sv_min_len; lifted rows do the same (a 20D25I replacement, 25 bp)."""
    path = _bam(tmp_path, [("short", [(0, 110), (2, 20), (1, 25), (0, 130)], [5, 145], [95, 105])])
    rows = _lift_bam(monkeypatch, path, [_src(0, 350)])
    assert _ivs(rows["short"]) == [[5, 100, 95], [100, 140, -40], [140, 245, 105]]
    assert [list(iv) for iv in rows["short"]["layers"]["msp"]["intervals"]] == [[100, 140, 40]]
    assert read_covers_regions(rows["short"], [(112, 128)])
    # With sv_min_len at 20 the replacement counts, and its deleted bases cut the linker.
    rows = _lift_bam(monkeypatch, path, [_src(0, 350)], sv_min_len=20)
    assert _ivs(rows["short"]) == [[5, 100, 95], [100, 110, -40], [130, 140, -40], [140, 245, 105]]



def _split_row():
    """A lifted row whose record splits at a g_split target gap: two runs (one fiberhmm-lift record each),
    a connector across the gap (an owned target insertion), no call near the runs' inner ends."""
    return {"id": "r", "intervals": [[0, 40, 40], [20060, 20100, 40]],
            "live_lift": {"segments": [[0, 100, 0, "+", True], [20000, 20100, 0, "+", True]],
                          "connectors": [[100, 20000]], "holes": [], "badges": [], "badge_ids": [],
                          "insertions": {}, "calls": {"intervals": ["ns:0", "ns:1"]},
                          "call_parts": {"intervals": [[0, 0], [100, 100]]}}}


def test_a_view_between_two_runs_has_no_neutral_interval_across_the_gap():
    """Cause 7: a split row's hull spans the gap between its runs, where it has no data (fiberhmm-lift writes
    two records). A view across both inner ends gets one neutral interval per body span, not one across the gap
    (scans and Read Stats count neutral intervals). A view inside the gap keeps the row drawn without depth
    (test_live_lift_gap_markers)."""
    from services.working_sets import project_broad_read_to_viewport
    kw = dict(include_methylation=False, layer_key=None)
    row, _ = project_broad_read_to_viewport(_split_row(), viewport_offset=50, region_width=20000, **kw)
    assert [list(iv) for iv in row["intervals"]] == [[0, 50, 0], [19950, 20000, 0]]
    row, _ = project_broad_read_to_viewport(_split_row(), viewport_offset=5000, region_width=1000, **kw)
    assert row is not None and not list(row["intervals"])
