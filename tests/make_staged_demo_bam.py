"""Create a small, explicitly synthetic Browser interaction-test dataset."""
from array import array
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'browser'))
from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime(strict=True)
import pysam
from fiberhmm.io.ma_tags import format_ma_tag
from fiberhmm.io.bam_header import append_chemistry


def main():
    out=Path(sys.argv[1])
    if out.exists():raise ValueError('Use a fresh test BAM path')
    header={'HD':{'VN':'1.6','SO':'coordinate'},'SQ':[{'SN':'chrTest','LN':1000}], 'CO':['MA-TYPES:v1:tf,nuc,msp']}
    header=append_chemistry(pysam.AlignmentHeader.from_dict(header),dict(assay='fiber-seq',enzyme='hia5',platform='pacbio',mode='pacbio-fiber'))
    seq='ACG'*60
    with pysam.AlignmentFile(out,'wb',header=header) as bam:
        for i in range(16):
            protected=[(60,90),(120,138)]
            marks=[p//3 for p,b in enumerate(seq) if b=='A' and not any(a<=p<z for a,z in protected)]
            deltas=[marks[0]]+[b-a-1 for a,b in zip(marks,marks[1:])]
            r=pysam.AlignedSegment();r.query_name=f'demo/{i}/ccs';r.query_sequence=seq;r.flag=0
            r.reference_id=0;r.reference_start=100;r.mapping_quality=60;r.cigar=[(0,len(seq))]
            r.set_tag('MM','A+a.,'+','.join(map(str,deltas))+';');r.set_tag('ML',array('B',[255]*len(marks)))
            r.set_tag('MA',format_ma_tag(len(seq),[],[(0,len(seq))],[(a,b-a) for a,b in protected],nuc_qual_spec='',tf_qual_spec=''))
            bam.write(r)
    pysam.index(str(out))


if __name__=='__main__':main()
