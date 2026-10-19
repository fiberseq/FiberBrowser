"""Inspection follows independent reference and alternate spans, including empty alts."""
from types import SimpleNamespace

import pysam
import pytest
from fastapi import HTTPException

from live_lift_fixtures import MAT, TARGET, SSIZE, make_record, write_bam
from test_live_lift_boundary_gaps import gap_map
from test_live_lift_differences import _fasta
from services.lift import differences as diff


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
