"""Nucleosome panel P-G / feature hub H3: layers and molecule metrics as Filter/Sort terms, cluster modes and
columns, Read Stats columns, and the tables-mode overlay before quality filters.

H3 gate (feature hub DESIGN §13): the filter "regular array ∧ NRL 185–195" returns the same molecules as the scan
rows — through a tables-mode scan's overlay and through live outputs.
"""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrS', 160_000
SETTINGS = {'calibration': 'self', 'calibration_population': 400}
VIEW = (40_000, 70_000)


@pytest.fixture(scope='module')
def bam(tmp_path_factory):
    return chromatin_bam(tmp_path_factory.mktemp('nuc_rules') / 'chromatin.bam', contig=CONTIG, length=LENGTH)


@pytest.fixture(scope='module')
def scan_dir(bam, tmp_path_factory):
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    out = tmp_path_factory.mktemp('nuc_rules_scan') / 'scan'
    run_units([{'dataset_id': 'dataset_1', 'paths': [bam]}], plan({CONTIG: LENGTH}, genome=True, contigs=[CONTIG]),
              modules=['nuc'], params={'nuc': SETTINGS}, out=out, annotate=False, cores=2)
    return out


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    yield
    STORE.clear()


def _state(bam):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    return st


def _filter(st, **kw):
    from models.requests import AnalysisFilterRequest
    from services.filtering_endpoint import filter_reads_by_analysis_rule_for_request
    req = AnalysisFilterRequest(dataset_ids=['ds0'], scope_windows=[list(VIEW)], **kw)
    out = filter_reads_by_analysis_rule_for_request(st, req, chrom=CONTIG, start=VIEW[0], end=VIEW[1])
    return set(out['results']['ds0']['read_ids'])


def _expected(scan, st):
    """Records with a regular segment in the view and an NRL in 185-195, from the scan's own rows."""
    from services.nuc.loaded import scan_rows
    out = set()
    for row in scan_rows(scan, 'ds0', CONTIG, *VIEW).values():
        regular = any(q[0] == 1 and a < VIEW[1] and b > VIEW[0] for _ms, _ml, a, b, q, _n in row.groups['nucseg'])
        nrl = row.scalars.get('nrl')
        if regular and nrl is not None and 185 <= nrl <= 195:
            out.add(row.qname)
    return out


REGULAR = dict(metric='count', operator='gte', threshold=1, layer='nucseg',
               rule=dict(size_min=0, size_max=None, conditions=[],
                         quality_gates=[dict(qualityName='code', minValue=1, maxValue=1)]))
NRL = dict(metric='value', operator='between', threshold=185, threshold_max=195, molecule_metric='nuc.nrl')


def test_h3_gate_regular_array_and_nrl_through_the_scan_overlay(bam, scan_dir):
    from services.scan.registry import open_scan
    st = _state(bam)
    scan = open_scan(st, scan_dir)
    regular, nrl = _filter(st, **REGULAR), _filter(st, **NRL)
    expected = _expected(scan, st)
    assert len(expected) >= 3
    assert regular & nrl == expected
    assert regular and nrl and (regular ^ nrl)   # each rule alone selects other reads too


def test_h3_gate_regular_array_and_nrl_through_live_outputs(bam, scan_dir):
    from services.nuc import jobs
    from services.scan.registry import close_scan, open_scan
    st = _state(bam)
    scan = open_scan(st, scan_dir)
    expected = _expected(scan, st)
    close_scan(st, scan.scan_id)
    job = jobs.submit(st, dict(datasets=['ds0'], chrom=CONTIG, start=VIEW[0] - 20_000, end=VIEW[1] + 20_000,
                               parameters=SETTINGS, workers=2))
    assert jobs.wait(st, job['job_id'], timeout=900)['status'] == 'complete'
    assert _filter(st, **REGULAR) & _filter(st, **NRL) == expected


def test_a_missing_metric_never_passes_and_sorts_last(bam, scan_dir):
    from models.requests import SortReadsRequest
    from services.filtering_endpoint import sort_reads_for_request
    from services.scan.registry import open_scan
    st = _state(bam)
    open_scan(st, scan_dir)
    everything = _filter(st, metric='value', operator='gte', threshold=-1e9, molecule_metric='nuc.nrl')
    req = SortReadsRequest(dataset_ids=['ds0'], sort_by='value', molecule_metric='nuc.nrl', descending=True)
    order = sort_reads_for_request(st, req, chrom=CONTIG, start=VIEW[0], end=VIEW[1])['results']['ds0']['read_sort_order']
    ranked = [rid for rid in order if rid in everything]
    assert order[:len(ranked)] == ranked          # reads with an NRL first
    assert len(order) >= len(everything)


def test_overlay_layers_meet_quality_filters(bam, scan_dir):
    """agy A5: tables-mode overlay layers are on the rows before quality filters (and metaprofiles) see them."""
    from services.scan.registry import open_scan
    st = _state(bam)
    open_scan(st, scan_dir)
    st.set_quality_filters([dict(layer='nucsz', quality_name='posterior', min_value=250)])
    ws = st.build_working_set('ds0', CONTIG, *VIEW, include_layers=True)
    kept = [q for r in ws.reads for q in ((r.get('layers') or {}).get('nucsz') or {}).get('qualities', [[], [], []])[2]]
    assert kept and min(kept) >= 250


def test_cluster_nuc_modes_and_metric_columns():
    from services.clustering_features import _nuc_mode_intervals, class_aware_pattern_slices, extract_features_from_compact
    layers = {'nucsz': {'intervals': [[0, 147, 147], [200, 230, 30], [300, 450, 150]], 'qualities': [[2, 17, 3]]},
              'nucseg': {'intervals': [[0, 800, 800], [400, 520, 120]], 'qualities': [[1, 17]]}}
    assert _nuc_mode_intervals(layers, 'nuc.size.mono') == [(0, 147, 1.0)]
    assert _nuc_mode_intervals(layers, 'nuc.size.tf') == [(200, 230, 1.0)]
    assert _nuc_mode_intervals(layers, 'nuc.seg.regular') == [(0, 800, 1.0)]
    assert _nuc_mode_intervals(layers, 'nuc.event.missing') == [(400, 520, 1.0)]
    reads = [{'id': f'r{i}', 'intervals': [], '_fiberbrowser_scalars': {'nuc.nrl': v}} for i, v in enumerate([180.0, 190.0, None, 200.0])]
    rule = {'id': 'm', 'enabled': True, 'terms': [{'id': 't', 'source': 'molecule_metric', 'moleculeMetric': 'nuc.nrl'}]}
    X, ids, widths, modes = extract_features_from_compact(reads, [(0, 100)], 0, peak_modes=['cluster_rule:m'],
                                                          cluster_feature_rules=[rule])
    assert widths == [1] and [round(float(x), 3) for x in X[:, 0]] == [0.167, 0.5, 0.5, 0.833]
    assert class_aware_pattern_slices(widths, modes, [rule]) == [(0, 0, 1, True)]


def test_read_stats_carry_the_nucleosome_columns():
    from services.read_stats import nucleosome_columns
    cols = nucleosome_columns({'_fiberbrowser_scalars': {'nuc.nrl': 189.0, 'nuc.reg_fraction': 0.25}})
    assert cols['nrl'] == 189.0 and cols['reg_fraction'] == 0.25 and cols['n_missing'] is None
    assert all(v is None for v in nucleosome_columns(None).values())


def test_scalar_groups_decode_and_never_stay_a_layer():
    from services.nuc.scalars import decode_bytes, scalar_groups_to_fields
    read = {'layers': {'nfrmol': {'intervals': [[0, 1000, 1000]], 'qualities': [[125], [2], [1], [44]]}, 'nuc': {}}}
    scalar_groups_to_fields(read)
    assert 'nfrmol' not in read['layers'] and read['_fiberbrowser_scalars'] == {
        'nfr.openness': 0.5, 'nfr.n_nfr': 2.0, 'nfr.longest_linker': 300.0}
    assert decode_bytes('nfrmol', [255, 255, 255, 255]) == {'nfr.openness': None, 'nfr.n_nfr': None, 'nfr.longest_linker': None}
    assert decode_bytes('nucmol', [1, 2]) == {}


def test_correspondence_cluster_nuc_modes_read_the_nuc_groups():
    """Graph-path and matched-region windows load the groups a nucleosome mode reads."""
    from services.correspondence_clustering import mode_layer
    assert mode_layer('nuc.size.mono') == 'nucsz'
    assert mode_layer('nuc.seg.regular') == 'nucseg'
    assert mode_layer('nuc.event.missing') == 'nucseg'
    assert mode_layer('accessibility') == 'msp'
    assert mode_layer('tf_density') == 'tf'


def test_assigning_to_a_saved_model_ranks_metrics_against_the_fitted_cohort():
    """Codex C-4 class: new reads assigned to a saved correspondence model rank their molecule metrics against the
    cohort the model was fitted on (kept with the model), not against themselves."""
    from services.clustering_features import extract_features_grouped
    from services.correspondence_clustering import fitted_metric_cohort
    rule = {'id': 'm', 'enabled': True, 'terms': [{'id': 't', 'source': 'molecule_metric', 'moleculeMetric': 'nuc.nrl'}]}
    fitted = [{'id': f'f{i}', 'intervals': [], '_fiberbrowser_scalars': {'nuc.nrl': v}} for i, v in enumerate([170.0, 180.0, 190.0, 200.0, None])]
    cohort = fitted_metric_cohort(fitted, ['cluster_rule:m'], [rule])
    assert cohort == {'nuc.nrl': [170.0, 180.0, 190.0, 200.0]}
    assert fitted_metric_cohort(fitted, ['accessibility'], []) == {}
    # Two new reads both above the fitted median: alone they would split 0.25 / 0.75.
    new = [{'id': 'n0', 'intervals': [], '_fiberbrowser_scalars': {'nuc.nrl': 195.0}, '_cluster_group': 'w'},
           {'id': 'n1', 'intervals': [], '_fiberbrowser_scalars': {'nuc.nrl': 205.0}, '_cluster_group': 'w'}]
    groups = {'w': ([(0, 100)], 0, {})}
    alone, _ids, _w, _m = extract_features_grouped(new, [(0, 100)], 0, groups, peak_modes=['cluster_rule:m'], cluster_feature_rules=[rule])
    kept, _ids, _w, _m = extract_features_grouped(new, [(0, 100)], 0, groups, peak_modes=['cluster_rule:m'], cluster_feature_rules=[rule],
                                                  metric_cohort=cohort)
    assert [round(float(x), 3) for x in alone[:, 0]] == [0.25, 0.75]
    assert [round(float(x), 3) for x in kept[:, 0]] == [0.75, 1.0]
