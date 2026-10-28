"""Orphans require a known primary with no target placement, across the whole genome."""
import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll


@pytest.mark.parametrize('primary_pos,orphan', [(500, False), (5000, True)])
def test_supplementary_marks_only_an_unprojectable_primary(tmp_path, primary_pos, orphan):
    ll.clear_primary_cache()
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / 'map'))
    path = write_bam(tmp_path / 'source.bam', lambda h: [
        make_record(h, 'molecule', MAT, 2000, '100M', flag=2048,
                    tags=[('SA', f'{PAT},{primary_pos + 1},+,100M,60,0;')]),
        make_record(h, 'molecule', PAT, primary_pos, '100M'),
    ])
    # The primary is outside the selected haplotype and viewport. SA lookup
    # must distinguish an offscreen primary from one that cannot lift.
    def load(lookup=True):
        return ll.load_lifted_rows(handle, [path], TARGET, 3000, 3100, haplotypes=['H#1'],
                                  settings=ll.LiftSettings(primary_lookup=lookup), dataset_id='test',
                                  loader_options={'hide_terminal_gaps': False}).rows
    for _ in range(2):  # cached primary metadata must give the same mark
        (row,) = load()
        assert row['live_lift']['source']['supplementary']
        assert bool(row['live_lift'].get('orphan')) is orphan
    (unknown,) = load(False)
    assert 'orphan' not in unknown['live_lift']


def test_primary_deletion_alone_is_not_a_placement(tmp_path):
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / 'map'))
    assert not ll._primary_lifts(handle, PAT, [(4500, 4600)])
    assert ll._primary_lifts(handle, PAT, [(3500, 3600)])
    assert not ll._primary_lifts(handle, PAT, [])
    # The read's hull crosses a mapped piece, but none of its bases align there.
    from types import SimpleNamespace
    from threading import Lock
    fake = SimpleNamespace(lock=Lock(), map=SimpleNamespace(source_to_target=lambda *args: [
        SimpleNamespace(primary=True, q_start=100, q_end=200)]))
    assert not ll._primary_lifts(fake, 'source', [(0, 100), (200, 300)])
