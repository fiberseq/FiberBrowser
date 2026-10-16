"""Sessions keep the footprint-class runs their saved classes refer to (release audit F6).

Import used to dispose every consensus run (deleting its artifacts) and then restore saved classes pointing at those
job ids; after a restart nothing could bring the runs back. Runs are now frozen into the session and restored under
their own ids, and a run still open is never deleted first."""
import copy
import threading
import time

import pysam
import pytest

from models.requests import SessionExportRequest, SessionImportRequest
from services import consensus_workflow as cw
from services.consensus_occupancy import class_occupancy, recaller_scored_units
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
from state.browser_state import BrowserState


def _bam(tmp_path):
    bam = tmp_path / 'source.bam'
    with pysam.AlignmentFile(str(bam), 'wb', header={'HD': {'VN': '1.6'}, 'SQ': [{'SN': 'chrT', 'LN': 2000}]}):
        pass
    pysam.index(str(bam))
    return bam


@pytest.fixture(scope='module')
def recaller_result(tmp_path_factory):
    from test_consensus_lattice_recaller import planted_payload
    workflow, _ = cw._runtime()
    out = tmp_path_factory.mktemp('run')
    return workflow.run_workflow(planted_payload(), {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'learned_spots': False}}, out), out


def _state_with_run(bam, result, job_id='original-run', artifact_dir=None):
    state = BrowserState(None)
    state.add_dataset('d', str(bam))
    result = copy.deepcopy(result)
    result['manifest']['browser_sources'] = cw._snapshot(state, ['d'])    # as a Browser run records its sources
    cw._install_result(state, result, cw._snapshot(state, ['d']), job_id=job_id,
                       filters={'recaller_class_tiers': {'class_001': 'core+edge'}})
    if artifact_dir is not None:
        cw._session(state)[0][job_id]['artifact_dir'] = str(artifact_dir)   # as a Browser run: molecules.tsv.gz there
    return state


def _saved_group(job_id='original-run'):
    return dict(id='g1', name='S1 · Class 1 · d', consensusJobId=job_id, consensusStateId='class_001', sourceDatasetId='d',
                consensusTier='core', savedClass={'id': 'S1'})


def _export(state):
    request = SessionExportRequest(chrom='chrT', start=1000, end=1500, frontend_state={'footprintGroups': [_saved_group()]})
    return build_session_export_for_request(state, request)['session']


def test_save_and_reopen_keeps_the_run_and_its_artifacts(tmp_path, recaller_result):
    result, _ = recaller_result
    state = _state_with_run(_bam(tmp_path), result)
    job = cw._session(state)[0]['original-run']
    artifacts = job['artifact_dir']
    session = _export(state)
    assert [r['job_id'] for r in session['consensus_runs']['runs']] == ['original-run']
    restored = import_session_for_request(state, SessionImportRequest(session=session))
    time.sleep(.2)   # dispose cleans up on a background thread
    assert restored['success'] and restored['results']['consensus_runs_restored'] == 1
    assert cw._session(state)[0]['original-run'] is job                 # kept as it was, not rebuilt
    assert __import__('os').path.isdir(artifacts)
    assert state.consensus_workflow_active == 'original-run'


def test_a_restart_restores_the_run_under_its_own_id(tmp_path, recaller_result):
    result, run_dir = recaller_result
    bam = _bam(tmp_path)
    before = _state_with_run(bam, result, artifact_dir=run_dir)
    scored = recaller_scored_units(cw._session(before)[0]['original-run'], 'd')
    session = _export(before)
    after = BrowserState(None)                                          # a new server: no runs in memory
    restored = import_session_for_request(after, SessionImportRequest(session=session))
    assert restored['results']['consensus_runs_restored'] == 1 and not restored['results']['consensus_runs_failed']
    job = cw._session(after)[0]['original-run']
    assert job['status'] == 'complete' and after.consensus_workflow_active == 'original-run'
    assert job['filters']['recaller_class_tiers'] == {'class_001': 'core+edge'}
    assert recaller_scored_units(job, 'd') == scored                  # the exact scoring population travels too
    assert 'tf_rc' in after.get_dataset('d').derived_layers
    reads = [dict(id=u['read_name'], strand=u['strand']) for u in result['datasets']['d']['units']]
    members, eligible = class_occupancy(after, 'd', 'chrT', reads, [_saved_group()])
    assert members[0] and len(eligible[0]) == 120


def test_a_run_whose_files_changed_is_not_restored(tmp_path, recaller_result):
    result, _ = recaller_result
    bam = _bam(tmp_path)
    session = _export(_state_with_run(bam, result))
    with pysam.AlignmentFile(str(bam), 'wb', header={'HD': {'VN': '1.6'}, 'SQ': [{'SN': 'chrT', 'LN': 2000}, {'SN': 'x', 'LN': 5}]}):
        pass
    pysam.index(str(bam))
    after = BrowserState(None)
    restored = import_session_for_request(after, SessionImportRequest(session=session))
    assert restored['success'] and restored['results']['consensus_runs_restored'] == 0
    assert 'source files changed' in restored['results']['consensus_runs_failed'][0]
    assert 'original-run' not in cw._session(after)[0]


def test_runs_no_saved_class_refers_to_are_still_disposed(tmp_path, recaller_result):
    result, _ = recaller_result
    state = _state_with_run(_bam(tmp_path), result)
    cw._session(state)[0]['other'] = dict(status='complete', artifact_dir=str(tmp_path / 'other-run'))
    session = _export(state)
    session['consensus_runs']['active_job'] = None
    import_session_for_request(state, SessionImportRequest(session=session))
    assert set(cw._session(state)[0]) == {'original-run'}


def test_downloaded_result_reimports_under_its_own_id(tmp_path, recaller_result):
    """Download frozen result -> restart -> Import: saved classes referring to the run resolve again (audit F6)."""
    result, run_dir = recaller_result
    bam = _bam(tmp_path)
    before = _state_with_run(bam, result, artifact_dir=run_dir)
    scored = recaller_scored_units(cw._session(before)[0]['original-run'], 'd')
    raw = cw.export_with_curation(before, 'original-run').read_bytes()
    after = BrowserState(None)
    after.add_dataset('d', str(bam))
    summary = cw.import_result(after, raw)
    assert summary['job_id'] == 'original-run'
    assert recaller_scored_units(cw._session(after)[0]['original-run'], 'd') == scored
    again = cw.import_result(after, raw)                      # the id is taken now: a new one
    assert again['job_id'] != 'original-run'


def test_depth_caps_and_usage_survive_session_export(tmp_path, recaller_result):
    import base64
    import gzip
    import json
    state = _state_with_run(_bam(tmp_path), recaller_result[0])
    job = cw._session(state)[0]['original-run']
    caps = dict(max_discovery_molecules=2000, max_quantification_molecules=1500, sample_seed=7)
    manifest = job['result']['manifest']
    manifest['parameters']['recaller'].update(caps)
    records = [dict(phase='discovery', window=[1050, 1350], **caps,
                    strata=[dict(stratum='d::CT', available=2734, discovery=2000, quantification=None)])]
    loader = [dict(dataset_id='d', reads_seen=25000, eligible_reads=20000, reads_decoded=3000)]
    manifest['loader_sampling'] = loader
    manifest['molecule_sampling'] = records
    block = cw.export_session_runs(state, {})
    saved = json.loads(gzip.decompress(base64.b64decode(block['runs'][0]['payload_gz_b64'])))
    assert {n:saved['result']['manifest']['parameters']['recaller'][n] for n in caps} == caps
    assert saved['result']['manifest']['molecule_sampling'] == records
    assert cw._summary(job)['molecule_sampling'] == records
    assert saved['result']['manifest']['loader_sampling'] == loader
    assert cw._summary(job)['loader_sampling'] == loader
