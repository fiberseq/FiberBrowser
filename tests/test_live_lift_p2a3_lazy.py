"""Collapsed panels avoid hidden-block composition; expansion enriches copies."""
from test_live_lift_differences import evidence
from test_live_lift_endpoints import lift_env, _add
from live_lift_fixtures import MAT, TARGET
from services.lift import compose


def test_compact_only_composes_requested_insertions(evidence, lift_env, monkeypatch):
    _, ds, _ = evidence
    client, state, _, _ = lift_env
    did = _add(client, ds.live_lift.manifest, ds.paths[0])['dataset']['id']
    params = dict(dataset_id=did, chrom=TARGET, start=5900, end=6200, include_layers=True,
                  include_methylation=True, full_working_set=True)
    original = compose._insertion_payloads
    calls = []
    def track(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(compose, '_insertion_payloads', track)
    cold = client.get('/api/reads/compact', params=params)
    assert cold.status_code == 200, cold.text
    assert not calls
    assert all(not r['live_lift']['insertions'] for r in cold.json()['reads'])
    key = f'MAT:{MAT}:5000-5100:insertion'
    # The canvas and primary click use this parallel metadata before any
    # insertion-local annotations have been composed.
    badges = [badge for r in cold.json()['reads']
              for badge, ins_id in zip(r['live_lift']['badges'], r['live_lift']['badge_ids'])
              if ins_id == key]
    assert badges and all(b[1] == 'source_insertion' and b[2] > 0 for b in badges)
    expanded = client.get('/api/reads/compact', params={**params, 'insertion_ids': key})
    assert expanded.status_code == 200, expanded.text
    assert calls
    blocks = [r['live_lift']['insertions'][key] for r in expanded.json()['reads'] if key in r['live_lift']['insertions']]
    assert blocks and all(b['length'] == 100 and b['pos'] == 110 for b in blocks)
    assert any(b.get('layers') for b in blocks)
    calls.clear()
    collapsed = client.get('/api/reads/compact', params=params)
    assert collapsed.status_code == 200 and not calls
    assert collapsed.json()['reads'] == cold.json()['reads']
