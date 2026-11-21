"""User-set layer colours: saved defaults in the analysis preferences (``layer_colors``), and the figure engine
drawing the session's colours over them as the browser does (services/figure/layer_colours.py)."""
from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest

from services import analysis_preferences as AP
from services.figure import layer_colours as LC
from services.figure.defaults import defaults
from services.figure.spec import _merge_defaults, build_panels, resolve_spec


@pytest.fixture
def prefs_file(tmp_path, monkeypatch):
    path = tmp_path / 'prefs' / 'analysis_preferences.json'
    monkeypatch.setenv('FIBERBROWSER_PREFERENCES', str(path))
    return path


def test_saved_default_colours_merge_per_layer_validate_and_forget(prefs_file):
    assert AP.load_preferences()['layer_colors'] == {}
    AP.update_preferences({'layer_colors': {'nuc': '#FF0000', 'tf': '#abc', 'bad': 'red', 'm6a': 12}})
    assert AP.load_preferences()['layer_colors'] == {'nuc': '#ff0000', 'tf': '#aabbcc'}
    AP.update_preferences({'layer_colors': {'nuc': None, 'fire': '#00ff00'}})
    assert AP.load_preferences()['layer_colors'] == {'tf': '#aabbcc', 'fire': '#00ff00'}
    stored = json.loads(prefs_file.read_text())
    assert stored['layer_colors'] == {'tf': '#aabbcc', 'fire': '#00ff00'}
    with pytest.raises(ValueError):
        AP.update_preferences({'layer_colors': ['#ff0000']})


def test_the_endpoint_keeps_layer_colours(client, prefs_file):
    r = client.put('/api/preferences/analysis', json={'layer_colors': {'nuc': '#123456'}})
    assert r.status_code == 200 and r.json()['layer_colors'] == {'nuc': '#123456'}
    assert client.get('/api/preferences/analysis').json()['layer_colors'] == {'nuc': '#123456'}


def test_session_colours_win_over_saved_defaults_with_aliases(prefs_file):
    AP.update_preferences({'layer_colors': {'nuc': '#0000ff', 'tf': '#00ff00'}})
    fe = {'layerColorOverrides': {'nuc': '#ff0000', 'msp': '#111111'}}
    assert LC.effective(fe) == {'nuc': '#ff0000', 'tf': '#00ff00', 'fire': '#111111'}
    LC.apply(fe)
    colors = LC.layer_colors_for(fe)
    assert colors['msp'] == colors['fire'] == '#111111' and colors['footprint'] == '#ff0000'
    assert LC.mark_color(fe, 'fire', '#ea580c') == '#111111'
    assert LC.mark_color(fe, 'm6a', '#6b21a8') == '#6b21a8'      # no colour set: the stock one


def test_stock_rules_and_tf_overlay_follow_recoloured_rules_keep_theirs():
    fe = _merge_defaults({'layerColorOverrides': {'nuc': '#ff0000', 'fire': '#0000ff', 'tf': '#00ff00'}})
    fe['activeColormap']['rules'] = [
        {**r, 'color': '#222222'} if r['id'] == 'fire' else r for r in fe['activeColormap']['rules']]
    LC.apply(fe, defaults_map={})
    rules = {r['id']: r for r in fe['activeColormap']['rules']}
    assert rules['nuc']['color'] == '#ff0000'
    assert rules['fire']['color'] == '#222222'                  # the user recoloured it
    assert rules['pol2']['color'] == '#ff69b4'
    assert fe['activeColormap']['tfOverlay']['color'] == '#00ff00'
    # nothing set: the colormap is left as it is
    plain = _merge_defaults({})
    before = copy.deepcopy(plain['activeColormap'])
    LC.apply(plain, defaults_map={})
    assert plain['activeColormap'] == before


def test_default_metaprofile_sources_follow_and_picked_ones_stay():
    ds = {'id': 'ds', 'label': 'ds', 'available_layers': {'nuc': True, 'tf': True, 'tf2': True}}
    src = lambda rid, color, **kw: {'id': rid, 'ref': {'kind': 'metaprofile', 'ruleId': rid}, 'color': color,
                                     'visible': True, 'negate': False, 'scale': 1, **kw}
    comp = {'id': defaults()['defaultMetaprofileId'], 'kind': 'metaprofile', 'visible': True, 'sources': [
        src('nuc', '#16a34a'), src('tf', '#999999', autoColor=False), src('tf2', '#5571be', autoColor=True)]}
    fe = {'compositeTracks': [comp], 'layerColorOverrides': {'nuc': '#ff0000', 'tf': '#00ff00', 'tf2': '#0000ff'}}
    LC.apply(fe, defaults_map={})
    build_panels(SimpleNamespace(datasets={'ds': ds}), fe)
    out = {s['ref']['ruleId']: s for s in fe['compositeTracks'][0]['sources']}
    assert out['nuc']['color'] == '#ff0000' and out['nuc']['autoColor'] is True
    assert out['tf']['color'] == '#999999'
    assert out['tf2']['color'] == '#0000ff'


def test_a_default_metaprofile_built_for_the_figure_takes_the_colours(prefs_file):
    AP.update_preferences({'layer_colors': {'nuc': '#ff00ff'}})
    ds = {'id': 'ds', 'label': 'ds', 'available_layers': {'nuc': True}}
    state = SimpleNamespace(datasets={'ds': ds}, dataset_order=['ds'])
    spec = resolve_spec(state, chrom='chr1', start=0, end=1000, source='defaults')
    sources = {s['ref']['ruleId']: s for s in spec.fe['compositeTracks'][0]['sources']}
    assert sources['nuc']['color'] == '#ff00ff'
    assert {r['id']: r['color'] for r in spec.fe['activeColormap']['rules']}['nuc'] == '#ff00ff'


def test_the_read_track_draws_the_users_nucleosome_colour():
    from tests.test_figure_reads import START, _fp, _px, _read, _render
    reads = [_read('r1', [[0, 200, 200]])]
    fe = _merge_defaults({'readDisplayMode': 'all', 'readSeparatorMode': 'off',
                          'layerColorOverrides': {'nuc': '#ff0000'}})
    LC.apply(fe, defaults_map={})
    img, _, _ = _render(reads, fe=fe)
    assert _px(img, 0, 100) == _fp('#ff0000')
    assert START  # the shared fixture's region


def test_the_browser_figure_renderer_gets_the_saved_default_colours(prefs_file):
    from tests.test_figure_render import _push_live, _state
    from models.requests import FigureRequest
    from services.figure_render import build_figure_envelope
    state = _state('a')
    _push_live(state)
    assert 'userLayerColors' not in build_figure_envelope(FigureRequest(), state)['figure']['baseState']
    AP.update_preferences({'layer_colors': {'nuc': '#ff00ff'}})
    assert build_figure_envelope(FigureRequest(), state)['figure']['baseState']['userLayerColors'] == {'nuc': '#ff00ff'}


def test_tf_calls_and_an_extra_ma_tag_layer_draw_in_the_users_colours():
    from tests.test_figure_reads import _close, _over, _px, _read, _render
    tf = {'intervals': [[100, 130, 30]]}
    mine = {'intervals': [[500, 560, 60]]}
    reads = [_read('r1', [[0, 1000, -1000]], layers={'tf': tf, 'mine': mine})]
    ds = {'id': 'ds', 'data_type': 'bam', 'layer_type': 'bam',
          'available_layers': {'footprint': True, 'nuc': True, 'tf': True, 'mine': True}}
    base = {'readDisplayMode': 'all', 'readSeparatorMode': 'off',
            'enabledModTypes': {'footprint': True, 'nuc': True, 'tf': True, 'mine': True}}
    plain, _, _ = _render(reads, fe=_merge_defaults(base), dataset=ds)
    assert _close(_px(plain, 0, 115), _over('#9ca3af', round(255 * 0.9) / 255, '#f1f5f9'))   # stock Subnucleosome grey
    fe = _merge_defaults({**base, 'layerColorOverrides': {'tf': '#00ff00', 'mine': '#ff0000'}})
    LC.apply(fe, defaults_map={})
    img, _, _ = _render(reads, fe=fe, dataset=ds)
    assert _close(_px(img, 0, 115), _over('#00ff00', round(255 * 0.9) / 255, '#f1f5f9'))
    r, g, b = _px(img, 0, 530)
    assert r > 200 and g < 120 and b < 120 and _px(plain, 0, 530) != _px(img, 0, 530)


def test_a_following_curated_source_goes_back_to_the_built_in_colour_when_no_colour_applies():
    ds = {'id': 'ds', 'label': 'ds', 'available_layers': {'nuc': True}}
    comp = {'id': defaults()['defaultMetaprofileId'], 'kind': 'metaprofile', 'visible': True, 'sources': [
        {'id': 'n', 'ref': {'kind': 'metaprofile', 'ruleId': 'nuc'}, 'color': '#ff00ff', 'autoColor': True,
         'visible': True, 'negate': False, 'scale': 1},
        {'id': 'p', 'ref': {'kind': 'metaprofile', 'ruleId': 'nuc'}, 'color': '#123456', 'autoColor': False,
         'visible': True, 'negate': False, 'scale': 1}]}
    fe = {'compositeTracks': [comp]}
    LC.apply(fe, defaults_map={})
    build_panels(SimpleNamespace(datasets={'ds': ds}), fe)
    colours = [s['color'] for s in fe['compositeTracks'][0]['sources']]
    assert colours == ['#16a34a', '#123456']


def test_layer_colours_and_recent_genome_settings_share_the_preferences_file(prefs_file, tmp_path, monkeypatch):
    """Both features save into analysis_preferences.json, one field per PUT: neither write clobbers the other, in
    either order, and the recent-genome list itself (its own file) is untouched by both."""
    recent = tmp_path / 'recent_genomes.json'
    recent.write_text('{"entries": []}')
    monkeypatch.setenv('FIBERBROWSER_RECENT_GENOMES', str(recent))
    AP.update_preferences({'layer_colors': {'nuc': '#ff0000'}})
    AP.update_preferences({'recent_genomes_max': 12})
    AP.update_preferences({'recent_genomes_autoswitch': True})   # an old setting: ignored
    AP.update_preferences({'layer_colors': {'tf': '#00ff00'}})
    prefs = AP.load_preferences()
    assert prefs['layer_colors'] == {'nuc': '#ff0000', 'tf': '#00ff00'}
    assert prefs['recent_genomes_max'] == 12 and 'recent_genomes_autoswitch' not in prefs
    AP.update_preferences({'layer_colors': {'nuc': None}})
    AP.update_preferences({'recent_genomes_max': 3})
    prefs = AP.load_preferences()
    assert prefs['layer_colors'] == {'tf': '#00ff00'}
    assert prefs['recent_genomes_max'] == 3 and 'recent_genomes_autoswitch' not in prefs
    assert recent.read_text() == '{"entries": []}'
    from services import recent_genomes as RG
    assert RG._shown_max() == 3


def test_lab_members_keep_their_own_preferences(prefs_file):
    """Audit (final 3.1.0, HIGH): on a lab server one member's saved colours never replace another's. A member who
    never saved reads the shared file."""
    from services import runtime
    from services.lab.users import LabUser
    AP.update_preferences({'layer_colors': {'nuc': '#00ff00'}, 'pinned_motifs': {'fly': ['vfl']}})
    runtime.set_lab_mode(True)
    try:
        with runtime.lab_request_context(LabUser('alice')):
            assert AP.load_preferences()['layer_colors'] == {'nuc': '#00ff00'}   # the shared file, until she saves
            AP.update_preferences({'layer_colors': {'nuc': '#ff0000'}})
        with runtime.lab_request_context(LabUser('bob')):
            AP.update_preferences({'layer_colors': {'nuc': '#0000ff'}})
            assert AP.load_preferences()['layer_colors'] == {'nuc': '#0000ff'}
            assert LC.saved_defaults() == {'nuc': '#0000ff'}
        with runtime.lab_request_context(LabUser('alice')):
            prefs = AP.load_preferences()
            assert prefs['layer_colors'] == {'nuc': '#ff0000'} and prefs['pinned_motifs'] == {'fly': ['vfl']}
            assert LC.saved_defaults() == {'nuc': '#ff0000'}
    finally:
        runtime.set_lab_mode(False)
    assert AP.load_preferences()['layer_colors'] == {'nuc': '#00ff00'}   # the local user's file is untouched
    assert 'alice' not in ''.join(p.name for p in prefs_file.parent.rglob('*'))


def test_alias_keyed_default_colours_are_one_layer_and_clear(prefs_file):
    """Audit (final 3.1.0, MED): a default stored under an alias (msp) is the same layer as its canonical key (fire),
    so "Clear my defaults" (fire: null) really clears it."""
    AP.update_preferences({'layer_colors': {'msp': '#ff0000', 'mod': '#00ff00'}})
    assert AP.load_preferences()['layer_colors'] == {'fire': '#ff0000', 'm6a': '#00ff00'}
    AP.update_preferences({'layer_colors': {'fire': None, 'm6a': None}})
    assert AP.load_preferences()['layer_colors'] == {}
    prefs_file.write_text(json.dumps({'layer_colors': {'msp': '#123456'}}))   # an older file with an alias key
    AP.update_preferences({'layer_colors': {'fire': None}})
    assert AP.load_preferences()['layer_colors'] == {}


def test_public_and_tour_figures_never_use_the_hosts_default_colours(prefs_file, monkeypatch):
    """Audit (final 3.1.0, MED): a public page never loads the host's preferences, so its headless figures don't
    either."""
    from services import runtime
    AP.update_preferences({'layer_colors': {'nuc': '#ff0000'}})
    assert LC.saved_defaults() == {'nuc': '#ff0000'}
    monkeypatch.setattr(runtime, 'get_public_mode', lambda: True)
    assert LC.saved_defaults() == {}
    monkeypatch.setattr(runtime, 'get_public_mode', lambda: False)
    monkeypatch.setattr(runtime, 'current_sandbox_id', lambda: 'tour-1')
    assert LC.saved_defaults() == {}


def test_member_files_of_two_preference_stores_stay_apart(tmp_path, monkeypatch):
    """Re-check (final 3.1.0, N2): two servers with their own preference files never share a member's file."""
    from services import runtime
    from services.lab.users import LabUser
    paths = []
    runtime.set_lab_mode(True)
    try:
        for name in ('lab-a.json', 'lab-b.json'):
            monkeypatch.setenv('FIBERBROWSER_PREFERENCES', str(tmp_path / name))
            with runtime.lab_request_context(LabUser('alice')):
                paths.append(AP.preferences_path())
                AP.update_preferences({'layer_colors': {'nuc': '#ff0000' if name == 'lab-a.json' else '#0000ff'}})
        monkeypatch.setenv('FIBERBROWSER_PREFERENCES', str(tmp_path / 'lab-a.json'))
        with runtime.lab_request_context(LabUser('alice')):
            assert AP.load_preferences()['layer_colors'] == {'nuc': '#ff0000'}
    finally:
        runtime.set_lab_mode(False)
    assert paths[0] != paths[1]
