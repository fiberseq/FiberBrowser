"""Regressions reproduced from the P2a2 review with synthetic public data."""
import pysam
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from services.lift import differences as diff
from services.lift.reads import lifted_reads_for_region

def test_unmapped_span_is_not_map_insertion(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / 'unmapped-probe.bam', lambda h: [make_record(h, 'unmapped', MAT, 8900, '400M')])]
    rows = lifted_reads_for_region(ds, TARGET, 7500, 14000)
    observed = [{'badges':r['live_lift']['badges'], 'sv':r.get('sv')} for r in rows]
    assert any(b[1]=='outside_chains' for r in rows for b in r['live_lift']['badges'])
    assert not any(e['source']=='assembly' and e['t']=='I' for r in rows for e in r.get('sv',[]))


def test_target_gaps_have_one_kind(evidence):
    _, ds, _ = evidence
    items = diff.assembly_items_for_region(ds.live_lift, TARGET, 1000, 20000)
    for gap in (i for i in items if i['kind'] in ('deletion', 'replacement')):
        assert not any(i['kind'] == 'no_correspondence' and i['hap'] == gap['hap']
                       and i['t_start'] < gap['t_end'] and i['t_end'] > gap['t_start'] for i in items)
    assert any(i['kind'] == 'no_correspondence' for i in items)


def test_unknown_chromosome_size_does_not_invent_bin_tails(evidence, monkeypatch):
    _, ds, _ = evidence
    monkeypatch.setattr(ds.live_lift.handle, 'target_size', lambda chrom: None)
    diff._CACHE.clear()
    one = diff.assembly_items_for_region(ds.live_lift, TARGET, 19000, 1000001)
    assert all(i['t_end'] != diff.BIN_BP for i in one)
