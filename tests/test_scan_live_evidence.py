"""Full compact-row evidence, including reversals, insertions and scan parity."""
from types import SimpleNamespace as NS
from pathlib import Path
import os
import shutil

import pytest
pysam = pytest.importorskip('pysam')

from live_lift_fixtures import write_toy_sidecar, write_bam, make_record, MAT, PAT, SSIZE
from nuc_fixtures import header, _mm


@pytest.fixture
def lifted(tmp_path):
    import array
    from services.lift.live_lift import open_lift_map, LiftSettings
    from models.domain import Dataset
    sidecar = write_toy_sidecar(tmp_path / 'map')
    # The Python reader's small fixture omits native deserialization metadata.
    import json
    manifest = json.loads(Path(sidecar).read_text())
    manifest.update(generator=dict(tool='fixture', version='1', command='', params={}),
                    graph=dict(path='', file_bytes=0, nodes=0, paths=0, fingerprint='fixture'),
                    net_min_gap=0, coverage={})
    for contig in manifest['targets'] + manifest['sources']:
        contig.update(path=contig['name'], haplotype='fixture', size_inferred=False, fragments=[], uncovered=[])
    for i, chain in enumerate(manifest['chains']):
        chain.update(ucsc_id=i, anchor_bp=chain['aligned'], substitution_bp=0, aligned_fill_bp=0,
                     fill_matches=0, fill_mismatches=0, identity=1., blocks=0, gaps=0)
        manifest['sources'][chain['source']]['haplotype'] = chain['haplotype']
    Path(sidecar).write_text(json.dumps(manifest))
    def records(hdr):
        for i, (contig, start, size, reverse) in enumerate([(MAT, 500, 6000, False), (MAT, 7100, 1500, True),
                                                           (PAT, 100, 3500, False)]):
            starts = list(range(100, size - 200, 190))
            ma = f'{size};nuc.QQQ:' + ','.join(f'{start + 1}-147' for start in starts)
            qualities = array.array('B', [200, 255, 255] * len(starts))
            mm, ml = _mm('A' * size, range(0, size, 15))
            yield make_record(hdr, f'molecule_{i}', contig, start, f'{size}M', reverse=reverse,
                seq=('T' if reverse else 'A') * size,
                tags=[('MA', ma), ('AQ', qualities), ('MM', mm), ('ML', ml), ('tp', 'P', 'A'), ('ns', array.array('I', range(100, size - 200, 190))),
                      ('nl', array.array('I', [147] * len(range(100, size - 200, 190))))])
    source = write_bam(tmp_path / 'source.bam', records, header_extra={'PG': header(MAT, SSIZE)['PG']})
    dataset = Dataset('sample', source, data_type='bam_livelift')
    handle = open_lift_map(sidecar)
    dataset.live_lift = NS(handle=handle, haplotypes=handle.haplotypes, settings=LiftSettings())
    return dataset, sidecar


def test_full_records_preserve_calls_and_reverse_sequence(lifted):
    from services.scan.live_evidence import lifted_input
    dataset, _map = lifted
    spec, evidence = lifted_input(dataset, dataset_id='sample')
    records = [record for _ds, _i, record in evidence()]
    assert len(records) == 3
    for record in records:
        assert record.reference_name == 'chrT'
        assert record.query_length == sum(n for op, n in record.cigartuples if op in (0, 1, 4))
        assert record.has_tag('Yp') and record.has_tag('ns')
        assert record.get_tag('tp', with_value_type=True) == ('P', 'A')
        assert record.header.references == spec['headers'][0].references
    reverse = next(r for r in records if r.get_tag('Yp').endswith(':-'))
    assert not reverse.is_reverse  # source reversal composed with a reversed chain
    assert set(reverse.query_sequence) == {'A'}
    assert len(evidence.source_records) == len(records)


def test_cancelled_population_is_never_scanned(lifted):
    from services.scan.live_evidence import lifted_input
    with pytest.raises(InterruptedError):
        lifted_input(lifted[0], dataset_id='sample', cancel=lambda: True)


def test_live_record_ids_are_not_source_bam_ids(lifted):
    from services.scan.live_evidence import input_ids
    from services.scan.identity import content_id
    dataset, _map = lifted
    assert input_ids(dataset) == input_ids(dataset)
    assert input_ids(dataset) != [content_id(p) for p in dataset.paths]


def test_synthetic_scan_tables_equal_native_lift(lifted, tmp_path):
    from fiberhmm.cli.lift import main
    from scripts.scan_lift_parity import compare
    executable = os.environ.get('FIBERBROWSER_TEST_LIFTBAM') or shutil.which('liftbam')
    if not executable:
        pytest.skip('set FIBERBROWSER_TEST_LIFTBAM for the native lift gate')
    dataset, sidecar = lifted
    target = tmp_path / 'lifted.bam'
    (tmp_path / 'work').mkdir()
    assert main(['-i', dataset.paths[0], '-o', str(target), '--map', sidecar, '--liftbam', executable,
                 '-t', '1', '--tmp-dir', str(tmp_path / 'work')]) == 0
    result = compare(dataset.paths[0], str(target), sidecar, [('chrT', 0, 20_000)], tmp_path / 'scan',
                     parameters={'nfr': {'nfr': {'bootstrap': 0, 'kmax': 3, 'splits': 2}}, 'nuc': {'calibration': 'self'}})
    assert result['passed'], result['different']
    from services.scan.registry import open_scan
    from services.nuc.loaded import scan_rows
    state = NS(datasets={dataset.id: dataset}, chroms=[NS(name='chrT', size=20_000)])
    scan = open_scan(state, tmp_path / 'scan' / 'browser-route')
    assert scan.datasets_of_browser(dataset.id) == ['sample']
    rows = scan_rows(scan, dataset.id, MAT, 0, SSIZE)
    assert rows
    assert all(row.chrom == MAT for row in rows.values())
    assert all(0 <= mark[2] <= mark[3] <= SSIZE for row in rows.values() for marks in row.groups.values() for mark in marks)


def test_scan_plan_uses_target_reference_and_keeps_the_gate(lifted, tmp_path, monkeypatch):
    import services.scan.live_evidence as evidence
    from services.scan.planning import build_plan, ScanPlanError
    dataset, _map = lifted
    state = NS(datasets={dataset.id: dataset}, chroms=[NS(name='chrT', size=20_000)], performance={'effective': 'standard'})
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    request = dict(datasets=[dataset.id], modules=['nuc'], scope='view', chrom='chrT', start=1000, end=10_000, workers=99)
    monkeypatch.setattr(evidence, 'LIVE_LIFT_SCAN_PARITY', False)
    with pytest.raises(ScanPlanError, match='fiberhmm-lift'):
        build_plan(state, request)
    monkeypatch.setattr(evidence, 'LIVE_LIFT_SCAN_PARITY', True)
    plan = build_plan(state, request)
    assert plan['workers'] == 4
    assert all(u['chrom'] == 'chrT' for u in plan['units'])
    assert plan['datasets'][0]['live_lift'] is True
    assert 'fiberhmm-lift' in plan['cli']['text'] and ' && fiberhmm-scan' in plan['cli']['text']


def test_live_scan_job_runs_and_binds_the_evidence(lifted, tmp_path, monkeypatch):
    from services.scan import jobs, registry
    from services.scan.live_evidence import source_record_map
    dataset, _map = lifted
    state = NS(datasets={dataset.id: dataset}, chroms=[NS(name='chrT', size=20_000)], performance={'effective': 'standard'})
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    job = jobs.submit(state, dict(datasets=[dataset.id], modules=['nuc'], scope='view', chrom='chrT', start=1000, end=10_000,
                                 parameters={'nuc': {'calibration': 'self'}}, workers=1))
    done = jobs.wait(state, job['job_id'], timeout=180)
    assert done['status'] == 'complete', done.get('error') or done
    scans = registry.list_scans(state)
    assert len(scans) == 1 and scans[0].datasets_of_browser(dataset.id) == ['dataset_1']
    assert source_record_map(scans[0])


def test_target_states_rejoin_the_original_record(lifted, tmp_path):
    import hashlib
    import json
    from services.scan.states import states_from_table
    from services.lift.cohort import _encode_record
    from services.lift.joint import molecule_key
    dataset, _map = lifted
    with pysam.AlignmentFile(dataset.paths[0]) as bam:
        record = next(bam)
    original = hashlib.sha256(record.to_string().encode()).hexdigest() + ':0'
    target = 'target_digest:0'
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'live_lift_records.json').write_text(json.dumps([
        dict(dataset_id='sample', input_index=0, record=target, source_record=original)]))
    row = dict(dataset_id='sample', input_index='0', hit_id='feature', qname=record.query_name, record=target, state='1')
    scan = NS(path=tmp_path, tables=NS(fetch=lambda *args: [row]))
    state = NS(datasets={dataset.id: dataset})
    binding = {('sample', dataset.id): (dataset.id, 'input', {0: dataset.paths[0]})}
    states = states_from_table(state, scan, 'fp', dict(hit_id='feature', chrom='chrT', start=1000, end=1020), binding)
    group = dataset.live_lift.settings.molecule_group_map(dataset.paths, dataset.id)[dataset.paths[0]]
    key = _encode_record([molecule_key(group, record.query_name), record.query_name, original])
    assert states == {(dataset.id, key): ['1']}


def test_scan_cancel_during_evidence_snapshot(lifted, tmp_path, monkeypatch):
    from services.scan import jobs, registry
    from fiberhmm.scan import run_units
    dataset, _map = lifted
    state = NS(datasets={dataset.id: dataset}, chroms=[NS(name='chrT', size=20_000)], performance={'effective': 'standard'})
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    def runner(datasets, units, *, evidence, **kwargs):
        def interrupted():
            for record in evidence():
                jobs.cancel(state, next(iter(state.scan_jobs)))
                yield record
        return run_units(datasets, units, evidence=interrupted, **kwargs)
    job = jobs.submit(state, dict(datasets=[dataset.id], modules=['nuc'], scope='view', chrom='chrT', start=1000, end=10_000,
                                 parameters={'nuc': {'calibration': 'self'}}, workers=1), runner=runner)
    assert jobs.wait(state, job['job_id'], timeout=180)['status'] == 'cancelled'
    assert not registry.list_scans(state)


@pytest.mark.parametrize('same_dataset', [False, True])
def test_mixed_scan_keeps_native_states(lifted, tmp_path, same_dataset):
    import json
    from services.scan.states import states_from_table
    dataset, _ = lifted
    native_sid = 'sample' if same_dataset else 'native'
    native_index = 1 if same_dataset else 0
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'live_lift_records.json').write_text(json.dumps([
        dict(dataset_id='sample', input_index=0, record='lifted:0', source_record='source:0')]))
    row = dict(dataset_id=native_sid, input_index=str(native_index), hit_id='feature',
               qname='native_read', record='native:0', state='1', start='100', end='200')
    scan = NS(path=tmp_path, tables=NS(fetch=lambda *args: [row]))
    state = NS(datasets={'native': NS(data_type='bam')})
    binding = {(native_sid, 'native'): ('native', 'input', {native_index: 'native.bam'})}
    assert states_from_table(state, scan, 'fp', dict(hit_id='feature', chrom='chrT', start=100, end=200), binding) == {
        ('native', 'native_read'): ['1']}


@pytest.mark.parametrize('same_browser', [False, True])
def test_mixed_scan_keeps_native_nucleosome_rows(lifted, tmp_path, same_browser):
    import json
    from services.nuc.loaded import scan_rows
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'live_lift_records.json').write_text(json.dumps([
        dict(dataset_id='lift', input_index=0, record='lifted:0', source_record='source:0')]))
    molecule = dict(dataset_id='native', input_index='0', record='native:0', qname='native_read',
                    chrom='chrT', start='100', end='200', nrl='190')
    mark = dict(molecule, group='nucsz', mol_start='10', mol_len='147', q='200,255', name='nuc')
    tables = NS(has=lambda name: True, fetch=lambda name, *args: [mark] if '/marks.' in name else [molecule])
    scan = NS(path=tmp_path, tables=tables, manifest_digest='mixed-native', scan_id='mixed',
              manifest={'reference': {'contigs': [('chrT', 20000)]}},
              module=lambda name: {'settings': {}},
              bound_pairs=lambda: [('lift', 'native' if same_browser else 'lift', 'input', {0: lifted[0].paths[0]}),
                                   ('native', 'native', 'input', {0: str(tmp_path / 'native.bam')})])
    rows = scan_rows(scan, 'native', 'chrT', 100, 200)
    assert len(rows) == 1
    record = next(iter(rows.values()))
    assert record.qname == 'native_read' and record.scalars['nrl'] == 190
    assert record.groups['nucsz'] == [(10, 147, 100, 200, (200, 255), 'nuc')]


def _replace_source(dataset, tmp_path, cigar, size, *, supplementary=False, copies=1):
    import array
    def records(hdr):
        starts = sorted(set([5, size - 30] + list(range(100, size - 200, 190))))
        for i in range(copies):
            yield make_record(hdr, f'crossing_{i}', MAT, 1000, cigar, seq='A' * size,
                flag=2048 if supplementary else 0,
                tags=[('ns', array.array('I', starts)), ('nl', array.array('I', [20] * len(starts))),
                      ('MA', f'{size};nuc.QQQ:' + ','.join(f'{s + 1}-20' for s in starts)),
                      ('AQ', array.array('B', [200, 255, 255] * len(starts)))])
    path = write_bam(tmp_path / 'crossing.bam', records, header_extra={'PG': header(MAT, SSIZE)['PG']})
    dataset.paths = [path]
    return dataset


@pytest.mark.parametrize('supplementary', [False, True])
def test_inversion_chooses_one_primary_across_display_rows(lifted, tmp_path, supplementary):
    from services.scan.live_evidence import lifted_input
    dataset = _replace_source(lifted[0], tmp_path, '7500M', 7500, supplementary=supplementary)
    _, evidence = lifted_input(dataset, dataset_id='sample')
    records = [r for _, _, r in evidence()]
    assert len(records) >= 2 and {r.is_reverse for r in records} == {False, True}
    primaries = [r for r in records if not r.is_supplementary]
    assert len(primaries) == (0 if supplementary else 1)
    if primaries:
        assert sum(n for op, n in primaries[0].cigartuples if op == 0) == max(
            sum(n for op, n in r.cigartuples if op == 0) for r in records)
    # This is the scan's supplementary exclusion gate.
    from fiberhmm.scan.reads import passes, resolve_read_policy
    filters = resolve_read_policy({'filters': {'supplementary': 'exclude'}})['filters']
    assert sum(passes(r, filters) for r in records) == (0 if supplementary else 1)


def test_large_source_insertion_preserves_compositor_runs(lifted, tmp_path):
    from services.scan.live_evidence import lifted_input
    dataset = _replace_source(lifted[0], tmp_path, '50M12000I50M', 12100)
    _, evidence = lifted_input(dataset, dataset_id='sample')
    records = [r for _, _, r in evidence()]
    assert len(records) == 2
    assert sum(not r.is_supplementary for r in records) == 1
    assert sorted(r.cigarstring for r in records) == ['12050S50M', '50M12050S']


def test_source_snapshot_retains_only_bounded_full_records(lifted, tmp_path, monkeypatch):
    from services.scan.live_evidence import lifted_input
    dataset = _replace_source(lifted[0], tmp_path, '1000M', 1000, copies=50)
    original = pysam.AlignmentFile
    active = [0]
    peak = [0]
    class Read:
        def __init__(self, record):
            self.record = record
            active[0] += 1
            peak[0] = max(peak[0], active[0])
            assert active[0] <= 2, 'full source records accumulated before the load budget'
        def __getattr__(self, name):
            return getattr(self.record, name)
        def __del__(self):
            active[0] -= 1
    class Bam:
        def __init__(self, *args, **kwargs):
            self.bam = original(*args, **kwargs)
        def __getattr__(self, name):
            return getattr(self.bam, name)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.bam.close()
        def __iter__(self):
            for record in self.bam:
                yield Read(record)
    monkeypatch.setattr(pysam, 'AlignmentFile', Bam)
    _, evidence = lifted_input(dataset, dataset_id='sample')
    assert sum(1 for _ in evidence()) == 50
    assert peak[0] <= 2
    assert len(evidence.source_records) == 50


def test_oversize_source_refused_before_compact_loading(lifted, monkeypatch):
    import services.scan.live_evidence as live
    import services.lift.live_lift as loader
    monkeypatch.setattr(live, 'MAX_SOURCE_RECORD_BYTES', 100, raising=False)
    monkeypatch.setattr(loader, 'load_lifted_rows', lambda *a, **kw: pytest.fail('loaded oversized evidence'))
    _, evidence = live.lifted_input(lifted[0], dataset_id='sample')
    with pytest.raises(live.EvidenceError, match='memory budget'):
        list(evidence())


def test_primary_selection_spans_all_target_contigs(lifted, monkeypatch):
    import hashlib
    from services.scan.live_evidence import lifted_input
    import services.lift.live_lift as loader
    import services.lift.cohort as cohort
    dataset, _ = lifted
    with pysam.AlignmentFile(dataset.paths[0]) as bam:
        original = hashlib.sha256(next(bam).to_string().encode()).hexdigest() + ':0'
    dataset.live_lift.handle = NS(
        haplotypes=['hap'], resolve_haplotypes=lambda values: values,
        map=NS(m={'targets': [{'name': 'chrA', 'size': 20000}, {'name': 'chrB', 'size': 20000}]},
               chains=[{'target': 0}, {'target': 1}],
               source_to_target=lambda *args: [NS(chain=i, t_start=1000, t_end=2000, primary=True) for i in range(2)]))
    def load(handle, paths, chrom, *args, **kwargs):
        n = 50 if chrom == 'chrA' else 100
        row = dict(alignment_orientation='forward', live_lift=dict(library=0, record=original, placement='0',
                   row_index=0, molecular_spans=[[0, n, 0, 1, True]], segments=[[0, n, 0, '+', True]]))
        return NS(rows=[row], region_start=1000, truncated=False)
    monkeypatch.setattr(loader, 'load_lifted_rows', load)
    monkeypatch.setattr(cohort, 'prepare_lift_cohort', lambda rows, *args: NS(rows=rows))
    _, evidence = lifted_input(dataset, dataset_id='sample')
    records = [r for _, _, r in evidence()]
    assert [(r.reference_name, r.is_supplementary) for r in records] == [('chrA', True), ('chrB', False)]


def test_decode_budget_refuses_partial_population_and_cleans_snapshot(lifted, tmp_path, monkeypatch):
    import services.scan.live_evidence as live
    import services.lift.live_lift as loader
    folder = tmp_path / 'snapshots'
    folder.mkdir()
    original_tempdir = live.tempfile.TemporaryDirectory
    monkeypatch.setattr(live.tempfile, 'TemporaryDirectory', lambda **kwargs: original_tempdir(dir=folder, **kwargs))
    def truncated(*args, budget, **kwargs):
        assert budget.max_bytes == live.MAX_EVIDENCE_DECODE_BYTES
        return NS(rows=[], truncated=True)
    monkeypatch.setattr(loader, 'load_lifted_rows', truncated)
    _, evidence = live.lifted_input(lifted[0], dataset_id='sample')
    with pytest.raises(live.EvidenceError, match='partial population'):
        list(evidence())
    assert not list(folder.iterdir())
    assert len(evidence.source_records) == 0
