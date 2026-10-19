"""Inspection follows independent reference and alternate spans, including empty alts."""
from types import SimpleNamespace
import gzip
import json
from pathlib import Path

import pysam
import pytest
from fastapi import HTTPException

from live_lift_fixtures import MAT, TARGET, SSIZE, make_record, write_bam, write_difference_sidecar
from test_live_lift_boundary_gaps import gap_map
from test_live_lift_differences import _fasta
from services.lift import differences as diff
from services.lift.dataset import LiveLiftConfig


@pytest.mark.parametrize("dt,dq", [(1500, 0), (1142, 0), (1733, 1)])
@pytest.mark.parametrize("strand", ["+", "-"])
@pytest.mark.parametrize("with_fasta", [False, True])
def test_gap_inspection_spans_partial_reads_and_aliases(tmp_path, dt, dq, strand, with_fasta):
    config = gap_map(tmp_path, dt, dq, strand)
    target = _fasta(tmp_path / "target.fa", [(TARGET, "C" * 20000)])
    if with_fasta:
        config.source_fasta = _fasta(tmp_path / "source.fa", [(MAT, "A" * SSIZE)])
    a, b = (200, 200 + dq) if strand == "+" else (SSIZE - 200 - dq, SSIZE - 200)
    bam = write_bam(tmp_path / "source.bam", lambda h: [
        make_record(h, "full", MAT, a - 50, f"{100 + dq}M", seq="A" * (100 + dq), tags=[("MD", str(100 + dq))]),
        make_record(h, "right", MAT, a, "50M", seq="A" * 50, tags=[("MD", "50")]),
        make_record(h, "left", MAT, a - 50, "50M", seq="A" * 50, tags=[("MD", "50")]),
    ], contigs=((MAT, SSIZE),))
    ds = SimpleNamespace(id="gap", paths=[bam], data_type="bam_livelift", live_lift=config)
    with pysam.FastaFile(target) as fasta:
        state = SimpleNamespace(fasta=fasta, datasets={ds.id: ds})
        item, = [d for d in diff.assembly_items_for_region(config, TARGET, 1100, 1101) if d["kind"] in ("deletion", "replacement")]
        # Selecting the old hole from a tiny viewport resolves the complete edit.
        result = diff.difference_reads(state, ds, TARGET, 1101, 1102, item_id=item["aliases"][0])
        assert (result["pos"], result["end"]) == (1100, 1100 + dt)
        rows = {r["id"]: r for r in result["rows"]}
        assert rows["full"]["read_bases"] == ("A" if strand == "+" else "T") * dq
        assert rows["full"]["hg002"] == rows["full"]["read_bases"]
        assert rows["full"]["full_span"] and rows["full"]["ref_bp"] == dt and rows["full"]["alt_bp"] == dq
        assert rows["full"]["allele"] == ("hg002" if dq else "deleted")
        assert rows["right"]["allele"] == "partial" and not rows["right"]["full_span"]
        if not dq:
            assert rows["left"]["allele"] == "partial"
        assert result["hap_status"] == {"MAT": item["kind"]}
        assert result["sequence"] is None  # no insertion Identify sequence fabricated
        if dq and not with_fasta:
            with pytest.raises(HTTPException) as exc:
                diff.difference_sequence(ds, TARGET, 1101, item["aliases"][0])
            assert exc.value.status_code == 409
        else:
            seq = diff.difference_sequence(ds, TARGET, 1101, item["aliases"][0])
            assert seq["item_id"] == item["id"] and seq["total"] == dq
            assert seq["sequence"] == ("A" if strand == "+" else "T") * dq
        ref_page = diff.difference_sequence(ds, TARGET, 1101, item["aliases"][0], allele="reference", reference=fasta, offset=dt - 10, limit=20)
        assert ref_page["sequence"] == "C" * 10 and ref_page["total"] == dt
        assert ref_page["orientation"] == "+" and ref_page["next_offset"] is None


def test_replacement_reference_preview_and_bounded_alt_pages(tmp_path):
    config = gap_map(tmp_path, 3, 80)
    config.source_fasta = _fasta(tmp_path / "source.fa", [(MAT, "A" * SSIZE)])
    target = _fasta(tmp_path / "target.fa", [(TARGET, "C" * 20000)])
    ds = SimpleNamespace(id="gap", live_lift=config)
    with pysam.FastaFile(target) as fasta:
        item, = [d for d in diff.differences_for_region(SimpleNamespace(fasta=fasta), ds, TARGET, 1100, 1101)["items"] if d["kind"] == "replacement"]
    assert item["grch38"] == "CCC" and item["alt"] == "A" * 60
    assert item["alt_truncated"] and item["sequence_status"] == "partial"
    assert diff.difference_sequence(ds, TARGET, 1100, item["id"], offset=60, limit=10)["sequence"] == "A" * 10


@pytest.mark.parametrize("op", ["D", "N"])
def test_source_hull_without_aligned_boundary_flanks_is_not_full_inspection(tmp_path, op):
    config = gap_map(tmp_path, 200, 0)
    bam = write_bam(tmp_path / "source.bam", lambda h: [
        make_record(h, "unobserved", MAT, 150, f"40M20{op}40M"),
        make_record(h, "one-flank", MAT, 150, f"50M10{op}40M"),
    ], contigs=((MAT, SSIZE),))
    ds = SimpleNamespace(id="gap", paths=[bam], data_type="bam_livelift", live_lift=config)
    result = diff.difference_reads(SimpleNamespace(fasta=None, datasets={ds.id: ds}), ds, TARGET, 1100, 1300)
    rows = {row["id"]: row for row in result["rows"]}
    assert rows["unobserved"]["allele"] == "no_coverage" and not rows["unobserved"]["full_span"]
    assert rows["one-flank"]["allele"] == "partial" and not rows["one-flank"]["full_span"]


@pytest.mark.parametrize("count", [1, 501])
@pytest.mark.parametrize("with_reference", [False, True])
def test_mnv_inspection_bounds_every_preview_after_classification(tmp_path, count, with_reference):
    manifest = Path(write_difference_sidecar(tmp_path / "map"))
    with gzip.open(manifest.parent / "toy.t0.chrT.fills.json.gz", "wt") as fh:
        json.dump({"target": TARGET, "fills": {"0": [[1200, 200, 1]]}}, fh)
    config = LiveLiftConfig(str(manifest), [])
    bam = write_bam(tmp_path / "source.bam", lambda h: [
        *[make_record(h, f"full-{i}", MAT, 0, "1000M", seq="A" * 1000, tags=[("MD", "1000")]) for i in range(count)],
        make_record(h, "partial", MAT, 250, "100M", seq="A" * 100, tags=[("MD", "100")]),
    ])
    ds = SimpleNamespace(id="mnv", paths=[bam], data_type="bam_livelift", live_lift=config)
    target = _fasta(tmp_path / "target.fa", [(TARGET, "C" * 20000)])
    with pysam.FastaFile(target) as fasta:
        state = SimpleNamespace(fasta=fasta if with_reference else None, datasets={ds.id: ds})
        item, = [d for d in diff.assembly_items_for_region(config, TARGET, 1200, 1400) if d["kind"] == "mnv"]
        result = diff.difference_reads(state, ds, TARGET, 1200, 1400, item_id=item["id"])
    assert result["capped"] == (count > 500)
    assert len(result["rows"]) == min(count + 1, 500)
    for row in result["rows"]:
        assert row["read_bases"] == "A" * 60
        assert row["read_bases_length"] == (100 if row["id"] == "partial" else 200)
        assert row["allele"] == ("hg002" if with_reference and row["id"] != "partial" else "unknown")


def test_length_distinct_assembly_match_without_target_fasta(tmp_path):
    config = gap_map(tmp_path, 200, 1)
    bam = write_bam(tmp_path / "source.bam", lambda h: [make_record(h, "full", MAT, 150, "101M", tags=[("MD", "101")])])
    ds = SimpleNamespace(id="gap", paths=[bam], data_type="bam_livelift", live_lift=config)
    row, = diff.difference_reads(SimpleNamespace(fasta=None, datasets={ds.id: ds}), ds, TARGET, 1100, 1300)["rows"]
    assert row["allele"] == "hg002" and row["read_bases_length"] == 1


@pytest.mark.parametrize("strand", ["+", "-"])
@pytest.mark.parametrize("dq", [788, 792])
def test_replacement_alternate_block_and_identify_keep_both_spans(tmp_path, strand, dq):
    import array
    from services.lift.reads import lifted_reads_for_region
    config = gap_map(tmp_path, 4, dq, strand)
    a, b = (200, 200 + dq) if strand == "+" else (SSIZE - 200 - dq, SSIZE - 200)
    bam = write_bam(tmp_path / "source.bam", lambda h: [
        make_record(h, "carrier", MAT, a - 50, f"{dq + 100}M", seq="A" * (dq + 100), tags=[
            ("MD", str(dq + 100)), ("ns", array.array("I", [60])), ("nl", array.array("I", [30]))]),
        make_record(h, "partial", MAT, a - 20, "100M", seq="A" * 100, tags=[("MD", "100")]),
    ])
    ds = SimpleNamespace(id="replacement", paths=[bam], data_type="bam_livelift", live_lift=config)
    item, = [d for d in diff.assembly_items_for_region(config, TARGET, 1100, 1104) if d["kind"] == "replacement"]
    rows = lifted_reads_for_region(ds, TARGET, 1000, 1250, dict(hide_terminal_gaps=False))
    row = next(r for r in rows if r["id"] == "carrier")
    assert row["live_lift"]["badge_ids"] == [item["id"]]
    block = row["live_lift"]["insertions"][item["id"]]
    assert (block["kind"], block["t_start"], block["t_end"], block["ref_bp"], block["length"]) == ("replacement", 1100, 1104, 4, dq)
    assert block["covered"] == [0, dq]
    assert [10, 40, 30] in block["intervals"] if strand == "+" else [dq - 40, dq - 10, 30] in block["intervals"]
    result = diff.difference_reads(SimpleNamespace(fasta=None, datasets={ds.id: ds}), ds, TARGET, 1100, 1104,
                                   item_id=item["id"], include_sequence=True)
    assert result["sequence"]["sequence"] == ("A" if strand == "+" else "T") * dq
    assert result["sequence"]["ins_id"] == item["id"]
    carrier = next(r for r in result["rows"] if r["id"] == "carrier")
    assert carrier["carries_insertion"] and carrier["ins_id"] == item["id"] and carrier["full_span"]
    assert carrier["read_bases_length"] == dq and len(carrier["read_bases"]) == 60
    partial = next(r for r in result["rows"] if r["id"] == "partial")
    assert not partial["carries_insertion"] and not partial["full_span"]
