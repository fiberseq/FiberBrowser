"""Independent endpoint/query-frame oracles for the future guarded adapter.

These test the existing display primitives and enforce absence of authoritative
fields. Native endpoint/hypothesis consumers are not a projected adapter yet.
"""
import pytest

from live_lift_fixtures import MAT, TARGET, SSIZE, make_record, write_bam
from test_live_lift_boundary_gaps import gap_map
from services.lift import live_lift as ll
from services.lift.compose import project_aligned_runs, lift_compact_reads
from services.sv_events import junction_evidence, classify_molecules


@pytest.mark.parametrize("dt,dq", [(0, 30), (200, 0), (200, 1)])
@pytest.mark.parametrize("map_strand", ["+", "-"])
@pytest.mark.parametrize("read_reverse", [False, True])
def test_target_endpoints_seq_offsets_hard_clips_and_double_reverse(tmp_path, dt, dq, map_strand, read_reverse):
    config = gap_map(tmp_path, dt, dq, map_strand)
    a = 200 if map_strand == "+" else SSIZE - 200 - dq
    bam = write_bam(tmp_path / "hard.bam", lambda h: [make_record(h, "m", MAT, a - 50,
                    f"5H10S{100 + dq}M7H", reverse=read_reverse, tags=[("st", "CT")])], contigs=((MAT, SSIZE),))
    selection = ll.select_pieces(config.handle, TARGET, 1000, 1600, haplotypes=config.haplotypes,
                                 settings=config.settings, key=config.key())
    plan = ll.plan_fetch(selection, config.settings)
    read, = ll.decode_source_records([bam], plan)
    pieces = plan.pieces_by_contig()[MAT]
    projected = project_aligned_runs(read, pieces, config.settings)
    # BAM SEQ follows source reference order even when the record is reverse.
    # Its 10 soft-clipped + 5 hard-clipped leading bases precede the first M.
    expected = ([(15, 1050, 50, 1, 0), (65 + dq, 1100 + dt, 50, 1, 0)] if map_strand == "+" else
                [(15, 1149 + dt, 50, -1, 0), (65 + dq, 1099, 50, -1, 0)])
    assert projected == expected
    full_length = 122 + dq
    # Reflect [15,65) in the full molecule, never in stored SEQ (which lacks H).
    assert (full_length - 65, full_length - 15) == (57 + dq, 107 + dq)
    actual = {(seq + i - 5, target + step * i) for seq, target, n, step, _ in projected for i in range(n)}
    assert all(10 <= seq < 110 + dq for seq, _ in actual)
    assert not any(1100 <= target < 1100 + dt for _, target in actual)
    row, = lift_compact_reads([read], plan, handle=config.handle, region_start=1000, region_end=1600,
                             settings=config.settings, key=config.key(), dataset_id="contract")
    assert row["alignment_orientation"] == ("reverse" if read_reverse != (map_strand == "-") else "forward")
    assert row["strand"] == "CT"
    obs, = row["live_lift"]["gap_observations"]
    assert (obs["t_start"], obs["t_end"]) == (1100, 1100 + dt)
    if dt:
        # Source CIGAR covers only 100+dq bases, while the target hull includes
        # the map deletion. Never derive ref_end from source cigar_ref_len.
        assert row["reference_end"] - row["reference_start"] == 100 + dt
        assert row["reference_end"] != row["reference_start"] + 100 + dq
    else:
        # Display can rejoin touching spans; the edit cut must survive elsewhere.
        assert row["alignment_spans"] == [[1050, 1150]] and obs["t_start"] == obs["t_end"]
    assert not {"sv_evidence", "aligned_blocks", "sv_segments", "sv_alignments", "sequence_span"} & row.keys()


def test_source_clip_origins_and_query_metadata_cannot_leak_to_display():
    piece = ll.LiftPiece(0, 1000, 1100, 100, 200, "-", True, "H#1", MAT)
    selection = ll.PieceSelection(TARGET, 0, 2000, 0, 2000, [piece])
    source_anchor = dict(chrom=MAT, pos=100, cigar_ref_len=100, q_start=15, q_end=115, query_length=122, strand="+")
    read = dict(id="clip", reference_start=100, reference_end=200, intervals=[],
                sv=[dict(t="S", ref=100, len=15, side="L", q=0, anchor=source_anchor),
                    dict(t="D", ref=140, len=20, q=55, ref_end=160, raw_ref=140, raw_ref_end=160,
                         ref_len=20, alt_len=1, uncertainty=[139, 141], raw_pieces=[dict(t="D", ref=140, len=20, q=55)])],
                _fiberbrowser_source_base=0, _fiberbrowser_aligned_runs=[[100, 15, 100]],
                _fiberbrowser_lift_record=dict(contig=MAT, reverse=False, length=122))
    row, = lift_compact_reads([read], ll.plan_fetch(selection, ll.LiftSettings()), handle=None,
                             region_start=0, region_end=2000, settings=ll.LiftSettings(), key="test", dataset_id="test")
    clip, = [ev for ev in row["sv"] if ev["t"] == "S"]
    assert (clip["ref"], clip["side"]) == (1100, "R")
    forbidden = {"q", "q_end", "anchor", "ref_end", "raw_ref", "raw_ref_end", "raw_pieces", "uncertainty", "ref_len", "alt_len"}
    assert all(not forbidden & ev.keys() and ev["display_only"] for ev in row["sv"])


def test_review_endpoint_control_is_a_guarded_adapter_prerequisite():
    # Supplemental review control: explicit target ref_end is not yet consumed
    # by native junction code. Establish its independent expected geometry.
    left = dict(chrom=TARGET, pos=0, cigar_ref_len=1000, ref_end=1100, strand="+", q_start=0, q_end=1000, query_length=2000, mapq=60)
    right = dict(chrom=TARGET, pos=1200, cigar_ref_len=1000, ref_end=2200, strand="+", q_start=1000, q_end=2000, query_length=2000, mapq=60)
    assert right["pos"] - left["ref_end"] == 100 and right["q_start"] == left["q_end"]
    assert junction_evidence(dict(sv_segments=[left, right]), "D", 1100, 100, TARGET) is None
    assert junction_evidence(dict(sv_segments=[dict(left, cigar_ref_len=1100), right]), "D", 1100, 100, TARGET)["level"] == "confirmed"
    # Even a hypothetical mixed-frame bundle cannot certify a lifted call.
    lifted = dict(id="m", live_lift={"v": 1}, sv_segments=[left, right], reference_start=0, reference_end=2200)
    assert classify_molecules([(lifted, None)], t="D", ref=1100, length=100, chrom=TARGET)["m"]["allele"] == 2


def test_review_projection_alternatives_cannot_form_an_interim_junction():
    rows = []
    for hypothesis, pos, qs, qe in [("A", 0, 0, 1000), ("B", 1100, 1000, 2000)]:
        segment = dict(chrom=TARGET, pos=pos, cigar_ref_len=1000, strand="+", q_start=qs, q_end=qe,
                       query_length=2000, mapq=60, projection_hypothesis=hypothesis)
        native = dict(id="m", reference_start=pos, reference_end=pos + 1000, sv_segments=[segment], sv_evidence=[])
        # A source bundle must not escape the gate by flattening nested rows.
        rows.append(dict(native, live_lift={"v": 1}, sv_alignments=[native]))
    assert classify_molecules([(r, None) for r in rows], t="D", ref=1000, length=100, chrom=TARGET)["m"]["allele"] == 2
    assert all(classify_molecules([(r, None)], t="D", ref=1000, length=100, chrom=TARGET)["m"]["allele"] == 2 for r in rows)
