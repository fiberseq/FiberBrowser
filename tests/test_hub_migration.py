"""M1 restore corpus and frozen legacy job facade gates. No server or sockets."""
import copy
import json
import types
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from models.requests import SessionExportRequest, SessionImportRequest
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
from services.hub.migration import LEGACY_TYPES, legacy_runs
from test_sessions_endpoint import _ImportState

CORPUS = sorted((Path(__file__).parent / 'fixtures' / 'sessions').glob('*.json'))


@pytest.fixture(scope='module')
def release301():
    source = (Path(__file__).parent / 'fixtures' / 'sessions' / 'session_endpoint_301.py').read_text()
    module = types.ModuleType('session_release_301')
    exec(compile(source, '<release-3.0.1-session-endpoint>', 'exec'), module.__dict__)
    return module


@pytest.mark.parametrize('path', CORPUS, ids=lambda p: p.stem)
def test_corpus_endpoint_restore_and_round_trip(path, release301):
    session = json.loads(path.read_text())
    old = release301.import_session_for_request(_ImportState(), SessionImportRequest(session=copy.deepcopy(session)))
    state = _ImportState()
    new = import_session_for_request(state, SessionImportRequest(session=copy.deepcopy(session)))
    assert new['success'] and old['success']
    for key in ('frontend', 'viewport', 'datasets'):
        assert new[key] == old[key]
    state.chroms = [NS(name='chrT')]
    for ds in state.datasets.values():
        ds.is_remote = False
    exported = build_session_export_for_request(state, SessionExportRequest(chrom='chrT', start=100, end=900,
                                                                          frontend_state=new['frontend']))['session']
    assert exported['version'] == '2.0'
    restored = release301.import_session_for_request(_ImportState(), SessionImportRequest(session=exported))
    assert restored['frontend'] == session['frontend']
    assert restored['viewport'] == session['viewport']


def test_analysis_kind_table_covers_every_legacy_adapter():
    assert set(LEGACY_TYPES.values()) == {'fp.class', 'nfr.region', 'nfr.variant', 'peaks.peak', 'var.sv', 'var.diff', 'graph.bubble', 'var.snp'}


def _jobs(tmp_path):
    import threading
    cons = dict(job_id='class-job', status='complete', artifact_dir=str(tmp_path / 'classes'),
                request={'dataset_ids': ['sample-a']}, filters={'tier': 'core'}, _scored_units={'sample-a': {'class_001': set()}},
                _curation={'history': [], 'cursor': 0}, result={'manifest': {'region': {'chrom': 'chrT', 'start': 100, 'end': 900}},
                'datasets': {'sample-a': {'cr': {'catalog': [{'family': 'class_001', 'consensus_start': 200, 'consensus_end': 220}]}},
                             'sample-b': {'cr': {'catalog': [{'family': 'class_001', 'consensus_start': 200, 'consensus_end': 220}]}}}})
    nfr = dict(job_id='nfr-job', status='complete', artifact_dir=str(tmp_path / 'nfr'), request={'dataset_ids': ['sample-a']},
               result={'region': {'chrom': 'chrT', 'start': 100, 'end': 900},
                       'nfrs': [{'id': 'N1', 'start': 300, 'end': 380, 'variants': [{'id': 'N1:V1', 'L': 310.5, 'R': 370.5}]}]})
    state = NS(consensus_workflow_jobs={'class-job': cons}, consensus_workflow_lock=threading.RLock(),
               consensus_workflow_active='class-job', accessibility_jobs={'nfr-job': nfr}, accessibility_lock=threading.RLock(),
               chroms=[NS(name='chrT', size=10000)])
    return state, cons, nfr


def test_facades_keep_identity_population_curation_filters_and_write_fetchable_scan_tables(tmp_path):
    from services.scan.tables import Table
    state, cons, nfr = _jobs(tmp_path)
    before = copy.deepcopy(cons)
    result = legacy_runs(state)
    assert not result['problems']
    assert [r['jobId'] for r in result['runs']] == ['class-job', 'nfr-job']
    run = result['runs'][0]
    assert run['active'] and len(run['mappings']) == 2
    assert {r['datasetId'] for r in run['mappings']} == {'sample-a', 'sample-b'}
    assert len({r['hitId'] for r in run['mappings']}) == 1
    assert run['mappings'][0]['legacyRef']['source'] == 'class-job'
    for key in ('result', '_curation', '_scored_units', 'filters'):
        assert cons[key] == before[key]
    table = Table(Path(run['path']) / 'fp' / 'hits.tsv.bgz')
    assert [r['hit_id'] for r in table.fetch('chrT', 100, 900)] == ['fp-class:class-job:class_001']
    manifest = json.loads((Path(run['path']) / 'manifest.json').read_text())
    assert manifest['schema'] == 'fiberhmm.scan.v1'
    assert manifest['reference']['contigs'] == [['chrT', 10000]]
    assert len(result['runs'][1]['mappings']) == 2
    assert result['runs'][1]['mappings'][1]['legacyRef']['start'] == 310.5
    assert legacy_runs(state) == result


def test_conversion_runs_after_pack_session_import_end(tmp_path, monkeypatch):
    from services import sessions_endpoint as endpoint
    state = _ImportState()
    fake, cons, nfr = _jobs(tmp_path)
    order = []
    original = endpoint.run_hooks

    def hooks(event, *args):
        if event == 'session_import_end':
            order.append(event)
            state.accessibility_jobs = fake.accessibility_jobs
            state.accessibility_lock = fake.accessibility_lock
        else:
            original(event, *args)
    monkeypatch.setattr(endpoint, 'run_hooks', hooks)
    restored = import_session_for_request(state, SessionImportRequest(session={'version': '2.0'}))
    assert order == ['session_import_end']
    assert restored['results']['hub_legacy']['runs'][0]['jobId'] == 'nfr-job'


def test_missing_or_bad_runs_do_not_abort_legacy_restore(tmp_path):
    state, cons, nfr = _jobs(tmp_path)
    cons['result'] = {'invalid': True}
    result = legacy_runs(state)
    assert len(result['problems']) == 1
    assert [r['jobId'] for r in result['runs']] == ['nfr-job']


def test_legacy_jobs_share_the_scan_worker():
    from services.consensus_workflow import _EXECUTOR as classes
    from lab.services.accessibility_workflow import _EXECUTOR as nfr
    from services.scan.jobs import _EXECUTOR as scan
    assert classes is nfr is scan


# A generated session corpus entry with a real frozen result, in addition to the checked-in panel fixtures.
from test_session_consensus_runs import recaller_result


def test_real_class_run_crosses_both_release_endpoints(tmp_path, recaller_result, release301):
    from test_session_consensus_runs import _bam, _state_with_run, _saved_group
    from services.consensus_workflow import _session
    from services.consensus_occupancy import recaller_scored_units
    from state.browser_state import BrowserState
    result, run_dir = recaller_result
    before = _state_with_run(_bam(tmp_path), result, artifact_dir=run_dir)
    request = SessionExportRequest(chrom='chrT', start=1000, end=1500, frontend_state={'footprintGroups': [_saved_group()]})
    old_file = release301.build_session_export_for_request(before, request)['session']
    migrated = BrowserState(None)
    response = import_session_for_request(migrated, SessionImportRequest(session=old_file))
    assert response['results']['consensus_runs_restored'] == 1
    assert not response['results']['hub_legacy']['problems']
    facade = response['results']['hub_legacy']['runs'][0]
    assert facade['active'] and facade['mappings']
    assert {m['jobId'] for m in facade['mappings']} == {'original-run'}
    exported = build_session_export_for_request(migrated, request)['session']
    legacy = BrowserState(None)
    reopened = release301.import_session_for_request(legacy, SessionImportRequest(session=exported))
    assert reopened['results']['consensus_runs_restored'] == 1
    current_job = _session(migrated)[0]['original-run']
    old_job = _session(legacy)[0]['original-run']
    assert old_job['filters'] == current_job['filters']
    assert recaller_scored_units(old_job, 'd') == recaller_scored_units(current_job, 'd')
    assert old_job['result'] == current_job['result']


def test_accessibility_run_crosses_both_release_endpoints(tmp_path, release301):
    from lab.services import accessibility_workflow as aw
    from services.consensus_workflow import _snapshot
    from state.browser_state import BrowserState
    from test_session_consensus_runs import _bam
    before = BrowserState(None)
    before.add_dataset('sample-a', str(_bam(tmp_path)))
    # A frozen empty scoring population is deliberate; import must not invent measured negatives.
    result = dict(region={'chrom': 'chrT', 'start': 100, 'end': 900}, molecules={},
                  nfrs=[dict(id='N1', start=300, end=380, variants=[dict(id='N1:V1', L=310.5, R=370.5)])])
    jobs, _ = aw._session(before)
    jobs['nfr-job'] = dict(job_id='nfr-job', status='complete', request={'dataset_ids': ['sample-a']},
                           result=result, _snapshot=_snapshot(before, ['sample-a']), finished_at=1)
    old_file = release301.build_session_export_for_request(before, SessionExportRequest())['session']
    # Pack export is explicitly invoked too: public-only test configurations need not load the lab pack.
    old_file['accessibility_runs'] = aw.export_session_runs(before)
    after = BrowserState(None)
    imported = import_session_for_request(after, SessionImportRequest(session=old_file))
    aw.restore_session_runs(after, old_file)
    facade = legacy_runs(after)
    assert not facade['problems'] and len(facade['runs'][0]['mappings']) == 2
    new_file = build_session_export_for_request(after, SessionExportRequest())['session']
    new_file['accessibility_runs'] = aw.export_session_runs(after)
    legacy = BrowserState(None)
    release301.import_session_for_request(legacy, SessionImportRequest(session=new_file))
    ids, problems = aw.restore_session_runs(legacy, new_file)
    assert ids == ['nfr-job'] and not problems
    assert aw._session(legacy)[0]['nfr-job']['result'] == result


def test_curated_classes_and_matched_windows_keep_their_mapping_without_refitting(tmp_path):
    state, job, _ = _jobs(tmp_path)
    job['_curation'] = {'cursor': 0, 'snapshots': [dict(ignored_families={'sample-a': ['class_001']},
        manual_groups=[dict(group_id='manual:one', dataset_id='sample-a', family='manual:one', display_start=240,
                            display_end=270, manual=True, label='Curated class')])]}
    runs = legacy_runs(state)
    rows = runs['runs'][0]['mappings']
    assert [(r['datasetId'], r['family']) for r in rows] == [('sample-a', 'manual:one'), ('sample-b', 'class_001')]
    job['_curation'] = {}
    result = job['result']
    result['manifest'].update(region={'chrom': 'oriented_BED', 'start': 0, 'end': 100},
                              region_datasets={'sample-a': 'sample-a', 'sample-b': 'sample-b'})
    for dataset, ds in result['datasets'].items():
        ds['units'] = [dict(genomic_provenance=dict(coordinate_origin=200,
            window=dict(chrom='chrT', start=500, end=600, strand='-' if dataset == 'sample-a' else '+')))]
    rows = legacy_runs(state)['runs'][0]['mappings']
    assert [(r['start'], r['end']) for r in rows] == [(580, 600), (500, 520)]
    assert len({r['hitId'] for r in rows}) == 2
    assert all(r['hasStates'] is False and r['note'] for r in rows)
