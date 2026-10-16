"""Per-read states of selected features (footprint classes) for the read panel's Cluster, Sort and Filter: the
engine's own states, per dataset and read name, with '.' for reads a feature did not evaluate."""
from types import SimpleNamespace

import pytest

from services import consensus_workflow as cw
from services.feature_states import MAX_FEATURES, feature_states


def test_bad_requests_are_refused_with_a_reason():
    state = SimpleNamespace()
    with pytest.raises(ValueError, match='list of features'):
        feature_states(state, [])
    with pytest.raises(ValueError, match='dataset_id'):
        feature_states(state, [dict(kind='fp-class', source='x', id='A')])
    with pytest.raises(ValueError, match='At most'):
        feature_states(state, [dict(kind='fp-class', source='x', id='A', dataset_id='d')] * (MAX_FEATURES + 1))
    with pytest.raises(ValueError, match='kind'):
        feature_states(state, [dict(kind='no-such-kind', source='x', id='A')])


def _class_job(state, monkeypatch):
    jobs, _ = cw._session(state)
    jobs['j'] = {'status': 'complete', 'filters': {}, 'result': {'manifest': {'region': {'chrom': 'chrT'}}},
                 'index': {'d': {'by_name': {'r1': ['u1'], 'r2': ['u2'], 'r3': ['u3'], 'twice': ['u4', 'u5']},
                                 'per_unit': {
                                     'u1': {'tf_cr': [{'family': 'A'}]},
                                     'u2': {'tf_cr': [{'family': 'B'}]},
                                     'u3': {'tf_cr': [{'family': 'A', 'classification_status': 'provisional_unresolved'}]},
                                     'u4': {'tf_cr': [{'family': 'A'}]},
                                     'u5': {'tf_cr': [{'family': 'B'}]},
                                 }}}}
    monkeypatch.setattr(cw, '_visible', lambda *args: True)
    # A name with two alignments matches neither (as an ambiguous identity does).
    monkeypatch.setattr(cw, '_match_projection_unit', lambda index, read:
                        (index['by_name'][read['id']][0] if len(index['by_name'].get(read['id'], ())) == 1 else None, '', 0))


def test_class_states_are_exact_primary_membership(monkeypatch):
    state = SimpleNamespace()
    _class_job(state, monkeypatch)
    out = feature_states(state, [dict(kind='fp-class', source='j', id='A', dataset_id='d'),
                                 dict(kind='fp-class', source='j', id='B', dataset_id='d')])
    assert out['by_dataset'] == {'d': {'r1': '10', 'r2': '01', 'r3': '00', 'twice': '..'}}
    assert out['features'][0]['members'] == {'d': 1} and out['features'][0]['evaluated'] == {'d': 3}
    with pytest.raises(ValueError, match='not from dataset'):
        feature_states(state, [dict(kind='fp-class', source='j', id='A', dataset_id='other')])
    with pytest.raises(ValueError, match='not available'):
        feature_states(state, [dict(kind='fp-class', source='gone', id='A', dataset_id='d')])
