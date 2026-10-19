"""Map geometry and coverage are complete without claiming CIGAR read evidence."""
from types import SimpleNamespace

import pytest

from live_lift_fixtures import MAT, TARGET, SSIZE, make_record, write_bam
from test_live_lift_boundary_gaps import gap_map
from services.lift.reads import lifted_reads_for_region, clip_geometry
from services.sv_events import carrier_evidence, classify_allele, cluster_sv_events


@pytest.mark.parametrize("dt,dq", [(9, 0), (10, 0), (11, 0), (0, 9), (0, 10), (0, 50), (10, 1), (1, 10), (201, 0), (201, 1), (20, 20)])
@pytest.mark.parametrize("strand", ["+", "-"])
def test_gap_shapes_use_fixed_floor_and_retain_map_links(tmp_path, dt, dq, strand):
    config = gap_map(tmp_path, dt, dq, strand)
    a, b = (200, 200 + dq) if strand == "+" else (SSIZE - 200 - dq, SSIZE - 200)
    bam = write_bam(tmp_path / "source.bam", lambda h: [make_record(h, "full", MAT, a - 50, f"{100 + dq}M")], contigs=((MAT, SSIZE),))
    ds = SimpleNamespace(id="gap", paths=[bam], data_type="bam_livelift", live_lift=config)
    low = lifted_reads_for_region(ds, TARGET, 1000, 1500, dict(sv_min_len=10))[0]
    high = lifted_reads_for_region(ds, TARGET, 1000, 1500, dict(sv_min_len=1000))[0]
    assert low["live_lift"]["gap_observations"] == high["live_lift"]["gap_observations"]
    markers = [ev for ev in high.get("sv", []) if ev.get("source") == "assembly"]
    observations = high["live_lift"]["gap_observations"]
    if max(dt, dq) < 10:
        assert not observations and not markers
        return
    obs, = observations
    marker, = markers
    assert (obs["t_start"], obs["t_end"], obs["ref_bp"], obs["alt_bp"]) == (1100, 1100 + dt, dt, dq)
    assert obs["coverage"] == dict(source=[0, dq], aligned_bp=dq, mol_bp=dq, left_flank=True, right_flank=True, full=True)
    assert marker["difference_id"] == obs["id"]
    assert (marker["ref"], marker["ref_end"], marker["ref_len"], marker["alt_len"]) == (1100, 1100 + dt, dt, dq)
    assert marker["display_only"] and marker["method"] == "assembly_projection" and "level" not in marker
    assert not {"sv_evidence", "aligned_blocks", "sv_segments", "sv_alignments", "sequence_span"} & high.keys()
    assert carrier_evidence(high, marker["t"], 1100, marker["len"], TARGET) is None
    assert classify_allele(high, marker["t"], 1100, marker["len"], chrom=TARGET) == 2
    assert cluster_sv_events([high], 1000, 1500, 10)[0] == []
    crop = clip_geometry(high["live_lift"], 100, 1)["gap_observations"]
    assert crop[0]["pos"] == 0 and crop[0]["t_start"] == 1100


def test_partial_replacement_keeps_coverage_without_a_spanned_marker(tmp_path):
    config = gap_map(tmp_path, 201, 80)
    bam = write_bam(tmp_path / "source.bam", lambda h: [make_record(h, "partial", MAT, 150, "80M")], contigs=((MAT, SSIZE),))
    ds = SimpleNamespace(id="gap", paths=[bam], data_type="bam_livelift", live_lift=config)
    row, = lifted_reads_for_region(ds, TARGET, 1000, 1500)
    observation, = row["live_lift"]["gap_observations"]
    assert observation["coverage"]["source"] == [0, 30]
    assert not observation["coverage"]["full"] and not observation["coverage"]["right_flank"]
    assert not any(ev.get("source") == "assembly" for ev in row.get("sv", []))
