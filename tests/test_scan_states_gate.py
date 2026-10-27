"""H1 gate: states from scan files equal the live per-molecule states.

The same scan run in tables mode (``states.tsv.bgz``) and in annotated mode (the module's MA state group on each
record of the annotated BAMs, what the reads carry when the annotated BAM is opened) gives identical per-read
states for every hit with states, for native datasets (by read name) and for live-lift datasets (by record key,
so lifted split rows get their record's state). Needs FiberHMM with ``fiberhmm.scan``.
"""
from __future__ import annotations

import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan')

from scan_fixtures import multi_locus_daf_bam

CONTIG, LENGTH = 'chrT', 140_000
NFR_PARAMS = {'nfr': {'nfr': {'bootstrap': 0, 'kmax': 3, 'splits': 2}}}


@pytest.fixture(scope='module')
def scans(tmp_path_factory):
    from fiberhmm.scan.cli import main
    from services.scan.identity import content_id
    d = tmp_path_factory.mktemp('states')
    bams = sorted([multi_locus_daf_bam(d / 'a.bam', seed=3, contig=CONTIG, length=LENGTH),
                   multi_locus_daf_bam(d / 'b.bam', seed=11, contig=CONTIG, length=LENGTH)], key=content_id)
    (d / 'params.json').write_text(json.dumps(NFR_PARAMS))
    out = {}
    for mode in ('--annotate', '--no-annotate'):
        o = d / mode.strip('-')
        argv = [x for p in bams for x in ('--bam', p)] + ['--genome', '--contigs', CONTIG, '--modules', 'fp,nfr', mode,
                                                         '--parameters', str(d / 'params.json'), '--cores', '2', '-o', str(o)]
        with redirect_stdout(io.StringIO()):
            assert main(argv) == 0
        out[mode] = o
    assert json.loads((out['--annotate'] / 'manifest.json').read_text())['outputs']['annotate'] is True
    assert not (out['--annotate'] / 'fp' / 'states.tsv.bgz').exists()
    return bams, out['--annotate'], out['--no-annotate']


def _state(bams, data_type='bam'):
    from models.domain import Dataset
    from services.lift.live_lift import LiftSettings
    st = NS(datasets={}, chroms=[NS(name=CONTIG, size=LENGTH)])
    for i, p in enumerate(bams):
        ds = Dataset(f'ds{i}', p, label=f'DS{i}')
        ds.data_type = data_type
        if data_type == 'bam_livelift':
            ds.live_lift = NS(settings=LiftSettings())
        st.datasets[ds.id] = ds
    return st


def _all_states(st, scan_dir):
    from services.scan.registry import open_scan
    from services.scan.serve import hits_for_view
    from services.scan.states import hub_feature_states
    scan = open_scan(st, scan_dir)
    out = {}
    for s in scan.sets(st):
        if 'state' not in s['type']['provides']:
            continue
        module = s['source']['module']
        for h in hits_for_view(scan, module, CONTIG, 0, LENGTH, type_id=s['typeId'])['hits']:
            states, *_ = hub_feature_states(st, s['setId'], {'id': h['hitId']})
            out[h['hitId']] = states
    return out


@pytest.mark.parametrize('data_type', ['bam', 'bam_livelift'])
def test_states_tables_equal_annotated(scans, data_type):
    bams, annotated, tables = scans
    from_tables = _all_states(_state(bams, data_type), tables)
    from_reads = _all_states(_state(bams, data_type), annotated)
    assert from_tables and set(from_tables) == set(from_reads)
    # both state groups are covered: footprint classes (fpcls) and NFRs (nfrvar)
    assert any(h.startswith('fp:') for h in from_tables) and any(h.startswith('nfr:') for h in from_tables)
    called = sum(1 for states in from_tables.values() for v in states.values() if v != '.')
    assert called > 50, 'the fixture must give called states'
    for hit_id in from_tables:
        assert from_tables[hit_id] == from_reads[hit_id], hit_id
    if data_type == 'bam_livelift':
        assert all(k[1].startswith('lift-record:v1 ') for states in from_tables.values() for k in states)
