"""Map previews are bounded; explicit sequence requests page in display order."""
from test_live_lift_differences import evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import TARGET
from services.lift import differences as diff


def test_one_base_view_bounds_all_source_fetches(evidence, monkeypatch):
    state, ds, _ = evidence
    fetch = diff.fasta_bases
    sizes = []
    def bounded(fa, chrom, start, end):
        if start is not None:
            sizes.append(end - start)
        return fetch(fa, chrom, start, end)
    monkeypatch.setattr(diff, 'fasta_bases', bounded)
    items = diff.differences_for_region(state, ds, TARGET, 12800, 12801)['items']
    inversion = next(d for d in items if d['kind'] == 'inversion')
    assert max(sizes) <= 60
    assert len(inversion['alt']) == 60 and inversion['alt_truncated']
    assert inversion['alt_bp'] == 2000


def test_map_sequence_pages_and_orientation(evidence, lift_env):
    state0, ds, _ = evidence
    client, state, _, _ = lift_env
    did = _add(client, ds.live_lift.manifest, ds.paths[0])['dataset']['id']
    state.datasets[did].live_lift.source_fasta = ds.live_lift.source_fasta
    state.fasta = state0.fasta
    item = next(i for i in diff.assembly_items_for_region(ds.live_lift, TARGET, 12800, 12801) if i['kind'] == 'inversion')
    params = dict(dataset_id=did, chrom=TARGET, pos=12800, item_id=item['id'], limit=59)
    pieces = []
    offset = 0
    while offset is not None:
        response = client.get('/api/lift/difference_sequence', params={**params, 'offset': offset})
        assert response.status_code == 200, response.text
        page = response.json()
        assert len(page['sequence']) <= 59
        pieces.append(page['sequence'])
        offset = page['next_offset']
    src = item['src']
    expected = diff.revcomp(diff.fasta_bases(__import__('pysam').FastaFile(ds.live_lift.source_fasta), src['contig'], src['start'], src['end']))
    assert ''.join(pieces) == expected
    assert client.get('/api/lift/difference_sequence', params={**params, 'limit': 50001}).status_code == 422
    assert client.get('/api/lift/difference_sequence', params={**params, 'item_id': 'missing'}).status_code == 404
