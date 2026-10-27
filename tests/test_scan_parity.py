"""B1 gate: browser = CLI. A live scan in the browser (services/scan/jobs) and a ``fiberhmm-scan`` CLI run on the
same units give identical rows: uncapped and capped, 1 and 4 workers, module subsets, incremental runs; units an
open scan already computed are not computed again; a scan can be cancelled.

Needs FiberHMM with ``fiberhmm.scan`` (skipped otherwise). The fixture is FiberHMM's synthetic DAF locus at five
offsets of a 140 kb contig (two of them across zone boundaries), in two datasets.
"""
from __future__ import annotations

import gzip
import io
import json
import threading
import time
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan')

from scan_fixtures import multi_locus_daf_bam

CONTIG, LENGTH = 'chrT', 140_000
NFR_PARAMS = {'nfr': {'nfr': {'bootstrap': 0, 'kmax': 3, 'splits': 2}}}
TABLES = ('fp/hits.tsv.bgz', 'fp/values.tsv.bgz', 'fp/classes.tsv.bgz', 'fp/states.tsv.bgz',
          'nfr/hits.tsv.bgz', 'nfr/values.tsv.bgz', 'nfr/variants.tsv.bgz', 'nfr/states.tsv.bgz')


@pytest.fixture(scope='module')
def bams(tmp_path_factory):
    d = tmp_path_factory.mktemp('parity')
    a = multi_locus_daf_bam(d / 'a.bam', seed=3, contig=CONTIG, length=LENGTH)
    b = multi_locus_daf_bam(d / 'b.bam', seed=11, contig=CONTIG, length=LENGTH)
    return a, b


def _canonical(paths):
    from services.scan.identity import content_id
    return sorted(paths, key=content_id)


def _cli(out: Path, paths, *, modules='fp,nfr', extra=(), params=NFR_PARAMS, where=('--genome', '--contigs', CONTIG)):
    from fiberhmm.scan.cli import main
    argv = [x for p in _canonical(paths) for x in ('--bam', p)] + list(where) + ['--modules', modules, '--no-annotate',
                                                                                 '--cores', '2', '-o', str(out)]
    if params:
        pfile = out.parent / (out.name + '.params.json')
        pfile.write_text(json.dumps({k: v for k, v in params.items() if k in modules.split(',')}))
        argv += ['--parameters', str(pfile)]
    argv += list(extra)
    with redirect_stdout(io.StringIO()):
        assert main(argv) == 0
    return out


@pytest.fixture(scope='module')
def cli_uncapped(bams, tmp_path_factory):
    return _cli(tmp_path_factory.mktemp('cli') / 'uncapped', bams)


@pytest.fixture(scope='module')
def cli_capped(bams, tmp_path_factory):
    return _cli(tmp_path_factory.mktemp('cli') / 'capped', bams,
                extra=('--max-discovery-molecules', '15', '--max-quantification-molecules', '15'))


def _rows(path: Path):
    if not path.is_file():
        return None
    with gzip.open(path, 'rt') as handle:
        return [line.rstrip('\n') for line in handle]


def _state(bams):
    from models.domain import Dataset
    st = NS(datasets={}, chroms=[NS(name=CONTIG, size=LENGTH)], performance={'effective': 'standard'})
    for i, p in enumerate(bams):
        ds = Dataset(f'ds{i}', p, label=f'DS{i}')
        st.datasets[ds.id] = ds
    return st


@pytest.fixture
def cache(tmp_path, monkeypatch):
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    return tmp_path / 'cache'


def _scan(st, *, start=0, end=LENGTH, modules=('fp', 'nfr'), workers=1, caps=None, params=NFR_PARAMS, runner=None):
    from services.scan import jobs
    req = dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=start, end=end, modules=list(modules),
               workers=workers, parameters={k: v for k, v in (params or {}).items() if k in modules})
    if caps:
        req['caps'] = caps
    job = jobs.submit(st, req, runner=runner)
    done = jobs.wait(st, job['job_id'], timeout=900)
    assert done['status'] == 'complete', done
    return done


def _cache_dir(st, module):
    from services.scan.registry import list_scans
    for s in list_scans(st):
        if s.source == 'cache' and module in (s.manifest.get('modules') or {}):
            return s.path
    raise AssertionError(f'no cache scan for {module}')


def _assert_same_rows(browser: dict, cli: Path, tables=TABLES):
    for rel in tables:
        module = rel.split('/')[0]
        # Both runs must have written the table (a missing pair would compare None with None).
        assert (cli / rel).is_file() and (browser[module] / rel).is_file(), f'{rel}: not written'
        got = _rows(browser[module] / rel)
        want = _rows(cli / rel)
        assert got == want, f'{rel}: browser and CLI rows differ'


def test_full_view_equals_cli_uncapped_1_worker(bams, cli_uncapped, cache):
    st = _state(bams)
    job = _scan(st, workers=1)
    dirs = {m: _cache_dir(st, m) for m in ('fp', 'nfr')}
    _assert_same_rows(dirs, cli_uncapped)
    assert any(_rows(cli_uncapped / 'fp/hits.tsv.bgz')[1:]), 'the fixture must yield footprint classes'
    assert any(_rows(cli_uncapped / 'nfr/hits.tsv.bgz')[1:]), 'the fixture must yield NFRs'
    assert len(_rows(cli_uncapped / 'nfr/variants.tsv.bgz')) > 1, 'the fixture must yield NFR variants'
    assert len(_rows(cli_uncapped / 'nfr/states.tsv.bgz')) > 1 and len(_rows(cli_uncapped / 'fp/states.tsv.bgz')) > 1
    assert job['computed_units'] > 0
    # Same units as the genome scan of the contig: the same scan key (dataset order, labels, policy, settings).
    for m in ('fp', 'nfr'):
        mine = json.loads((dirs[m] / 'manifest.json').read_text())
        assert mine['units']['mode'] == 'grid' and mine['units']['contigs'] == [CONTIG]
        assert mine['read_policy'] == json.loads((cli_uncapped / 'manifest.json').read_text())['read_policy']
        assert mine['modules'][m]['settings_hash'] == json.loads((cli_uncapped / 'manifest.json').read_text())['modules'][m]['settings_hash']


def test_full_view_equals_cli_4_workers(bams, cli_uncapped, cache):
    st = _state(bams)
    _scan(st, workers=4)
    _assert_same_rows({m: _cache_dir(st, m) for m in ('fp', 'nfr')}, cli_uncapped)


def test_capped_equals_cli_capped(bams, cli_capped, cli_uncapped, cache):
    st = _state(bams)
    _scan(st, caps={'max_discovery_molecules': 15, 'max_quantification_molecules': 15})
    dirs = {m: _cache_dir(st, m) for m in ('fp', 'nfr')}
    _assert_same_rows(dirs, cli_capped)
    # and the caps changed something (else the capped gate tests nothing)
    assert _rows(cli_capped / 'fp/states.tsv.bgz') != _rows(cli_uncapped / 'fp/states.tsv.bgz')


def test_module_subset_gives_the_same_rows(bams, cli_uncapped, cache):
    st = _state(bams)
    _scan(st, modules=('fp',))
    _assert_same_rows({'fp': _cache_dir(st, 'fp')}, cli_uncapped, tables=[t for t in TABLES if t.startswith('fp/')])


def test_incremental_scans_reuse_units_and_equal_cli(bams, cli_uncapped, cache):
    st = _state(bams)
    first = _scan(st, start=0, end=40_000)
    second = _scan(st, start=40_000, end=LENGTH)
    total = len(json.loads((Path(_cache_dir(st, 'fp')).with_suffix('.plan.json')).read_text())['units'])
    # Each unit is computed once per module: the second scan reuses the first one's units.
    assert second['coverage']['fp']['cached'] == first['computed_units'] // 2 > 0
    assert first['computed_units'] + second['computed_units'] == 2 * total
    _assert_same_rows({m: _cache_dir(st, m) for m in ('fp', 'nfr')}, cli_uncapped)


def test_partial_view_inner_zones_equal_cli(bams, cli_uncapped, cache):
    """A view's own zones (not the extra unit on each side, whose outer seam is open) give the CLI's rows."""
    from services.scan.tables import iter_rows
    st = _state(bams)
    _scan(st, start=30_000, end=80_000)
    for m in ('fp', 'nfr'):
        d = _cache_dir(st, m)
        inner = [(u['zone_start'], u['zone_end']) for u in iter_rows(d / 'units.tsv.bgz')][1:-1]
        assert inner
        def owned(rows):
            return sorted(r['hit_id'] for r in rows if any(a <= int(r['anchor']) < b for a, b in inner))
        got = owned(iter_rows(d / f'{m}/hits.tsv.bgz'))
        want = owned(iter_rows(cli_uncapped / f'{m}/hits.tsv.bgz'))
        assert got == want and got, m


def test_the_view_cli_line_computes_the_browsers_rows(bams, cache, tmp_path):
    """The dialog's command line for a view (--genome --zones, CONTRACTS v1.9) run as it is gives the browser's rows,
    the edge units' seams included."""
    from services.scan import planning
    st = _state(bams)
    plan = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=40_000,
                                        end=70_000, modules=['fp', 'nfr'], parameters=NFR_PARAMS))
    args = plan['cli']['args']
    zones = args[args.index('--zones') + 1]
    assert zones == f"{CONTIG}:{plan['units'][0]['zone_start']}-{plan['units'][-1]['zone_end']}"
    cli = _cli(tmp_path / 'zones', bams, where=('--genome', '--zones', zones))
    _scan(st, start=40_000, end=70_000)
    _assert_same_rows({m: _cache_dir(st, m) for m in ('fp', 'nfr')}, cli)


def test_precomputed_units_skip_compute(bams, cli_uncapped, cache):
    from services.scan import registry, planning
    st = _state(bams)
    scan = registry.open_scan(st, cli_uncapped)
    assert all(b['status'] == 'bound' for b in scan.bindings.values())
    plan = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=20_000,
                                        end=60_000, modules=['fp', 'nfr'], parameters=NFR_PARAMS))
    for m in ('fp', 'nfr'):
        assert plan['coverage'][m]['to_compute'] == [] and len(plan['coverage'][m]['precomputed']) == len(plan['units'])
    calls = []
    job = _scan(st, start=20_000, end=60_000, runner=lambda *a, **k: calls.append(a))
    assert calls == [] and job['computed_units'] == 0
    assert job['coverage']['fp']['precomputed'] == len(plan['units'])
    # The CLI line lists the BAMs in canonical order, the same units (the contig's grid) and the same settings.
    assert plan['cli']['args'][:5] == ['fiberhmm-scan', '--bam', _canonical(bams)[0], '--bam', _canonical(bams)[1]] or \
        plan['cli']['text'].startswith('fiberhmm-scan --bam')
    # The view's genome-grid units exactly (fiberhmm-scan --zones, CONTRACTS v1.9): its first zone start to its last
    # zone end.
    zones = f"--genome --zones chrT:{plan['units'][0]['zone_start']}-{plan['units'][-1]['zone_end']}"
    assert zones in plan['cli']['text'] and '--no-annotate' in plan['cli']['text']


def test_cancel_stops_a_scan(bams, cache):
    from services.scan import jobs
    st = _state(bams)
    started = threading.Event()

    def slow(*_a, cancel=None, **_k):
        started.set()
        for _ in range(200):
            if cancel.is_set():
                raise KeyboardInterrupt('scan cancelled')
            time.sleep(0.05)
        raise AssertionError('not cancelled')

    job = jobs.submit(st, dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=0, end=30_000,
                               modules=['fp'], workers=1), runner=slow)
    assert started.wait(30)
    assert jobs.cancel(st, job['job_id'])['status'] == 'cancelling'
    assert jobs.wait(st, job['job_id'], timeout=60)['status'] == 'cancelled'
    # A second scan may start once the first has stopped.
    with pytest.raises(ValueError, match='Choose at least one module'):
        jobs.submit(st, dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=0, end=30_000, modules=[]))


def test_peaks_use_the_local_rare_rule_outside_grid_scans(bams, cache, tmp_path):
    """Owner decision (26 Oct): browser peaks use the local Rare rule and count every record; BED-like scopes set it
    (FiberHMM's 'auto' would pick the window rule there), grid scans get it from 'auto'. The window rule stays
    reachable as a setting."""
    from services.scan import planning
    st = _state(bams)
    bed = tmp_path / 'units.bed'
    bed.write_text(f'{CONTIG}\t20000\t30000\tlocus\n')
    plan = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='bed', bed=str(bed), modules=['peaks']))
    assert plan['parameters']['peaks'] == {'tier_rule': 'local', 'row_rule': 'records'}
    assert '--parameters scan_parameters.json' in plan['cli']['text'] and plan['cli']['parameters']['peaks']['tier_rule'] == 'local'
    window = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='bed', bed=str(bed), modules=['peaks'],
                                          parameters={'peaks': {'tier_rule': 'window', 'row_rule': 'view'}}))
    assert window['parameters']['peaks'] == {'tier_rule': 'window', 'row_rule': 'view'}
    grid = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=20000, end=30000,
                                        modules=['peaks']))
    assert 'peaks' not in grid['parameters']   # 'auto' = local + records on grid units, as the CLI's genome scan


def test_plan_read_policy_from_settings_and_grouped_datasets(bams, cache):
    """The settings' read_policy reaches the plan (the dialog's caps on top, as cap flags over a parameter file), and
    a dataset of several BAMs is written with --datasets on the command line (repeated --bam would split it)."""
    from models.domain import Dataset
    from services.scan import planning
    st = _state(bams)
    plan = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='view', chrom=CONTIG, start=20000, end=30000,
                                        modules=['fp'], caps={'max_discovery_molecules': 9},
                                        parameters={'read_policy': {'filters': {'min_mapq': 60}, 'caps': {'sample_seed': 47, 'max_discovery_molecules': 3}}}))
    assert plan['read_policy']['filters']['min_mapq'] == 60
    assert plan['read_policy']['caps'] == {'max_discovery_molecules': 9, 'max_quantification_molecules': 0, 'sample_seed': 47}
    assert 'read_policy' not in plan['parameters'] and plan['cli']['parameters']['read_policy'] == {'filters': {'min_mapq': 60}}
    assert '--max-discovery-molecules 9' in plan['cli']['text'] and '--sample-seed 47' in plan['cli']['text']
    st.datasets = {'both': Dataset('both', list(bams), label='Both')}
    grouped = planning.build_plan(st, dict(datasets=['both'], scope='view', chrom=CONTIG, start=20000, end=30000, modules=['fp']))
    assert '--datasets scan_datasets.json' in grouped['cli']['text'] and '--bam' not in grouped['cli']['text']
    assert grouped['cli']['datasets'] == [{'dataset_id': 'dataset_1', 'paths': [planning._home_short(p) for p in bams]}]


def test_a_partial_open_scan_does_not_make_units_precomputed(bams, cli_uncapped, tmp_path, monkeypatch):
    """Precomputed is all or nothing, and only from a scan that also computed every unit's grid neighbours (so it
    reconciled each seam as a full run does): a browser cache of [0, 40 kb) opened from disk doesn't cover a view
    at [40, 140 kb); the genome scan does."""
    from services.scan import registry, planning
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'first'))
    st = _state(bams)
    _scan(st, start=0, end=40_000)
    partial_dir = _cache_dir(st, 'fp')
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'second'))
    st2 = _state(bams)
    registry.open_scan(st2, partial_dir)
    req = dict(datasets=sorted(st2.datasets), scope='view', chrom=CONTIG, start=40_000, end=LENGTH, modules=['fp'],
               parameters={})
    plan = planning.build_plan(st2, req)
    assert plan['coverage']['fp']['precomputed'] == {} and plan['coverage']['fp']['to_compute']
    registry.open_scan(st2, cli_uncapped)
    plan = planning.build_plan(st2, req)
    assert len(plan['coverage']['fp']['precomputed']) == len(plan['units'])


def test_union_of_views_on_two_contigs_is_a_genome_plan_order():
    from fiberhmm.scan.units import plan
    from services.scan.planning import union_units
    reference = {'chr1': 75_000, 'chr2': 75_000}
    units, _ = plan(reference, genome=True)
    chr2 = [u for u in units if u.chrom == 'chr2'][:2]
    chr1 = [u for u in units if u.chrom == 'chr1'][1:]
    merged = union_units(union_units([], chr2, {'chr1': 0, 'chr2': 1}), chr1, {'chr1': 0, 'chr2': 1})
    assert [(u.chrom, u.zone_start) for u in merged] == [('chr1', 25_000), ('chr1', 50_000), ('chr2', 0), ('chr2', 25_000)]
    assert [u.index for u in merged] == [0, 1, 2, 3]


def test_bed_scope_peaks_run_with_the_local_rule(bams, cache, tmp_path):
    """The owner's peaks decision, executed: a BED scan with peaks runs through run_units with the local Rare rule
    and every record (its calibration says so), as the CLI given the same --parameters."""
    from services.scan import jobs
    st = _state(bams)
    bed = tmp_path / 'units.bed'
    bed.write_text(f'{CONTIG}\t20000\t30000\tlocus\n')
    job = jobs.submit(st, dict(datasets=sorted(st.datasets), scope='bed', bed=str(bed), modules=['peaks'], workers=1))
    done = jobs.wait(st, job['job_id'], timeout=600)
    assert done['status'] == 'complete', done
    d = _cache_dir(st, 'peaks')
    cal = json.loads((d / 'peaks' / 'extra' / 'calibration.json').read_text())
    assert (cal['tier_rule'], cal['row_rule']) == ('local', 'records')
    cli = _cli(tmp_path / 'cli_bed', bams, modules='peaks', where=('--bed', str(bed)),
               params={'peaks': {'tier_rule': 'local', 'row_rule': 'records'}})
    for rel in ('peaks/hits.tsv.bgz', 'peaks/values.tsv.bgz'):
        assert (cli / rel).is_file() == (d / rel).is_file()
        if (cli / rel).is_file():
            assert _rows(d / rel) == _rows(cli / rel), rel


def test_genes_scope_plans_tss_units_on_the_bams_contig_names(bams, cache):
    """Genes: TSS +/- 5 kb BED units, with the annotation's contig name mapped to the BAM's (here 'T' -> 'chrT')."""
    import pandas as pd
    from services.scan import planning
    st = _state(bams)
    st.gtf_data = {'transcripts': pd.DataFrame([dict(gene_name='GENEA', transcript_id='t1', chrom='T', start=24_000, end=30_000, strand='+'),
                                                dict(gene_name='GENEB', transcript_id='t2', chrom='T', start=70_000, end=80_000, strand='-')])}
    plan = planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='genes', genes=['GENEA', 'GENEB'], modules=['fp']))
    assert [(u['chrom'], u['start'], u['end']) for u in plan['units']] == [(CONTIG, 19_000, 29_000), (CONTIG, 74_999, 84_999)]
    assert '--bed' in plan['cli']['text']
    with pytest.raises(planning.ScanPlanError, match='Not in the loaded gene annotation'):
        planning.build_plan(st, dict(datasets=sorted(st.datasets), scope='genes', genes=['NOPE'], modules=['fp']))
