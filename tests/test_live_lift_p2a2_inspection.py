"""Regressions reproduced from the P2a2 review with synthetic public data."""
import pysam
from test_live_lift_differences import evidence, two_hap_evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from services.lift import differences as diff
from services.lift.reads import lifted_reads_for_region

def test_mixed_deletion(two_hap_evidence):
    state, ds, tmp = two_hap_evidence
    ds.paths = [write_bam(tmp / 'deletion-probe.bam', lambda h: [
        make_record(h, 'mat-deleted', MAT, 2900, '200M', seq='A'*200, tags=[('MD', '200')]),
        make_record(h, 'pat-reference', PAT, 2900, '220M', seq='A'*220, tags=[('MD', '220')])])]
    spans = diff._inspection_spans(ds.live_lift, TARGET, 4000, 4010, None)
    result = diff.difference_reads(state, ds, TARGET, 4000, 4010, item_id=f'MAT:{MAT}:3000-3000:deletion')
    assert {r['id']: r['allele'] for r in result['rows']} == {'mat-deleted': 'deleted', 'pat-reference': 'same_as_grch38'}
    assert result['hap_status'] == {'MAT': 'deletion', 'PAT': 'aligned'}

def test_inspection_annotation_cache(evidence, lift_env):
    sample_state, sample_ds, _ = evidence
    client, state, _, _ = lift_env
    added = _add(client, sample_ds.live_lift.manifest, sample_ds.paths[0])
    assert added.get('success'), added
    did = added['dataset']['id']
    state.fasta = sample_state.fasta
    params = dict(dataset_id=did, chrom=TARGET, pos=1100)
    cold = client.get('/api/lift/difference_reads', params=params)
    assert cold.status_code == 200, cold.text
    warm = client.get('/api/reads/compact', params=dict(dataset_id=did, chrom=TARGET, start=1000, end=7000,
        include_layers=False, include_methylation=False, full_working_set=True, max_reads=1000))
    assert warm.status_code == 200, warm.text
    reused = client.get('/api/lift/difference_reads', params=params)
    assert reused.status_code == 200, reused.text
    before = next(r for r in cold.json()['rows'] if r['id']=='hg')['chromatin']
    after = next(r for r in reused.json()['rows'] if r['id']=='hg')['chromatin']
    assert before['nearest_m6a_bp'] == 1 and after == before

def test_cross_hap_supplementary_allele(two_hap_evidence):
    state, ds, tmp = two_hap_evidence
    seq = 'A'*100+'C'+'A'*99
    ds.paths = [write_bam(tmp / 'crosshap.bam', lambda h: [
        make_record(h, 'same-molecule', MAT, 0, '200M', seq=seq, flag=2048,
            tags=[('MD','200'),('SA',f'{PAT},1,+,200M,60,1;')]),
        make_record(h, 'same-molecule', PAT, 0, '200M', seq=seq,
            tags=[('MD','100A99'),('SA',f'{MAT},1,+,200M,60,0;')])])]
    result = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    display = lifted_reads_for_region(ds, TARGET, 1090, 1110, dict(include_cigar=True, target_fasta=state.fasta))
    assert len(result['rows']) == 2
    assert {(r['supplementary'], r['hap_label'], r['hg002'], r['allele']) for r in result['rows']} == {(True, 'PAT', 'A', 'other'), (False, 'PAT', 'A', 'other')}
    assert {r['cigar'][0]['source'] for r in display} == {'reads'}


def test_inspection_recovers_records_missing_from_sampled_cache(evidence, monkeypatch):
    state, ds, _ = evidence
    cold = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    full = lifted_reads_for_region(ds, TARGET, 1050, 1151, dict(include_layers=True, include_methylation=True))
    import services.read_auxiliary_endpoint as aux
    # A complete annotation cache is still insufficient when its sample omits
    # one of the records fetched by the bounded inspection.
    monkeypatch.setattr(aux, '_cached_lift_rows', lambda *a, **k: ([r for r in full if r['id'] != 'hg'], (ds.id, TARGET, 1050)))
    warm = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    assert warm == cold


def test_missing_correspondence_is_explicit_per_parent(evidence):
    state, ds, _ = evidence
    result = diff.difference_reads(state, ds, TARGET, 19000, 19001)
    assert result['rows'] == []
    assert set(result['hap_status'].values()) == {'no_correspondence'}


def test_cross_parent_ambiguous_expected_allele_stays_unknown(two_hap_evidence):
    state, ds, tmp = two_hap_evidence
    ds.live_lift.source_fasta = None
    seq = 'A'*100+'C'+'A'*99
    ds.paths = [write_bam(tmp / 'ambiguous-parent.bam', lambda h: [
        make_record(h, 'molecule', MAT, 0, '200M', seq=seq, flag=2048,
                    tags=[('MD', '200'), ('SA', f'{PAT},1,+,200M,60,1;')]),
        make_record(h, 'molecule', PAT, 0, '200M', seq=seq,
                    tags=[('MD', '100A99'), ('SA', f'{MAT},1,+,200M,60,0;')]),
        make_record(h, 'conflicting-reference', PAT, 0, '200M', seq='A'*100+'G'+'A'*99, tags=[('MD', '200')])])]
    result = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    row = next(r for r in result['rows'] if r['supplementary'])
    assert row['hap_label'] == 'PAT' and row['hg002'] is None
    assert row['allele'] == 'unknown' and row['alignment_hg002'] == 'C'
