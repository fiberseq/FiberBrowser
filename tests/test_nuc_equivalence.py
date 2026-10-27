"""Nucleosome panel P-B0 gate: loaded = live (NUC §5.2 "Equivalence tests").

1. Live outputs (services/nuc, per record from the complete source record) equal a ``fiberhmm-scan`` run's rows
   for every record: every ``nucsz``/``nucseg`` mark (reference envelope, molecular start and length, bytes, AN name)
   and every ``nucmol`` scalar, with the scan's calibration (opened scan) and with the browser's own calibration.
2. The browser's calibration (scope 'data') equals the scan's record byte for byte.
3. Overlapping views give identical molecule-wide rows.
4. The rows' layers are the same whether they come from the live store or the scan's tables-mode overlay.

Needs FiberHMM with the nuc scan module (skipped otherwise). The data are synthetic Hia5 molecules
(tests/nuc_fixtures.py).
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrS', 160_000
# Self calibration on a small population keeps the test quick; the browser passes the same settings.
SETTINGS = {'calibration': 'self', 'calibration_population': 400}


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_eq') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


@pytest.fixture(scope='module')
def scan_dir(bam, tmp_path_factory):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    out = tmp_path_factory.mktemp('nuc_scan') / 'scan'
    units = plan({CONTIG: LENGTH}, genome=True, contigs=[CONTIG])
    run_units([{'dataset_id': 'dataset_1', 'paths': [bam]}], units, modules=['nuc'], params={'nuc': SETTINGS},
              out=out, annotate=False, cores=2)
    return out


@pytest.fixture(autouse=True)
def fresh_store(tmp_path, monkeypatch):
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    yield
    STORE.clear()


def _state(bam):
    from models.domain import Dataset
    ds = Dataset('ds0', bam, label='Synthetic')
    return NS(datasets={ds.id: ds}, chroms=[NS(name=CONTIG, size=LENGTH)], performance={'effective': 'standard'})


def _compute(st, start=0, end=LENGTH, **extra):
    from services.nuc import jobs
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=start, end=end, parameters=SETTINGS, workers=2,
                               **extra))
    done = jobs.wait(st, job['job_id'], timeout=900)
    assert done['status'] == 'complete', done
    return done


def _norm(out):
    return ({g: sorted(m) for g, m in out.groups.items()},
            {k: v for k, v in out.scalars.items()})


def test_live_rows_equal_the_scans_rows_with_its_calibration(bam, scan_dir):
    from services.nuc.loaded import scan_rows
    from services.nuc.store import STORE
    from services.scan.registry import open_scan
    st = _state(bam)
    scan = open_scan(st, scan_dir)
    assert scan.bindings['dataset_1']['status'] == 'bound'
    done = _compute(st)
    assert done['results']['ds0']['calibration']['source'] == 'scan'
    loaded = scan_rows(scan, 'ds0', CONTIG, 0, LENGTH)
    live = {(p, *k): v for p in (str(Path(bam).resolve()),) for k, v in STORE.rows_of(p).items()}
    assert len(loaded) > 100
    assert set(loaded) == set(live)
    marks = 0
    for key, row in loaded.items():
        assert _norm(row) == _norm(live[key]), key
        marks += sum(len(m) for m in row.groups.values())
    assert marks > 5000


def test_browser_calibration_equals_the_scans_byte_for_byte(bam, scan_dir):
    from services.nuc.loaded import scan_rows
    from services.nuc.store import STORE
    from services.scan.registry import open_scan
    st = _state(bam)
    done = _compute(st)                      # no scan open: the browser calibrates (scope 'data')
    assert done['results']['ds0']['calibration']['source'] == 'computed'
    from services.nuc.jobs import active_config
    mine = active_config(st, 'ds0').calibration.wrapper
    theirs = json.loads((scan_dir / 'nuc' / 'extra' / 'calibration.json').read_text())
    assert json.dumps(mine, sort_keys=True) == json.dumps(theirs, sort_keys=True)
    # and so the live rows equal the scan's
    scan = open_scan(_state(bam), scan_dir)
    st2 = _state(bam)
    st2.datasets = st.datasets
    loaded = scan_rows(scan, 'ds0', CONTIG, 0, LENGTH)
    live = {(str(Path(bam).resolve()), *k): v for k, v in STORE.rows_of(bam).items()}
    assert set(loaded) == set(live) and all(_norm(loaded[k]) == _norm(live[k]) for k in loaded)
    # a second job reuses the cached record
    STORE.clear()
    assert _compute(_state(bam), 40_000, 50_000)['results']['ds0']['calibration']['source'] == 'cache'


def test_overlapping_views_give_identical_molecule_rows(bam):
    from services.nuc.store import STORE
    st = _state(bam)
    _compute(st, 20_000, 60_000)
    first = dict(STORE.rows_of(bam))
    STORE.clear()
    _compute(_state(bam), 40_000, 100_000)
    second = STORE.rows_of(bam)
    shared = set(first) & set(second)
    assert len(shared) > 20
    assert all(_norm(first[k]) == _norm(second[k]) for k in shared)


def _load(bam, start, end):
    from services.compact_read_loader import build_compact_reads_from_bam
    return build_compact_reads_from_bam(bam, CONTIG, start, end, spanning_only=False, include_layers=True,
                                        include_layer_qualities=True)


def test_layers_from_the_store_equal_the_scan_overlay(bam, scan_dir):
    from services.nuc.store import STORE
    from services.scan.overlay import apply_scan_overlays
    from services.scan.registry import open_scan
    st = _state(bam)
    start, end = 40_000, 52_000
    plain = _load(bam, start, end)
    assert not any('nucsz' in (r.get('layers') or {}) for r in plain)
    _compute(st, start, end)
    live = {(r['record_sha256'], r['alignment_occurrence']): r for r in _load(bam, start, end)}
    with_nuc = [r for r in live.values() if 'nucsz' in (r.get('layers') or {})]
    assert len(with_nuc) >= 10
    # the scan's tables-mode overlay on rows without live layers
    STORE.clear()
    st2 = _state(bam)
    open_scan(st2, scan_dir)
    overlaid = apply_scan_overlays(st2, 'ds0', CONTIG, start, end, _load(bam, start, end))
    by_key = {(r['record_sha256'], r['alignment_occurrence']): r for r in overlaid}
    for key, row in live.items():
        for group in ('nucsz', 'nucseg'):
            a = (row.get('layers') or {}).get(group)
            b = (by_key[key].get('layers') or {}).get(group)
            assert (a is None) == (b is None), (key, group)
            if a is None:
                continue
            for field in ('intervals', 'qualities', 'quality_names', 'annotation_names'):
                assert a[field] == b[field], (key, group, field)


def test_rows_carry_contract_quality_names_and_never_nucmol(bam):
    st = _state(bam)
    _compute(st, 40_000, 50_000)
    rows = [r for r in _load(bam, 40_000, 50_000) if 'nucsz' in (r.get('layers') or {})]
    assert rows and all('nucmol' not in r['layers'] for r in rows)
    assert rows[0]['layers']['nucsz']['quality_names'] == ['coarse', 'named', 'posterior', 'z']
    assert rows[0]['layers']['nucseg']['quality_names'] == ['code', 'posterior_or_llr10', 'q_hat_minus_100_or_count']
    ds = st.datasets['ds0']
    assert ds.derived_layers['nucsz']['kind'] == 'nuc-live' and ds.available_layers['nucseg']


def test_a_genome_nuc_scan_makes_a_view_precomputed(bam, scan_dir):
    """scan-next follow-up: nuc's calibration no longer depends on the plan (scope 'data'), so an open genome scan
    covers a view's units; the old same-plan condition is gone."""
    from services.scan import planning
    from services.scan.registry import open_scan
    st = _state(bam)
    open_scan(st, scan_dir)
    assert json.loads((scan_dir / 'nuc' / 'extra' / 'calibration.json').read_text())['scope'] == 'data'
    plan = planning.build_plan(st, dict(datasets=['ds0'], scope='view', chrom=CONTIG, start=40_000, end=70_000,
                                        modules=['nuc'], parameters={'nuc': SETTINGS}))
    cov = plan['coverage']['nuc']
    assert cov['to_compute'] == [] and len(cov['precomputed']) == len(plan['units'])
    assert '--genome --zones chrS:' in plan['cli']['text']


def _summary(st, ds_id='ds0', start=40_000, end=52_000):
    from services.nuc.observations import summarize
    out = summarize(st, [dict(obsId='o', datasetId=ds_id, chrom=CONTIG, start=start, end=end)])['observations'][0]
    assert 'error' not in out, out
    return out


def _numbers(summary):
    return {k: summary[k] for k in ('records', 'computed', 'molecules', 'lowInformation', 'sizes', 'spacing', 'segments')}


def test_a_loaded_scan_summarises_without_compute_and_equals_live(bam, scan_dir):
    from services.scan.registry import open_scan
    st = _state(bam)
    open_scan(st, scan_dir)
    loaded = _summary(st)
    assert loaded['computed'] > 10 and loaded['notComputed'] == 0
    assert all(s.startswith('scan:') for s in loaded['sources'])
    _compute(st, 40_000, 52_000)
    live = _summary(st)
    assert live['sources'] == ['live']
    assert _numbers(loaded) == _numbers(live)


def test_an_annotated_bam_summarises_from_its_own_groups_and_equals_live(bam, tmp_path):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    out = tmp_path / 'annotated_scan'
    run_units([{'dataset_id': 'dataset_1', 'paths': [bam]}], plan({CONTIG: LENGTH}, genome=True, contigs=[CONTIG]),
              modules=['nuc'], params={'nuc': SETTINGS}, out=out, annotate=True, cores=2)
    manifest = json.loads((out / 'manifest.json').read_text())
    annotated = str(out / manifest['outputs']['annotated'][0]['path'])
    st = _state(annotated)
    loaded = _summary(st)
    assert loaded['computed'] > 10 and loaded['sources'] == ['annotated']
    # live outputs of the annotated records (their calls are the input's) use the scan's calibration
    from services.scan.registry import open_scan
    open_scan(st, out)
    done = _compute(st, 40_000, 52_000)
    assert done['results']['ds0']['calibration']['source'] == 'scan'
    live = _summary(st)
    assert live['sources'] == ['live']
    # Marks are exact in both; nucmol scalars are bytes in an annotated BAM (CONTRACTS §6.4: lossy, the codec's
    # step), so spacing summaries agree to the codec step and the bytes agree exactly.
    a, b = _numbers(loaded), _numbers(live)
    assert {k: a[k] for k in a if k != 'spacing'} == {k: b[k] for k in b if k != 'spacing'}
    for key, step in (('regularity', 0.008), ('gapCv', 0.008)):
        assert all(abs(x - y) <= step for x, y in zip(a['spacing'][key], b['spacing'][key]))
    assert all(abs(x - y) <= 1 for x, y in zip(a['spacing']['nrl']['quantiles'], b['spacing']['nrl']['quantiles']))
    from services.nuc.loaded import loaded_rows
    from services.nuc.inputs import nuc_source
    from services.nuc.store import STORE
    live_rows = {(str(Path(annotated).resolve()), *k): v for k, v in STORE.rows_of(annotated).items()}
    src = nuc_source(st, 'ds0')
    STORE.clear()
    ann = loaded_rows(_state(annotated), src, [(CONTIG, 40_000, 52_000)], list(live_rows))
    assert len(ann) > 10
    for key, row in ann.items():
        assert row.nucmol == live_rows[key].nucmol, key
        assert {g: sorted(m) for g, m in row.groups.items()} == {g: sorted(m) for g, m in live_rows[key].groups.items()}
