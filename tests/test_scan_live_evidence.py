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
