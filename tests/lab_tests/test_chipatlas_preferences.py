"""The lab pack's ChIP-Atlas experiment choice per genome (the NFR peak check) is an analysis preference kept on this
computer: merged per genome, forgotten with null, moved once without overwriting, and served by the endpoint."""
from __future__ import annotations

import pytest

from services import analysis_preferences as AP


@pytest.fixture
def prefs_file(tmp_path, monkeypatch):
    path = tmp_path / 'prefs' / 'analysis_preferences.json'
    monkeypatch.setenv('FIBERBROWSER_PREFERENCES', str(path))
    return path


def test_merge_per_genome_and_forget(prefs_file):
    assert AP.load_preferences() == {'chipatlas_selection': {}, 'pinned_motifs': {}}
    AP.update_preferences({'chipatlas_selection': {'dm6': {'cellTypeClasses': ['Embryo'], 'cellTypes': ['S2', 'S2', ' ']}}})
    AP.update_preferences({'chipatlas_selection': {'hg38': {'cellTypeClasses': [], 'cellTypes': ['K562']}},
                           'pinned_motifs': {'fly': ['vfl']}})
    p = AP.load_preferences()
    assert p['chipatlas_selection'] == {'dm6': {'cellTypeClasses': ['Embryo'], 'cellTypes': ['S2']},
                                        'hg38': {'cellTypeClasses': [], 'cellTypes': ['K562']}}
    AP.update_preferences({'chipatlas_selection': {'dm6': None, 'mm10': 'bad'}})
    assert list(AP.load_preferences()['chipatlas_selection']) == ['hg38']
    with pytest.raises(ValueError):
        AP.update_preferences({'chipatlas_selection': ['dm6']})


def test_one_time_move_keeps_what_is_stored(prefs_file):
    AP.update_preferences({'chipatlas_selection': {'dm6': {'cellTypes': ['Kc167']}}})
    AP.update_preferences({'only_missing': True, 'chipatlas_selection': {'dm6': {'cellTypes': ['S2']}, 'hg38': {'cellTypes': ['K562']}}})
    p = AP.load_preferences()['chipatlas_selection']
    assert p['dm6']['cellTypes'] == ['Kc167'] and p['hg38']['cellTypes'] == ['K562']


def test_the_endpoint_reads_and_writes(client, prefs_file):
    r = client.put('/api/preferences/analysis', json={'chipatlas_selection': {'dm6': {'cellTypeClasses': ['Larvae'], 'cellTypes': []}}})
    assert r.status_code == 200 and r.json()['chipatlas_selection']['dm6']['cellTypeClasses'] == ['Larvae']
    assert client.get('/api/preferences/analysis').json()['chipatlas_selection']['dm6']['cellTypeClasses'] == ['Larvae']
