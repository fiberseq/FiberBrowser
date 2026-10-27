"""Nucleosome panel backend: regressions for the Codex round-1 group A findings.

- A browser dataset holding two scan datasets' files uses each file's own calibration record.
- Read ids keep their provenance (a lift-record key names its molecule and record, not every library's copy).
- Summaries are measured in molecular bases (a deletion never inflates a segment), one record per mol:v1 molecule.
- A file recomputed by another dataset under other settings leaves the first dataset without live outputs there.
- Live layers win over a record's own (possibly stale) groups.
- A cancelled job refreshes what it wrote.
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
SETTINGS = {'calibration': 'self', 'calibration_population': 400}


@pytest.fixture(autouse=True)
def fresh_store(tmp_path, monkeypatch):
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    yield
    STORE.clear()


@pytest.fixture(scope='module')
def two_bams(tmp_path_factory):
    d = tmp_path_factory.mktemp('nuc_two')
    return (chromatin_bam(d / 'a.bam', contig=CONTIG, length=LENGTH, seed=21),
            chromatin_bam(d / 'b.bam', contig=CONTIG, length=LENGTH, seed=33, step=1100))


def _state(*datasets):
    return NS(datasets={d.id: d for d in datasets}, chroms=[NS(name=CONTIG, size=LENGTH)],
              performance={'effective': 'standard'})


def _job(st, ds_ids, start, end, params=SETTINGS, **extra):
    from services.nuc import jobs
    job = jobs.submit(st, dict(datasets=ds_ids, chrom=CONTIG, start=start, end=end, parameters=params, workers=2, **extra))
    return jobs.wait(st, job['job_id'], timeout=900)


def test_a_merged_dataset_uses_each_files_own_calibration(two_bams, tmp_path):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    from models.domain import Dataset
    from services.nuc.jobs import active_config
    from services.nuc.loaded import scan_rows
    from services.nuc.store import STORE
    from services.scan.registry import open_scan
    a, b = two_bams
    out = tmp_path / 'scan'
    run_units([{'dataset_id': 'dataset_1', 'paths': [a]}, {'dataset_id': 'dataset_2', 'paths': [b]}],
              plan({CONTIG: LENGTH}, genome=True, contigs=[CONTIG]), modules=['nuc'], params={'nuc': SETTINGS},
              out=out, annotate=False, cores=2)
    merged = Dataset('merged', [a, b], label='A + B')
    st = _state(merged)
    scan = open_scan(st, out)
    assert {x['status'] for x in scan.bindings.values()} == {'bound'}
    done = _job(st, ['merged'], 40_000, 60_000)
    assert done['status'] == 'complete', done
    cfg = active_config(st, 'merged')
    assert len({c.digest for c in cfg.calibrations.values()}) == 2
    loaded = scan_rows(scan, 'merged', CONTIG, 40_000, 60_000)
    live = {(str(Path(p).resolve()), *k): v for p in (a, b) for k, v in STORE.rows_of(p).items()}
    shared = set(loaded) & set(live)
    assert {k[0] for k in shared} == {str(Path(a).resolve()), str(Path(b).resolve())}
    for key in shared:
        assert {g: sorted(m) for g, m in loaded[key].groups.items()} == {g: sorted(m) for g, m in live[key].groups.items()}
        assert loaded[key].scalars == live[key].scalars


def test_read_ids_keep_their_provenance():
    from services.nuc.live import Rec
    from services.nuc.observations import _ReadIds
    a = Rec('/x/a.bam', 's1', 0, 'm1/5/ccs', None, False, (), 'mol-A')
    b = Rec('/x/b.bam', 's1', 0, 'm1/5/ccs', None, False, (), 'mol-B')
    named = _ReadIds(['lift-record:v1 ["mol-A","m1/5/ccs","s1:0"]'])
    assert named.match(a) and not named.match(b)
    folded = _ReadIds(['lift-record:v1 ["mol-B","m1/5/ccs",null]'])
    assert folded.match(b) and not folded.match(a)
    plain = _ReadIds(['m1/5/ccs'])
    assert plain.match(a) and plain.match(b)


def test_molecular_windows_skip_deleted_reference_bases():
    from services.nuc.live import mol_window
    from services.nuc.observations import summarize_rows
    from services.nuc.store import RecordOutputs

    class R:
        reference_start, is_reverse, query_length = 1000, False, 400
        cigartuples = [(0, 200), (2, 2000), (0, 200)]      # 200 M, a 2 kb deletion, 200 M
    # The window covers the whole alignment: 400 molecular bases, not 2,400.
    assert mol_window(R, 1000, 3400) == (0, 400)
    R.is_reverse = True
    assert mol_window(R, 1000, 1100) == (300, 400)
    row = RecordOutputs('q', 0, CONTIG, 1000, 3400, False, False, None,
                        {'nucsz': [], 'nucseg': [(0, 200, 1000, 1200, (1, 255, 90), 'a'),
                                                 (200, 200, 3200, 3400, (2, 255, 0), 'b')]}, [], {}, 'live')
    seg = summarize_rows([(row, ((0, 400),))])['segments']
    assert seg['regular'] == 0.5 and seg['disordered'] == 0.5


def test_one_record_per_molecule():
    from services.nuc.observations import _molecule_key
    assert _molecule_key('m84046_1/1234/ccs/fwd') == _molecule_key('m84046_1/1234/ccs/rev')
    assert _molecule_key('m84046_1/1234/ccs') != _molecule_key('m84046_1/1235/ccs')


def test_a_file_recomputed_under_other_settings_leaves_the_first_dataset_without_live_rows(two_bams):
    from models.domain import Dataset
    from services.nuc.jobs import active_config
    from services.nuc.observations import summarize
    a, _b = two_bams
    st = _state(Dataset('one', a, label='One'), Dataset('two', a, label='Two'))
    assert _job(st, ['one'], 40_000, 50_000)['status'] == 'complete'
    obs = [dict(obsId='o', datasetId='one', chrom=CONTIG, start=40_000, end=50_000)]
    assert summarize(st, obs)['observations'][0]['computed'] > 5
    assert _job(st, ['two'], 40_000, 50_000, params={**SETTINGS, 'calibration_population': 300})['status'] == 'complete'
    assert active_config(st, 'one') is None
    first = summarize(st, obs)['observations'][0]
    assert first['computed'] == 0 and first['calibration'] is None


def test_live_layers_replace_a_records_own_groups(two_bams):
    from models.domain import Dataset
    from services.nuc.layers import injector
    from services.nuc.store import STORE
    a, _b = two_bams
    st = _state(Dataset('one', a, label='One'))
    assert _job(st, ['one'], 40_000, 50_000)['status'] == 'complete'
    key, row = next(iter(STORE.rows_of(a).items()))
    inject = injector(a, 40_000, 50_000, include_layers=True, requested_layers=None, include_qualities=True,
                      include_lift_meta=False)
    read = {'record_sha256': key[0], 'alignment_occurrence': key[1], 'layers': {'nucsz': {'intervals': [[0, 1, 1]]}}}
    inject(read)
    assert read['layers']['nucsz'].get('nuc_live') is True and read['layers']['nucsz']['intervals'] != [[0, 1, 1]]
    assert read['_fiberbrowser_scalars']['nuc.nrl'] == row.scalars['nrl']


def test_a_cancelled_job_refreshes_what_it_wrote(two_bams, monkeypatch):
    from models.domain import Dataset
    from services.nuc import jobs, live
    from services.nuc.store import STORE
    a, _b = two_bams
    st = _state(Dataset('one', a, label='One'))
    real = live.compute_regions

    def stop_after_one_batch(source, regions, settings, cals, policy, **kw):
        cancel = kw['cancel']

        def progress(records, computed):
            if computed >= 3:
                cancel.set()
        return real(source, regions, settings, cals, policy, progress=progress, cancel=cancel)
    monkeypatch.setattr(live, 'compute_regions', stop_after_one_batch)
    done = _job(st, ['one'], 0, LENGTH)
    assert done['status'] == 'cancelled'
    assert done['results']['one']['complete'] is False and done['results']['one']['datasets'] == ['one']
    assert STORE.has_rows(a) and st.datasets['one'].derived_layers['nucsz']['kind'] == 'nuc-live'


def test_graph_rows_carry_classes_on_call_pieces_and_a_segment_lane():
    from services.graph_panel.reads import _nuc_classes, clip_to_windows, marks_of
    layers = {'nucsz': {'intervals': [[100, 247, 147], [300, 330, 30]], 'quality_names': ['coarse', 'named', 'posterior', 'z'],
                        'qualities': [[2, 17], [0, 0], [230, 200], [128, 255]]},
              'nucseg': {'intervals': [[90, 900, 810], [400, 520, 120]], 'quality_names': ['code', 'posterior_or_llr10', 'q_hat_minus_100_or_count'],
                         'qualities': [[1, 17], [200, 45], [90, 3]]}}
    out = {'nuc': {'iv': [[1100, 1170, 147], [1170, 1247, 147]], 'id': [None, None], 'part': [None, None]},
           'tf': {'iv': [[1300, 1330, 30]], 'id': [None], 'part': [None]}}
    _nuc_classes(out, layers, 1000, lambda a, b: True)
    assert out['nuc']['cls'] == [2, 2] and out['nuc']['zb'] == [128, 128]      # both pieces of a split footprint
    assert out['tf']['cls'] == [17] and out['tf']['zb'] == [255]
    assert out['nseg'] == {'iv': [[1090, 1900, 810], [1400, 1520, 120]], 'code': [1, 17], 'p': [200, 45], 'q3': [90, 3]}
    clipped = clip_to_windows(out, [[1350, 1450]])
    assert clipped['nseg']['iv'] == [[1090, 1900, 810], [1400, 1520, 120]] and 'tf' not in clipped
    assert marks_of(out) == 5


def test_graph_call_never_takes_an_overlapping_footprints_class():
    """A nucleosome [100, 247) whose midpoint falls inside a TF mark [170, 190) keeps its own mono class; a TF piece
    keeps its own; a span shared by two marks with other bytes gives no class."""
    from services.graph_panel.reads import _nuc_classes
    layers = {'nucsz': {'intervals': [[100, 247, 147], [170, 190, 20]], 'quality_names': ['coarse', 'named', 'posterior', 'z'],
                        'qualities': [[2, 17], [0, 0], [230, 200], [128, 40]]}}
    out = {'nuc': {'iv': [[100, 247, 147]], 'id': [None], 'part': [None]},
           'tf': {'iv': [[170, 190, 20]], 'id': [None], 'part': [None]}}
    _nuc_classes(out, layers, 0, lambda a, b: True)
    assert out['nuc']['cls'] == [2] and out['nuc']['zb'] == [128]
    assert out['tf']['cls'] == [17] and out['tf']['zb'] == [40]
    # A piece of the split nucleosome around the TF (same molecular length) still finds it.
    out = {'nuc': {'iv': [[150, 200, 147]], 'id': [None], 'part': [None]}}
    _nuc_classes(out, layers, 0, lambda a, b: True)
    assert out['nuc']['cls'] == [2]
    # No length, two marks with different bytes over the midpoint: no class rather than the wrong one.
    out = {'nuc': {'iv': [[175, 185, None]], 'id': [None], 'part': [None]}}
    _nuc_classes(out, layers, 0, lambda a, b: True)
    assert 'cls' not in out['nuc']


def test_an_empty_live_group_still_keeps_scan_marks_out(two_bams, tmp_path):
    """Codex A2-r1: a live configuration that gives a record no segment must not let a scan's older marks back."""
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    from models.domain import Dataset
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.scan.overlay import apply_scan_overlays
    from services.scan.registry import open_scan
    a, _b = two_bams
    out = tmp_path / 'scan'
    run_units([{'dataset_id': 'dataset_1', 'paths': [a]}], plan({CONTIG: LENGTH}, genome=True, contigs=[CONTIG]),
              modules=['nuc'], params={'nuc': SETTINGS}, out=out, annotate=False, cores=2)
    st = _state(Dataset('one', a, label='One'))
    open_scan(st, out)
    rows = build_compact_reads_from_bam(a, CONTIG, 40_000, 50_000, spanning_only=False, include_layers=True)
    assert any('nucseg' in (r.get('layers') or {}) for r in apply_scan_overlays(st, 'one', CONTIG, 40_000, 50_000, rows))
    # Live outputs with molecules too short to segment: no nucseg rows at all.
    no_segments = {**SETTINGS, 'params': {'seg_min_molecule_bp': 1_000_000}}
    assert _job(st, ['one'], 40_000, 50_000, params=no_segments)['status'] == 'complete'
    rows = build_compact_reads_from_bam(a, CONTIG, 40_000, 50_000, spanning_only=False, include_layers=True)
    live = [r for r in rows if r.get('nuc_live')]
    assert live and not any('nucseg' in (r.get('layers') or {}) for r in live)
    overlaid = apply_scan_overlays(st, 'one', CONTIG, 40_000, 50_000, rows)
    assert not any('nucseg' in (r.get('layers') or {}) for r in overlaid if r.get('nuc_live'))


def test_graph_records_carry_provenance_molecule_keys(two_bams):
    from services.lift.joint import molecule_key
    from services.nuc.live import Rec
    from services.nuc.observations import _ReadIds, _with_molecule_keys
    a, _b = two_bams

    class Settings:
        def molecule_group_map(self, paths, dataset_id):
            return {p: f'{dataset_id}#{i}' for i, p in enumerate(paths)}
    ds = NS(id='lifted', paths=[a], live_lift=NS(settings=Settings()))
    st = NS(datasets={'lifted': ds})
    source = NS(browser_id='lifted', paths=(str(Path(a).resolve()),))
    recs = _with_molecule_keys(st, source, [Rec(str(Path(a).resolve()), 's1', 0, 'm1/7/ccs', None, False, ())])
    assert recs[0].molecule == molecule_key('lifted#0', 'm1/7/ccs')
    assert _ReadIds([f'lift-record:v1 ["{recs[0].molecule}","m1/7/ccs","s1:0"]']).match(recs[0])


def test_contig_aliases_compute_and_resolve(two_bams):
    from models.domain import Dataset
    from services.nuc.observations import summarize
    a, _b = two_bams
    st = _state(Dataset('one', a, label='One'))
    done = _job(st, ['one'], 40_000, 50_000, )
    assert done['results']['one']['computed'] > 5
    from services.nuc.store import STORE
    STORE.clear()
    from services.nuc import jobs
    job = jobs.submit(st, dict(datasets=['one'], chrom='S', start=40_000, end=50_000, parameters=SETTINGS, workers=2))
    alias = jobs.wait(st, job['job_id'], timeout=900)
    assert alias['results']['one']['computed'] == done['results']['one']['computed']
    obs = summarize(st, [dict(obsId='o', datasetId='one', chrom='S', start=40_000, end=50_000)])['observations'][0]
    assert obs['computed'] > 5 and obs['segments']['bp'] > 0


def test_scan_overlay_joins_rows_by_file(two_bams, tmp_path):
    """Codex A2-r2: an identical record in two files of a merged dataset gets its own file's scalars and marks."""
    from services.scan.overlay import _with_scalars
    rows = [('nuc', {'record': 's:0', 'nrl': '190.0', '_file': '/x/a.bam'}),
            ('nuc', {'record': 's:0', 'nrl': '220.0', '_file': '/x/b.bam'})]
    read = {'id': 'q', 'record_sha256': 's', 'alignment_occurrence': 0, 'library_id': '/x/b.bam'}
    assert _with_scalars(read, rows)['_fiberbrowser_scalars']['nuc.nrl'] == 220.0


def test_annotated_nuc_marks_inside_an_insertion_keep_the_nearest_aligned_base():
    """Codex A3-1: the MA parser keeps nucsz/nucseg marks with no aligned base, as the scan's zero-width envelope."""
    from models.domain import CigarCoordMapper
    from services.bam_tags import parse_ma_aq_tags_into_layers
    mapper = CigarCoordMapper([(0, 1000), (1, 1000), (0, 2000)], 5000)   # 1000 M, a 1 kb insertion, 2000 M
    ma = '4000;nucsz.QQQQ:101-147,1201-147,2101-147'      # before, inside, after the insertion
    aq = [2, 0, 230, 128] * 3
    layers = parse_ma_aq_tags_into_layers(ma, aq, mapper, 4000, 9000, an_str='nucsz@d_0,nucsz@d_1,nucsz@d_2',
                                          tags_are_molecular=True)
    ivs = layers['nucsz']['intervals']
    assert len(ivs) == 3 and ivs[1][1] - ivs[1][0] == 1
    assert ivs[1][0] in (5999 - 4000, 6000 - 4000)       # the insertion's flanking aligned bases
    assert layers['nucsz']['annotation_names'] == ['nucsz@d_0', 'nucsz@d_1', 'nucsz@d_2']
    other = parse_ma_aq_tags_into_layers('4000;tf.QQQ:1201-30', [1, 2, 3], mapper, 4000, 9000)
    assert 'tf' not in other            # other groups keep the old rule


def test_window_metrics_use_the_molecules_contig_name():
    from services.nuc.observations import frame_chrom
    mols = [NS(chrom='1'), NS(chrom='1')]
    assert frame_chrom(mols, 'chr1') == '1' and frame_chrom(mols, '1') == '1' and frame_chrom([], 'chr1') == 'chr1'


def test_lifted_compute_covers_the_graph_hull(monkeypatch):
    """Codex A3-2: a live-lift view also computes each source contig's piece hull (a graph column's span)."""
    import services.nuc.observations as obs_mod
    from services.nuc import live
    monkeypatch.setattr(obs_mod, 'source_windows', lambda *a, **k: [('c', 0, 1000), ('c', 101_000, 102_000)])

    class Plan:
        contigs = [NS(contig='c', windows=[(0, 1000), (101_000, 102_000)])]
    import services.lift.live_lift as ll
    monkeypatch.setattr(ll, 'select_pieces', lambda *a, **k: None)
    monkeypatch.setattr(ll, 'plan_fetch', lambda *a, **k: Plan)
    monkeypatch.setattr(ll, 'lift_key', lambda *a, **k: 'k')
    handle = NS(map=NS(targets={'chrT'}), resolve_haplotypes=lambda h: h)
    st = NS(datasets={'d': NS(live_lift=NS(handle=handle, haplotypes=['H#1'], settings=None))})
    regions = live.source_regions(st, NS(kind='lifted', browser_id='d'), 'chrT', 0, 5000)
    assert ('c', 0, 102_000) in regions
