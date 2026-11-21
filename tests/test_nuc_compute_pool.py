"""Nucleosome jobs on worker processes store exactly what the serial compute stores.

The pool path (services/nuc/compute_pool.py) reads the region in the server process, computes the records on
spawned workers and stores their outputs in record order. Rows, failures, counts and the cached molecules and
results must equal the serial compute's. Stored molecules leave out their cumulative count arrays, which are
rebuilt identically on first use.
"""
from __future__ import annotations

import dataclasses
import math
from types import SimpleNamespace as NS

import numpy as np
import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrS', 60_000
SETTINGS = {'calibration': 'self', 'calibration_population': 200}


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_pool') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


@pytest.fixture(autouse=True)
def fresh_store(tmp_path, monkeypatch):
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    yield
    STORE.clear()


def _compute(bam, performance):
    from models.domain import Dataset
    from services.nuc import jobs
    from services.nuc.store import STORE
    ds = Dataset('ds0', bam, label='Synthetic')
    st = NS(datasets={ds.id: ds}, chroms=[NS(name=CONTIG, size=LENGTH)], performance=performance)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=0, end=LENGTH, parameters=SETTINGS, workers=2))
    done = jobs.wait(st, job['job_id'], timeout=900)
    assert done['status'] == 'complete', done
    cfg = jobs.active_config(st, 'ds0')
    path = STORE._path(ds.path)
    files = STORE._files[path]
    out = dict(stats={k: v for k, v in done['results']['ds0'].items()},
               rows=[(k, v.to_json()) for k, v in STORE.rows_of(path).items()],
               failed=dict(files.failed),
               results=STORE.results_of(path, cfg.config_for(path)))
    STORE.clear()
    return out


def _same(a, b, where=''):
    assert type(a) is type(b), where
    if isinstance(a, np.ndarray):
        assert a.dtype == b.dtype and a.shape == b.shape and np.array_equal(a, b, equal_nan=a.dtype.kind == 'f'), where
    elif isinstance(a, float):
        # Spectral regularity can differ in the last digit between two runs of the same code (FFT on another
        # buffer); everything else is exact.
        assert (math.isnan(a) and math.isnan(b)) or math.isclose(a, b, rel_tol=1e-12, abs_tol=0), where
    elif isinstance(a, dict):
        assert list(a) == list(b), where
        for k in a:
            _same(a[k], b[k], f'{where}.{k}')
    elif isinstance(a, (list, tuple)):
        assert len(a) == len(b), where
        for i, (x, y) in enumerate(zip(a, b)):
            _same(x, y, f'{where}[{i}]')
    elif dataclasses.is_dataclass(a):
        for f in dataclasses.fields(a):
            _same(getattr(a, f.name), getattr(b, f.name), f'{where}.{f.name}')
    elif hasattr(a, '__dict__'):
        _same(vars(a), vars(b), where)
    else:
        assert a == b, where


def test_pool_stores_what_the_serial_compute_stores(bam):
    serial = _compute(bam, {'effective': 'standard', 'workers': 1, 'decode_workers': 1})
    pooled = _compute(bam, {'effective': 'high', 'workers': 2, 'decode_workers': 2})
    assert serial['stats']['computed'] > 20
    for key in ('records', 'computed', 'cached', 'undecodable', 'withoutCalls'):
        assert pooled['stats'][key] == serial['stats'][key], key
    assert pooled['rows'] == serial['rows']
    assert pooled['failed'] == serial['failed']
    assert list(pooled['results']) == list(serial['results'])
    for key, (mol, res) in serial['results'].items():
        pmol, pres = pooled['results'][key]
        assert mol._cum_hit is None and pmol._cum_hit is None
        _same(pmol, mol, f'mol {key}')
        _same(pres, res, f'res {key}')


def test_stored_molecules_rebuild_their_counts():
    from fiberhmm.nuc.records import NucMolecule
    from services.nuc.compute_pool import slim_molecule
    rng = np.random.default_rng(3)
    inf = rng.random(500) < 0.6
    mol = NucMolecule('m', 500, False, [], [], [], rng.random(500) < 0.2, inf)
    before = mol.counts(np.arange(0, 500, 7), np.arange(5, 505, 7))
    slim_molecule(mol)
    assert mol._cum_hit is None and mol._cum_inf is None
    after = mol.counts(np.arange(0, 500, 7), np.arange(5, 505, 7))
    for x, y in zip(before, after):
        assert x.dtype == y.dtype and np.array_equal(x, y)


def test_low_memory_mode_computes_in_the_server_process():
    from services.nuc.compute_pool import compute_workers
    assert compute_workers(NS(performance={'effective': 'low', 'workers': 1, 'decode_workers': 1})) == 1
    assert compute_workers(NS()) == 1
    assert compute_workers(NS(performance={'effective': 'high', 'workers': 4, 'decode_workers': 8})) >= 1
