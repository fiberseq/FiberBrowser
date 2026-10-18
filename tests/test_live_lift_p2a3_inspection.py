"""P2a3 review reproductions using synthetic, public fixtures."""
from test_live_lift_differences import evidence, two_hap_evidence
from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from services.lift import differences as diff, live_lift as ll
from services.lift.reads import lifted_reads_for_region


def test_off_window_primary_cold_warm_and_display(two_hap_evidence, monkeypatch):
    state, ds, tmp = two_hap_evidence
    ds.paths = [write_bam(tmp / 'off-window.bam', lambda h: [
        make_record(h, 'molecule', MAT, 0, '200M', seq='A'*100+'C'+'A'*99, flag=2048,
                    tags=[('MD', '200'), ('SA', f'{PAT},501,+,200M,60,0;')]),
        make_record(h, 'molecule', PAT, 500, '200M', seq='A'*200,
                    tags=[('MD', '200'), ('SA', f'{MAT},1,+,200M,60,0;')])])]
    ll.clear_primary_cache()
    cold = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    normal = lifted_reads_for_region(ds, TARGET, 1050, 1151, dict(include_layers=True, include_methylation=True))
    assert {r['live_lift']['hap_label'] for r in normal} == {'PAT'}
    import services.read_auxiliary_endpoint as aux
    monkeypatch.setattr(aux, '_cached_lift_rows', lambda *a, **k: (normal, (ds.id, TARGET, 1050)))
    warm = diff.difference_reads(state, ds, TARGET, 1100, 1101)
    assert cold == warm
    assert {(r['hap_label'], r['hg002'], r['allele']) for r in cold['rows']} == {('PAT', 'A', 'other')}


def test_missing_primary_uses_one_budget_and_is_not_cached(two_hap_evidence, monkeypatch):
    state, ds, tmp = two_hap_evidence
    ds.paths = [write_bam(tmp / 'missing-primary.bam', lambda h: [
        make_record(h, 'molecule', MAT, 0, '200M', seq='A'*200, flag=2048,
                    tags=[('MD', '200'), ('SA', f'{PAT},501,+,200M,60,0;')])])]
    original = ll.lookup_primary
    calls = []
    def lookup(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(ll, 'lookup_primary', lookup)
    for count in (1, 2):
        diff.difference_reads(state, ds, TARGET, 1100, 1101)
        assert len(calls) == count
        assert not any(v is None for v in ll._PRIMARY_CACHE.values())


def test_cross_parent_insertion_keeps_observed_and_expected_separate(two_hap_evidence):
    state, ds, tmp = two_hap_evidence
    ds.paths = [write_bam(tmp / 'cross-insertion.bam', lambda h: [
        make_record(h, 'molecule', MAT, 4900, '300M', seq='A'*300, flag=2048,
                    tags=[('MD', '300'), ('SA', f'{PAT},4901,+,300M,60,0;')]),
        make_record(h, 'molecule', PAT, 4900, '300M', seq='A'*300,
                    tags=[('MD', '300'), ('SA', f'{MAT},4901,+,300M,60,0;')])])]
    key = f'MAT:{MAT}:5000-5100:insertion'
    result = diff.difference_reads(state, ds, TARGET, 6010, 6010, item_id=key, include_sequence=True)
    row = next(r for r in result['rows'] if r['supplementary'])
    assert row['hap_label'] == 'PAT' and row['hg002'] == ''
    assert row['alignment_hg002'] == 'A'*100
    assert row['carries_insertion'] and row['alignment_ins_id'] == key
    assert row['allele'] == 'other' and row.get('ins_id') != key
    assert result['sequence'] is None


def test_read_only_insertion_sequence_without_map_id(evidence):
    state, ds, tmp = evidence
    ds.paths = [write_bam(tmp / 'read-insertion.bam', lambda h: [
        make_record(h, 'carrier', MAT, 400, '100M80I100M', seq='A'*100+'G'*80+'A'*100,
                    tags=[('MD', '200')])])]
    result = diff.difference_reads(state, ds, TARGET, 1500, 1500, lift_hap='MAT', include_sequence=True)
    row = result['rows'][0]
    assert row['carries_insertion'] and row['read_bases_length'] == 80
    assert row['hg002'] == '' and row['allele'] == 'other'
    assert result['sequence']['ins_id'] == row['ins_id']
    assert result['sequence']['sequence'] == 'G'*80


def test_omitted_insertion_id_prefers_requested_parent(two_hap_evidence):
    state, ds, tmp = two_hap_evidence
    ds.paths = [write_bam(tmp / 'carrier.bam', lambda h: [make_record(h, 'carrier', MAT, 4900, '300M', seq='A'*300, tags=[('MD', '300')])])]
    result = diff.difference_reads(state, ds, TARGET, 6010, 6010, lift_hap='MAT', include_sequence=True)
    assert result['sequence'] and result['sequence']['ins_id'].startswith('MAT:')
