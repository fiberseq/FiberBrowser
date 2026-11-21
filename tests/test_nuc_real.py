"""Nucleosome panel on the HG002 AluY demo (real data; skipped unless the pg-lift demo paths are set).

``FIBERBROWSER_TEST_LIFT_NATIVE`` (the reads aligned to GRCh38), ``FIBERBROWSER_TEST_LIFT_BAM`` (the same reads
aligned to HG002) and ``FIBERBROWSER_TEST_LIFT_MAP`` (the GRCh38 <- HG002 lift map).

- A live job computes outputs for both datasets at the AluY view: the native rows and the live-lifted rows carry
  ``nucsz``/``nucseg`` layers (lifted ones through compose's projection, split at gaps under one AN name).
- The MAT and PAT observations of the lifted dataset resolve to their own records and windows in source
  coordinates; their summaries count footprints and segments.
- A graph-path observation (a source contig span) resolves to the records over it.
"""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pytest.importorskip('fiberhmm.scan.modules.nuc')

NATIVE = os.environ.get('FIBERBROWSER_TEST_LIFT_NATIVE', '')
LIFTED = os.environ.get('FIBERBROWSER_TEST_LIFT_BAM', '')
MAP = os.environ.get('FIBERBROWSER_TEST_LIFT_MAP', '')
CHROM, START, END = 'chr3', 128_653_000, 128_661_000

pytestmark = pytest.mark.skipif(not (Path(NATIVE).is_file() and Path(LIFTED).is_file() and Path(MAP).is_file()),
                                reason='Set FIBERBROWSER_TEST_LIFT_NATIVE, _BAM and _MAP for the AluY demo')


@pytest.fixture(scope='module')
def computed(tmp_path_factory):
    os.environ['FIBERBROWSER_SCAN_CACHE_DIR'] = str(tmp_path_factory.mktemp('nuc_real') / 'cache')
    from models.domain import Dataset
    from services.lift.dataset import LiveLiftConfig
    from services.nuc import jobs
    from services.nuc.store import STORE
    STORE.clear()
    native = Dataset('native', NATIVE, label='GRCh38')
    lifted = NS(id='lifted', label='Lifted', data_type='bam_livelift', paths=[LIFTED], path=LIFTED,
                live_lift=LiveLiftConfig(MAP, []), available_layers={}, derived_layers={})
    st = NS(datasets={'native': native, 'lifted': lifted}, chroms=[NS(name=CHROM, size=198_295_559)],
            performance={'effective': 'standard'})
    job = jobs.submit(st, dict(datasets=['native', 'lifted'], chrom=CHROM, start=START, end=END, workers=4))
    done = jobs.wait(st, job['job_id'], timeout=1200)
    assert done['status'] == 'complete', done
    yield st, done
    STORE.clear()


def test_native_and_lifted_rows_carry_nuc_layers(computed):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.lift.reads import lifted_reads_for_region
    st, done = computed
    for ds_id in ('native', 'lifted'):
        r = done['results'][ds_id]
        assert r['computed'] > 50 and r['calibration']['source'] == 'computed'
    native = build_compact_reads_from_bam(NATIVE, CHROM, START, END, spanning_only=False, include_layers=True)
    assert sum('nucsz' in (r.get('layers') or {}) for r in native) > 50
    rows = lifted_reads_for_region(st.datasets['lifted'], CHROM, START, END, {'include_layers': True,
                                                                              'include_layer_qualities': True})
    with_nuc = [r for r in rows if 'nucsz' in (r.get('layers') or {})]
    assert len(with_nuc) > 50
    layer = with_nuc[0]['layers']['nucsz']
    assert layer['quality_names'] == ['coarse', 'named', 'posterior', 'z']
    assert len(layer['annotation_names']) == len(layer['intervals'])
    assert all(n.startswith('nucsz@') for n in layer['annotation_names'])


def test_haplotype_observations_resolve_in_source_coordinates(computed):
    from services.nuc.observations import summarize
    st, _done = computed
    obs = [dict(obsId='grch38', datasetId='native', chrom=CHROM, start=START, end=END),
           dict(obsId='mat', datasetId='lifted', chrom=CHROM, start=START, end=END, liftHap='MAT'),
           dict(obsId='pat', datasetId='lifted', chrom=CHROM, start=START, end=END, liftHap='PAT')]
    out = {o['obsId']: o for o in summarize(st, obs)['observations']}
    for k in ('grch38', 'mat', 'pat'):
        assert 'error' not in out[k], out[k]
        assert out[k]['computed'] > 20 and out[k]['sizes']['footprints'] > 100 and out[k]['segments']['bp'] > 0
    assert out['mat']['windows'][0]['chrom'].endswith('MATERNAL') and out['pat']['windows'][0]['chrom'].endswith('PATERNAL')
    assert out['mat']['computed'] + out['pat']['computed'] >= out['grch38']['computed'] * 0.8
    assert out['grch38']['windowMetrics']['n_molecules'] > 10


def test_graph_path_observation(computed):
    from services.nuc.observations import summarize
    st, done = computed
    contig, a, b = done['results']['lifted']['regions'][0]
    out = summarize(st, [dict(obsId='g', kind='graph', datasetId='lifted', graph=dict(contig=contig, start=a, end=b))])
    g = out['observations'][0]
    assert 'error' not in g and g['computed'] > 20 and g['windows'][0]['chrom'] == contig
