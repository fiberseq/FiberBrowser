"""Live lift reproduces what the browser's decoder makes of a fiberhmm-lift record (lift parity): the
per-record footprint rules applied to each lifted record, gaps built before cuts, and calls cut at a
junction's whole D. Cases from the Codex review of the lift-parity branch (group A, round 1). Through an
identity map the lifted record is the source record, so a native decode of the same BAM is the reference."""
from array import array
from types import SimpleNamespace

from live_lift_fixtures import make_record, write_bam
from services.compact_read_loader import build_compact_reads_from_bam
from services.lift import compose
from services.lift import live_lift as ll
from test_live_lift_columnar import _same

CONTIG = "chrS"


def _bam(tmp_path, records, size=5000):
    return write_bam(tmp_path / "s.bam", lambda h: [make_record(h, name, CONTIG, pos, cigar, tags=tags)
                                                     for name, pos, cigar, tags in records],
                     contigs=((CONTIG, size),))


def _pieces(spans):
    """``[(q_start, q_end, t_start)]`` on one '+' chain."""
    return [ll.LiftPiece(0, ts, ts + qe - qs, qs, qe, "+", True, "H#1", CONTIG) for qs, qe, ts in spans]


def _lift(monkeypatch, path, pieces, end, **options):
    """Lifted rows through the columnar pass, checked against the per-row functions."""
    sel = ll.PieceSelection("chrT", 0, end, 0, end, sorted(pieces, key=lambda p: (p.t_start, p.chain)))
    plan = ll.plan_fetch(sel, ll.LiftSettings())
    kw = dict(handle=None, region_start=0, region_end=end, settings=ll.LiftSettings(), key="k", dataset_id="d",
              loader_options=options or None)

    def run():
        return compose.lift_compact_reads(ll.decode_source_records([path], plan, loader_options=options or None),
                                          plan, **kw)
    rows = run()
    with monkeypatch.context() as m:
        m.setattr(compose, "precompute", lambda *a, **k: None)
        _same(rows, run())
    return rows


def _native(path, end, **options):
    return build_compact_reads_from_bam(path, CONTIG, 0, end, spanning_only=False, include_supplementary=True,
                                        **options)


def _ivs(row):
    return [list(iv) for iv in row["intervals"]]


def test_a_record_with_only_dropped_read_end_footprints_keeps_its_neutral_row(tmp_path, monkeypatch):
    path = _bam(tmp_path, [("r", 0, "140M", [("ns", array("I", [10])), ("nl", array("I", [10]))])])
    opts = dict(short_terminal_footprint_bp=20)
    (native,) = _native(path, 400, **opts)
    (row,) = _lift(monkeypatch, path, _pieces([(0, 350, 0)]), 400, **opts)
    assert _ivs(row) == _ivs(native) == [[10, 20, 0]]


def test_a_skipped_read_end_ma_call_keeps_a_rejected_record(tmp_path, monkeypatch):
    # The footprint lies 1.4 kb from the record's end (the terminal-gap filter rejects it); a requested TF
    # call at the read's start, dropped as a read-end call, still keeps the record (a neutral row).
    tags = [("ns", array("I", [500])), ("nl", array("I", [100])), ("MA", "2000;tf.Q:1-5"), ("AQ", array("B", [200]))]
    path = _bam(tmp_path, [("r", 0, "2000M", tags)])
    opts = dict(short_terminal_footprint_bp=20, requested_layers=["tf"])
    (native,) = _native(path, 2100, **opts)
    (row,) = _lift(monkeypatch, path, _pieces([(0, 2100, 0)]), 2100, **opts)
    assert _ivs(row) == _ivs(native) == [[0, 2000, 0]]


def test_gaps_are_built_before_a_junction_cuts(tmp_path, monkeypatch):
    # Map: source [0, 50) -> [0, 50), [100, 150) -> [110, 160): the lifted CIGAR is 50M 50I 60D 50M (an event
    # of 60 bp: its D is cut). ns:0 ends inside the insertion: the decoder's call reaches P + 1 = 51 before
    # the cut, so the gap after it is 79 bp long (it was 80).
    path = _bam(tmp_path, [("r", 0, "150M", [("ns", array("I", [40, 120])), ("nl", array("I", [20, 10]))])])
    (row,) = _lift(monkeypatch, path, _pieces([(0, 50, 0), (100, 150, 110)]), 400)
    assert _ivs(row) == [[40, 50, 20], [110, 130, -79], [130, 140, 10]]
    assert row["live_lift"]["holes"] == [[50, 110]]


def test_a_call_across_a_cutting_junction_loses_the_whole_lifted_deletion(tmp_path, monkeypatch):
    # The read deletes source [48, 50) at the end of the first fragment, next to a 60 bp connector: the
    # lifted record writes 48M 62D 90M, and the decoder cuts the call at the whole D, [48, 110).
    path = _bam(tmp_path, [("r", 0, "48M2D90M", [("ns", array("I", [10])), ("nl", array("I", [100]))])])
    (row,) = _lift(monkeypatch, path, _pieces([(0, 50, 0), (50, 140, 110)]), 400)
    assert [iv for iv in _ivs(row) if iv[2] > 0] == [[10, 48, 100], [110, 172, 100]]
    assert row["live_lift"]["holes"] == [[48, 110]]


def test_supplementary_status_counts_placements_outside_the_selection():
    # liftbam's primary placement is the one with the most aligned bases over the whole record: here the
    # source [0, 200) on another chain, not the selected [200, 250).
    selected = ll.LiftPiece(1, 1000, 1050, 200, 250, "+", True, "H#1", CONTIG)
    elsewhere = ll.LiftPiece(2, 5000, 5200, 0, 200, "+", True, "H#1", CONTIG)
    read = {"reference_start": 0, "reference_end": 250, "_fiberbrowser_primary": {"is_supplementary": False},
            "_fiberbrowser_lift_record": {"contig": CONTIG, "reverse": False, "length": 250}}
    rows = compose._read_rows(read, ([selected], [selected.q_start]), ll.LiftSettings())
    runs = compose._SeqRuns([[0, 0, 250]], read["_fiberbrowser_lift_record"])
    ctx = SimpleNamespace(handle=object(), selection=SimpleNamespace(pieces=[selected]), settings=ll.LiftSettings(),
                          projections=lambda contig, a, b, haps: [selected, elsewhere])
    assert compose._supplementary_runs(read, rows, runs, ctx) == {(id(rows[0]), 0)}
    ctx.projections = lambda contig, a, b, haps: [selected]
    assert compose._supplementary_runs(read, rows, runs, ctx) == set()


def _ma(spec, quals):
    return [("MA", spec), ("AQ", array("B", quals))]


def test_a_read_gap_of_g_split_starts_a_new_lifted_record(tmp_path, monkeypatch):
    # Codex review (group A, round 2): liftbam splits at a read gap of 10 kb (200M10200S and 10200S200M):
    # no gap and no inferred MSP joins the two records' footprints.
    path = _bam(tmp_path, [("r", 0, "10400M", [("ns", array("I", [50, 10250])), ("nl", array("I", [100, 100]))])],
                size=20000)
    (row,) = _lift(monkeypatch, path, _pieces([(0, 200, 0), (10200, 10400, 200)]), 1000)
    assert _ivs(row) == [[50, 150, 100], [250, 350, 100]]
    assert not (row.get("layers") or {}).get("msp")
    assert len(row["live_lift"]["segments"]) == 2


def test_a_record_ends_at_its_last_aligned_base(tmp_path, monkeypatch):
    # Codex review (group A, round 2): a 1000 bp read deletion spans the split; liftbam's records end at
    # their aligned bases (100M100S at 0, 100S100M at 20400), so neither footprint is a terminal-gap reject.
    path = _bam(tmp_path, [("r", 0, "100M1000D100M", [("ns", array("I", [10, 110])), ("nl", array("I", [70, 70]))])])
    (row,) = _lift(monkeypatch, path, _pieces([(0, 700, 0), (700, 1200, 20000)]), 21000)
    assert [iv for iv in _ivs(row) if iv[2] > 0] == [[10, 80, 70], [20410, 20480, 70]]
    assert [s[:2] for s in row["live_lift"]["segments"]] == [[0, 100], [20400, 20500]]


def test_a_blanked_record_builds_no_gap_from_a_cut_call(tmp_path, monkeypatch):
    # Codex review (group A, round 2): the terminal-gap filter rejects the lifted record (a requested MA TF
    # call keeps it as a neutral row); the footprint inside the cut insertion builds no gap there.
    tags = [("ns", array("I", [500, 1000])), ("nl", array("I", [100, 100]))] + _ma("2000;tf.Q:21-10", [200])
    path = _bam(tmp_path, [("r", 0, "2000M", tags)])
    (row,) = _lift(monkeypatch, path, _pieces([(0, 50, 0), (900, 2000, 650)]), 2000, requested_layers=["tf"])
    assert _ivs(row) == [[0, 50, 0], [650, 1750, 0]]


def test_an_ma_group_with_no_call_on_the_lifted_record_leaves_legacy_inference_on(tmp_path, monkeypatch):
    # Codex review (group A, round 2): the record's only MA TF call lies inside the map insertion (no place on
    # the lifted record 50M50I100M), so the decoder infers TF calls from ns/nl, as on any record without MA TF.
    tags = [("ns", array("I", [10, 150])), ("nl", array("I", [30, 30]))] + _ma("200;tf.Q:61-20", [200])
    path = _bam(tmp_path, [("r", 0, "200M", tags)])
    (row,) = _lift(monkeypatch, path, _pieces([(0, 50, 0), (100, 200, 50)]), 400)
    assert [list(iv) for iv in row["layers"]["tf"]["intervals"]] == [[10, 40, 30], [100, 130, 30]]


def test_min_footprints_counts_each_lifted_record(tmp_path, monkeypatch):
    # Codex review (group A, round 2): each half of the record lifts as its own record with one footprint.
    path = _bam(tmp_path, [("r", 0, "1000M", [("ns", array("I", [50, 650])), ("nl", array("I", [100, 100]))])])
    rows = _lift(monkeypatch, path, _pieces([(0, 500, 0), (500, 1000, 20000)]), 21000, min_footprints=2)
    assert rows == []
    rows = _lift(monkeypatch, path, _pieces([(0, 500, 0), (500, 1000, 20000)]), 21000, min_footprints=1)
    assert len(rows) == 1 and len(rows[0]["live_lift"]["segments"]) == 2
