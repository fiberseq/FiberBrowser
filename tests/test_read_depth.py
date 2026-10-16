"""Read-cap compatibility and forwarding without expensive inference."""
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from services.read_depth import NAMES, depth_parameters


@pytest.mark.parametrize('supported', [False, True])
def test_depth_zero_preserves_old_parameters(supported):
    assert depth_parameters(dict(stringency=.9, max_discovery_molecules=0,
                                 max_quantification_molecules=0, sample_seed=9), supported) == dict(stringency=.9)


@pytest.mark.parametrize('value', [-1, 1.5, True, '2000'])
def test_depth_requires_nonnegative_integer(value):
    with pytest.raises(ValueError, match='non-negative integer'):
        depth_parameters(dict(max_discovery_molecules=value), True)


def test_depth_unsupported_rejected():
    with pytest.raises(ValueError, match='Update FiberHMM'):
        depth_parameters(dict(max_quantification_molecules=2000), False)


@pytest.mark.parametrize('cap', [0, 2000])
def test_depth_consensus_reaches_engine(monkeypatch, tmp_path, cap):
    from services import consensus_workflow as cw
    from state.browser_state import BrowserState
    from test_session_consensus_runs import _bam
    state = BrowserState(None)
    state.add_dataset('d', str(_bam(tmp_path)))
    engine, params = cw._runtime()
    real_parse, real_schema = params.parse_options, params.parameter_schema
    def schema():
        groups = real_schema()
        groups['recaller'] += [dict(name=n) for n in NAMES if n not in {c['name'] for c in groups['recaller']}]
        return groups
    def parse(p):
        # Simulate a newer engine even when the test installation predates caps.
        copy = {**p, 'recaller': {k:v for k,v in p.get('recaller', {}).items() if k not in NAMES}}
        return real_parse(copy)
    monkeypatch.setattr(params, 'parameter_schema', schema)
    monkeypatch.setattr(params, 'parse_options', parse)
    monkeypatch.setattr(cw, 'schema', lambda: dict(display_defaults={}))
    monkeypatch.setattr(cw, 'load_payload', lambda *a: dict(strata=[dict(dataset_id='d', units=[dict(unit_id='u')])]))
    called = Mock(side_effect=RuntimeError('stop after engine boundary'))
    monkeypatch.setattr(engine, 'run_analysis', called)
    monkeypatch.setattr(cw, '_summary', lambda j: j)
    request = dict(dataset_ids=['d'], chemistry_overrides={'d':'ddda'}, chrom='chrT', start=100, end=200,
                   parameters=dict(cr=dict(engine='lattice_recaller'), recaller=dict(max_discovery_molecules=cap,
                                   max_quantification_molecules=cap, sample_seed=7)))
    job = cw.submit(state, request)
    job['_future'].result(timeout=10)
    sent = called.call_args.args[1]['recaller']
    assert {n:sent[n] for n in NAMES if n in sent} == (dict(zip(NAMES, (cap, cap, 7))) if cap else {})
    assert job['request']['parameters']['recaller'] == sent
