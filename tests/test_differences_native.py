"""Independent native baseline; asking for a v2 envelope must never need a map."""
import json
from types import SimpleNamespace

import pytest

from services import sv_endpoint


def test_native_versioned_adapter_preserves_geometry_without_map_or_sequence(monkeypatch):
    # Independently authored: two same-size sequence-distinct inserts, a spanning
    # reference read, and a partial read. Sequence-free scans keep geometry.
    rows = [
        {'id': 'synthetic-a', 'reference_start': 0, 'reference_end': 300, 'sv': [{'t': 'I', 'ref': 100, 'len': 100, 'q': 100}]},
        {'id': 'synthetic-c', 'reference_start': 0, 'reference_end': 300, 'sv': [{'t': 'I', 'ref': 100, 'len': 100, 'q': 100}]},
        {'id': 'synthetic-ref', 'reference_start': 0, 'reference_end': 300, 'sv': []},
        {'id': 'synthetic-partial', 'reference_start': 0, 'reference_end': 90, 'sv': []},
    ]
    def no_map(*a, **k):
        raise AssertionError('native adapter requested a map')
    monkeypatch.setattr('services.lift.live_lift.open_lift_map', no_map)
    monkeypatch.setattr(sv_endpoint, 'scan_view', lambda *a, **k: rows)
    args = dict(dataset_id='synthetic-dataset', chrom='chrT', start=0, end=300, t='I', ref=100, length=100, margin=20)
    legacy = sv_endpoint.sv_split_payload(SimpleNamespace(), **args)
    versioned = sv_endpoint.sv_split_payload(SimpleNamespace(), **args, payload_version=2)
    assert {k: v for k, v in versioned.items() if k != 'differences'} == legacy
    assert legacy['counts'] == [2, 1, 1]
    envelope = json.loads(json.dumps(versioned['differences']))
    assert envelope['geometry_counts'] == [2, 1, 1]
    assert envelope['exact_counts'] == {'target': 0, 'reference': 0, 'unknown': 4}
    assert envelope['scope']['analysis_scope'] == 'native_only'
    assert len(envelope['calls_by_molecule']) == 4
    assert len(envelope['membership']['rows']['synthetic-dataset']) == 4
    assert envelope['target']['target_type'] == 'geometry'


@pytest.mark.parametrize('include_duplicates', [False, True])
def test_default_dataset_and_duplicate_memberships_match_classified_molecules(monkeypatch, include_duplicates):
    rows = [
        {'id': 'kept', 'row_id': 'kept-row', 'reference_start': 0, 'reference_end': 300, 'sv': []},
        {'id': 'duplicate', 'row_id': 'duplicate-row', 'duplicate': True, 'reference_start': 0, 'reference_end': 300, 'sv': []},
        # A supplementary nonduplicate cannot revive a duplicate-only primary.
        {'id': 'duplicate', 'row_id': 'supplementary-row', 'supplementary': True, 'reference_start': 0, 'reference_end': 300, 'sv': []},
    ]
    dataset = SimpleNamespace(data_type='bam', paths=[])
    state = SimpleNamespace(datasets={'synthetic-dataset': dataset}, dataset_order=['synthetic-dataset'],
                            get_dataset=lambda key: dataset if key == 'synthetic-dataset' else None)
    monkeypatch.setattr(sv_endpoint, '_scan', lambda *a, **k: rows)
    result = sv_endpoint.sv_split_payload(state, dataset_id='', chrom='chrT', start=0, end=300,
                                         t='I', ref=100, length=100, margin=20,
                                         payload_version=2, include_duplicates=include_duplicates)
    envelope = result['differences']
    calls = envelope['calls_by_molecule']
    membership = envelope['membership']['rows']['synthetic-dataset']
    assert {c['molecule_id']['library_id'] for c in calls.values()} == {'synthetic-dataset'}
    assert {c['molecule_id']['raw_name'] for c in calls.values()} == ({'kept', 'duplicate'} if include_duplicates else {'kept'})
    assert set(membership) == ({'kept-row', 'duplicate-row', 'supplementary-row'} if include_duplicates else {'kept-row'})
    assert set(membership.values()) == set(calls)
    assert envelope['geometry_counts'] == result['counts']
