from types import SimpleNamespace
import pytest
from models.domain import ChromInfo
from services.reference_collection import load_reference_pairs
from services.gene_annotations import load_gtf
from services.files_endpoint import search_gene_payload


def test_bed12_genes_exons_and_search(tmp_path):
    path = tmp_path/'genes.bed'
    path.write_text('track name=genes\nchr1\t100\t200\tGATA1\t0\t-\t110\t190\t0\t2\t20,30,\t0,70,\n')
    data = load_gtf(str(path))
    assert data['transcripts'].iloc[0]['start'] == 100
    assert data['exons'][['start','end']].values.tolist() == [[100,120],[170,200]]
    assert search_gene_payload(SimpleNamespace(gtf_data=data),'GATA1')['chrom'] == 'chr1'
    path.write_text('chr1\t100\t200\tbad\t0\t+\t100\t200\t0\t2\t20,\t0,70,\n')
    with pytest.raises(ValueError, match='block count'):
        load_gtf(str(path))


def test_multiple_reference_pairs_are_atomic_and_route_sequence(tmp_path):
    state = SimpleNamespace(fasta=None, _chrom_info_with_circular_flags=lambda name,size: ChromInfo(name=name,size=size),
                            _reset_circular_chroms_for_reference=lambda reference: None)
    pairs=[]
    for name,sequence in [('maternal','ACGT'),('paternal','TGCA')]:
        fasta=tmp_path/f'{name}.fa'; fasta.write_text(f'>{name}\n{sequence}\n')
        bed=tmp_path/f'{name}.bed'; bed.write_text(f'{name}\t0\t4\tGENE\t0\t+\n')
        pairs.append(dict(fasta=str(fasta),annotation=str(bed)))
    result=load_reference_pairs(state,pairs)
    assert result['gene_count']==2
    assert state.fasta.fetch('maternal',0,4)=='ACGT'
    assert state.fasta.fetch('paternal',0,4)=='TGCA'
    assert state.gtf_data['transcripts']['transcript_id'].nunique()==2
    assert search_gene_payload(state,'GENE','paternal')['chrom']=='paternal'
    before=state.fasta
    with pytest.raises(ValueError,match='multiple FASTAs'):
        load_reference_pairs(state,[pairs[0],pairs[0]])
    assert state.fasta is before
    assert state.fasta.fetch('paternal',0,4)=='TGCA'
    state.fasta.close()
