"""Public MA exporter -> fresh Browser read loader -> cart analysis."""
import array
import hashlib
import pysam
import pytest
from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime()
from fiberhmm.inference.consensus.bam_export import export_bams
from services.compact_read_loader import build_compact_reads_from_bam
from services.footprint_analysis import FootprintLayerResolver,build_interval_table

@pytest.mark.parametrize('reverse',[False,True])
@pytest.mark.parametrize('cross',[False,True])
def test_export_reload_preserves_multiple_families_and_declared_semantics(tmp_path,reverse,cross):
    path=tmp_path/'input.bam'
    header={'HD':{'SO':'coordinate'},'SQ':[{'SN':'chr1','LN':1000}]}
    with pysam.AlignmentFile(str(path),'wb',header=header) as bam:
        r=pysam.AlignedSegment(bam.header);r.query_name='test';r.query_sequence='A'*200
        r.reference_id=0;r.reference_start=100;r.cigarstring='200M';r.flag=16 if reverse else 0
        r.set_tag('MA','200;msp.:1-200;tf.QQQ:61-20');r.set_tag('AQ',array.array('B',[80,20,30]));bam.write(r)
    pysam.index(str(path))
    with pysam.AlignmentFile(str(path),'rb') as bam: sha=hashlib.sha256(next(bam).to_string().encode()).hexdigest()
    span=[220,240] if reverse else [160,180]
    unit=dict(unit_id='u',positions=list(range(100,300)),source_members=[dict(library_id=str(path),record_sha256=sha)])
    payload=dict(region=dict(chrom='chr1',start=100,end=300),strata=[dict(dataset_id='d',units=[unit])],input_files=[dict(dataset_id='d',path=str(path),size=path.stat().st_size,mtime_ns=path.stat().st_mtime_ns)])
    result=dict(manifest=dict(input_digest='roundtrip',parameters={'cross':{'enabled':cross}}),datasets={'d':{'cr':{'records':[dict(unit_id='d::u',proposals=[dict(source_interval=span,compatible_families=['a','b'])])]}}})
    rows=export_bams([(result,payload)],tmp_path/'export')
    reads=build_compact_reads_from_bam(rows[0]['bam'],'chr1',100,300,spanning_only=False,hide_terminal_gaps=False)
    assert len(reads)==1
    layer_name='tf_cross_consensus' if cross else 'tf_consensus'
    layer=reads[0]['layers'][layer_name]
    assert layer['intervals']==[[span[0]-100,span[1]-100,20]]*2
    assert len(set(layer['annotation_names']))==2
    assert layer['family_confidence_kind']=='unavailable'
    assert layer['quality_names']==['tq','fi','fq','op','sq','q0']
    resolver=FootprintLayerResolver(layer_name)
    table=build_interval_table(reads,resolver.intervals,100,resolver.family_metadata)
    assert table.family_names.tolist()==layer['annotation_names']
    assert table.family_confidence_kinds.tolist()==[0,0]
    assert table.family_layers.tolist()==[layer_name]*2


def test_cart_keeps_same_slot_different_names_and_layers_separate():
    from services.footprint_analysis import compute_group_memberships
    def layer(name):return dict(intervals=[[10,30,20]],annotation_names=[name],quality_names=['fi','fq'],qualities=[[1],[0]],family_confidence_kind='unavailable')
    reads=[dict(id='a',layers={'tf_consensus':layer('fhcr_a')}),dict(id='b',layers={'tf_consensus':layer('fhcr_b')}),dict(id='x',layers={'tf_cross_consensus':layer('fhxcr_x')})]
    resolver=FootprintLayerResolver('all_fp',selected_layers=('tf_consensus','tf_cross_consensus'))
    table=build_interval_table(reads,resolver.intervals,100,resolver.family_metadata)
    groups=[dict(familyId=1,familyAnnotationName=name,layer=lyr,minFamilyConfidence=0) for name,lyr in [('fhcr_a','tf_consensus'),('fhcr_b','tf_consensus'),('fhxcr_x','tf_cross_consensus')]]
    assert compute_group_memberships(table,groups,[])=={0:{'a'},1:{'b'},2:{'x'}}
    groups[0]['familyId']=99
    assert compute_group_memberships(table,groups,[])[0]=={'a'}
    groups[0]['minFamilyConfidence']=.01
    assert compute_group_memberships(table,groups,[])[0]==set()
