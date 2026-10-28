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


def test_primary_existence_stops_before_loading_other_targets(tmp_path, monkeypatch):
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / 'map'))
    lm = handle.map
    lm.target_to_source(TARGET, 0, 20_000)  # selected target is already loaded
    # Another chromosome has a candidate chain for this source. Put it first
    # to verify that the loaded placement is checked before any cold target.
    ci = len(lm.chains)
    lm.chains.append({**lm.chains[0], 'target': 1})
    lm.by_source[0].insert(0, ci)
    handle.primary_chains.add(ci)
    original = lm.chain_data

    def chain_data(index):
        assert index != ci, 'existence check loaded an unnecessary target'
        return original(index)

    monkeypatch.setattr(lm, 'chain_data', chain_data)
    assert ll._primary_lifts(handle, MAT, [(100, 200)])


@pytest.mark.parametrize('blocks,expected', [([(100, 200)], True), ([(5000, 5100)], False)])
def test_primary_probe_caches_result_without_retaining_target(tmp_path, monkeypatch, blocks, expected):
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / 'map'))
    assert not handle.map._blocks
    assert ll._primary_lifts(handle, MAT, blocks) is expected
    assert not handle.map._blocks

    def unexpected_load(index):
        pytest.fail('repeated primary probe loaded target blocks')

    monkeypatch.setattr(handle.map, 'chain_data', unexpected_load)
    assert ll._primary_lifts(handle, MAT, blocks) is expected


def test_primary_probes_reuse_payload_for_other_chains(tmp_path, monkeypatch):
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / 'map'))
    assert ll._primary_lifts(handle, MAT, [(100, 200)])

    def unexpected_read(*args, **kwargs):
        pytest.fail('another chain probe reread the same target payload')

    monkeypatch.setattr('services.lab.paths.open_read', unexpected_read)
    assert ll._primary_lifts(handle, MAT, [(7000, 7100)])  # reverse chain
    assert not handle.map._blocks


@pytest.mark.parametrize('mode', ['empty', 'noncanonical_key', 'wrong_target'])
def test_primary_probe_payload_fallbacks(tmp_path, mode):
    import gzip
    import json

    path = write_toy_sidecar(tmp_path / 'map')
    payload = tmp_path / 'map' / 'toy.t0.chrT.json.gz'
    with gzip.open(payload, 'rt') as fh:
        data = json.load(fh)
    if mode == 'empty':
        data['blocks']['0'] = []
    elif mode == 'noncanonical_key':
        data['blocks']['00'] = data['blocks'].pop('0')
    else:
        data['target'] = 'wrong'
    with gzip.open(payload, 'wt') as fh:
        json.dump(data, fh)
    handle = ll.LiftMapHandle(path)
    if mode == 'wrong_target':
        with pytest.raises(ValueError, match="expected 'chrT'"):
            ll._primary_lifts(handle, MAT, [(100, 200)])
    else:
        assert ll._primary_lifts(handle, MAT, [(100, 200)]) is (mode != 'empty')
    assert not handle.map._blocks


def test_primary_existence_matches_full_projection(tmp_path):
    import random

    path = write_toy_sidecar(tmp_path / 'map')
    oracle, handle = ll.LiftMapHandle(path), ll.LiftMapHandle(path)
    rng = random.Random(17)
    # Includes reverse chains, alternative-only placements, source gaps,
    # touching boundaries and hulls whose mapped bases are all deletions.
    cases = [[(7000, 7001)], [(8999, 9000)], [(9600, 9900)],
             [(4999, 5000), (5100, 5101)], [(5000, 5100)]]
    for _ in range(500):
        points = sorted(rng.randrange(0, 10_001) for _ in range(4))
        cases.append(list(zip(points[::2], points[1::2])))
    for contig in (MAT, PAT, 'unknown'):
        for blocks in cases:
            pieces = oracle.map.source_to_target(contig, blocks[0][0], blocks[-1][1])
            expected = any(p.primary and any(a < p.q_end and b > p.q_start for a, b in blocks)
                           for p in pieces)
            assert ll._primary_lifts(handle, contig, blocks) is expected
    assert not handle.map._blocks
