"""Public synthetic regressions for the phase-four review findings."""
from types import SimpleNamespace

import pytest

from insertion_fixtures import SITE
from live_lift_fixtures import make_record, write_bam
from services.differences.workspace import inspect, _carrier_molecules


def native(tmp_path, records, libraries=1):
    paths = [write_bam(tmp_path / f'library-{i}.bam', records,
                       contigs=(('chrT', 300000),)) for i in range(libraries)]
    ds = SimpleNamespace(id='native', data_type='bam', paths=paths,
                         molecule_groups=list(zip(paths, [f'library-{i}' for i in range(libraries)])))
    state = SimpleNamespace(datasets={ds.id: ds}, get_dataset=lambda _: ds,
                            translate_chrom=lambda c: c, fasta=None)
    return state, ds


def query(alt=100, ref=4, **target):
    return dict(chrom='chrT', start=SITE-1000, end=SITE+1000, target=dict(
        target_id='alternate', revision=1, target_type='geometry', chrom='chrT',
        ref_start=SITE, ref_end=SITE+ref, alt_bp=alt, **target))


def test_replacement_duplicate_names_use_qualified_membership(tmp_path):
    state, ds = native(tmp_path, lambda h: [make_record(h, 'shared', 'chrT', SITE-100,
                       '100M4D100I100M')], libraries=2)
    out = inspect(state, ds, **query())
    assert out['targets'][0]['counts'] == [2, 0, 0]
    rows = out['membership']['rows'][ds.id]
    assert len(set(rows.values())) == 2
    assert 'shared' not in rows
    assert 'shared' not in out['membership']['legacy_aliases'][ds.id]

    from services.working_sets import _load_broad_reads
    from services.compact_read_loader import _build_compact_reads_from_bam_region
    display = _load_broad_reads(dataset=ds, dataset_id=ds.id, chrom='chrT',
        broad_start=SITE-200, broad_end=SITE+300, broad_width=500,
        include_methylation=False, layer_key=(), include_layer_qualities=False,
        build_bam_reads=_build_compact_reads_from_bam_region,
        build_bigbed_reads=lambda *a, **k: [], load_bigbed_marks=lambda *a, **k: [])
    assert len(display) == 2
    assert {rows[row['analysis_id']] for row in display} == set(rows.values())


@pytest.mark.parametrize('chemistry,base,observed', [('none', 'A', 'A'), ('CT', 'C', 'T'), ('GA', 'G', 'A')])
@pytest.mark.parametrize('reverse', [False, True])
def test_exact_replacement_preserves_qualified_chemistry(tmp_path, chemistry, base, observed, reverse):
    # Explicit chemistry is in canonical molecule orientation; reflected
    # records need the complemented conversion matrix exactly once.
    if reverse and chemistry != 'none':
        complement = str.maketrans('ACGT', 'TGCA')
        base, observed = base.translate(complement), observed.translate(complement)
    state, ds = native(tmp_path, lambda h: [make_record(h, 'carrier', 'chrT', SITE-100,
        '100M4D100I100M', seq='A'*100+observed*100+'A'*100, flag=16 if reverse else 0)])
    q = query()
    geometry = inspect(state, ds, **q)
    molecule = next(iter(geometry['targets'][0]['calls_by_molecule']))
    q['target'].update(target_type='exact', candidates={'alternate': base*100, 'reference': 'ACGT'},
        competition_complete=True, chemistry_by_name={molecule: {'chemistry': chemistry, 'provenance': 'synthetic'}})
    out = inspect(state, ds, **q)['targets'][0]
    assert out['counts'] == out['geometry_counts'] == [1, 0, 0]
    assert out['sequence_unresolved_count'] == 0


def test_conflicting_replacement_policy_changes_counts_and_frozen_cohort(tmp_path):
    state, ds = native(tmp_path, lambda h: [
        make_record(h, 'conflict', 'chrT', SITE-600, '600M4D500I600M'),
        make_record(h, 'conflict', 'chrT', SITE+200000, '1700M', flag=2048)])
    q = query(alt=500)
    q['end'] = SITE+210000
    excluded = inspect(state, ds, **q)
    included = inspect(state, ds, **q, include_conflicting=True)
    assert excluded['targets'][0]['counts'] == [0, 0, 1]
    assert included['targets'][0]['counts'] == [1, 0, 0]
    assert not _carrier_molecules(excluded)
    assert len(_carrier_molecules(included)) == 1


@pytest.mark.parametrize('level', ['putative', 'conflicting', 'ambiguous'])
def test_policy_applies_to_geometry_before_group_shortcut(level):
    from services.differences.call_policy import molecule_group
    value = dict(call=dict(assignment='unknown', level=None), geometry_group=2,
                 geometry_evidence=dict(assignment='target', level=level))
    assert molecule_group(value, 'geometry', {}) == 2
    assert molecule_group(value, 'geometry', {'include_'+level: True}) == 0


def test_nonmatching_insertion_is_other_observation_including_sequence_page(tmp_path):
    from services.differences.workspace import observations, sequence
    state, ds = native(tmp_path, lambda h: [make_record(h, 'other', 'chrT', SITE-100,
                       '100M200I100M', seq='A'*400)])
    q = query(ref=0)
    block, = observations(state, ds, **q)['blocks']
    assert block['observation_role'] == 'other'
    page = sequence(state, ds, **q, row_ids=['other'], record_id=block['record_id'])
    assert page['observation_role'] == 'other' and page['sequence'] == 'A'*200


def test_expanded_blocks_use_confirmed_exact_calls_and_supporting_records(tmp_path):
    from services.differences.workspace import alternate_blocks
    state, ds = native(tmp_path, lambda h: [
        make_record(h, 'carrier', 'chrT', SITE-100, '100M500I100M', seq='A'*700),
        make_record(h, 'nearby', 'chrT', SITE-130, '100M25D5M500I100M', seq='A'*705),
        make_record(h, 'competing', 'chrT', SITE-100, '100M500I100M', seq='C'*700),
        make_record(h, 'clip', 'chrT', SITE, '1S200M'),
        make_record(h, 'reference', 'chrT', SITE-150, '300M'),
        make_record(h, 'reference', 'chrT', SITE, '80S100M', flag=2048)])
    q = query(alt=500, ref=0)
    q['target'].update(target_type='exact', candidates={'alternate': 'A'*500, 'competitor': 'C'*500, 'reference': ''},
        competition_complete=True, chemistry_by_name={name: dict(chemistry='none', provenance='synthetic')
            for name in ('carrier', 'nearby', 'competing', 'clip', 'reference')})
    calls = inspect(state, ds, **q, include_putative=False)
    expected = _carrier_molecules(calls)
    blocks = alternate_blocks(state, ds, **q)['blocks']
    assert {b['row_id'] for b in blocks} == {'carrier', 'nearby'}
    assert {b['molecule_id'] for b in blocks} == expected
    assert all(b['seq_q'][1]-b['seq_q'][0] == 500 for b in blocks)


def test_replacement_clip_windows_use_the_corresponding_boundary_and_minimum():
    import pysam
    from services.differences.workspace import _query_window
    q = query(alt=500, ref=35)['target']
    r = pysam.AlignedSegment()
    r.reference_start, r.cigarstring = SITE-100, '100M80S'
    assert _query_window(r, q)[:5] == (100, 180, 0, 500, 'partial')
    r.reference_start, r.cigarstring = SITE+35, '80S100M'
    assert _query_window(r, q)[:5] == (0, 80, 420, 500, 'partial')
    r.cigarstring = '1S100M'
    assert _query_window(r, q) is None



def test_interrupted_native_replacement_cannot_reenter_geometry_cohort(tmp_path):
    state, ds = native(tmp_path, lambda h: [
        make_record(h, 'one', 'chrT', SITE-100, '100M4D100I100M'),
        make_record(h, 'two', 'chrT', SITE-100, '100M4D100I100M')])
    result = inspect(state, ds, **query(), policy={'max_records': 1})
    assert not _carrier_molecules(result)
    assert result['targets'][0]['counts'][0] == result['targets'][0]['geometry_counts'][0] == 0


def test_native_putative_lens_respects_frozen_policy_without_expanding_unconfirmed_clip(tmp_path):
    from services.differences.workspace import lens, alternate_blocks
    state, ds = native(tmp_path, lambda h: [make_record(h, 'partial', 'chrT', SITE-200, '200M80S')])
    q = query(ref=0)
    calls = inspect(state, ds, **q)
    assert calls['targets'][0]['counts'] == [1,0,0]
    assert not alternate_blocks(state, ds, **q)['blocks']
    out = lens(state, ds, **q, frozen_calls=calls, consensus=False)
    assert len(out['carriers']) == 1 and out['carriers'][0]['partial'] == 'start'
