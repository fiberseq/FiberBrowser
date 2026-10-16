from types import SimpleNamespace
import array
import numpy as np
import pysam
import pytest
from services.consensus_lattice_view import lattice_payload


def fixture(tmp_path):
    path=tmp_path/'lattice.bam'
    with pysam.AlignmentFile(path,'wb',header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'chr1','LN':1000}]}) as bam:
        read=pysam.AlignedSegment(bam.header);read.query_name='r';read.query_sequence='ACGT'*40
        read.flag=0;read.reference_id=0;read.reference_start=100;read.mapping_quality=60
        read.cigarstring='60M10D100M';read.set_tag('MM','A+a.,4,4,4;');read.set_tag('ML',array.array('B',[255,20,255]))
        bam.write(read)
    pysam.index(str(path))
    ds=SimpleNamespace(path=str(path),paths=[str(path)],label='test',data_type='bam',family_scan_chemistry='hia5-pacbio')
    return SimpleNamespace(get_dataset=lambda _:ds),path


def test_actual_native_observations_match_inference_and_do_not_fill_deletions(tmp_path):
    from services.consensus_evidence import _runtime,_chemistry_runtime
    from fiberhmm.inference.strand_rescue import load_region_evidence
    state,path=fixture(tmp_path);before=path.read_bytes()
    request=dict(dataset_id='d',chrom='chr1',start=100,end=270,read_ids=['r','absent'])
    result=lattice_payload(state,request);row=result['reads']['r']
    preset,_,context,mode,hit,miss=_chemistry_runtime(_runtime(),'hia5-pacbio',allow_population=True)
    expected=load_region_evidence(str(path),'chr1',100,270,strand_mode=preset['strand_mode'],mode=mode,
        context_size=context,prob_threshold=preset['prob_threshold'],llr_hit=hit,llr_miss=miss,min_mapq=0)
    assert row['positions']==(expected[0].positions-100).tolist()
    assert row['hits']==expected[0].hits.astype(int).tolist()
    assert not any(60<=p<70 for p in row['positions'])
    assert len(row['positions'])>sum(row['hits'])>0
    assert result['unavailable_read_ids']==['absent']
    assert path.read_bytes()==before
    assert np.all(np.asarray(row['p_accessible'])>np.asarray(row['p_protected']))


def test_lattice_requires_explicit_observation_source_and_valid_model(tmp_path):
    state,_=fixture(tmp_path);request=dict(dataset_id='d',chrom='chr1',start=0,end=50,read_ids=['r'])
    with pytest.raises(ValueError,match='datatype'):lattice_payload(state,{**request,'chemistry':'unknown'})
    with pytest.raises(ValueError,match='50 kb'):lattice_payload(state,{**request,'end':100000})
    state.get_dataset('d').data_type='bigbed'
    with pytest.raises(ValueError,match='BAM query'):lattice_payload(state,request)


def _bam(path,start):
    with pysam.AlignmentFile(path,'wb',header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'chr1','LN':1000}]}) as bam:
        read=pysam.AlignedSegment(bam.header);read.query_name='r';read.query_sequence='ACGT'*40
        read.flag=0;read.reference_id=0;read.reference_start=start;read.mapping_quality=60
        read.cigarstring='160M';read.set_tag('MM','A+a.,4,4,4;');read.set_tag('ML',array.array('B',[255,20,255]))
        bam.write(read)
    pysam.index(str(path))


def test_same_name_in_two_merged_bams_is_never_merged(tmp_path):
    a,b=tmp_path/'a.bam',tmp_path/'b.bam';_bam(a,100);_bam(b,130)
    ds=SimpleNamespace(path=str(a),paths=[str(a),str(b)],label='m',data_type='bam',family_scan_chemistry='hia5-pacbio')
    state=SimpleNamespace(get_dataset=lambda _:ds)
    request=dict(dataset_id='d',chrom='chr1',start=100,end=300,read_ids=['r'])
    result=lattice_payload(state,request)
    # Two molecules share the name: neither is shown as one mixed row.
    assert result['reads']=={} and result['ambiguous_read_ids']==['r'] and result['unavailable_read_ids']==['r']
    only_b=SimpleNamespace(**{**ds.__dict__,'paths':[str(b)]})
    single=lattice_payload(SimpleNamespace(get_dataset=lambda _:only_b),request)['reads']['r']
    picked=lattice_payload(state,{**request,'read_identities':{'r':{'reference_start':130,'library_id':str(b.resolve())}}})
    row=picked['reads']['r']
    assert row['positions']==single['positions'] and row['identity']['reference_start']==130
    assert picked['ambiguous_read_ids']==[]


def _bam_no_marks(path,start):
    with pysam.AlignmentFile(path,'wb',header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'chr1','LN':1000}]}) as bam:
        read=pysam.AlignedSegment(bam.header);read.query_name='r';read.query_sequence='ACGT'*40
        read.flag=0;read.reference_id=0;read.reference_start=start;read.mapping_quality=60
        read.cigarstring='160M'
        bam.write(read)
    pysam.index(str(path))


def test_pin_to_an_unencodable_alignment_never_returns_another_molecule(tmp_path):
    a,b=tmp_path/'a.bam',tmp_path/'b.bam';_bam_no_marks(a,100);_bam(b,130)
    ds=SimpleNamespace(path=str(a),paths=[str(a),str(b)],label='m',data_type='bam',family_scan_chemistry='hia5-pacbio')
    state=SimpleNamespace(get_dataset=lambda _:ds)
    request=dict(dataset_id='d',chrom='chr1',start=100,end=300,read_ids=['r'])
    pinned_a=lattice_payload(state,{**request,'read_identities':{'r':{'reference_start':100,'library_id':str(a.resolve())}}})
    assert pinned_a['reads']=={} and pinned_a['unavailable_read_ids']==['r']
    # Unpinned, the shared name stays ambiguous rather than showing B's row.
    unpinned=lattice_payload(state,request)
    assert unpinned['reads']=={} and unpinned['ambiguous_read_ids']==['r']
    pinned_b=lattice_payload(state,{**request,'read_identities':{'r':{'reference_start':130,'library_id':str(b.resolve())}}})
    assert pinned_b['reads']['r']['identity']['reference_start']==130
