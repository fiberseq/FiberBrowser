"""Regression cases from the P2a review probes, through the real display routes.

Small caps and budgets deliberately exercise cold/warm ordering without a
large BAM. Synthetic geometry isolates point markers, badge-only rows and
connectors; real lifted rows check every parallel call/provenance group.
"""
from copy import deepcopy
import gzip
import json
from pathlib import Path

import pysam
import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam
from test_live_lift_endpoints import lift_env, _add, _compact
from services.lift import live_lift as ll
from services.lift.reads import lifted_reads_for_region
from services.working_sets import project_broad_read_to_viewport


def _dataset(env, **extra):
    client, state, manifest, bam = env
    result = _add(client, manifest, bam, **extra)
    assert result['success'], result
    return client, state.datasets[result['dataset']['id']]


@pytest.mark.parametrize('hap', ['MAT', 'PAT'])
def test_haplotype_before_working_cap_cold_and_warm(lift_env, hap):
    client, ds = _dataset(lift_env)
    lift_env[1].max_working_reads = 1
    cold = _compact(client, ds.id, end=19000, lift_hap=hap, sample_seed='probe')
    warm = _compact(client, ds.id, end=19000, lift_hap=hap, sample_seed='probe')
    assert cold['reads'] and cold['reads'] == warm['reads']
    assert len(cold['reads']) == 1
    # Rebuild from just the warm broad cache too: the working cap still
    # follows haplotype filtering when the viewport cache is absent.
    lift_env[1]._working_set_cache.clear()
    assert _compact(client, ds.id, end=19000, lift_hap=hap, sample_seed='probe')['reads'] == cold['reads']
    assert {r['live_lift']['hap_label'] for r in cold['reads']} == {hap}


def test_compact_all_display_filter_before_cap(lift_env):
    client, ds = _dataset(lift_env, settings={'supplementary_display': 'hide'})
    lift_env[1].max_working_reads = 1
    params = dict(chrom=TARGET, start=1000, end=9000, sample_seed='probe', max_reads=1)
    for _ in range(2):
        response = client.get('/api/reads/compact_all', params=params)
        assert response.status_code == 200, response.text
        rows = response.json()['datasets'][ds.id]['reads']
        assert rows and not any(r['live_lift']['source']['supplementary'] for r in rows)


def test_implicit_dataset_has_same_display_rules(lift_env):
    client, ds = _dataset(lift_env, settings={'supplementary_display': 'hide'})
    explicit = _compact(client, ds.id)
    implicit = _compact(client, None)
    assert explicit['reads'] and explicit['reads'] == implicit['reads']
    assert not any(r['live_lift']['source']['supplementary'] for r in implicit['reads'])


def _groups(row):
    groups = {'intervals': row['intervals']}
    if row.get('fire'):
        groups['fire'] = row['fire']
    groups.update({f'layer:{n}': layer['intervals'] for n, layer in row.get('layers', {}).items()})
    return groups


@pytest.mark.parametrize('packed', [False, True])
def test_crop_retains_every_call_group(lift_env, packed):
    from services.packed_reads import PackedReads
    client, ds = _dataset(lift_env)
    rows = lifted_reads_for_region(ds, TARGET, 1000, 9000, {'include_layers': True})
    # The toy source has no explicit FIRE tag. Add a parallel group to the
    # real row so packing/cropping must retain its identities just like layers.
    row = next(r for r in rows if r['id'] == 'plus')
    row['fire'] = [[2900, 3110, 210], [5000, 5100, 100]]
    row['live_lift']['calls']['fire'] = ['fire:0', 'fire:1']
    row['live_lift']['call_parts']['fire'] = [[0, 0], [1, 1]]
    if packed:
        row = next(iter(PackedReads([row])))
    cropped, _ = project_broad_read_to_viewport(row, viewport_offset=2000, region_width=3000,
                                               include_methylation=True, layer_key=('nuc', 'tf', 'msp', 'fire'))
    assert {'intervals', 'fire', 'layer:nuc', 'layer:msp'} <= set(_groups(cropped))
    for field in ('calls', 'call_parts'):
        for name, intervals in _groups(cropped).items():
            assert name in cropped['live_lift'][field]
            assert len(cropped['live_lift'][field][name]) == len(intervals)
            assert cropped['live_lift'][field][name] == [v for iv, v in zip(_groups(row)[name], row['live_lift'][field][name])
                                                       if min(iv[1], 5000) > max(iv[0], 2000)]
    # Endpoint crops also retain named layer provenance on a warm broad load.
    _compact(client, ds.id, layer_names='nuc,tf,msp')
    result = _compact(client, ds.id, start=3000, end=6000, layer_names='nuc,tf,msp')
    plus = next(r for r in result['reads'] if r['id'] == 'plus')
    assert 'layer:nuc' in plus['live_lift']['calls']


@pytest.mark.parametrize('offset', [0, 5])
def test_crop_keeps_identified_markers_in_all_groups_only_for_lift(offset):
    row = {'id': 'marker', 'intervals': [[5, 5, 3]], 'fire': [[5, 5, 3]],
           'layers': {'nuc': {'intervals': [[5, 5, 3]]}},
           'live_lift': {'segments': [[0, 10, 0, '+', True]], 'connectors': [], 'badges': [],
                         'calls': {g: ['ns:0'] for g in ('intervals', 'fire', 'layer:nuc')},
                         'call_parts': {g: [[1, 2]] for g in ('intervals', 'fire', 'layer:nuc')}}}
    kwargs = dict(viewport_offset=offset, region_width=10, include_methylation=False, layer_key=('nuc', 'fire'))
    cropped, _ = project_broad_read_to_viewport(row, **kwargs)
    for name, intervals in _groups(cropped).items():
        assert list(intervals[0]) == [5-offset, 5-offset, 3]
        assert cropped['live_lift']['calls'][name] == ['ns:0']
        assert cropped['live_lift']['call_parts'][name] == [[1, 2]]
    native = deepcopy(row)
    native.pop('live_lift')
    assert project_broad_read_to_viewport(native, **kwargs)[0] is None


def test_badge_only_crop_survives():
    badge = {'id': 'badge', 'intervals': [], 'live_lift': {'segments': [[0, 10, 0, '+', True]],
             'connectors': [], 'badges': [[10, 'source_insertion', 100, 100, 'R']]}}
    row, spanning = project_broad_read_to_viewport(badge, viewport_offset=10, region_width=10,
                                                  include_methylation=False, layer_key=())
    assert row and row['intervals'] == [[0, 0, 0]]
    assert row['live_lift']['badges'][0][0] == 0 and not spanning


def test_connector_only_crop_is_not_spanning():
    from services.read_selection import is_read_spanning
    row = {'id': 'connector', 'intervals': [[0, 5, 5], [15, 20, 5]],
           'live_lift': {'segments': [[0, 20, 0, '+', True]], 'connectors': [[5, 15]], 'badges': []}}
    cropped, spanning = project_broad_read_to_viewport(row, viewport_offset=7, region_width=5,
                                                       include_methylation=False, layer_key=())
    assert cropped is None and not spanning
    from services.packed_reads import ReadDisplayIndex
    assert list(ReadDisplayIndex([row]).overlapping(7, 12)) == []
    row['live_lift']['connectors'] = []
    row['live_lift']['badges'] = [[10, 'source_insertion', 100, 100, 'I']]
    assert is_read_spanning(row, 20)  # a badge's point cut rejoins


def test_right_edge_badge_survives_crop_and_display_index():
    from services.packed_reads import ReadDisplayIndex
    row = {'id': 'edge', 'intervals': [], 'live_lift': {'segments': [[10, 20, 0, '+', True]],
           'connectors': [], 'badges': [[10, 'source_insertion', 100, 100, 'L']]}}
    cropped, _ = project_broad_read_to_viewport(row, viewport_offset=0, region_width=10,
                                               include_methylation=False, layer_key=())
    assert cropped and cropped['live_lift']['badges'][0][0] == 10
    assert len(list(ReadDisplayIndex([row]).overlapping(0, 10))) == 1


def test_neutral_crop_extent_starts_at_body_after_connector():
    row = {'id': 'uncalled', 'intervals': [], 'live_lift': {'segments': [[0, 20, 0, '+', True]],
           'connectors': [[5, 15]], 'badges': []}}
    cropped, _ = project_broad_read_to_viewport(row, viewport_offset=7, region_width=13,
                                               include_methylation=False, layer_key=())
    assert cropped['intervals'] == [[8, 13, 0]]


@pytest.mark.parametrize('reuse', [False, True])
def test_coverage_uses_panel_supplementary_filter(lift_env, monkeypatch, reuse):
    from services.lift import reads
    _client, ds = _dataset(lift_env, settings={'supplementary_display': 'hide'})
    rows = [{'id': 'supp', 'live_lift': {'hap_label': 'MAT', 'molecule': 'supp', 'record': 'supp:0',
             'segments': [[0, 100, 0, '+', True]], 'source': {'supplementary': True}}}]
    monkeypatch.setattr(reads, 'lifted_reads_for_region', lambda *a, **k: rows)
    result = reads.lifted_coverage(ds, TARGET, 2000, 2100, 1, **({'rows': rows} if reuse else {}))
    assert result['coverage'] == [0]


@pytest.mark.parametrize('direct', [False, True])
def test_endpoint_spanning_uses_body_not_connector(lift_env, direct):
    client, ds = _dataset(lift_env)
    payload = _compact(client, ds.id, start=4002, end=4008, spanning='true',
                       hide_terminal_gaps='false' if direct else 'true')
    assert payload['reads'] == [] and payload['total_spanning'] == 0


def test_one_molecule_overlapping_rows_has_depth_one(lift_env, tmp_path):
    from test_live_lift_regressions import _dup_map, _u32
    client, state, _manifest, _bam = lift_env
    manifest = _dup_map(tmp_path / 'dupmap')
    bam = write_bam(tmp_path / 'dup.bam', lambda h: [make_record(h, 'dup', MAT, 0, '2000M',
                    tags=[('ns', _u32([500, 1500])), ('nl', _u32([150, 150]))])])
    did = _add(client, manifest, bam, haplotypes=['H#1'])['dataset']['id']
    response = client.get('/api/coverage', params=dict(dataset_id=did, chrom=TARGET, start=1000, end=2200, bins=12))
    assert response.status_code == 200, response.text
    assert response.json()['max'] == 1


@pytest.mark.parametrize('kind', ['record', 'byte'])
def test_budget_refuses_without_caching_truncated_rows(lift_env, monkeypatch, kind):
    client, ds = _dataset(lift_env)
    original = ll.LoadBudget
    monkeypatch.setattr(ll, 'LoadBudget', lambda: original(**({'max_records': 1} if kind == 'record' else {'max_bytes': 1})))
    response = client.get('/api/reads/compact', params=dict(chrom=TARGET, start=1000, end=9000,
                          dataset_id=ds.id, hide_terminal_gaps='false', full_working_set='true'))
    assert response.status_code == 413, response.text
    assert 'zoom in' in response.json()['notice']
    assert ('1 source records' if kind == 'record' else 'MB') in response.json()['notice']
    assert not lift_env[1]._methylation_cache and not lift_env[1]._broad_cache
    monkeypatch.setattr(ll, 'LoadBudget', original)
    assert _compact(client, ds.id)['reads']


@pytest.mark.parametrize('direct', [False, True])
def test_target_sampling_reports_estimated_counts(lift_env, monkeypatch, direct):
    from services import read_sampling
    client, ds = _dataset(lift_env)
    all_rows = _compact(client, ds.id, end=19000, hide_terminal_gaps='false' if direct else 'true')['reads']
    monkeypatch.setattr(read_sampling, 'sample_level', lambda *a, **k: 2)
    payload = _compact(client, ds.id, end=19000, full_working_set='false',
                       hide_terminal_gaps='false' if direct else 'true')
    info = payload['working_sampling']
    assert info['level'] == 2 and info['kept'] < info['total'] and info['estimated']
    assert 0 < len(payload['reads']) < len(all_rows)
    assert {r['live_lift']['molecule'] for r in payload['reads']} < {r['live_lift']['molecule'] for r in all_rows}
    assert _compact(client, ds.id, end=19000, full_working_set='false',
                    hide_terminal_gaps='false' if direct else 'true')['working_sampling'] == info


def test_dataset_estimate_uses_target_fetch_plan(lift_env, monkeypatch):
    from services.read_sampling import estimate_dataset_reads
    _client, ds = _dataset(lift_env)
    seen = []
    def estimate(paths, plan):
        seen.extend(c.contig for c in plan.contigs)
        return 123.0
    monkeypatch.setattr(ll, 'estimate_lifted_reads', estimate)
    assert estimate_dataset_reads(lift_env[1], ds, TARGET, 1000, 19000) == 123
    assert set(seen) == {MAT, PAT}
    def refuse(*a, **k):
        raise ll.LiftRefused('budget')
    monkeypatch.setattr(ll, 'plan_fetch', refuse)
    assert estimate_dataset_reads(lift_env[1], ds, TARGET, 1000, 19000) is None


def test_validation_checks_each_bam_and_settings_atomically(lift_env, tmp_path):
    client, state, manifest, bam = lift_env
    wrong = write_bam(tmp_path / 'unrelated.bam', lambda h: [make_record(h, 'x', 'chrZ', 10, '50M')],
                      contigs=(('chrZ', 1000),))
    response = _add(client, manifest, bam, paths=[bam, wrong])
    assert not response['success'] and wrong in response['error']
    mat = write_bam(tmp_path / 'matonly.bam', lambda h: [make_record(h, 'mat', MAT, 1000, '100M')],
                    contigs=((MAT, 10000),))
    result = _add(client, manifest, mat, haplotypes=['MAT'])
    ds = state.datasets[result['dataset']['id']]
    key = ds.live_lift.key()
    response = client.post(f'/api/lift/datasets/{ds.id}/settings', json={'haplotypes': ['MAT', 'PAT']}).json()
    assert not response['success'] and mat in response['error']
    assert ds.live_lift.key() == key and ds.live_lift.haplotypes == ['H#1']


def _fasta(path, sequences):
    path.write_text(''.join(f'>{name}\n{sequence}\n' for name, sequence in sequences.items()))
    pysam.faidx(str(path))
    return str(path)


def test_session_fingerprints_relink_and_import_identity(lift_env, tmp_path):
    import shutil
    from models.requests import SessionExportRequest, SessionImportRequest
    from services.session_files import check_session_files
    from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
    client, state, manifest, bam = lift_env
    source = _fasta(tmp_path / 'source.fa', {MAT: 'A'*10000, PAT: 'A'*10000})
    did = _add(client, manifest, bam, source_fasta=source)['dataset']['id']
    exported = build_session_export_for_request(state, SessionExportRequest(chrom=TARGET, start=1000, end=9000))['session']
    paths = {str(bam), str(manifest), source}
    assert paths <= exported['file_fingerprints'].keys()
    assert {f['path'] for f in check_session_files(exported)['files']} >= paths
    # Move the inputs, including the manifest's relative sidecar files, so
    # import can succeed only if every registered source is relinked.
    moved = tmp_path / 'moved'
    moved.mkdir()
    mapping = {}
    for old in paths:
        old_path = Path(old)
        new = moved / old_path.name
        if old == str(manifest):
            shutil.move(str(old_path.parent), str(moved / 'map'))
            new = moved / 'map' / old_path.name
        else:
            shutil.move(old, new)
            suffix = '.bai' if old == str(bam) else '.fai'
            shutil.move(old + suffix, str(new) + suffix)
        mapping[old] = str(new)
    checked = check_session_files(exported, mapping=mapping)
    assert all(f['status'] != 'missing' for f in checked['files'])
    from services.lift.registration import restore_from_session
    state.remove_dataset(did)
    entry = next(d for d in exported['datasets'] if d['id'] == did)
    direct = restore_from_session(state, entry, path_mapping=mapping)['dataset']
    assert direct['paths'] == [mapping[str(bam)]]
    assert direct['live_lift']['source_fasta'] == mapping[source]
    imported = import_session_for_request(state, SessionImportRequest(session=exported, path_mapping=mapping))
    restored = next(d for d in imported['datasets'] if d['id'] == did)
    assert restored['live_lift']['manifest'] == mapping[str(manifest)]
    assert state.datasets[did].live_lift.source_fasta == mapping[source]
    assert restored['source_identity'] == state.datasets[did].to_dict()['source_identity']
    assert restored['live_lift']['key'] == state.datasets[did].live_lift.key()


def test_anchor_checks_and_source_fasta_session(lift_env, tmp_path):
    client, state, manifest, bam = lift_env
    # Give this synthetic map more than 16 independent >=200 bp blocks so
    # the check exercises the full spot-check budget, including the - chain.
    payload_path = Path(manifest).parent / 'toy.t0.chrT.json.gz'
    with gzip.open(payload_path, 'rt') as handle:
        payload = json.load(handle)
    payload['blocks']['2'] = [[15000 + i*200, i*200, 200] for i in range(20)]
    with gzip.open(payload_path, 'wt') as handle:
        json.dump(payload, handle)
    # + anchors compare A/A; the - chain compares T to revcomp(A).
    target = list('A' * 20000)
    target[12000:14000] = 'T' * 2000
    target_path = _fasta(tmp_path / 'target.fa', {TARGET: ''.join(target).lower()})
    source_path = _fasta(tmp_path / 'source.fa', {MAT: 'A'*10000, PAT: 'A'*10000})
    state.fasta = pysam.FastaFile(target_path)
    try:
        result = _add(client, manifest, bam, source_fasta=source_path)
        assert result['success'], result
        assert result['validation']['anchors']['status'] == 'consistent'
        assert result['validation']['anchors']['checked'] == 16
        ds = state.datasets[result['dataset']['id']]
        assert ds.to_dict()['live_lift']['validation'] == result['validation']
        from services.lift.registration import session_entry, restore_from_session
        entry = {**ds.to_dict(), **session_entry(ds)}
        assert entry['live_lift']['source_fasta'] == source_path
        state.remove_dataset(ds.id)
        restored = restore_from_session(state, entry)
        assert restored['dataset']['live_lift']['source_fasta'] == source_path
        mutated = _fasta(tmp_path / 'mutated.fa', {MAT: 'C' + 'A'*9999, PAT: 'A'*10000})
        bad = _add(client, manifest, bam, source_fasta=mutated)
        assert not bad['success'] and bad['validation']['anchors']['status'] == 'mismatch'
    finally:
        state.fasta.close()
        state.fasta = None


def test_missing_fasta_reports_anchors_not_checked(lift_env, tmp_path):
    client, ds = _dataset(lift_env)
    anchors = ds.to_dict()['live_lift']['validation']['anchors']
    assert anchors['status'] == 'not checked' and 'not checked' in anchors['message']
    state = lift_env[1]
    state.fasta = pysam.FastaFile(_fasta(tmp_path / 'target.fa', {TARGET: 'A'*20000}))
    try:
        out = _add(client, lift_env[2], lift_env[3])
        assert out['validation']['anchors']['status'] == 'not checked'
    finally:
        state.fasta.close()
        state.fasta = None


def test_correspondence_only_never_decodes_and_keys_haplotype(lift_env, monkeypatch):
    from services.lift import reads
    client, ds = _dataset(lift_env)
    def forbidden(*a, **k):
        pytest.fail('correspondence must not decode BAMs')
    monkeypatch.setattr(reads, 'lifted_reads_for_region', forbidden)
    monkeypatch.setattr(ll, 'decode_source_records', forbidden)
    for hap in ('MAT', 'PAT'):
        response = client.get('/api/coverage', params=dict(chrom=TARGET, start=0, end=20000, bins=20,
                              dataset_id=ds.id, lift_hap=hap, lift_correspondence_only='true'))
        assert response.status_code == 200, response.text
        data = response.json()
        assert data['coverage'] is None
        assert set(data['live_lift']['haplotypes']) == {hap}
        assert data['live_lift']['haplotypes'][hap]['depth'] is None
        assert data['live_lift']['pooled']['depth'] is None
        assert max(data['live_lift']['pooled']['correspondence']) == 1


def test_coverage_reuses_broad_rows_and_invalidates_lift_key(lift_env, monkeypatch):
    from services.lift import reads
    client, ds = _dataset(lift_env)
    _compact(client, ds.id)
    original = reads.lifted_reads_for_region
    def forbidden(*a, **k):
        pytest.fail('warm coverage must reuse display geometry')
    monkeypatch.setattr(reads, 'lifted_reads_for_region', forbidden)
    params = dict(chrom=TARGET, start=3000, end=6000, bins=20, dataset_id=ds.id)
    warm = client.get('/api/coverage', params=params).json()
    monkeypatch.setattr(reads, 'lifted_reads_for_region', original)
    direct = reads.lifted_coverage(ds, TARGET, 3000, 6000, 20)
    assert warm == direct
    key = ds.live_lift.key()
    assert client.post(f'/api/lift/datasets/{ds.id}/settings', json={'settings': {'rejoin_bp': 0}}).json()['success']
    assert ds.live_lift.key() != key
    calls = []
    def record(*a, **k):
        calls.append(True)
        return original(*a, **k)
    monkeypatch.setattr(reads, 'lifted_reads_for_region', record)
    assert client.get('/api/coverage', params=params).status_code == 200
    assert calls


def test_sampling_fits_decode_budget_despite_skipped_records(lift_env, monkeypatch):
    from services import read_sampling
    client, ds = _dataset(lift_env)
    original = ll.LoadBudget
    monkeypatch.setattr(ll, 'LoadBudget', lambda: original(max_records=2))
    monkeypatch.setattr(read_sampling, 'sample_level', lambda *a, **k: 2)
    payload = _compact(client, ds.id, end=19000, full_working_set='false')
    assert payload['reads']
    assert payload['working_sampling']['estimated'] is True
    assert payload['working_sampling']['kept'] == 2
    assert payload['working_sampling']['total'] == 4


def test_coverage_excludes_alternatives_and_deduplicates_pooled_haps(lift_env):
    from services.lift.reads import lifted_coverage
    _client, ds = _dataset(lift_env)
    def row(label, alt=False):
        return {'id': label, 'live_lift': {'hap_label': label, 'molecule': 'one', 'record': 'record:0', 'alt': alt,
                                         'segments': [[0, 1000, 0, '+', True]], 'connectors': []}}
    result = lifted_coverage(ds, TARGET, 2000, 3000, 10, rows=[row('MAT'), row('PAT'), row('MAT', True)])
    assert result['max'] == 1
    result = lifted_coverage(ds, TARGET, 2000, 3000, 10, rows=[row('MAT', True)])
    assert result['max'] == 0


@pytest.mark.parametrize("explicit_home", [False, True])
def test_launcher_isolates_child_home_and_prints_explicit_relaunch(tmp_path, monkeypatch, capsys, explicit_home):
    import importlib.util
    import os
    import shlex
    import sys
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('live_lift_demo', Path(__file__).parents[1] / 'scripts/live_lift_demo.py')
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setenv('HOME', str(tmp_path / 'scratch-home'))
    monkeypatch.setenv('PGLIFT_WORK', str(tmp_path / 'work'))
    monkeypatch.setenv('LIVE_LIFT_DEMO_DATA', str(tmp_path / 'demo data'))
    spec.loader.exec_module(module)
    assert module.HANDOFF == str(tmp_path / 'demo data')
    assert module.DEFAULT_MAP.startswith(str(tmp_path / 'work'))
    assert not module.DEFAULT_FASTA.startswith(os.environ['HOME'])
    data = tmp_path / 'demo data'
    data.mkdir()
    for name in ('SAMPLE_A.alu_chr3.hg002v1.1.bam', 'SAMPLE_A.alu_chr3.GRCh38.bam', 'map.json', 'target.fa'):
        (data / name).touch()
    home = tmp_path / 'server home'
    seen = {}
    class Process:
        def wait(self):
            return 0
        def poll(self):
            return 0
    def popen(args, **kwargs):
        seen.update(args=args, **kwargs)
        return Process()
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            pass
        def read(self):
            return b'{"success": true}'
    monkeypatch.setattr(module.subprocess, 'Popen', popen)
    monkeypatch.setattr(module.subprocess, 'run', lambda *a, **k: pytest.fail('build must be optional'))
    monkeypatch.setattr(module, 'wait_ready', lambda *a: None)
    monkeypatch.setattr(module.urllib.request, 'urlopen', lambda *a, **k: Response())
    monkeypatch.setattr(module.tempfile, 'mkdtemp', lambda **k: str(home))
    monkeypatch.setattr(sys, 'argv', ['demo', '--data-root', str(data),
                                     '--fasta', str(data/'target.fa'), '--map', str(data/'map.json'), '--port', '8899']
                                    + (['--home', str(home)] if explicit_home else []))
    module.main()
    assert home.is_dir() and seen['env']['HOME'] == str(home)
    assert os.environ['HOME'] == str(tmp_path / 'scratch-home')
    output = capsys.readouterr().out
    relaunch = shlex.split(next(line.removeprefix('Relaunch: ') for line in output.splitlines() if line.startswith('Relaunch: ')))
    for flag in ('--data-root', '--home', '--fasta', '--map', '--lift-bam', '--native-bam', '--port'):
        assert flag in relaunch


@pytest.mark.parametrize('direct', [False, True])
def test_compact_all_spanning_uses_body(lift_env, direct):
    client, ds = _dataset(lift_env)
    response = client.get('/api/reads/compact_all', params=dict(chrom=TARGET, start=4002, end=4008,
                          spanning='true', hide_terminal_gaps='false' if direct else 'true'))
    assert response.status_code == 200, response.text
    data = response.json()['datasets'][ds.id]
    assert data['reads'] == [] and data['total_spanning'] == 0
