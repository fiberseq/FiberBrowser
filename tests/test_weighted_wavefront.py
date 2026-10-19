"""Independent global-score oracle; no production alignment as expected truth."""
import random

import numpy as np
import pytest

from services.insertion_consensus import encode
from services.weighted_wavefront import weighted_wavefront


def optimal_score(a, b, band=None):
    negative = -1_000_000
    previous = [-i if band is None or i <= band else negative for i in range(len(b) + 1)]
    for i, x in enumerate(a, 1):
        center = i * len(b) // len(a)
        current = [-i if band is None or center <= band else negative]
        for j, y in enumerate(b, 1):
            if band is not None and abs(j - center) > band:
                current.append(negative)
                continue
            current.append(max(previous[j - 1] + (1 if x == y and x in 'ACGT' else -1),
                               previous[j] - 1, current[j - 1] - 1))
        previous = current
    return previous[-1]


def test_scaled_band_respects_the_independent_constrained_score_oracle():
    rng = random.Random(229)
    for _ in range(300):
        a = ''.join(rng.choices('ACGT', k=rng.randrange(1, 20)))
        b = ''.join(rng.choices('ACGT', k=rng.randrange(1, 20)))
        band = rng.randrange(1, 6)
        expected = optimal_score(a, b, band)
        ops, status, _states = weighted_wavefront(encode(a), encode(b), 160, 100_000, band)
        if expected < -1000:
            assert status == 1
            continue
        assert status == 0, (a, b, band, expected)
        i = j = score = 0
        for op in ops:
            if op == 0:
                score += 1 if a[i] == b[j] else -1
                i += 1
                j += 1
            elif op == 1:
                score -= 1
                j += 1
            else:
                score -= 1
                i += 1
            assert abs(j - i * len(b) // len(a)) <= band
        assert score == expected, (a, b, band, score, expected)


def test_wavefront_has_independently_optimal_score_and_full_coordinate_consumption():
    rng = random.Random(1123)
    cases = [('', ''), ('', 'ACG'), ('ACGT', ''), ('ACGNT', 'ACT'), ('ACACAC', 'CACACA')]
    for _ in range(300):
        cases.append((''.join(rng.choices('ACGTN', k=rng.randrange(20))),
                      ''.join(rng.choices('ACGTN', k=rng.randrange(20)))))
    for a, b in cases:
        ops, status, states = weighted_wavefront(encode(a), encode(b), 160, 100_000)
        assert status == 0
        i = j = score = 0
        for op in ops:
            if op == 0:
                score += 1 if a[i] == b[j] and a[i] in 'ACGT' else -1
                i += 1
                j += 1
            elif op == 1:
                score -= 1
                j += 1
            else:
                score -= 1
                i += 1
        assert (i, j) == (len(a), len(b)), (a, b, ops)
        assert score == optimal_score(a, b), (a, b, ops)


def test_exhaustion_returns_no_partial_path():
    ops, status, states = weighted_wavefront(encode('A' * 100), encode('C' * 100), 20, 10)
    assert status == 1 and states <= 10 and ops.size == 0


def test_long_length_difference_uses_a_bounded_remaining_length_potential():
    a, b = 'C' * 3500 + 'ACGT' * 1000, 'ACGT' * 1000
    ops, status, states = weighted_wavefront(encode(a), encode(b), 20, 100_000)
    assert status == 0 and states < 100_000
    assert np.count_nonzero(ops == 2) == 3500
    assert np.count_nonzero(ops == 0) == len(b)


def test_alternative_allocation_and_request_state_limits_cannot_bypass_limits():
    from dataclasses import replace
    from services.reconstruction_budget import DEFAULT_LIMITS, ResourceResult, WorkBudget, isolated
    budget = WorkBudget(replace(DEFAULT_LIMITS, wavefront_pair_states=100_000_000))
    with pytest.raises(ResourceResult, match='wavefront_allocation'):
        budget.wavefront(1000, 1000)
    with pytest.raises(ResourceResult, match='wavefront_states'):
        isolated('services.insertion_consensus', 'align', ('A' * 100, 'C' * 100), {}, lengths=[100, 100],
                 pairs=[(100, 100, 50)], limits=replace(DEFAULT_LIMITS, request_cells=10), allow_wavefront=True)


def test_large_ordinary_consensus_uses_explicit_bounded_alternative():
    from services.insertion_consensus import consensus_with_knots
    truth = 'ACGT' * 1850
    reads = [truth[:100 + i] + ('T' if truth[100 + i] != 'T' else 'C') + truth[101 + i:] for i in range(24)]
    result = consensus_with_knots(reads)
    assert result['alignment_algorithm'] == 'weighted_wavefront:v1'
    assert result['seq'] == truth and len(result['reads']) == 24
