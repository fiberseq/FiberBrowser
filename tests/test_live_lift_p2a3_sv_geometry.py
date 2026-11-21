"""Future source-frame evidence fields must never leak through lifted rows."""
from test_live_lift_differences import evidence
from live_lift_fixtures import MAT, TARGET
from services.lift import live_lift as ll
from services.lift.reads import lifted_reads_for_region


def test_source_sv_geometry_is_removed(evidence, monkeypatch):
    _, ds, _ = evidence
    original = ll.decode_source_records
    def with_source_evidence(*args, **kwargs):
        rows = original(*args, **kwargs)
        for row in rows:
            row.update(sv_evidence=[dict(t='I', ref=50, len=100)], aligned_blocks=[[0, 200]],
                       sv_segments=[dict(chrom=MAT, pos=0, cigar_ref_len=200)],
                       sv_alignments=[dict(sv=[dict(t='I', ref=50, len=100)],
                                           aligned_blocks=[[0, 200]])], sequence_span=[0, 200])
        return rows
    monkeypatch.setattr(ll, 'decode_source_records', with_source_evidence)
    rows = lifted_reads_for_region(ds, TARGET, 1000, 7000)
    assert rows
    assert all(not {'sv_evidence', 'aligned_blocks', 'sv_segments', 'sv_alignments', 'sequence_span'} & r.keys()
               for r in rows)
    assert any(e.get('source') == 'assembly' for r in rows for e in r.get('sv', []))
