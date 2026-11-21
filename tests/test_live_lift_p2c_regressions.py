"""P2b review reproductions: missing signal, stable fits and selection identity."""
import array
from copy import deepcopy
from dataclasses import replace
from itertools import permutations
from types import SimpleNamespace

import numpy as np
import pytest

from live_lift_fixtures import MAT, TARGET, make_record, write_bam
from test_live_lift_endpoints import lift_env, _add
from test_live_lift_cohort import row
from services.lift.cohort import analysis_id, raw_qnames, prepare_lift_cohort
from services.lift.live_lift import LiftSettings


@pytest.mark.parametrize('overlap_mode', ['aggressive', 'conservative'])
@pytest.mark.parametrize('connector', [False, True])
def test_centroid_holes_are_missing_within_an_overlapping_peak(overlap_mode, connector):
    from services.dynamic_clustering import assign_reads_to_centroids
    read = row()
    read['intervals'] = [[0, 10, 0], [90, 100, 0]]
    read['live_lift']['segments'] = [[0, 100, 1, '+', True]] if connector else [
        [0, 10, 1, '+', True], [90, 100, 1, '+', True]]
    read['live_lift']['connectors'] = [[10, 90]] if connector else []
    result = assign_reads_to_centroids([read], [[0, 100]], {0: [0] * 10, 1: [1] * 10}, [10],
        region_start=500, subnucleosomal_threshold=90, overlap_mode=overlap_mode)
    assert result['assignments'] == {'molecule': 1}


def test_centroid_without_observed_sample_positions_is_unassigned():
    from services.dynamic_clustering import assign_reads_to_centroids
    read = row(start=1)
    read['intervals'] = [[1, 9, 0]]
    read['live_lift']['segments'] = [[1, 9, 1, '+', True]]
    result = assign_reads_to_centroids([read], [[0, 100]], {0: [0] * 10, 1: [1] * 10}, [10],
        subnucleosomal_threshold=90, overlap_mode='aggressive')
    assert result['assignments'] == {'molecule': -1}


@pytest.mark.parametrize('mixed', [False, True])
def test_centroid_mask_keeps_class_bits_separate_from_spatial_positions(mixed):
    from services.dynamic_clustering import assign_reads_to_centroids
    read = row()
    read['intervals'] = [[1, 9, 0]]
    read['live_lift']['segments'] = [[1, 9, 1, '+', True]]
    terms = [dict(source='footprint_class', group=dict(consensusJobId='j', consensusStateId='A'))]
    if mixed:
        terms.append(dict(source='layer', layer=None, sizeMin=0))
    rules = [dict(id='cart', enabled=True, terms=terms)]
    width = 11 if mixed else 1
    result = assign_reads_to_centroids([read], [[0, 100], [100, 200]],
        {0: [0] * (width + 10), 1: [1] * (width + 10)}, [width, 10],
        subnucleosomal_threshold=90, overlap_mode='aggressive',
        peak_modes=['cluster_rule:cart', 'accessibility'], cluster_feature_rules=rules,
        cluster_rule_context=dict(resolve_footprint_class=lambda *_: [(2, 8, 1)]))
    assert result['assignments'] == {'molecule': 1}


@pytest.mark.parametrize('display_index', [False, True, 'builder', 'display_blocks'])
@pytest.mark.parametrize('aliases', [False, True])
def test_packed_selection_preserves_qname_and_cohort_identity(display_index, aliases):
    import pickle
    from services.packed_reads import (PackedReads, PackedReadBuilder, ReadDisplayIndex,
                                      _encode_block, select_read_ids)
    from services.byte_cache import retained_size
    reads = [dict(id='sample|run|read_2', analysis_id='cohort_3', intervals=[[0, 100, 0]])] * 2
    if display_index == 'builder':
        builder = PackedReadBuilder()
        for read in reads:
            builder.append(read)
        packed = builder.finish()
    elif display_index == 'display_blocks':
        packed = PackedReads.from_display_blocks([
            (_encode_block(reads), ReadDisplayIndex(reads), retained_size(reads))])
    else:
        packed = PackedReads(reads, display_index=display_index)
    packed = pickle.loads(pickle.dumps(packed))
    choices = ['sample|run|read_2', 'cohort_3']
    if aliases:
        choices += ['sample|run|read', 'cohort']
    for identity in choices:
        assert list(select_read_ids(packed, {identity}, aliases=aliases)) == reads
    assert list(select_read_ids(packed, {'absent'}, aliases=aliases)) == []


@pytest.mark.parametrize('fold_molecule,fold_orientation_rows', [(False, False), (False, True), (True, False), (True, True)])
def test_qname_decode_validates_identity_and_preserves_raw_pipes(fold_molecule, fold_orientation_rows):
    settings = LiftSettings(fold_molecule=fold_molecule, fold_orientation_rows=fold_orientation_rows,
                            molecule_groups=[['source', 'group|nested']])
    dataset = SimpleNamespace(id='lifted', paths=['source'], live_lift=SimpleNamespace(settings=settings))
    names = ['read', 'sample|run|read', 'group|nested|read|1', 'lift-cohort:v1:broken']
    assert raw_qnames(names, dataset) == set(names)
    for name in names:
        from services.lift.joint import molecule_key
        read = row(molecule=molecule_key('group|nested', name))  # B11: escaped, so it never collides
        read['id'] = name
        encoded = analysis_id(read, settings)
        assert encoded != name
        assert ' ' in encoded  # The marker cannot collide with a raw SAM QNAME.
        assert raw_qnames([encoded], dataset) == {name}
        foreign = replace(settings, molecule_groups=[['source', 'other']])
        other = SimpleNamespace(id='other', paths=['source'], live_lift=SimpleNamespace(settings=foreign))
        assert raw_qnames([encoded], other) == {encoded}


@pytest.mark.parametrize('payload', [
    'broken', '{}', '[]', '["group|read","read",null,null]',
    '["group|read","read",null,null,"1",0]',
    '["group|read","read","unexpected-record",null,"1"]',
    '["group|read","read",null,0,"1"]',
    '["group|other","read",null,null,"1"]',
    '["group|read","read",null,null,{}]',
    '["group|read", "read", null, null, "1"]',  # Noncanonical JSON.
])
def test_unrecognized_cohort_encodings_pass_through_verbatim(payload):
    settings = LiftSettings(fold_molecule=True, molecule_groups=[['source', 'group']])
    dataset = SimpleNamespace(id='lifted', paths=['source'], live_lift=SimpleNamespace(settings=settings))
    value = 'lift-cohort:v1 ' + payload
    assert raw_qnames([value], dataset) == {value}


def test_cohort_identity_components_cannot_alias_through_pipes():
    settings = LiftSettings(fold_orientation_rows=True)
    a = row(molecule='group|read', record='part|record')
    a['id'] = 'read'
    b = row(molecule='group|read|part', record='record')
    b['id'] = 'read|part'
    assert analysis_id(a, settings) != analysis_id(b, settings)


@pytest.mark.parametrize('settings', [{}, {'fold_orientation_rows': True}, {'fold_molecule': True}])
@pytest.mark.parametrize('scope', ['qname', 'cohort'])
def test_pipe_qname_explicit_endpoint_scope_cold_equals_warm(lift_env, tmp_path, settings, scope):
    client, state, manifest, _ = lift_env
    name = 'sample|run|read'
    bam = write_bam(tmp_path / 'pipe.bam', lambda h: [make_record(h, name, MAT, 2500, '3300M',
        tags=[('ns', array.array('I', [400, 2450, 3000])), ('nl', array.array('I', [200, 200, 200]))])])
    did = _add(client, manifest, bam, settings=settings)['dataset']['id']
    query = dict(chrom=TARGET, start=3500, end=3900)
    body = dict(dataset_ids=[did], peak_regions=[dict(start=3600, end=3700)], method='combinatorial')
    def fit(selection=None):
        response = client.post('/api/cluster_all', params=query, json={**body,
            **({'read_ids': {did: selection}} if selection is not None else {})})
        assert response.status_code == 200, response.text
        return response.json()['results'][did]['assignments']
    expected = fit()
    assert len(expected) == 1
    selection = [name] if scope == 'qname' else list(expected)
    state._broad_cache.clear()
    state._working_set_cache.clear()
    cold = fit(selection)
    fit()  # An unscoped request warms the broad cache, as in the review probe.
    warm = fit(selection)
    assert cold == warm == expected


@pytest.fixture
def joint_fixture(lift_env, monkeypatch):
    """Variable native/MAT/PAT rows exercise real endpoint fitting and dedup."""
    from models.domain import WorkingSet
    from services.analysis_query import AnalysisReadQuery
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam, settings={'molecule_groups': [[bam, 'shared']]})['dataset']['id']
    native = state.add_dataset('native', bam)
    native.molecule_groups = [[bam, 'shared']]
    rng = np.random.default_rng(712)
    # Many equally frequent patterns make label ties visible. The continuous
    # open widths also expose seeded k-means' sensitivity to input row order.
    patterns = rng.integers(0, 11, size=(60, 12))
    cohorts = {}
    for panel, indices in [('native', range(60)), ('MAT', range(0, 30)), ('PAT', range(30, 60))]:
        reads = []
        for i in indices:
            read = row(molecule=f'shared|read{i:02d}')
            read['id'] = f'read{i:02d}'
            read['source_path'] = bam
            read['intervals'] = []
            for p, width in enumerate(patterns[i]):
                left, cut, right = 100 * p, 100 * p + 10 * int(width), 100 * (p + 1)
                if cut > left:
                    read['intervals'].append([left, cut, 0])
                if right > cut:
                    read['intervals'].append([cut, right, 100])
            if panel == 'native':
                read.pop('live_lift')
            else:
                read['live_lift']['segments'] = [[0, 1200, 1, '+', True]]
                read['live_lift']['calls'] = {}
            reads.append(read)
        cohorts[panel] = reads
    def working_set(self, _state, dataset_id, **kwargs):
        key = 'native' if dataset_id == 'native' else kwargs.get('lift_hap')
        reads = deepcopy(cohorts[key])
        if dataset_id != 'native':
            reads = prepare_lift_cohort(reads, 'analysis', state.datasets[did].live_lift.settings).rows
        return WorkingSet(reads, total_overlapping=len(reads), total_spanning=len(reads),
                          chrom=TARGET, start=0, end=1200)
    monkeypatch.setattr(AnalysisReadQuery, 'build_working_set', working_set)
    query = dict(chrom=TARGET, start=0, end=1200)
    peaks = [dict(start=100 * p, end=100 * (p + 1)) for p in range(12)]
    windows = [dict(dataset_id='native', result_key='native', **query)] + [
        dict(dataset_id=did, result_key=hap, lift_hap=hap, **query) for hap in ('MAT', 'PAT')]
    return client, state, did, query, peaks, windows, cohorts


def _assignments(response):
    assert response.status_code == 200, response.text
    data = response.json()
    return ({key: value['assignments'] for key, value in data['results'].items()},
            data.get('cluster_patterns'), data['joint_cohort'])


def _policy(state, did, policy):
    state.datasets['native'].joint_dedup = policy
    dataset = state.datasets[did]
    dataset.live_lift.settings = replace(dataset.live_lift.settings, joint_dedup=policy)


@pytest.mark.parametrize('policy', ['off', 'by_molecule'])
@pytest.mark.parametrize('method', ['combinatorial', 'binary', 'kmeans', 'minibatch'])
def test_joint_endpoint_window_permutations_have_identical_memberships_and_labels(joint_fixture, policy, method):
    client, state, did, query, peaks, windows, cohorts = joint_fixture
    _policy(state, did, policy)
    expected = None
    for order in permutations(windows):  # Includes native/MAT/PAT and its reverse.
        result = _assignments(client.post('/api/cluster_all', params=query, json=dict(
            dataset_ids=['native', did], viewports=order, peak_regions=peaks, method=method, k=4,
            sample_seed='order-probe')))
        if expected is None:
            expected = result
            assert sum(map(len, result[0].values())) == (120 if policy == 'off' else 60)
        assert result == expected
        for reads in cohorts.values():
            reads.reverse()


@pytest.mark.parametrize('policy', ['off', 'by_molecule'])
@pytest.mark.parametrize('method', ['combinatorial', 'binary', 'kmeans', 'minibatch'])
@pytest.mark.parametrize('balance', [False, True])
@pytest.mark.parametrize('mode', ['joint', 'separate'])
def test_matched_endpoint_view_panel_and_row_permutations_are_identical(joint_fixture, policy, method, balance, mode):
    client, state, did, query, peaks, windows, cohorts = joint_fixture
    _policy(state, did, policy)
    native = dict(id='native', **query, peak_regions=peaks, panels=[windows[0]])
    lifted = dict(id='lifted', **query, peak_regions=peaks, panels=windows[1:])
    expected = None
    for reverse_views, reverse_panels in [(False, False), (True, False), (False, True), (True, True)]:
        lifted['panels'] = list(reversed(windows[1:])) if reverse_panels else windows[1:]
        views = [lifted, native] if reverse_views else [native, lifted]
        result = _assignments(client.post('/api/cluster_matched_views', json=dict(
            views=views, method=method, mode=mode, balance_views=balance, k=4, sample_seed='order-probe')))
        if expected is None:
            expected = result
            assert sum(map(len, result[0].values())) == (120 if policy == 'off' else 60)
        assert result == expected
        for reads in cohorts.values():
            reads.reverse()


@pytest.mark.parametrize('engine', ['compact', 'columnar', 'dataframe'])
def test_equal_frequency_pattern_labels_break_ties_lexicographically(engine):
    from services.cluster_assignment import cluster_compact_reads
    from services.columnar_clustering import ColumnarPatterns
    patterns = [[0, 100, 0], [0, 100, 100]]
    reads = [dict(id='open', intervals=[patterns[0]]), dict(id='closed', intervals=[patterns[1]])]
    def fit(values):
        if engine == 'columnar':
            columnar = ColumnarPatterns([[0, 100]], 0)
            for read in values:
                columnar.append(read)
            return columnar.finish()
        if engine == 'dataframe':
            from services.cluster_assignment import cluster_reads
            from services.read_metrics import compact_reads_to_dataframe
            return cluster_reads(compact_reads_to_dataframe(values, 0, 100), [[0, 100]],
                                 n_clusters=2, start=0, method='combinatorial')
        return cluster_compact_reads(values, [[0, 100]], 0, n_clusters=2, method='combinatorial')
    forward = fit(reads)
    reverse = fit(list(reversed(reads)))
    assert forward[0] == reverse[0] == {'open': 1, 'closed': 0}


@pytest.mark.parametrize('endpoint', ['difference_sequence', 'provenance'])
def test_new_lift_routes_allow_owner_and_deny_remote_and_public(lift_env, monkeypatch, endpoint):
    import server
    from services import runtime
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient
    client, state, manifest, bam = lift_env
    did = _add(client, manifest, bam)['dataset']['id']
    if endpoint == 'difference_sequence':
        from services.lift import differences
        calls = []
        def sequence(*args, **kwargs):
            calls.append(True)
            return {'sequence': 'ACGT'}
        monkeypatch.setattr(differences, 'difference_sequence', sequence)
        method, path = 'GET', '/api/lift/difference_sequence'
        kwargs = dict(params=dict(dataset_id=did, chrom=TARGET, item_id='test', pos=3500))
    else:
        state.add_dataset('native', bam)
        method, path = 'POST', '/api/lift/provenance/native'
        kwargs = dict(json={'molecule_groups': [[bam, 'shared']]})
    assert client.request(method, path, **kwargs).status_code == 200
    remote = TestClient(server.app, client=('192.0.2.1', 50000), base_url='http://remote.example', headers=auth_headers())
    assert remote.request(method, path, **kwargs).status_code == 403
    monkeypatch.setattr(runtime, '_public_mode', True)
    response = client.request(method, path, **kwargs)
    assert response.status_code == 403
    assert response.json()['message'] == 'This action is disabled on a public FiberBrowser server.'
    if endpoint == 'difference_sequence':
        assert calls == [True]
