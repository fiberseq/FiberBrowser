"""Actual BAM-frame slicing and opt-in native evidence, without a map/server."""
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import pysam
import pytest

from services import sv_endpoint
from services.differences.enrichment import enrich_native, observe_interval
from services.differences.likelihood import LikelihoodPolicy


def record(name, cigar, sequence, *, flag=0):
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": "chrT", "LN": 10_000}]})
    read = pysam.AlignedSegment(header)
    read.query_name, read.reference_id, read.reference_start = name, 0, 0
    read.flag, read.mapping_quality, read.cigarstring = flag, 60, cigar
    read.query_sequence = sequence
    if sequence is not None:
        read.query_qualities = [40] * len(sequence)
    return read


def setup(monkeypatch, reads):
    rows = [sv_endpoint._compact_record(r, "chrT", 10) for r in reads]
    monkeypatch.setattr(sv_endpoint, "scan_view", lambda *args: rows)
    monkeypatch.setattr(sv_endpoint, "_bam_records", lambda *args, **kwargs: iter((r, "chrT") for r in reads))
    monkeypatch.setattr("services.lift.live_lift.open_lift_map", lambda *args: pytest.fail("native enrichment requested a map"))
    return dict(dataset_id="synthetic", chrom="chrT", start=0, end=300, ref=100, t="I", length=100, payload_version=2)


def specification(reads, *, target="A" * 100, reference="", competitors=None):
    return {"target_id": "frozen-target", "revision": 1, "reference": reference,
            "candidates": {"frozen-target": target, **(competitors or {"competing-target": "C" * 100})},
            "competition_complete": True,
            "chemistry_by_name": {r.query_name: {"chemistry": "none", "provenance": "synthetic-library"} for r in reads}}


@pytest.mark.parametrize("reverse", [False, True])
def test_actual_cigar_insertions_slice_seq_once_and_keep_frozen_geometry(monkeypatch, reverse):
    reads = [record("m1", "100M100I100M", "G" * 100 + "A" * 100 + "T" * 100, flag=16 if reverse else 0),
             record("m2", "100M100I100M", "G" * 100 + "C" * 100 + "T" * 100),
             record("reference", "200M", "G" * 200), record("partial", "90M", "G" * 90)]
    args = setup(monkeypatch, reads)
    before = sv_endpoint.sv_split_payload(None, **args)
    snapshot = deepcopy(before)
    enriched = sv_endpoint.sv_split_payload(None, **args, allele_target=specification(reads))
    evidence = enriched["differences"].pop("enrichment")
    assert enriched == before == snapshot
    assert before["counts"] == [2, 1, 1]
    assert evidence["counts"] == {"target": 1, "reference": 1, "other_allele": 1, "ambiguous": 0, "unknown": 1}
    rows = [a for c in evidence["calls_by_molecule"].values() for a in c["alignments"]]
    assert all(len(row["read_bases"]) <= 60 for row in rows)
    assert sorted(row["read_bases_length"] for row in rows) == [0, 0, 100, 100]
    inserted = next(row for row in rows if row["read_bases"].startswith("A"))
    assert inserted["query_interval"] == (100, 200)


def test_empty_deletion_replacement_and_hard_clip_use_full_molecule_query_frame():
    deletion = record("deletion", "7H100M100D100M", "G" * 100 + "T" * 100)
    observed = observe_interval(deletion, 100, 200)
    assert observed["complete"] and observed["sequence"] == ""
    assert observed["query_interval"] == (107, 107)
    replacement = record("replacement", "100M4D792I100M", "G" * 100 + "A" * 792 + "T" * 100)
    observed = observe_interval(replacement, 100, 104)
    assert observed["complete"] and observed["sequence"] == "A" * 792
    assert observed["query_interval"] == (100, 892)
    skip = record("skip", "100M100N100M", "G" * 200)
    assert not observe_interval(skip, 100, 200)["complete"]
    missing = record("missing", "200M", None)
    assert observe_interval(missing, 100, 100)["sequence"] is None


def test_missing_competitor_unknown_chemistry_and_preview_do_not_assign(monkeypatch):
    reads = [record("m1", "100M100I100M", "G" * 100 + "A" * 100 + "T" * 100)]
    args = setup(monkeypatch, reads)
    for change in [{"chemistry_by_name": {}}, {"competition_complete": False},
                   {"candidates": {"frozen-target": "A" * 100, "unavailable": None}}]:
        result = sv_endpoint.sv_split_payload(None, **args, allele_target={**specification(reads), **change})
        assert result["counts"][0] == 1
        assert result["differences"]["enrichment"]["counts"]["unknown"] == 1


def test_enrichment_refusal_preserves_geometry_and_returns_unknown(monkeypatch):
    reads = [record("m1", "100M100I100M", "G" * 100 + "A" * 100 + "T" * 100)]
    args = setup(monkeypatch, reads)
    envelope = sv_endpoint.sv_split_payload(None, **args)["differences"]
    result = enrich_native(None, envelope, dataset_id="synthetic", chrom="chrT", ref=100, target_end=100,
                           specification=specification(reads), policy=LikelihoodPolicy(max_pair_cells=10))
    assert not result["search_complete"]
    assert result["counts"]["target"] == 0
    assert "likelihood_pair_cells" in result["reasons"]
    assert envelope["geometry_counts"][0] == 1


def test_enrichment_ids_follow_target_revision_and_not_source_path(monkeypatch):
    reads = [record("m1", "100M100I100M", "G" * 100 + "A" * 100 + "T" * 100)]
    args = setup(monkeypatch, reads)
    env = sv_endpoint.sv_split_payload(None, **args)["differences"]
    base = dict(dataset_id="synthetic", chrom="chrT", ref=100, target_end=100)
    one = enrich_native(None, env, **base, specification=specification(reads), records=[(reads[0], "chrT", "old-locator")])
    two = enrich_native(None, env, **base, specification=specification(reads), records=[(reads[0], "chrT", "new-locator")])
    assert one == two
    three = enrich_native(None, env, **base, specification={**specification(reads), "revision": 2}, records=[(reads[0], "chrT")])
    assert three["enrichment_id"] != one["enrichment_id"]


def test_bad_requests_and_duplicate_decoding_are_bounded(monkeypatch):
    reads = [record("m1", "100M100I100M", "G" * 100 + "A" * 100 + "T" * 100)]
    args = setup(monkeypatch, reads)
    env = sv_endpoint.sv_split_payload(None, **args)["differences"]
    value = enrich_native(None, env, dataset_id="synthetic", chrom="chrT", ref=100, target_end=100,
                          specification=specification(reads), records=[(reads[0], "chrT"), (reads[0], "chrT")])
    assert value["records_enriched"] == value["counts"]["target"] == 1
    for bad in [{}, {**specification(reads), "reference": "wrong-span"},
                {**specification(reads), "candidates": {"frozen-target": "A" * 100_001}}]:
        with pytest.raises(sv_endpoint.SvRequestError):
            sv_endpoint.sv_split_payload(None, **args, allele_target=bad)


def test_shifted_repeat_cigar_requires_an_explicit_common_diagnostic_window(monkeypatch):
    reads = [record('shifted', '104M100I96M', 'G' * 104 + 'A' * 100 + 'T' * 96)]
    args = setup(monkeypatch, reads)
    small = sv_endpoint.sv_split_payload(None, **args, allele_target=specification(reads))['differences']['enrichment']
    call, = small['calls_by_molecule'].values()
    assert call['call']['assignment'] == 'ambiguous'
    assert 'diagnostic_window_misses_geometry' in call['call']['reasons']
    spec = specification(reads, target='GGGG' + 'A' * 100 + 'T', reference='GGGGT', competitors={'other': 'C' * 105})
    spec.update(diagnostic_start=100, diagnostic_end=105)
    wide = sv_endpoint.sv_split_payload(None, **args, allele_target=spec)['differences']['enrichment']
    assert wide['counts']['target'] == 1
