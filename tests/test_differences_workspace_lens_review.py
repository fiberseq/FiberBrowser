"""Frozen-cohort lens regressions with authored source/query coordinates."""
from dataclasses import replace

import pytest

from live_lift_fixtures import MAT, TARGET, make_record, write_bam
from test_live_lift_differences import evidence  # noqa: F401
from services.differences.workspace import inspect, lens


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('ref_bp', [0, 15])
def test_read_discovered_lifted_target_has_observed_carriers_and_reference_flanks(evidence, monkeypatch, ref_bp, reverse):
    monkeypatch.setenv('FIBERBROWSER_LIVE_LIFT', '1')
    state, ds, tmp = evidence
    state.get_dataset = state.datasets.get
    # First toy map block is target = source + 1000.
    ds.paths = [write_bam(tmp/'read-edit.bam', lambda h: [
        make_record(h, 'carrier', MAT, 1900, '100M'+(f'{ref_bp}D' if ref_bp else '')+'120I100M', seq='A'*100+'C'*120+'G'*100),
        make_record(h, 'reference', MAT, 1850, '400M', seq='A'*400, flag=16 if reverse else 0)])]
    q = dict(chrom=TARGET, start=2800, end=3300, target=dict(target_id='projected-geometry:read-edit',
        revision=1, target_type='geometry', chrom=TARGET, ref_start=3000, ref_end=3000+ref_bp, alt_bp=120))
    calls = inspect(state, ds, **q)
    assert calls['targets'][0]['counts'] == [1, 1, 0]
    monkeypatch.setattr('services.lift.differences.difference_reads', lambda *a, **k: pytest.fail('display path must not be used'))
    result = lens(state, ds, **q, frozen_calls=calls, flank=20, consensus=False, include_sequences=True)
    assert result['difference_scope']['complete']
    carrier, = result['carriers']
    reference, = result['reference']
    assert carrier['seq'] == 'C'*120
    assert carrier['read']['intervals'][0][0] == -20
    assert carrier['read']['intervals'][-1][1] == 140
    assert reference['q'] == 150
    assert reference['read']['intervals'][0][0] == -20
    assert result['flank'] == 20 and result['truncated'] == dict(carriers=0, reference=0)


def test_boundary_deletions_and_hidden_supplementaries_stay_in_frozen_lifted_lens(evidence, monkeypatch):
    monkeypatch.setenv('FIBERBROWSER_LIVE_LIFT', '1')
    state, ds, tmp = evidence
    ds.live_lift.settings = replace(ds.live_lift.settings, cohort_supplementaries='all_records', supplementary_display='hide')
    ds.paths = [write_bam(tmp/'boundary.bam', lambda h: [
        make_record(h, 'left-boundary', MAT, 4900, '99M1D300M', seq='T'*399),
        make_record(h, 'right-boundary', MAT, 4900, '200M1D200M', seq='G'*400),
        make_record(h, 'supplementary', MAT, 4900, '400M', seq='A'*400, flag=2048)])]
    q = dict(chrom=TARGET, start=5800, end=6300, target=dict(target_id='assembly-insertion', revision=1,
        target_type='geometry', chrom=TARGET, ref_start=6010, ref_end=6010, alt_bp=100))
    calls = inspect(state, ds, **q)
    assert calls['targets'][0]['counts'] == [3, 0, 0]
    result = lens(state, ds, **q, frozen_calls=calls, include_sequences=True, consensus=False)
    assert result['difference_scope']['complete']
    assert {r['id']: r['seq'] for r in result['carriers']} == {
        'left-boundary': 'T'*100, 'right-boundary': 'G'*100, 'supplementary': 'A'*100}


def test_native_frozen_lens_restores_reference_rows_and_flanks(tmp_path):
    from test_differences_workspace_review import native, query
    from insertion_fixtures import SITE
    state, ds = native(tmp_path, lambda h: [
        make_record(h, 'carrier', 'chrT', SITE-150, '150M100I150M', seq='A'*150+'C'*100+'G'*150),
        make_record(h, 'reference', 'chrT', SITE-150, '300M')])
    q = query(ref=0)
    calls = inspect(state, ds, **q)
    out = lens(state, ds, **q, frozen_calls=calls, flank=25, consensus=False, include_sequences=True)
    assert out['flank'] == 25 and out['difference_scope']['complete']
    assert out['carriers'][0]['seq'] == 'C'*100
    assert out['carriers'][0]['read']['intervals'][0][0] == -25
    assert out['carriers'][0]['read']['intervals'][-1][1] == 125
    assert out['reference'][0]['read']['intervals'][0][0] == -25
    assert out['reference'][0]['read']['intervals'][-1][1] == 25



def test_minus_map_lens_keeps_observed_sequence_and_annotation_offsets(evidence, monkeypatch):
    monkeypatch.setenv('FIBERBROWSER_LIVE_LIFT', '1')
    state, ds, _ = evidence
    q = dict(chrom=TARGET, start=12700, end=13200, target=dict(target_id='minus-insertion', revision=1,
        target_type='geometry', chrom=TARGET, ref_start=12900, ref_end=12900, alt_bp=100))
    calls = inspect(state, ds, **q)
    out = lens(state, ds, **q, frozen_calls=calls, flank=20, consensus=False, include_sequences=True)
    carrier, = out['carriers']
    assert carrier['seq'] == 'A'*89+'T'+'A'*10
    assert carrier['read']['methyl_m6a'] == [89]
    assert out['difference_scope']['complete']
