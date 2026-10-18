"""Structural-variant events, clusters and allele split (fb-n9-sv)."""
from __future__ import annotations

import json
from pathlib import Path

import pysam
import pytest

from services import compact_read_loader
from services.sv_events import (
    SV_MIN_LEN_DEFAULT,
    classify_allele,
    cluster_sv_events,
    deletion_spans,
    events_match,
    extract_sv_events,
    finalize_sv_payload,
    has_large_indel,
    normalize_min_sv_len,
    parse_sa_tag,
    split_compact_read_at_deletions,
    sv_events_in_view,
    sv_summary_for_reads,
)
from tests.conftest import auth_headers
import sv_fixtures as fx


def _seg(cigar, start=1000, *, reverse=False, sa=None, supplementary=False, seq=None):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6"}, "SQ": [{"SN": "chrT", "LN": 100_000}]})
    a = pysam.AlignedSegment(header)
    a.query_name = "r"
    qlen = sum(n for op, n in cigar if op in (0, 1, 4, 7, 8))
    a.query_sequence = seq or ("ACGT" * (qlen // 4 + 1))[:qlen]
    a.flag = (16 if reverse else 0) | (2048 if supplementary else 0)
    a.reference_id = 0
    a.reference_start = start
    a.mapping_quality = 60
    a.cigartuples = cigar
    if sa:
        a.set_tag("SA", sa)
    return a


def test_frame_policy_error_propagates_through_public_compact_loader(sv_bam, monkeypatch):
    from services import bam_tags

    def broken(_header):
        raise RuntimeError('injected frame policy failure')

    monkeypatch.setattr(bam_tags, 'bam_ma_aq_tags_are_molecular', broken)
    with pytest.raises(bam_tags.FramePolicyError, match='injected frame policy') as error:
        compact_read_loader.build_compact_reads_from_bam(sv_bam, fx.CHROM, *fx.VIEW, spanning_only=False)
    assert isinstance(error.value.__cause__, RuntimeError)


def test_direct_endpoint_uses_display_cutoff_for_interval_cuts_and_cache(sv_client, monkeypatch):
    from services import read_endpoint
    client, _state = sv_client
    cutoffs = []
    original = read_endpoint.load_direct_reads_for_dataset

    def capture(*args, **kwargs):
        cutoffs.append(kwargs['sv_min_len'])
        return original(*args, **kwargs)

    monkeypatch.setattr(read_endpoint, 'load_direct_reads_for_dataset', capture)
    for cutoff in (50, 100):
        result = client.get('/api/reads/compact', params=dict(
            dataset_id='sv', chrom=fx.CHROM, start=fx.VIEW[0], end=fx.VIEW[1],
            include_duplicates=True, min_sv_len=cutoff, spanning=False))
        assert result.status_code == 200, result.text
    assert cutoffs == [50, 100]


def test_evidence_floor_does_not_cut_chromatin_at_sub_display_deletions():
    from models.domain import CigarCoordMapper
    a = _seg([(0, 100), (2, 15), (0, 100), (2, 60), (0, 100)])
    compact = {'id': 'synthetic', 'intervals': [[50, 300, 1]]}
    compact_read_loader._attach_sv_events(compact, a, 1000, sv_min_len=50,
                                        mapper=CigarCoordMapper(a.cigartuples, 1000))
    assert compact['intervals'] == [[50, 215, 1], [275, 300, 1]]
    assert [ev['len'] for ev in compact['sv']] == [15, 60]


def _seed(name, length, ref=1000):
    return dict(id=name, reference_start=0, reference_end=4000,
                sv=[dict(t='I', ref=ref, len=length, q=100)])


def test_cluster_targets_are_permutation_and_merged_file_order_invariant():
    import itertools
    rows = [_seed(str(i), length) for i, length in enumerate([100, 140, 120, 120, 120])]
    expected = sv_summary_for_reads(rows, 0, 4000, 50)
    for order in itertools.permutations(rows):
        assert sv_summary_for_reads(order, 0, 4000, 50) == expected
    for first, second in ((rows[:2], rows[2:]), (rows[2:], rows[:2])):
        assert sv_summary_for_reads(first + second + first, 0, 4000, 50)['clusters'] == expected['clusters']


def test_singleton_outlier_does_not_gain_a_shadow_cluster_after_reconciliation():
    rows = [_seed('low', 100), _seed('high', 140)] + [_seed(str(i), 120, 1001) for i in range(6)]
    clusters, _ = cluster_sv_events(rows, 0, 4000, 50)
    assert [(c['ref'], c['len'], len(c['members'])) for c in clusters] == [(1001, 120, 8)]


def test_shifted_duplicate_molecule_has_one_median_vote():
    rows = [_seed('duplicate', 100), _seed('other', 120)]
    expected = cluster_sv_events(rows, 0, 4000, 50)
    assert cluster_sv_events(rows + [_seed('duplicate', 101)], 0, 4000, 50) == expected
    assert expected[0][0]['len'] == 110


def test_cluster_reconciliation_respects_view_and_summary_skips_unused_members(monkeypatch):
    from services import sv_events
    rows = [_seed('in', 100, 1005), _seed('out', 100, 990)]
    assert cluster_sv_events(rows, 1000, 2000, 50)[0][0]['members'] == {'in'}
    original = sv_events.cluster_sv_events
    def checked(*args, **kwargs):
        assert kwargs['reconcile_members'] is False
        return original(*args, **kwargs)
    monkeypatch.setattr(sv_events, 'cluster_sv_events', checked)
    assert sv_summary_for_reads(rows, 1000, 2000, 50)['clusters'][0]['support'] == 2


# ---------------------------------------------------------------------------
# Extraction


def test_deletion_insertion_and_clips_in_absolute_coordinates():
    a = _seg([(4, 80), (0, 100), (2, 1500), (0, 50), (1, 400), (0, 30), (5, 60)], start=1000)
    ev = extract_sv_events(a, 50)
    assert ev == [
        {"t": "S", "side": "L", "ref": 1000, "len": 80, "q": 0},
        {"t": "D", "ref": 1100, "len": 1500, "q": 180},
        {"t": "I", "ref": 2650, "len": 400, "q": 230},
        # Right clip 60 bp, all hard: q is where SEQ ends.
        {"t": "S", "side": "R", "ref": 2680, "len": 60, "q": 660, "h": 1},
    ]


def test_threshold_is_inclusive_and_small_events_are_dropped():
    a = _seg([(0, 100), (2, 49), (0, 100), (1, 50), (0, 100), (4, 49)])
    ev = extract_sv_events(a, 50)
    assert [e["t"] for e in ev] == ["I"]
    assert extract_sv_events(a, 51) is None
    assert [e["t"] for e in extract_sv_events(a, 10)] == ["D", "I", "S"]


def test_split_pieces_of_one_deletion_are_joined():
    # 900D 2M 598D: one 1.5 kb deletion, as nanopore aligners write it.
    a = _seg([(0, 100), (2, 900), (0, 2), (2, 598), (0, 100)], start=0)
    event, = extract_sv_events(a, 50)
    assert (event['ref'], event['len'], event['ref_len'], event['alt_len']) == (100, 1498, 1500, 2)
    # Far apart: two deletions.
    b = _seg([(0, 100), (2, 900), (0, 40), (2, 598), (0, 100)], start=0)
    assert [(e["ref"], e["len"]) for e in extract_sv_events(b, 50)] == [(100, 900), (1040, 598)]


def test_insertion_seq_only_when_requested():
    a = _seg([(0, 10), (1, 60), (0, 10)], seq="C" * 10 + "G" * 60 + "C" * 10)
    assert "seq" not in extract_sv_events(a, 50)[0]
    assert extract_sv_events(a, 50, include_seq=True)[0]["seq"] == "G" * 60


def test_sa_tag_is_parsed_zero_based():
    a = _seg([(0, 500), (4, 2000)], sa="chr2L,11501,-,500S2000M,30,3;chrX,10,+,5M,0,0;")
    ev = extract_sv_events(a, 50)
    assert ev[0]["t"] == "S" and ev[0]["side"] == "R"
    assert ev[1:] == [
        {"t": "SA", "chrom": "chr2L", "pos": 11500, "strand": "-", "mapq": 30, "nm": 3, "cigar_ref_len": 2000,
         "supp": False, "same_strand": False, "q_start": 500, "q_end": 2500, "query_length": 2500},
        {"t": "SA", "chrom": "chrX", "pos": 9, "strand": "+", "mapq": 0, "nm": 0, "cigar_ref_len": 5,
         "supp": False, "same_strand": True, "q_start": 0, "q_end": 5, "query_length": 5},
    ]
    assert parse_sa_tag("bad;chr1,1,+,10M,60,0", supplementary=True)[0]["supp"] is True


def test_reads_without_large_events_carry_nothing():
    assert extract_sv_events(_seg([(0, 500)]), 50) is None
    assert not has_large_indel("100M49D100M", 50)
    assert has_large_indel("100M50D100M", 50)
    assert not has_large_indel("150M", 50)  # an M op of 150 is not an indel


def test_min_sv_len_is_clamped():
    assert normalize_min_sv_len(1) == 10
    assert normalize_min_sv_len("200") == 200
    assert normalize_min_sv_len(None) == SV_MIN_LEN_DEFAULT


def test_events_in_view_keep_overlapping_events_and_sa():
    ev = [{"t": "D", "ref": 100, "len": 500, "q": 0}, {"t": "I", "ref": 2000, "len": 60, "q": 1},
          {"t": "SA", "chrom": "c", "pos": 1, "strand": "+", "mapq": 1, "nm": 0, "cigar_ref_len": 1, "supp": False}]
    assert [e["t"] for e in sv_events_in_view(ev, 550, 1000, 50)] == ["D", "SA"]
    assert sv_events_in_view(ev, 700, 1000, 50) is None
    assert [e["t"] for e in sv_events_in_view(ev, 0, 3000, 100)] == ["D", "SA"]
    cached = {"id": "x", "sv": ev}
    out = finalize_sv_payload([cached], 700, 1000, 50)
    assert "sv" not in out[0] and cached["sv"] is ev  # the cached read is untouched


# ---------------------------------------------------------------------------
# Calls split at deletions


def test_split_keeps_size_and_aligned_qualities():
    read = {
        "intervals": [[0, 100, 100], [100, 120, -20], [120, 1767, 147], [1767, 1800, -33]],
        "qualities": [10, 20],
        "fire": [[1700, 1790, 200]],
        "layers": {"nuc": {"intervals": [[0, 100, 100], [120, 1767, 147]],
                           "qualities": [[1, 2], [3, 4]], "quality_names": ["nq", "lq"],
                           "annotation_names": ["a", "b"], "circular_ids": ["a", "b"],
                           "source_intervals": [[0, 100, 100], [120, 1767, 147]]}},
    }
    split_compact_read_at_deletions(read, [(190, 1690)])
    assert read["intervals"] == [[0, 100, 100], [100, 120, -20], [120, 190, 147], [1690, 1767, 147], [1767, 1800, -33]]
    assert read["qualities"] == [10, 20, 20]
    assert read["fire"] == [[1700, 1790, 200]]
    nuc = read["layers"]["nuc"]
    assert nuc["intervals"] == [[0, 100, 100], [120, 190, 147], [1690, 1767, 147]]
    assert nuc["qualities"] == [[1, 2, 2], [3, 4, 4]]
    assert nuc["quality_names"] == ["nq", "lq"]
    assert nuc["annotation_names"] == ["a", "b", "b"]
    assert nuc["source_intervals"] == [[0, 100, 100], [120, 190, 147], [1690, 1767, 147]]


@pytest.fixture(scope="module")
def sv_bam(tmp_path_factory):
    return fx.write_sv_bam(tmp_path_factory.mktemp("sv") / "sv.bam")


def _load(path, start=fx.VIEW[0], end=fx.VIEW[1], **kw):
    kw.setdefault("spanning_only", False)
    kw.setdefault("include_layers", True)
    return {r["id"]: r for r in compact_read_loader.build_compact_reads_from_bam(path, fx.CHROM, start, end, **kw)}


@pytest.mark.parametrize("name", ["sv/del0/ccs", "sv/del1/ccs", "sv/del3/ccs"])
def test_calls_spanning_a_deletion_are_split_on_both_strands(sv_bam, name):
    """ns/nl intervals, MA nuc/tf/msp layers: nothing inside the deleted span,
    and the nucleosome over the breakpoint is in two nucleosome-sized pieces."""
    start = fx.VIEW[0]
    read = _load(sv_bam, start=start)[name]
    (d,) = [e for e in read["sv"] if e["t"] == "D"]
    a, b = d["ref"] - start, d.get("raw_ref_end", d["ref"] + d["len"]) - start
    cuts = [(s-start, e-start) for s, e in deletion_spans([d])]
    for iv in read["intervals"]:
        assert all(iv[1] <= lo or iv[0] >= hi for lo, hi in cuts), iv
    for layer_name, layer in read["layers"].items():
        for iv in layer["intervals"]:
            assert all(iv[1] <= lo or iv[0] >= hi for lo, hi in cuts), (layer_name, iv)
    left = [iv for iv in read["layers"]["nuc"]["intervals"] if iv[1] == a]
    right = [iv for iv in read["layers"]["nuc"]["intervals"] if iv[0] == b]
    assert left and right and left[0][2] == right[0][2] == 147
    assert [iv for iv in read["intervals"] if iv[1] == a and iv[2] == 147]
    for layer in read["layers"].values():
        for track in layer.get("qualities") or []:
            assert len(track) == len(layer["intervals"])


def test_reads_without_deletions_keep_their_calls(sv_bam):
    reads = _load(sv_bam)
    ref = reads["sv/ref4/ccs"]
    assert "sv" not in ref
    assert any(iv[0] < fx.DEL_START - fx.VIEW[0] < iv[1] for iv in ref["layers"]["nuc"]["intervals"] + ref["layers"]["msp"]["intervals"])


def test_broad_cache_projection_keeps_absolute_events(sv_bam):
    from services.working_sets import project_broad_read_to_viewport
    reads = _load(sv_bam, start=0, end=fx.CHROM_LEN)
    projected, _ = project_broad_read_to_viewport(
        reads["sv/del0/ccs"], viewport_offset=9000, region_width=4000, include_methylation=False,
        layer_key=None)
    assert projected["sv"] == reads["sv/del0/ccs"]["sv"]


# ---------------------------------------------------------------------------
# Clusters and alleles


def test_cluster_tolerance():
    # Breakpoints within max(20, 5% len), lengths within 20%.
    assert events_match("D", 1010, 1500, 1000, 1500)
    assert events_match("D", 1070, 1500, 1000, 1500)       # 70 <= 75
    assert not events_match("D", 1080, 1500, 1000, 1500)   # 80 > 75
    assert events_match("D", 1000, 80, 1015, 80)          # 20 bp floor
    assert not events_match("D", 1000, 80, 1025, 80)
    assert not events_match("I", 1000, 300, 1000, 400)    # 25% shorter
    assert events_match("I", 1000, 330, 1005, 400)
    reads = [{"id": f"r{i}", "sv": [{"t": "D", "ref": 1000 + i * 5, "len": 1500 + i, "q": 0}]} for i in range(6)]
    reads.append({"id": "far", "sv": [{"t": "D", "ref": 5000, "len": 1500, "q": 0}]})
    reads.append({"id": "short", "sv": [{"t": "D", "ref": 1000, "len": 600, "q": 0}]})
    clusters, _ = cluster_sv_events(reads, 0, 10_000, 50)
    assert sorted(len(c["members"]) for c in clusters) == [1, 1, 6]


def test_summary_over_fixture(sv_bam):
    reads = list(_load(sv_bam).values())
    summary = sv_summary_for_reads(reads, *fx.VIEW, 50, chrom=fx.CHROM)
    by_type = {c["t"]: c for c in summary["clusters"]}
    assert by_type["D"]["support"] == 13 and by_type["D"]["sa_support"] == 3
    assert by_type["D"]["informative"] == 21
    assert abs(by_type["D"]["ref"] - fx.DEL_START) <= 6 and abs(by_type["D"]["len"] - fx.DEL_LEN) <= 10
    assert by_type["I"]["support"] == 9
    assert summary["clips"] == [{"side": "L", "ref": fx.DEL_START + fx.DEL_LEN, "n": 3},
                                {"side": "R", "ref": fx.DEL_START, "n": 3}]
    assert sv_summary_for_reads(reads, *fx.VIEW, 2001)['clusters'] == []


def test_allele_classification_edge_cases():
    t, ref, length = "D", 10_000, 1500
    carrier = {"id": "c", "reference_start": 9000, "reference_end": 13000, "sv": [{"t": "D", "ref": 10010, "len": 1495, "q": 0}]}
    reference = {"id": "r", "reference_start": 9800, "reference_end": 11700}
    short_left = {"id": "s", "reference_start": 9000, "reference_end": 11550}  # short of end + margin
    other_allele = {"id": "o", "reference_start": 9000, "reference_end": 13000, "sv": [{"t": "D", "ref": 10000, "len": 600, "q": 0}]}
    split = {"id": "p", "reference_start": 6000, "reference_end": 10003,
             "sv": [{"t": "S", "side": "R", "ref": 10003, "len": 2000, "q": 4000},
                    {"t": "SA", "chrom": "chrA", "pos": 11497, "strand": "+", "mapq": 60, "nm": 0, "cigar_ref_len": 2000, "supp": False}]}
    no_sa = {**split, "sv": split["sv"][:1]}
    wrong_chrom = {**split, "sv": [split["sv"][0], {**split["sv"][1], "chrom": "chrB"}]}
    no_bounds = {"id": "n"}
    assert classify_allele(carrier, t, ref, length) == 0
    assert classify_allele(reference, t, ref, length) == 1
    assert classify_allele(short_left, t, ref, length) == 2
    assert classify_allele(other_allele, t, ref, length) == 2  # deleted bases cannot establish reference
    assert classify_allele(split, t, ref, length, chrom="chrA") == 2  # no query geometry
    assert classify_allele(no_sa, t, ref, length, chrom="chrA") == 2
    assert classify_allele(wrong_chrom, t, ref, length, chrom="chrA") == 2
    assert classify_allele(no_bounds, t, ref, length) == 2
    # Insertions: a point locus, spanned +- margin.
    assert classify_allele({"id": "i", "reference_start": 13_000, "reference_end": 14_101}, "I", 14_000, 400) == 1
    assert classify_allele({"id": "i", "reference_start": 13_000, "reference_end": 14_099}, "I", 14_000, 400) == 2


# ---------------------------------------------------------------------------
# Endpoints


@pytest.fixture
def sv_client(standalone_app, sv_bam):
    from starlette.testclient import TestClient
    from state import get_state
    from state.browser_state import BrowserState

    state = BrowserState(None, None, None, None)
    state.add_dataset("sv", sv_bam, "SV")
    standalone_app.dependency_overrides[get_state] = lambda: state
    try:
        yield TestClient(standalone_app, headers=auth_headers()), state
    finally:
        standalone_app.dependency_overrides.pop(get_state, None)


def _compact(client, **params):
    base = dict(chrom=fx.CHROM, start=fx.VIEW[0], end=fx.VIEW[1], dataset_id="sv", include_layers="true", max_reads=500)
    response = client.get("/api/reads/compact", params={**base, **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_compact_payload_has_sv_and_summary(sv_client):
    client, _state = sv_client
    data = _compact(client)
    reads = {r["id"]: r for r in data["reads"]}
    assert reads["sv/del0/ccs"]["sv"][0]["t"] == "D"
    assert "sv" not in reads["sv/ref5/ccs"]
    summary = data["sv_summary"]
    assert [c["t"] for c in summary["clusters"]] == ["D", "I"]
    assert summary["clusters"][0]["support"] == 13 and summary["scope"] == "all"
    # Downsampled display: the summary still counts every read in view.
    small = _compact(client, max_reads=3)
    assert len(small["reads"]) == 3
    assert small["sv_summary"]["clusters"][0]["support"] == 13
    # Above the deletion's length: no deletion events or clusters.
    big = _compact(client, min_sv_len=1600)
    assert "sv_summary" not in big or all(c["t"] != "D" for c in big["sv_summary"]["clusters"])
    assert not any(e["t"] == "D" for r in big["reads"] for e in r.get("sv") or [])
    # Below the cache floor (direct path), with inserted bases.
    low = _compact(client, min_sv_len=20, include_sv_seq="true")
    ins = [e for r in low["reads"] for e in r.get("sv") or [] if e["t"] == "I"]
    assert ins and all(len(e["seq"]) == e["len"] for e in ins)
    off = _compact(client, include_sv_summary="false")
    assert "sv_summary" not in off


def test_compact_all_has_summary(sv_client):
    client, _state = sv_client
    response = client.get("/api/reads/compact_all", params=dict(
        chrom=fx.CHROM, start=fx.VIEW[0], end=fx.VIEW[1], dataset_ids="sv", include_layers="true"))
    assert response.status_code == 200, response.text
    data = response.json()["datasets"]["sv"]
    assert data["sv_summary"]["clusters"][0]["support"] == 13


def test_split_endpoint_classifies_every_read_in_view(sv_client):
    client, _state = sv_client
    summary = _compact(client)["sv_summary"]
    d = summary["clusters"][0]
    response = client.post("/api/sv/split", json=dict(
        dataset_id="sv", chrom=fx.CHROM, start=fx.VIEW[0], end=fx.VIEW[1], t="D", ref=d["ref"], len=d["len"]))
    assert response.status_code == 200, response.text
    out = response.json()
    groups = {k: {rid for rid, g in out["assignments"].items() if g == k} for k in (0, 1, 2)}
    assert groups[0] == fx.EXPECTED["del_carriers"]
    assert groups[1] == fx.EXPECTED["del_reference"]
    assert groups[2] == fx.EXPECTED["del_not_informative"]
    assert out["counts"] == [13, 8, 3]
    assert out["label"].startswith("DEL 1.5 kb @ chrSV:10,")
    bad = client.post("/api/sv/split", json=dict(dataset_id="sv", chrom=fx.CHROM, start=1, end=2, t="X", ref=1, len=5))
    assert bad.status_code == 400


def test_insert_seq_endpoint(sv_client, sv_bam):
    client, _state = sv_client
    reads = _load(sv_bam)
    (ins,) = [e for e in reads["sv/del0/ccs"]["sv"] if e["t"] == "I"]
    response = client.get("/api/sv/insert_seq", params=dict(
        dataset_id="sv", chrom=fx.CHROM, ref=ins["ref"], read_id="sv/del0/ccs", q=ins["q"], len=ins["len"]))
    assert response.status_code == 200, response.text
    seq = response.json()["seq"]
    with pysam.AlignmentFile(sv_bam) as bam:
        rec = next(r for r in bam.fetch(fx.CHROM, ins["ref"] - 1, ins["ref"] + 1) if r.query_name == "sv/del0/ccs")
    assert seq == rec.query_sequence[ins["q"]:ins["q"] + ins["len"]] and len(seq) == ins["len"]
    missing = client.get("/api/sv/insert_seq", params=dict(
        dataset_id="sv", chrom=fx.CHROM, ref=ins["ref"], read_id="nope", q=0, len=5))
    assert missing.status_code == 404


def test_dafc_and_dense_loaders_split_footprints_at_deletions(sv_bam):
    """Every read path agrees: no footprint block spans the deleted reference."""
    from services.dafc_reads import query_bam_for_dafc
    from services.dense_bam_loader import _legacy_reference_footprints
    import pysam as _pysam

    rows = {r["name"]: r for r in query_bam_for_dafc(sv_bam, fx.CHROM, *fx.VIEW)}
    with _pysam.AlignmentFile(sv_bam) as bam:
        records = {r.query_name: r for r in bam.fetch(fx.CHROM, *fx.VIEW) if not r.is_supplementary}
    for name in ("sv/del0/ccs", "sv/del1/ccs", "sv/del3/ccs"):
        rec = records[name]
        (d,) = [e for e in extract_sv_events(rec, 50) if e["t"] == "D"]
        cuts = deletion_spans([d])
        row = rows[name]
        blocks = [(row["start"] + int(s), row["start"] + int(s) + int(n))
                  for s, n in zip(row["blockStarts"].split(","), row["blockSizes"].split(",")) if s]
        assert blocks and all(e <= a or s >= b for a, b in cuts for s, e in blocks), name
        dense = _legacy_reference_footprints(rec, rec.get_tag("ns"), rec.get_tag("nl"), 2, True)
        assert dense and all(e <= a or s >= b for a, b in cuts for s, e, _n in dense), name


def test_mapper_walk_and_cigar_walk_give_the_same_events(sv_bam):
    """The loader reuses CigarCoordMapper's walk; the endpoints walk the CIGAR."""
    from models.domain import CigarCoordMapper
    with pysam.AlignmentFile(sv_bam) as bam:
        records = list(bam.fetch(fx.CHROM, *fx.VIEW))
    for rec in records:
        mapper = CigarCoordMapper(rec.cigartuples, rec.reference_start)
        for floor in (10, 50, 400):
            assert extract_sv_events(rec, floor, mapper=mapper) == extract_sv_events(rec, floor), rec.query_name
    split = _seg([(5, 30), (4, 40), (0, 100), (2, 900), (0, 2), (2, 598), (0, 100), (4, 60)], start=0)
    mapper = CigarCoordMapper(split.cigartuples, 0)
    assert extract_sv_events(split, 50, mapper=mapper) == extract_sv_events(split, 50)
    clips = [e for e in extract_sv_events(split, 50) if e['t'] == 'S']
    assert clips == [
        {"t": "S", "side": "L", "ref": 0, "len": 70, "q": 0, "h": 1},
        {"t": "S", "side": "R", "ref": 1700, "len": 60, "q": 242},
    ]


# ---------------------------------------------------------------------------
# Codex review (fb-n9-sv)


def test_pieces_that_join_past_the_threshold_make_an_event():
    """30D 5M 20D: no single op reaches 50, the joined deletion (55) does."""
    from models.domain import CigarCoordMapper
    a = _seg([(0, 100), (2, 30), (0, 5), (2, 20), (0, 100)], start=0)
    want = extract_sv_events(a, 50)
    assert want[0]["len"] == 50 and want[0]["ref_len"] == 55
    assert extract_sv_events(a, 50) == want
    assert extract_sv_events(a, 50, mapper=CigarCoordMapper(a.cigartuples, 0)) == want
    assert extract_sv_events(a, 51) is None


def test_inverted_sa_segment_is_not_a_deletion_carrier():
    t, ref, length = "D", 10_000, 1500
    clip = {"t": "S", "side": "R", "ref": 10_003, "len": 2000, "q": 4000}
    seg = {"t": "SA", "chrom": "chrA", "pos": 11_497, "strand": "-", "mapq": 60, "nm": 0, "cigar_ref_len": 2000, "supp": False}
    base = {"id": "p", "reference_start": 6000, "reference_end": 10_003}
    assert classify_allele({**base, "sv": [clip, {**seg, "same_strand": True}]}, t, ref, length, chrom="chrA") == 2
    assert classify_allele({**base, "sv": [clip, {**seg, "same_strand": False}]}, t, ref, length, chrom="chrA") == 2


def test_source_intervals_split_where_the_visible_call_does_not_cross():
    read = {"intervals": [[0, 50, 50]], "layers": {"tf": {
        "intervals": [[0, 50, 300]], "source_intervals": [[-50, 300, 300]], "qualities": [[7]], "quality_names": ["tq"]}}}
    split_compact_read_at_deletions(read, [(100, 200)])
    assert read["layers"]["tf"]["intervals"] == [[0, 50, 300]]
    assert read["layers"]["tf"]["source_intervals"] == [[-50, 100, 300]]


def test_gap_fill_never_joins_calls_across_a_deletion():
    from services.read_metrics import fill_small_gaps_in_read
    split = {"intervals": [[0, 50, 147], [150, 200, 147], [200, 205, -5], [205, 300, 95]], "qualities": [1, 1, 2]}
    out = fill_small_gaps_in_read(split, 10)
    assert out["intervals"] == [[0, 50, 147], [150, 300, 242]]
    plain = {"intervals": [[0, 50, 50], [50, 55, -5], [55, 100, 45]]}
    assert fill_small_gaps_in_read(plain, 10)["intervals"] == [[0, 100, 95]]


def test_split_keeps_sa_carriers_with_clips_shorter_than_the_deletion(tmp_path):
    """A 200 bp clip + SA segment still makes a carrier of a 1.5 kb deletion."""
    from services.sv_endpoint import sv_split_payload
    from state.browser_state import BrowserState
    import array
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 30_000}]}
    path = str(tmp_path / "clip.bam")
    with pysam.AlignmentFile(path + ".u.bam", "wb", header=header) as out:
        for name, start, cigar, sa in (
            ("carrier", 9_000, [(0, 1000), (4, 200)], "chrT,11501,+,1000S200M,60,0;"),
            ("ref", 9_000, [(0, 4000)], None),
        ):
            a = pysam.AlignedSegment(out.header)
            a.query_name = name
            qlen = sum(n for op, n in cigar if op in (0, 4))
            a.query_sequence = "A" * qlen
            a.query_qualities = array.array("B", [30] * qlen)
            a.reference_id = 0
            a.reference_start = start
            a.mapping_quality = 60
            a.cigartuples = cigar
            if sa:
                a.set_tag("SA", sa)
            out.write(a)
    pysam.sort("-o", path, path + ".u.bam")
    pysam.index(path)
    state = BrowserState(None, None, None, None)
    state.add_dataset("c", path, "C")
    out = sv_split_payload(state, dataset_id="c", chrom="chrT", start=9_500, end=12_000, t="D", ref=10_000, length=1500)
    assert out["assignments"] == {"carrier": 0, "ref": 1}


def test_insert_seq_prefers_the_exact_name(sv_bam, tmp_path):
    from services.sv_endpoint import sv_insert_seq_payload
    from state.browser_state import BrowserState
    state = BrowserState(None, None, None, None)
    state.add_dataset("sv", sv_bam, "SV")
    reads = _load(sv_bam)
    (ins,) = [e for e in reads["sv/ref0/ccs"]["sv"] if e["t"] == "I"]
    out = sv_insert_seq_payload(state, dataset_id="sv", chrom=fx.CHROM, ref=ins["ref"], read_id="sv/ref0/ccs",
                                q=ins["q"], length=ins["len"])
    assert out["read_id"] == "sv/ref0/ccs"
    # A suffixed display id resolves to its record.
    out2 = sv_insert_seq_payload(state, dataset_id="sv", chrom=fx.CHROM, ref=ins["ref"], read_id="sv/ref0/ccs_1",
                                 q=ins["q"], length=ins["len"])
    assert out2["seq"] == out["seq"]


# ---------------------------------------------------------------------------
# An insertion's clipped carriers (integration fb33)


def _ins_read(rid, start, end, *events):
    return {"id": rid, "reference_start": start, "reference_end": end, "sv": list(events)}


def test_an_insertion_clip_at_the_breakpoint_is_a_carrier():
    from services.sv_events import carrier_evidence, insertion_clip_min, insertion_clip_tolerance
    ref, length = 10_000, 9_000
    assert insertion_clip_tolerance(length) == 50 and insertion_clip_tolerance(300) == 20
    assert insertion_clip_min(length) == 50 and insertion_clip_min(60) == 50  # the cache's floor, for every size
    right = _ins_read("r", 5_000, 10_010, {"t": "S", "side": "R", "ref": 10_010, "len": 4_000, "q": 5_010})
    left = _ins_read("l", 9_970, 14_000, {"t": "S", "side": "L", "ref": 9_970, "len": 3_000, "q": 0})
    hard = _ins_read("h", 6_000, 10_000, {"t": "S", "side": "R", "ref": 10_000, "len": 900, "q": 4_000, "h": 1},
                     {"t": "SA", "chrom": "chrX", "pos": 5, "strand": "+", "mapq": 60, "nm": 0,
                      "cigar_ref_len": 900, "supp": False, "same_strand": True})
    far = _ins_read("f", 5_000, 9_900, {"t": "S", "side": "R", "ref": 9_900, "len": 4_000, "q": 4_900})
    short = _ins_read("s", 5_000, 10_000, {"t": "S", "side": "R", "ref": 10_000, "len": 40, "q": 5_000})
    cigar = _ins_read("c", 5_000, 15_000, {"t": "I", "ref": 10_020, "len": 8_800, "q": 5_020},
                      {"t": "S", "side": "R", "ref": 15_000, "len": 400, "q": 18_800})
    assert carrier_evidence(right, "I", ref, length)["kind"] == "clip"
    assert carrier_evidence(left, "I", ref, length)["clip"]["side"] == "L"
    assert carrier_evidence(hard, "I", ref, length)["kind"] == "clip"
    assert carrier_evidence(far, "I", ref, length) is None      # 100 bp away
    assert carrier_evidence(short, "I", ref, length) is None    # a 40 bp clip
    assert carrier_evidence(cigar, "I", ref, length)["kind"] == "cigar"
    for read in (right, left, hard):
        assert classify_allele(read, "I", ref, length) == 2
        assert carrier_evidence(read, "I", ref, length)["level"] == "putative"
    assert classify_allele(cigar, "I", ref, length) == 0
    assert classify_allele(far, "I", ref, length) == 2
    other = _ins_read("o", 5_000, 15_000, {"t": "I", "ref": 10_005, "len": 3_000, "q": 5_005})
    assert classify_allele(other, "I", ref, length) == 2       # another allele is not reference
    plain = _ins_read("p", 5_000, 15_000)
    assert classify_allele(plain, "I", ref, length) == 1


def test_the_summary_counts_an_insertions_clipped_carriers():
    ref, length = 10_000, 9_000
    reads = [_ins_read(f"c{i}", 5_000, 15_000, {"t": "I", "ref": ref + i, "len": length - 10 * i, "q": 5_000})
             for i in range(4)]
    reads += [_ins_read(f"r{i}", 5_000, ref + 5, {"t": "S", "side": "R", "ref": ref + 5, "len": 3_000, "q": 5_005})
              for i in range(5)]
    reads += [_ins_read(f"l{i}", ref - 3, 14_000, {"t": "S", "side": "L", "ref": ref - 3, "len": 2_000, "q": 0})
              for i in range(2)]
    reads += [_ins_read(f"n{i}", 5_000, 15_000) for i in range(3)]
    reads += [_ins_read("o", 5_000, 15_000, {"t": "I", "ref": ref, "len": 2_000, "q": 5_000})]
    summary = sv_summary_for_reads(reads, 0, 20_000, 50)
    big = next(c for c in summary["clusters"] if c["t"] == "I" and c["len"] > 5_000)
    assert big["support"] == 4 and big["clip_support"] == 0 and big["sa_support"] == 0
    assert big["ambiguous"] == 7 and big["putative"] == 0
    # Carriers + the plain spanning reads; the other allele is not informative.
    assert big["informative"] == 7
    for read in reads:
        allele = classify_allele(read, "I", big["ref"], big["len"])
        assert allele == (0 if read["id"][0] == "c" else 1 if read["id"][0] == "n" else 2), read["id"]


def test_supplementary_records_with_calls_are_one_molecule_everywhere(sv_client, sv_bam):
    """FiberHMM 3.0 calls supplementary records too (--alignments primary-supplementary): the
    fixture's split reads carry MA/ns/MM on their supplementary halves. A molecule is still one
    row, one count: the read panel, coverage, Read Stats and the split draw and count its
    primary record only (the supplementary half shows as the SA segment of the SV display)."""
    import pysam
    client, _state = sv_client
    lo, hi = fx.VIEW
    with pysam.AlignmentFile(sv_bam) as bam:
        records = [r for r in bam.fetch(fx.CHROM, lo, hi) if not r.is_unmapped]
        supplementary = [r for r in records if r.is_supplementary]
        primaries = {r.query_name: r for r in records if not (r.is_secondary or r.is_supplementary)}
    assert supplementary and all(r.has_tag("MA") and r.has_tag("MM") for r in supplementary)
    data = _compact(client)
    ids = [r["id"] for r in data["reads"]]
    assert len(ids) == len(set(ids)) and set(ids) <= set(primaries)  # no second row for a supplementary record
    assert {n for n in primaries if n.startswith("sv/clip")} <= set(ids)
    for read in data["reads"]:
        if read["id"].startswith("sv/clip"):  # its calls are the primary half's (view-relative)
            assert max(iv[1] for iv in read["intervals"]) <= primaries[read["id"]].reference_end - lo, read["id"]
    coverage = client.get("/api/coverage", params=dict(chrom=fx.CHROM, start=lo, end=hi, bins=100,
                                                       dataset_id="sv")).json()
    assert coverage["reads"] == len(primaries)
    split_names = sorted(n for n in primaries if n.startswith("sv/clip"))
    stats = client.post("/api/reads/stats", params=dict(chrom=fx.CHROM, start=lo, end=hi),
                        json={"read_ids_by_dataset": {"sv": split_names}}).json()
    rows = stats.get("per_read") or []
    assert sorted(r["read_id"] for r in rows) == split_names
    for row in rows:
        assert row["ref_start"] == primaries[row["read_id"]].reference_start


# P0 audit: the snapshots retain only local CIGAR/clip evidence and alignment
# bounds from an HG002 Fiber-seq sample, with anonymous IDs and no sequence/tags (see data/README).
@pytest.mark.parametrize("case", json.loads(
    (Path(__file__).parent / 'data/sv_p0_evidence.json').read_text()),
    ids=lambda case: case['name'])
def test_audited_loci_summary_split_and_display_evidence_agree(case):
    from services.sv_endpoint import classify_compact
    from services.sv_events import carrier_evidence
    target = case['target']
    reads = case['reads']
    calls = classify_compact((({**r, 'duplicate': False, 'file_chrom': case['chrom']}, r) for r in reads),
                             t=target['t'], ref=target['ref'], length=target['len'])
    expected = case['evidence_expected']
    assert {n for n, c in calls.items() if c['allele'] == 0} == set(expected['confirmed'])
    for cutoff in ([50, 2000] if case['name'] == 'alu' else [50]):
        summary = sv_summary_for_reads(reads, case['start'], case['end'], cutoff, chrom=case['chrom'])
        c = next(c for c in summary['clusters'] if all(c[k] == v for k, v in target.items()))
        assert (c['support'], c['informative'], c['clip_support']) == (
            len(expected['confirmed']), expected['informative'], 0)
        assert c['putative'] == len(expected['putative']) and c['ambiguous'] == len(expected['ambiguous'])
        assert c['support'] == sum(c['allele'] == 0 for c in calls.values())
        assert c['informative'] == sum(c['allele'] < 2 for c in calls.values())
        display = finalize_sv_payload(reads, case['start'], case['end'], cutoff)
        assert {r['id'] for r in display if (carrier_evidence(r, target['t'], target['ref'], target['len']) or {}).get('level') == 'confirmed'} == set(expected['confirmed'])


def _p0_read(name, ref, length, t='I'):
    return dict(id=name, reference_start=0, reference_end=4000,
                sv=[dict(t=t, ref=ref, len=length, q=100)])


def test_final_cluster_members_drop_stale_median_members():
    reads = [_p0_read(str(i), ref, 100) for i, ref in enumerate([1000, 1015, 1025, 1030, 1030])]
    clusters, _ = cluster_sv_events(reads, 0, 4000, 50)
    assert len(clusters) == 1 and clusters[0]['ref'] == 1025
    assert clusters[0]['members'] == {'1', '2', '3', '4'}
    c = sv_summary_for_reads(reads, 0, 4000, 50)['clusters'][0]
    assert c['support'] == 4
    assert c['support'] == sum(classify_allele(r, 'I', c['ref'], c['len']) == 0 for r in reads)


def test_final_target_counts_matching_events_from_adjacent_clusters_once_per_qname():
    reads = [_p0_read('first', 1000, 100), _p0_read('adjacent', 1000, 140)]
    reads += [_p0_read(str(i), 1001, 120) for i in range(3)]
    # The 140 bp event seeded a separate cluster before the first median moved.
    clusters, _ = cluster_sv_events(reads, 0, 4000, 50)
    c = next(c for c in clusters if c['len'] == 120)
    assert c['members'] == {r['id'] for r in reads}
    summary = sv_summary_for_reads(reads + reads, 0, 4000, 50)
    c = next(c for c in summary['clusters'] if c['len'] == 120)
    assert c['support'] == c['informative'] == 5
    assert summary['n_reads'] == 5


def test_repeated_qnames_reduce_carriers_and_reference_with_the_split_precedence():
    from services.sv_endpoint import classify_compact
    carrier = _p0_read('carrier', 1000, 100)
    clipped = {**carrier, 'sv': [dict(t='S', ref=1000, len=60, q=0, side='R')]}
    reference = dict(id='reference', reference_start=0, reference_end=4000)
    conflicting_reference = {**reference, 'id': 'carrier'}
    unknown = dict(id='reference', reference_start=999, reference_end=1001)
    special_reference = {**reference, 'alignment_spans': [(0, 4000)]}
    reads = [clipped, reference, conflicting_reference, unknown, special_reference, carrier, carrier]
    for cohort in (reads, list(reversed(reads))):
        summary = sv_summary_for_reads(cohort, 0, 4000, 50)
        c = summary['clusters'][0]
        assert (c['support'], c['informative'], c['clip_support'], summary['n_reads']) == (1, 2, 0, 2)
        calls = classify_compact((({**r, 'file_chrom': 'chrT', 'duplicate': False}, None) for r in cohort),
                                 t='I', ref=c['ref'], length=c['len'])
        assert {n: c['allele'] for n, c in calls.items()} == {'carrier': 0, 'reference': 1}
        assert calls['carrier']['evidence']['kind'] == 'cigar'


@pytest.mark.parametrize('mapper', [False, True])
@pytest.mark.parametrize('extra', [[], [(0, 100), (2, 20), (0, 100)]])
def test_merged_deletion_threshold_is_monotonic_and_independent_of_unrelated_events(mapper, extra):
    from models.domain import CigarCoordMapper
    read = _seg([(0, 100), (2, 20), (0, 10), (2, 20), (0, 100)] + extra)
    options = {'mapper': CigarCoordMapper(read.cigartuples, read.reference_start)} if mapper else {}
    for cutoff in [10, 20, 40]:
        events = extract_sv_events(read, cutoff, **options)
        assert next(e for e in events if e['ref'] == 1100)['len'] == 40
    assert not any(e['ref'] == 1100 for e in extract_sv_events(read, 41, **options) or [])


def test_small_matching_event_below_display_cutoff_is_still_carrier_evidence():
    from services.sv_endpoint import classify_records
    from services.sv_events import sv_extraction_floor
    seed = _seg([(0, 1000), (1, 60), (0, 1000)], start=0)
    near = _seg([(0, 1000), (1, 48), (0, 1000)], start=0)
    seed.query_name, near.query_name = 'seed', 'near'
    records = [(r, 'chrT') for r in (seed, near)]
    reads = [dict(id=r.query_name, reference_start=r.reference_start, reference_end=r.reference_end,
                  sv=extract_sv_events(r, sv_extraction_floor(50))) for r, _ in records]
    c = sv_summary_for_reads(reads, 0, 3000, 50)['clusters'][0]
    assert c['len'] == 60 and c['support'] == 2
    assert cluster_sv_events(reads, 0, 3000, 50)[0][0]['members'] == {'seed', 'near'}
    assert sum(c['allele'] == 0 for c in classify_records(records, t='I', ref=1000, length=60).values()) == 2
    displayed = finalize_sv_payload(reads, 0, 3000, 50)
    assert 'sv' not in displayed[1] and displayed[1]['sv_evidence'][0]['len'] == 48
