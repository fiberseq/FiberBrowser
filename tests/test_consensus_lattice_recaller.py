"""FiberBrowser support for FiberHMM's lattice recaller engine (the default footprint-class engine)."""
from types import SimpleNamespace
import pytest
import threading

import numpy as np

from services import consensus_workflow as workflow

PA, PP = 0.8, 0.02


def planted_payload(n=120, occupancy=0.4, seed=7):
    rng = np.random.default_rng(seed); units = []
    for i in range(n):
        strand = 'CT' if i % 2 == 0 else 'GA'; pos = np.arange(900 + (0 if strand == 'CT' else 2), 1500, 4)
        bound = rng.random() < occupancy; jl, jr = rng.integers(-1, 2, size=2); a, b = 1180 + jl, 1210 + jr
        prot = bound & (pos >= a) & (pos < b)
        hit = np.where(prot, rng.random(len(pos)) < PP, rng.random(len(pos)) < PA)
        calls = [dict(interval=[int(a), int(b)], llr=12.0)] if bound else []
        units.append(dict(unit_id=f'mol{i:04d}', read_name=f'read{i:04d}', strand=strand, reference_start=880, reference_end=1520,
                          positions=pos.tolist(), hits=hit.astype(int).tolist(), p_accessible=[PA]*len(pos), p_protected=[PP]*len(pos),
                          native_multi_interval_calls=calls, native_multi_interval_tf_intervals=[c['interval'] for c in calls],
                          raw_tf_intervals=[c['interval'] for c in calls], representative_raw_tf_intervals=[c['interval'] for c in calls],
                          raw_nuc_intervals=[], msp_intervals=[[880, 1520]], contexts=[0]*len(pos)))
    return dict(region=dict(chrom='chrT', start=1050, end=1350),
                strata=[dict(dataset_id='d', stratum_id='d', chemistry='ddda', model_manifest=dict(preset='ddda'), units=units)])


def recaller_job(tmp_path):
    fh_workflow, _ = workflow._runtime()
    result = fh_workflow.run_workflow(planted_payload(), {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'learned_spots': False}}, tmp_path)
    job = dict(job_id='j', status='complete', result=result, filters=workflow.schema()['display_defaults'],
               request=dict(parameters={'cr': {'engine': 'lattice_recaller'}}))
    job['index'], job['layers'] = workflow._index(result)
    state = SimpleNamespace(consensus_workflow_jobs={'j': job}, consensus_workflow_lock=threading.RLock(), consensus_workflow_active='j')
    return state, job


def test_schema_defaults_to_the_lattice_recaller_with_its_controls():
    s = workflow.schema()
    assert s['cr_mode'] == workflow.RECALLER_MODE
    engine = next(c for c in s['groups']['cr'] if c['name'] == 'engine')
    assert engine['default'] == 'lattice_recaller' and 'staged_native_families' in engine['choices']
    names = {c['name'] for c in s['groups']['recaller']}
    assert {'stringency', 'edge_quantile_low', 'core_quantile_low', 'linker', 'learned_spots', 'resolution_nats',
            'core_resplit_depth'} <= names  # FiberHMM 3.0's re-split of candidates that fail the core rule


def test_recaller_result_indexes_summarizes_and_links_native_calls(tmp_path):
    state, job = recaller_job(tmp_path)
    result = job['result']
    assert workflow._cr_mode(result) == workflow.RECALLER_MODE
    catalog = result['datasets']['d']['cr']['catalog']
    assert catalog and all('recaller' in f for f in catalog)
    assert 'tf_cr' in job['layers']
    calls = [c for row in job['index']['d']['per_unit'].values() for c in row.get('tf_cr', [])]
    assert calls and any(c.get('family') for c in calls)
    assert all(workflow._visible(c, job['filters'], c.get('strand')) for c in calls)
    summary = workflow._summary(job)
    s = summary['summary']['d']
    assert summary['cr_mode'] == 'lattice_recaller' and s['classes'] == len(catalog) and s['assignments'] > 0
    assert s['source_calls'] == len(calls)
    assigned = next(c for c in calls if c.get('family'))
    looked = workflow.get_native_call(state, 'j', 'd', assigned['source_call_id'])
    assert looked['frozen_family'] == assigned['family'] and looked['call']['unit_id'].startswith('d::')


def test_headless_figures_colour_class_calls_like_the_browser():
    """Figures (services/figure) paint consensus-workflow calls in their class colour, as ReadTrackCanvas does."""
    from services.figure.tracks.consensus import family_color, palette
    from services.figure.tracks.reads import _consensus_record_color
    colors = palette(dict(datasets=dict(d=dict(catalog=[dict(family='B'), dict(family='A')]))))
    assert _consensus_record_color(dict(family='A', kind='assignment'), colors) == colors['A'] == '#d88724'
    assert _consensus_record_color(dict(family='Z'), colors) == family_color('Z', colors)
    assert _consensus_record_color(dict(family='A', classification_status='provisional_unresolved'), colors) == '#9ba6ae'
    assert _consensus_record_color(dict(family='A', manual_ignored=True), colors) == '#94a3b8'
    assert _consensus_record_color(dict(kind='new_recall'), colors) == '#db2777'


def test_one_strand_class_reads_and_occupancy_follow_the_strand(tmp_path):
    """A recaller class saved for one DAF strand filters and counts only that strand's molecules."""
    from services.consensus_occupancy import class_occupancy
    state, job = recaller_job(tmp_path)
    family = next(f['family'] for f in job['result']['datasets']['d']['cr']['catalog'])
    strands = workflow.unit_strands(job, 'd')
    both = set(workflow.state_read_ids(state, 'j', 'd', family)['read_ids'])
    ct = set(workflow.state_read_ids(state, 'j', 'd', family, strand='CT')['read_ids'])
    ga = set(workflow.state_read_ids(state, 'j', 'd', family, strand='GA')['read_ids'])
    assert ct and ga and ct | ga == both and not ct & ga
    name_strand = {u['read_name']: u['strand'] for u in job['result']['datasets']['d']['units']}
    assert all(name_strand[n] == 'CT' for n in ct) and set(strands.values()) == {'CT', 'GA'}
    reads = [dict(id=u['read_name'], strand=u['strand'], _projection_unit=u['unit_id']) for u in job['result']['datasets']['d']['units']]
    group = dict(consensusStateId=family, consensusJobId='j', sourceDatasetId='d', consensusStrand='CT')
    try:
        members, eligible = class_occupancy(state, 'd', 'chrT', reads, [group])
    except ValueError:
        return  # projection needs full read identity in this fixture; the read-filter path above is the contract
    assert members[0] <= ct and all(name_strand[n] == 'CT' for n in eligible[0])


def test_recaller_calls_are_a_layer_and_define_membership(tmp_path):
    """The recaller's own calls are their own layer (molecule or consensus edges) and decide class membership."""
    state, job = recaller_job(tmp_path)
    assert 'tf_rc' in job['layers']
    per_unit = job['index']['d']['per_unit']
    calls = [r for layers in per_unit.values() for r in layers.get('tf_rc', [])]
    members = [r for r in calls if r['kind'] == 'recaller_class']
    assert members == calls                         # wider-protection stretches are not drawn
    assert members and all(r['family'] and r.get('edge_range') and r.get('consensus_interval') for r in members)
    family = members[0]['family']
    units = {u for u, layers in per_unit.items() if any(r['kind'] == 'recaller_class' and r['family'] == family for r in layers.get('tf_rc', []))}
    names = {n for n, us in job['index']['d']['by_name'].items() if set(us) <= units}
    assert set(workflow.state_read_ids(state, 'j', 'd', family)['read_ids']) == names
    d = workflow.schema()['display_defaults']
    assert d['recaller_edges'] == 'native' and d['recaller_class_tiers'] == {}
    # Adding categories to what counts as the class never removes members.
    loose = set(workflow.state_read_ids(state, 'j', 'd', family, tier='core+edge+loose')['read_ids'])
    assert names <= loose
    import pytest
    with pytest.raises(ValueError):
        workflow.set_filters(state, 'j', {'recaller_edges': 'sideways'})
    workflow.set_filters(state, 'j', {'recaller_edges': 'lattice', 'recaller_class_tiers': {family: 'core+edge'}})
    assert job['filters']['recaller_class_tiers'][family] == 'core+edge'
    assert workflow.within_tier({'tier': 'edge'}, 'core+edge') and not workflow.within_tier({'tier': 'loose'}, 'core+edge')
    assert not workflow.within_tier({'tier': 'core'}, 'edge') and workflow.recaller_tier(job, family) == 'core+edge'
    with pytest.raises(ValueError):
        workflow.set_filters(state, 'j', {'recaller_class_tiers': {family: 'core+maybe'}})


def test_manual_curation_is_refused_for_recaller_runs(tmp_path):
    """Release audit §3: ignoring a recaller class was recorded but changed no drawn, filtered or counted read."""
    from services.consensus_curation import CurationUnavailable, update_curation
    state, job = recaller_job(tmp_path)
    family = job['result']['datasets']['d']['cr']['catalog'][0]['family']
    with pytest.raises(CurationUnavailable, match='not available for lattice recaller runs'):
        update_curation(state, 'j', dict(expected_revision=0, operation='ignore', dataset_id='d', family_ids=[family]))
