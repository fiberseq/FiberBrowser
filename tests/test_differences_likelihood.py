"""Hand-authored allele/noise/chemistry oracles, independent of extraction."""
from dataclasses import replace
import threading

import pytest

from services.background_work import Cancelled, cancel_scope
from services.differences.alleles import DafContext
from services.differences.likelihood import LikelihoodBudget, LikelihoodPolicy, compete
from services.reconstruction_budget import RESERVATIONS


@pytest.fixture(autouse=True)
def isolated_reservation_accounting():
    # Other suites legitimately retain a charged numerical worker. These tests
    # assert zero outstanding reservations for their own sequence likelihoods.
    from services.reconstruction_budget import close_warm_worker
    close_warm_worker()
    yield
    close_warm_worker()


def run(observed, candidates, *, chemistry="none", **kwargs):
    return compete(observed, candidates, target_id="target", complete=True,
                   context=DafContext(chemistry, "synthetic-observation"), **kwargs)


@pytest.mark.parametrize("observed,assignment", [("A" * 100, "target"), ("C" * 100, "other_allele"), ("", "reference")])
def test_same_size_distinct_alleles_and_reference_are_independent(observed, assignment):
    result = run(observed, {"target": "A" * 100, "competitor": "C" * 100, "reference": ""})
    assert result["call"]["assignment"] == assignment
    assert result["call"]["method"] == "exact_sequence"
    assert result["call"]["level"] == "confirmed"


def test_sequence_free_partial_preview_and_missing_competitors_do_not_assign():
    candidates = {"target": "A" * 1000, "reference": ""}
    for observed, complete, expected in [(None, False, candidates), ("A" * 60, False, candidates),
                                         ("A" * 1000, True, {**candidates, "competitor": None})]:
        result = compete(observed, expected, target_id="target", complete=complete, context=DafContext("none", "test"))
        assert result["call"]["assignment"] == "unknown"


@pytest.mark.parametrize("chemistry,target,converted", [("CT", "ACCCG", "ATTTG"), ("GA", "TGGGC", "TAAAC")])
def test_daf_channel_tolerates_conversion_without_exact_equality(chemistry, target, converted):
    result = run(converted, {"target": target, "reference": "GGTTT" if chemistry == "CT" else "CCAAG"}, chemistry=chemistry)
    assert result["call"]["assignment"] == "target"
    assert result["call"]["method"] == "sequence_likelihood"
    assert result["call"]["level"] == "putative"
    assert result["call"]["reasons"] == ("uncalibrated_likelihood_profile",)


@pytest.mark.parametrize("chemistry,a,b", [("CT", "ACG", "ATG"), ("GA", "TGC", "TAC")])
def test_conversion_only_true_variants_tie_until_unconverted_diagnostic_recovers(chemistry, a, b):
    candidates = {"target": a, "competitor": b, "reference": ""}
    assert run(b, candidates, chemistry=chemistry)["call"]["assignment"] == "ambiguous"
    # One unconverted donor is only ~30:1 at these engineering rates. Repeated
    # independent diagnostics supply enough odds; chemistry is never erased.
    result = run(a * 4, {k: v * 4 for k, v in candidates.items()}, chemistry=chemistry)
    assert result["call"]["assignment"] == "target"


def test_reverse_complement_changes_matrix_once_without_renaming_chemistry():
    comp = lambda seq: seq.translate(str.maketrans("ACGT", "TGCA"))[::-1]
    candidates, observed = {"target": "AACCCG", "reference": "GGTTTA"}, "AATTTG"
    forward = run(observed, candidates, chemistry="CT")
    reverse = compete(comp(observed), {k: comp(v) for k, v in candidates.items()}, target_id="target", complete=True,
                      context=DafContext("CT", "synthetic", reverse_complemented=True))
    assert reverse["call"]["assignment"] == forward["call"]["assignment"]
    assert reverse["scores"]["target"]["log_likelihood"] == pytest.approx(forward["scores"]["target"]["log_likelihood"])
    assert reverse["context"]["chemistry"] == "CT"


def test_unknown_chemistry_is_unresolved_and_quality_changes_evidence():
    candidates = {"target": "ACGT" * 5, "reference": "T" * 20}
    assert run(candidates["target"], candidates, chemistry="unknown")["call"]["assignment"] == "unknown"
    scores = []
    for quality in (10, 40):
        result = compete("ACGT" * 5, candidates, target_id="target", complete=True,
                         context=DafContext("none", "synthetic", base_qualities=(quality,) * 20))
        scores.append(result["scores"]["target"]["log_likelihood"])
    assert scores[1] > scores[0]


def test_ont_indels_and_substitutions_remain_likelihood_with_explicit_fit_guard():
    target = "ACGT" * 15
    observed = target[:10] + "A" + target[10:30] + target[31:44] + "C" + target[45:]
    result = run(observed, {"target": target, "reference": "T" * 60})
    assert result["call"]["assignment"] == "target"
    assert result["call"]["level"] == "putative"
    assert result["scores"]["target"]["noise_edits"] == 3
    bad = run("C" * 60, {"target": "A" * 60, "reference": "T" * 60})
    assert bad["call"]["assignment"] in {"unknown", "ambiguous"}


def test_preflight_refuses_before_score_allocation_and_aggregate_work_is_shared(monkeypatch):
    import services.differences.likelihood as module
    def forbidden(*args):
        raise AssertionError("alignment entered before preflight")
    monkeypatch.setattr(module, "_score", forbidden)
    result = run("A" * 100_000, {"target": "C" * 100_000, "reference": ""})
    assert result["resource"]["reason"] == "likelihood_pair_cells"
    assert RESERVATIONS.bytes == 0


def test_request_caps_and_cancellation_release_reservations():
    policy = LikelihoodPolicy(max_request_cells=100)
    budget = LikelihoodBudget(policy)
    first = run("AAA", {"target": "AAA", "reference": "CCC"}, chemistry="CT", policy=policy, budget=budget)
    assert first["call"]["assignment"] == "target"
    for _ in range(3):
        final = run("AAA", {"target": "AAA", "reference": "CCC"}, chemistry="CT", policy=policy, budget=budget)
    assert final["resource"]["reason"] == "likelihood_request_cells"
    event = threading.Event()
    event.set()
    with cancel_scope(event), pytest.raises(Cancelled):
        run("ACG", {"target": "ACG", "reference": ""})
    assert RESERVATIONS.bytes == 0


def test_held_out_noisy_competition_reports_engineering_not_biological_calibration():
    # Different lengths and phase from all hand-authored examples. Every expected
    # allele is directly authored; no production extractor supplies the oracle.
    import random
    rng = random.Random(91671)
    correct = 0
    for i in range(24):
        allele = "".join(rng.choice("ACGT") for _ in range(72 + i))
        other = "".join(rng.choice("ACGT") for _ in range(len(allele)))
        noisy = allele[:17] + allele[18:40] + "A" + allele[40:]
        result = run(noisy, {"target": allele, "other": other, "reference": ""})
        correct += result["call"]["assignment"] == "target"
        assert result["call"]["level"] == "putative"
        assert result["policy"]["calibration_id"] is None
    assert correct == 24


def test_conversion_policy_is_default_and_molecule_rate_overrides_it():
    candidates = {"target": "CCCG", "reference": "AAAA"}
    def score(policy_rate, context_rate=None):
        context = DafContext("CT", "synthetic", conversion_rate=context_rate)
        result = compete("TTTG", candidates, target_id="target", complete=True,
                         context=context, policy=LikelihoodPolicy(conversion_rate=policy_rate))
        return result["scores"]["target"]["log_likelihood"]
    assert score(.99) > score(.01)
    assert score(.99, .4) == score(.01, .4)
    assert run("TTTG", candidates, chemistry="CT", policy=LikelihoodPolicy(conversion_rate=.99))["scores"] != run(
        "TTTG", candidates, chemistry="CT", policy=LikelihoodPolicy(conversion_rate=.01))["scores"]


def test_prefix_suffix_and_empty_allele_insertions_have_equal_emission_cost():
    import math
    from services.differences.likelihood import _score
    policy = LikelihoodPolicy()
    context = DafContext("none", "synthetic")
    prefix = _score("A" * 10 + "G", "G", context, policy, LikelihoodBudget(policy))
    suffix = _score("G" + "A" * 10, "G", context, policy, LikelihoodBudget(policy))
    empty = _score("A" * 10, "", context, policy, LikelihoodBudget(policy))
    assert prefix == pytest.approx(suffix)
    assert empty == pytest.approx((10 * math.log(policy.indel_rate / 4), 10))


def test_exact_long_sequences_skip_alignment_but_keep_limits_and_quality_guards(monkeypatch):
    import services.differences.likelihood as module
    monkeypatch.setattr(module, "_score", lambda *args: pytest.fail("exact assignment ran DP"))
    policy = LikelihoodPolicy(max_pair_cells=1, max_request_cells=1)
    budget = LikelihoodBudget(policy)
    for _ in range(20):
        result = run("A" * 100_000, {"target": "A" * 100_000, "reference": ""}, policy=policy, budget=budget)
        assert result["call"]["assignment"] == "target" and result["call"]["level"] == "confirmed"
    assert budget.cells == 0
    assert run("A" * 100_001, {"target": "A" * 100_001, "reference": ""})["resource"]["reason"] == "likelihood_bases"


def test_long_daf_diagnostics_use_certified_band_with_shared_work_budget():
    policy = LikelihoodPolicy()
    budget = LikelihoodBudget(policy)
    for _ in range(20):
        result = run("A" * 4000, {"target": "A" * 4000, "reference": ""}, chemistry="CT", policy=policy, budget=budget)
        assert result["call"]["assignment"] == "target"
    assert 0 < budget.cells < policy.max_request_cells


@pytest.mark.parametrize("chemistry,reverse", [("none", False), ("CT", False), ("GA", False), ("CT", True), ("GA", True)])
def test_banded_scores_equal_independent_full_matrix_oracle(chemistry, reverse):
    import math
    import random
    from services.differences.likelihood import _band, _score
    rng = random.Random(84834)
    policy = LikelihoodPolicy()
    for _ in range(100):
        observed = "".join(rng.choices("ACGT", k=rng.randrange(12)))
        expected = "".join(rng.choices("ACGT", k=rng.randrange(12)))
        # Independent full-matrix likelihood and minimum-noise tie break.
        donor, converted = ("C", "T") if chemistry == "CT" else ("G", "A")
        if reverse:
            donor, converted = donor.translate(str.maketrans("ACGT", "TGCA")), converted.translate(str.maketrans("ACGT", "TGCA"))
        def probability(e, o):
            if chemistry != "none" and e == donor:
                return .1 * (.99 if o == donor else .01/3) + .9 * (.99 if o == converted else .01/3)
            return .99 if e == o else .01/3
        matrix = [[(0., 0)] * (len(expected) + 1) for _ in range(len(observed) + 1)]
        for i in range(1, len(observed) + 1):
            matrix[i][0] = (i * math.log(policy.indel_rate / 4), i)
        for j in range(1, len(expected) + 1):
            matrix[0][j] = (j * math.log(policy.indel_rate), j)
        for i, o in enumerate(observed, 1):
            for j, e in enumerate(expected, 1):
                noise = e != o and not (chemistry != "none" and e == donor and o == converted)
                options = [(matrix[i-1][j-1][0] + math.log(probability(e, o)), matrix[i-1][j-1][1] + noise),
                           (matrix[i-1][j][0] + math.log(.02/4), matrix[i-1][j][1] + 1),
                           (matrix[i][j-1][0] + math.log(.02), matrix[i][j-1][1] + 1)]
                matrix[i][j] = max(options, key=lambda v: (v[0], -v[1]))
        context = DafContext(chemistry, "synthetic", reverse_complemented=reverse)
        budget = LikelihoodBudget(policy)
        band = _band(observed, expected, context, policy, budget)
        assert _score(observed, expected, context, policy, budget, band) == pytest.approx(matrix[-1][-1])
