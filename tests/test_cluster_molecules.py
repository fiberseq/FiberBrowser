"""/api/cluster_molecules: the cluster map's per-molecule colours (m6A per kb, span, layer shares, layer at a
position) from the clustered reads themselves, independent of the read panels. Synthetic Hia5 molecules."""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')

from nuc_fixtures import chromatin_bam

CONTIG, LENGTH = 'chrR', 160_000
VIEW = (20_000, 24_000)


@pytest.fixture(scope='module')
def state(tmp_path_factory):
    from models.domain import Dataset
    from state.browser_state import BrowserState
    bam = chromatin_bam(tmp_path_factory.mktemp('cluster_mol') / 'c.bam', contig=CONTIG, length=LENGTH)
    st = BrowserState(None)
    ds = Dataset('ds0', bam, label='Synthetic')
    ds.available_layers = {'footprint': True, 'nuc': True, 'msp': True, 'm6a': True}
    st.datasets = {'ds0': ds}
    st.chroms = [NS(name=CONTIG, size=LENGTH)]
    return st


def _ids(state):
    from services.analysis_query import AnalysisReadQuery
    from services.read_selection import cohort_read_id
    q = AnalysisReadQuery.from_request(state, capability='clustering', chrom=CONTIG, start=VIEW[0], end=VIEW[1],
                                       dataset_id='ds0', include_methylation=False, include_layers=False)
    return [cohort_read_id(r) for r in q.build_working_set(state, 'ds0').reads]


def test_summaries_and_state(state):
    from services.cluster_molecules import cluster_molecules, clear_cache
    clear_cache()
    ids = _ids(state)
    assert len(ids) > 4
    assigned = {rid: i % 2 for i, rid in enumerate(ids)}
    res = cluster_molecules(state, chrom=CONTIG, start=VIEW[0], end=VIEW[1], spanning=False, dataset_ids=['ds0'],
                            cluster_assignments={'ds0': assigned})
    mol = res['molecules']['ds0']
    assert set(mol) == set(ids)
    assert 'nuc' in res['layers'] and 'fire' in res['layers']
    for s in mol.values():
        assert s['span'] > 0 and 'state' not in s
        assert s['m6a'] is not None and s['m6a_per_kb'] is not None and s['m6a_per_kb'] >= 0
        assert all(0 <= v <= 1 for v in s['frac'].values())
        # Nucleosomes and linkers tile the molecule: their shares add to about one.
        assert 0.9 <= s['frac'].get('nuc', 0) + s['frac'].get('fire', 0) <= 1.01
    # A subset of the assignments: only those molecules.
    some = dict(list(assigned.items())[:3])
    res2 = cluster_molecules(state, chrom=CONTIG, start=VIEW[0], end=VIEW[1], spanning=False, dataset_ids=['ds0'],
                             cluster_assignments={'ds0': some})
    assert set(res2['molecules']['ds0']) == set(some)
    res3 = cluster_molecules(state, chrom=CONTIG, start=VIEW[0], end=VIEW[1], spanning=False, dataset_ids=['ds0'],
                             cluster_assignments={'ds0': assigned}, position=VIEW[0] + 2000)
    states = {s['state'] for s in res3['molecules']['ds0'].values()}
    assert states <= {'nuc', 'fire', 'linker', None} and states - {None}


def test_layer_state_order():
    from services.cluster_molecules import layer_state_at, summarize_read
    read = {'reference_start': 1000, 'reference_end': 1400, 'intervals': [],
            'layers': {'nuc': {'intervals': [[0, 147, 147]]}, 'tf': {'intervals': [[100, 120, 20]]},
                       'msp': {'intervals': [[147, 300, 153]]}},
            'methyl_m6a': [150, 160, 170, 350]}
    assert layer_state_at(read, 1000, 1110) == 'tf'      # tf wins over nuc
    assert layer_state_at(read, 1000, 1050) == 'nuc'
    assert layer_state_at(read, 1000, 1200) == 'fire'    # msp is fire
    assert layer_state_at(read, 1000, 1350) == 'linker'
    assert layer_state_at(read, 1000, 1500) is None
    s = summarize_read(read, 1000, 1200)                  # a 200 bp view: the read covers all of it
    assert s['span'] == 400 and s['m6a'] == 3 and s['m6a_per_kb'] == 15.0
    assert s['frac']['nuc'] == pytest.approx(147 / 200) and s['frac']['fire'] == pytest.approx(53 / 200)


def test_two_datasets_load_side_by_side(state):
    from models.domain import Dataset
    from services.cluster_molecules import cluster_molecules, clear_cache
    clear_cache()
    ds0 = state.datasets['ds0']
    ds1 = Dataset('ds1', ds0.path, label='Copy')
    ds1.available_layers = dict(ds0.available_layers)
    state.datasets['ds1'] = ds1
    try:
        ids = _ids(state)
        assigned = {rid: 0 for rid in ids}
        res = cluster_molecules(state, chrom=CONTIG, start=VIEW[0], end=VIEW[1], spanning=False,
                                dataset_ids=['ds0', 'ds1'], cluster_assignments={'ds0': assigned, 'ds1': assigned})
        assert set(res['molecules']) == {'ds0', 'ds1'}
        assert res['molecules']['ds0'] == res['molecules']['ds1'] and len(res['molecules']['ds0']) == len(ids)
    finally:
        state.datasets.pop('ds1', None)
