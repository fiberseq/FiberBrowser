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
