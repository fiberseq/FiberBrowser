"""Regressions reproduced from the P2a2 review with synthetic public data."""
import pysam
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from services.lift import differences as diff
from services.lift.reads import lifted_reads_for_region

def test_minus_insertion_points(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / 'minus-point.bam', lambda h: [make_record(h, 'minus-edge', MAT, 7700, '700M',
        seq='T'*300+'A'+'T'*10+'A'+'T'*388, tags=[('MD','700'), ('MM','A+a,0,0;'), ('ML',__import__('array').array('B',[255,255]))])])]
    rows = lifted_reads_for_region(ds, TARGET, 12000, 14000, dict(include_methylation=True))
    block = next(iter(rows[0]['live_lift']['insertions'].values()))
    assert block['methyl_m6a'] == [88,99]
