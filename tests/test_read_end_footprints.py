"""Read-end footprints under 90 bp are dropped at load time (display and analyses).

A footprint call at either end of a read (nothing observed between it and the
read end) is cut off by the end; shorter than the cutoff it is left out of the
read's calls. Read membership (min footprints, the terminal-gap filter) is
still judged on all of the read's calls.
"""
from types import SimpleNamespace

from services import compact_read_loader
from services.compact_read_loader import (
    SHORT_TERMINAL_FOOTPRINT_BP,
    short_terminal_footprint_bp_for,
    short_terminal_spans,
)
from services.read_auxiliary_endpoint import (
    read_end_footprints_payload,
    set_read_end_footprints_payload,
)
from services.working_sets import read_load_token

from test_compact_read_loader import FakeBam, FakeBamRead, FakeBigBed, bed12_rest

CUT = SHORT_TERMINAL_FOOTPRINT_BP


def _load(read, bp, **kwargs):
    fake_bam = FakeBam([read])
    options = dict(
        spanning_only=False,
        include_layers=True,
        requested_layers=["nuc", "tf"],
        include_layer_qualities=True,
        bam_handle_getter=lambda _path: fake_bam,
        short_terminal_footprint_bp=bp,
    )
    options.update(kwargs)
    return compact_read_loader.build_compact_reads_from_bam(
        "https://example.test/read.bam", "chr2L", 100, 1100, **options)


def test_short_terminal_spans_picks_only_short_calls_at_the_two_ends():
    # ns/nl: a 40 bp stub at the start, a 147 bp nucleosome, a 60 bp stub at the end.
    assert short_terminal_spans([5, 100, 400], [40, 147, 60], None, CUT, read_length=470) == {(5, 45), (400, 460)}
    # A long call at an end stays; an internal short call is never a read-end call.
    assert short_terminal_spans([5, 100, 400], [140, 30, 147], None, CUT, read_length=560) == set()
    # MA calls count too: a TF before the first ns/nl footprint is the read's first call.
    ma = [("nuc", 100, 247), ("tf", 2, 30)]
    assert short_terminal_spans([100], [147], ma, CUT, read_length=1000) == {(2, 30)}
    # The same call in ns/nl and in MA nuc is one call.
    assert short_terminal_spans([0], [50], [("nuc", 0, 50)], CUT, read_length=1000) == {(0, 50)}
    # Only at the read end: a first/last call SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP
    # or more from it is not cut off by it (a lone TF in an accessible read).
    assert short_terminal_spans(None, None, [("tf", 393, 437)], CUT, read_length=661) == set()
    assert short_terminal_spans([30, 100], [40, 147], None, CUT, read_length=1000) == set()
    assert short_terminal_spans([29, 100], [40, 147], None, CUT, read_length=1000) == {(29, 69)}
    # Unknown read length: the last call is kept.
    assert short_terminal_spans([100, 990], [147, 10], None, CUT) == set()
    # Off, or nothing to look at.
    assert short_terminal_spans([5], [40], None, 0, read_length=100) == set()
    assert short_terminal_spans(None, None, [], CUT) == set()


def _mixed_read():
    # Query == reference offset 100 (one M block). ns/nl: nucleosomes; MA: the
    # same nucleosomes plus TF calls, with a 30 bp TF stub at each read end.
    return FakeBamRead(
        "read1", 100, 1100,
        tags={
            "ns": [100, 600], "nl": [147, 150], "nq": [201, 202], "lq": [11, 12], "rq": [21, 22],
            "MA": "1000;nuc+QQQ:101-147,601-150;tf+QQQ:11-30,401-40,961-30",
            "AQ": [201, 11, 21, 202, 12, 22, 101, 1, 2, 102, 3, 4, 103, 5, 6],
        },
    )


def test_bam_read_end_tf_stubs_are_dropped_and_the_rest_keeps_its_qualities():
    read = _mixed_read()
    read.query_length = 1000
    kept = _load(read, CUT)[0]
    off = _load(read, 0)[0]

    assert off["layers"]["tf"]["intervals"] == [[10, 40, 30], [400, 440, 40], [960, 990, 30]]
    # Only the stubs at the two read ends go; the internal 40 bp TF call stays
    # with its own tq/el/er.
    assert kept["layers"]["tf"]["intervals"] == [[400, 440, 40]]
    assert kept["layers"]["tf"]["qualities"] == [[102], [3], [4]]
    assert kept["layers"]["nuc"] == off["layers"]["nuc"]
    # The body (terminal gaps hidden) still spans every call, the dropped ones'
    # stretch empty, so each window keeps the same reads.
    assert kept["intervals"][0][0] == off["intervals"][0][0] == 10
    assert kept["intervals"][-1][1] == off["intervals"][-1][1] == 990
    assert not [iv for iv in kept["intervals"] if iv[2] > 0 and iv[0] < 100]


def test_bam_short_end_nucleosome_stub_is_dropped_from_primary_and_layers():
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={
            "ns": [0, 200, 960], "nl": [60, 147, 30], "nq": [70, 80, 90],
            "lq": [1, 2, 3], "rq": [4, 5, 6],
        },
    )
    read.query_length = 1000
    kept = _load(read, CUT, requested_layers=["nuc"])[0]
    off = _load(read, 0, requested_layers=["nuc"])[0]
    assert [iv for iv in off["intervals"] if iv[2] > 0] == [[0, 60, 60], [200, 347, 147], [960, 990, 30]]
    assert [iv for iv in kept["intervals"] if iv[2] > 0] == [[200, 347, 147]]
    assert kept["qualities"] == [80]
    assert kept["layers"]["nuc"]["qualities"] == [[80], [2], [5]]


def test_rule_never_changes_which_reads_load():
    # Min footprints counts all the read's calls...
    read = FakeBamRead("read1", 100, 1100, tags={"ns": [0, 200, 900], "nl": [60, 147, 50]})
    read.query_length = 1000
    assert len(_load(read, CUT, min_footprints=3, requested_layers=["nuc"])) == 1
    # ...and so does the terminal-gap filter: dropping the 60 bp stub at the
    # start would leave a 450 bp leading gap (> 400), but the read stays.
    read = FakeBamRead("read2", 100, 1100, tags={"ns": [0, 450, 800], "nl": [60, 147, 190]})
    read.query_length = 1000
    assert len(_load(read, CUT, terminal_gap_threshold=400, requested_layers=["nuc"])) == 1
    assert len(_load(read, 0, terminal_gap_threshold=400, requested_layers=["nuc"])) == 1


def test_only_calls_at_the_read_end_go_and_mid_read_calls_stay():
    # Amplicon reads: one MSP over the whole read with TF calls inside it.
    # The last TF ends 11 bp from the read end (inside FiberHMM's end margin):
    # cut off, dropped. The first starts 393 bp in: a real call, kept.
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={"MA": "661;msp.:1-661;tf.QQQ:394-44,574-77", "AQ": [1, 2, 3, 4, 5, 6]},
    )
    read.query_length = 661
    assert _load(read, 0)[0]["layers"]["tf"]["intervals"] == [[393, 437, 44], [573, 650, 77]]
    assert _load(read, CUT)[0]["layers"]["tf"]["intervals"] == [[393, 437, 44]]
    # A single TF footprint in the middle of a read is its first and last call: kept.
    read = FakeBamRead(
        "read2", 100, 1100,
        tags={"MA": "661;msp.:1-661;tf.QQQ:301-40", "AQ": [1, 2, 3]},
    )
    read.query_length = 661
    assert _load(read, CUT)[0]["layers"]["tf"]["intervals"] == [[300, 340, 40]]
    # ns/nl with as/al MSPs alike: the short first footprint after a 10 bp MSP
    # goes; the short last one 50 bp from the end stays.
    read = FakeBamRead(
        "read3", 100, 1100,
        tags={"ns": [10, 200, 900], "nl": [60, 147, 50], "as": [0, 70], "al": [10, 130]},
    )
    read.query_length = 1000
    kept = _load(read, CUT, requested_layers=["nuc"])[0]
    assert [iv for iv in kept["intervals"] if iv[2] > 0] == [[200, 347, 147], [900, 950, 50]]


def test_a_read_with_only_read_end_stubs_stays_as_an_empty_row():
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={"ns": [10, 960], "nl": [40, 30], "MA": "1000;nuc+Q:11-40,961-30", "AQ": [1, 2]},
    )
    read.query_length = 1000
    off = _load(read, 0)
    kept = _load(read, CUT)
    assert len(off) == len(kept) == 1
    assert kept[0]["intervals"] == [[10, 990, 0]]
    assert "nuc" not in (kept[0].get("layers") or {})


def test_a_read_whose_only_calls_are_ma_stubs_stays():
    # Empty ns/nl (no nucleosome calls) and MA TF stubs at both read ends:
    # both are dropped, and the read still shows (empty) where its calls were.
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={"ns": [], "nl": [], "MA": "1000;tf.QQQ:11-20,971-20", "AQ": [1, 2, 3, 4, 5, 6]},
    )
    read.query_length = 1000
    off = _load(read, 0)
    kept = _load(read, CUT)
    assert len(off) == len(kept) == 1
    assert off[0]["layers"]["tf"]["intervals"] == [[10, 30, 20], [970, 990, 20]]
    assert "tf" not in (kept[0].get("layers") or {})
    # As without the drop (a read with drawn MA calls and no ns/nl footprint).
    assert kept[0]["intervals"] == off[0]["intervals"] == [[0, 1000, 0]]


def test_dropped_ma_calls_still_count_for_read_membership():
    # The MA calls keep a read whose ns/nl geometry fails the terminal-gap test;
    # dropping them as read-end stubs must not remove it (Codex review).
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={"ns": [450], "nl": [147], "MA": "1000;tf.QQQ:411-20,651-20", "AQ": [1, 2, 3, 4, 5, 6]},
    )
    read.query_length = 1000
    assert len(_load(read, 0, terminal_gap_threshold=300)) == 1
    assert len(_load(read, CUT, terminal_gap_threshold=300)) == 1


def test_a_window_away_from_dropped_stubs_gains_no_read():
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={"ns": [], "nl": [], "MA": "1000;tf.QQQ:1-20,981-20", "AQ": [1, 2, 3, 4, 5, 6]},
    )
    read.query_length = 1000
    fake_bam = FakeBam([read])
    for bp in (0, CUT):
        rows = compact_read_loader.build_compact_reads_from_bam(
            "https://example.test/read.bam", "chr2L", 600, 700, spanning_only=False,
            include_layers=True, requested_layers=["nuc", "tf"],
            bam_handle_getter=lambda _path: fake_bam, short_terminal_footprint_bp=bp)
        assert rows == []


def test_a_broad_load_uses_one_cutoff_for_every_file():
    from services.working_sets import _load_broad_reads

    seen = []

    def build_bam(path, *_args, **kwargs):
        seen.append((path, kwargs.get("short_terminal_footprint_bp")))
        return []

    dataset = SimpleNamespace(data_type="bam", paths=["a.bam", "b.bam"], derived_layers={})
    _load_broad_reads(
        dataset=dataset, dataset_id="d", chrom="chr2L", broad_start=0, broad_end=10, broad_width=10,
        include_methylation=False, layer_key=(), include_layer_qualities=False,
        build_bam_reads=build_bam, build_bigbed_reads=None, load_bigbed_marks=None,
        short_terminal_footprint_bp=0,
    )
    assert seen == [("a.bam", 0), ("b.bam", 0)]


def test_ma_only_reads_drop_read_end_stubs_and_keep_quality_alignment():
    read = FakeBamRead(
        "read1", 100, 1100,
        tags={
            "MA": "1000;nuc+QQQ:201-147;tf+QQQ:1-20,501-30,981-20",
            "AQ": [201, 11, 21, 101, 1, 2, 102, 3, 4, 103, 5, 6],
        },
    )
    read.query_length = 1000
    kept = _load(read, CUT)[0]
    assert kept["layers"]["tf"]["intervals"] == [[500, 530, 30]]
    assert kept["layers"]["tf"]["qualities"] == [[102], [3], [4]]
    assert kept["layers"]["nuc"]["intervals"] == [[200, 347, 147]]
    assert _load(read, 0)[0]["layers"]["tf"]["intervals"] == [[0, 20, 20], [500, 530, 30], [980, 1000, 20]]


def test_single_bigbed_rows_drop_read_end_stubs():
    fake_bigbed = FakeBigBed({
        "chr2L": [(100, 600, bed12_rest("read1", [40, 147, 30], [0, 150, 470], "70,80,90,"))],
    })

    def load(bp):
        return compact_read_loader.build_compact_reads_from_bigbed(
            ["fp.bb"], "chr2L", 100, 600, spanning_only=False,
            bigbed_handle_getter=lambda _path: fake_bigbed,
            overlay_type_detector=lambda _path: "footprint", format_cache={},
            short_terminal_footprint_bp=bp,
        )[0]

    assert [iv for iv in load(0)["intervals"] if iv[2] > 0] == [[0, 40, 40], [150, 297, 147], [470, 500, 30]]
    kept = load(CUT)
    assert [iv for iv in kept["intervals"] if iv[2] > 0] == [[150, 297, 147]]
    assert kept["layers"]["nuc"]["qualities"] == [[80]]
    # The body still spans the row's blocks, the dropped stubs' stretch empty.
    assert kept["intervals"][0][0] == 0 and kept["intervals"][-1][1] == 500

    stub_only = FakeBigBed({"chr2L": [(100, 600, bed12_rest("read2", [40, 30], [0, 470], "70,90,"))]})
    rows = compact_read_loader.build_compact_reads_from_bigbed(
        ["fp.bb"], "chr2L", 100, 600, spanning_only=False,
        bigbed_handle_getter=lambda _path: stub_only,
        overlay_type_detector=lambda _path: "footprint", format_cache={},
        short_terminal_footprint_bp=CUT,
    )
    assert [row["intervals"] for row in rows] == [[[0, 500, 0]]]


def test_workspace_setting_reaches_the_loaders_and_their_caches():
    state = SimpleNamespace(drop_short_terminal_footprints=True, short_terminal_footprint_bp=CUT)
    assert short_terminal_footprint_bp_for(state) == CUT
    assert short_terminal_footprint_bp_for(SimpleNamespace()) == CUT  # the default is on
    on_token = read_load_token(SimpleNamespace(**vars(state)), "chr2L")
    state.drop_short_terminal_footprints = False
    assert short_terminal_footprint_bp_for(state) == 0
    # Reads loaded under the other setting are never served from a cache.
    assert read_load_token(state, "chr2L") != on_token


def test_read_end_footprints_endpoint_toggles_and_clears_read_caches():
    from state.browser_state import BrowserState

    state = BrowserState(None, None, None, None)
    assert read_end_footprints_payload(state) == {"hide_short": True, "min_bp": CUT, "max_end_gap_bp": 30}
    state._broad_cache[("x",)] = ([], 0.0)
    state._working_set_cache[("y",)] = object()
    result = set_read_end_footprints_payload(state, {"hide_short": False})
    assert result["changed"] is True and result["hide_short"] is False
    assert not state._broad_cache and not state._working_set_cache
    state._broad_cache[("x",)] = ([], 0.0)
    assert set_read_end_footprints_payload(state, {"hide_short": False})["changed"] is False
    assert state._broad_cache  # unchanged setting: caches kept


def test_direct_bam_loader_uses_the_workspace_setting(monkeypatch):
    from services import read_route_helpers

    seen = {}

    def fake_build(_path, _chrom, _start, _end, **kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(read_route_helpers, "build_compact_reads_from_bam", fake_build)
    state = SimpleNamespace(chrom_map=None, drop_short_terminal_footprints=False)
    monkeypatch.setattr("services.plasmid_reconcile.contig_links", lambda *_a, **_k: None)
    monkeypatch.setattr("services.circular_genome.is_circular_chrom", lambda *_a, **_k: False)
    read_route_helpers.build_direct_bam_reads(state, "x.bam", "chr2L", 0, 10)
    assert seen["short_terminal_footprint_bp"] == 0
    state.drop_short_terminal_footprints = True
    read_route_helpers.build_direct_bam_reads(state, "x.bam", "chr2L", 0, 10)
    assert seen["short_terminal_footprint_bp"] == CUT
