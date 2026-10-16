"""Origin-spanning reads in the SAM circular representation (fiberhmm-pipeline).

A plasmid read across the origin is ONE record whose alignment runs past the
contig end (``@SQ TP:circular``, reference_end > LN).  A linear window at the
start of the plasmid must show its wrapped tail at ``position - LN``; a
wrapped circular view must show each position once; coverage counts each
record once per position.
"""
from __future__ import annotations

import random
from array import array

import pysam
import pytest

from models.domain import Dataset
from services.circular_genome import circular_query_segments_for_region
from services.footprint_analysis import build_interval_table, compute_cooccupancy_result, read_reference_spans
from services.read_coverage import compute_binned_read_coverage
from services.read_endpoint import compact_reads_payload_for_request, load_direct_reads_for_dataset
from state.browser_state import BrowserState

L = 1000
CONTIG = "pWrap"


def _sequence() -> str:
    rng = random.Random(11)
    seq = [rng.choice("ACGT") for _ in range(L)]
    # C reference bases where read B carries C->T (DAF deamination via MD).
    seq[980] = "C"
    seq[10] = "C"
    return "".join(seq)


def _md(ref: str, query: str) -> str:
    out, run = [], 0
    for r, q in zip(ref, query):
        if r == q:
            run += 1
        else:
            out.append(f"{run}{r}")
            run = 0
    out.append(str(run))
    return "".join(out)


def _record(header, name, pos, length, ext, *, tags, flag=0, mutate=None, cigar=None):
    query = list(ext[pos:pos + length])
    for index, base in (mutate or {}).items():
        query[index] = base
    query = "".join(query)
    read = pysam.AlignedSegment(header)
    read.query_name = name
    read.query_sequence = query
    read.flag = flag
    read.reference_id = 0
    read.reference_start = pos
    read.mapping_quality = 60
    read.cigar = cigar or [(0, length)]
    read.query_qualities = pysam.qualitystring_to_array("I" * length)
    read.set_tag("MD", _md(ext[pos:pos + length], query))
    for tag, value in tags.items():
        read.set_tag(tag, value)
    return read


def _a_index_at_or_after(query: str, index: int) -> int:
    return next(i for i in range(index, len(query)) if query[i] == "A")


def write_fixture(tmp_path, *, topology=True):
    seq = _sequence()
    ext = seq + seq + seq
    sq = {"SN": CONTIG, "LN": L}
    if topology:
        sq["TP"] = "circular"
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [sq]})
    fasta = tmp_path / "ref.fa"
    fasta.write_text(f">{CONTIG}\n{seq}\n")

    # A: Fiber-seq read 700..1300 (tail 0..300). ns/nl footprints at
    # 750..850, 950..1050 (across the origin) and 1100..1160; MSPs 860..940 and
    # 1060..1100; an MA TF call 1120..1140; m6A at two A's.
    query_a = ext[700:1300]
    m6a_head = _a_index_at_or_after(query_a, 100)
    m6a_tail = _a_index_at_or_after(query_a, 450)
    a_positions = [i for i, base in enumerate(query_a) if base == "A"]
    first_skip = a_positions.index(m6a_head)
    second_skip = a_positions.index(m6a_tail) - first_skip - 1
    read_a = _record(header, "wrapA", 700, 600, ext, tags={
        "ns": array("i", [50, 250, 400]), "nl": array("i", [100, 100, 60]),
        "nq": array("B", [10, 20, 30]),
        "as": array("i", [160, 360]), "al": array("i", [80, 40]),
        "MA": "v1;tf+Q:421-20", "AQ": array("B", [200]),
        "MM": f"A+a,{first_skip},{second_skip};", "ML": array("B", [250, 250]),
    })

    # B: DAF read 900..1200 with C->T at 980 (head) and 1010 (tail, = 10).
    read_b = _record(header, "wrapB", 900, 300, ext, mutate={80: "T", 110: "T"}, tags={
        "ns": array("i", [50]), "nl": array("i", [100]), "nq": array("B", [40]),
    })

    # C: an ordinary read 100..300 (control).
    read_c = _record(header, "plainC", 100, 200, ext, tags={
        "ns": array("i", [20]), "nl": array("i", [50]), "nq": array("B", [50]),
    })

    # E: a record longer than the contig (500..1700): its tail comes back over
    # its own start at 500, so only tail positions < 500 may be drawn.
    read_e = _record(header, "longE", 500, 1200, ext, tags={
        "ns": array("i", [150, 1150]), "nl": array("i", [100, 50]), "nq": array("B", [60, 70]),
    })

    unsorted = tmp_path / "unsorted.bam"
    with pysam.AlignmentFile(str(unsorted), "wb", header=header) as out:
        for read in (read_c, read_e, read_a, read_b):
            out.write(read)
    bam = tmp_path / "wrap.bam"
    pysam.sort("-o", str(bam), str(unsorted))
    pysam.index(str(bam))
    return {
        "bam": str(bam), "fasta": str(fasta), "seq": seq,
        "m6a_head": 700 + m6a_head, "m6a_tail": 700 + m6a_tail - L,
    }


def _state(fixture, *, flag_circular=False):
    state = BrowserState(None)
    # The fixture's reads end in sub-90 bp footprints (e.g. A's 1100..1160): this
    # tests wrapping geometry, not the read-end footprint rule (test_read_end_footprints).
    state.drop_short_terminal_footprints = False
    if flag_circular:
        state.add_supplemental_plasmid_reference(CONTIG, fixture["seq"], circular=True)
    dataset = Dataset("wrap", fixture["bam"], "wrap", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "tf": True, "msp": True}
    state.datasets["wrap"] = dataset
    state.dataset_order.append("wrap")
    return state


def _payload(state, start, end, **kwargs):
    params = dict(
        state=state, chrom=CONTIG, start=start, end=end, max_reads=100, dataset_id="wrap",
        include_layers=True, layer_names="nuc,tf,msp", include_methylation=True, spanning=False,
    )
    params.update(kwargs)
    payload = compact_reads_payload_for_request(**params)
    return payload, {read["id"]: read for read in payload["reads"]}


def _positive(intervals):
    return [list(iv) for iv in intervals if iv[2] > 0]


@pytest.fixture
def fixture(tmp_path):
    return write_fixture(tmp_path)


@pytest.mark.parametrize("flag_circular", [False, True])
def test_linear_window_at_start_shows_wrapped_tail(tmp_path, flag_circular):
    # TP:circular alone is enough; a contig the browser flags circular (a
    # plasmid map) wraps even without the header declaration.
    fixture = write_fixture(tmp_path, topology=not flag_circular)
    state = _state(fixture, flag_circular=flag_circular)
    payload, reads = _payload(state, 0, 200)

    assert set(reads) == {"wrapA", "wrapB", "plainC", "longE"}
    assert payload["total_overlapping"] == 4

    a = reads["wrapA"]
    # 950..1050 crosses the origin: its tail half is [0, 50) (size kept);
    # 1100..1160 -> [100, 160).
    assert _positive(a["intervals"]) == [[0, 50, 100], [100, 160, 60]]
    assert a["qualities"] == [20, 30]
    assert a["layers"]["tf"]["intervals"] == [[120, 140, 20]]
    assert a["layers"]["msp"]["intervals"] == [[60, 100, 40]]
    assert a["methyl_m6a"] == [fixture["m6a_tail"]]

    b = reads["wrapB"]
    assert _positive(b["intervals"]) == [[0, 50, 100]]
    assert [event[0] for event in b["deam"]] == [10]

    assert _positive(reads["plainC"]["intervals"]) == [[120, 170, 50]]


def test_window_at_contig_end_is_unchanged(fixture):
    state = _state(fixture)
    _payload_, reads = _payload(state, 900, 1000)
    a = reads["wrapA"]
    assert _positive(a["intervals"]) == [[50, 100, 100]]
    assert a["layers"]["msp"]["intervals"] == [[0, 40, 80]]
    assert [event[0] for event in reads["wrapB"]["deam"]] == [80]


def test_head_and_tail_in_one_window_are_one_read(fixture):
    state = _state(fixture)
    # 150..900 holds B's tail (to 200) and A's head (from 700) and tail (to 300).
    _payload_, reads = _payload(state, 150, 900)
    a = reads["wrapA"]
    assert _positive(a["intervals"]) == [[0, 10, 60], [600, 700, 100]]
    marks = [pos - 150 for pos in (fixture["m6a_tail"], fixture["m6a_head"]) if 150 <= pos < 900]
    assert a["methyl_m6a"] == marks
    # longE: head footprint 650..750 once; the tail's copy of the same
    # positions (its 1650..1700 footprint) is not drawn a second time.
    assert _positive(reads["longE"]["intervals"]) == [[500, 600, 100]]


def test_wrapped_view_draws_each_position_once(tmp_path):
    fixture = write_fixture(tmp_path)
    state = _state(fixture, flag_circular=True)
    payload, reads = _payload(state, 900, 1100)

    # plainC (100..300) is not in view; A, B and E are, once each.
    assert payload["total_overlapping"] == 3
    assert sorted(reads) == ["longE", "wrapA", "wrapB"]
    a = reads["wrapA"]
    positives = _positive(a["intervals"])
    # The origin-crossing footprint's halves meet at the seam, once each.
    assert positives == [[50, 100, 100], [100, 150, 100]]
    starts = [iv[0] for iv in a["intervals"]]
    assert starts == sorted(starts)
    for left, right in zip(a["intervals"], a["intervals"][1:]):
        assert left[1] <= right[0]
    assert a["layers"]["msp"]["intervals"] == [[0, 40, 80], [160, 200, 40]]
    assert [event[0] for event in reads["wrapB"]["deam"]] == [80, 110]


def _coverage(state, fixture, start, end, segments=None):
    from services.bam_handles import get_bam_handle
    from services.bigbed_handles import get_bigbed_handle

    return compute_binned_read_coverage(
        [state.get_dataset("wrap")], CONTIG, start, end, end - start,
        bam_handle_getter=get_bam_handle, bigbed_handle_getter=get_bigbed_handle,
        query_segments=segments,
    )["coverage"]


_COVERED = {
    "wrapA": [(700, 1000), (0, 300)],
    "wrapB": [(900, 1000), (0, 200)],
    "plainC": [(100, 300)],
    "longE": [(0, 1000)],
}


def _truth(position: int) -> int:
    pos = position % L
    return sum(any(lo <= pos < hi for lo, hi in spans) for spans in _COVERED.values())


def test_coverage_counts_wrapped_tails_once(fixture):
    state = _state(fixture)
    assert _coverage(state, fixture, 0, L) == [_truth(p) for p in range(L)]


def test_coverage_across_the_seam_counts_each_read_once(tmp_path):
    fixture = write_fixture(tmp_path)
    state = _state(fixture, flag_circular=True)
    segments = circular_query_segments_for_region(state, CONTIG, 900, 1100)
    assert _coverage(state, fixture, 900, 1100, segments) == [_truth(p) for p in range(900, 1100)]


def test_spanning_uses_the_projected_alignment(fixture):
    state = _state(fixture)
    reads = load_direct_reads_for_dataset(
        state, state.get_dataset("wrap"), chrom=CONTIG, start=0, end=200, spanning_only=True,
        include_methylation=False, ml_threshold=125, min_fp_quality=0, include_cigar=False,
        hide_terminal_gaps=False, terminal_gap_threshold=500, include_layers=False,
        requested_layers=None, include_layer_qualities=False, infer_legacy_layers=True,
        legacy_nuc_min_size=90,
    )
    assert {read["id"] for read in reads} == {"wrapA", "wrapB", "longE"}


def test_analysis_extent_of_a_wrapped_read(fixture):
    state = _state(fixture)
    working_set = state.build_working_set("wrap", CONTIG, 0, 200, spanning=False, include_layers=False)
    by_id = {read["id"]: read for read in working_set.reads}
    # Co-occupancy eligibility: A's alignment covers its wrapped tail
    # [-300, 300) here as well as its record's own 700..1300 (both parts are
    # in the broad window the working set is cut from), never the gap.
    assert read_reference_spans(by_id["wrapA"], 0) == [(-300, 300), (700, 1300)]
    assert read_reference_spans(by_id["plainC"], 0) == [(100, 300)]


def test_tp_circular_contig_is_flagged_circular_on_load(fixture):
    state = BrowserState(None)
    state.add_dataset("wrap", fixture["bam"])
    meta = state.circular_chroms.get(CONTIG)
    assert meta is not None and meta["source"] == "bam_topology" and meta["size"] == L


def _whole_contig_read(intervals):
    # A record 700..1300 on a 1000 bp contig seen over the whole contig: tail
    # [-300, 300) and head [700, 1300) leave a gap at 300..700 with no bases.
    return {"id": "r", "intervals": intervals,
            "reference_start": 700, "reference_end": 1300,
            "alignment_spans": [[-300, 300], [700, 1300]]}


def test_analysis_spans_are_both_parts_never_the_gap():
    read = _whole_contig_read([[50, 120, 70], [800, 900, 100]])
    assert read_reference_spans(read, 0) == [(-300, 300), (700, 1300)]


@pytest.mark.parametrize("intervals", [
    [[50, 120, 70], [800, 900, 100]],      # the tail part carries most of the shown extent
    [[10, 20, 10], [700, 1000, 300]],      # the head part does
])
def test_cooccupancy_eligibility_of_a_read_in_two_parts(intervals):
    # Review finding (HIGH): one part stood for the whole read, so a site in
    # the gap was eligible (the negative tail extent read as "unknown") or a
    # site in the other part was not.
    table = build_interval_table([_whole_contig_read(intervals)], lambda r: r["intervals"], 0)
    groups = [dict(referenceAbsStart=10, referenceAbsEnd=20),     # tail part
              dict(referenceAbsStart=400, referenceAbsEnd=500),   # the gap
              dict(referenceAbsStart=800, referenceAbsEnd=900)]   # head part
    result = compute_cooccupancy_result(table, groups, [], fisher_exact_func=lambda t: (1.0, 1.0))
    assert [g["eligible_reads"] for g in result["per_group"]] == [1, 0, 1]
    assert result["per_group"][1]["ids_without"] == []
    # Only the pair of covered sites is tested.
    assert [(p["group_i"], p["group_j"]) for p in result["pairs"]] == [(0, 2)]


def test_negative_extent_is_data_and_unknown_extent_stays_eligible():
    reads = [{"id": "tail", "intervals": [[0, 60, -60]], "alignment_spans": [[-300, 60]]},
             {"id": "unknown", "intervals": []}]
    table = build_interval_table(reads, lambda r: r["intervals"], 0)
    groups = [dict(referenceAbsStart=10, referenceAbsEnd=20), dict(referenceAbsStart=100, referenceAbsEnd=120)]
    result = compute_cooccupancy_result(table, groups, [], fisher_exact_func=lambda t: (1.0, 1.0))
    # The tail (a negative start) covers 10..20: eligible, not "unknown".
    assert result["per_group"][0]["ids_without"] == ["tail", "unknown"]
    assert result["per_group"][1]["ids_without"] == ["unknown"]


@pytest.mark.parametrize("bins", [1, 2, 7, 1000])
def test_a_record_counts_once_per_coarse_coverage_bin(fixture, bins):
    # Review finding: a wrapped record's head and tail were joined per
    # position, then each disjoint piece was binned separately, so a coarse
    # bin holding both counted the record twice (6 instead of 4 in one bin).
    state = _state(fixture)
    from services.bam_handles import get_bam_handle
    from services.bigbed_handles import get_bigbed_handle

    result = compute_binned_read_coverage(
        [state.get_dataset("wrap")], CONTIG, 0, L, bins,
        bam_handle_getter=get_bam_handle, bigbed_handle_getter=get_bigbed_handle,
    )
    size = L / bins
    expected = []
    for b in range(bins):
        lo, hi = b * size, (b + 1) * size
        expected.append(sum(
            any(a < hi and z > lo for a, z in spans)
            for spans in _COVERED.values()))
    assert result["coverage"] == expected
    assert max(result["coverage"]) <= 4


def _multi_revolution_bam(tmp_path):
    # One record 500..2700 on the 1000 bp contig: 2.2 revolutions. Footprints
    # at 600..650 (first revolution), 1200..1250 (second: shown at 200..250)
    # and 2200..2250 (third: the same positions again, 200..250).
    seq = _sequence()
    ext = seq * 3
    header = pysam.AlignmentHeader.from_dict(
        {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": L, "TP": "circular"}]})
    read = _record(header, "multi", 500, 2200, ext, tags={
        "ns": array("i", [100, 700, 1700]), "nl": array("i", [50, 50, 50]), "nq": array("B", [10, 20, 30]),
    })
    path = tmp_path / "multi.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        out.write(read)
    pysam.index(str(path))
    return str(path)


@pytest.mark.parametrize("window", [(0, L), (300, 700), (0, 200)])
def test_multiple_revolutions_show_each_position_once(tmp_path, window):
    # Review finding: every tail pass was cropped at the record's own start,
    # so the second and third revolutions both drew positions 0..499.
    from services.compact_read_loader import build_compact_reads_from_bam

    start, end = window
    rows = build_compact_reads_from_bam(
        _multi_revolution_bam(tmp_path), CONTIG, start, end, spanning_only=False, include_layers=True,
        hide_terminal_gaps=False)
    assert len(rows) == 1
    intervals = rows[0]["intervals"]
    depth = [sum(a <= p < b for a, b, _size in intervals) for p in range(end - start)]
    assert depth == [1] * (end - start)
    # The one footprint at each position, with its own quality.
    expected = [(a - start, b - start, q) for a, b, q in ((200, 250, 20), (600, 650, 10))
                if a >= start and b <= end]
    positive = [(iv[0], iv[1], q) for iv, q in zip([iv for iv in intervals if iv[2] > 0], rows[0].get("qualities", []))]
    assert positive == expected


def _duplicate_bam(path, copies=2):
    header = pysam.AlignmentHeader.from_dict(
        {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": L, "TP": "circular"}]})
    ext = _sequence() * 2
    read = _record(header, "same", 900, 300, ext, tags={
        "ns": array("i", [50]), "nl": array("i", [100]), "nq": array("B", [40])})
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for _ in range(copies):
            out.write(read)
    pysam.index(str(path))
    return str(path)


def test_identical_records_remain_distinct_across_origin(tmp_path):
    # Review finding: the wrapped view merged its segments' rows by read name,
    # so two identical primary records became one row with doubled intervals
    # and no record identity, while a linear window showed two.
    state = BrowserState(None)
    state.add_dataset("duplicates", _duplicate_bam(tmp_path / "duplicates.bam"))
    within = state.build_working_set("duplicates", CONTIG, 0, 100, include_layers=False)
    seam = state.build_working_set("duplicates", CONTIG, 900, 1100, include_layers=False)
    assert len(within.reads) == len(seam.reads) == 2
    assert {read["alignment_occurrence"] for read in seam.reads} == {0, 1}
    for read in seam.reads:
        assert read["record_sha256"] and read["reference_start"] == 900
        # One record's footprint 950..1050, its halves either side of the seam once each.
        assert _positive(read["intervals"]) == [[50, 100, 100], [100, 150, 100]]
        assert [900, 1200] in read["alignment_spans"]


def test_same_name_in_two_files_stays_two_rows_across_origin(tmp_path):
    state = BrowserState(None)
    state.add_dataset("pair", [_duplicate_bam(tmp_path / "a.bam", 1), _duplicate_bam(tmp_path / "b.bam", 1)])
    seam = state.build_working_set("pair", CONTIG, 900, 1100, include_layers=False)
    assert len(seam.reads) == 2
    assert len({read["library_id"] for read in seam.reads}) == 2


def test_wrapped_view_rows_carry_logical_alignment_spans(tmp_path):
    fixture = write_fixture(tmp_path)
    state = _state(fixture, flag_circular=True)
    working_set = state.build_working_set("wrap", CONTIG, -100, 100, include_layers=False)
    by_id = {read["id"]: read for read in working_set.reads}
    # wrapA (700..1300) is at -300..300 in this view's coordinates; plainC
    # (100..300) is not in it.
    assert by_id["wrapA"]["record_sha256"]
    assert [-300, 300] in by_id["wrapA"]["alignment_spans"]
    table = build_interval_table(working_set.reads, lambda r: r["intervals"], -100)
    from services.footprint_analysis import reads_covering
    assert "wrapA" in reads_covering(table, (-50, 50))
    assert "wrapB" in reads_covering(table, (-50, 50))      # 900..1200 -> -100..200


def test_circular_toggle_does_not_reuse_linear_caches(tmp_path):
    # Review finding: coverage, broad-read, working-set and direct-read cache
    # keys left out the contig's topology, so turning circular mode on for a
    # BAM without TP:circular kept serving the linear reads and coverage of an
    # interior window (same query segments either way).
    from services.read_auxiliary_endpoint import get_coverage_payload

    fixture = write_fixture(tmp_path, topology=False)
    state = _state(fixture)
    linear_ids = {"plainC"}
    circular_ids = {"plainC", "longE", "wrapA", "wrapB"}

    def snapshot():
        coverage = get_coverage_payload(state, chrom=CONTIG, start=0, end=200, bins=200)["coverage"]
        working = {r["id"] for r in state.build_working_set("wrap", CONTIG, 0, 200, include_layers=False).reads}
        display = set(_payload(state, 0, 200)[1])
        direct = set(_payload(state, 0, 200, include_cigar=True)[1])
        return coverage[0], working, display, direct

    assert snapshot() == (0, linear_ids, linear_ids, linear_ids)
    state.set_circular_chrom(CONTIG, size=L)
    assert snapshot() == (_truth(0), circular_ids, circular_ids, circular_ids)
    state.clear_circular_chroms()
    assert snapshot() == (0, linear_ids, linear_ids, linear_ids)


def test_a_wrapped_tail_with_nothing_drawn_still_counts_as_covered(tmp_path):
    # A record 900..1060 whose only footprint is in its head: its 60 bp tail
    # (0..60) is a hidden terminal gap, so no tail part is drawn, but the
    # record's bases are there: co-occupancy must count it at a site in the
    # tail (real pipeline BAMs have many such records).
    header = pysam.AlignmentHeader.from_dict(
        {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": L, "TP": "circular"}]})
    read = _record(header, "short_tail", 900, 160, _sequence() * 2, tags={
        "ns": array("i", [20]), "nl": array("i", [60]), "nq": array("B", [50])})
    path = tmp_path / "short_tail.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        out.write(read)
    pysam.index(str(path))
    state = BrowserState(None)
    state.add_dataset("short", str(path))
    from services.footprint_analysis import reads_covering

    for start, end in ((0, L), (-100, 100)):
        working_set = state.build_working_set("short", CONTIG, start, end, include_layers=False)
        (row,) = working_set.reads
        table = build_interval_table(working_set.reads, lambda r: r["intervals"], start)
        assert reads_covering(table, (10, 20)) == {"short_tail"}
        assert reads_covering(table, (100, 120)) == set()


def test_join_keeps_identical_records_without_a_digest_apart():
    # Read adapters without SAM serialization carry no record digest: two
    # identical records must still be two rows, head and tail joined in order.
    from services.compact_read_loader import _join_wrapped_parts

    def row(start, end):
        return {"id": "a", "reference_start": 900, "reference_end": 1100,
                "alignment_orientation": "forward", "intervals": [[start, end, -(end - start)]]}

    joined = _join_wrapped_parts(
        [row(900, 1000), row(900, 1000)], [(L, [row(0, 100), row(0, 100)])], 0, L, False, wrap_length=L)
    assert len(joined) == 2
    for read in joined:
        assert [iv[:2] for iv in read["intervals"]] == [[0, 100], [900, 1000]]
        assert read["alignment_spans"] == [[900, 1100], [-100, 100]]
