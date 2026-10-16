"""BigBed datasets / no native replay with the default lattice recaller (release audit §2).

Following the old error advice ("disable native replay to use existing BigBed TF calls") produced a recaller run
that 'completed' with 0 classes and no warning. The run is now refused before any work, naming the alternatives."""
from types import SimpleNamespace

import pytest

from services import consensus_workflow as cw


def _state(data_type):
    ds = SimpleNamespace(data_type=data_type, label='Sample A', family_scan_chemistry='ddda', paths=['/nonexistent.bam'], path='/nonexistent.bam')
    return SimpleNamespace(get_dataset=lambda _: ds)


REQUEST = dict(dataset_ids=['a'], chrom='chrT', start=1000, end=2000)


def test_recaller_refuses_bigbed_input_before_running():
    with pytest.raises(ValueError, match='Sample A: The lattice recaller .* needs the BAM') as error:
        cw.submit(_state('bigbed'), dict(REQUEST))
    assert 'Staged Monte Carlo' in str(error.value)


def test_recaller_refuses_disabled_native_replay():
    request = dict(REQUEST, parameters={'input': {'correct_native': False}})
    with pytest.raises(ValueError, match='Replay corrected native TF decoder'):
        cw.submit(_state('bam'), request)


def test_staged_engine_may_use_bigbed_calls_without_replay():
    _, parameters = cw._runtime()
    options = parameters.parse_options({'cr': {'engine': cw.STAGED_MODE}, 'input': {'correct_native': False}})
    cw.recaller_preflight(_state('bigbed'), ['a'], options)      # no error: the staged engine reads existing calls


def test_planted_payload_without_replayed_calls_finds_nothing(tmp_path):
    """Why the preflight exists: the recaller discovers classes only from replayed native calls."""
    from test_consensus_lattice_recaller import planted_payload
    payload = planted_payload()
    for unit in payload['strata'][0]['units']:
        unit['native_multi_interval_calls'] = []
    workflow, _ = cw._runtime()
    # FiberHMM 3 refuses this combination itself (it used to 'complete' with 0 classes).
    with pytest.raises(ValueError, match='correct_native=false is not supported by the lattice recaller'):
        workflow.run_workflow(payload, {'cr': {'engine': 'lattice_recaller'}, 'recaller': {'learned_spots': False},
                                        'input': {'correct_native': False}}, tmp_path)


def _bigbed_ddda(monkeypatch):
    """A DddA BigBed dataset whose m5c companion carries DddA mCG spans (the ddda_mcg layer), with evidence loading
    stubbed out (no reads): only the mCG conditioning decision is exercised."""
    import numpy as np
    from services import consensus_evidence
    model = SimpleNamespace(emissionprob_=np.zeros((2, 4)))
    monkeypatch.setattr(consensus_evidence, '_runtime', lambda: {'collapse': lambda reads, **_: (reads, dict(raw_reads=0, analyzed_molecules=0))})
    monkeypatch.setattr(consensus_evidence, '_load_dataset_evidence', lambda *a, **k: ([], model, {}, {}))
    ds = SimpleNamespace(data_type='bigbed', label='DddA bb', consensus_chemistry='ddda', paths=['/x.bb'], path='/x.bb',
                         available_layers={'tf': True, 'ddda_mcg': True})
    return SimpleNamespace(get_dataset=lambda _: ds)


def test_bigbed_ddda_mcg_conditioning_is_skipped_with_a_warning_by_default(monkeypatch):
    """Integrator note (fb-v216 makes m5c BigBeds report ddda_mcg): the default-on mCG correction must not make a
    DddA BigBed run fail; it runs without it and says so."""
    _, parameters = cw._runtime()
    options = parameters.parse_options({'cr': {'engine': cw.STAGED_MODE}, 'input': {'correct_native': False}})
    payload = cw.load_payload(_bigbed_ddda(monkeypatch), dict(dataset_ids=['a'], chrom='chrT', start=0, end=500),
                              options, lambda *a, **k: None)
    assert len(payload['browser_warnings']) == 1 and 'mCG conditioning was skipped' in payload['browser_warnings'][0]
    assert payload['strata'][0]['model_manifest']['m5c_conditioned_opportunities'] == 0


def test_bigbed_ddda_mcg_conditioning_explicitly_requested_is_refused(monkeypatch):
    _, parameters = cw._runtime()
    options = parameters.parse_options({'cr': {'engine': cw.STAGED_MODE}, 'input': {'correct_native': False, 'ddda_m5c_correction': True}})
    with pytest.raises(ValueError, match='needs BAM query coordinates'):
        cw.load_payload(_bigbed_ddda(monkeypatch), dict(dataset_ids=['a'], chrom='chrT', start=0, end=500,
                                                         explicit_parameters=['input.ddda_m5c_correction']),
                        options, lambda *a, **k: None)
