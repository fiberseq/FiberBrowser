"""Insertion lens: carriers' calls and marks in insertion-local coordinates.

The fixture (tests/insertion_fixtures.py) plants every nucleosome, TF footprint
and m6A mark in SEQ-frame query coordinates, writes them as FiberHMM does
(MA/AQ in molecular frame, legacy ns/nl, MM/ML on the original molecule), and
the lens must give them back at ``query - q_insert`` on both strands.
"""
from __future__ import annotations

import array
import json

import numpy as np
import pysam
import pytest

from insertion_fixtures import SITE, make_insertion_bam
from services.insertion_consensus import (
    OP_INS, OP_MATCH, align, build_consensus, consensus_with_knots, encode, read_to_consensus_knots,
)
from services.insertion_lens import (
    build_lens,
    insertion_span,
    to_lens_local,
    find_clusters,
    splice_cigar,
    splice_clip,
    splice_md,
    splice_read,
    split_at_breakpoints,
)
from services.sv_events import classify_allele_evidence, extract_sv_events

FLANK = 1000
LOADER = {"include_methylation": True, "include_layers": True}


@pytest.fixture(scope="module")
def fixture(tmp_path_factory):
    return make_insertion_bam(tmp_path_factory.mktemp("insertion"))


@pytest.fixture(scope="module")
def lens(fixture):
    return build_lens([fixture["bam"]], "chrT", pos=SITE, len_min=1000, flank=FLANK, loader_kwargs=LOADER)


def _local_expected(intervals, q0, lo, hi):
    """Truth (query start, length) -> lens-local [s, e) clipped to [lo, hi)."""
    out = []
    for s, n in intervals:
        a, b = max(s - q0, lo), min(s - q0 + n, hi)
        if b > a:
            out.append((a, b))
    return sorted(out)


def _merge_pieces(intervals):
    """Rejoin pieces split at breakpoints (abutting, same size) into whole calls."""
    out = []
    for s, e, *rest in sorted(intervals):
        if out and out[-1][1] == s and out[-1][2] == (rest[0] if rest else None):
            out[-1][1] = e
        else:
            out.append([s, e, rest[0] if rest else None])
    return [(s, e) for s, e, _ in out]


# ---------------------------------------------------------------------------
# Events, splicing


def _cigar_carriers(lens):
    return [c for c in lens["carriers"] if c.get("kind") == "cigar"]


def test_insertion_span_walks_a_joined_insertion():
    # The SV schema joins 900I 3M 1100I into one event of 2003 query bases.
    cigar = [(4, 5), (0, 100), (1, 900), (0, 3), (1, 1100), (0, 50)]
    assert insertion_span(cigar, 1000, 105, 2003) == (1103, 2)
    assert insertion_span([(0, 10), (1, 50), (0, 10)], 0, 10, 50) == (10, 1)


def test_splice_cigar_turns_the_insert_span_into_one_block():
    assert splice_cigar([(0, 10), (1, 5), (0, 10)], 0, {"q": 10, "len": 5}) == [(0, 25)]
    merged = [(4, 2), (0, 10), (1, 5), (0, 3), (1, 4), (2, 1), (0, 6)]
    # The span runs from the first inserted base to the last: 5 + 3 + 4 query bases.
    assert splice_cigar(merged, 0, {"q": 12, "len": 12}) == [(4, 2), (0, 22), (2, 1), (0, 6)]
    with pytest.raises(ValueError):
        splice_cigar([(0, 10), (1, 5), (0, 10)], 0, {"q": 3, "len": 5})


def test_splice_md_keeps_flank_mismatches_in_place():
    simple = [(0, 10), (1, 5), (0, 10)]
    # 10M5I10M over 20 reference bases with mismatches at ref offsets 3 and 14.
    assert splice_md("3A10T5", simple, {"q": 10, "len": 5}) == "3A15T5"
    assert splice_md("10^AC10", [(0, 10), (1, 4), (2, 2), (0, 10)], {"q": 10, "len": 4}) == "14^AC10"
    # A merged insert: its bridge bases stay aligned (their mismatch is kept);
    # a deletion inside the span disappears with it.
    merged = [(0, 10), (1, 5), (0, 3), (2, 2), (1, 4), (0, 10)]
    assert splice_md("11G1^TT10", merged, {"q": 10, "len": 12}) == "16G15"
    # N consumes reference but no MD bases (Codex: offsets must come from the CIGAR walk).
    assert splice_md("20C19", [(0, 10), (3, 100), (0, 10), (1, 60), (0, 20)], {"q": 20, "len": 60}) == "80C19"
    with pytest.raises(ValueError):
        splice_md("20", [(0, 20)], {"q": 3, "len": 5})


def test_spliced_merged_read_keeps_a_bridge_mismatch_on_both_strands():
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "c", "LN": 1000}]})
    ref = "ACGT" * 25 + "CCC" + "ACGT" * 25
    for reverse in (False, True):
        read = pysam.AlignedSegment(header)
        read.query_name = "r"
        bridge = "CTC"  # C>T at the bridge's middle base
        read.query_sequence = ref[:100] + "G" * 60 + bridge + "G" * 60 + ref[103:]
        read.flag = 16 if reverse else 0
        read.reference_id = 0
        read.reference_start = 0
        read.cigartuples = [(0, 100), (1, 60), (0, 3), (1, 60), (0, 100)]
        read.set_tag("MD", "101C101")
        event = next(e for e in extract_sv_events(read, 50) if e["t"] == "I")
        assert (event["ref"], event["len"], event["alt_len"], event["q"]) == (100, 120, 123, 100)
        assert insertion_span(read.cigartuples, 0, event["q"], event["alt_len"]) == (103, 2)
        spliced = splice_read(read, event)
        assert spliced.cigarstring == "323M"
        lower = {q: base for q, _r, base in spliced.get_aligned_pairs(with_seq=True) if base and base.islower()}
        assert lower == {161: "c"}


def test_spliced_read_reports_the_reference_bases_of_its_flanks():
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "c", "LN": 1000}]})
    ref = "ACGTACGTAC" + "GGGGGCCCCC"
    read = pysam.AlignedSegment(header)
    read.query_name = "r"
    # Query: 10 ref bases (mismatch at 3), 5 inserted, 10 ref bases (mismatch at 14).
    q = list(ref[:10]) + list("TTTTT") + list(ref[10:])
    q[3] = "C"
    q[15 + 4] = "A"
    read.query_sequence = "".join(q)
    read.reference_id = 0
    read.reference_start = 100
    read.cigartuples = [(0, 10), (1, 5), (0, 10)]
    read.set_tag("MD", "3T10C5")
    spliced = splice_read(read, {"ref": 110, "ref_end": 110, "q": 10, "len": 5})
    assert spliced.cigarstring == "25M" and read.cigarstring == "10M5I10M"
    pairs = spliced.get_aligned_pairs(with_seq=True)
    lower = {qpos: base for qpos, _rpos, base in pairs if base and base.islower()}
    assert lower == {3: "t", 19: "c"}


def test_split_at_breakpoints_keeps_size_and_parallel_lists():
    read = {
        "intervals": [[-60, 87, 147], [200, 300, 100]],
        "qualities": [[10], [20]],
        "layers": {
            "nuc": {"intervals": [[-60, 87, 147], [600, 747, 147]], "qualities": [[200, 180], [5, 6]],
                    "quality_names": ["nq", "lq"], "source_intervals": [[1, 147], [700, 147]]},
            "msp": {"intervals": [[-30, 520, 550]], "qualities": None, "quality_names": []},
        },
        "fire": [[-10, 10, 128]],
    }
    out = split_at_breakpoints(read, 500)
    assert out["intervals"] == [[-60, 0, 147], [0, 87, 147], [200, 300, 100]]
    assert out["qualities"] == [[10], [10], [20]]
    assert out["layers"]["nuc"]["intervals"] == [[-60, 0, 147], [0, 87, 147], [600, 747, 147]]
    # Channel-major qualities: each channel follows the pieces.
    assert out["layers"]["nuc"]["qualities"] == [[200, 200, 180], [5, 5, 6]]
    assert out["layers"]["nuc"]["source_intervals"] == [[1, 147], [1, 147], [700, 147]]
    assert out["layers"]["nuc"]["quality_names"] == ["nq", "lq"]
    # An MSP across the whole (short) insert is cut at both breakpoints.
    assert out["layers"]["msp"]["intervals"] == [[-30, 0, 550], [0, 500, 550], [500, 520, 550]]
    assert out["fire"] == [[-10, 0, 128], [0, 10, 128]]
    sides = {(s["layer"], s["side"]) for s in out["straddles"]}
    assert sides == {("primary", "L"), ("nuc", "L"), ("msp", "LR"), ("fire", "L")}


# ---------------------------------------------------------------------------
# The lens on the fixture


def test_site_reads_are_split_into_carriers_reference_and_excluded(lens, fixture):
    carriers = {k for k, v in fixture["reads"].items() if v["kind"] == "carrier"}
    clipped = {k for k, v in fixture["reads"].items() if v["kind"] == "clip"}
    reference = {k for k, v in fixture["reads"].items() if v["kind"] == "reference"}
    assert {c["id"] for c in _cigar_carriers(lens)} == carriers
    assert {c["id"] for c in lens["carriers"] if c["kind"] == "clip"} == clipped
    assert {r["id"] for r in lens["reference"]} == reference
    # The read clipped 500 bp away does not reach the site: the lens never sees it.
    assert lens["excluded"] == {"other_insert": 1, "not_informative": 0}
    cluster = lens["cluster"]
    assert cluster["carriers"] == len(carriers)
    assert cluster['ambiguous'] == len(clipped)
    assert (cluster["cigar"], cluster["clipped"], cluster["hard"]) == (len(carriers), len(clipped), 1)
    lengths = [fixture["reads"][c]["len"] for c in carriers]
    assert cluster["len_lo"] == min(lengths) and cluster["len_hi"] == max(lengths)
    assert {c["strand"] for c in lens["carriers"]} == {"+", "-"}
    assert lens["sv"]["t"] == "I" and abs(lens["sv"]["ref"] - SITE) <= 5


@pytest.mark.parametrize("strand", ["+", "-"])
def test_insert_calls_are_in_insert_local_coordinates(lens, fixture, strand):
    checked = 0
    for carrier in _cigar_carriers(lens):
        if carrier["strand"] != strand:
            continue
        truth = fixture["reads"][carrier["id"]]
        q0, length = truth["q"], truth["len"]
        assert carrier["len"] == length and carrier["q"] == q0 and carrier["ref"] == truth["bp"]
        layers = carrier["read"]["layers"]
        lo, hi = -FLANK, length + FLANK
        assert _merge_pieces(layers["nuc"]["intervals"]) == _local_expected(truth["nucs"], q0, lo, hi)
        assert sorted((s, e) for s, e, _ in layers["tf"]["intervals"]) == _local_expected(truth["tfs"], q0, lo, hi)
        # Nothing is drawn at a breakpoint that is not there.
        for s, e, _ in layers["nuc"]["intervals"] + layers["msp"]["intervals"]:
            assert not (s < 0 < e) and not (s < length < e)
        checked += 1
    assert checked >= 10


@pytest.mark.parametrize("strand", ["+", "-"])
def test_m6a_marks_are_in_insert_local_coordinates(lens, fixture, strand):
    for carrier in (c for c in _cigar_carriers(lens) if c["strand"] == strand):
        truth = fixture["reads"][carrier["id"]]
        q0, length = truth["q"], truth["len"]
        got = set(carrier["read"]["methyl_m6a"])
        expected = {p - q0 for p in truth["m6a"] if -FLANK < p - q0 < length + FLANK - 1}
        assert expected and expected <= got <= expected | {-FLANK, length + FLANK - 1}
        inside = [p for p in got if 0 <= p < length]
        # The open patch (62–82% of the insert) is far denser than the packed body.
        open_lo, open_hi = int(0.62 * length), int(0.82 * length)
        dense = sum(open_lo <= p < open_hi for p in inside) / (open_hi - open_lo)
        packed = sum(p < open_lo for p in inside) / open_lo
        assert dense > 3 * packed


def test_calls_straddling_breakpoints_are_split_and_keep_their_size(lens):
    for carrier in _cigar_carriers(lens):
        length = carrier["len"]
        nuc = carrier["read"]["layers"]["nuc"]
        assert [-60, 0, 147] in nuc["intervals"] and [0, 87, 147] in nuc["intervals"]
        assert [length - 70, length, 147] in nuc["intervals"] and [length, length + 77, 147] in nuc["intervals"]
        assert all(len(channel) == len(nuc["intervals"]) for channel in nuc["qualities"])
        straddles = [s for s in carrier["read"]["straddles"] if s["layer"] == "nuc"]
        assert {(s["start"], s["end"], s["side"]) for s in straddles} == {
            (-60, 87, "L"), (length - 70, length + 77, "R")}


def test_a_split_insert_is_one_event_and_its_right_flank_lines_up(lens, fixture):
    carrier = next(c for c in _cigar_carriers(lens) if fixture["reads"][c["id"]]["pieces"] == 2)
    truth = fixture["reads"][carrier["id"]]
    assert carrier["pieces"] == 2 and carrier["ref_end"] == carrier["ref"] + 3
    assert carrier["len"] == truth["len"]
    # Right-flank nucleosomes sit at the same distance from the right breakpoint as on other carriers.
    def right_flank(c):
        return [s - c["len"] for s, e, _ in c["read"]["layers"]["nuc"]["intervals"] if s > c["len"]]
    other = next(c for c in _cigar_carriers(lens) if c["id"] != carrier["id"] and c["ref"] == SITE)
    # The same genomic nucleosomes, at the same reference positions (breakpoint + offset).
    assert [x + carrier["ref_end"] for x in right_flank(carrier)[:3]] == [
        x + other["ref_end"] for x in right_flank(other)[:3]]


def test_reference_reads_have_flanks_only(lens, fixture):
    for ref_read in lens["reference"]:
        truth = fixture["reads"][ref_read["id"]]
        assert ref_read["len"] == 0
        nuc = ref_read["read"]["layers"]["nuc"]["intervals"]
        expected = _local_expected(truth["nucs"], SITE - truth["read_start"], -FLANK, FLANK)
        assert _merge_pieces(nuc) == expected
        assert [-60, 0, 147] in nuc and [0, 87, 147] in nuc


def test_length_range_selects_the_cluster(fixture):
    # 100-500 bp at the site is the 300 bp allele; the 2 kb carriers are another insertion there.
    short = build_lens([fixture["bam"]], "chrT", pos=SITE, len_min=100, len_max=500,
                       flank=200, consensus=False, loader_kwargs=LOADER)
    assert short["sv"]["len"] == 300
    assert {c["id"] for c in short["carriers"] if c["kind"] == "cigar"} == {"other_insert_00"}
    n_long = sum(1 for v in fixture["reads"].values() if v["kind"] == "carrier")
    assert short["excluded"]["other_insert"] == n_long
    none = build_lens([fixture["bam"]], "chrT", pos=SITE, len_min=5000, flank=200, consensus=False,
                      loader_kwargs=LOADER)
    assert none["success"] is False and "5000 bp" in none["error"]


def test_consensus_recovers_the_element_and_maps_every_read(lens, fixture):
    cons = lens["consensus"]["seq"]
    ops = align(cons, fixture["te"])
    assert int((ops != OP_MATCH).sum()) <= 0.01 * len(fixture["te"])
    for carrier in _cigar_carriers(lens):
        knots = carrier["knots"]
        assert knots[0] == [0, 0] and knots[-1] == [carrier["len"], len(cons)]
        assert all(a[0] <= b[0] and a[1] <= b[1] for a, b in zip(knots, knots[1:]))
        assert carrier["identity"] > 0.9


def test_consensus_of_jittered_copies():
    rng = np.random.default_rng(3)
    truth = "".join(rng.choice(list("ACGT"), 1500))
    reads = []
    for _ in range(15):
        chars = list(truth)
        for _ in range(40):
            i = int(rng.integers(0, len(chars)))
            if rng.random() < 0.5:
                del chars[i]
            else:
                chars.insert(i, str(rng.choice(list("ACGT"))))
        reads.append("".join(chars))
    assert build_consensus(reads) == truth
    result = consensus_with_knots(reads[:3])
    assert len(result["reads"]) == 3 and result["seq"]
    assert build_consensus([]) == "" and build_consensus(["acgt"]) == "ACGT"


def test_payload_is_compact_and_sequences_only_on_request(lens, fixture):
    assert all("seq" not in c for c in lens["carriers"])
    assert all("record_sha256" not in c["read"] for c in lens["carriers"])
    size = len(json.dumps(lens))
    per_read = size / (len(lens["carriers"]) + len(lens["reference"]))
    assert per_read < 8_000, per_read
    with_seq = build_lens([fixture["bam"]], "chrT", pos=SITE, len_min=1000, flank=100,
                          consensus=False, include_sequences=True, loader_kwargs=LOADER)
    for carrier in with_seq["carriers"]:
        truth = fixture["reads"][carrier["id"]]
        if truth.get("hard"):
            assert "seq" not in carrier and carrier["len"] == 0
        else:
            assert carrier["seq"] == truth["insert_seq"]


def test_find_clusters_lists_the_insertion(fixture):
    clusters = find_clusters([fixture["bam"]], "chrT", SITE - 500, SITE + 500, min_len=100)
    big = max(clusters, key=lambda c: c["carriers"])
    carriers = sum(1 for v in fixture["reads"].values() if v["kind"] == "carrier")
    clipped = sum(1 for v in fixture["reads"].values() if v["kind"] == "clip")
    assert big["carriers"] == carriers and big["clip_support"] == 0
    assert big["ambiguous"] == clipped
    assert abs(big["ref"] - SITE) <= 5 and 1900 < big["len"] < 2100
    assert any(c["len"] == 300 for c in clusters)


# ---------------------------------------------------------------------------
# Endpoints


def test_insertion_endpoints(client, fixture):
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    dataset = resp.json()["dataset"]
    try:
        resp = client.get("/api/insertions/clusters", params={
            "chrom": "chrT", "start": SITE - 1000, "end": SITE + 1000, "dataset_id": dataset["id"], "min_len": 500})
        assert resp.status_code == 200, resp.text
        clusters = resp.json()["clusters"]
        assert len(clusters) == 1 and clusters[0]["carriers"] == 24 and clusters[0]["clip_support"] == 0
        resp = client.get("/api/insertions/lens", params={
            "chrom": "chrT", "pos": clusters[0]["ref"], "dataset_id": dataset["id"],
            "ref": clusters[0]["ref"], "length": clusters[0]["len"], "flank": 500,
            "layer_names": "nuc,msp,tf"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success"] and len(data["carriers"]) == 27 and data["consensus"]["length"] > 1900
        assert data["flank"] == 500
        resp = client.get("/api/insertions/lens", params={"chrom": "chrT", "pos": SITE, "dataset_id": "nope"})
        assert resp.json()["success"] is False
        resp = client.get("/api/insertions/clusters", params={
            "chrom": "chrT", "start": 0, "end": 3_000_000, "dataset_id": dataset["id"]})
        assert resp.json()["success"] is False
    finally:
        client.delete(f"/api/datasets/{dataset['id']}")


# ---------------------------------------------------------------------------
# Codex review regressions


def test_identity_counts_equal_bases_only():
    result = consensus_with_knots(["AAAAAAAAAA", "AAAAAAAAAA", "TTTTTTTTTT"])
    assert result["seq"] == "AAAAAAAAAA"
    assert result["reads"][2]["identity"] == 0.0 and result["reads"][0]["identity"] == 1.0


def test_knots_place_a_leading_consensus_gap_exactly():
    ops = np.array([OP_INS] * 10 + [OP_MATCH] * 100, dtype=np.uint8)
    knots, _ = read_to_consensus_knots(ops)
    assert knots[0] == [0, 10] and knots[-1] == [100, 110]
    reads = [k[0] for k in knots]
    assert reads == sorted(set(reads))
    a = encode("ACGT" * 25)
    b = encode("T" * 10 + "ACGT" * 25)
    knots, identity = read_to_consensus_knots(align(a, b), a, b)
    assert knots[0] == [0, 10] and identity == pytest.approx(100 / 110)


def test_read_limits_apply_across_files_and_zero_means_none(fixture):
    # The same reads in two files are one read each (by name, as the allele split counts them).
    both = build_lens([fixture["bam"], fixture["bam"]], "chrT", pos=SITE, len_min=1000, flank=100,
                      max_carriers=10, max_reference=0, consensus=False, loader_kwargs=LOADER)
    assert len(both["carriers"]) == 10 and both["cluster"]["carriers"] == 24
    assert both["truncated"] == {"carriers": 17, "reference": 16}
    assert both["reference"] == []
    # The cap keeps the kinds' proportions: CIGAR carriers and clipped ones both shown.
    assert {c["kind"] for c in both["carriers"]} == {"cigar", "clip"}


def test_a_rejected_insertion_at_the_site_is_not_reference():
    # 80 + 40 bp pieces 20 aligned bp apart: two events, neither the 2 kb insertion.
    read = {"id": "f", "reference_start": 0, "reference_end": 3000,
            "sv": [{"t": "I", "ref": 1140, "len": 80, "q": 1140}, {"t": "I", "ref": 1160, "len": 40, "q": 1240}]}
    assert classify_allele_evidence(read, "I", 1200, 2000) == (2, {"kind": "other"})
    plain = {"id": "g", "reference_start": 0, "reference_end": 3000, "sv": []}
    assert classify_allele_evidence(plain, "I", 1200, 2000) == (1, None)


def test_source_intervals_shift_with_their_calls():
    local = to_lens_local({"layers": {"tf": {
        "intervals": [[940, 1000, 147]], "source_intervals": [[940, 1087, 147]]}}}, 1000)
    assert local["layers"]["tf"]["intervals"] == [[-60, 0, 147]]
    assert local["layers"]["tf"]["source_intervals"] == [[-60, 87, 147]]


# ---------------------------------------------------------------------------
# Clipped carriers (soft clip + SA, hard clip) and the allele split


def test_a_right_soft_clip_shows_the_insert_start(lens, fixture):
    entry = next(c for c in lens["carriers"] if c["id"] == "clipped_00")
    truth = fixture["reads"]["clipped_00"]
    assert (entry["kind"], entry["partial"], entry["len"], entry["clip_len"]) == ("clip", "start", 600, 600)
    assert "hard" not in entry and entry["ref"] == SITE
    # Its marks: SEQ position p is lens-local p - q (the clip's first base is insert base 0).
    got = set(entry["read"]["methyl_m6a"])
    expected = {p - truth["q"] for p in truth["m6a"] if -FLANK < p - truth["q"] < 600}
    assert expected and expected <= got
    assert all(-FLANK <= p < 600 for p in got)
    # Partial knots start at the consensus's first base.
    assert entry["knots"][0][1] <= 2 and entry["identity"] > 0.95


def test_a_left_soft_clip_shows_the_insert_end_on_the_reverse_strand(lens, fixture):
    entry = next(c for c in lens["carriers"] if c["id"] == "clipped_left_00")
    truth = fixture["reads"]["clipped_left_00"]
    assert (entry["kind"], entry["partial"], entry["len"], entry["strand"]) == ("clip", "end", 700, "-")
    # The clip is the insert's last 700 bp: local 0..700; the genome after the site from 700 on.
    got = set(entry["read"]["methyl_m6a"])
    expected = {p for p in truth["m6a"] if p < 700 + FLANK - 1}
    assert expected and expected <= got | {700 + FLANK - 1}
    body = entry["read"]["layers"]["nuc"]["intervals"] + entry["read"]["layers"]["msp"]["intervals"]
    assert min(s for s, _e, *_ in body) == 0 and max(e for _s, e, *_ in body) <= 700 + FLANK
    cons_len = lens["consensus"]["length"]
    assert abs(entry["knots"][-1][1] - cons_len) <= 2 and entry["knots"][0][1] >= cons_len - 710


def test_a_hard_clip_is_a_carrier_without_inserted_bases(lens):
    entry = next(c for c in lens["carriers"] if c["id"] == "hard_right_00")
    assert entry["hard"] is True and entry["len"] == 0 and entry["sa"] is True and entry["clip_len"] == 900
    assert entry["partial"] == "start" and "knots" not in entry
    body = entry["read"]["layers"]["nuc"]["intervals"] + entry["read"]["layers"]["msp"]["intervals"]
    assert body and max(e for _s, e, *_ in body) <= 0  # its left flank only


def test_splice_clip_aligns_a_soft_clip_and_pads_md():
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "c", "LN": 10000}]})
    read = pysam.AlignedSegment(header)
    read.query_name = "r"
    read.query_sequence = "A" * 300
    read.reference_id = 0
    read.reference_start = 1000
    read.cigartuples = [(5, 7), (4, 100), (0, 150), (4, 50)]
    read.set_tag("MD", "10C139")
    left = splice_clip(read, "L")
    assert left.reference_start == 900 and left.cigartuples == [(5, 7), (0, 250), (4, 50)]
    assert left.get_tag("MD") == "110C139"
    right = splice_clip(read, "R")
    assert right.reference_start == 1000 and right.cigartuples == [(5, 7), (4, 100), (0, 200)]
    assert right.get_tag("MD") == "10C189"
    read.cigartuples = [(0, 300), (5, 40)]
    assert splice_clip(read, "R") is None


def test_lens_carriers_are_the_split_carriers(client, fixture):
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion-split"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    dataset = resp.json()["dataset"]
    try:
        lens = client.get("/api/insertions/lens", params={
            "chrom": "chrT", "pos": SITE, "dataset_id": dataset["id"], "len_min": 1000, "flank": 200,
            "consensus": "false", "max_carriers": 1000, "max_reference": 500}).json()
        assert lens["success"], lens
        sv = lens["sv"]
        split = client.post("/api/sv/split", json={
            "dataset_id": dataset["id"], "chrom": "chrT", "start": SITE - 5000, "end": SITE + 5000,
            "t": "I", "ref": sv["ref"], "len": sv["len"], "margin": sv["margin"]}).json()
        carriers = {name for name, allele in split["assignments"].items() if allele == 0}
        reference = {name for name, allele in split["assignments"].items() if allele == 1}
        assert carriers == {c["id"] for c in lens["carriers"] if c["evidence_level"] == "confirmed"}
        assert reference == {r["id"] for r in lens["reference"]}
        assert split["counts"][0] == lens["cluster"]["carriers"] == 24
        assert split["carriers_by"] == {"cigar": 24, "sa": 0, "clip": 0}
        assert split["assignments"]["clip_elsewhere_00"] == 2 and split["assignments"]["other_insert_00"] == 2
        # Opened on the cluster the SV summary reports, the lens has the same reads.
        again = client.get("/api/insertions/lens", params={
            "chrom": "chrT", "pos": SITE, "dataset_id": dataset["id"], "ref": sv["ref"], "length": sv["len"],
            "flank": 200, "consensus": "false", "max_carriers": 1000, "max_reference": 500}).json()
        assert {c["id"] for c in again["carriers"] if c["evidence_level"] == "confirmed"} == carriers
    finally:
        client.delete(f"/api/datasets/{dataset['id']}")


def test_the_split_scan_cache_extends_and_matches_a_fresh_scan(client, fixture):
    from services import sv_endpoint
    resp = client.post("/api/datasets/add", json={"path": fixture["bam"], "label": "insertion-scan"})
    dataset = resp.json()["dataset"]
    body = {"dataset_id": dataset["id"], "chrom": "chrT", "t": "I", "ref": SITE, "len": 2000}
    try:
        sv_endpoint._SCAN_CACHE.clear()
        first = client.post("/api/sv/split", json={**body, "start": SITE - 12_000, "end": SITE - 2_000}).json()
        # Overlapping the cached region: only the added part is read.
        calls = []
        real = sv_endpoint._scan
        sv_endpoint._scan = lambda *a, **k: calls.append(a[3:5]) or real(*a, **k)
        try:
            panned = client.post("/api/sv/split", json={**body, "start": SITE - 6_000, "end": SITE + 6_000}).json()
            inside = client.post("/api/sv/split", json={**body, "start": SITE - 1_000, "end": SITE + 1_000}).json()
        finally:
            sv_endpoint._scan = real
        assert calls == [(SITE - 2_000, SITE + 6_000)]
        sv_endpoint._SCAN_CACHE.clear()
        fresh = client.post("/api/sv/split", json={**body, "start": SITE - 6_000, "end": SITE + 6_000}).json()
        assert panned["assignments"] == fresh["assignments"] and panned["counts"] == fresh["counts"]
        assert sum(first["counts"]) > 0 and panned["counts"][0] == 24
        assert set(inside["assignments"]) <= set(panned["assignments"]) and inside["counts"][0] == 24
    finally:
        client.delete(f"/api/datasets/{dataset['id']}")


# ---------------------------------------------------------------------------
# Codex review of the integration (fb33)


def _tiny_bam(path, records, ref_len=20_000):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrX", "LN": ref_len}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, start, cigar in sorted(records, key=lambda r: r[1]):
            a = pysam.AlignedSegment(out.header)
            a.query_name = name
            qlen = sum(n for op, n in cigar if op in (0, 1, 4, 7, 8))
            a.query_sequence = "A" * qlen
            a.query_qualities = pysam.qualitystring_to_array("5" * qlen)
            a.reference_id = 0
            a.reference_start = start
            a.mapping_quality = 60
            a.cigartuples = cigar
            out.write(a)
    pysam.index(str(path))
    return str(path)


class _State:
    def __init__(self, paths):
        self.chrom_map = {}
        self._ds = type("D", (), {"paths": paths, "data_type": "bam"})()

    def get_dataset(self, _dataset_id):
        return self._ds


def test_the_scan_cache_keeps_same_named_records_of_merged_files(tmp_path, monkeypatch):
    from services import plasmid_reconcile, sv_endpoint
    a = _tiny_bam(tmp_path / "a.bam", [("same", 250, [(0, 200)])])
    b = _tiny_bam(tmp_path / "b.bam", [("same", 250, [(0, 50), (1, 100), (0, 50)])])
    monkeypatch.setattr(plasmid_reconcile, "contig_links", lambda *_a, **_k: None)
    state = _State([a, b])
    sv_endpoint._SCAN_CACHE.clear()
    cold = sv_endpoint.scan_view(state, "d", "chrX", 100, 400, 50)
    sv_endpoint._SCAN_CACHE.clear()
    sv_endpoint.scan_view(state, "d", "chrX", 100, 200, 50)
    extended = sv_endpoint.scan_view(state, "d", "chrX", 100, 400, 50)
    assert len(cold) == len(extended) == 2
    by = sv_endpoint.classify_compact(((c, c) for c in extended), t="I", ref=300, length=100)
    assert by["same"]["allele"] == 0
    # The contig links are part of the key: a new link is a new scan.
    calls = []
    monkeypatch.setattr(plasmid_reconcile, "contig_links", lambda *_a, **k: calls.append(k) or {"linked": True})
    sv_endpoint.scan_view(state, "d", "chrX", 100, 400, 50)
    assert len(sv_endpoint._SCAN_CACHE) == 2


def test_the_lens_fetches_far_enough_for_a_longer_matching_allele(tmp_path):
    # A 5 kb insertion 240 bp from a 4 kb cluster still matches (tolerance and
    # length follow the longer event); the lens must fetch it as the split does.
    bam = _tiny_bam(tmp_path / "c.bam", [("long", 1220, [(0, 20), (1, 5000), (0, 300)]),
                                          ("plain", 500, [(0, 1500)])])
    lens = build_lens([bam], "chrX", pos=1000, ref=1000, length=4000, flank=100, consensus=False,
                      loader_kwargs=LOADER)
    assert {c["id"] for c in lens["carriers"]} == {"long"}
    assert {r["id"] for r in lens["reference"]} == {"plain"}


# --- DAF: FiberHMM's deamination-aware consensus ---------------------------------

@pytest.fixture(scope="module")
def daf_fixture(tmp_path_factory):
    from insertion_fixtures import make_daf_insertion_bam
    return make_daf_insertion_bam(tmp_path_factory.mktemp("daf_insertion"))


def _open_c_columns(te: str, half: int) -> list[int]:
    return [i for i, b in enumerate(te[:half]) if b == "C"]


def test_the_daf_consensus_calls_heavily_deaminated_cs_where_a_majority_calls_t(daf_fixture):
    """80% of open Cs read T on the 24 C->T carriers (4 G->A): a majority vote calls them T;
    FiberHMM's DAF-aware consensus (the variability per strand) calls them C."""
    pytest.importorskip("fiberhmm.daf.insert_consensus")
    te, half = daf_fixture["te"], daf_fixture["open_half"]
    open_cs = _open_c_columns(te, half)
    assert len(open_cs) >= 20
    majority = build_lens([daf_fixture["bam"]], "chrD", pos=daf_fixture["site"], len_min=100, flank=200,
                          loader_kwargs=LOADER)
    assert majority["consensus"]["method"] == "majority" and "fallback" not in majority["consensus"]
    wrong = majority["consensus"]["seq"]
    assert len(wrong) == len(te)
    assert sum(wrong[i] == "T" for i in open_cs) > 0.8 * len(open_cs)  # the majority vote is wrong
    daf = build_lens([daf_fixture["bam"]], "chrD", pos=daf_fixture["site"], len_min=100, flank=200,
                     loader_kwargs=LOADER, daf=True)
    consensus = daf["consensus"]
    assert consensus["method"] == "daf" and consensus["method_label"] == "DAF-aware (FiberHMM)"
    assert consensus["seq"] == te  # every column right, the open Cs included
    assert consensus["carriers_ct"] == 24 and consensus["carriers_ga"] == 4 and consensus["n_reads"] == 28
    assert 0 < consensus["confident_fraction"] <= 1
    # Every carrier is still mapped onto the (DAF-aware) consensus.
    assert all(entry["knots"][-1][1] == len(te) for entry in daf["carriers"])


def test_the_lens_falls_back_to_a_majority_vote_without_fiberhmms_module(daf_fixture, monkeypatch):
    from services import insertion_consensus
    monkeypatch.setattr(insertion_consensus, "fiberhmm_insert_consensus", lambda: None)
    lens = build_lens([daf_fixture["bam"]], "chrD", pos=daf_fixture["site"], len_min=100, flank=200,
                      loader_kwargs=LOADER, daf=True)
    assert lens["consensus"]["method"] == "majority" and lens["consensus"]["method_label"] == "majority vote"
    assert "older than 3.0" in lens["consensus"]["fallback"]


def test_fiber_seq_keeps_the_majority_vote(lens):
    assert lens["consensus"]["method"] == "majority" and "fallback" not in lens["consensus"]
    assert "run_consensus" not in lens


def test_the_runs_insert_consensus_report_is_shown_beside_the_lens(daf_fixture, tmp_path):
    import os
    import shutil
    bam = tmp_path / "called.bam"
    shutil.copy(daf_fixture["bam"], bam)
    shutil.copy(daf_fixture["bam"] + ".bai", str(bam) + ".bai")
    os.makedirs(tmp_path / "qc")
    (tmp_path / "qc" / "called.insert_consensus.json").write_text(json.dumps({
        "schema": "fiberhmm.daf.insert_consensus.v1", "min_carriers": 20, "breakpoint_tolerance": 30,
        "insertions": [{"contig": "chrD", "pos": 2990, "length": 305, "carriers": 28, "carriers_ct": 24,
                        "carriers_ga": 4, "used": True, "consensus_length": 300, "confident_fraction": 0.93},
                       {"contig": "chrD", "pos": 5000, "length": 300, "carriers": 3, "used": False}]}))
    lens = build_lens([str(bam)], "chrD", pos=daf_fixture["site"], len_min=100, flank=200, consensus=False,
                      loader_kwargs=LOADER, daf=True)
    run = lens["run_consensus"]
    assert run["used"] and run["carriers"] == 28 and run["confident_fraction"] == 0.93
    assert run["path"] == str(tmp_path / "qc" / "called.insert_consensus.json")


def test_daf_datasets_are_told_by_their_chemistry():
    from types import SimpleNamespace
    from services.insertion_lens import _is_daf_dataset
    assert _is_daf_dataset(SimpleNamespace(consensus_chemistry="dddb"))
    assert _is_daf_dataset(SimpleNamespace(consensus_chemistry="ddda"))
    assert not _is_daf_dataset(SimpleNamespace(consensus_chemistry="hia5-pacbio"))
    assert _is_daf_dataset(SimpleNamespace(consensus_chemistry=None, available_layers={"deam": True, "m6a": False}))
    assert not _is_daf_dataset(SimpleNamespace(consensus_chemistry=None, available_layers={"m6a": True}))
    assert not _is_daf_dataset(None)


def test_joined_insertion_pieces_are_one_daf_carrier(tmp_path):
    """Codex review: the lens joins nearby CIGAR insertion pieces (50I 3M 50I) into one insert;
    FiberHMM's carriers are per I operation, so each lens carrier takes only its strand from
    FiberHMM and keeps the lens's span."""
    pytest.importorskip("fiberhmm.daf.insert_consensus")
    import random
    from services.insertion_consensus import daf_aware_consensus
    rng = random.Random(3)
    ref = "".join(rng.choice("ACGT") for _ in range(400))
    insert = "".join(rng.choice("ACGT") for _ in range(103))
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "c", "LN": 400}]})
    records = []
    for i in range(4):
        left, right = ref[0:100], ref[103:203]  # 100M, then the 3M bridge at ref 100-103, then 100M
        bridge = ref[100:103]
        conv = lambda seq: "".join("T" if b == "C" and rng.random() < 0.4 else b for b in seq)
        l2, r2 = conv(left), conv(right)
        read = pysam.AlignedSegment(header)
        read.query_name = f"r{i}"
        read.query_sequence = l2 + insert[:50] + bridge + insert[53:] + r2
        read.reference_id, read.reference_start, read.mapping_quality = 0, 0, 60
        read.cigartuples = [(0, 100), (1, 50), (0, 3), (1, 50), (0, 100)]
        aligned_read, aligned_ref = l2 + bridge + r2, left + bridge + right
        md, run = [], 0
        for got, want in zip(aligned_read, aligned_ref):
            if got == want:
                run += 1
            else:
                md.append(f"{run}{want}")
                run = 0
        read.set_tag("MD", "".join(md) + str(run))
        records.append((read, 100, 103))
    result, why = daf_aware_consensus(records)
    assert why is None and result["carriers_ct"] == 4 and result["carriers_ga"] == 0
    assert len(result["seq"]) == 103


def test_summary_variants_split_and_lens_deduplicate_the_same_molecules(tmp_path, monkeypatch):
    from services import plasmid_reconcile, sv_endpoint, variants_endpoint
    from services.sv_events import sv_summary_for_reads, sv_extraction_floor
    a = _tiny_bam(tmp_path / 'p0-a.bam', [
        ('seed', 100, [(0, 900), (1, 100), (0, 1000)]),
        ('clipped', 500, [(0, 500), (4, 60)]),
        ('plain', 0, [(0, 2000)]), ('conflicting', 0, [(0, 2000)]),
    ])
    b = _tiny_bam(tmp_path / 'p0-b.bam', [
        ('seed', 100, [(0, 900), (1, 100), (0, 1000)]),
        ('near', 100, [(0, 900), (1, 80), (0, 1000)]),
        ('conflicting', 100, [(0, 900), (1, 100), (0, 1000)]), ('plain', 0, [(0, 2000)]),
    ])
    monkeypatch.setattr(plasmid_reconcile, 'contig_links', lambda *_a, **_k: None)
    monkeypatch.setattr(variants_endpoint, '_scoped_state', lambda state, body: state)
    state = _State([a, b])
    records = []
    for path in [a, b]:
        with pysam.AlignmentFile(path) as bam:
            records.extend((r, 'chrX') for r in bam.fetch('chrX', 0, 2000))
    compact = [dict(id=r.query_name, reference_start=r.reference_start, reference_end=r.reference_end,
                    sv=extract_sv_events(r, sv_extraction_floor(50))) for r, _ in records]
    lens = build_lens([a, b], 'chrX', pos=1000, ref=1000, length=100,
                      flank=100, consensus=False, loader_kwargs=LOADER)
    split = sv_endpoint.sv_split_payload(state, dataset_id='d', chrom='chrX', start=0, end=2000,
                                         t='I', ref=1000, length=100)
    assert lens['cluster']['carriers'] == split['counts'][0] == 3
    assert lens['cluster']['reference'] == split['counts'][1] == 1
    assert {c['id'] for c in lens['carriers'] if c['evidence_level'] == 'confirmed'} == {n for n, allele in split['assignments'].items() if allele == 0}
    for cutoff in [50, 90]:
        summary = sv_summary_for_reads(compact, 0, 2000, cutoff)
        variants = variants_endpoint.svs_payload(state, dict(dataset_id='d', chrom='chrX', start=0, end=2000, min_len=cutoff))
        assert summary['clusters'] == variants['clusters']
        c = summary['clusters'][0]
        assert (c['support'], c['informative'], c['clip_support']) == (3, 4, 0)
        assert c['putative'] == 1
