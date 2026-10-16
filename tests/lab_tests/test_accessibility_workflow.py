"""Accessibility (preview): the FiberHMM NFR-variant job runner (EXPERIMENTAL).

Synthetic payloads keep most tests fast (the loader is replaced); one test runs the real demo BAM through FiberHMM."""
import csv
import gzip
import io
import threading
import time
from pathlib import Path

import numpy as np
import pysam
import pytest

from models.requests import SessionExportRequest, SessionImportRequest
from lab.services import accessibility_workflow as aw
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
from state.browser_state import BrowserState

ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / 'browser' / 'data' / 'demo' / 'napa_ddda.bam'


def _empty_bam(tmp_path, name='source.bam'):
    bam = tmp_path / name
    with pysam.AlignmentFile(str(bam), 'wb', header={'HD': {'VN': '1.6'}, 'SQ': [{'SN': 'chrT', 'LN': 5000}]}):
        pass
    pysam.index(str(bam))
    return bam


def planted_payload(n=300, seed=3, dataset='d'):
    """Molecules over chrT:0-4000, nucleosomes with 40-bp linkers; an NFR at 1500-1720 is open on 60% of molecules
    (a third of those split: 1500-1590 + 1690-1780 around a 100-bp nucleosome), and a second NFR at 2600-2780
    opens more often with the first."""
    rng = np.random.default_rng(seed); units = []
    for i in range(n):
        open1 = rng.random() < .6; split = open1 and rng.random() < .33
        open2 = rng.random() < (.75 if open1 else .2)
        gaps = []
        if open1:
            gaps += [(1500, 1590), (1690, 1780)] if split else [(1500 + int(rng.integers(-6, 7)), 1720 + int(rng.integers(-6, 7)))]
        if open2:
            gaps.append((2600 + int(rng.integers(-6, 7)), 2780 + int(rng.integers(-6, 7))))
        nucs, s = [], 200
        for g0, g1 in sorted(gaps) + [(3800, 3800)]:
            k = max(1, round((g0 - s + 40)/187))
            size = (g0 - s - 40*(k - 1))/k
            nucs += [[int(s + j*(size + 40)), int(s + j*(size + 40) + size)] for j in range(k)]
            s = g1
        pos = np.arange(0, 4000, 5)
        acc = np.ones(len(pos), bool)
        for a, b in nucs:
            acc &= ~((pos >= a) & (pos < b))
        hit = np.where(acc, rng.random(len(pos)) < .6, rng.random(len(pos)) < .02)
        units.append(dict(unit_id=f'unit_{i:04d}', read_name=f'read{i:04d}', strand='CT' if i % 2 == 0 else 'GA',
                          reference_start=0, reference_end=4000, positions=pos.tolist(), hits=hit.astype(int).tolist(),
                          raw_nuc_intervals=nucs, raw_tf_intervals=[], source_members=[dict(read_name=f'read{i:04d}')]))
    return dict(region=dict(chrom='chrT', start=1000, end=3400),
                strata=[dict(dataset_id=dataset, stratum_id=dataset, chemistry='ddda', units=units)])


@pytest.fixture
def state(tmp_path, monkeypatch):
    s = BrowserState(None)
    s.add_dataset('d', str(_empty_bam(tmp_path)))
    calls = []

    def fake_load(state_, request, options, progress):
        calls.append(request)
        progress('loading', 'synthetic molecules')
        return planted_payload()
    monkeypatch.setattr('services.consensus_workflow.load_payload', fake_load)
    s._loads = calls
    return s


def _wait(state, job_id, timeout=120):
    t = time.time()
    while time.time() - t < timeout:
        job = aw.get_job(state, job_id)
        if job['status'] not in ('queued', 'running', 'cancelling'):
            return job
        time.sleep(.1)
    raise AssertionError('job did not finish')


REQUEST = dict(dataset_ids=['d'], chemistry_overrides={'d': 'ddda'}, chrom='chrT', start=1000, end=3400,
               parameters=dict(bootstrap=20, nfr_regions=[[1450, 1760], [2560, 2820]]))


def test_a_run_finds_variants_groups_reads_and_exports(state):
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'complete', job['message']
    result = job['result']
    assert result['schema'].startswith('fiberhmm.accessibility') and result['experimental'] is True
    assert 'molecules' not in result                       # per-read records stay on the server
    n1, n2 = result['nfrs']
    assert n1['callable'] == n1['reads'] == 300 and n2['variants']
    widths = sorted(round(v['width']) for v in n1['variants'])
    assert any(w > 180 for w in widths)                    # the full NFR
    assert job['progress']['stage'] == 'complete' and job['payload_source'] == 'loaded'
    # the two NFRs open together: a co-accessible variant pair
    pair = next(p for p in result['pairs'] if p['a'].startswith('N1') and p['b'].startswith('N2') or p['a'].startswith('N2') and p['b'].startswith('N1'))
    assert pair['n'] >= 50
    assert any(p['class'] == 'co-accessible' for p in result['pairs'])
    # read groups: MAP configurations, read names per dataset, one pattern bit per variant
    groups = aw.read_groups(state, job['job_id'], 'N1')
    assert {g['label'] for g in groups['groups']} >= {'closed'}
    assert sum(g['count'] for g in groups['groups']) == 300 and len(groups['by_dataset']['d']) == 300
    assert all(len(g['pattern']) == len(n1['variants']) for g in groups['groups'])
    full = max(n1['variants'], key=lambda v: v['width'])
    reads = aw.element_reads(state, job['job_id'], full['id'])['by_dataset']['d']
    assert 100 < len(reads) < 300 and all(r.startswith('read') for r in reads)
    # exports are the engine's own files
    tsv = aw.export_path(state, job['job_id'], 'variants.tsv').read_text()
    rows = list(csv.DictReader(io.StringIO(tsv), delimiter='\t'))
    assert {r['id'] for r in rows} == {v['id'] for n in result['nfrs'] for v in n['variants']}
    assert {'prevalence_strict', 'prevalence_em', 'ci_lo', 'ci_hi'} <= set(rows[0])
    with gzip.open(aw.export_path(state, job['job_id'], 'molecules.tsv.gz'), 'rt') as fh:
        assert sum(1 for _ in fh) == 1 + 2*300
    with pytest.raises(ValueError, match='Unknown export'):
        aw.export_path(state, job['job_id'], '../manifest.json')


def test_parameters_are_checked_before_anything_runs(state):
    with pytest.raises(ValueError, match='Unknown Accessibility parameter'):
        aw.submit(state, dict(REQUEST, parameters=dict(kmeans_k=3)))
    with pytest.raises(ValueError, match='stringency'):
        aw.submit(state, dict(REQUEST, parameters=dict(stringency=1.5)))
    with pytest.raises(ValueError, match='mode'):
        aw.submit(state, dict(REQUEST, parameters=dict(mode='widths')))
    with pytest.raises(ValueError, match='must be a number'):
        aw.submit(state, dict(REQUEST, parameters=dict(stringency='high')))
    with pytest.raises(ValueError, match='distinct datasets'):
        aw.submit(state, dict(REQUEST, dataset_ids=[]))
    with pytest.raises(ValueError, match='half-open'):
        aw.submit(state, dict(REQUEST, start='1000'))
    with pytest.raises(ValueError, match='analysis limit'):
        aw.submit(state, dict(REQUEST, end=10_000_000))
    # A given NFR region outside the view (carried over from another locus) is refused, not run to an empty result.
    with pytest.raises(ValueError, match='outside the view'):
        aw.submit(state, dict(REQUEST, parameters=dict(bootstrap=20, nfr_regions=[[15_039_433, 15_039_983]])))
    assert not state._loads


def test_bigbed_datasets_are_refused_with_a_reason(state, tmp_path):
    ds = state.get_dataset('d')
    ds.data_type = 'bigbed'
    with pytest.raises(ValueError, match='BigBed datasets are not supported'):
        aw.submit(state, REQUEST)


def test_one_run_at_a_time_and_cancel(state, monkeypatch):
    release = threading.Event()

    def slow_load(state_, request, options, progress):
        for _ in range(400):
            progress('loading', 'waiting')
            if release.wait(.05):
                break
        return planted_payload()
    monkeypatch.setattr('services.consensus_workflow.load_payload', slow_load)
    job = aw.submit(state, REQUEST)
    with pytest.raises(ValueError, match='already running'):
        aw.submit(state, REQUEST)
    cancelled = aw.cancel(state, job['job_id'])
    assert cancelled['status'] == 'cancelling'
    done = _wait(state, job['job_id'])
    assert done['status'] == 'cancelled' and 'result' not in done
    with pytest.raises(ValueError, match='completed'):
        aw.read_groups(state, job['job_id'], 'N1')
    assert [j['job_id'] for j in aw.list_jobs(state)['jobs']] == [job['job_id']]


def test_engine_errors_end_the_job_with_the_message(state, monkeypatch):
    monkeypatch.setattr('services.consensus_workflow.load_payload',
                        lambda *a: dict(region=dict(chrom='chrT', start=1000, end=3400), strata=[dict(dataset_id='d', units=[])]))
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'error' and 'No molecules' in job['message']


def test_footprint_classes_of_a_find_classes_run_become_elements(state, tmp_path):
    """A complete lattice-recaller run on the same datasets: its classes join the run by unit_id."""
    from services import consensus_workflow as cw
    run = tmp_path / 'class-run'; run.mkdir()
    (run / 'classes.tsv').write_text('class_id\tchannel\tstart\tend\tprevalence\tsupported\n'
                                     'class_001\td::CT\t1600\t1630\t0.3\tTrue\nclass_001\td::GA\t1600\t1630\t0.3\tTrue\n')
    payload = planted_payload()
    with gzip.open(run / 'molecules.tsv.gz', 'wt') as fh:
        fh.write('class_id\tchannel\tunit_id\tlabel\n')
        for i, u in enumerate(payload['strata'][0]['units']):
            fh.write(f"class_001\td::{u['strand']}\t{u['unit_id']}\t{'member' if i % 3 == 0 else 'non_member'}\n")
    jobs, _lock = cw._session(state)
    jobs['classes'] = dict(job_id='classes', status='complete', result=dict(cr_mode='lattice_recaller'), artifact_dir=str(run),
                           request=dict(dataset_ids=['d'], chrom='chrT', start=1200, end=2000, chemistry_overrides={'d': 'ddda'},
                                        parameters={}),
                           _snapshot=cw._snapshot(state, ['d']), finished_at=time.time())
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'complete' and job['class_job_id'] == 'classes'
    result = job['result']
    assert result['class_join'] == dict(classes=1, class_molecules=300, joined_molecules=300, molecules=300)
    assert any(e['kind'] == 'tf' for e in result['elements'])
    assert any('class_001' in (p['a'], p['b']) for p in result['pairs'])
    # the class run does not cover the region: its evidence is not reused
    assert job['payload_source'] == 'loaded'


def test_sessions_keep_runs_and_regenerate_their_files(state, tmp_path):
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    session = build_session_export_for_request(state, SessionExportRequest(chrom='chrT', start=1000, end=3400))['session']
    block = session['accessibility_runs']
    assert block['schema'] == aw.SESSION_RUNS_SCHEMA and [r['job_id'] for r in block['runs']] == [job['job_id']]
    after = BrowserState(None)
    restored = import_session_for_request(after, SessionImportRequest(session=session))
    assert restored['results']['accessibility_runs_restored'] == 1, restored['results']
    again = aw.get_job(after, job['job_id'])
    assert again['status'] == 'complete' and again['result']['nfrs'] == job['result']['nfrs']
    assert aw.read_groups(after, job['job_id'], 'N1')['by_dataset'] == aw.read_groups(state, job['job_id'], 'N1')['by_dataset']
    assert aw.export_path(after, job['job_id'], 'coaccess.tsv').read_text() == aw.export_path(state, job['job_id'], 'coaccess.tsv').read_text()


def test_a_session_whose_files_changed_does_not_restore_the_run(state, tmp_path):
    _wait(state, aw.submit(state, REQUEST)['job_id'])
    session = build_session_export_for_request(state, SessionExportRequest(chrom='chrT', start=1000, end=3400))['session']
    bam = Path(state.get_dataset('d').path)
    with pysam.AlignmentFile(str(bam), 'wb', header={'HD': {'VN': '1.6'}, 'SQ': [{'SN': 'chrT', 'LN': 5000}, {'SN': 'x', 'LN': 9}]}):
        pass
    pysam.index(str(bam))
    after = BrowserState(None)
    restored = import_session_for_request(after, SessionImportRequest(session=session))
    assert restored['results']['accessibility_runs_restored'] == 0
    assert 'source files changed' in restored['results']['accessibility_runs_failed'][0]


def test_router_endpoints(state, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from lab.routers.accessibility import router
    from state.dependencies import get_state
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    assert client.get('/api/accessibility/schema').json()['defaults']['stringency'] == 0.9
    assert client.post('/api/accessibility/jobs', json=dict(REQUEST, parameters=dict(nope=1))).status_code == 422
    job = client.post('/api/accessibility/jobs', json=REQUEST).json()
    done = _wait(state, job['job_id'])
    assert client.get(f"/api/accessibility/jobs/{job['job_id']}").json()['status'] == done['status'] == 'complete'
    assert client.get('/api/accessibility/jobs/nope').status_code == 404
    groups = client.get(f"/api/accessibility/jobs/{job['job_id']}/groups", params=dict(nfr='N1')).json()
    assert groups['groups'] and groups['by_dataset']['d']
    assert client.get(f"/api/accessibility/jobs/{job['job_id']}/groups", params=dict(nfr='N9')).status_code == 422
    tsv = client.get(f"/api/accessibility/jobs/{job['job_id']}/export/coaccess.tsv")
    assert tsv.status_code == 200 and tsv.text.startswith('a\tb\t')
    assert client.delete(f"/api/accessibility/jobs/{job['job_id']}").json()['status'] == 'complete'


@pytest.mark.skipif(not DEMO.exists(), reason='demo BAM not present')
def test_demo_bam_secondary_nfr_through_fiberhmm():
    """The real demo BAM through FiberHMM's loader: NAPA's secondary NFR is detected and its three variants found
    (the prototype's V1 alternative-left, V2 full, V3 alternative-right).

    Rarest NFR 15%, as the e2e (tests/e2e/lab/nfr-preview.spec.ts) sets it: at the 10% default of FiberHMM's
    depth-aware detection the view's rarer openings are NFRs too (one at the window's left edge, and the secondary
    NFR widens to 47,518,040-47,518,570 with six variants; its full variant is the same)."""
    s = BrowserState(None)
    s.add_dataset('napa', str(DEMO))
    job = _wait(s, aw.submit(s, dict(dataset_ids=['napa'], chrom='chr19', start=47517650, end=47518985,
                                     parameters=dict(bootstrap=20, min_fraction=0.15)))['job_id'], timeout=600)
    assert job['status'] == 'complete', job['message']
    n1 = job['result']['nfrs'][0]
    assert n1['source'] == 'detected' and abs(n1['start'] - 47518170) <= 20 and abs(n1['end'] - 47518510) <= 20
    rel = [v['relation'] for v in n1['variants']]
    assert rel == ['alternative-left', 'full', 'alternative-right']
    full = n1['variants'][1]
    assert abs(full['L'] - 47518219) < 5 and abs(full['R'] - 47518459) < 5 and abs(full['prevalence'] - .291) < .01
    assert set(full['by_channel']) == {'napa::CT', 'napa::GA'}


def _class_run(state, tmp_path, start=1000, end=3400, chemistry='ddda', name='classes'):
    from fiberhmm.inference.consensus.artifacts import write_json
    from services import consensus_workflow as cw
    run = tmp_path / name; run.mkdir()
    write_json(run / 'evidence.json.gz', dict(planted_payload(), region=dict(chrom='chrT', start=start, end=end)))
    jobs, _lock = cw._session(state)
    jobs[name] = dict(job_id=name, status='complete', result=dict(cr_mode='lattice_recaller'), artifact_dir=str(run),
                      request=dict(dataset_ids=['d'], chrom='chrT', start=start, end=end, chemistry_overrides={'d': chemistry},
                                   parameters={'cr': {'engine': 'lattice_recaller'}}),
                      _snapshot=cw._snapshot(state, ['d']), finished_at=time.time())


def test_a_find_classes_run_on_the_same_region_lends_its_evidence(state, tmp_path):
    """Same datasets, chemistry, loader input and region: the class run's saved evidence is this run's load and is
    reused. A larger region would have loaded other observations and duplicate groups: it is not narrowed, but loaded."""
    _class_run(state, tmp_path)
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['status'] == 'complete' and job['payload_source'] == 'reused from Find classes run classes'
    assert not state._loads and job['result']['region'] == dict(chrom='chrT', start=1000, end=3400)
    job = _wait(state, aw.submit(state, dict(REQUEST, loader_parameters={'input': {'minimum_mapq': 30}}))['job_id'])
    assert job['payload_source'] == 'loaded' and len(state._loads) == 1


def test_a_larger_or_other_chemistry_class_run_does_not_lend_evidence(state, tmp_path):
    _class_run(state, tmp_path, start=500, end=3900, name='larger')
    _class_run(state, tmp_path, chemistry='dddb', name='other_chemistry')
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    assert job['payload_source'] == 'loaded' and len(state._loads) == 1
    assert job.get('class_job_id') is None       # neither has classes.tsv; the dddb one is never a candidate
    from services import consensus_workflow as cw
    snap = cw._snapshot(state, ['d'])
    req = dict(REQUEST, chemistry_overrides={'d': 'ddda'})
    assert aw._matching_class_job(state, req, snap, {}, exact=False)['job_id'] == 'larger'


def test_read_names_whose_molecules_disagree_are_left_out_of_groups(state, monkeypatch):
    """Two molecules sharing a QNAME (merged BAMs): if their configurations differ, the name is not grouped."""
    payload = planted_payload()
    units = payload['strata'][0]['units']
    covers = lambda u: any(a <= 1550 < b for a, b in u['raw_nuc_intervals'])
    opened = next(u for u in units if not covers(u))
    closed = next(u for u in units if covers(u))
    closed['read_name'] = opened['read_name']; closed['source_members'] = [dict(read_name=opened['read_name'])]
    monkeypatch.setattr('services.consensus_workflow.load_payload', lambda *a: payload)
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    record = aw._session(state)[0][job['job_id']]['result']['molecules']
    assert record[closed['unit_id']]['nfr']['N1']['map'] == 'closed' != record[opened['unit_id']]['nfr']['N1']['map']
    groups = aw.read_groups(state, job['job_id'], 'N1')
    assert opened['read_name'] not in groups['by_dataset']['d'] and groups['ambiguous_reads'] == {'d': 1}
    assert len(groups['by_dataset']['d']) == 298
    full = max(job['result']['nfrs'][0]['variants'], key=lambda v: v['width'])
    reads = aw.element_reads(state, job['job_id'], full['id'])
    assert opened['read_name'] not in reads['by_dataset']['d'] or record[opened['unit_id']]['nfr']['N1']['p'][full['name']] < .5
    assert sum(g['count'] for g in groups['groups']) == len(groups['by_dataset']['d'])


def test_session_restore_bounds_and_validates_runs(state, tmp_path):
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    session = build_session_export_for_request(state, SessionExportRequest(chrom='chrT', start=1000, end=3400))['session']
    import base64, copy, json as _json
    bad = copy.deepcopy(session)
    bad['accessibility_runs']['runs'][0]['payload_gz_b64'] = base64.b64encode(gzip.compress(_json.dumps([1]).encode())).decode()
    after = BrowserState(None)
    res = import_session_for_request(after, SessionImportRequest(session=bad))
    assert res['results']['accessibility_runs_restored'] == 0 and 'not an object' in res['results']['accessibility_runs_failed'][0]
    # The same server, the run kept through import: still checked against the files now open.
    store = aw._session(state)[0][job['job_id']]
    store['_snapshot'] = {'d': {'paths': ['elsewhere.bam'], 'files': []}}
    many = copy.deepcopy(session)
    many['accessibility_runs']['runs'][0]['sources'] = {'d': {'paths': ['elsewhere.bam'], 'files': []}}
    many['accessibility_runs']['runs'] = many['accessibility_runs']['runs'] * (aw.MAX_SESSION_RUNS + 2)
    res = import_session_for_request(state, SessionImportRequest(session=many))
    assert res['results']['accessibility_runs_restored'] == 0
    assert any('beyond' in p for p in res['results']['accessibility_runs_failed'])


def test_the_engine_knobs_the_panel_exposes_reach_the_run(state):
    params = dict(REQUEST['parameters'], min_gap_bp=80, openness_pad_bp=10, open_threshold=0.6, detect_threshold=0.2,
                  shift_bp=30, min_reads=8.0)
    job = _wait(state, aw.submit(state, dict(REQUEST, parameters=params))['job_id'])
    assert job['status'] == 'complete', job['message']
    p = job['result']['parameters']
    assert (p['min_gap_bp'], p['openness_pad_bp'], p['open_threshold'], p['detect_threshold'], p['shift_bp']) == (80, 10, 0.6, 0.2, 30)


def test_the_nfr_detection_settings_reach_the_run(state):
    params = {k: v for k, v in REQUEST['parameters'].items() if k != 'nfr_regions'}   # detected, not given
    params.update(detect_method='raw', clip_gaps_to_region=True, min_fraction=0.03, min_fold=2.5, detect_q=0.05, min_open_reads=5)
    job = _wait(state, aw.submit(state, dict(REQUEST, parameters=params))['job_id'])
    assert job['status'] == 'complete', job['message']
    p = job['result']['parameters']
    assert (p['detect_method'], p['min_fraction'], p['min_fold'], p['detect_q'], p['min_open_reads']) == ('raw', 0.03, 2.5, 0.05, 5)
    det = job['result']['detection']
    assert p['clip_gaps_to_region'] is True
    assert det['enrichment_gates'] is False
    assert 'opportunity_diagnostic' in det
    assert det['method'] == 'raw' and det['min_fraction'] == 0.03
    with pytest.raises(ValueError, match='min_fraction'):
        aw.submit(state, dict(REQUEST, parameters=dict(min_fraction=0)))
    with pytest.raises(ValueError, match='detect_method'):
        aw.submit(state, dict(REQUEST, parameters=dict(detect_method='peaks')))
    assert 'min_fraction' in aw.schema()['defaults'] and 'min_fraction' in aw.schema()['panel_parameters']


def test_an_older_fiberhmm_without_the_detection_settings_says_so_plainly():
    import dataclasses
    from types import SimpleNamespace

    @dataclasses.dataclass
    class OldOptions:                       # an NFROptions from before the enrichment rule
        stringency: float = 0.9
        detect_threshold: float = 0.15

        @classmethod
        def from_params(cls, params):
            return cls(**params)
    old = SimpleNamespace(NFROptions=OldOptions)
    assert aw.engine_options(old, dict(stringency=0.85)).stringency == 0.85
    with pytest.raises(ValueError, match='does not have the setting Rarest NFR: it finds NFRs with its older fixed rule'):
        aw.engine_options(old, dict(stringency=0.9, min_fraction=0.03))


def test_gap_assignment_requires_a_boolean():
    with pytest.raises(ValueError, match='clip_gaps_to_region must be true or false'):
        aw.clean_parameters(dict(clip_gaps_to_region='true'))


@pytest.mark.parametrize('cap', [0, 2000])
def test_depth_caps_reach_engine_and_run_receipt(state, monkeypatch, cap):
    from dataclasses import dataclass, fields
    from unittest.mock import Mock
    acc = aw._runtime()
    original = acc.NFROptions
    if 'max_discovery_molecules' not in {f.name for f in fields(original)}:
        @dataclass
        class WithCaps(original):
            max_discovery_molecules: int = 0
            max_quantification_molecules: int = 0
            sample_seed: int = 1

            @classmethod
            def from_params(cls, params):
                return cls(**params)
        monkeypatch.setattr(acc, 'NFROptions', WithCaps)
    called = Mock(side_effect=RuntimeError('stop after engine boundary'))
    monkeypatch.setattr(acc, 'run_accessibility', called)
    params = dict(REQUEST['parameters'], max_discovery_molecules=cap, max_quantification_molecules=cap, sample_seed=7)
    job = _wait(state, aw.submit(state, dict(REQUEST, parameters=params))['job_id'])
    sent = called.call_args.args[1]
    expected = params if cap else REQUEST['parameters']
    assert sent == expected
    assert job['request']['parameters'] == expected


def test_depth_caps_and_usage_survive_session_export(state):
    import base64
    import json
    job = _wait(state, aw.submit(state, REQUEST)['job_id'])
    frozen = aw._session(state)[0][job['job_id']]
    caps = dict(max_discovery_molecules=2000, max_quantification_molecules=1500, sample_seed=7)
    frozen['request']['parameters'].update(caps)
    frozen['result']['parameters'].update(caps)
    records = [dict(phase='discovery', window=[1000, 3400], **caps,
                    strata=[dict(stratum='d::CT', available=2734, discovery=2000, quantification=None)])]
    frozen['result'].setdefault('detection', {})['molecule_sampling'] = records
    block = aw.export_session_runs(state)
    saved = json.loads(gzip.decompress(base64.b64decode(block['runs'][0]['payload_gz_b64'])))
    assert {n:saved['request']['parameters'][n] for n in caps} == caps
    assert saved['result']['detection']['molecule_sampling'] == records


def test_depth_caps_and_seed_distinguish_reused_evidence():
    caps = dict(max_discovery_molecules=2000, max_quantification_molecules=1500, sample_seed=7)
    request = dict(REQUEST, parameters=caps)
    job = dict(request=dict(request, parameters=dict(recaller=caps)), result={}, _snapshot={'d': 'source'})
    mismatch = lambda r: aw._class_job_mismatch(job, r, job['_snapshot'], {}, True,
                                                'lattice_recaller', lambda _: 'lattice_recaller', lambda a, b: a == b)
    assert mismatch(request) == ''
    assert mismatch(dict(request, parameters={})) == 'other read caps or sample seed'
    assert mismatch(dict(request, parameters=dict(caps, sample_seed=8))) == 'other read caps or sample seed'


def test_low_memory_preserves_smaller_caps_and_loader_seed(state, monkeypatch):
    from unittest.mock import Mock
    state.performance = {'effective': 'low', 'max_working_reads': 2000}
    acc = aw._runtime()
    called = Mock(side_effect=RuntimeError('stop after engine boundary'))
    monkeypatch.setattr(acc, 'run_accessibility', called)
    caps = dict(max_discovery_molecules=11, max_quantification_molecules=7, sample_seed=17)
    job = _wait(state, aw.submit(state, dict(REQUEST, parameters={**REQUEST['parameters'], **caps}))['job_id'])
    assert called.called, job
    sent = called.call_args.kwargs['inputs']['loader_parameters']['recaller']
    assert {key: sent[key] for key in caps} == caps
    assert {key: job['request']['parameters'][key] for key in caps} == caps
