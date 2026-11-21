"""Hub provider columns and assembly callable territory, without servers or ports."""
import asyncio
from types import SimpleNamespace as NS

import pytest


def test_linear_fit_record_sources_use_own_contig_not_primary_haplotype():
    from services.clustering_endpoint import record_sources
    ds = NS(live_lift=NS(handle=NS(source_haplotype={'maternal': 'hm', 'paternal': 'hp'},
                                  haplotype_labels={'hm': 'MAT', 'hp': 'PAT'})))
    reads = [dict(analysis_id='identity', live_lift=dict(hap_label='MAT', source=dict(contig='paternal')))]
    assert record_sources(ds, reads) == {'identity': {'contig': 'paternal', 'hap': 'PAT'}}


def test_provider_hits_get_graph_columns_including_source_alleles(monkeypatch):
    from routers.hub import provider_columns
    from services.scan import graph_hits
    seen = []

    async def aliases(state, hits, chrom):
        seen.extend(hits)
        for hit in hits:
            hit['graph'] = {'paths': {'pat': {'status': 'absent'}}}

    monkeypatch.setattr(graph_hits, 'add_graph_aliases', aliases)
    hits = [dict(hitId=str(i), typeId=t, chrom='chrT', start=10, end=20, anchor=10)
            for i, t in enumerate(['var.diff', 'peaks.peak', 'fp.class'])]
    out = asyncio.run(provider_columns({'chrom': 'chrT', 'hits': hits}, state=NS()))
    assert len(seen) == 3
    assert all(h['graph']['paths']['pat']['status'] == 'absent' for h in out['hits'])
    plan = graph_hits._hit_plan(dict(hits[0], detail=dict(datasetId='lift', source='assembly',
                                                       src=dict(contig='source', start=100, end=200))),
                                {('lift', 'source'): 'mat'}, 'target')
    assert plan == ('mat', 100, 200, (10, 20))
    # A deletion names the reference bases it removes, not the source's adjacent base.
    deletion = dict(hits[0], detail=dict(datasetId='lift', kind='deletion', source='assembly',
                                       src=dict(contig='source', start=100, end=100)))
    assert graph_hits._hit_plan(deletion, {('lift', 'source'): 'mat'}, 'target') == (None, 10, 20, (10, 20))


def test_assembly_callable_territory_is_lifted_and_clipped(monkeypatch):
    from services.hub import assoc_inputs as inputs
    from services.scan import lift, projection
    from fiberhmm.assoc import scanio
    monkeypatch.setattr(scanio, 'territory', lambda *a, **k: [('source', 0, 100), ('source', 200, 250)])
    monkeypatch.setattr('fiberhmm.scan.reader.ScanDir', lambda path: NS())
    config = NS(handle=NS(path='map', plain_chain=False))
    state = NS(datasets={'lift': NS(live_lift=config)}, chroms=[NS(name='chrT')])
    scan = NS(frame={'kind': 'source'}, path='scan')
    monkeypatch.setattr(projection, 'lifted_datasets', lambda *a: ['lift'])
    calls = []

    def project(path, intervals, **kw):
        calls.append((path, intervals, kw))
        return [lift.HitLift('split', 'chrT', 90, 120, parts=[('chrT', 90, 120), ('chrT', 150, 190)]),
                lift.HitLift('unmapped')]

    monkeypatch.setattr(lift, 'lift_intervals', project)
    table = inputs.HitTable('fp.class', 'Classes', scan=scan)
    territory, note = inputs.scan_territory(state, table, [('chrT', 100, 180)])
    assert territory == [('chrT', 100, 120), ('chrT', 150, 180)]
    assert calls == [('map', [('source', 0, 100), ('source', 200, 250)], {'split_gap': 0})]
    assert 'liftbed' in note
