"""Regressions reproduced from the P2a2 review with synthetic public data."""
import pysam
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from services.lift import differences as diff
from services.lift.reads import lifted_reads_for_region

def test_bookkeeping_guard(lift_env):
    client, state, manifest, bam = lift_env
    added = _add(client, manifest, bam)
    assert added.get('success'), added
    did = added['dataset']['id']
    response = client.post(f'/api/datasets/{did}/refresh_capabilities')
    assert response.status_code == 200
    assert response.json()["success"]

def test_anchor_validation_of_valid_fills(evidence):
    from services.lift.validate import validate_live_lift
    state, ds, _ = evidence
    result = validate_live_lift(ds.live_lift.handle, ds.paths, ds.live_lift.haplotypes,
        target_fasta=state.fasta, source_fasta=ds.live_lift.source_fasta)
    assert result.ok and result.anchors['status'] == 'consistent'
    assert result.anchors['checked'] > 0
