"""Analysis preferences kept on this computer (services/analysis_preferences.py, /api/preferences/analysis): pinned
motifs per species and custom motifs survive another port or build (browser storage is per origin), merge per key,
and move once from a browser's own storage without overwriting; a map this build doesn't know is kept in the file."""
from __future__ import annotations

import json

import pytest

from services import analysis_preferences as AP


@pytest.fixture
def prefs_file(tmp_path, monkeypatch):
    path = tmp_path / 'prefs' / 'analysis_preferences.json'
    monkeypatch.setenv('FIBERBROWSER_PREFERENCES', str(path))
    return path


def test_merge_per_species_and_forget(prefs_file):
    assert AP.load_preferences()['pinned_motifs'] == {}
    AP.update_preferences({'pinned_motifs': {'fly': ['vfl', 'su(Hw)', 'VFL']}})
    AP.update_preferences({'pinned_motifs': {'human': ['CTCF']}})
    assert AP.load_preferences()['pinned_motifs'] == {'fly': ['vfl', 'su(Hw)'], 'human': ['CTCF']}
    assert json.loads(prefs_file.read_text())['schema'] == AP.SCHEMA
    AP.update_preferences({'pinned_motifs': {'fly': None}})                 # back to the species' defaults
    assert AP.load_preferences()['pinned_motifs'] == {'human': ['CTCF']}


def test_a_map_this_build_does_not_know_is_kept_in_the_file(prefs_file, monkeypatch):
    monkeypatch.setattr('plugins.packs.preference_maps', lambda: {})
    prefs_file.parent.mkdir(parents=True)
    prefs_file.write_text(json.dumps({'schema': AP.SCHEMA, 'other_map': {'dm6': {'x': 1}}, 'other_list': [1]}))
    assert 'other_map' not in AP.load_preferences()
    AP.update_preferences({'pinned_motifs': {'fly': ['vfl']}})
    stored = json.loads(prefs_file.read_text())
    assert stored['other_map'] == {'dm6': {'x': 1}} and 'other_list' not in stored
    assert stored['pinned_motifs'] == {'fly': ['vfl']}


def test_custom_motifs_are_validated_and_replaced_as_a_list(prefs_file):
    good = {'name': 'CAGGTAG', 'counts': {b: [1, 0, 0] for b in 'ACGT'}}
    AP.update_preferences({'custom_motifs': [good, {'name': 'bad', 'counts': {'A': [1]}}, {'name': 'cagGTAG', 'counts': good['counts']}]})
    assert [c['name'] for c in AP.load_preferences()['custom_motifs']] == ['CAGGTAG']
    AP.update_preferences({'custom_motifs': []})
    assert AP.load_preferences()['custom_motifs'] == []


def test_one_time_move_keeps_what_is_stored(prefs_file):
    AP.update_preferences({'pinned_motifs': {'fly': ['Trl']}})
    AP.update_preferences({'only_missing': True, 'pinned_motifs': {'fly': ['vfl'], 'human': ['CTCF']},
                           'custom_motifs': [{'name': 'X', 'counts': {b: [1, 1, 1] for b in 'ACGT'}}]})
    p = AP.load_preferences()
    assert p['pinned_motifs'] == {'fly': ['Trl'], 'human': ['CTCF']} and [c['name'] for c in p['custom_motifs']] == ['X']
    AP.update_preferences({'only_missing': True, 'custom_motifs': []})        # stored already: kept
    assert [c['name'] for c in AP.load_preferences()['custom_motifs']] == ['X']


def test_an_unreadable_file_reads_as_empty_and_is_replaced(prefs_file):
    prefs_file.parent.mkdir(parents=True)
    prefs_file.write_text('{not json')
    assert AP.load_preferences()['pinned_motifs'] == {}
    AP.update_preferences({'pinned_motifs': {'fly': ['vfl']}})
    assert AP.load_preferences()['pinned_motifs'] == {'fly': ['vfl']}
    with pytest.raises(ValueError):
        AP.update_preferences({'pinned_motifs': ['vfl']})


def test_the_endpoint_reads_and_writes_and_a_tour_tab_cannot_write(client, prefs_file, monkeypatch):
    r = client.put('/api/preferences/analysis', json={'pinned_motifs': {'human': ['CTCF']}})
    assert r.status_code == 200 and r.json()['pinned_motifs'] == {'human': ['CTCF']}
    assert client.get('/api/preferences/analysis').json()['pinned_motifs'] == {'human': ['CTCF']}
    assert client.put('/api/preferences/analysis', json={'pinned_motifs': 3}).status_code == 400
    monkeypatch.setattr('services.runtime.current_sandbox_id', lambda: 'tour')
    assert client.put('/api/preferences/analysis', json={'pinned_motifs': {'fly': ['vfl']}}).status_code == 403
    assert AP.load_preferences()['pinned_motifs'] == {'human': ['CTCF']}


def test_show_preview_features_is_a_kept_boolean(prefs_file):
    from services.analysis_preferences import load_preferences, update_preferences
    assert 'show_preview_features' not in load_preferences()
    assert update_preferences({'show_preview_features': True})['show_preview_features'] is True
    assert load_preferences()['show_preview_features'] is True
    # A one-time move never overwrites it; a bad value is refused.
    assert update_preferences({'only_missing': True, 'show_preview_features': False})['show_preview_features'] is True
    import pytest
    with pytest.raises(ValueError):
        update_preferences({'show_preview_features': 'yes'})
    assert update_preferences({'show_preview_features': False})['show_preview_features'] is False
