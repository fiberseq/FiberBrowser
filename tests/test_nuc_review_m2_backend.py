"""Nucleosome M2 backend: regressions for the Codex M2 review, group C round 1.

- C-1: a quality-filtered scan mark stays filtered when the overlay runs again after the filters (the working set's
  second pass): the overlay's receipt is on the row itself, not on its (mutable) layers.
- C-3: a linked sort by a molecule metric or a hub-state count orders the pooled clusters by those values (missing
  values left out of the means, clusters with no value last), not by a fallback of zero.
- C-5: an annotated BAM's nucleosome groups are exposed (scalars, layers) only when FiberHMM reads them as current
  for the record's calls; stale or unsupported groups are dropped.
"""
from __future__ import annotations

import array
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')

from scan_fixtures import row, tiny_bam, write_scan_dir, write_table


# --- C-1: the post-filter overlay pass never restores rejected marks ---------------------------------------------

HIT = 'fp:class:chrT:1050:aaaaaaaa'
QFILTER = [dict(layer='fpcls', quality_name='q1', min_value=250)]


def _fpcls_scan(tmp_path, bam, record='r1:0', spans=((1000, 1100),)):
    """A tables-mode scan with fpcls member marks (the first 1000-1100) of posterior 0.502 (byte 128) on m1/1/ccs."""
    hits = [(a, b, HIT if k == 0 else f'fp:class:chrT:{(a + b) // 2}:{k:08x}', f'class_{k:03d}')
            for k, (a, b) in enumerate(spans)]
    d = write_scan_dir(tmp_path / 'scan', bam, hits=hits, states=[(h, a, b, 'm1/1/ccs', record, '1') for a, b, h, _l in hits])
    # The fixture's states table has no posterior column: write it with one.
    write_table(d / 'fp' / 'states.tsv.bgz', ['hit_id', 'dataset_id', 'qname', 'record', 'molecule', 'state', 'posterior'],
                [row('chrT', a, b, h, 'dataset_1', 'm1/1/ccs', record, 'mol:v1 0', '1', '0.502') for a, b, h, _l in hits],
                {'chrT': 0})
    return d


@pytest.fixture
def fp_bam(tmp_path):
    return tiny_bam(tmp_path / 'a.bam', reads=(('m1/1/ccs', 1000, 0), ('m1/2/ccs', 1100, 0)))


def test_c1_overlay_again_after_a_quality_filter_keeps_the_mark_filtered(tmp_path, fp_bam):
    from models.domain import Dataset
    from services.read_quality_filters import apply_quality_filters
    from services.scan import registry
    from services.scan.overlay import apply_scan_overlays
    ds = Dataset('ds_a', fp_bam, label='A')
    ds.data_type = 'bam'
    st = NS(datasets={'ds_a': ds}, chroms=[NS(name='chrT', size=100_000)])
    registry.open_scan(st, _fpcls_scan(tmp_path, fp_bam))
    reads = [dict(id='m1/1/ccs', start=1000, end=1500, reference_start=1000, reference_end=1500,
                  intervals=[[0, 500, 0]], layers={})]
    (once,) = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, reads)
    assert once['layers']['fpcls']['intervals'] == [[0, 100, 100]]
    assert once['layers']['fpcls']['qualities'][1] == [128]
    filtered = apply_quality_filters(once, QFILTER)
    assert filtered['layers']['fpcls']['intervals'] == []
    (again,) = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, [filtered])
    assert again['layers']['fpcls']['intervals'] == []          # the receipt on the row: no raw mark comes back
    assert again is filtered


def test_c1_a_pass_over_another_window_is_not_skipped(tmp_path, fp_bam):
    """The receipt names its window: a row passed over another window gets that window's marks (replacing the
    first pass's group, filtered or not), never only the first window's."""
    from models.domain import Dataset
    from services.read_quality_filters import apply_quality_filters
    from services.scan import registry
    from services.scan.overlay import apply_scan_overlays
    ds = Dataset('ds_a', fp_bam, label='A')
    ds.data_type = 'bam'
    st = NS(datasets={'ds_a': ds}, chroms=[NS(name='chrT', size=100_000)])
    registry.open_scan(st, _fpcls_scan(tmp_path, fp_bam, spans=((1000, 1100), (2500, 2600))))
    read = dict(id='m1/1/ccs', start=1000, end=3000, reference_start=1000, reference_end=3000,
                intervals=[[0, 2000, 0]], layers={})
    (narrow,) = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, [read])
    assert narrow['layers']['fpcls']['intervals'] == [[0, 100, 100]]
    (wide,) = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 3000, [narrow])
    assert wide['layers']['fpcls']['intervals'] == [[0, 100, 100], [1500, 1600, 100]]
    # A filtered row over its own window stays filtered; over another window its group is replaced, not merged.
    filtered = apply_quality_filters(wide, QFILTER)
    assert filtered['layers']['fpcls']['intervals'] == []
    assert apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 3000, [filtered])[0] is filtered
    (other,) = apply_scan_overlays(st, 'ds_a', 'chrT', 1000, 2000, [filtered])
    assert other['layers']['fpcls']['intervals'] == [[0, 100, 100]]


def test_c1_working_set_quality_filter_holds_through_the_second_overlay_pass(tmp_path, fp_bam, monkeypatch):
    from models.domain import Dataset
    from services.scan import registry
    from state.browser_state import BrowserState
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    st = BrowserState(None)
    ds = Dataset('ds_a', fp_bam, label='A')
    ds.data_type = 'bam'
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds_a': ds}
    st.chroms = [NS(name='chrT', size=100_000)]
    from services.compact_read_loader import build_compact_reads_from_bam
    own = {r['id']: r for r in build_compact_reads_from_bam(fp_bam, 'chrT', 1000, 2000, spanning_only=False)}['m1/1/ccs']
    registry.open_scan(st, _fpcls_scan(tmp_path, fp_bam, f"{own['record_sha256']}:{own['alignment_occurrence']}"))
    plain = st.build_working_set('ds_a', 'chrT', 1000, 2000, include_layers=True)
    raw = {r['id']: r for r in plain.reads}['m1/1/ccs']
    assert raw['layers']['fpcls']['intervals'] == [[0, 100, 100]]
    st.set_quality_filters(QFILTER)
    ws = st.build_working_set('ds_a', 'chrT', 1000, 2000, include_layers=True)
    got = {r['id']: r for r in ws.reads}['m1/1/ccs']
    assert got['layers']['fpcls']['intervals'] == []


# --- C-3: linked sorts by a molecule metric or a hub count ---------------------------------------------------------

ASSIGN = {'a': {'a0': 0, 'a1': 0, 'a2': 1, 'a3': 1}, 'b': {'b0': 0, 'b1': 0, 'b2': 1, 'b3': 1}}
KW = dict(start=0, end=100, gene_regions=[], peak_regions=[], scope_windows=None, gene_regions_by_key={},
          transcription_genes=[])


def _nrl_reads(values):
    return {ds: [{'id': rid, 'intervals': [], '_fiberbrowser_scalars': {'nuc.nrl': values[rid]}} for rid in mapping]
            for ds, mapping in ASSIGN.items()}


def _linked(reads, req, hub_count=None):
    import services.filtering_endpoint as fe
    state = NS(get_dataset=lambda ds: NS(cluster_assignments=ASSIGN[ds]))
    query = NS(dataset_ids=['a', 'b'], build_working_set=lambda st, ds: NS(reads=reads[ds]))
    results = {ds: fe._sort_by_values(reads[ds], ASSIGN[ds], req, ds, hub_count) for ds in ASSIGN}
    alone = {ds: list(r['cluster_order']) for ds, r in results.items()}
    fe._apply_linked_sort_order(state, req, query, results, hub_count=hub_count, **KW)
    return alone, results


def test_c3_linked_scalar_sort_keeps_the_metric_order():
    from models.requests import SortReadsRequest
    reads = _nrl_reads({'a0': 180.0, 'a1': 180.0, 'a2': 200.0, 'a3': 200.0,
                        'b0': 180.0, 'b1': 180.0, 'b2': 200.0, 'b3': 200.0})
    req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='value', molecule_metric='nuc.nrl', descending=True,
                           linked=True, cluster_assignments=ASSIGN)
    alone, results = _linked(reads, req)
    assert alone == {'a': [1, 0], 'b': [1, 0]}
    assert results['a']['cluster_order'] == [1, 0] and results['b']['cluster_order'] == [1, 0]
    assert results['a']['read_sort_order'][:2] == ['a2', 'a3']


def test_c3_linked_scalar_sort_leaves_missing_values_out_and_puts_empty_clusters_last():
    from models.requests import SortReadsRequest
    # Cluster 0: 190 and missing in a, 170 in b -> pooled mean 180 (missing left out, not counted as 0).
    # Cluster 1: 175 in a, 176 in b -> 175.5. Ascending: [1, 0]; a missing value counted as zero would put 0 first.
    reads = _nrl_reads({'a0': 190.0, 'a1': None, 'a2': 175.0, 'a3': 175.0,
                        'b0': 170.0, 'b1': 170.0, 'b2': 176.0, 'b3': 176.0})
    req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='value', molecule_metric='nuc.nrl', descending=False,
                           linked=True, cluster_assignments=ASSIGN)
    _alone, results = _linked(reads, req)
    assert results['a']['cluster_order'] == [1, 0] and results['b']['cluster_order'] == [1, 0]
    # A cluster with no value anywhere goes last in either direction.
    empty = _nrl_reads({'a0': None, 'a1': None, 'a2': 175.0, 'a3': 175.0,
                        'b0': None, 'b1': None, 'b2': 176.0, 'b3': 176.0})
    for descending in (True, False):
        req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='value', molecule_metric='nuc.nrl',
                               descending=descending, linked=True, cluster_assignments=ASSIGN)
        _alone, results = _linked(empty, req)
        assert results['a']['cluster_order'] == [1, 0] and results['b']['cluster_order'] == [1, 0]


def test_c3_linked_hub_state_sort_uses_the_hub_counts():
    from models.requests import SortReadsRequest
    counts = {'a0': 0.0, 'a1': 0.0, 'a2': 2.0, 'a3': 2.0, 'b0': 0.0, 'b1': 0.0, 'b2': 2.0, 'b3': 2.0}
    reads = {ds: [{'id': rid, 'intervals': []} for rid in mapping] for ds, mapping in ASSIGN.items()}
    req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='feature_hub', descending=True, linked=True,
                           cluster_assignments=ASSIGN, feature_hub={'hits': [{'set_id': 's', 'hit_id': 'h'}]})
    alone, results = _linked(reads, req, hub_count=lambda read, ds: counts[read['id']])
    assert alone == {'a': [1, 0], 'b': [1, 0]}
    assert results['a']['cluster_order'] == [1, 0] and results['b']['cluster_order'] == [1, 0]


def test_c3_sort_endpoint_links_scalar_and_hub_sorts(monkeypatch):
    """Through sort_reads_for_request: the linked pass gets the same evaluator as each dataset's sort."""
    import services.filtering_endpoint as fe
    from models.requests import SortReadsRequest
    reads = _nrl_reads({'a0': 180.0, 'a1': 180.0, 'a2': 200.0, 'a3': 200.0,
                        'b0': 180.0, 'b1': 180.0, 'b2': 200.0, 'b3': 200.0})
    query = NS(dataset_ids=['a', 'b'], chrom='chrT', sample_seed='s',
               build_working_set=lambda st, ds: NS(reads=reads[ds]))
    monkeypatch.setattr(fe.AnalysisReadQuery, 'from_request', staticmethod(lambda *a, **k: query))
    state = NS(get_dataset=lambda ds: NS(cluster_assignments=ASSIGN[ds]))
    req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='value', molecule_metric='nuc.nrl', descending=True,
                           linked=True, cluster_assignments=ASSIGN)
    out = fe.sort_reads_for_request(state, req, chrom='chrT', start=0, end=100)['results']
    assert out['a']['cluster_order'] == [1, 0] and out['b']['cluster_order'] == [1, 0]
    counts = {'a0': 3.0, 'a1': 3.0, 'a2': 0.0, 'a3': 0.0, 'b0': 3.0, 'b1': 3.0, 'b2': 0.0, 'b3': 0.0}
    monkeypatch.setattr(fe, '_hub_counter', lambda st, hub, *a: (lambda read, ds: counts[read['id']]))
    req = SortReadsRequest(dataset_ids=['a', 'b'], sort_by='feature_hub', descending=True, linked=True,
                           cluster_assignments=ASSIGN, feature_hub={'hits': [{'set_id': 's', 'hit_id': 'h'}]})
    out = fe.sort_reads_for_request(state, req, chrom='chrT', start=0, end=100)['results']
    assert out['a']['cluster_order'] == [0, 1] and out['b']['cluster_order'] == [0, 1]


# --- C-5: stale annotated nucleosome groups are never exposed --------------------------------------------------------

CONTIG, LENGTH, MOL = 'chrS', 200_000, 3500
NUC_STARTS = [301 + 190 * k for k in range(16)]          # 1-based MA starts, 147 bp cores


def _nuc_header():
    from fiberhmm.nuc.tags import annotate_header
    pg = {'ID': 'fiberhmm-call', 'PN': 'fiberhmm-call', 'VN': '3.0.2',
          'CL': 'fiberhmm-call -i in.bam -o out.bam --enzyme hia5 --seq pacbio',
          'DS': 'FiberHMM fused apply+recall; coord=molecular; mode=pacbio-fiber'}
    hd = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': CONTIG, 'LN': LENGTH}], 'PG': [pg], 'CO': []}
    return annotate_header(pysam.AlignmentHeader.from_dict(hd))


def _nuc_record(header, name, ref_start, *, stale=False, legacy=False, coarse=2):
    """A record whose nucsz / nucmol groups (NRL 190) were computed from its calls; ``stale``: one call start moved
    (301 -> 321) afterwards. ``legacy``: the record also carries ns/nl (the loader's other branch)."""
    from fiberhmm.nuc.tags import NUCMOL_SPEC, encode_nucmol, record_calls_digest
    r = pysam.AlignedSegment(header)
    r.query_name, r.flag, r.reference_id, r.reference_start = name, 0, 0, ref_start
    r.mapping_quality, r.cigarstring = 60, f'{MOL}M'
    r.query_sequence = ('ACGTTGCA' * (MOL // 8 + 1))[:MOL]
    r.query_qualities = array.array('B', [30] * MOL)
    calls = ','.join(f'{s}-147' for s in NUC_STARTS)
    r.set_tag('MA', f'{MOL};nuc.:{calls}')
    digest = record_calls_digest(r)
    assert digest
    nucmol = encode_nucmol({'nrl': 190.0}, {}, digest=digest)
    now = ','.join(f'{s + (20 if stale and k == 0 else 0)}-147' for k, s in enumerate(NUC_STARTS))
    r.set_tag('MA', f'{MOL};nuc.:{now};nucsz.QQQQ:{calls};nucmol.{NUCMOL_SPEC}:1-{MOL}')
    r.set_tag('AQ', array.array('B', [coarse, 0, 230, 128] * len(NUC_STARTS) + list(nucmol)))
    r.set_tag('AN', ','.join(['.'] * len(NUC_STARTS) + [f'nucsz@{digest}_{k}' for k in range(len(NUC_STARTS))]
                             + ['nucmol']))
    if legacy:
        starts = [s - 1 + (20 if stale and k == 0 else 0) for k, s in enumerate(NUC_STARTS)]
        r.set_tag('ns', array.array('I', starts))
        r.set_tag('nl', array.array('I', [147] * len(starts)))
    return r


@pytest.fixture
def nuc_bam(tmp_path, monkeypatch):
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    path = str(tmp_path / 'annotated.bam')
    header = _nuc_header()
    with pysam.AlignmentFile(path, 'wb', header=header) as out:
        out.write(_nuc_record(out.header, 'cur', 10_000))
        out.write(_nuc_record(out.header, 'old', 10_100, stale=True))
        out.write(_nuc_record(out.header, 'cur_ns', 10_200, legacy=True))
        out.write(_nuc_record(out.header, 'old_ns', 10_300, stale=True, legacy=True))
    pysam.index(path)
    yield path
    STORE.clear()


def test_c5_fixture_is_current_and_stale_as_fiberhmm_reads_it(nuc_bam):
    from fiberhmm.nuc.tags import read_nuc_groups
    with pysam.AlignmentFile(nuc_bam) as bam:
        groups = {r.query_name: read_nuc_groups(r) for r in bam.fetch(until_eof=True)}
    for name in ('cur', 'cur_ns'):
        assert not groups[name]['nucmol']['stale'] and not groups[name]['nucsz']['stale']
        assert groups[name]['nucmol']['scalars']['nrl'] == 190.0
    for name in ('old', 'old_ns'):
        assert groups[name]['nucmol']['stale'] and groups[name]['nucsz']['stale']


@pytest.mark.parametrize('requested', [None, ['nucmol'], ['nucsz', 'nucmol']])
def test_c5_loader_drops_stale_nucleosome_groups(nuc_bam, requested):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.nuc.scalars import metric_value
    reads = build_compact_reads_from_bam(nuc_bam, CONTIG, 9_000, 15_000, spanning_only=False, include_layers=True,
                                         requested_layers=requested, include_layer_qualities=True,
                                         hide_terminal_gaps=False)
    by_id = {r['id']: r for r in reads}
    assert set(by_id) == {'cur', 'old', 'cur_ns', 'old_ns'}
    for name in ('cur', 'cur_ns'):
        assert metric_value(by_id[name], 'nuc.nrl') == 190.0
        assert 'nucmol' not in (by_id[name].get('layers') or {})
        if requested is None or 'nucsz' in requested:
            assert len(by_id[name]['layers']['nucsz']['intervals']) == len(NUC_STARTS)
    for name in ('old', 'old_ns'):
        assert metric_value(by_id[name], 'nuc.nrl') is None, name
        assert '_fiberbrowser_scalars' not in by_id[name] or 'nuc.nrl' not in by_id[name]['_fiberbrowser_scalars']
        layers = by_id[name].get('layers') or {}
        assert 'nucsz' not in layers and 'nucmol' not in layers, name


def test_c5_unsupported_group_versions_are_dropped(tmp_path, monkeypatch):
    """A header declaring another nucmol group version: FiberHMM flags it unsupported (stale); never decoded."""
    import json
    from fiberhmm.io.scan_ma import scan_contract_line
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.nuc.scalars import metric_value
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    hd = _nuc_header().to_dict()
    hd['CO'] = [c for c in hd.get('CO', []) if '"nucmol"' not in c] + [
        scan_contract_line({'group': 'nucmol', 'group_version': 1, 'kind': 'scalar'})]
    header = pysam.AlignmentHeader.from_dict(hd)
    path = str(tmp_path / 'v1.bam')
    with pysam.AlignmentFile(path, 'wb', header=header) as out:
        out.write(_nuc_record(out.header, 'cur', 10_000))
    pysam.index(path)
    (read,) = build_compact_reads_from_bam(path, CONTIG, 9_000, 15_000, spanning_only=False, include_layers=True,
                                           include_layer_qualities=True)
    assert metric_value(read, 'nuc.nrl') is None
    assert 'nucsz' in read['layers']               # its own contract is current: the group stays
    assert json.loads(hd['CO'][-1].split(':', 2)[2])['group'] == 'nucmol'


# --- D-1 wiring: Filter/Sort rules with nucleosome conditions load the nucsz marks ----------------------------------

MONO_RULE = dict(size_min=1, size_max=None, conditions=[], quality_gates=[], nuc_coarse=[2])


@pytest.fixture
def class_bam(tmp_path, monkeypatch):
    """Two annotated records: every footprint's nucsz mark long (coarse 3) on the first, mono (coarse 2) on the
    second (both current, legacy ns/nl footprints as the primary intervals)."""
    from services.nuc.store import STORE
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path / 'cache'))
    STORE.clear()
    path = str(tmp_path / 'classes.bam')
    with pysam.AlignmentFile(path, 'wb', header=_nuc_header()) as out:
        out.write(_nuc_record(out.header, 'long', 10_000, legacy=True, coarse=3))
        out.write(_nuc_record(out.header, 'mono', 10_100, legacy=True, coarse=2))
    pysam.index(path)
    yield path
    STORE.clear()


def _class_state(path):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    st = BrowserState(None)
    ds = Dataset('ds0', path, label='Classes')
    ds.available_layers = {'footprint': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    return st


def test_d1_filter_and_sort_rules_with_nuc_conditions_read_the_nucsz_marks(class_bam):
    from models.requests import AnalysisFilterRequest, SortReadsRequest
    from services.filtering_endpoint import filter_reads_by_analysis_rule_for_request, sort_reads_for_request
    st = _class_state(class_bam)
    view = dict(chrom=CONTIG, start=10_000, end=13_700)
    req = AnalysisFilterRequest(dataset_ids=['ds0'], metric='count', operator='gte', threshold=1, rule=MONO_RULE)
    picked = filter_reads_by_analysis_rule_for_request(st, req, **view)['results']['ds0']['read_ids']
    assert picked == ['mono']                       # the long-only read counts 0
    req = SortReadsRequest(dataset_ids=['ds0'], sort_by='rule', rule=MONO_RULE, descending=True)
    out = sort_reads_for_request(st, req, **view)['results']['ds0']
    assert out['read_sort_order'] == ['mono', 'long'] and 'no_op_reason' not in out
