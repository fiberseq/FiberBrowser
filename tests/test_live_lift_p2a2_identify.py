"""Regressions reproduced from the P2a2 review with synthetic public data."""
import pysam
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from services.lift import differences as diff
from services.lift.reads import lifted_reads_for_region

def test_identify_contract(evidence):
    state, ds, _ = evidence
    item = next(i for i in diff.assembly_items_for_region(ds.live_lift, TARGET, 6000, 6020) if i['kind'] == 'insertion')
    result = diff.difference_reads(state, ds, TARGET, 6010, 6010, item_id=item['id'])
    carriers = [r for r in result['rows'] if r.get('carries_insertion')]
    assert carriers and result['sequence'] is None
    full = diff.difference_reads(state, ds, TARGET, 6010, 6010, item_id=item['id'], include_sequence=True)
    assert len(full['sequence']['sequence']) == 100
    assert full['sequence']['source'] == 'reads'
    assert all(len(r['read_bases']) <= 60 for r in full['rows'])


def test_identify_accepts_read_indels_and_orients_one_bounded_sequence(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / 'noisy-insertion.bam', lambda h: [
        make_record(h, 'noisy', MAT, 4900, '150M1I150M', seq='A'*150+'G'+'A'*150, tags=[('MD','300')])])]
    key = f'MAT:{MAT}:5000-5100:insertion'
    result = diff.difference_reads(state, ds, TARGET, 6010, 6010, item_id=key, include_sequence=True)
    assert result['rows'][0]['carries_insertion']
    assert len(result['sequence']['sequence']) == 101
    assert result['sequence']['ins_id'] == key
    minus_key = f'MAT:{MAT}:8000-8100:insertion'
    ds.paths = [write_bam(tmp / 'minus-insertion.bam', lambda h: [
        make_record(h, 'oriented', MAT, 7700, '700M', seq='T'*700, tags=[('MD','700')])])]
    minus = diff.difference_reads(state, ds, TARGET, 12900, 12900, item_id=minus_key, include_sequence=True)
    assert minus['sequence']['sequence'] == 'A'*100
    assert minus['sequence']['orientation'] == '-'
