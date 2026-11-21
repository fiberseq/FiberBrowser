"""Differences requests use the dataset's reference for every workspace action."""
import asyncio
from types import SimpleNamespace

import pytest

from routers.differences import WorkspaceRequest, _workspace


@pytest.mark.parametrize('operation', ['inspect', 'alternate_blocks', 'observations', 'sequence', 'lens'])
def test_workspace_routes_use_dataset_reference_and_revision(monkeypatch, operation):
    dataset = SimpleNamespace(id='native', data_type='bam', paths=[])
    main = SimpleNamespace(datasets={'native': dataset})
    scoped = SimpleNamespace(datasets=main.datasets, get_dataset=lambda _: dataset, fasta_path='panel-reference.fa')
    scopes, received = [], []
    def for_datasets(state, ids):
        assert state is main
        scopes.append(ids)
        return scoped
    monkeypatch.setattr('services.panel_genomes.for_datasets', for_datasets)
    async def background(request, key, function, state, ds, **kwargs):
        received.append((key, state, ds))
        return dict(scope='panel')
    monkeypatch.setattr('services.background_work.run_background', background)
    req = WorkspaceRequest(dataset_id='native', native_dataset_id='native-copy', chrom='chrT', start=100, end=500, target={})
    assert asyncio.run(_workspace(req, object(), main, operation)) == dict(scope='panel')
    assert scopes == [['native', 'native-copy']]
    assert received[0][1] is scoped and received[0][2] is dataset
