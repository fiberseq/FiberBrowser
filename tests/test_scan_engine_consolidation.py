"""Backend gates for legacy execution adapters; no sockets or application server."""
import copy
import gzip
import json
from pathlib import Path
from types import SimpleNamespace
import uuid

import numpy as np
import pysam
import pytest

from services.consensus_workflow import _runtime
from services.scan.legacy_execution import native_inputs, run_peak_counts, run_prepared

_runtime()


def _source(tmp_path, supplementary=False):
    from fiberhmm.io.bam_header import append_chemistry
    header = pysam.AlignmentHeader.from_dict(dict(HD=dict(VN='1.6', SO='coordinate'),
        SQ=[dict(SN='chrT', LN=5000)]))
    header = append_chemistry(header, dict(assay='daf', enzyme='ddda', platform='pacbio', mode='daf'))
    path = tmp_path / 'calls.bam'
    with pysam.AlignmentFile(path, 'wb', header=header) as bam:
        token = uuid.uuid4().hex
        for i in range(12):
            record = pysam.AlignedSegment(header)
            record.query_name = token if supplementary else uuid.uuid4().hex
            record.query_sequence = 'AYGT' * 1000
            record.reference_id = 0
            record.reference_start = i
            record.mapping_quality = 60
            record.cigarstring = '4000M'
            record.flag = 2048 if supplementary and i else 0
            record.set_tag('st', 'CT')
            record.set_tag('MA', '4000;nuc:201-350,801-950,1801-1950,2401-2550;tf:1181-1210;msp:951-1800')
            bam.write(record)
    pysam.index(str(path))
    return [dict(dataset_id='d', paths=[str(path)], chemistry='ddda')]


def _progress(*args, **kwargs):
    pass


_progress.report = _progress


def _public(value):
    """Only wall-clock/provenance file locations may differ between executions."""
    if isinstance(value, dict):
        return {k: _public(v) for k, v in value.items() if k not in
                {'seconds'}}
    if isinstance(value, list):
        return [_public(v) for v in value]
    return value


@pytest.mark.parametrize('cap', [0, 40])
def test_fp_prepared_population_and_all_legacy_outputs_match(tmp_path, cap):
    from test_consensus_lattice_recaller import planted_payload
    from fiberhmm.inference.consensus.workflow import run_analysis
    from services.consensus_workflow import _index
    datasets = _source(tmp_path)
    payload = planted_payload(n=60)
    params = dict(cr=dict(engine='lattice_recaller'), compute=dict(cores=1),
                  recaller=dict(learned_spots=False, max_discovery_molecules=cap,
                                max_quantification_molecules=cap, sample_seed=9))
    before = copy.deepcopy(payload)
    old = run_analysis(payload, params, tmp_path / 'old', _progress)
    new, directory = run_prepared('fp', datasets, payload, params, tmp_path / 'new', _progress, runner=run_analysis)
    assert _public(new) == _public(old)
    assert _index(new) == _index(old)
    assert payload == before
    for filename in ('classes.tsv', 'molecules.tsv.gz'):
        opener = gzip.open if filename.endswith('.gz') else open
        with opener(tmp_path / 'old' / filename, 'rt') as a, opener(tmp_path / 'new' / filename, 'rt') as b:
            assert a.read() == b.read()
    manifest = json.loads((Path(directory) / 'manifest.json').read_text())
    assert manifest['modules']['fp']['settings']['browser_population']['evidence_sha256']
    assert (Path(directory) / 'fp' / 'hits.tsv.bgz').is_file()


@pytest.mark.parametrize('given', [False, True])
@pytest.mark.parametrize('cap', [0, 60])
def test_nfr_given_detected_and_capped_results_match(tmp_path, given, cap):
    from lab_tests.test_accessibility_workflow import planted_payload
    from fiberhmm.inference.accessibility.workflow import run_accessibility
    datasets = _source(tmp_path)
    payload = planted_payload(n=90)
    params = dict(bootstrap=4, robust=0, max_discovery_molecules=cap,
                  max_quantification_molecules=cap, sample_seed=7)
    if given:
        params['nfr_regions'] = [[1400, 1850]]
    inputs = dict(payload_source='reused', class_job='class-job', loader_parameters={})
    before = copy.deepcopy(payload)
    old = run_accessibility(payload, params, tmp_path / 'old', _progress, classes=None, inputs=inputs)
    new, directory = run_prepared('nfr', datasets, payload, params, tmp_path / 'new', _progress,
                                  runner=run_accessibility, inputs=inputs)
    assert _public(new) == _public(old)
    assert payload == before
    for filename in ('variants.tsv', 'configurations.tsv', 'coaccess.tsv', 'combos.tsv', 'molecules.tsv.gz'):
        opener = gzip.open if filename.endswith('.gz') else open
        with opener(tmp_path / 'old' / filename, 'rt') as a, opener(tmp_path / 'new' / filename, 'rt') as b:
            assert a.read() == b.read()
    assert (Path(directory) / 'nfr' / 'states.tsv.bgz').is_file()


def test_nfr_frozen_reuse_with_class_elements_matches(tmp_path):
    from lab_tests.test_accessibility_workflow import planted_payload
    from fiberhmm.inference.accessibility.workflow import classes_from_rows, run_accessibility
    payload = planted_payload(n=90)
    units = payload['strata'][0]['units']
    support = {('class_001', f'd::{strand}'): dict(start=1600, end=1630, prevalence=1/3)
               for strand in ('CT', 'GA')}
    states = {'class_001': {u['unit_id']: (int(i % 3 == 0), f"d::{u['strand']}")
                           for i, u in enumerate(units)}}
    classes = classes_from_rows(support, states)
    assert classes
    params = dict(bootstrap=4, robust=0, elements='nfrs', nfr_regions=[[1400, 1850]])
    inputs = dict(payload_source='reused from classes', class_job='class-job')
    old = run_accessibility(copy.deepcopy(payload), params, tmp_path / 'old', _progress,
                            classes=classes, inputs=inputs)
    new, _ = run_prepared('nfr', _source(tmp_path), payload, params, tmp_path / 'new', _progress,
                           runner=run_accessibility, classes=classes, inputs=inputs)
    assert _public(old) == _public(new)
    assert new['class_join']['joined_molecules'] == len(units)
    assert any(e['kind'] == 'tf' for e in new['elements'])
    for filename in ('coaccess.tsv', 'combos.tsv'):
        assert (tmp_path / 'old' / filename).read_text() == (tmp_path / 'new' / filename).read_text()


@pytest.mark.parametrize('source', ['accessibility', 'tf_density'])
@pytest.mark.parametrize('rule', ['window', 'local'])
def test_peaks_scores_tiers_broad_and_signal_match(tmp_path, source, rule):
    from fiberhmm.scan.peaks_core import DEFAULTS, scan_peaks
    from services.peak_scanning import compute_scan_counts, detect_threshold_layers, build_peak_thresholds
    datasets = _source(tmp_path)
    rows = [dict(intervals=[[0, 100, 150], [100, 250, -150], [250, 280, 30], [280, 500, 150]])
            for _ in range(20)]
    numerator, total = compute_scan_counts(rows, source, 500)
    params = dict(DEFAULTS, signal_source=source, smooth_width=20, min_width=10, max_peak_width=120, tier_rule=rule)
    expected = scan_peaks(numerator, total, n_reads=len(rows), rule=rule, params=params)
    actual = run_peak_counts(datasets, dict(chrom='chrT', start=1000, end=1500), numerator, total, len(rows), params)
    for key in ('peaks', 'broad', 'layer_info', 'thresholds'):
        assert actual[key] == expected[key]
    np.testing.assert_array_equal(actual['smoothed'], expected['smoothed'])
    if rule == 'window':
        thresholds = build_peak_thresholds(*(params[k] for k in (
            'threshold_strong', 'threshold_medium', 'threshold_weak', 'threshold_rare', 'min_reads')), len(rows))
        broad = []
        peaks, layers = detect_threshold_layers(expected['smoothed'], total, thresholds, params['min_width'],
            params['min_reads'], params['smooth_width'], max_width=params['max_peak_width'], broad_out=broad)
        assert (actual['peaks'], actual['layer_info'], actual['broad']) == (peaks, layers, broad)


def test_owner_local_rare_rule_is_the_only_tier_change(tmp_path):
    from fiberhmm.scan.peaks_core import DEFAULTS
    datasets = _source(tmp_path)
    # 10% signal with 20 covering records, but 100 rows somewhere in the view.
    num, den = np.full(500, 2, dtype=np.int32), np.full(500, 20, dtype=np.int32)
    params = dict(DEFAULTS, smooth_width=1, min_width=20, min_reads=5)
    window = run_peak_counts(datasets, dict(chrom='chrT', start=0, end=500), num, den, 100,
                             dict(params, tier_rule='window'))
    local = run_peak_counts(datasets, dict(chrom='chrT', start=0, end=500), num, den, 100,
                            dict(params, tier_rule='local'))
    assert window['peaks'] == local['peaks']
    # Fewer view rows raises the old Rare threshold to 25%; local stays at 8%.
    window = run_peak_counts(datasets, dict(chrom='chrT', start=0, end=500), num, den, 20,
                             dict(params, tier_rule='window'))
    assert not window['peaks'] and local['peaks'][0]['layer'] == 3
    den[:100] = 4
    local = run_peak_counts(datasets, dict(chrom='chrT', start=0, end=500), num, den, 100,
                            dict(params, tier_rule='local'))
    assert all(p['start'] >= 100 for p in local['peaks'] if p['layer'] == 3)


def test_unsupported_evidence_is_reported(tmp_path):
    ds = SimpleNamespace(data_type='bigbed')
    state = SimpleNamespace(get_dataset=lambda _: ds)
    sources, reason = native_inputs(state, dict(dataset_ids=['d'], chrom='chrT', start=0, end=500))
    assert sources is None and 'native BAM' in reason


def test_grid_record_row_rule_counts_supplementaries(tmp_path):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.peaks_reads import compact_rows
    from fiberhmm.scan.units import plan
    datasets = _source(tmp_path, supplementary=True)
    with pysam.AlignmentFile(datasets[0]['paths'][0], 'rb') as bam:
        records = compact_rows(bam, 'chrT', 100, 500, row_rule='records')
        view = compact_rows(bam, 'chrT', 100, 500, row_rule='view')
    assert len(records) == 12 and len(view) == 1
    directory = tmp_path / 'grid'
    run_units(datasets, plan({'chrT': 5000}, genome=True), modules=['peaks'],
              out=directory, annotate=False, cores=1, window_jobs=1)
    calibration = json.loads((directory / 'peaks' / 'extra' / 'calibration.json').read_text())
    assert calibration['row_rule'] == 'records' and calibration['tier_rule'] == 'local'
    unit_results = [json.load(gzip.open(p, 'rt')) for p in directory.glob('work/peaks/*/result.json.gz')]
    assert [r['extra']['n_reads'] for r in unit_results] == [12]


@pytest.mark.parametrize('bundled', [False, True], ids=['synthetic-bam', 'bundled-demo'])
@pytest.mark.parametrize('module', ['fp', 'nfr'])
@pytest.mark.parametrize('cap', [0, 24])
def test_bam_loaded_population_engine_and_facade_parity(tmp_path, bundled, module, cap):
    from fiberhmm.inference.consensus.bam import load_bam_payload
    from fiberhmm.inference.consensus.parameters import parse_options
    from fiberhmm.inference.consensus.workflow import run_analysis
    from fiberhmm.inference.accessibility.workflow import run_accessibility
    from services.hub.migration import _rows
    if bundled:
        path = Path(__file__).parents[1] / 'browser' / 'data' / 'demo' / 'napa_ddda.bam'
        assert path.is_file(), 'The bundled parity fixture must be available'
        datasets = [dict(dataset_id='d', paths=[str(path)], chemistry='ddda')]
        region = dict(chrom='chr19', start=47517650, end=47518985)
    else:
        datasets = _source(tmp_path)
        region = dict(chrom='chrT', start=1000, end=2000)
    loader = dict(cr=dict(engine='lattice_recaller'), compute=dict(cores=1),
                  recaller=dict(learned_spots=False, max_discovery_molecules=cap,
                                max_quantification_molecules=cap, sample_seed=11))
    payload = load_bam_payload(datasets, region, parse_options(loader), _progress)
    assert any(s['units'] for s in payload['strata'])
    runner = run_analysis if module == 'fp' else run_accessibility
    params = loader if module == 'fp' else dict(bootstrap=4, robust=0, min_fraction=.15,
        max_discovery_molecules=cap, max_quantification_molecules=cap, sample_seed=11)
    # SampledPayload carries a stateful top-up closure. Deepcopy cannot clone
    # that closure: use independent loaders for the old and new executions.
    old_payload = load_bam_payload(datasets, region, parse_options(loader), _progress)
    old = runner(old_payload, params, tmp_path / 'old', _progress)
    new, directory = run_prepared(module, datasets, payload, params, tmp_path / 'new', _progress,
                                  runner=runner, loader_parameters=loader)
    assert _public(old) == _public(new)
    kind = 'consensus' if module == 'fp' else 'accessibility'
    job = dict(job_id='job', request=dict(region, dataset_ids=['d']), result=old)
    # Curation is applied to the facade, never by re-running the inference.
    if module == 'fp':
        catalog = old['datasets']['d']['cr']['catalog']
        ignored = [catalog[0]['family']] if catalog else []
        job['_curation'] = dict(cursor=0, snapshots=[dict(ignored_families={'d': ignored},
            manual_groups=[dict(dataset_id='d', group_id='manual:one', family='manual:one',
                display_start=region['start']+50, display_end=region['start']+75, manual=True)])])
    before = _rows(kind, job)
    job['result'] = new
    assert _rows(kind, job) == before
    manifest = json.loads((Path(directory) / 'manifest.json').read_text())
    assert manifest['units']['mode'] == 'bed'
    assert manifest['modules'][module]['settings']['browser_population']['parameters'] == params


def test_peak_endpoint_uses_scan_and_keeps_filtered_cohort(tmp_path):
    from state.browser_state import BrowserState
    from models.requests import ScanPeaksRequest
    from services.clustering_endpoint import run_scan_peaks_endpoint
    datasets = _source(tmp_path)
    state = BrowserState(None)
    state.add_dataset('d', datasets[0]['paths'][0])
    with pysam.AlignmentFile(datasets[0]['paths'][0], 'rb') as bam:
        selected = [r.query_name for r in bam.fetch('chrT', 1000, 1500)][:6]
    args = dict(state=state, chrom='chrT', start=1000, end=1500, dataset_id='d', spanning=False)
    params = dict(min_width=10, smooth_width=20, read_ids=selected, sample_seed='fixed', return_signal=True)
    old = run_scan_peaks_endpoint(**args, req=ScanPeaksRequest(**params, execution_engine='legacy'))
    new = run_scan_peaks_endpoint(**args, req=ScanPeaksRequest(**params, tier_rule='window'))
    assert old['execution_engine'] == 'legacy' and new['execution_engine'] == 'scan:peaks'
    assert old['n_reads'] == new['n_reads'] == len(selected)
    for field in ('peaks', 'broad_peaks', 'signal', 'layer_info'):
        assert old[field] == new[field]


def test_legacy_jobs_publish_execution_scan_without_replacing_facade_identity(tmp_path):
    from state.browser_state import BrowserState
    from services import consensus_workflow as cw
    from lab.services import accessibility_workflow as aw
    from services.hub.migration import legacy_runs
    datasets = _source(tmp_path)
    state = BrowserState(None)
    state.add_dataset('d', datasets[0]['paths'][0])
    base = dict(dataset_ids=['d'], chrom='chrT', start=1000, end=2000,
                chemistry_overrides={'d': 'ddda'})
    fp = cw.submit(state, dict(base, parameters=dict(compute=dict(cores=1),
        recaller=dict(learned_spots=False, max_discovery_molecules=8, max_quantification_molecules=8))))
    fp_job = cw._session(state)[0][fp['job_id']]
    fp_job['_future'].result(timeout=180)
    assert fp_job['status'] == 'complete', fp_job.get('message')
    nfr = aw.submit(state, dict(base, parameters=dict(bootstrap=4, robust=0, nfr_regions=[[1400, 1850]])))
    nfr_job = aw._session(state)[0][nfr['job_id']]
    nfr_job['_future'].result(timeout=180)
    assert nfr_job['status'] == 'complete', nfr_job.get('message')
    for job, module in ((fp_job, 'fp'), (nfr_job, 'nfr')):
        assert job['execution_engine'] == f'scan:{module}'
        assert (Path(job['execution_scan']) / 'manifest.json').is_file()
    facade = legacy_runs(state)
    assert not facade['problems']
    assert {r['jobId'] for r in facade['runs']} == {fp['job_id'], nfr['job_id']}
    assert {r['executionEngine'] for r in facade['runs']} == {'scan:fp', 'scan:nfr'}


def test_bundled_peak_endpoint_matches_legacy_window_and_package_local():
    from state.browser_state import BrowserState
    from models.requests import ScanPeaksRequest
    from services.clustering_endpoint import run_scan_peaks_endpoint
    path = Path(__file__).parents[1] / 'browser' / 'data' / 'demo' / 'napa_ddda.bam'
    state = BrowserState(None)
    state.add_dataset('d', str(path))
    args = dict(state=state, chrom='chr19', start=47517650, end=47518985, dataset_id='d', spanning=False)
    old = run_scan_peaks_endpoint(**args, req=ScanPeaksRequest(execution_engine='legacy', return_signal=True))
    window = run_scan_peaks_endpoint(**args, req=ScanPeaksRequest(tier_rule='window', return_signal=True))
    local = run_scan_peaks_endpoint(**args, req=ScanPeaksRequest(return_signal=True))
    assert window['execution_engine'] == local['execution_engine'] == 'scan:peaks'
    assert local['tier_rule'] == 'local'
    for field in ('peaks', 'broad_peaks', 'signal', 'layer_info', 'n_reads'):
        assert old[field] == window[field]
    assert local['signal'] == old['signal']
