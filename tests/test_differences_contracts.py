"""Independent string/count/identity oracles for the unified contract spike."""
from dataclasses import asdict
import json

import pytest

from services.differences.alleles import diagnostic_assignment, transition_probability
from services.differences.calls import (Call, Hypothesis, MembershipIndex, MoleculeId,
    Representation, reconcile_hypotheses, reconcile_representations, witness_id)
from services.differences.identity import IdentityLedger, digest_file, exact_local_allele_id, observation_id
from services.differences.model import Difference, Geometry, Sequence, Span
from services.differences.policy import SearchBudget, SearchPolicy


def test_payload_empty_deletion_and_replacement_keep_independent_spans():
    deleted = Difference('d', 1, 'assembly', 'ref-content', Geometry(Span('chrT', 10, 110), 0, 'deletion'),
                         Sequence('available', 0, ''), ('obs',))
    payload = json.loads(json.dumps(deleted.payload()))
    assert payload['exact_allele_id'] is None
    assert payload['sequence']['preview'] == ''
    assert payload['geometry']['net_bp'] == -100
    replacement = Geometry(Span('chrT', 10, 14), 792, 'replacement').payload()
    assert (replacement['ref_bp'], replacement['alt_bp'], replacement['net_bp']) == (4, 792, 788)


def test_map_only_adapter_preserves_occurrence_identity_without_read_votes():
    from services.differences.assembly import assembly_difference
    ledger = IdentityLedger()
    item = {'id': 'old-marker', 'hap': 'assembly#1', 'hap_label': 'label', 'chain': 7, 'strand': '-',
            'src': {'contig': 'source', 'start': 20, 'end': 812}, 't_start': 100, 't_end': 104,
            'kind': 'replacement', 'alt_bp': 792, 'alt': 'A' * 60, 'alt_truncated': True}
    args = dict(reference_id='ref-content', map_content_id='map-content', target_contig='chrT', ledger=ledger)
    first = assembly_difference(item, **args)
    second = assembly_difference({**item, 'hap_label': 'renamed', 'alt': 'A' * 792, 'alt_truncated': False}, **args)
    assert first['difference']['difference_id'] == second['difference']['difference_id']
    assert first['difference']['sequence']['status'] == 'partial'
    assert second['difference']['sequence']['status'] == 'available'
    assert second['difference']['exact_allele_id'] is None  # sequence availability alone is not canonicalization
    assert second['difference']['source'] == 'assembly'
    assert 'calls_by_molecule' not in second


@pytest.mark.parametrize('args', [('partial', 100, 'A', 'digest'), ('available', None), ('available', 100, 'A' * 61)])
def test_previews_and_missing_sequence_cannot_claim_full_identity(args):
    with pytest.raises(ValueError):
        Sequence(*args)


def test_content_ids_trim_padding_and_do_not_encode_display_kind():
    identity = lambda start, r, a, version='1': exact_local_allele_id('ref-digest', 'chrT', start, r, a, normalization=version)
    assert identity(10, 'ACG', 'ATG') == identity(11, 'C', 'T')
    assert identity(11, 'C', '') != identity(11, 'C', 'T')
    assert identity(11, 'C', 'T') != identity(11, 'C', 'T', '2')
    with pytest.raises(ValueError):
        identity(11, 'N', 'A')


def test_verified_content_identity_survives_relocation_touch_and_cache_eviction(tmp_path):
    import os
    from services.differences import identity
    original, relocated = tmp_path / 'original', tmp_path / 'relocated'
    original.write_bytes(b'public synthetic immutable content')
    expected = digest_file(original)
    relocated.write_bytes(original.read_bytes())
    os.utime(relocated, (1, 1))
    assert digest_file(relocated) == expected
    identity._digests.clear()
    assert digest_file(relocated) == expected
    relocated.write_bytes(b'different content')
    assert digest_file(relocated) != expected


def test_ledger_order_eviction_resolution_merge_split_and_relocation():
    ledger = IdentityLedger()
    a, b = (observation_id('immutable-data', 'record-' + s, 'op') for s in ('a', 'b'))
    parent = ledger.register('native', [a, b], {'geometry': [10, 10, 100], 'members': ['m1'], 'policy': {'putative': False}})
    saved = json.loads(json.dumps(ledger.payload()))
    cold = IdentityLedger(saved)
    assert cold.register('native', [b, a], {'locator': 'relocated'}) == parent
    exact = exact_local_allele_id('ref', 'chrT', 10, '', 'AC', normalization='1')
    cold.resolve_exact(parent, exact)
    assert cold.data['records'][parent]['exact_allele_id'] == exact
    children = [cold.register('native', [o], {'members': [m]}) for o, m in ((a, 'm1'), (b, 'm2'))]
    cold.retire([parent], children, reason='cluster_split')
    assert cold.lookup(parent)['snapshot']['members'] == ['m1']
    assert cold.lookup(parent, frozen=False)['status'] == 'unresolved_split'
    assert cold.lookup('evicted-unsaved')['status'] == 'unresolved'
    merged = cold.register('new-grouping-version', [a, b], {'members': ['m1', 'm2']})
    cold.retire(children, [merged], reason='merge')
    restored = IdentityLedger(json.loads(json.dumps(cold.payload())))
    assert restored.lookup(parent)['snapshot'] == saved['snapshots'][parent]
    with pytest.raises(ValueError):
        restored.retire([merged], [parent], reason='cycle')


@pytest.mark.parametrize('other,assignment,reason,complete', [
    (Call('target', 'confirmed'), 'target', None, True),
    (Call('target', 'putative'), 'target', None, True),
    (Call('reference', 'confirmed'), 'ambiguous', 'cross_representation_disagreement', True),
    (Call(), 'ambiguous', 'unresolved_representation', True),
    (Call('unavailable', reasons=('missing_map',)), 'target', None, False),
])
def test_representation_truth(other, assignment, reason, complete):
    copies = [Representation('n', 'native', Call('target', 'confirmed', witness_ids=('physical',))),
              Representation('l', 'lifted', other)]
    result = reconcile_representations(copies, scope='combined')
    assert result['call']['assignment'] == assignment
    assert result['complete'] == complete
    if reason:
        assert reason in result['call']['reasons']
    assert reconcile_representations(copies, scope='native_only')['call']['assignment'] == 'target'
    if other.level == 'putative':
        assert result['call']['level'] == 'putative'


@pytest.mark.parametrize('source', ['native', 'lifted'])
def test_incomplete_viable_representation_cannot_prove_unconditional_agreement(source):
    copies = [Representation('n', 'native', Call('target', 'confirmed', reasons=('native_diagnostic',)), complete=source != 'native'),
              Representation('l', 'lifted', Call('target', 'confirmed', reasons=('lifted_diagnostic',)), complete=source != 'lifted')]
    result = reconcile_representations(copies, scope='combined')
    assert result['complete'] is False
    assert result['call']['assignment'] == 'ambiguous'
    assert set(result['call']['reasons']) >= {'incomplete_representation_scope', 'native_diagnostic', 'lifted_diagnostic'}


def test_missing_or_ineligible_copy_preserves_independent_native_call():
    native = Representation('n', 'native', Call('target', 'confirmed'))
    for others in ([], [Representation('l', 'lifted', Call('unavailable', reasons=('missing_map',)))],
                   [Representation('l', 'lifted', Call('reference', 'confirmed'), admissible=False)],
                   [Representation('l', 'lifted', Call('reference', 'confirmed'), authoritative=False)]):
        result = reconcile_representations([native, *others], scope='combined')
        assert result['call']['assignment'] == 'target'
        assert result['call']['level'] == 'confirmed'
        assert result['complete'] is False


@pytest.mark.parametrize('other,reason', [(Call('reference', 'confirmed', reasons=('reference_diagnostic',)), 'cross_representation_disagreement'),
                                         (Call(reasons=('partial_window',)), 'unresolved_representation')])
def test_reconciliation_preserves_constituent_reasons(other, reason):
    result = reconcile_representations([Representation('n', 'native', Call('target', 'confirmed', reasons=('target_diagnostic',))),
                                        Representation('l', 'lifted', other)], scope='combined')
    assert set(result['call']['reasons']) == {reason, 'target_diagnostic', *other.reasons}


@pytest.mark.parametrize('chemistry', ['none', 'CT', 'GA'])
@pytest.mark.parametrize('competitor,reason', [(None, 'diagnostic_sequence_unavailable'), ('ACNT', 'ambiguous_bases')])
def test_unresolved_competitor_sequence_cannot_exclude_an_allele(chemistry, competitor, reason):
    result = diagnostic_assignment('ACGT', {'target': 'ACGT', 'reference': competitor},
                                   target_id='target', complete=True, chemistry=chemistry)
    assert result.assignment == 'unknown'
    assert result.reasons == (reason,)


def test_physical_evidence_deduplicates_before_qualified_row_fanout():
    a = MoleculeId('sample', 'library-a', 'same|name')
    b = MoleculeId('sample', 'library-b', 'same|name')
    assert a.key != b.key
    witness = witness_id(a, 'original-record-lineage', 100, 200)
    calls = [Representation(str(i), source, Call('target', 'confirmed', witness_ids=(witness,)))
             for i, source in enumerate(('native', 'lifted', 'lifted'))]
    result = reconcile_representations(calls, scope='combined')
    assert result['call']['witness_ids'] == (witness,)
    index = MembershipIndex()
    index.add('dataset', 'row-a', a, analysis_id='analysis-a')
    index.add('dataset', 'row-b', a)
    index.add('dataset', 'row-c', b)
    assert set(index.fan_out('dataset', {a.key: result})) == {'row-a', 'analysis-a', 'row-b'}
    assert index.payload()['legacy_aliases']['dataset'] == {}
    assert index.fan_out('unrelated-dataset', {a.key: result}) == {}


@pytest.mark.parametrize('assignment', ['target', 'reference'])
@pytest.mark.parametrize('kind', ['hypotheses', 'path_states', 'transitions'])
def test_retained_agreement_cannot_prove_unexplored_outcomes(assignment, kind):
    policy = SearchPolicy(max_hypotheses=1, max_path_states=1, max_transitions=1)
    search = SearchBudget(policy)
    assert search.admit(kind)
    assert not search.admit(kind)
    h = Hypothesis('retained', Call(assignment, 'confirmed'), 'primary')
    result = reconcile_hypotheses([h], primary_complete=True, search=search.payload())
    assert result['call']['assignment'] == 'ambiguous'
    assert 'incomplete_hypothesis_search' in result['call']['reasons']
    assert search.payload()['pruned'][kind] == 1


def test_complete_primary_is_independent_of_secondary_diagnostics_and_caps():
    hs = [Hypothesis('primary', Call('target', 'confirmed'), 'primary'),
          Hypothesis('secondary', Call('reference', 'confirmed'), 'secondary')]
    search = SearchBudget(SearchPolicy(max_hypotheses=1))
    search.admit('hypotheses')
    search.admit('hypotheses', ownership='secondary')
    assert reconcile_hypotheses(hs, primary_complete=True, search=search.payload())['call']['assignment'] == 'target'
    assert reconcile_hypotheses(hs, primary_complete=False)['call']['assignment'] == 'ambiguous'
    # Two one-flank alternatives stay unknown, never form a joint deletion.
    assert reconcile_hypotheses([Hypothesis('left', Call()), Hypothesis('right', Call())])['call']['assignment'] == 'unknown'


def test_sequence_competition_is_independent_of_geometry_and_preview():
    candidates = {'A': 'A' * 100, 'C': 'C' * 100, 'reference': ''}
    a = diagnostic_assignment('A' * 100, candidates, target_id='A', complete=True, chemistry='none')
    c = diagnostic_assignment('C' * 100, candidates, target_id='A', complete=True, chemistry='none')
    assert (a.assignment, a.level, c.assignment, c.allele_id) == ('target', 'confirmed', 'other_allele', 'C')
    assert diagnostic_assignment('A' * 60, candidates, target_id='A', complete=False).assignment == 'unknown'
    assert diagnostic_assignment(None, candidates, target_id='A', complete=False).assignment == 'unknown'
    assert diagnostic_assignment('A' * 99, candidates, target_id='A', complete=True).assignment == 'unknown'  # ONT noise awaits calibration


def test_structural_assignment_requires_one_complete_diagnostic_path():
    from dataclasses import replace
    from services.differences.alleles import StructuralProof
    proof = StructuralProof('target', 'synthetic-oracle:v1', 2, True, True, True, True)
    result = diagnostic_assignment(None, {}, target_id='target', complete=False, structural_path=proof)
    assert result.assignment == 'target' and result.method == 'structural_path'
    for partial in (replace(proof, observed_flanks=1), replace(proof, competing_paths_excluded=False),
                    replace(proof, compatible_path=False), replace(proof, search_complete=False), True):
        assert diagnostic_assignment(None, {}, target_id='target', complete=False, structural_path=partial).assignment == 'unknown'


@pytest.mark.parametrize('chemistry,donor,converted', [('CT', 'C', 'T'), ('GA', 'G', 'A')])
def test_daf_conversion_ties_and_complemented_matrix(chemistry, donor, converted):
    complement = str.maketrans('ACGT', 'TGCA')
    p = transition_probability(donor, converted, chemistry=chemistry)
    assert p > .8
    assert p == transition_probability(donor.translate(complement), converted.translate(complement),
                                       chemistry=chemistry, reverse_complemented=True)
    assert transition_probability(donor, converted, chemistry='GA' if chemistry == 'CT' else 'CT') < .01
    candidates = {'target': donor, 'competitor': converted}
    result = diagnostic_assignment(converted, candidates, target_id='target', complete=True, chemistry=chemistry)
    assert result.assignment == 'ambiguous'
    assert diagnostic_assignment(donor, candidates, target_id='target', complete=True, chemistry=chemistry).assignment == 'target'
    assert diagnostic_assignment(donor, candidates, target_id='target', complete=True, chemistry='unknown').assignment == 'unknown'
