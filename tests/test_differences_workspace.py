from test_live_lift_differences import evidence  # noqa: F401
"""Independent query-coordinate, count and resource oracles for native expansion."""
from types import SimpleNamespace
import pytest
from insertion_fixtures import make_insertion_bam, SITE
from services.differences.workspace import alternate_blocks, inspect, expandable_alt_block
from services.reconstruction_budget import ResourceResult


@pytest.fixture
def native(tmp_path):
    truth = make_insertion_bam(tmp_path, n_carriers=4, n_reference=2)
    ds = SimpleNamespace(id="native", data_type="bam", paths=[truth["bam"]])
    state = SimpleNamespace(datasets={ds.id: ds}, get_dataset=lambda _: ds,
                            translate_chrom=lambda c: c, fasta=None)
    return state, ds, truth


def target(alt=2000, ref_bp=0):
    return dict(target_id="frozen-native", revision=1, target_type="geometry", chrom="chrT",
                ref_start=SITE, ref_end=SITE+ref_bp, alt_bp=alt)


def test_alternate_capability_preserves_both_spans():
    assert all(expandable_alt_block(r, a) for r, a in [(0, 50), (4, 788), (4, 792), (12, 50), (100, 150)])
    assert all(not expandable_alt_block(r, a) for r, a in [(0, 49), (0, 50001), (90, 2), (100, 110), (50, 50)])


def test_native_calls_remain_geometry_and_fan_out_without_map(native, monkeypatch):
    state, ds, _ = native
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "0")
    result = inspect(state, ds, chrom="chrT", start=SITE-1000, end=SITE+1000, target=target())
    assert result["analysis_scope"] == "native_only"
    calls = result["targets"][0]
    assert calls["counts"] == calls["geometry_counts"]
    assert calls["counts"][0] >= 4
    assert all(c["call"]["assignment"] == "unknown" for c in calls["calls_by_molecule"].values())
    assert result["membership"]["rows"][ds.id]


def test_native_blocks_observed_query_offsets_both_strands(native, monkeypatch):
    state, ds, truth = native
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "0")
    result = alternate_blocks(state, ds, chrom="chrT", start=SITE-1000, end=SITE+1000, target=target(), layers=["nuc", "tf", "msp"])
    assert result["complete"] and len(result["blocks"]) >= 4
    import pysam
    originals = {r.query_name: r for r in pysam.AlignmentFile(ds.paths[0]).fetch()}
    assert {b["read_orientation"] for b in result["blocks"]} == {"+", "-"}
    for block in result["blocks"]:
        read = originals[block["row_id"]]
        lo, hi = block["seq_q"]
        t = truth["reads"][block["row_id"]]
        if t["kind"] == "carrier":
            assert (lo, hi) == (t["q"], t["q"]+t["len"])
            assert sorted(block.get("methyl_m6a", [])) == sorted(p-lo for p in t["m6a"] if lo <= p < hi)
            expected = sorted((max(0, a-lo), min(hi-lo, a+n-lo)) for a,n in t["nucs"] if a < hi and a+n > lo)
            actual = sorted((a,b) for a,b,*_ in block["layers"]["nuc"]["intervals"])
            assert actual == expected
            assert block["layers"]["nuc"].get("quality_names")
        assert block["read_bases"] == read.query_sequence[lo:hi][:60]
        assert block["read_bases_length"] == hi-lo
        assert block["covered"][1]-block["covered"][0] == hi-lo
        assert "live_lift" not in block
        assert all(0 <= p < block["length"] for p in block.get("methyl_m6a", []))
    # Full CIGAR blocks retain footprints crossing either boundary and qualities.
    assert any(b.get("layers", {}).get("nuc", {}).get("intervals") for b in result["blocks"])
    only = result["blocks"][0]["row_id"]
    subset = alternate_blocks(state, ds, chrom="chrT", start=SITE-1000, end=SITE+1000, target=target(), row_ids=[only])
    assert {b["row_id"] for b in subset["blocks"]} == {only}


def test_native_blocks_refuse_before_decode(native, monkeypatch):
    state, ds, _ = native
    monkeypatch.setattr('services.differences.workspace._query_annotations', lambda *a: pytest.fail("must refuse before decode"))
    for t, rows in [(target(50001), None), (target(), ["r"]*501)]:
        with pytest.raises(ResourceResult):
            alternate_blocks(state, ds, chrom="chrT", start=SITE-1000, end=SITE+1000, target=t, row_ids=rows)


def test_paged_observed_sequence_is_explicit_and_preserves_full_length(native):
    from services.differences.workspace import sequence
    state, ds, truth = native
    q=dict(chrom="chrT",start=SITE-1000,end=SITE+1000,target=target())
    block=next(b for b in alternate_blocks(state,ds,**q)["blocks"] if b["coverage"] == "full")
    page=sequence(state,ds,**q,row_ids=[block["row_id"]],record_id=block["record_id"],offset=60,limit=100)
    expected=truth["reads"][block["row_id"]]["insert_seq"]
    assert page["sequence"] == expected[60:160]
    assert page["length"] == len(expected) and not page["complete"] and page["next_offset"] == 160


def test_lens_uses_frozen_cohort_and_budget_refusal_keeps_chromatin(native, monkeypatch):
    from services.differences.workspace import lens
    state,ds,_=native
    q=dict(chrom="chrT",start=SITE-1000,end=SITE+1000,target=target())
    calls=inspect(state,ds,**q)
    # Freeze a one-molecule cohort without using display filters.
    chosen=next(k for k,c in calls["targets"][0]["calls_by_molecule"].items() if c["geometry_group"]==0)
    calls["targets"][0]["calls_by_molecule"]={chosen:calls["targets"][0]["calls_by_molecule"][chosen]}
    monkeypatch.setattr('services.insertion_consensus.reconstruct_lens', lambda *a,**k: (_ for _ in ()).throw(ResourceResult('budget_exceeded','synthetic_preflight')))
    out=lens(state,ds,**q,frozen_calls=calls)
    assert len(out["carriers"]) == 1
    assert out["carriers"][0]["read"]["layers"]["nuc"]["intervals"]
    assert out["consensus_resource"]["status"] == "budget_exceeded" and "consensus" not in out
    bad={**calls,"scope":{}}
    with pytest.raises(ResourceResult,match="stale_call_snapshot"):
        lens(state,ds,**q,frozen_calls=bad)


@pytest.mark.parametrize('alt_bp',[788,792])
@pytest.mark.parametrize('reverse',[False,True])
def test_native_replacement_retains_both_spans_and_observed_offsets(tmp_path,alt_bp,reverse):
    from live_lift_fixtures import write_bam,make_record
    path=write_bam(tmp_path/'replacement.bam',lambda h:[make_record(h,'molecule','chrT',SITE-100,f'100M4D{alt_bp}I100M',flag=16 if reverse else 0)],contigs=(('chrT',30000),))
    ds=SimpleNamespace(id='native',data_type='bam',paths=[path])
    state=SimpleNamespace(datasets={ds.id:ds},get_dataset=lambda _:ds,translate_chrom=lambda c:c,fasta=None)
    q=dict(chrom='chrT',start=SITE-200,end=SITE+200,target=target(alt_bp,4))
    calls=inspect(state,ds,**q)
    assert calls['targets'][0]['counts']==[1,0,0]
    block=alternate_blocks(state,ds,**q)['blocks'][0]
    assert (block['t_start'],block['t_end'],block['ref_bp'],block['alt_bp'])==(SITE,SITE+4,4,alt_bp)
    assert block['seq_q']==[100,100+alt_bp] and block['length']==alt_bp
    assert block['read_bases_length']==alt_bp and len(block['read_bases'])==60


def test_native_deletion_inspection_preserves_empty_and_reference_observations(tmp_path):
    from live_lift_fixtures import write_bam,make_record
    from services.differences.workspace import observations,sequence
    path=write_bam(tmp_path/'deletion.bam',lambda h:[make_record(h,'deletion','chrT',SITE-100,'100M100D100M'),make_record(h,'reference','chrT',SITE-100,'300M')],contigs=(('chrT',30000),))
    ds=SimpleNamespace(id='native',data_type='bam',paths=[path])
    state=SimpleNamespace(datasets={ds.id:ds},get_dataset=lambda _:ds,translate_chrom=lambda c:c,fasta=None)
    q=dict(chrom='chrT',start=SITE-200,end=SITE+300,target=target(0,100))
    rows={b['row_id']:b for b in observations(state,ds,**q)['blocks']}
    assert rows['deletion']['read_bases']=='' and rows['deletion']['read_bases_length']==0
    assert rows['reference']['read_bases_length']==100 and len(rows['reference']['read_bases'])==60
    page=sequence(state,ds,**q,row_ids=['deletion'],record_id=rows['deletion']['record_id'])
    assert page['complete'] and page['sequence']=='' and page['length']==0


def test_native_block_cache_is_separate_revisioned_and_immutable(native,monkeypatch):
    state,ds,_=native
    q=dict(chrom='chrT',start=SITE-1000,end=SITE+1000,target=target())
    first=alternate_blocks(state,ds,**q)
    expected=first['blocks'][0]['covered'][:]
    first['blocks'][0]['covered'][0]=-999
    monkeypatch.setattr('services.differences.workspace._query_annotations',lambda *a:pytest.fail('warm block should not decode again'))
    assert alternate_blocks(state,ds,**q)['blocks'][0]['covered']==expected


def test_explicit_exact_target_keeps_geometry_counts_and_reports_exact_calls_separately(tmp_path):
    from live_lift_fixtures import write_bam,make_record
    path=write_bam(tmp_path/'exact.bam',lambda h:[make_record(h,'carrier','chrT',SITE-100,'100M100I100M',seq='A'*300),make_record(h,'reference','chrT',SITE-100,'200M')],contigs=(('chrT',30000),))
    ds=SimpleNamespace(id='native',data_type='bam',paths=[path])
    state=SimpleNamespace(datasets={ds.id:ds},get_dataset=lambda _:ds,translate_chrom=lambda c:c,fasta=None)
    t={**target(100),'target_type':'exact','candidates':{'frozen-native':'A'*100,'reference':''},'competition_complete':True,
       'chemistry_by_name':{name:{'chemistry':'none','provenance':'synthetic'} for name in ['carrier','reference']}}
    out=inspect(state,ds,chrom='chrT',start=SITE-200,end=SITE+200,target=t)['targets'][0]
    assert out['geometry_counts']==out['counts']==[1,1,0]
    assert out['sequence_unresolved_count']==0
    t['chemistry_by_name']={name:{'chemistry':'unknown','provenance':'unavailable'} for name in ['carrier','reference']}
    unknown=inspect(state,ds,chrom='chrT',start=SITE-200,end=SITE+200,target=t)['targets'][0]
    assert unknown['geometry_counts']==[1,1,0] and unknown['counts']==[0,0,2]
    assert unknown['sequence_unresolved_count']==2


def test_lifted_workspace_lens_has_independent_sequence_count_and_chromatin_oracles(evidence,monkeypatch):
    from services.differences.workspace import lens
    from services.reconstruction_budget import close_warm_worker
    from services.lift.capability import LiveLiftUnsupported,require
    state,ds,_=evidence
    state.get_dataset=state.datasets.get
    monkeypatch.setenv('FIBERBROWSER_LIVE_LIFT','1')
    t=dict(target_id='frozen-insertion',revision=1,target_type='geometry',chrom='chrT',ref_start=6010,ref_end=6010,alt_bp=100)
    # The fixture's target name comes from its independently authored map.
    from live_lift_fixtures import TARGET
    t['chrom']=TARGET
    q=dict(chrom=TARGET,start=5900,end=6500,target=t)
    calls=inspect(state,ds,**q)
    try:
        result=lens(state,ds,**q,frozen_calls=calls)
        assert result['consensus']['seq']=='A'*100
        assert result['consensus']['n_reads']==len(result['carriers'])==3
        assert result['difference_scope']['complete']
        assert all(sorted((a,b) for a,b,size in row['read']['intervals'] if size>0)==[(10,40),(60,90)] for row in result['carriers'])
    finally:
        close_warm_worker()
    # Opening the versioned workspace cannot enable the legacy consumer.
    with pytest.raises(LiveLiftUnsupported):require(ds,'insertion_lens')
    from services.lift import capability
    monkeypatch.setattr(capability,'SUPPORTED',capability.SUPPORTED-{'difference_lens'})
    with pytest.raises(LiveLiftUnsupported):lens(state,ds,**q,frozen_calls=calls)


def test_long_left_clip_keeps_suffix_semantics_when_truncated_to_target_length(tmp_path):
    import pysam
    from services.differences.workspace import _query_window
    header=pysam.AlignmentHeader.from_dict({'SQ':[{'SN':'chrT','LN':30000}]})
    read=pysam.AlignedSegment(header);read.query_name='left';read.reference_id=0
    read.reference_start=SITE;read.cigarstring='150S100M';read.query_sequence='C'*250
    window=_query_window(read,target(100))
    assert window[:5]==(50,150,0,100,'partial')
    assert window[7]=='end'
