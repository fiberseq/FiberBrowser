"""Browser/CLI preparation parity on a real indexed, annotated BAM."""
from types import SimpleNamespace
import pysam
from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime()
from fiberhmm.io.bam_header import append_chemistry
from fiberhmm.inference.consensus.parameters import parse_options
from fiberhmm.inference.consensus.bam import load_bam_payload
from services.consensus_workflow import load_payload


def test_browser_and_package_prepare_identical_native_bam_evidence(tmp_path):
    path=tmp_path/'calls.bam'
    header=pysam.AlignmentHeader.from_dict({'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'chr1','LN':1000}]})
    header=append_chemistry(header,dict(assay='daf',enzyme='ddda',platform='pacbio',mode='daf'))
    with pysam.AlignmentFile(str(path),'wb',header=header) as bam:
        read=pysam.AlignedSegment(header);read.query_name='test_molecule'
        read.query_sequence='AYGT'*50;read.reference_id=0;read.reference_start=100
        read.mapping_quality=60;read.cigarstring='200M';read.set_tag('st','CT')
        read.set_tag('MA','200;msp:1-200;tf:61-80');bam.write(read)
    pysam.index(str(path))
    ds=SimpleNamespace(data_type='bam',paths=[str(path)],path=str(path),family_scan_chemistry='ddda')
    state=SimpleNamespace(get_dataset=lambda _:ds)
    region=dict(chrom='chr1',start=120,end=220)
    options=parse_options({'cr':{'engine':'staged_native_families'}})
    package=load_bam_payload([dict(dataset_id='d',paths=[str(path)],chemistry='ddda')],region,options)
    browser=load_payload(state,dict(region,dataset_ids=['d']),options,lambda *a:None)
    assert package==browser
    assert browser['strata'][0]['units']
    assert 'native_multi_interval_tf_intervals' in browser['strata'][0]['units'][0]


def test_export_service_passes_current_merged_view_not_old_run_ids(tmp_path,monkeypatch):
    import threading
    from services.consensus_workflow import export_family_bams
    from fiberhmm.inference.consensus import bam_export
    from fiberhmm.inference.consensus.artifacts import write_json
    folder=tmp_path/'job';folder.mkdir();write_json(folder/'evidence.json.gz',{'strata':[]})
    job=dict(status='complete',artifact_dir=str(folder),result={'frozen':True})
    state=SimpleNamespace(datasets={'merged_now':SimpleNamespace(data_type='bam',paths=['a.bam','b.bam'])},
        consensus_workflow_jobs={'j':job},consensus_workflow_lock=threading.RLock())
    calls=[]
    def export(analyses,output_dir,**kwargs):
        calls.append((analyses,output_dir,kwargs));return []
    monkeypatch.setattr(bam_export,'export_bams',export)
    response=export_family_bams(state,'j',str(tmp_path/'out'))
    assert response['grouping']=='datasets'
    assert calls[0][2]['scope']=='regions'
    assert calls[0][2]['dataset_groups']==[dict(dataset_id='merged_now',paths=['a.bam','b.bam'])]
    assert calls[0][0][0][0] is job['result']
    assert job['_bam_export_busy'] is False
    export_family_bams(state,'j',str(tmp_path/'other'),'files','full')
    assert calls[1][2]['grouping']=='files'
    assert calls[1][2]['scope']=='full'


def test_bam_export_errors_do_not_leave_job_locked(tmp_path,monkeypatch):
    import pytest
    import threading
    from services.consensus_workflow import export_family_bams
    from fiberhmm.inference.consensus import bam_export
    from fiberhmm.inference.consensus.artifacts import write_json
    write_json(tmp_path/'evidence.json.gz',{})
    job=dict(status='complete',artifact_dir=str(tmp_path),result={})
    state=SimpleNamespace(datasets={},consensus_workflow_jobs={'j':job},consensus_workflow_lock=threading.RLock())
    monkeypatch.setattr(bam_export,'export_bams',lambda *a,**k:(_ for _ in ()).throw(ValueError('changed source')))
    with pytest.raises(ValueError,match='changed source'):export_family_bams(state,'j',str(tmp_path/'out'))
    assert not job['_bam_export_busy']
